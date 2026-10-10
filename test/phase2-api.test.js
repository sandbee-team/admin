// Phase 2 U3: on-demand usage checks API (docs/PHASE2-PLAN.md rev 2, §3, §8,
// §10, §11). The API only reads results and ENQUEUES checks; the worker (U2)
// runs them. Every response and every audit row is scanned for secrets.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertNoSecrets,
  clearOfWindow,
  startApp,
  VAULT_KEY,
} from "./helpers.js";
import { digest, encrypt } from "../backend/lib/crypto.js";
import { newPos, aadOf } from "../backend/modules/pos.js";
import {
  ALERT_TITLES,
  HOBBY_LIMITS,
  MONGO_LIMIT_BYTES,
  WORKER_FREE_REQUESTS,
} from "../shared/usage.js";

const VERCEL_TOKEN = "vercel-usage-secret-token-1234567890";
const STATS_TOKEN = "health-stats-usage-token-abcdef123456";
const CF_TOKEN = "cloudflare-usage-secret-token-0987654321";
const MONGO_PASS = "MongoSecretPass99";
const MONGO_URI = `mongodb+srv://pos:${MONGO_PASS}@cluster0.example.mongodb.net/pos`;
const SECRETS = [
  VERCEL_TOKEN,
  STATS_TOKEN,
  CF_TOKEN,
  MONGO_PASS,
  MONGO_URI,
  VAULT_KEY,
];
const HOUR = 3600000;

let ctx, owner, admin, operations, viewer, product, other;

// Every response is scanned for secrets and encrypted boxes.
async function call(path, { session = owner, ...options } = {}) {
  const res = await ctx.request(path, { session, ...options });
  assertNoSecrets(res.data, SECRETS, `${options.method ?? "GET"} ${path}`);
  return res;
}
const usagePath = (id, rest = "") => `/installations/${id}/pos/usage${rest}`;
const getUsage = (id, session) => call(usagePath(id), { session });
const putWatch = (id, body, session) =>
  call(usagePath(id, "/watch"), { method: "PUT", body, session });
const checkNow = (id, session, body = {}) =>
  call(usagePath(id, "/check"), { method: "POST", body, session });
const batch = (session, body = {}) =>
  call("/pos/usage/check", { method: "POST", body, session });

const POS_CONFIG = (slug) => ({
  slug,
  subdomain: "cafe",
  host: `${slug}.pos.example.com`,
  tenantId: "tenant_1",
  rootDomain: "pos.example.com",
  vercel: {
    projectId: "prj_abc123",
    orgId: "team_abc123",
    teamId: "team_abc123",
    projectName: slug,
  },
  cloudflare: {
    accountId: "cfacc123",
    workerName: `${slug}-rt`,
    workerUrl: "https://worker.example.workers.dev",
  },
  image: {
    store: "r2",
    publicBaseUrl: "https://img.example.com",
    cloudName: "",
    r2AccountId: "r2acc123",
    bucket: "images",
  },
  posAdmin: { username: "owner1" },
});
const heartbeat = (at = new Date()) =>
  ctx.db
    .collection("system_state")
    .updateOne({ _id: "pos-worker" }, { $set: { at } }, { upsert: true });
// A POS installation with every secret box the worker would read, the worker
// online and all rate limits cleared.
async function fresh({
  slug = `use-${randomUUID().slice(0, 8)}`,
  usage,
  withPos = true,
  productId,
} = {}) {
  const { db } = ctx;
  const customerId = randomUUID(),
    id = randomUUID();
  await db.collection("customers").insertOne({
    _id: customerId,
    name: `Customer ${slug}`,
    email: `${slug}@example.test`,
    status: "active",
    updatedAt: new Date(),
  });
  let pos;
  if (withPos) {
    pos = newPos(POS_CONFIG(slug));
    pos.vercel.token = encrypt(
      VERCEL_TOKEN,
      VAULT_KEY,
      aadOf(id, "vercel.token"),
    );
    pos.mongo.uri = encrypt(MONGO_URI, VAULT_KEY, aadOf(id, "mongo.uri"));
    pos.cloudflare.token = encrypt(
      CF_TOKEN,
      VAULT_KEY,
      aadOf(id, "cloudflare.token"),
    );
    pos.generated.healthStatsToken = encrypt(
      STATS_TOKEN,
      VAULT_KEY,
      aadOf(id, "generated.healthStatsToken"),
    );
    if (usage) pos.usage = usage;
  }
  await db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: productId ?? product._id,
    name: `${slug} POS`,
    status: "live",
    environment: "production",
    updatedAt: new Date(),
    ...(pos ? { pos } : {}),
  });
  await db.collection("rate_limits").deleteMany({});
  await heartbeat();
  return { id, customerId, slug };
}
const doc = (id) => ctx.db.collection("installations").findOne({ _id: id });
const setUsage = (id, set, unset) =>
  ctx.db
    .collection("installations")
    .updateOne(
      { _id: id },
      { ...(set ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) },
    );
const audits = (resourceId, action, since) =>
  ctx.db
    .collection("audit_events")
    .find({
      resourceId,
      ...(action ? { action } : {}),
      ...(since ? { createdAt: { $gte: since } } : {}),
    })
    .toArray();
// Nobody else is on the watch list (other tests leave watched clients behind).
const unwatchAll = () =>
  ctx.db
    .collection("installations")
    .updateMany(
      { "pos.usage.watch": true },
      { $set: { "pos.usage.watch": false } },
    );
const bucketRow = (key) =>
  ctx.db
    .collection("rate_limits")
    .findOne({ _id: digest(`${key}:${Math.floor(Date.now() / HOUR)}`) });
const iso = (value) => JSON.parse(JSON.stringify(value));
const retire = (id) =>
  ctx.db
    .collection("installations")
    .updateOne({ _id: id }, { $set: { status: "retired" } });
// Runs `hook` inside the hourly-allowance write for `key`: after a route's
// cheap pre-checks and before its transaction, the window in which another
// request could change the row. The app shares ctx.db, so its collection()
// is wrapped for the duration of `fn` and restored after.
async function duringConsume(key, hook, fn) {
  const { db } = ctx;
  const id = digest(`${key}:${Math.floor(Date.now() / HOUR)}`);
  const original = db.collection;
  let fired = false;
  db.collection = function (name, ...rest) {
    const col = original.call(this, name, ...rest);
    if (name !== "rate_limits") return col;
    const write = col.findOneAndUpdate.bind(col);
    col.findOneAndUpdate = async (filter, ...args) => {
      if (!fired && filter?._id === id) {
        fired = true;
        await hook();
      }
      return write(filter, ...args);
    };
    return col;
  };
  try {
    await fn();
  } finally {
    delete db.collection;
  }
  assert.ok(fired, `the hook ran inside consume(${key})`);
}
const queuedCheck = () => ({
  id: randomUUID(),
  status: "queued",
  batchId: null,
  requestedAt: new Date(),
  by: { id: "x", name: "Other" },
  lease: { owner: null, until: null, fence: 0 },
  attempt: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
});
const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms);
const runningCheck = () => ({
  ...queuedCheck(),
  status: "running",
  startedAt: new Date(),
  lease: { owner: "w1", until: new Date(Date.now() + MIN), fence: 1 },
  attempt: 1,
});
// The Usage GET looks for a running (or just finished) check on ANY
// installation: park the ones other tests left behind, for `fn` only.
async function withNoneRunning(fn) {
  const col = ctx.db.collection("installations");
  const ids = (
    await col
      .find({ "pos.usage.check.status": "running" }, { projection: { _id: 1 } })
      .toArray()
  ).map((row) => row._id);
  const recent = await col
    .find(
      {
        "pos.usage.check.status": { $in: ["done", "failed", "expired"] },
        "pos.usage.check.finishedAt": { $gt: new Date(Date.now() - 5 * MIN) },
      },
      { projection: { "pos.usage.check.finishedAt": 1 } },
    )
    .toArray();
  await col.updateMany(
    { _id: { $in: ids } },
    { $set: { "pos.usage.check.status": "done" } },
  );
  for (const row of recent)
    await col.updateOne(
      { _id: row._id },
      { $set: { "pos.usage.check.finishedAt": ago(10 * MIN) } },
    );
  try {
    await fn();
  } finally {
    await col.updateMany(
      { _id: { $in: ids } },
      { $set: { "pos.usage.check.status": "running" } },
    );
    for (const row of recent)
      await col.updateOne(
        { _id: row._id },
        {
          $set: {
            "pos.usage.check.finishedAt": row.pos.usage.check.finishedAt,
          },
        },
      );
    await heartbeat();
  }
}

before(async () => {
  ctx = await startApp({ dbName: "phase2_api" });
  owner = await ctx.login("owner@example.test");
  admin = await ctx.login("admin@example.test");
  operations = await ctx.login("operations@example.test");
  viewer = await ctx.login("viewer@example.test");
  product = await ctx.db.collection("products").findOne({ slug: "pos" });
  other = await ctx.db.collection("products").findOne({ slug: { $ne: "pos" } });
});
after(() => ctx?.stop());

describe("usage routes: access and validation", () => {
  it("401 without a session on all four routes", async () => {
    const { id } = await fresh();
    for (const [method, path, body] of [
      ["GET", usagePath(id)],
      ["PUT", usagePath(id, "/watch"), { watch: true }],
      ["POST", usagePath(id, "/check"), {}],
      ["POST", "/pos/usage/check", {}],
    ]) {
      const res = await ctx.request(path, { method, body });
      assert.equal(res.status, 401, `${method} ${path}`);
      assertNoSecrets(res.data, SECRETS, `${method} ${path}`);
    }
  });

  it("viewer and operations get 403 on every route and nothing changes", async () => {
    const { id } = await fresh();
    for (const session of [viewer, operations]) {
      const role = session.user.role;
      assert.equal((await getUsage(id, session)).status, 403, role);
      assert.equal(
        (await putWatch(id, { watch: true }, session)).status,
        403,
        role,
      );
      assert.equal((await checkNow(id, session)).status, 403, role);
      assert.equal((await batch(session)).status, 403, role);
    }
    assert.equal((await doc(id)).pos.usage, undefined);
    assert.equal((await audits(id)).length, 0);
  });

  it("admin and owner may read, watch, check now and check watched clients", async () => {
    for (const session of [admin, owner]) {
      const { id } = await fresh();
      const role = session.user.role;
      assert.equal((await getUsage(id, session)).status, 200, role);
      assert.equal(
        (await putWatch(id, { watch: true }, session)).status,
        200,
        role,
      );
      assert.equal((await checkNow(id, session)).status, 202, role);
      await setUsage(id, { "pos.usage.check.status": "done" });
      assert.equal((await batch(session)).status, 202, role);
    }
  });

  it("bad ids, unknown body keys, non-POS and missing POS settings are refused", async () => {
    const { id } = await fresh();
    for (const [path, method, body] of [
      ["/installations/not-a-uuid/pos/usage", "GET"],
      ["/installations/not-a-uuid/pos/usage/watch", "PUT", { watch: true }],
      ["/installations/not-a-uuid/pos/usage/check", "POST", {}],
      [usagePath(id, "/watch"), "PUT", { watch: true, extra: 1 }],
      [usagePath(id, "/watch"), "PUT", { watch: "yes" }],
      [usagePath(id, "/watch"), "PUT", {}],
      [usagePath(id, "/check"), "POST", { force: true }],
      ["/pos/usage/check", "POST", { all: true }],
    ])
      assert.equal(
        (await call(path, { method, body })).status,
        400,
        `${method} ${path} ${JSON.stringify(body)}`,
      );
    const unknown = randomUUID();
    assert.equal((await getUsage(unknown)).status, 404);
    assert.equal((await putWatch(unknown, { watch: true })).status, 404);
    assert.equal((await checkNow(unknown)).status, 404);
    const notPos = await fresh({ withPos: false, productId: other._id });
    const nonPosGet = await getUsage(notPos.id);
    assert.equal(nonPosGet.status, 400);
    assert.match(nonPosGet.data.error, /only available for POS/);
    assert.equal((await putWatch(notPos.id, { watch: true })).status, 400);
    assert.equal((await checkNow(notPos.id)).status, 400);
    const noPos = await fresh({ withPos: false });
    const missing = await getUsage(noPos.id);
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /not been set up/);
    assert.equal((await putWatch(noPos.id, { watch: true })).status, 404);
    assert.equal((await checkNow(noPos.id)).status, 404);
    assert.equal((await doc(noPos.id)).pos, undefined);
    assert.equal((await doc(id)).pos.usage, undefined);
  });
});

describe("GET usage view", () => {
  it("is empty before anything was stored and reports the worker", async () => {
    const { id } = await fresh();
    const res = await getUsage(id);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, {
      watch: false,
      hasHost: true,
      check: null,
      last: null,
      hobby: iso(HOBBY_LIMITS),
      limits: {
        mongoBytes: MONGO_LIMIT_BYTES,
        workerRequests: WORKER_FREE_REQUESTS,
      },
      workerOnline: true,
      stalled: false,
    });
    // Worker offline: nothing will run a check, so the tab is stalled too.
    await heartbeat(new Date(Date.now() - 5 * 60000));
    let off = (await getUsage(id)).data;
    assert.equal(off.workerOnline, false);
    assert.equal(off.stalled, true);
    await ctx.db.collection("system_state").deleteOne({ _id: "pos-worker" });
    off = (await getUsage(id)).data;
    assert.equal(off.workerOnline, false);
    assert.equal(off.stalled, true);
    await setUsage(id, { "pos.host": "" });
    assert.equal((await getUsage(id)).data.hasHost, false);
    await heartbeat();
  });

  it("stalled: worker offline, or queued over 10 minutes (server clock) while no check runs anywhere", async () => {
    await withNoneRunning(async () => {
      const { id } = await fresh({
        usage: { check: { ...queuedCheck(), requestedAt: ago(11 * MIN) } },
      });
      // Queued for 11 minutes and nothing running anywhere: nobody runs it.
      let data = (await getUsage(id)).data;
      assert.equal(data.workerOnline, true);
      assert.equal(data.check.status, "queued");
      assert.equal(data.stalled, true);
      // A long batch: another client's check is running, so this one only
      // waits its turn.
      const busy = await fresh({ usage: { check: runningCheck() } });
      assert.equal((await getUsage(id)).data.stalled, false);
      await setUsage(busy.id, { "pos.usage.check.status": "done" });
      assert.equal((await getUsage(id)).data.stalled, true);
      // ...but one that finished a moment ago means the batch is moving (the
      // worker claims the next check on its next poll).
      await setUsage(busy.id, { "pos.usage.check.finishedAt": new Date() });
      assert.equal((await getUsage(id)).data.stalled, false);
      await setUsage(busy.id, { "pos.usage.check.finishedAt": ago(2 * MIN) });
      assert.equal((await getUsage(id)).data.stalled, true);
      // Queued 9 minutes ago, or with no readable request time: not stalled.
      await setUsage(id, { "pos.usage.check.requestedAt": ago(9 * MIN) });
      assert.equal((await getUsage(id)).data.stalled, false);
      await setUsage(id, { "pos.usage.check.requestedAt": "long ago" });
      assert.equal((await getUsage(id)).data.stalled, false);
      // Its own check running (asked for long ago) or finished: not stalled.
      await setUsage(id, {
        "pos.usage.check.status": "running",
        "pos.usage.check.requestedAt": ago(30 * MIN),
      });
      data = (await getUsage(id)).data;
      assert.equal(data.check.status, "running");
      assert.equal(data.stalled, false);
      await setUsage(id, { "pos.usage.check.status": "done" });
      assert.equal((await getUsage(id)).data.stalled, false);
      // Worker offline: stalled whatever the check, a fresh queued one too.
      await setUsage(id, {
        "pos.usage.check.status": "queued",
        "pos.usage.check.requestedAt": new Date(),
      });
      await heartbeat(ago(5 * MIN));
      data = (await getUsage(id)).data;
      assert.equal(data.workerOnline, false);
      assert.equal(data.stalled, true);
    });
  });

  it("whitelists the stored check and result (no lease, mail, unknown fields, bad codes or junk numbers)", async () => {
    const now = Date.now();
    const REQ = new Date(now - 120000),
      START = new Date(now - 90000),
      LAST_AT = new Date(now - 60000),
      EXPIRES = now + 10 * 86400000,
      CHECK_ID = randomUUID();
    const ledger = (n) => ({
      name: `ledger-${n}`,
      role: "ledger",
      label: `A${n}`,
      active: false,
      paused: false,
      state: "ok",
      usedPct: 0.1,
      bytes: 1000 + n,
    });
    const LONG = "core at 91% ".repeat(20);
    const { id } = await fresh({
      usage: {
        watch: true,
        mail: { storage: { at: new Date(), level: "critical" } },
        surprise: "unknown-top-level-field",
        check: {
          id: CHECK_ID,
          status: "running",
          batchId: "batch-1",
          requestedAt: REQ,
          by: { id: "staff-secret-id", name: "Owner‮Name" },
          lease: { owner: "worker-7", until: new Date(), fence: 4 },
          attempt: 2,
          startedAt: START,
          finishedAt: null,
          error: { code: "not-a-code", message: "provider said something" },
          note: STATS_TOKEN,
        },
        last: {
          at: LAST_AT,
          durationMs: 4200,
          level: "critical",
          raw: STATS_TOKEN,
          site: {
            state: "up",
            code: "ok",
            httpStatus: 200,
            latencyMs: -5,
            probes: 1,
            deployActive: "yes",
            body: "provider body text",
          },
          mongo: {
            source: "health",
            code: "ok",
            statsCode: "stats-denied",
            maxPct: 0.91,
            uri: MONGO_URI,
            clusters: [
              {
                name: "core",
                role: "core",
                label: "C",
                tag: "C",
                active: true,
                paused: false,
                state: "ok",
                usedPct: 0.91,
                bytes: 488636416,
                host: "cluster0.example.mongodb.net",
              },
              {
                name: "Bad Name!",
                role: "ledger",
                label: "A",
                active: true,
                paused: false,
                state: "ok",
                usedPct: 0.2,
                bytes: 1,
              },
              {
                name: "odd",
                role: "weird",
                label: "lower",
                active: "true",
                paused: 1,
                state: "broken",
                usedPct: 5,
                bytes: -1,
              },
              "not-an-object",
              ...Array.from({ length: 13 }, (_, i) => ledger(i + 1)),
            ],
          },
          cloudflare: {
            code: "cf-denied",
            day: "2026-10-11",
            requests: 15000,
            errors: Number.NaN,
            pct: 0.15,
            yesterday: { day: "yesterday", requests: 100 },
            token: CF_TOKEN,
          },
          credentials: {
            vercel: { code: "ok", expiresAt: EXPIRES, token: VERCEL_TOKEN },
            cloudflare: { code: "bogus", expiresAt: "soon" },
          },
          alerts: {
            credential: {
              level: "warning",
              value: null,
              detail: "Vercel token expires in 10 days",
            },
            storage: {
              level: "critical",
              value: 0.91,
              detail: `‮${LONG}`,
            },
            workers: { level: "ok-ish", value: 1, detail: "dropped" },
            "made-up": { level: "critical", value: 1, detail: "dropped" },
          },
        },
      },
    });
    const res = await getUsage(id, admin);
    assert.equal(res.status, 200);
    const cluster = (name, role, label, extra = {}) => ({
      name,
      role,
      label,
      active: false,
      paused: false,
      state: "ok",
      usedPct: 0.1,
      bytes: 1000 + Number(name.split("-")[1]),
      ...extra,
    });
    assert.deepEqual(
      res.data,
      iso({
        watch: true,
        hasHost: true,
        check: {
          id: CHECK_ID,
          status: "running",
          batch: true,
          requestedAt: REQ,
          startedAt: START,
          finishedAt: null,
          by: { name: "Owner Name" },
          error: { code: "internal" },
        },
        last: {
          at: LAST_AT,
          durationMs: 4200,
          level: "critical",
          site: {
            state: "up",
            code: "ok",
            httpStatus: 200,
            latencyMs: null,
            probes: 1,
            deployActive: false,
          },
          mongo: {
            source: "health",
            code: "ok",
            statsCode: "stats-denied",
            maxPct: 0.91,
            clusters: [
              {
                name: "core",
                role: "core",
                label: "C",
                active: true,
                paused: false,
                state: "ok",
                usedPct: 0.91,
                bytes: 488636416,
              },
              {
                name: "odd",
                role: null,
                label: null,
                active: false,
                paused: false,
                state: "error",
                usedPct: null,
                bytes: null,
              },
              ...Array.from({ length: 10 }, (_, i) =>
                cluster(`ledger-${i + 1}`, "ledger", `A${i + 1}`),
              ),
            ],
          },
          cloudflare: {
            code: "cf-denied",
            day: "2026-10-11",
            requests: 15000,
            errors: null,
            pct: 0.15,
            yesterday: { day: null, requests: 100 },
          },
          credentials: {
            vercel: { code: "ok", expiresAt: new Date(EXPIRES) },
            cloudflare: { code: "internal", expiresAt: null },
          },
          alerts: [
            {
              type: "storage",
              title: ALERT_TITLES.storage,
              level: "critical",
              detail: LONG.trim().slice(0, 120),
            },
            {
              type: "credential",
              title: ALERT_TITLES.credential,
              level: "warning",
              detail: "Vercel token expires in 10 days",
            },
          ],
        },
        hobby: HOBBY_LIMITS,
        limits: {
          mongoBytes: MONGO_LIMIT_BYTES,
          workerRequests: WORKER_FREE_REQUESTS,
        },
        workerOnline: true,
        stalled: false,
      }),
    );
    const text = JSON.stringify(res.data);
    for (const word of ["lease", "fence", "attempt", "mail", "surprise"])
      assert.equal(text.includes(word), false, word);
    assert.equal(res.data.last.mongo.clusters.length, 12);
  });

  it("degrades junk stored values to safe defaults", async () => {
    const { id } = await fresh({
      usage: {
        watch: "yes",
        check: { status: "exploded", requestedAt: "not a date", by: null },
        last: {
          at: 12,
          level: "fine",
          site: { state: "sideways", code: 42, probes: "3" },
          mongo: { source: "guess", clusters: "many", maxPct: 3 },
          cloudflare: null,
          credentials: { vercel: "x" },
          alerts: ["storage"],
        },
      },
    });
    const { data } = await getUsage(id);
    assert.equal(data.watch, false);
    assert.equal(data.check.status, "failed");
    assert.equal(data.check.requestedAt, null);
    assert.equal(data.check.batch, false);
    assert.deepEqual(data.check.by, { name: "" });
    assert.equal(data.check.error, null);
    assert.equal(data.last.level, null);
    assert.equal(data.last.site.state, "unknown");
    assert.equal(data.last.site.code, "internal");
    assert.equal(data.last.site.probes, null);
    assert.equal(data.last.mongo.source, null);
    assert.equal(data.last.mongo.code, "internal");
    assert.equal(data.last.mongo.statsCode, null);
    assert.equal(data.last.mongo.maxPct, null);
    assert.deepEqual(data.last.mongo.clusters, []);
    assert.deepEqual(data.last.cloudflare, {
      code: "internal",
      day: null,
      requests: null,
      errors: null,
      pct: null,
      yesterday: { day: null, requests: null },
    });
    assert.deepEqual(data.last.credentials, {
      vercel: { code: "internal", expiresAt: null },
      cloudflare: { code: "internal", expiresAt: null },
    });
    assert.deepEqual(data.last.alerts, []);
  });
});

describe("watch list", () => {
  it("stores the flag, audits each change once and never touches pos.rev", async () => {
    const { id, slug } = await fresh();
    const rev = (await doc(id)).pos.rev;
    const on = await putWatch(id, { watch: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.data, { watch: true });
    assert.equal((await doc(id)).pos.usage.watch, true);
    assert.equal((await getUsage(id)).data.watch, true);
    // Same value again: answered, but nothing changed, so no second row.
    assert.equal((await putWatch(id, { watch: true })).status, 200);
    const watched = await audits(id, "pos.usage.watched");
    assert.equal(watched.length, 1);
    assert.equal(watched[0].resource, "installations");
    assert.equal(watched[0].detail, slug);
    assert.equal(watched[0].actorName, "owner");
    const off = await putWatch(id, { watch: false }, admin);
    assert.deepEqual(off.data, { watch: false });
    assert.equal((await doc(id)).pos.usage.watch, false);
    const unwatched = await audits(id, "pos.usage.unwatched");
    assert.equal(unwatched.length, 1);
    assert.equal(unwatched[0].actorName, "admin");
    assert.equal((await doc(id)).pos.rev, rev, "pos.rev unchanged");
    assertNoSecrets(await audits(id), SECRETS, "audit rows");
  });
});

describe("check now", () => {
  it("queues one check, refuses a second, and frees a dead lease", async () => {
    const { id, slug } = await fresh();
    const rev = (await doc(id)).pos.rev;
    const first = await checkNow(id);
    assert.equal(first.status, 202, JSON.stringify(first.data));
    assert.equal(first.data.check.status, "queued");
    assert.equal(first.data.check.batch, false);
    assert.equal(first.data.check.by.name, "owner");
    assert.equal(first.data.check.error, null);
    assert.deepEqual(Object.keys(first.data.check).sort(), [
      "batch",
      "by",
      "error",
      "finishedAt",
      "id",
      "requestedAt",
      "startedAt",
      "status",
    ]);
    const stored = (await doc(id)).pos.usage.check;
    assert.equal(stored.id, first.data.check.id);
    assert.equal(stored.batchId, null);
    assert.deepEqual(stored.lease, { owner: null, until: null, fence: 0 });
    assert.equal(stored.attempt, 0);
    assert.equal(stored.startedAt, null);
    assert.equal(stored.finishedAt, null);
    assert.equal(stored.error, null);
    assert.equal(stored.by.id, owner.user._id);
    assert.equal(stored.by.name, "owner");
    assert.ok(stored.requestedAt instanceof Date);
    assert.equal((await doc(id)).pos.rev, rev, "pos.rev unchanged");
    assert.equal((await doc(id)).pos.usage.watch, undefined, "not watched");

    const again = await checkNow(id, admin);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, "busy");
    assert.match(again.data.error, /already queued or running/);
    // A refusal does not use up the hourly allowance.
    assert.equal((await bucketRow(`usage-check:${id}`)).count, 1);

    // A running check with a live lease still blocks.
    await setUsage(id, {
      "pos.usage.check.status": "running",
      "pos.usage.check.lease": {
        owner: "w1",
        until: new Date(Date.now() - 60000),
        fence: 1,
      },
    });
    assert.equal((await checkNow(id)).status, 409);
    // Its lease dead for more than 15 minutes: the slot is free again.
    await setUsage(id, {
      "pos.usage.check.lease.until": new Date(Date.now() - 16 * 60000),
    });
    const revived = await checkNow(id);
    assert.equal(revived.status, 202);
    assert.notEqual(revived.data.check.id, first.data.check.id);
    // Finished checks free the slot as well.
    for (const status of ["done", "failed", "expired"]) {
      await setUsage(id, { "pos.usage.check.status": status });
      assert.equal((await checkNow(id)).status, 202, status);
    }
    const rows = await audits(id, "pos.usage.check-requested");
    assert.equal(rows.length, 5);
    assert.equal(rows[0].detail, slug);
    assert.equal(rows[0].resource, "installations");
    assertNoSecrets(rows, SECRETS, "audit rows");
  });

  it("two simultaneous requests queue exactly one check", async () => {
    const { id } = await fresh();
    const results = await Promise.all([checkNow(id), checkNow(id, admin)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
    const won = results.find((r) => r.status === 202);
    assert.equal((await doc(id)).pos.usage.check.id, won.data.check.id);
    assert.equal((await audits(id, "pos.usage.check-requested")).length, 1);
  });

  it("is refused with 503 while the worker is offline, storing nothing and using no allowance", async () => {
    const { id } = await fresh();
    await ctx.db.collection("system_state").deleteOne({ _id: "pos-worker" });
    const missing = await checkNow(id);
    assert.equal(missing.status, 503);
    assert.equal(missing.data.code, "not-ready");
    assert.deepEqual(missing.data.items, ["worker"]);
    assert.match(missing.data.error, /worker/i);
    await heartbeat(new Date(Date.now() - 2 * 60000));
    assert.equal((await checkNow(id)).status, 503);
    assert.equal((await doc(id)).pos.usage, undefined);
    assert.equal(await bucketRow(`usage-check:${id}`), null);
    assert.equal((await audits(id, "pos.usage.check-requested")).length, 0);
    await heartbeat();
    assert.equal((await checkNow(id)).status, 202);
  });

  it("a POS block removed after the pre-check answers 404, not busy", async () => {
    const { id } = await fresh();
    await duringConsume(
      `usage-check:${id}`,
      () => setUsage(id, null, { pos: "" }),
      async () => {
        const res = await checkNow(id);
        assert.equal(res.status, 404, JSON.stringify(res.data));
        assert.match(res.data.error, /not been set up/);
      },
    );
    assert.equal((await doc(id)).pos, undefined);
    assert.equal((await audits(id, "pos.usage.check-requested")).length, 0);
  });

  it("may check a retired installation (only the batch skips them)", async () => {
    const { id } = await fresh({ usage: { watch: true } });
    await retire(id);
    const res = await checkNow(id);
    assert.equal(res.status, 202, JSON.stringify(res.data));
    assert.equal((await doc(id)).pos.usage.check.status, "queued");
  });

  it("allows ten checks per installation per hour", async () => {
    await clearOfWindow(HOUR);
    const { id } = await fresh();
    for (let i = 0; i < 10; i++) {
      await setUsage(id, { "pos.usage.check.status": "done" });
      assert.equal((await checkNow(id)).status, 202, `request ${i + 1}`);
    }
    await setUsage(id, { "pos.usage.check.status": "done" });
    const limited = await checkNow(id);
    assert.equal(limited.status, 429);
    assert.equal(
      (await doc(id)).pos.usage.check.status,
      "done",
      "nothing queued",
    );
  });
});

describe("check watched clients", () => {
  it("queues every watched client without an active check under one batch id", async () => {
    await unwatchAll();
    const since = new Date();
    const idle = await fresh({ usage: { watch: true } });
    const busy = await fresh({ usage: { watch: true } });
    const finished = await fresh({ usage: { watch: true } });
    const unwatched = await fresh();
    // Retired: neither queued nor counted as skipped.
    const retired = await fresh({ usage: { watch: true } });
    await retire(retired.id);
    assert.equal((await checkNow(busy.id)).status, 202);
    const busyCheck = (await doc(busy.id)).pos.usage.check;
    await setUsage(finished.id, {
      "pos.usage.check": {
        id: randomUUID(),
        status: "done",
        batchId: null,
        requestedAt: new Date(Date.now() - HOUR),
        by: { id: "x", name: "Owner" },
        lease: { owner: "w", until: new Date(), fence: 2 },
        attempt: 1,
        startedAt: new Date(),
        finishedAt: new Date(),
        error: null,
      },
    });
    const res = await batch(admin);
    assert.equal(res.status, 202, JSON.stringify(res.data));
    assert.deepEqual(Object.keys(res.data).sort(), [
      "batchId",
      "queued",
      "skipped",
    ]);
    assert.equal(res.data.queued, 2);
    assert.equal(res.data.skipped, 1);
    const { batchId } = res.data;
    for (const f of [idle, finished]) {
      const check = (await doc(f.id)).pos.usage.check;
      assert.equal(check.status, "queued");
      assert.equal(check.batchId, batchId);
      assert.equal(check.id, batchId);
      assert.deepEqual(check.lease, { owner: null, until: null, fence: 0 });
      assert.equal(check.attempt, 0);
      assert.equal(check.by.name, "admin");
    }
    assert.deepEqual((await doc(busy.id)).pos.usage.check, busyCheck);
    assert.equal((await doc(unwatched.id)).pos.usage, undefined);
    assert.equal((await doc(retired.id)).pos.usage.check, undefined);
    assert.equal((await getUsage(idle.id)).data.check.batch, true);
    const rows = await audits("pos-usage", "pos.usage.batch-requested", since);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].resource, "system");
    assert.equal(rows[0].detail, "2 queued, 1 skipped");
    assertNoSecrets(rows, SECRETS, "audit rows");
    // Everything is now queued: a second batch is refused before the hourly
    // allowance and writes no audit row.
    const used = (await bucketRow(`usage-batch:${owner.user._id}`))?.count;
    const second = await batch();
    assert.equal(second.status, 409);
    assert.equal(second.data.code, "busy");
    assert.equal(
      second.data.error,
      "Every watched client already has a check queued or running.",
    );
    assert.equal(
      (await bucketRow(`usage-batch:${owner.user._id}`))?.count,
      used,
      "a busy refusal uses no allowance",
    );
    assert.equal(
      (await audits("pos-usage", "pos.usage.batch-requested", since)).length,
      1,
    );
  });

  it("refuses offline, no-watched and all-busy before the allowance; 429 after six per hour", async () => {
    await clearOfWindow(HOUR);
    await unwatchAll();
    await fresh();
    const key = `usage-batch:${owner.user._id}`;
    const since = new Date();
    const none = await batch();
    assert.equal(none.status, 409);
    assert.equal(none.data.code, "no-watched");
    assert.equal(none.data.error, "No clients are on the watch list.");
    // A watched but retired client does not count.
    const retired = await fresh({ usage: { watch: true } });
    await retire(retired.id);
    assert.equal((await batch()).data.code, "no-watched");
    assert.equal(await bucketRow(key), null, "no-watched uses no allowance");
    await heartbeat(new Date(Date.now() - 5 * 60000));
    const offline = await batch();
    assert.equal(offline.status, 503);
    assert.equal(offline.data.code, "not-ready");
    await heartbeat();
    // Every watched client already busy: refused, no allowance used.
    const w = await fresh({ usage: { watch: true } });
    assert.equal((await checkNow(w.id)).status, 202);
    for (let i = 0; i < 7; i++) {
      const busy = await batch();
      assert.equal(busy.status, 409, `busy ${i + 1}`);
      assert.equal(busy.data.code, "busy");
    }
    assert.equal(await bucketRow(key), null, "busy uses no allowance");
    // Six real batches per staff member per hour.
    for (let i = 0; i < 6; i++) {
      await setUsage(w.id, { "pos.usage.check.status": "done" });
      assert.equal((await batch()).status, 202, `batch ${i + 1}`);
    }
    await setUsage(w.id, { "pos.usage.check.status": "done" });
    assert.equal((await batch()).status, 429);
    assert.equal(
      (await doc(w.id)).pos.usage.check.status,
      "done",
      "nothing queued",
    );
    // The allowance is per staff member.
    assert.equal((await batch(admin)).status, 202);
    assert.equal((await doc(retired.id)).pos.usage.check, undefined);
    assert.equal(
      (await audits("pos-usage", "pos.usage.batch-requested", since)).length,
      7,
      "only the queued batches are audited",
    );
  });

  it("a batch that loses every slot in a race is refused busy with no audit row", async () => {
    await unwatchAll();
    const a = await fresh({ usage: { watch: true } });
    const since = new Date();
    await duringConsume(
      `usage-batch:${owner.user._id}`,
      // Another request queues the only watched client first.
      () => setUsage(a.id, { "pos.usage.check": queuedCheck() }),
      async () => {
        const res = await batch();
        assert.equal(res.status, 409, JSON.stringify(res.data));
        assert.equal(res.data.code, "busy");
      },
    );
    assert.equal((await doc(a.id)).pos.usage.check.batchId, null);
    assert.equal(
      (await audits("pos-usage", "pos.usage.batch-requested", since)).length,
      0,
    );
  });
});

describe("fleet and overview", () => {
  it("fleet rows carry the usage summary and the worker state", async () => {
    const at = new Date(Date.now() - 300000),
      requestedAt = new Date(Date.now() - 20000);
    const f = await fresh({
      usage: {
        watch: true,
        mail: { storage: { at: new Date(), level: "warning" } },
        check: {
          id: randomUUID(),
          status: "running",
          batchId: null,
          requestedAt,
          by: { id: "x", name: "Owner" },
          lease: { owner: "w1", until: new Date(), fence: 3 },
          attempt: 1,
        },
        last: {
          at,
          level: "warning",
          durationMs: 1000,
          site: {
            state: "up",
            code: "ok",
            httpStatus: 200,
            latencyMs: 321,
            probes: 1,
          },
          mongo: { source: "health", code: "ok", maxPct: 0.8, clusters: [] },
          cloudflare: {
            code: "ok",
            day: "2026-10-11",
            requests: 50000,
            errors: 2,
            pct: 0.5,
            token: CF_TOKEN,
          },
        },
      },
    });
    const res = await call(`/pos/fleet?light=1&customerId=${f.customerId}`, {
      session: admin,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.workerOnline, true);
    assert.equal(res.data.usageStalled, false);
    assert.equal(res.data.rows.length, 1);
    assert.deepEqual(res.data.rows[0].usage, {
      watch: true,
      batchable: true,
      check: "running",
      level: "warning",
      site: "up",
      latencyMs: 321,
      storagePct: 0.8,
      workersPct: 0.5,
      workersDay: "2026-10-11",
      checkedAt: at.toISOString(),
    });
    const text = JSON.stringify(res.data);
    for (const word of ["lease", "fence", "mail", "requests"])
      assert.equal(text.includes(word), false, word);
    // Unchanged fields are still there.
    assert.equal(res.data.rows[0].slug, f.slug);
    assert.equal(res.data.rows[0].relation, "none");

    const plain = await fresh();
    const empty = await call(
      `/pos/fleet?light=1&customerId=${plain.customerId}`,
    );
    assert.deepEqual(empty.data.rows[0].usage, {
      watch: false,
      batchable: false,
      check: null,
      level: null,
      site: null,
      latencyMs: null,
      storagePct: null,
      workersPct: null,
      workersDay: null,
      checkedAt: null,
    });
    // Worker offline (stale or no heartbeat): usage checks are stalled.
    await setUsage(f.id, { "pos.usage.check.status": "done" });
    await heartbeat(new Date(Date.now() - 5 * 60000));
    const done = await call(`/pos/fleet?light=1&customerId=${f.customerId}`);
    assert.equal(done.data.rows[0].usage.check, "done");
    assert.equal(done.data.workerOnline, false);
    assert.equal(done.data.usageStalled, true);
    await ctx.db.collection("system_state").deleteOne({ _id: "pos-worker" });
    const gone = await call(`/pos/fleet?light=1&customerId=${f.customerId}`);
    assert.equal(gone.data.workerOnline, false);
    assert.equal(gone.data.usageStalled, true);
    await heartbeat();
  });

  it("fleet usageStalled: an old queued check with none running (server clock), from the loaded rows only", async () => {
    const a = await fresh({
      usage: {
        watch: true,
        check: { ...queuedCheck(), requestedAt: ago(11 * MIN) },
      },
    });
    const url = `/pos/fleet?light=1&customerId=${a.customerId}`;
    const read = async () => (await call(url)).data;
    let data = await read();
    assert.equal(data.workerOnline, true);
    assert.equal(data.rows[0].usage.check, "queued");
    assert.equal(data.usageStalled, true);
    // A long batch: another loaded row is running, so the old queued check
    // only waits its turn (same customer, its staging installation).
    const b = await fresh({ usage: { watch: true, check: runningCheck() } });
    await ctx.db
      .collection("installations")
      .updateOne(
        { _id: b.id },
        { $set: { customerId: a.customerId, environment: "staging" } },
      );
    data = await read();
    assert.equal(data.rows.length, 2);
    assert.equal(data.usageStalled, false);
    await setUsage(b.id, { "pos.usage.check.status": "done" });
    assert.equal((await read()).usageStalled, true);
    // ...but one that finished a moment ago means the batch is moving.
    await setUsage(b.id, { "pos.usage.check.finishedAt": new Date() });
    assert.equal((await read()).usageStalled, false);
    await setUsage(b.id, { "pos.usage.check.finishedAt": ago(2 * MIN) });
    assert.equal((await read()).usageStalled, true);
    // Queued 9 minutes ago, or nothing active: not stalled.
    await setUsage(a.id, { "pos.usage.check.requestedAt": ago(9 * MIN) });
    assert.equal((await read()).usageStalled, false);
    await setUsage(a.id, { "pos.usage.check.status": "done" });
    assert.equal((await read()).usageStalled, false);
    // Worker offline: stalled with nothing active too.
    await heartbeat(ago(5 * MIN));
    data = await read();
    assert.equal(data.workerOnline, false);
    assert.equal(data.usageStalled, true);
    await heartbeat();
  });

  it("fleet usage.batchable: watched and not retired (the watch list a batch queues)", async () => {
    const a = await fresh({ usage: { watch: true } });
    const url = `/pos/fleet?light=1&customerId=${a.customerId}`;
    const usage = async () => (await call(url)).data.rows[0].usage;
    let u = await usage();
    assert.equal(u.watch, true);
    assert.equal(u.batchable, true);
    // Retired: keeps its flag but a batch skips it.
    await retire(a.id);
    u = await usage();
    assert.equal(u.watch, true);
    assert.equal(u.batchable, false);
    await ctx.db
      .collection("installations")
      .updateOne({ _id: a.id }, { $set: { status: "live" } });
    await setUsage(a.id, { "pos.usage.watch": false });
    u = await usage();
    assert.equal(u.watch, false);
    assert.equal(u.batchable, false);
  });

  it("overview counts watched clients by level and carries the retention sweep", async () => {
    await unwatchAll();
    const older = new Date(Date.now() - 3 * HOUR),
      newer = new Date(Date.now() - HOUR),
      sweptAt = new Date(Date.now() - 2 * HOUR);
    await fresh({
      usage: { watch: true, last: { at: older, level: "critical" } },
    });
    await fresh({
      usage: { watch: true, last: { at: newer, level: "warning" } },
    });
    await fresh({ usage: { watch: true, last: { at: older, level: "ok" } } });
    // Not watched: never counted, even when critical and newest.
    await fresh({
      usage: { watch: false, last: { at: new Date(), level: "critical" } },
    });
    // Retired: never counted either, even when watched.
    const retired = await fresh({
      usage: { watch: true, last: { at: new Date(), level: "critical" } },
    });
    await retire(retired.id);
    await ctx.db.collection("system_state").updateOne(
      { _id: "pos-worker" },
      {
        $set: {
          retention: {
            at: sweptAt,
            checked: 9,
            copied: 3,
            missing: 2,
            failed: 1,
          },
        },
      },
    );
    // A watch change clears the overview cache (5 s otherwise).
    const late = await fresh();
    assert.equal((await putWatch(late.id, { watch: true })).status, 200);
    // Every role reads the /overview counts (the viewer included).
    const res = await call("/overview", { session: viewer });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.usage, {
      watched: 4,
      critical: 1,
      warning: 1,
      lastCheckAt: newer.toISOString(),
    });
    assert.deepEqual(res.data.retention, {
      failed: 1,
      missing: 2,
      at: sweptAt.toISOString(),
    });
    // The existing POS block keeps its shape.
    assert.deepEqual(Object.keys(res.data.pos).sort(), [
      "failed",
      "locked",
      "rolledBack",
      "total",
      "unhealthy",
      "unverified",
      "workerOnline",
    ]);

    // Junk or missing retention reads as zero / null.
    await ctx.db
      .collection("system_state")
      .updateOne(
        { _id: "pos-worker" },
        { $set: { retention: { at: "yesterday", failed: -3, missing: 1.5 } } },
      );
    await unwatchAll();
    assert.equal((await putWatch(late.id, { watch: true })).status, 200);
    const junk = await call("/overview", { session: owner });
    assert.deepEqual(junk.data.retention, { failed: 0, missing: 0, at: null });
    assert.deepEqual(junk.data.usage, {
      watched: 1,
      critical: 0,
      warning: 0,
      lastCheckAt: null,
    });
    await ctx.db
      .collection("system_state")
      .updateOne({ _id: "pos-worker" }, { $unset: { retention: "" } });
    await unwatchAll();
    assert.equal((await putWatch(late.id, { watch: false })).status, 200);
    const bare = await call("/overview", { session: owner });
    assert.deepEqual(bare.data.retention, { failed: 0, missing: 0, at: null });
    assert.deepEqual(bare.data.usage, {
      watched: 0,
      critical: 0,
      warning: 0,
      lastCheckAt: null,
    });
  });

  it("no audit row written by these routes carries a secret", async () => {
    const rows = await ctx.db
      .collection("audit_events")
      .find({ action: { $regex: "^pos\\.usage\\." } })
      .toArray();
    assert.ok(rows.length > 0);
    assertNoSecrets(rows, SECRETS, "audit rows");
    for (const row of rows) assert.ok(row.detail.length <= 200);
  });
});
