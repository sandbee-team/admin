import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  startApp,
  assertNoSecrets,
  VAULT_KEY,
  BACKUP_KEY,
  until,
} from "./helpers.js";
import { encrypt } from "../backend/lib/crypto.js";
import { base32Encode, codeAt, stepAt } from "../backend/lib/totp.js";
import { verifyVaultKey } from "../backend/lib/vault.js";
import { makeSnapshot, parseSnapshot } from "../backend/lib/snapshot.js";
import { resetTotp } from "../backend/lib/recovery-tasks.js";
import { applyTimeouts, TIMEOUTS } from "../backend/lib/http-timeouts.js";
import { createApp } from "../backend/app.js";

let ctx,
  owner,
  admin,
  viewer,
  counter = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIN = 60000,
  HOUR = 3600000;

before(async () => {
  ctx = await startApp({ dbName: "review_backend" });
  owner = await ctx.login("owner@example.test");
  admin = await ctx.login("admin@example.test");
  viewer = await ctx.login("viewer@example.test");
});
after(() => ctx.stop());

describe("Ecom bridge upstream failures (L2)", () => {
  let upstream, reply;
  before(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(reply.status, {
        "Content-Type": reply.type ?? "application/json",
      });
      res.end(reply.body);
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    ctx.c.ECOM_SERVICE_URL = `http://127.0.0.1:${upstream.address().port}/`;
    ctx.c.ECOM_SERVICE_KEY = "k".repeat(48);
  });
  after(async () => {
    ctx.c.ECOM_SERVICE_URL = "";
    ctx.c.ECOM_SERVICE_KEY = "";
    await new Promise((resolve) => upstream.close(resolve));
  });
  const get = () => ctx.request("/ecom/tenants", { session: owner });
  it("never forwards an upstream 401/403 as an Admin 401", async () => {
    for (const status of [401, 403]) {
      reply = {
        status,
        body: JSON.stringify({ error: "bad key sk-secret-upstream" }),
      };
      const res = await get();
      assert.equal(res.status, 502);
      assert.equal(res.data.code, "upstream-auth");
      assert.equal(
        res.data.error,
        "The Ecom service rejected Admin's service key.",
      );
      assert.equal(
        JSON.stringify(res.data).includes("sk-secret-upstream"),
        false,
      );
      assert.ok(res.data.requestId);
    }
    // The console session is still valid afterwards.
    assert.equal(
      (await ctx.request("/auth/me", { session: owner })).status,
      200,
    );
  });
  it("maps other upstream failures and unreadable bodies to 502", async () => {
    for (const status of [400, 404, 500, 503]) {
      reply = {
        status,
        body: JSON.stringify({ error: "detail from upstream" }),
      };
      const res = await get();
      assert.equal(res.status, 502, String(status));
      assert.equal(res.data.code, "upstream");
      assert.equal(
        JSON.stringify(res.data).includes("detail from upstream"),
        false,
      );
    }
    for (const status of [200, 500]) {
      reply = { status, type: "text/html", body: "<html>gateway</html>" };
      const res = await get();
      assert.equal(res.status, 502, `html ${status}`);
      assert.equal(res.data.code, "upstream");
      assert.doesNotMatch(res.data.error, /Malformed JSON/);
    }
  });
  it("still returns upstream data on success and refuses an unreachable upstream", async () => {
    reply = {
      status: 200,
      body: JSON.stringify({ connected: true, items: [], total: 0 }),
    };
    const ok = await get();
    assert.equal(ok.status, 200);
    assert.equal(ok.data.total, 0);
    const saved = ctx.c.ECOM_SERVICE_URL;
    ctx.c.ECOM_SERVICE_URL = "http://127.0.0.1:1/";
    const down = await get();
    ctx.c.ECOM_SERVICE_URL = saved;
    assert.equal(down.status, 502);
    assert.equal(down.data.code, "upstream");
  });
});

describe("/overview recovery projection (L3)", () => {
  it("exposes only the drill date to every role", async () => {
    await ctx.db.collection("recovery_checks").insertOne({
      _id: randomUUID(),
      type: "operator-attestation",
      location: "secret-location-vault-17",
      sourceRevision: "rev-abcdef123",
      notes: "private notes about the drill",
      recordedBy: "Someone Private",
      restoredAt: "2026-09-30",
      keyStoredSeparately: true,
      createdAt: new Date(),
    });
    for (const session of [viewer, admin, owner]) {
      const res = await ctx.request("/overview", { session });
      assert.equal(res.status, 200);
      const keys = Object.keys(res.data.latestRecovery ?? {});
      assert.deepEqual(keys, ["restoredAt"]);
      assert.equal(res.data.latestRecovery.restoredAt, "2026-09-30");
      assertNoSecrets(res.data, [
        "secret-location-vault-17",
        "rev-abcdef123",
        "private notes about the drill",
        "Someone Private",
      ]);
    }
  });
});

describe("wrong VAULT_KEY messages (L4)", () => {
  it("reports a mismatched key at boot with the intended message", async () => {
    await verifyVaultKey(ctx.db, VAULT_KEY);
    await verifyVaultKey(ctx.db, VAULT_KEY); // same key stays fine
    await assert.rejects(verifyVaultKey(ctx.db, "d".repeat(64)), (error) => {
      assert.match(error.message, /Vault key does not match this database/);
      return true;
    });
  });
  it("reports a mismatched key when reading a snapshot", async () => {
    const text = await makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY);
    assert.ok(parseSnapshot(text, VAULT_KEY, BACKUP_KEY));
    assert.throws(
      () => parseSnapshot(text, "d".repeat(64), BACKUP_KEY),
      (error) => error.message === "Vault verification failed.",
    );
  });
});

describe("rolling 24 h authenticator lock (L5)", () => {
  async function member(email) {
    const session = await ctx.login(email);
    const key = Buffer.from(randomUUID().replaceAll("-", "").slice(0, 20));
    const row = await ctx.db.collection("staff").findOne({ email });
    await ctx.db.collection("staff").updateOne(
      { _id: row._id },
      {
        $set: {
          totp: {
            key: encrypt(base32Encode(key), VAULT_KEY, `staff:${row._id}:totp`),
            enabledAt: new Date(),
            lastStep: 0,
          },
        },
      },
    );
    return { session, key, id: row._id, email };
  }
  const wrongCode = (who) => {
    const step = stepAt(Date.now());
    const valid = [-1, 0, 1].map((d) => codeAt(who.key, step + d));
    for (let n = 0; n < 1000; n++) {
      const code = String(n).padStart(6, "0");
      if (!valid.includes(code)) return code;
    }
  };
  const failures = (count, spanMs, endAgoMs = MIN) =>
    Array.from(
      { length: count },
      (_, i) =>
        new Date(
          Date.now() -
            endAgoMs -
            ((count - 1 - i) * spanMs) / Math.max(count - 1, 1),
        ),
    );
  const stepUp = (who, body) =>
    ctx.request("/auth/step-up", {
      method: "POST",
      body,
      session: who.session,
    });
  const staffRow = (who) => ctx.db.collection("staff").findOne({ _id: who.id });
  const lockedEvents = (who) =>
    ctx.db
      .collection("audit_events")
      .countDocuments({ action: "totp.locked", resourceId: who.id });

  it("locks when 20 wrong codes fall inside a rolling 24 h, even across UTC midnight", async () => {
    const who = await member("operations@example.test");
    // 19 failures spread over 23.5 h: depending on the time of day they
    // straddle a UTC midnight, which a calendar-day bucket would split into
    // two counts below the limit. A rolling window counts them all.
    const spread = failures(19, 23.5 * HOUR - MIN);
    await ctx.db
      .collection("staff")
      .updateOne({ _id: who.id }, { $set: { totpFailures: spread } });
    assert.equal((await stepUp(who, { code: wrongCode(who) })).status, 400);
    const after = await staffRow(who);
    const until = after.totpLockedUntil.getTime();
    assert.ok(
      Math.abs(until - (Date.now() + 24 * HOUR)) < 10000,
      "locked for 24 h from now",
    );
    assert.equal(after.totpFailures.length, 20);
    assert.equal(await lockedEvents(who), 1);
    // Even a correct code is refused while locked.
    const right = await stepUp(who, {
      code: codeAt(who.key, stepAt(Date.now())),
    });
    assert.equal(right.status, 429);
    assert.match(right.data.error, /Too many wrong authenticator codes/);
    // The lock is on the record: it does not move with the calendar.
    assert.equal((await staffRow(who)).totpLockedUntil.getTime(), until);
    assert.equal(await lockedEvents(who), 1);
  });

  it("does not count failures older than 24 h", async () => {
    const who = await member("admin@example.test");
    const old = Array.from(
      { length: 10 },
      (_, i) => new Date(Date.now() - 25 * HOUR - i * MIN),
    );
    const recent = failures(9, 5 * MIN);
    await ctx.db
      .collection("staff")
      .updateOne(
        { _id: who.id },
        { $set: { totpFailures: [...old, ...recent] } },
      );
    assert.equal((await stepUp(who, { code: wrongCode(who) })).status, 400);
    const row = await staffRow(who);
    assert.equal(row.totpLockedUntil, undefined);
    assert.equal(
      row.totpFailures.length,
      10,
      "only in-window failures are kept",
    );
    assert.equal(await lockedEvents(who), 0);
  });

  it("locks exactly once under racing failures; backup codes keep working; reset clears it", async () => {
    const who = await member("viewer@example.test");
    const codes = ["ABCDE-FGHJK", "KMNPQ-RSTUV"];
    const { hashBackup } = await backupHasher();
    await ctx.db.collection("staff").updateOne(
      { _id: who.id },
      {
        $set: {
          totpFailures: failures(18, 30 * MIN),
          totpBackupCodes: codes.map((c) =>
            hashBackup(who.id, c.replace("-", "")),
          ),
        },
      },
    );
    await Promise.all(
      [1, 2, 3].map(() => stepUp(who, { code: wrongCode(who) })),
    );
    assert.equal(await lockedEvents(who), 1);
    const locked = await staffRow(who);
    assert.ok(locked.totpLockedUntil > new Date());
    const viaBackup = await stepUp(who, { backupCode: codes[0] });
    assert.equal(viaBackup.status, 200, JSON.stringify(viaBackup.data));
    // A successful backup code does not lift the lock (documented choice).
    assert.ok((await staffRow(who)).totpLockedUntil > new Date());
    await resetTotp({ db: ctx.db, client: ctx.client }, who.email);
    const cleared = await staffRow(who);
    assert.equal(cleared.totpLockedUntil, undefined);
    assert.equal(cleared.totpFailures, undefined);
  });

  it("two failures in the same millisecond arm the lock once (one audit, one notice)", async () => {
    // Earlier tests enrolled this member; clear it so login needs no TOTP.
    await ctx.db
      .collection("staff")
      .updateOne(
        { email: "operations@example.test" },
        { $unset: { totp: "", totpFailures: "", totpLockedUntil: "" } },
      );
    const who = await member("operations@example.test");
    await ctx.db.collection("staff").updateOne(
      { _id: who.id },
      {
        $unset: { totpLockedUntil: "" },
        $set: { totpFailures: failures(19, 30 * MIN) },
      },
    );
    await ctx.db
      .collection("audit_events")
      .deleteMany({ action: "totp.locked", resourceId: who.id });
    const before = ctx.notices.filter(
      (n) => n.email === who.email && /locked/i.test(n.subject),
    ).length;
    // Freeze the clock so both requests compute the identical `now`.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      await Promise.all(
        [1, 2].map(() => stepUp(who, { code: wrongCode(who) })),
      );
    } finally {
      mock.timers.reset();
    }
    // The notice is sent after the response; wait for it, then count.
    await until(
      () =>
        ctx.notices.filter(
          (n) => n.email === who.email && /locked/i.test(n.subject),
        ).length > before,
      { what: "the lock notice" },
    );
    assert.equal(await lockedEvents(who), 1);
    const after = ctx.notices.filter(
      (n) => n.email === who.email && /locked/i.test(n.subject),
    ).length;
    assert.equal(after - before, 1);
    assert.ok((await staffRow(who)).totpLockedUntil > new Date());
  });
  it("lets the lock expire after 24 h", async () => {
    const who = await member("viewer@example.test");
    await ctx.db.collection("staff").updateOne(
      { _id: who.id },
      {
        $set: {
          totpLockedUntil: new Date(Date.now() - 1000),
          totpFailures: [],
        },
      },
    );
    const ok = await stepUp(who, { code: codeAt(who.key, stepAt(Date.now())) });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });
});
async function backupHasher() {
  // Mirrors auth.js: HMAC of "<staffId>:<CODE>" with a subkey of VAULT_KEY.
  const { createHmac } = await import("node:crypto");
  const subkey = createHmac("sha256", Buffer.from(VAULT_KEY, "hex"))
    .update("staff-backup-codes-v1")
    .digest();
  return {
    hashBackup: (id, code) =>
      createHmac("sha256", subkey).update(`${id}:${code}`).digest("hex"),
  };
}

describe("POS import: retired installation and product serialization (L1, L6)", () => {
  const FIXTURE = JSON.parse(
    readFileSync(
      new URL("./fixtures/pos-client.json", import.meta.url),
      "utf8",
    ),
  );
  const clientOf = () => {
    const slug = `review-cafe-${++counter}`;
    return { ...structuredClone(FIXTURE), slug, subdomain: slug };
  };
  async function importInto(client, customer) {
    const pre = await ctx.request("/pos/import/preview", {
      method: "POST",
      body: { client, profile: null },
      session: owner,
    });
    assert.equal(pre.status, 200, JSON.stringify(pre.data));
    return ctx.request("/pos/import/confirm", {
      method: "POST",
      body: { client, profile: null, digest: pre.data.digest, customer },
      session: owner,
    });
  }
  const mkCustomer = async () => {
    const n = ++counter;
    const res = await ctx.request("/customers", {
      method: "POST",
      session: admin,
      body: {
        name: `Review ${n}`,
        email: `review${n}@example.test`,
        company: "R",
        phone: "",
        status: "active",
        notes: "",
      },
    });
    return res.data._id;
  };
  const posProduct = () =>
    ctx.db.collection("products").findOne({ slug: "pos" });

  it("refuses to attach POS settings to a retired production installation", async () => {
    const customerId = await mkCustomer();
    const product = await posProduct();
    const installationId = randomUUID();
    await ctx.db.collection("installations").insertOne({
      _id: installationId,
      name: "Old POS",
      customerId,
      productId: product._id,
      environment: "production",
      status: "retired",
      release: "",
      sourceUrl: "",
      endpoint: "",
      connectionIds: [],
      checks: [],
      evidence: "",
      notes: "",
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const client = clientOf();
    const res = await importInto(client, { mode: "existing", customerId });
    assert.equal(res.status, 409);
    assert.equal(
      res.data.error,
      "This customer's production POS installation is retired and cannot be reused. Import into a new customer instead.",
    );
    assertNoSecrets(res.data, [FIXTURE.vercel.token, FIXTURE.mongodbUri]);
    const row = await ctx.db
      .collection("installations")
      .findOne({ _id: installationId });
    assert.equal(row.pos, undefined);
    assert.equal(row.status, "retired");
    assert.equal(
      await ctx.db
        .collection("installations")
        .countDocuments({ "pos.slug": client.slug }),
      0,
    );
    assert.equal(
      (await ctx.db.collection("customers").findOne({ _id: customerId }))
        .accounts,
      undefined,
    );
    // A planned installation of the same shape is still reused.
    await ctx.db
      .collection("installations")
      .updateOne({ _id: installationId }, { $set: { status: "planned" } });
    const ok = await importInto(client, { mode: "existing", customerId });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.installationId, installationId);
  });

  it("writes the product like the generic installation path and conflicts with a concurrent product change", async () => {
    const product = await posProduct();
    const before = (await posProduct()).installationRevision ?? 0;
    const done = await importInto(clientOf(), {
      mode: "new",
      name: "Fiona",
      email: `fiona${++counter}@example.test`,
      company: "F",
      phone: "",
    });
    assert.equal(done.status, 201, JSON.stringify(done.data));
    assert.equal((await posProduct()).installationRevision, before + 1);
    // Hold an uncommitted product write: the import must collide with it.
    const holder = ctx.client.startSession();
    holder.startTransaction();
    await ctx.db
      .collection("products")
      .updateOne(
        { _id: product._id },
        { $inc: { installationRevision: 1 } },
        { session: holder },
      );
    let finished = false;
    const pending = importInto(clientOf(), {
      mode: "new",
      name: "Gina",
      email: `gina${++counter}@example.test`,
      company: "G",
      phone: "",
    }).then((res) => {
      finished = true;
      return res;
    });
    await sleep(700);
    assert.equal(
      finished,
      false,
      "import waits on the conflicting product write",
    );
    await holder.commitTransaction();
    await holder.endSession();
    const res = await pending;
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal((await posProduct()).installationRevision, before + 3);
  });
});

describe("/audit query cost (L7)", () => {
  it("bounds the query and only counts exactly with a filter", async () => {
    const seen = [];
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === "collection")
          return (name) => {
            const col = target.collection(name);
            if (name !== "audit_events") return col;
            return new Proxy(col, {
              get(c, p) {
                if (p === "find")
                  return (...args) => {
                    const cursor = c.find(...args);
                    const bound = cursor.maxTimeMS.bind(cursor);
                    cursor.maxTimeMS = (ms) => {
                      seen.push(["find.maxTimeMS", ms]);
                      return bound(ms);
                    };
                    return cursor;
                  };
                if (p === "countDocuments" || p === "estimatedDocumentCount")
                  return (...args) => {
                    seen.push([p, JSON.stringify(args)]);
                    return c[p](...args);
                  };
                const value = c[p];
                return typeof value === "function" ? value.bind(c) : value;
              },
            });
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = createApp({
      db,
      client: ctx.client,
      c: ctx.c,
      sendCode: async () => {},
      notify: async () => {},
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const at = `http://127.0.0.1:${server.address().port}`;
    const get = async (path) => {
      const res = await fetch(`${at}/api${path}`, {
        headers: { Cookie: owner.cookie },
      });
      return { status: res.status, data: await res.json() };
    };
    try {
      const all = await get("/audit");
      assert.equal(all.status, 200);
      assert.ok(all.data.rows.length > 0 && all.data.rows.length <= 30);
      assert.equal(all.data.pageSize, 30);
      assert.ok(all.data.total >= all.data.rows.length);
      assert.deepEqual(
        seen.filter(([k]) => k !== "find.maxTimeMS").map(([k]) => k),
        ["estimatedDocumentCount"],
      );
      assert.ok(seen.some(([k, v]) => k === "find.maxTimeMS" && v === 4000));
      assert.ok(
        seen.some(
          ([k, v]) => k === "estimatedDocumentCount" && v.includes("4000"),
        ),
      );
      const page2 = await get("/audit?page=2");
      assert.equal(page2.data.page, 2);
      seen.length = 0;
      const customerId =
        (await ctx.db.collection("customers").findOne({}))?._id ?? randomUUID();
      const filtered = await get(`/audit?customerId=${customerId}`);
      assert.equal(filtered.status, 200);
      assert.deepEqual(
        seen.filter(([k]) => k !== "find.maxTimeMS").map(([k]) => k),
        ["countDocuments"],
      );
      const exact = await ctx.db.collection("audit_events").countDocuments({
        resourceId: {
          $in: [
            customerId,
            ...(
              await ctx.db
                .collection("installations")
                .find({ customerId })
                .toArray()
            ).map((i) => i._id),
          ],
        },
      });
      assert.equal(filtered.data.total, exact);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("HTTP server timeouts (S1)", () => {
  it("sets keepAliveTimeout above Caddy's idle time and keeps the other limits", () => {
    const server = applyTimeouts(http.createServer());
    assert.equal(server.keepAliveTimeout, 125000);
    assert.ok(server.keepAliveTimeout > 120000);
    assert.equal(server.headersTimeout, 10000);
    assert.equal(server.requestTimeout, 60000);
    assert.deepEqual(TIMEOUTS, {
      keepAliveTimeout: 125000,
      headersTimeout: 10000,
      requestTimeout: 60000,
    });
    server.close();
  });
  // Real sockets with the connection checks running every 50 ms (Node's
  // default is 30 s, which would make a timeout test pass vacuously).
  async function withServer(overrides, run) {
    const server = http.createServer(
      { connectionsCheckingInterval: 50 },
      (_req, res) => res.end("ok"),
    );
    if (overrides) applyTimeouts(server, overrides);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const hit = () =>
      new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: server.address().port, agent },
          (res) => {
            res.resume();
            res.on("end", () => resolve(req.socket));
          },
        );
        req.on("error", reject);
      });
    try {
      return await run({ server, hit });
    } finally {
      agent.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  it("headersTimeout is enforced (positive control): an incomplete request gets 408", async () => {
    await withServer(
      { keepAliveTimeout: 8000, headersTimeout: 300, requestTimeout: 2000 },
      async ({ server }) => {
        const answer = await new Promise((resolve, reject) => {
          const socket = net.connect(server.address().port, "127.0.0.1", () =>
            socket.write("GET / HTTP/1.1\r\nHost: x\r\n"),
          );
          let text = "";
          const started = Date.now();
          socket.on("data", (d) => (text += d));
          socket.on("close", () =>
            resolve({ text, took: Date.now() - started }),
          );
          socket.on("error", reject);
        });
        assert.match(answer.text, /^HTTP\/1\.1 408/);
        assert.ok(
          answer.took < 3000,
          `408 within the short headersTimeout (${answer.took} ms)`,
        );
      },
    );
  });
  it("an idle keep-alive socket outlives headersTimeout and Node's default keepAliveTimeout only with our setting", async () => {
    // Idle 6.5 s: longer than headersTimeout (300 ms) and longer than Node's
    // default keepAliveTimeout (5 s + 1 s buffer), shorter than ours (20 s).
    // Real sockets and timers cannot be mocked; the stock arm only needs a
    // late wake-up (more idle time is fine), and ours has 13.5 s of margin.
    const idle = 6500;
    const [ours, stock] = await Promise.all([
      withServer(
        { keepAliveTimeout: 20000, headersTimeout: 300, requestTimeout: 2000 },
        async ({ hit }) => {
          const first = await hit();
          await sleep(idle);
          return (await hit()) === first;
        },
      ),
      withServer(null, async ({ server, hit }) => {
        assert.equal(server.keepAliveTimeout, 5000, "Node default");
        const first = await hit();
        await sleep(idle);
        return (await hit()) === first;
      }),
    ]);
    assert.equal(ours, true, "reused with the raised keepAliveTimeout");
    assert.equal(
      stock,
      false,
      "closed under Node's default (test is sensitive)",
    );
  });
});

describe("handoff packaging guard (L9)", () => {
  const script = readFileSync(
    new URL("../scripts/package-handoff.ps1", import.meta.url),
    "utf8",
  );
  const pattern = /-match '([^']+)'/.exec(script)[1];
  const refused = new RegExp(pattern);
  it("refuses every .env variant except .env.example, at any depth", () => {
    for (const bad of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      "backend/.env",
      "scripts/.env.local",
      "test/fixtures/.env.production",
      ".local/owner-access.txt",
      "backups/x.json",
      "node_modules/a/b.js",
      "test-results/r.txt",
    ])
      assert.equal(refused.test(bad), true, bad);
    for (const ok of [
      ".env.example",
      "docs/.env.example",
      "backend/app.js",
      "scripts/env-check.js",
      "docs/environment.md",
      "test/envelope.test.js",
      "frontend/src/lib/environment.js",
    ])
      assert.equal(refused.test(ok), false, ok);
  });
});
