import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { BSON } from "mongodb";
import {
  startApp,
  assertNoSecrets,
  VAULT_KEY,
  BACKUP_KEY,
  clearOfWindow,
  until,
} from "./helpers.js";
import { createApp } from "../backend/app.js";
import { createFakeS3 } from "./fake-s3.js";
import { decrypt, encrypt, digest } from "../backend/lib/crypto.js";
import {
  base32Encode,
  base32Decode,
  codeAt,
  stepAt,
} from "../backend/lib/totp.js";
import { makeSnapshot, parseSnapshot } from "../backend/lib/snapshot.js";
import { verifySecretBoxes } from "../backend/lib/secrets.js";
import { cleanFileName } from "../backend/modules/files.js";
import { POS_SECRET_FIELDS } from "../shared/schemas.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const KEY = "JBSWY3DPEHPK3PXPJBSWY3DP"; // 24 base32 chars
const SECRET = {
  password: "Pa$$ w0rd-Secret-1  ",
  totpKey: KEY,
  codes: ["ABCD-1111-ZZ", "EFGH-2222-YY", "IJKL-3333-XX"],
};
const POS_VALUES = {
  "vercel.token": "vercel-token-plain-0123456789",
  "mongo.uri": "mongodb+srv://user:pw-plain-9876@cluster0.example.net/pos_db",
  "cloudflare.token": "cloudflare-token-plain-abcdef",
  "image.keys": JSON.stringify({
    accessKeyId: "r2-access-plain-key",
    secretAccessKey: "r2-secret-plain-key-zzz",
  }),
  "generated.authSecret": "auth-secret-plain-0123456789abcdef",
  "generated.healthStatsToken": "health-token-plain-0123456789abc",
  "generated.realtimePublishSecret": "realtime-secret-plain-0123456789",
  "posAdmin.password": "Pos-admin-plain-9!",
};
const PLAINTEXTS = [
  SECRET.password,
  SECRET.totpKey,
  ...SECRET.codes,
  ...Object.values(POS_VALUES),
  "r2-access-plain-key",
  "pw-plain-9876",
  VAULT_KEY,
  BACKUP_KEY,
];

let ctx, fake, base, servers, owner, admin, operations, viewer;
async function serve(deps) {
  const app = createApp({
    db: ctx.db,
    client: ctx.client,
    c: ctx.c,
    sendCode: async (email, code) => ctx.mail.set(email, code),
    notify: async () => {},
    ...deps,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function call(
  path,
  { method = "GET", body, session, headers = {}, at = base } = {},
) {
  const res = await fetch(`${at}/api${path}`, {
    method,
    headers: {
      Origin: ctx.origin,
      "Content-Type": "application/json",
      ...(session
        ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
        : {}),
      ...headers,
    },
    ...(body === undefined || method === "GET"
      ? {}
      : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}
const stepUp = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );
const stepDown = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $unset: { stepUpUntil: "" } },
    );
// Raw upload over node:http so tests control framing, aborts and stalls.
function upload(
  session,
  cid,
  {
    name = "contract.pdf",
    category = "agreement",
    body = Buffer.from("x"),
    length = body?.length,
    headers = {},
    send = true,
    at = base,
  } = {},
) {
  const url = new URL(`${at}/api/customers/${cid}/files`);
  let req;
  const promise = new Promise((resolve) => {
    req = http.request(
      url,
      {
        method: "POST",
        headers: {
          Origin: ctx.origin,
          Cookie: session.cookie,
          "X-CSRF-Token": session.csrf,
          "Content-Type": "application/octet-stream",
          ...(length === null ? {} : { "Content-Length": String(length) }),
          ...(name === null ? {} : { "X-File-Name": encodeURIComponent(name) }),
          ...(category === null ? {} : { "X-File-Category": category }),
          ...headers,
        },
      },
      (res) => {
        const parts = [];
        res.on("data", (d) => parts.push(d));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, data, text });
        });
      },
    );
    req.on("error", (error) => resolve({ error }));
    if (send) req.end(body);
  });
  return { req, promise };
}
const up = (session, cid, options) => upload(session, cid, options).promise;
// A request that passes the transfer-slot gate but fails on its malformed
// customer id (version/variant nibbles) before any rate limit is consumed:
// 503 means the slots are full, anything else means one is free.
const slotsFull = () =>
  up(admin, "11111111-1111-1111-1111-111111111111", { body: Buffer.from("x") });
const PROBE = { every: 50, timeout: 15000, what: "the transfer slots" };
async function download(session, cid, fid, at = base) {
  const res = await fetch(`${at}/api/customers/${cid}/files/${fid}/download`, {
    method: "POST",
    headers: {
      Origin: ctx.origin,
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrf,
    },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes };
}
let counter = 0;
async function mkCustomer() {
  const n = ++counter;
  const res = await call("/customers", {
    method: "POST",
    session: admin,
    body: {
      name: `Vault Client ${n}`,
      email: `vault${n}@example.test`,
      company: "Vault Co",
      phone: "",
      status: "active",
      notes: "",
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data._id;
}
const productId = async (slug) =>
  (await ctx.db.collection("products").findOne({ slug }))._id;
async function mkInstallation(cid, slug = "pos", environment = "production") {
  const res = await call("/installations", {
    method: "POST",
    session: admin,
    body: {
      name: `${slug} install`,
      customerId: cid,
      productId: await productId(slug),
      environment,
      status: "planned",
      release: "",
      sourceUrl: "",
      endpoint: "",
      connectionIds: [],
      checks: [],
      evidence: "",
      notes: "",
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data._id;
}
const customerDoc = (cid) =>
  ctx.db.collection("customers").findOne({ _id: cid });
const installationDoc = (iid) =>
  ctx.db.collection("installations").findOne({ _id: iid });
const audits = (filter) =>
  ctx.db
    .collection("audit_events")
    .find(filter)
    .sort({ createdAt: 1 })
    .toArray();
async function mkAccount(cid, extra = {}) {
  const res = await call(`/customers/${cid}/accounts`, {
    method: "POST",
    session: admin,
    body: {
      service: "gmail",
      label: "Main mailbox",
      login: "client@example.test",
      password: SECRET.password,
      totpKey: SECRET.totpKey,
      backupCodes: SECRET.codes,
      ...extra,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}
const POS_CONFIG = (slug) => ({
  slug,
  subdomain: "cafe",
  host: `cafe.pos.example.com`,
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
async function putSecrets(iid, rev, fields = POS_SECRET_FIELDS) {
  await stepUp(owner);
  for (const field of fields) {
    const res = await call(`/installations/${iid}/pos/secret`, {
      method: "PUT",
      session: admin,
      body: { rev, field, value: POS_VALUES[field] },
    });
    assert.equal(res.status, 200, `${field}: ${JSON.stringify(res.data)}`);
    rev = res.data.pos.rev;
  }
  return rev;
}
const filler = (n, extra = {}) =>
  Array.from({ length: n }, () => ({
    id: randomUUID(),
    name: "filler.pdf",
    category: "other",
    size: 1,
    sha256: "0".repeat(64),
    contentType: "application/pdf",
    s3Key: "files/x/y",
    versionId: "v",
    dataKey: null,
    uploadedBy: "t",
    uploadedById: "t",
    uploadedAt: new Date(),
    deletedAt: null,
    deletedBy: null,
    restoredAt: null,
    purgedAt: null,
    ...extra,
  }));

before(async () => {
  servers = [];
  ctx = await startApp({ dbName: "vault_test" });
  fake = createFakeS3();
  base = await serve({ s3: fake.client() });
  owner = await ctx.login("owner@example.test");
  admin = await ctx.login("admin@example.test");
  operations = await ctx.login("operations@example.test");
  viewer = await ctx.login("viewer@example.test");
});
after(async () => {
  for (const server of servers)
    await new Promise((resolve) => server.close(resolve));
  await ctx.stop();
});
beforeEach(async () => {
  await ctx.db.collection("rate_limits").deleteMany({});
  fake.reset();
  fake.clear();
  fake.hooks.afterPut = null;
  fake.hooks.beforePut = null;
  fake.state.versioning = true;
});

describe("accounts vault", () => {
  it("enforces the role matrix: 401 / 403 / 428", async () => {
    const cid = await mkCustomer();
    const acc = await mkAccount(cid);
    const a = `/customers/${cid}/accounts`;
    const routes = [
      ["GET", a, undefined, "credentials"],
      ["POST", a, { service: "gmail", label: "x" }, "credentials"],
      [
        "PUT",
        `${a}/${acc.id}`,
        { service: "gmail", label: "x", rev: acc.rev },
        "credentials",
      ],
      [
        "PUT",
        `${a}/${acc.id}/secret`,
        { rev: acc.rev, field: "password", value: "pw" },
        "credentials",
      ],
      [
        "POST",
        `${a}/${acc.id}/backup-codes/used`,
        { rev: acc.rev, index: 0 },
        "credentials",
      ],
      [
        "DELETE",
        `${a}/${acc.id}/secret`,
        { rev: acc.rev, field: "password" },
        "secrets",
      ],
      ["DELETE", `${a}/${acc.id}`, { rev: acc.rev }, "secrets"],
      ["POST", `${a}/${acc.id}/reveal`, { field: "password" }, "secrets"],
      ["POST", `${a}/${acc.id}/code`, {}, "secrets"],
    ];
    await stepDown(owner);
    for (const [method, path, body, need] of routes) {
      const label = `${method} ${path.replace(cid, ":id").replace(acc.id, ":aid")}`;
      assert.equal((await call(path, { method, body })).status, 401, label);
      assert.equal(
        (await call(path, { method, body, session: viewer })).status,
        403,
        `${label} viewer`,
      );
      assert.equal(
        (await call(path, { method, body, session: operations })).status,
        403,
        `${label} operations`,
      );
      if (need === "secrets") {
        assert.equal(
          (await call(path, { method, body, session: admin })).status,
          403,
          `${label} admin`,
        );
        assert.equal(
          (await call(path, { method, body, session: owner })).status,
          428,
          `${label} owner without step-up`,
        );
      }
    }
    // Nothing above changed the entry.
    assert.equal((await customerDoc(cid)).accounts[0].rev, 1);
  });

  it("creates accounts with encrypted, AAD-bound boxes and a whitelist view", async () => {
    const cid = await mkCustomer();
    const view = await mkAccount(cid);
    assert.deepEqual(Object.keys(view).sort(), [
      "changedAt",
      "codesLeft",
      "codesTotal",
      "hasPassword",
      "hasTotp",
      "id",
      "label",
      "login",
      "notes",
      "recoveryContact",
      "rev",
      "service",
    ]);
    assert.equal(view.hasPassword, true);
    assert.equal(view.hasTotp, true);
    assert.equal(view.codesTotal, 3);
    assert.equal(view.codesLeft, 3);
    assertNoSecrets(view, PLAINTEXTS);
    const stored = (await customerDoc(cid)).accounts[0];
    // Not trimmed, sealed to its own record.
    assert.equal(
      decrypt(
        stored.password,
        VAULT_KEY,
        `account:${cid}:${stored.id}:password`,
      ),
      SECRET.password,
    );
    assert.equal(
      decrypt(stored.totpKey, VAULT_KEY, `account:${cid}:${stored.id}:totpKey`),
      KEY,
    );
    assert.deepEqual(
      JSON.parse(
        decrypt(
          stored.backupCodes,
          VAULT_KEY,
          `account:${cid}:${stored.id}:backupCodes`,
        ),
      ),
      SECRET.codes,
    );
    assert.deepEqual(stored.totpParams, {
      algorithm: "sha1",
      digits: 6,
      period: 30,
    });
    assert.equal(JSON.stringify(stored).includes(SECRET.password), false);
    assert.throws(() =>
      decrypt(
        stored.password,
        VAULT_KEY,
        `account:${cid}:${stored.id}:totpKey`,
      ),
    );
    const list = await call(`/customers/${cid}/accounts`, { session: admin });
    assert.equal(list.status, 200);
    assertNoSecrets(list.data, PLAINTEXTS);
    assert.equal(
      (await audits({ action: "account.created" })).length > 0,
      true,
    );
  });

  it("validates input without echoing values and rejects unknown keys", async () => {
    const cid = await mkCustomer();
    const bad = "Z".repeat(1030);
    for (const body of [
      { service: "gmail", label: "x", password: bad },
      { service: "gmail", label: "x", totpKey: "not-a-valid-key!!!!!!!!!!!" },
      { service: "gmail", label: "x", totpKey: "AAAA" },
      { service: "gmail", label: "x", backupCodes: ["abc"] },
      { service: "gmail", label: "x", extra: "SECRETVALUE9999" },
      { service: "nope", label: "x" },
    ]) {
      const res = await call(`/customers/${cid}/accounts`, {
        method: "POST",
        session: admin,
        body,
      });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(JSON.stringify(res.data).includes(bad), false);
      assert.equal(JSON.stringify(res.data).includes("not-a-valid-key"), false);
      assert.equal(JSON.stringify(res.data).includes("SECRETVALUE9999"), false);
    }
    assert.equal((await customerDoc(cid)).accounts, undefined);
  });

  it("keeps per-entry rev, never bumps the customer revision, and 409s on stale rev", async () => {
    const cid = await mkCustomer();
    const before = (await customerDoc(cid)).revision;
    const acc = await mkAccount(cid);
    const a = `/customers/${cid}/accounts/${acc.id}`;
    const edit = await call(a, {
      method: "PUT",
      session: admin,
      body: {
        service: "vercel",
        label: "Vercel",
        rev: acc.rev,
        login: "v@x.test",
      },
    });
    assert.equal(edit.status, 200);
    assert.equal(edit.data.rev, 2);
    assert.equal(edit.data.service, "vercel");
    const stale = await call(a, {
      method: "PUT",
      session: admin,
      body: { service: "gmail", label: "again", rev: 1 },
    });
    assert.equal(stale.status, 409);
    assert.equal((await customerDoc(cid)).revision, before);
    assert.equal((await customerDoc(cid)).accounts[0].label, "Vercel");
    // Two racing writers with the same rev: exactly one wins.
    const [x, y] = await Promise.all(
      ["one", "two"].map((label) =>
        call(a, {
          method: "PUT",
          session: admin,
          body: { service: "gmail", label, rev: 2 },
        }),
      ),
    );
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal((await call(`${a}x`, { session: admin })).status >= 400, true);
    assert.equal(
      (
        await call(`/customers/${randomUUID()}/accounts/${acc.id}`, {
          method: "PUT",
          session: admin,
          body: { service: "gmail", label: "z", rev: 1 },
        })
      ).status,
      404,
    );
  });

  it("caps an entry list at 50 accounts", async () => {
    const cid = await mkCustomer();
    const rows = Array.from({ length: 49 }, () => ({
      id: randomUUID(),
      rev: 1,
      service: "other",
      label: "f",
      login: "",
      password: null,
      totpKey: null,
      totpParams: null,
      backupCodes: null,
      backupCodesCount: 0,
      backupCodesUsed: [],
      recoveryContact: "",
      notes: "",
      createdAt: new Date(),
      changedAt: new Date(),
    }));
    await ctx.db
      .collection("customers")
      .updateOne({ _id: cid }, { $set: { accounts: rows } });
    const body = { service: "other", label: "fiftieth" };
    assert.equal(
      (
        await call(`/customers/${cid}/accounts`, {
          method: "POST",
          session: admin,
          body,
        })
      ).status,
      201,
    );
    const over = await call(`/customers/${cid}/accounts`, {
      method: "POST",
      session: admin,
      body,
    });
    assert.equal(over.status, 409);
    assert.equal((await customerDoc(cid)).accounts.length, 50);
    assert.equal(
      (
        await call(`/customers/${randomUUID()}/accounts`, {
          method: "POST",
          session: admin,
          body,
        })
      ).status,
      404,
    );
  });

  it("replaces secrets, tracks backup codes and resets them on replacement", async () => {
    const cid = await mkCustomer();
    const acc = await mkAccount(cid);
    const a = `/customers/${cid}/accounts/${acc.id}`;
    const used = await call(`${a}/backup-codes/used`, {
      method: "POST",
      session: admin,
      body: { rev: 1, index: 1 },
    });
    assert.equal(used.status, 200);
    assert.equal(used.data.codesLeft, 2);
    assert.equal(used.data.rev, 2);
    // Already used / out of range / stale rev all refuse.
    for (const body of [
      { rev: 2, index: 1 },
      { rev: 2, index: 3 },
      { rev: 1, index: 0 },
    ])
      assert.equal(
        (
          await call(`${a}/backup-codes/used`, {
            method: "POST",
            session: admin,
            body,
          })
        ).status,
        409,
      );
    const replaced = await call(`${a}/secret`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 2,
        field: "backupCodes",
        value: ["NEW-CODE-1", "NEW-CODE-2"],
      },
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.data.codesTotal, 2);
    assert.equal(replaced.data.codesLeft, 2);
    assert.deepEqual((await customerDoc(cid)).accounts[0].backupCodesUsed, []);
    const pw = await call(`${a}/secret`, {
      method: "PUT",
      session: admin,
      body: { rev: 3, field: "password", value: "  spaced new  " },
    });
    assert.equal(pw.status, 200);
    assert.equal(pw.data.rev, 4);
    await stepUp(owner);
    const shown = await call(`${a}/reveal`, {
      method: "POST",
      session: owner,
      body: { field: "password" },
    });
    assert.equal(shown.data.value, "  spaced new  ");
    assert.equal(
      (
        await call(`${a}/secret`, {
          method: "PUT",
          session: admin,
          body: { rev: 1, field: "password", value: "stale" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(`${a}/secret`, {
          method: "PUT",
          session: admin,
          body: { rev: 4, field: "totpKey", value: "garbage1garbage1garbage1" },
        })
      ).status,
      400,
    );
  });

  it("reveal is step-up gated, audited, never trimmed, and rate limited (31st = 429)", async () => {
    await clearOfWindow(3600000);
    const cid = await mkCustomer();
    const acc = await mkAccount(cid);
    const a = `/customers/${cid}/accounts/${acc.id}/reveal`;
    await stepUp(owner);
    const pw = await call(a, {
      method: "POST",
      session: owner,
      body: { field: "password" },
    });
    assert.equal(pw.status, 200);
    assert.deepEqual(pw.data, { value: SECRET.password });
    const key = await call(a, {
      method: "POST",
      session: owner,
      body: { field: "totpKey" },
    });
    assert.deepEqual(key.data, { value: KEY });
    const codes = await call(a, {
      method: "POST",
      session: owner,
      body: { field: "backupCodes" },
    });
    assert.deepEqual(
      codes.data.codes.map((c) => [c.index, c.code, c.used]),
      SECRET.codes.map((code, i) => [i, code, false]),
    );
    const events = await audits({
      action: "account.revealed",
      resourceId: cid,
    });
    assert.equal(events.length, 3);
    for (const event of events) {
      assert.equal(event.actorId, owner.user._id);
      assert.equal(typeof event.ip, "string");
      for (const secret of PLAINTEXTS)
        assert.equal(event.detail.includes(secret), false);
    }
    assert.match(events[0].detail, /gmail: Main mailbox \(password\)/);
    // Unknown field, empty field.
    assert.equal(
      (
        await call(a, {
          method: "POST",
          session: owner,
          body: { field: "nope" },
        })
      ).status,
      400,
    );
    const empty = await mkAccount(cid, {
      label: "empty",
      password: undefined,
      totpKey: undefined,
      backupCodes: undefined,
    });
    assert.equal(
      (
        await call(`/customers/${cid}/accounts/${empty.id}/reveal`, {
          method: "POST",
          session: owner,
          body: { field: "password" },
        })
      ).status,
      404,
    );
    await ctx.db.collection("rate_limits").deleteMany({});
    for (let i = 0; i < 30; i++)
      assert.equal(
        (
          await call(a, {
            method: "POST",
            session: owner,
            body: { field: "password" },
          })
        ).status,
        200,
        `reveal ${i + 1}`,
      );
    const limited = await call(a, {
      method: "POST",
      session: owner,
      body: { field: "password" },
    });
    assert.equal(limited.status, 429);
    assertNoSecrets(limited.data, PLAINTEXTS);
  });

  it("show-code returns the current code for the stored params, never the key", async () => {
    const cid = await mkCustomer();
    const acc = await mkAccount(cid, {
      totpKey: `otpauth://totp/Svc:me?secret=${KEY}&algorithm=SHA256&digits=8&period=60`,
    });
    const stored = (await customerDoc(cid)).accounts[0];
    assert.deepEqual(stored.totpParams, {
      algorithm: "sha256",
      digits: 8,
      period: 60,
    });
    await stepUp(owner);
    const path = `/customers/${cid}/accounts/${acc.id}/code`;
    const start = Date.now();
    const res = await call(path, { method: "POST", session: owner, body: {} });
    const end = Date.now();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.data).sort(), ["code", "expiresIn"]);
    const params = { algorithm: "sha256", digits: 8, period: 60 };
    const accepted = new Set(
      [start, end].map((t) => codeAt(base32Decode(KEY), stepAt(t, 60), params)),
    );
    assert.ok(accepted.has(res.data.code), "code matches codeAt");
    assert.equal(res.data.code.length, 8);
    assert.ok(res.data.expiresIn >= 1 && res.data.expiresIn <= 60);
    assertNoSecrets(res.data, [KEY, ...PLAINTEXTS]);
    // Default params, and no body at all.
    const plain = await mkAccount(cid, { label: "plain" });
    const noBody = await fetch(
      `${base}/api/customers/${cid}/accounts/${plain.id}/code`,
      {
        method: "POST",
        headers: {
          Origin: ctx.origin,
          "Content-Type": "application/json",
          Cookie: owner.cookie,
          "X-CSRF-Token": owner.csrf,
        },
      },
    );
    assert.equal(noBody.status, 200);
    const accepted2 = new Set(
      [start, Date.now()].map((t) => codeAt(base32Decode(KEY), stepAt(t, 30))),
    );
    assert.ok(accepted2.has((await noBody.json()).code));
    assert.equal(
      (await audits({ action: "account.code-shown" })).length >= 2,
      true,
    );
    // Account with no key.
    const none = await mkAccount(cid, { label: "no key", totpKey: undefined });
    assert.equal(
      (
        await call(`/customers/${cid}/accounts/${none.id}/code`, {
          method: "POST",
          session: owner,
          body: {},
        })
      ).status,
      404,
    );
    // Its own limit: 60 per hour.
    await clearOfWindow(3600000);
    await ctx.db.collection("rate_limits").deleteMany({});
    for (let i = 0; i < 60; i++)
      await call(path, { method: "POST", session: owner, body: {} });
    assert.equal(
      (await call(path, { method: "POST", session: owner, body: {} })).status,
      429,
    );
  });

  it("removes secrets and accounts only with step-up, owner role and the current rev", async () => {
    const cid = await mkCustomer();
    const acc = await mkAccount(cid);
    const a = `/customers/${cid}/accounts/${acc.id}`;
    await stepUp(owner);
    const removed = await call(`${a}/secret`, {
      method: "DELETE",
      session: owner,
      body: { rev: 1, field: "totpKey" },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.hasTotp, false);
    assert.equal((await customerDoc(cid)).accounts[0].totpParams, null);
    const codes = await call(`${a}/secret`, {
      method: "DELETE",
      session: owner,
      body: { rev: 2, field: "backupCodes" },
    });
    assert.equal(codes.data.codesTotal, 0);
    assert.equal(
      (await call(a, { method: "DELETE", session: owner, body: { rev: 1 } }))
        .status,
      409,
    );
    assert.equal(
      (await call(a, { method: "DELETE", session: owner, body: { rev: 3 } }))
        .status,
      200,
    );
    assert.deepEqual((await customerDoc(cid)).accounts, []);
    assert.equal(
      (await audits({ action: "account.deleted" })).length > 0,
      true,
    );
  });

  it("refuses a box moved to another record or field (AAD swap)", async () => {
    const cid = await mkCustomer();
    const first = await mkAccount(cid),
      second = await mkAccount(cid, { label: "second" });
    const doc = await customerDoc(cid);
    const [a, b] = doc.accounts;
    await ctx.db.collection("customers").updateOne(
      { _id: cid },
      {
        $set: {
          "accounts.1.password": a.password,
          "accounts.1.totpKey": a.password,
        },
      },
    );
    await stepUp(owner);
    for (const field of ["password", "totpKey"]) {
      const res = await call(`/customers/${cid}/accounts/${second.id}/reveal`, {
        method: "POST",
        session: owner,
        body: { field },
      });
      assert.equal(res.status, 500, field);
      assertNoSecrets(res.data, PLAINTEXTS);
    }
    assert.equal(
      (
        await call(`/customers/${cid}/accounts/${second.id}/code`, {
          method: "POST",
          session: owner,
          body: {},
        })
      ).status,
      500,
    );
    // Across customers as well.
    const other = await mkCustomer();
    const stolen = await mkAccount(other, { label: "victim" });
    await ctx.db
      .collection("customers")
      .updateOne(
        { _id: other },
        { $set: { "accounts.0.password": a.password } },
      );
    assert.equal(
      (
        await call(`/customers/${other}/accounts/${stolen.id}/reveal`, {
          method: "POST",
          session: owner,
          body: { field: "password" },
        })
      ).status,
      500,
    );
    assert.ok(first && b);
  });
});

describe("generic record API never exposes embedded blocks", () => {
  it("hides accounts/files/pos from list, detail and PUT, and leaves them byte-identical", async () => {
    const cid = await mkCustomer();
    await mkAccount(cid);
    assert.equal(
      (await up(admin, cid, { body: Buffer.from("generic-put".repeat(10)) }))
        .status,
      201,
    );
    const iid = await mkInstallation(cid);
    const created = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: POS_CONFIG("generic-one") },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    await putSecrets(iid, 1);
    const snap = async () => {
      const c1 = await customerDoc(cid),
        i1 = await installationDoc(iid);
      return {
        accounts: BSON.serialize({ v: c1.accounts }),
        files: BSON.serialize({ v: c1.files }),
        pos: BSON.serialize({ v: i1.pos }),
      };
    };
    const before = await snap();
    const stripped = (row) => {
      for (const key of ["accounts", "files", "pos", "secret"])
        assert.equal(Object.hasOwn(row, key), false, `${key} leaked`);
    };
    for (const [kind, id] of [
      ["customers", cid],
      ["installations", iid],
    ]) {
      const list = await call(
        `/${kind}?customerId=${kind === "installations" ? cid : ""}`,
        {
          session: owner,
        },
      );
      assert.equal(list.status, 200);
      list.data.rows.forEach(stripped);
      assertNoSecrets(list.data, PLAINTEXTS);
      const detail = await call(`/${kind}/${id}`, { session: owner });
      stripped(detail.data);
      assertNoSecrets(detail.data, PLAINTEXTS);
      const { _id, createdAt, updatedAt, ...editable } = detail.data;
      assert.ok(_id && createdAt && updatedAt);
      const { revision, ...body } = editable;
      const put = await call(`/${kind}/${id}`, {
        method: "PUT",
        session: admin,
        body: {
          ...body,
          revision,
          notes: "edited through the generic API",
        },
      });
      assert.equal(put.status, 200, JSON.stringify(put.data));
      stripped(put.data);
      assertNoSecrets(put.data, PLAINTEXTS);
      assert.equal(put.data.notes, "edited through the generic API");
    }
    const after = await snap();
    assert.ok(
      before.accounts.equals(after.accounts),
      "accounts byte-identical",
    );
    assert.ok(before.files.equals(after.files), "files byte-identical");
    assert.ok(before.pos.equals(after.pos), "pos byte-identical");
    const created2 = await call("/customers", {
      method: "POST",
      session: admin,
      body: {
        name: "Fresh",
        email: "fresh-generic@example.test",
        company: "",
        phone: "",
        status: "lead",
        notes: "",
      },
    });
    stripped(created2.data);
  });
});

describe("files", () => {
  const body = () => Buffer.from("PLAINTEXT-FILE-CONTENT-".repeat(8));
  it("rejects unsafe names and sanitises headers", () => {
    assert.equal(cleanFileName("../a/b:c*?.PDF").name, "abc.pdf");
    assert.equal(
      cleanFileName("  my   contract\t.docx ").name,
      "my contract .docx".replace(" .", "."),
    );
    assert.equal(cleanFileName("é.txt").name, "é.txt");
    assert.equal(cleanFileName("a‮b\u0000c.json").name, "abc.json");
    const long = cleanFileName(`${"x".repeat(400)}.csv`).name;
    assert.equal(long.length, 150);
    assert.ok(long.endsWith(".csv"));
    for (const bad of [
      "noext",
      ".pdf",
      "..",
      "run.exe",
      "a.pdf.exe",
      "x.",
      "<>.pdf",
    ])
      assert.throws(
        () => cleanFileName(bad),
        (e) => e.status === 400,
        bad,
      );
  });

  it("uploads encrypted, stores metadata only, and downloads back verified", async () => {
    const cid = await mkCustomer();
    const plain = body();
    const res = await up(admin, cid, {
      name: "Agree ment ü.pdf",
      category: "kyc",
      body: plain,
    });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.data).sort(), [
      "category",
      "deletedAt",
      "id",
      "name",
      "restorable",
      "sha256",
      "size",
      "uploadedAt",
      "uploadedBy",
    ]);
    assert.equal(res.data.name, "Agree ment ü.pdf");
    assert.equal(res.data.size, plain.length);
    assert.equal(res.data.sha256, sha256(plain));
    const entry = (await customerDoc(cid)).files[0];
    assert.equal(entry.s3Key, `files/${cid}/${entry.id}`);
    const versions = fake.versions(entry.s3Key);
    assert.equal(versions.length, 1);
    assert.equal(entry.versionId, versions[0].id);
    const object = versions[0].body;
    assert.equal(object.subarray(0, 4).toString(), "SBF1");
    assert.equal(object.length, plain.length + 32);
    assert.equal(object.includes(plain.subarray(0, 16)), false);
    assert.equal(object.includes(Buffer.from("PLAINTEXT")), false);
    assert.equal(
      decrypt(entry.dataKey, VAULT_KEY, `file:${cid}:${entry.id}`).length,
      64,
    );
    assert.equal(JSON.stringify(entry).includes("PLAINTEXT"), false);
    const event = (await audits({ action: "file.uploaded" })).at(-1);
    assert.equal(event.detail.includes("Agree"), false);
    assert.match(event.detail, /^kyc, \d+ bytes, [0-9a-f]{8}$/);
    const list = await call(`/customers/${cid}/files`, { session: admin });
    assert.deepEqual(list.data.rows[0], JSON.parse(JSON.stringify(res.data)));
    assertNoSecrets(list.data, PLAINTEXTS);
    for (const key of ["s3Key", "dataKey", "versionId"])
      assert.equal(Object.hasOwn(list.data.rows[0], key), false);
    // Download needs step-up and returns exactly the plaintext.
    await stepDown(owner);
    assert.equal((await download(owner, cid, entry.id)).status, 428);
    await stepUp(owner);
    const dl = await download(owner, cid, entry.id);
    assert.equal(dl.status, 200);
    assert.ok(dl.bytes.equals(plain));
    assert.equal(dl.headers.get("content-type"), "application/octet-stream");
    assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      dl.headers.get("content-disposition"),
      `attachment; filename*=UTF-8''Agree%20ment%20%C3%BC.pdf`,
    );
    const seen = (await audits({ action: "file.downloaded" })).at(-1);
    assert.equal(seen.detail.includes("Agree"), false);
  });

  it("applies the role matrix to file routes", async () => {
    const cid = await mkCustomer();
    const made = await up(admin, cid, { body: body() });
    const fid = made.data.id;
    const f = `/customers/${cid}/files`;
    await stepDown(owner);
    for (const [method, path, need] of [
      ["GET", f, "credentials"],
      ["POST", `${f}/${fid}/restore`, "credentials"],
      ["POST", `${f}/${fid}/download`, "secrets"],
      ["DELETE", `${f}/${fid}`, "secrets"],
      ["POST", "/files/self-test", "secrets"],
    ]) {
      assert.equal((await call(path, { method, body: {} })).status, 401, path);
      assert.equal(
        (await call(path, { method, body: {}, session: viewer })).status,
        403,
        path,
      );
      assert.equal(
        (await call(path, { method, body: {}, session: operations })).status,
        403,
        path,
      );
      if (need === "secrets") {
        assert.equal(
          (await call(path, { method, body: {}, session: admin })).status,
          403,
          path,
        );
        if (!path.endsWith("self-test"))
          assert.equal(
            (await call(path, { method, body: {}, session: owner })).status,
            428,
            path,
          );
      }
    }
    for (const session of [viewer, operations])
      assert.equal((await up(session, cid, { body: body() })).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/customers/${cid}/files`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            Origin: ctx.origin,
          },
          body: "x",
        })
      ).status,
      401,
    );
  });

  it("refuses bad framing, size, type, name and category", async () => {
    const cid = await mkCustomer();
    const check = async (options, status) => {
      const res = await up(admin, cid, options);
      assert.equal(
        res.status,
        status,
        JSON.stringify(options).slice(0, 100) + res.text,
      );
      assert.deepEqual((await customerDoc(cid)).files ?? [], []);
      assert.equal(fake.allKeys().length, 0);
      return res;
    };
    await check(
      { body: body(), headers: { "Content-Type": "application/json" } },
      415,
    );
    await check({ body: Buffer.alloc(0) }, 400);
    await check({ name: "malware.exe", body: body() }, 400);
    await check({ name: null, body: body() }, 400);
    await check({ name: "x.pdf", category: "secrets", body: body() }, 400);
    await check({ name: "x.pdf", category: null, body: body() }, 400);
    await check(
      { name: "x.pdf", body: body(), headers: { "X-File-Name": "%E0%A4%A" } },
      400,
    );
    // No Content-Length (chunked) -> 411.
    const chunked = upload(admin, cid, { length: null, send: false });
    chunked.req.write(body());
    chunked.req.end();
    assert.equal((await chunked.promise).status, 411);
    // Over 20 MB is refused from the header alone.
    const big = upload(admin, cid, {
      length: 20 * 1024 * 1024 + 1,
      send: false,
    });
    big.req.flushHeaders();
    const refused = await big.promise;
    assert.equal(refused.status, 413);
    big.req.destroy();
    // A query string is not accepted.
    const q = await fetch(`${base}/api/customers/${cid}/files?x=1`, {
      method: "POST",
      headers: {
        Origin: ctx.origin,
        "Content-Type": "application/octet-stream",
        Cookie: admin.cookie,
        "X-CSRF-Token": admin.csrf,
        "X-File-Name": "a.pdf",
        "X-File-Category": "other",
      },
      body: "x",
    });
    assert.equal(q.status, 400);
    // The octet-stream exception covers only this exact route.
    const other = await fetch(`${base}/api/customers/${cid}/accounts`, {
      method: "POST",
      headers: {
        Origin: ctx.origin,
        "Content-Type": "application/octet-stream",
        Cookie: admin.cookie,
        "X-CSRF-Token": admin.csrf,
      },
      body: "x",
    });
    assert.equal(other.status, 415);
    assert.equal((await up(admin, randomUUID(), { body: body() })).status, 404);
  });

  it("a client abort mid-body leaves no object and no entry", async () => {
    const cid = await mkCustomer();
    const { req, promise } = upload(admin, cid, { length: 1000, send: false });
    req.write(Buffer.alloc(100, 1));
    await sleep(150);
    req.destroy();
    await promise;
    await sleep(200);
    assert.equal(fake.calls.filter((call) => call.op === "put").length, 0);
    assert.equal(fake.allKeys().length, 0);
    assert.deepEqual((await customerDoc(cid)).files ?? [], []);
    // A body shorter than declared that finishes cleanly is also refused.
    const short = upload(admin, cid, { length: 50, send: false });
    short.req.write(Buffer.alloc(10));
    await sleep(100);
    short.req.destroy();
    await short.promise;
    assert.equal(fake.allKeys().length, 0);
  });

  it("an S3 failure returns 503 and records nothing", async () => {
    const cid = await mkCustomer();
    fake.fail("put", { status: 500 });
    const res = await up(admin, cid, { body: body() });
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "File storage is unavailable.");
    assert.ok(res.data.requestId);
    assert.deepEqual((await customerDoc(cid)).files ?? [], []);
    fake.fail("put", { throwNetwork: true });
    assert.equal((await up(admin, cid, { body: body() })).status, 503);
    assert.equal(fake.liveKeys().length, 0);
  });

  it("a failed transaction deletes the orphaned object", async () => {
    const cid = await mkCustomer();
    fake.hooks.afterPut = async () => {
      await ctx.db
        .collection("staff")
        .updateOne(
          { email: "admin@example.test" },
          { $inc: { authVersion: 1 } },
        );
    };
    const res = await up(admin, cid, { body: body() });
    fake.hooks.afterPut = null;
    await ctx.db
      .collection("staff")
      .updateOne(
        { email: "admin@example.test" },
        { $inc: { authVersion: -1 } },
      );
    assert.equal(res.status, 403);
    assert.deepEqual((await customerDoc(cid)).files ?? [], []);
    assert.equal(fake.liveKeys().length, 0);
    assert.ok(fake.calls.some((call) => call.op === "delete"));
    assert.equal(
      (await audits({ action: "file.uploaded", resourceId: cid })).length,
      0,
    );
  });

  it("refuses an upload answered without a version id (versioning off)", async () => {
    const cid = await mkCustomer();
    fake.state.versioning = false;
    const res = await up(admin, cid, { body: body() });
    assert.equal(res.status, 503);
    assert.equal(fake.liveKeys().length, 0);
    assert.deepEqual((await customerDoc(cid)).files ?? [], []);
  });

  it("never sends a byte of a tampered, truncated or swapped object", async () => {
    const cid = await mkCustomer();
    const plain = body();
    const one = (await up(admin, cid, { body: plain })).data;
    const two = (await up(admin, cid, { body: Buffer.from(plain).reverse() }))
      .data;
    const files = (await customerDoc(cid)).files;
    const keyOf = (id) => files.find((f) => f.id === id).s3Key;
    await stepUp(owner);
    const bad = async (label) => {
      const res = await download(owner, cid, one.id);
      assert.equal(res.status, 422, label);
      assert.equal(
        res.headers.get("content-type").includes("json"),
        true,
        label,
      );
      assert.equal(res.bytes.includes(Buffer.from("PLAINTEXT")), false, label);
      assert.equal(
        JSON.parse(res.bytes.toString()).error.includes("integrity"),
        true,
      );
    };
    const key = keyOf(one.id);
    const length = fake.versions(key)[0].body.length;
    for (const offset of [0, 6, 20, length - 1]) {
      fake.tamper(key, offset);
      await bad(`offset ${offset}`);
      fake.tamper(key, offset); // restore
    }
    assert.equal((await download(owner, cid, one.id)).status, 200);
    fake.swap(key, keyOf(two.id));
    await bad("swapped objects");
    fake.swap(key, keyOf(two.id));
    assert.equal((await download(owner, cid, one.id)).status, 200);
    assert.ok((await audits({ action: "file.integrity-failed" })).length >= 5);
    // Wrong data key box (AAD) also fails closed.
    await ctx.db
      .collection("customers")
      .updateOne(
        { _id: cid },
        { $set: { "files.0.dataKey": files[1].dataKey } },
      );
    await bad("data key from another file");
  });

  it("delete -> restore -> download, and a purged version answers 410", async () => {
    const cid = await mkCustomer();
    const plain = body();
    const made = (await up(admin, cid, { body: plain })).data;
    const f = `/customers/${cid}/files/${made.id}`;
    await stepDown(owner);
    assert.equal(
      (await call(f, { method: "DELETE", session: owner, body: {} })).status,
      428,
    );
    await stepUp(owner);
    const key = (await customerDoc(cid)).files[0].s3Key;
    const firstVersion = (await customerDoc(cid)).files[0].versionId;
    assert.equal(
      (await call(f, { method: "DELETE", session: owner, body: {} })).status,
      200,
    );
    assert.deepEqual(fake.liveKeys(), []);
    const listed = (await call(`/customers/${cid}/files`, { session: admin }))
      .data.rows[0];
    assert.ok(listed.deletedAt);
    assert.equal(listed.restorable, true);
    assert.equal((await download(owner, cid, made.id)).status, 409);
    assert.equal(
      (await call(f, { method: "DELETE", session: owner, body: {} })).status,
      409,
    );
    const restored = await call(`${f}/restore`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal(restored.data.deletedAt, null);
    const entry = (await customerDoc(cid)).files[0];
    assert.notEqual(entry.versionId, firstVersion, "new versionId stored");
    assert.equal(fake.liveKeys().length, 1);
    assert.ok((await download(owner, cid, made.id)).bytes.equals(plain));
    assert.equal(
      (await call(`${f}/restore`, { method: "POST", session: admin, body: {} }))
        .status,
      409,
    );
    // Delete again, let the lifecycle purge the noncurrent versions.
    assert.equal(
      (await call(f, { method: "DELETE", session: owner, body: {} })).status,
      200,
    );
    fake.purgeNoncurrent(key);
    const gone = await call(`${f}/restore`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(gone.status, 410);
    const purged = (await customerDoc(cid)).files[0];
    assert.ok(purged.purgedAt);
    assert.equal(
      (await call(`/customers/${cid}/files`, { session: admin })).data.rows[0]
        .restorable,
      false,
    );
    assert.equal(
      (await call(`${f}/restore`, { method: "POST", session: admin, body: {} }))
        .status,
      410,
    );
    for (const action of ["file.deleted", "file.restored", "file.purged"])
      assert.ok((await audits({ action })).length >= 1, action);
  });

  it("restore is refused after 29 days; upload pulls entries deleted over 31 days ago", async () => {
    const cid = await mkCustomer();
    const made = (await up(admin, cid, { body: body() })).data;
    await stepUp(owner);
    await call(`/customers/${cid}/files/${made.id}`, {
      method: "DELETE",
      session: owner,
    });
    const days = (n) => new Date(Date.now() - n * 86400000);
    await ctx.db
      .collection("customers")
      .updateOne({ _id: cid }, { $set: { "files.0.deletedAt": days(30) } });
    fake.reset();
    const late = await call(`/customers/${cid}/files/${made.id}/restore`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(late.status, 410);
    assert.equal(
      fake.calls.some((call) => call.op === "copy"),
      false,
    );
    assert.equal(
      (await call(`/customers/${cid}/files`, { session: admin })).data.rows[0]
        .restorable,
      false,
    );
    await ctx.db
      .collection("customers")
      .updateOne({ _id: cid }, { $set: { "files.0.deletedAt": days(32) } });
    assert.equal((await up(admin, cid, { body: body() })).status, 201);
    const files = (await customerDoc(cid)).files;
    assert.equal(files.length, 1);
    assert.notEqual(files[0].id, made.id);
  });

  it("caps a customer at 300 files", async () => {
    const cid = await mkCustomer();
    await ctx.db
      .collection("customers")
      .updateOne({ _id: cid }, { $set: { files: filler(300) } });
    const full = await up(admin, cid, { body: body() });
    assert.equal(full.status, 409);
    assert.equal(fake.calls.length, 0, "no S3 call at the cap");
    // At 299 a concurrent writer fills the last slot between S3 and Mongo.
    await ctx.db
      .collection("customers")
      .updateOne({ _id: cid }, { $set: { files: filler(299) } });
    fake.hooks.afterPut = async () => {
      await ctx.db
        .collection("customers")
        .updateOne({ _id: cid }, { $push: { files: filler(1)[0] } });
    };
    const raced = await up(admin, cid, { body: body() });
    fake.hooks.afterPut = null;
    assert.equal(raced.status, 409);
    assert.equal((await customerDoc(cid)).files.length, 300);
    assert.equal(fake.liveKeys().length, 0, "orphan removed");
    // Old deleted entries make room.
    await ctx.db.collection("customers").updateOne(
      { _id: cid },
      {
        $set: {
          files: [
            ...filler(299),
            ...filler(1, { deletedAt: new Date(Date.now() - 40 * 86400000) }),
          ],
        },
      },
    );
    assert.equal((await up(admin, cid, { body: body() })).status, 201);
    assert.equal((await customerDoc(cid)).files.length, 300);
  });

  it("allows two concurrent transfers and answers the third with 503", async () => {
    const cid = await mkCustomer();
    const stalled = [1, 2].map(() => {
      const t = upload(admin, cid, { length: 10, send: false });
      t.req.write(Buffer.alloc(3));
      return t;
    });
    try {
      // Wait on observable state: the cheap probe is 503 only while both slots
      // are taken (otherwise it is refused as a malformed id after the slot gate).
      await until(async () => (await slotsFull()).status === 503, PROBE);
      const third = await up(admin, cid, { body: body() });
      assert.equal(third.status, 503, third.text);
    } finally {
      for (const t of stalled) t.req.destroy();
    }
    await Promise.all(stalled.map((t) => t.promise));
    // The slots come back once the aborted handlers finish.
    await until(async () => (await slotsFull()).status !== 503, PROBE);
    assert.equal((await up(admin, cid, { body: body() })).status, 201);
  });

  it("answers 503 'not configured' for every file route when S3 is not set up", async () => {
    const cid = await mkCustomer();
    const bare = await serve({ s3: undefined });
    await stepUp(owner);
    const fid = randomUUID();
    const res = await up(admin, cid, { body: body(), at: bare });
    assert.equal(res.status, 503);
    assert.equal(res.data.error, "File storage is not configured.");
    for (const [method, path, session] of [
      ["POST", `/customers/${cid}/files/${fid}/download`, owner],
      ["DELETE", `/customers/${cid}/files/${fid}`, owner],
      ["POST", `/customers/${cid}/files/${fid}/restore`, admin],
      ["POST", "/files/self-test", owner],
    ]) {
      const out = await call(path, { method, session, body: {}, at: bare });
      assert.equal(out.status, 503, path);
      assert.equal(out.data.error, "File storage is not configured.");
    }
    assert.equal(
      (await call(`/customers/${cid}/files`, { session: admin, at: bare }))
        .status,
      200,
    );
  });

  it("self-test reports versioning and listing and leaves nothing behind", async () => {
    await stepDown(owner);
    const ok = await call("/files/self-test", {
      method: "POST",
      session: owner,
      body: {},
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data, { ok: true, versioning: true, listing: true });
    assert.deepEqual(fake.liveKeys(), []);
    fake.state.versioning = false;
    const off = await call("/files/self-test", {
      method: "POST",
      session: owner,
      body: {},
    });
    assert.deepEqual(off.data, { ok: false, versioning: false, listing: true });
    assert.deepEqual(fake.liveKeys(), []);
    fake.state.versioning = true;
    fake.fail("list", { status: 403, code: "AccessDenied" });
    const noList = await call("/files/self-test", {
      method: "POST",
      session: owner,
      body: {},
    });
    assert.deepEqual(noList.data, {
      ok: false,
      versioning: true,
      listing: false,
    });
    assertNoSecrets(noList.data, PLAINTEXTS);
    const events = await audits({ action: "files.self-tested" });
    assert.deepEqual(
      events.slice(-3).map((e) => e.detail),
      ["ok", "failed", "failed"],
    );
  });
});

describe("POS block", () => {
  async function pos(slug = `pos-${++counter}`) {
    const cid = await mkCustomer();
    const iid = await mkInstallation(cid);
    const res = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: POS_CONFIG(slug) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return { cid, iid, slug, view: res.data.pos };
  }
  it("is only available for POS installations, with the role matrix", async () => {
    const cid = await mkCustomer();
    const gst = await mkInstallation(cid, "gst");
    const real = await mkInstallation(cid, "pos", "staging");
    for (const [method, path, body] of [
      ["GET", `/installations/${gst}/pos`],
      [
        "PUT",
        `/installations/${gst}/pos`,
        { rev: 0, config: POS_CONFIG("wrong-one") },
      ],
      [
        "PUT",
        `/installations/${gst}/pos/secret`,
        { rev: 1, field: "mongo.uri", value: POS_VALUES["mongo.uri"] },
      ],
    ]) {
      const res = await call(path, { method, body, session: admin });
      assert.equal(res.status, 400, path);
      assert.match(res.data.error, /only available for POS/);
    }
    assert.equal(
      (await call(`/installations/${randomUUID()}/pos`, { session: admin }))
        .status,
      404,
    );
    assert.deepEqual(
      (await call(`/installations/${real}/pos`, { session: admin })).data,
      {
        pos: null,
      },
    );
    await stepDown(owner);
    const p = `/installations/${real}/pos`;
    const matrix = [
      ["GET", p, undefined, "credentials"],
      ["PUT", p, { rev: 0, config: POS_CONFIG("matrix-one") }, "credentials"],
      [
        "PUT",
        `${p}/secret`,
        { rev: 1, field: "mongo.uri", value: POS_VALUES["mongo.uri"] },
        "credentials",
      ],
      ["DELETE", `${p}/secret`, { rev: 1, field: "mongo.uri" }, "secrets"],
      ["POST", `${p}/reveal`, { field: "mongo.uri" }, "secrets"],
      ["DELETE", p, { rev: 1 }, "secrets"],
    ];
    for (const [method, path, body, need] of matrix) {
      assert.equal(
        (await call(path, { method, body })).status,
        401,
        `${method} ${path}`,
      );
      for (const s of [viewer, operations])
        assert.equal(
          (await call(path, { method, body, session: s })).status,
          403,
        );
      if (need === "secrets") {
        assert.equal(
          (await call(path, { method, body, session: admin })).status,
          403,
        );
        assert.equal(
          (await call(path, { method, body, session: owner })).status,
          428,
        );
      }
    }
    assert.equal((await installationDoc(real)).pos, undefined);
  });

  it("creates with rev 0, derives build.nextPublic server-side and guards by rev", async () => {
    const { iid, view } = await pos();
    assert.equal(view.rev, 1);
    assert.deepEqual(view.build.nextPublic, {
      NEXT_PUBLIC_R2_PUBLIC_BASE_URL: "https://img.example.com",
    });
    assert.deepEqual(view.deploy, {
      current: null,
      last: null,
      previous: null,
    });
    assert.equal(
      Object.values(view.secrets).every((s) => s.set === false),
      true,
    );
    assert.deepEqual(
      Object.keys(view.secrets).sort(),
      [...POS_SECRET_FIELDS].sort(),
    );
    assertNoSecrets(view, PLAINTEXTS);
    // A client-supplied build block is refused.
    const forged = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 1,
        config: {
          ...POS_CONFIG("forge"),
          build: { nextPublic: { NEXT_PUBLIC_X: "1" } },
        },
      },
    });
    assert.equal(forged.status, 400);
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "PUT",
          session: admin,
          body: { rev: 0, config: POS_CONFIG("again") },
        })
      ).status,
      409,
    );
    const edit = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 1,
        config: {
          ...POS_CONFIG("renamed"),
          image: {
            store: "cloudinary",
            publicBaseUrl: "",
            cloudName: "demo-cloud",
            r2AccountId: "",
            bucket: "",
          },
        },
      },
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    assert.equal(edit.data.pos.rev, 2);
    assert.deepEqual(edit.data.pos.build.nextPublic, {
      NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "demo-cloud",
    });
    const stale = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, config: POS_CONFIG("late") },
    });
    assert.equal(stale.status, 409);
    assert.equal((await installationDoc(iid)).pos.slug, "renamed");
    const get = await call(`/installations/${iid}/pos`, { session: admin });
    assert.equal(get.data.pos.rev, 2);
    assertNoSecrets(get.data, PLAINTEXTS);
  });

  it("validates configuration and secrets without echoing values", async () => {
    const { iid } = await pos();
    const bad = (config) =>
      call(`/installations/${iid}/pos`, {
        method: "PUT",
        session: admin,
        body: { rev: 1, config },
      });
    for (const config of [
      { ...POS_CONFIG("ok-slug"), slug: "Bad Slug" },
      { ...POS_CONFIG("ok-slug"), subdomain: "admin" },
      { ...POS_CONFIG("ok-slug"), host: "UPPER.example.com" },
      { ...POS_CONFIG("ok-slug"), tenantId: "<tenant-id>" },
      { ...POS_CONFIG("ok-slug"), posAdmin: { username: "A" } },
      // Finding 1: the lock is no longer part of the config form.
      { ...POS_CONFIG("ok-slug"), deployLock: false },
      { ...POS_CONFIG("ok-slug"), deployLock: true },
      {
        ...POS_CONFIG("ok-slug"),
        vercel: { ...POS_CONFIG("x").vercel, token: "nope" },
      },
      {
        ...POS_CONFIG("ok-slug"),
        image: {
          store: "r2",
          publicBaseUrl: "",
          cloudName: "",
          r2AccountId: "",
          bucket: "",
        },
      },
    ])
      assert.equal((await bad(config)).status, 400);
    const secret = (field, value) =>
      call(`/installations/${iid}/pos/secret`, {
        method: "PUT",
        session: admin,
        body: { rev: 1, field, value },
      });
    for (const [field, value] of [
      ["mongo.uri", "mongodb://host-only-no-db-9988"],
      ["mongo.uri", "mongodb+srv://u:p@<cluster>.mongodb.net/db"],
      ["posAdmin.password", "weakpassword"],
      ["image.keys", "{not json 7766"],
      ["image.keys", JSON.stringify({ accessKeyId: "a" })],
      ["generated.authSecret", "short"],
      ["vercel.token", ""],
      ["nope", "value-nope-5544"],
    ]) {
      const res = await secret(field, value);
      assert.equal(res.status, 400, field);
      assert.equal(JSON.stringify(res.data).includes(value || "\u0000"), false);
    }
    // Image keys must match the image store (config uses r2).
    const cloudinary = await secret(
      "image.keys",
      JSON.stringify({ apiKey: "k", apiSecret: "s" }),
    );
    assert.equal(cloudinary.status, 400);
    assert.equal((await installationDoc(iid)).pos.vercel.token, null);
  });

  it("stores write-only secrets in AAD-bound boxes; reveal is step-up gated and audited", async () => {
    const { iid } = await pos();
    const rev = await putSecrets(iid, 1);
    const doc = (await installationDoc(iid)).pos;
    for (const field of POS_SECRET_FIELDS) {
      const box = field.split(".").reduce((v, k) => v[k], doc);
      assert.equal(
        decrypt(box, VAULT_KEY, `pos:${iid}:${field}`),
        POS_VALUES[field],
      );
      assert.ok(doc.secretsChangedAt[field.replace(".", "_")]);
    }
    assert.equal(JSON.stringify(doc).includes("plain"), false);
    const get = await call(`/installations/${iid}/pos`, { session: admin });
    assert.equal(
      Object.values(get.data.pos.secrets).every((s) => s.set && s.changedAt),
      true,
    );
    assertNoSecrets(get.data, PLAINTEXTS);
    await stepUp(owner);
    for (const field of POS_SECRET_FIELDS) {
      const res = await call(`/installations/${iid}/pos/reveal`, {
        method: "POST",
        session: owner,
        body: { field },
      });
      assert.deepEqual(res.data, { value: POS_VALUES[field] }, field);
    }
    const events = await audits({
      action: "pos.secret-revealed",
      resourceId: iid,
    });
    assert.equal(events.length, POS_SECRET_FIELDS.length);
    assert.equal(
      events.every((e) => !PLAINTEXTS.some((p) => e.detail.includes(p))),
      true,
    );
    // Removal needs step-up and rev; unset fields cannot be revealed.
    const removed = await call(`/installations/${iid}/pos/secret`, {
      method: "DELETE",
      session: owner,
      body: { rev, field: "vercel.token" },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.pos.secrets["vercel.token"].set, false);
    assert.equal(
      (
        await call(`/installations/${iid}/pos/reveal`, {
          method: "POST",
          session: owner,
          body: { field: "vercel.token" },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(`/installations/${iid}/pos/secret`, {
          method: "DELETE",
          session: owner,
          body: { rev, field: "mongo.uri" },
        })
      ).status,
      409,
    );
    // Reveal shares the 30/hour limit.
    await clearOfWindow(3600000);
    await ctx.db.collection("rate_limits").deleteMany({});
    for (let i = 0; i < 30; i++)
      await call(`/installations/${iid}/pos/reveal`, {
        method: "POST",
        session: owner,
        body: { field: "mongo.uri" },
      });
    assert.equal(
      (
        await call(`/installations/${iid}/pos/reveal`, {
          method: "POST",
          session: owner,
          body: { field: "mongo.uri" },
        })
      ).status,
      429,
    );
  });

  it("a config save never touches the secret boxes", async () => {
    const { iid } = await pos();
    const rev = await putSecrets(iid, 1);
    const boxes = async () => {
      const doc = (await installationDoc(iid)).pos;
      return BSON.serialize(
        Object.fromEntries(
          POS_SECRET_FIELDS.map((f) => [
            f,
            f.split(".").reduce((v, k) => v[k], doc),
          ]),
        ),
      );
    };
    const before = await boxes();
    const edit = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev,
        config: {
          ...POS_CONFIG("changed-slug"),
          host: "other.pos.example.com",
          cloudflare: {
            accountId: "cfacc999",
            workerName: "w2",
            workerUrl: "https://w2.example.workers.dev",
          },
        },
      },
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    assert.ok(before.equals(await boxes()));
    assert.equal(
      (await installationDoc(iid)).pos.host,
      "other.pos.example.com",
    );
    await stepUp(owner);
    const shown = await call(`/installations/${iid}/pos/reveal`, {
      method: "POST",
      session: owner,
      body: { field: "cloudflare.token" },
    });
    assert.equal(shown.data.value, POS_VALUES["cloudflare.token"]);
    // Dropping Cloudflare or switching the image store while their secrets
    // are set is refused instead of orphaning the boxes.
    for (const config of [
      { ...POS_CONFIG("changed-slug"), cloudflare: null },
      {
        ...POS_CONFIG("changed-slug"),
        image: {
          store: "cloudinary",
          publicBaseUrl: "",
          cloudName: "c",
          r2AccountId: "",
          bucket: "",
        },
      },
    ]) {
      const res = await call(`/installations/${iid}/pos`, {
        method: "PUT",
        session: admin,
        body: { rev: edit.data.pos.rev, config },
      });
      assert.equal(res.status, 409);
    }
    assert.ok(before.equals(await boxes()));
  });

  it("keeps pos.slug unique across installations", async () => {
    const first = await pos("unique-slug");
    const cid = await mkCustomer();
    const iid = await mkInstallation(cid);
    const clash = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: POS_CONFIG("unique-slug") },
    });
    assert.equal(clash.status, 409);
    assert.equal((await installationDoc(iid)).pos, undefined);
    assert.ok(first);
    // Two racing creates for the same slug: one wins.
    const [c1, c2] = [await mkCustomer(), await mkCustomer()];
    const [i1, i2] = [await mkInstallation(c1), await mkInstallation(c2)];
    const results = await Promise.all(
      [i1, i2].map((id) =>
        call(`/installations/${id}/pos`, {
          method: "PUT",
          session: admin,
          body: { rev: 0, config: POS_CONFIG("race-slug") },
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  });

  it("removes the whole block only with step-up and the current rev, then allows a fresh start", async () => {
    const { iid, slug } = await pos();
    await stepUp(owner);
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "DELETE",
          session: owner,
          body: { rev: 9 },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "DELETE",
          session: owner,
          body: { rev: 1 },
        })
      ).status,
      200,
    );
    assert.equal((await installationDoc(iid)).pos, undefined);
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "PUT",
          session: admin,
          body: { rev: 0, config: POS_CONFIG(slug) },
        })
      ).status,
      200,
    );
    assert.ok((await audits({ action: "pos.removed" })).length >= 1);
  });

  it("refuses a box moved between fields (AAD swap)", async () => {
    const { iid } = await pos();
    await putSecrets(iid, 1);
    const doc = (await installationDoc(iid)).pos;
    await ctx.db
      .collection("installations")
      .updateOne({ _id: iid }, { $set: { "pos.vercel.token": doc.mongo.uri } });
    await stepUp(owner);
    const res = await call(`/installations/${iid}/pos/reveal`, {
      method: "POST",
      session: owner,
      body: { field: "vercel.token" },
    });
    assert.equal(res.status, 500);
    assertNoSecrets(res.data, PLAINTEXTS);
  });
});

describe("responses never contain secrets", () => {
  it("deep-scans every read/write surface after secrets exist", async () => {
    const cid = await mkCustomer();
    await mkAccount(cid);
    const made = await up(admin, cid, {
      body: Buffer.from("PLAINTEXT-FILE-CONTENT-".repeat(8)),
    });
    const iid = await mkInstallation(cid);
    await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: POS_CONFIG(`scan-${++counter}`) },
    });
    await putSecrets(iid, 1);
    const connectionId = randomUUID();
    await ctx.db.collection("connections").insertOne({
      _id: connectionId,
      name: "conn",
      customerId: cid,
      provider: "vercel",
      ownership: "customer",
      accountId: "",
      resourceId: "",
      expiresAt: "",
      status: "recorded",
      notes: "",
      revision: 1,
      secret: encrypt(
        "conn-secret-plain-zz",
        VAULT_KEY,
        `connection:${connectionId}`,
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await call(`/customers/${cid}/accounts`, { session: admin });
    const secrets = [...PLAINTEXTS, "PLAINTEXT-FILE", "conn-secret-plain-zz"];
    const paths = [
      "/customers",
      `/customers/${cid}`,
      "/installations",
      `/installations/${iid}`,
      "/connections",
      "/products",
      "/tasks",
      "/overview",
      "/audit",
      `/audit?customerId=${cid}`,
      "/options/customers",
      "/options/products",
      "/options/installations",
      "/options/connections",
      "/options/staff",
      "/team",
      "/auth/me",
      `/customers/${cid}/accounts`,
      `/customers/${cid}/files`,
      `/installations/${iid}/pos`,
    ];
    for (const session of [owner, admin, operations, viewer])
      for (const path of paths) {
        const res = await call(path, { session });
        if (res.status !== 200) {
          assert.ok([403].includes(res.status), `${path} ${res.status}`);
          assertNoSecrets(res.data, secrets, path);
          continue;
        }
        assertNoSecrets(res.data, secrets, path);
      }
    assert.ok(made.data.id);
  });
});

describe("audit by customer", () => {
  it("returns the customer's and its installations' events, hiding IPs below team access", async () => {
    const mine = await mkCustomer(),
      other = await mkCustomer();
    const myInstall = await mkInstallation(mine);
    const otherInstall = await mkInstallation(other);
    await mkAccount(mine);
    await mkAccount(other, { label: "theirs" });
    const res = await call(`/audit?customerId=${mine}`, { session: owner });
    assert.equal(res.status, 200);
    const ids = new Set(res.data.rows.map((row) => row.resourceId));
    assert.ok(ids.has(mine));
    assert.ok(ids.has(myInstall));
    assert.equal(ids.has(other), false);
    assert.equal(ids.has(otherInstall), false);
    assert.equal(res.data.total, res.data.rows.length);
    assert.ok(res.data.rows.every((row) => typeof row.ip === "string"));
    const lower = await call(`/audit?customerId=${mine}`, { session: admin });
    assert.ok(lower.data.rows.length > 0);
    assert.ok(
      lower.data.rows.every((row) => !("ip" in row) && !("userAgent" in row)),
    );
    assert.equal(
      (await call("/audit?customerId=not-a-uuid", { session: owner })).status,
      400,
    );
    const unfiltered = await call("/audit", { session: owner });
    assert.ok(unfiltered.data.total > res.data.total);
    // Per-page ordering is newest first.
    const times = res.data.rows.map((row) => new Date(row.createdAt).getTime());
    assert.deepEqual(
      times,
      [...times].sort((a, b) => b - a),
    );
  });
});

describe("snapshot covers every new box type", () => {
  it("round-trips accounts, file keys, POS secrets, TOTP and connections; wrong vault key fails", async () => {
    const cid = await mkCustomer();
    await mkAccount(cid);
    await up(admin, cid, { body: Buffer.from("snapshot".repeat(20)) });
    const iid = await mkInstallation(cid);
    await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: POS_CONFIG(`snap-${++counter}`) },
    });
    await putSecrets(iid, 1);
    const staff = await ctx.db
      .collection("staff")
      .findOne({ email: "viewer@example.test" });
    await ctx.db.collection("staff").updateOne(
      { _id: staff._id },
      {
        $set: {
          totp: {
            key: encrypt(
              base32Encode(randomBytes(20)),
              VAULT_KEY,
              `staff:${staff._id}:totp`,
            ),
            enabledAt: new Date(),
            lastStep: 0,
          },
        },
      },
    );
    // Earlier tests corrupt boxes on purpose; drop those rows first.
    for (const name of ["customers", "installations"])
      for (const row of await ctx.db.collection(name).find({}).toArray())
        try {
          verifySecretBoxes(name, row, VAULT_KEY);
        } catch {
          await ctx.db.collection(name).deleteOne({ _id: row._id });
        }
    const text = await makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY);
    const snapshot = parseSnapshot(text, VAULT_KEY, BACKUP_KEY);
    const row = snapshot.collections.customers.find((r) => r._id === cid);
    assert.equal(row.accounts.length, 1);
    assert.equal(row.files.length, 1);
    assert.ok(
      snapshot.collections.installations.find((r) => r._id === iid).pos.mongo
        .uri,
    );
    assert.throws(() => parseSnapshot(text, "d".repeat(64), BACKUP_KEY));
    assert.throws(() => parseSnapshot(text, VAULT_KEY, "e".repeat(64)));
    // Every location is actually checked: tampering with any box type fails.
    const customer = await customerDoc(cid),
      installation = await installationDoc(iid);
    const wrong = encrypt("x", VAULT_KEY, "some-other-context");
    const cases = [
      ["customers", customer, "accounts.0.password"],
      ["customers", customer, "accounts.0.totpKey"],
      ["customers", customer, "accounts.0.backupCodes"],
      ["customers", customer, "files.0.dataKey"],
      ...POS_SECRET_FIELDS.map((f) => [
        "installations",
        installation,
        `pos.${f}`,
      ]),
    ];
    for (const [name, doc, path] of cases) {
      const copy = structuredClone(doc);
      const parts = path.split(".");
      const last = parts.pop();
      parts.reduce((v, k) => v[k], copy)[last] = wrong;
      assert.throws(() => verifySecretBoxes(name, copy, VAULT_KEY), path);
      verifySecretBoxes(name, doc, VAULT_KEY);
    }
    // A damaged box in the database makes the backup fail instead of silently
    // producing an unrestorable snapshot.
    await ctx.db
      .collection("installations")
      .updateOne({ _id: iid }, { $set: { "pos.mongo.uri": wrong } });
    await assert.rejects(makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY));
    await ctx.db
      .collection("installations")
      .updateOne(
        { _id: iid },
        { $set: { "pos.mongo.uri": installation.pos.mongo.uri } },
      );
    await makeSnapshot(ctx.db, VAULT_KEY, BACKUP_KEY);
  });
});

// ---- Review fixes -----------------------------------------------------------
function flakyClient() {
  const state = { failNth: 0, count: 0 };
  const client = new Proxy(ctx.client, {
    get(target, prop) {
      if (prop === "startSession")
        return (...args) => {
          const session = target.startSession(...args);
          const run = session.withTransaction.bind(session);
          // The transaction commits, but the caller is told it failed.
          session.withTransaction = async (callback, options) => {
            const result = await run(callback, options);
            state.count++;
            if (state.count === state.failNth)
              throw new Error("commit result unknown");
            return result;
          };
          return session;
        };
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client, state };
}
const fileKey = async (cid) => (await customerDoc(cid)).files[0].s3Key;
async function deletedFile(cid) {
  const made = (
    await up(admin, cid, { body: Buffer.from("restore-me".repeat(10)) })
  ).data;
  await stepUp(owner);
  assert.equal(
    (
      await call(`/customers/${cid}/files/${made.id}`, {
        method: "DELETE",
        session: owner,
        body: {},
      })
    ).status,
    200,
  );
  return made.id;
}

describe("review fixes: restore claims and unknown commits (M1)", () => {
  it("two parallel restores: one wins, the other 409s without deleting", async () => {
    const cid = await mkCustomer();
    const fid = await deletedFile(cid);
    const key = await fileKey(cid);
    fake.reset();
    const path = `/customers/${cid}/files/${fid}/restore`;
    const results = await Promise.all(
      [1, 2].map(() =>
        call(path, { method: "POST", session: admin, body: {} }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).data.code, "stale");
    assert.equal(fake.calls.filter((x) => x.op === "copy").length, 1);
    assert.equal(fake.calls.filter((x) => x.op === "delete").length, 0);
    const entry = (await customerDoc(cid)).files[0];
    const newest = fake.versions(key).at(-1);
    assert.equal(newest.marker, false);
    assert.equal(
      entry.versionId,
      newest.id,
      "record points at the current version",
    );
    assert.equal(entry.deletedAt, null);
    assert.equal(entry.restoring ?? null, null);
    assert.ok((await download(owner, cid, fid)).status === 200);
  });

  it("a live claim blocks a restore; an expired claim (crashed restore) can be retried", async () => {
    const cid = await mkCustomer();
    const fid = await deletedFile(cid);
    const path = `/customers/${cid}/files/${fid}/restore`;
    const claim = (until) =>
      ctx.db
        .collection("customers")
        .updateOne(
          { _id: cid },
          { $set: { "files.0.restoring": { token: "other", until } } },
        );
    await claim(new Date(Date.now() + 60000));
    fake.reset();
    assert.equal(
      (await call(path, { method: "POST", session: admin, body: {} })).status,
      409,
    );
    assert.equal(fake.calls.length, 0);
    await claim(new Date(Date.now() - 1000));
    assert.equal(
      (await call(path, { method: "POST", session: admin, body: {} })).status,
      200,
    );
    assert.equal((await customerDoc(cid)).files[0].restoring ?? null, null);
  });

  it("a restore whose copy fails releases the claim", async () => {
    const cid = await mkCustomer();
    const fid = await deletedFile(cid);
    const path = `/customers/${cid}/files/${fid}/restore`;
    fake.fail("copy", { status: 500 });
    assert.equal(
      (await call(path, { method: "POST", session: admin, body: {} })).status,
      503,
    );
    assert.equal((await customerDoc(cid)).files[0].restoring ?? null, null);
    assert.equal(
      (await call(path, { method: "POST", session: admin, body: {} })).status,
      200,
    );
  });

  it("an unknown commit result on restore does not delete the live version", async () => {
    const cid = await mkCustomer();
    const fid = await deletedFile(cid);
    const key = await fileKey(cid);
    const { client, state } = flakyClient();
    const at = await serve({ s3: fake.client(), client });
    fake.reset();
    state.failNth = 2; // claim = 1, commit = 2
    const res = await call(`/customers/${cid}/files/${fid}/restore`, {
      method: "POST",
      session: admin,
      body: {},
      at,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(fake.calls.filter((x) => x.op === "delete").length, 0);
    const entry = (await customerDoc(cid)).files[0];
    assert.equal(entry.deletedAt, null);
    assert.equal(entry.versionId, fake.versions(key).at(-1).id);
  });

  it("an unknown commit result on upload keeps the object the record points at", async () => {
    const cid = await mkCustomer();
    const { client, state } = flakyClient();
    const at = await serve({ s3: fake.client(), client });
    state.failNth = 1;
    const res = await up(admin, cid, {
      body: Buffer.from("unknown-commit".repeat(5)),
      at,
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(fake.calls.filter((x) => x.op === "delete").length, 0);
    const entry = (await customerDoc(cid)).files[0];
    assert.equal(entry.versionId, fake.versions(entry.s3Key).at(-1).id);
    assert.equal(fake.liveKeys().length, 1);
  });
});

describe("review fixes: transfers and delete order (L1, L2)", () => {
  it("holds the slot until the handler finishes, even if the client leaves", async () => {
    const cid = await mkCustomer();
    // The S3 call is held open by a gate the test controls, so "the handler is
    // still running" is a fact, not a race against a timer.
    let entered = 0,
      open;
    const gate = new Promise((resolve) => (open = resolve));
    fake.hooks.beforePut = async () => {
      entered++;
      await gate;
    };
    const slow = [1, 2].map(() => {
      const t = upload(admin, cid, {
        body: Buffer.from("slow-body".repeat(10)),
        send: false,
      });
      t.req.end(Buffer.from("slow-body".repeat(10)));
      return t;
    });
    try {
      await until(() => entered >= 2, { what: "both uploads to reach S3" });
      for (const t of slow) t.req.destroy();
      const third = await up(admin, cid, { body: Buffer.from("third") });
      assert.equal(third.status, 503, "slots are still held");
    } finally {
      // Never leave the gate shut: later tests share this fake.
      fake.hooks.beforePut = null;
      open();
      for (const t of slow) t.req.destroy();
    }
    await until(async () => (await slotsFull()).status !== 503, PROBE);
    assert.equal(
      (await up(admin, cid, { body: Buffer.from("after") })).status,
      201,
    );
  });

  it("deletes the record first; an S3 delete failure keeps the data restorable", async () => {
    const cid = await mkCustomer();
    const plain = Buffer.from("delete-order".repeat(10));
    const made = (await up(admin, cid, { body: plain })).data;
    await stepUp(owner);
    fake.fail("delete", { status: 500 });
    const res = await call(`/customers/${cid}/files/${made.id}`, {
      method: "DELETE",
      session: owner,
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.storageDeleted, false);
    const entry = (await customerDoc(cid)).files[0];
    assert.ok(entry.deletedAt, "the record says deleted");
    assert.equal(fake.liveKeys().length, 1, "the object is still current");
    assert.equal((await download(owner, cid, made.id)).status, 409);
    const back = await call(`/customers/${cid}/files/${made.id}/restore`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.equal(back.status, 200);
    assert.ok((await download(owner, cid, made.id)).bytes.equals(plain));
    const ok = await call(`/customers/${cid}/files/${made.id}`, {
      method: "DELETE",
      session: owner,
      body: {},
    });
    assert.equal(ok.data.storageDeleted, true);
    assert.deepEqual(fake.liveKeys(), []);
  });
});

describe("review fixes: input and integrity hardening (L3-L7)", () => {
  it("rejects prototype-named authenticator algorithms (L3)", async () => {
    const cid = await mkCustomer();
    const acc = await mkAccount(cid);
    for (const algorithm of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const value = `otpauth://totp/x?secret=${KEY}&algorithm=${algorithm}`;
      const created = await call(`/customers/${cid}/accounts`, {
        method: "POST",
        session: admin,
        body: { service: "gmail", label: "x", totpKey: value },
      });
      assert.equal(created.status, 400, algorithm);
      assert.match(created.data.error, /authenticator/i);
      const replaced = await call(
        `/customers/${cid}/accounts/${acc.id}/secret`,
        {
          method: "PUT",
          session: admin,
          body: { rev: 1, field: "totpKey", value },
        },
      );
      assert.equal(replaced.status, 400, algorithm);
    }
    assert.equal((await customerDoc(cid)).accounts.length, 1);
  });

  it("cleans audit detail of control and bidi characters (L4)", async () => {
    const cid = await mkCustomer();
    await mkAccount(cid, { label: "Ev‮il\u0007 na‏me" });
    const event = (
      await audits({ action: "account.created", resourceId: cid })
    ).at(-1);
    assert.equal(event.detail, "gmail: Evilname");
    for (const ch of event.detail) {
      const n = ch.codePointAt(0);
      assert.ok(
        n > 0x1f &&
          !(n >= 0x7f && n <= 0x9f) &&
          ![0x2028, 0x2029, 0x200e, 0x200f].includes(n) &&
          !(n >= 0x202a && n <= 0x202e) &&
          !(n >= 0x2066 && n <= 0x2069),
        `unsafe character ${n.toString(16)}`,
      );
    }
    const { audit } = await import("../backend/lib/audit.js");
    await audit(
      ctx.db,
      undefined,
      null,
      "test.long",
      "x",
      "y",
      `${"a\u0000".repeat(500)}`,
    );
    const long = (await audits({ action: "test.long" })).at(-1);
    assert.equal(long.detail.length, 200);
  });

  it("reports an over-long tampered object as an integrity failure (L5)", async () => {
    const cid = await mkCustomer();
    const plain = Buffer.from("too-long-check".repeat(8));
    const made = (await up(admin, cid, { body: plain })).data;
    const key = await fileKey(cid);
    const before = (await audits({ action: "file.integrity-failed" })).length;
    fake.replace(key, Buffer.alloc(plain.length + 32 + 5000, 7));
    await stepUp(owner);
    const res = await download(owner, cid, made.id);
    assert.equal(res.status, 422);
    assert.match(JSON.parse(res.bytes.toString()).error, /integrity/);
    assert.equal(
      (await audits({ action: "file.integrity-failed" })).length,
      before + 1,
    );
  });

  it("strips invisible format characters from file names (L6)", () => {
    assert.equal(cleanFileName("a​b­⁠c\u{E0041}d.pdf").name, "abcd.pdf");
    assert.equal(cleanFileName("x.p​df").name, "x.pdf");
    for (const bad of ["​.pdf", "­⁠.pdf", "\u{E0041}​.txt", "​​pdf"])
      assert.throws(
        () => cleanFileName(bad),
        (e) => e.status === 400,
        JSON.stringify(bad),
      );
  });

  it("requires a 16-byte GCM tag when opening a box (L7)", () => {
    const box = encrypt("hello", VAULT_KEY, "ctx");
    assert.equal(decrypt(box, VAULT_KEY, "ctx"), "hello");
    const tag = Buffer.from(box.tag, "base64");
    for (const size of [4, 8, 12, 15])
      assert.throws(
        () =>
          decrypt(
            { ...box, tag: tag.subarray(0, size).toString("base64") },
            VAULT_KEY,
            "ctx",
          ),
        undefined,
        `${size}-byte tag`,
      );
    assert.throws(() =>
      decrypt(
        { ...box, tag: Buffer.concat([tag, tag]).toString("base64") },
        VAULT_KEY,
        "ctx",
      ),
    );
  });
});

describe("review fixes: auth runs once per request (L8)", () => {
  it("looks up the session and staff member once and still rejects everywhere", async () => {
    const counts = { sessions: 0, staff: 0 };
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === "collection")
          return (name) => {
            const col = target.collection(name);
            if (name === "sessions" || name === "staff") {
              const find = col.findOne.bind(col);
              col.findOne = (...args) => {
                counts[name]++;
                return find(...args);
              };
            }
            return col;
          };
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const at = await serve({ s3: fake.client(), db });
    const cid = await mkCustomer();
    const iid = await mkInstallation(cid);
    for (const path of [
      "/customers",
      `/customers/${cid}`,
      `/customers/${cid}/accounts`,
      `/customers/${cid}/files`,
      `/installations/${iid}/pos`,
      "/overview",
      "/team",
      "/audit",
    ]) {
      counts.sessions = counts.staff = 0;
      const res = await call(path, { session: owner, at });
      assert.equal(res.status, 200, path);
      assert.deepEqual(counts, { sessions: 1, staff: 1 }, path);
      const anon = await call(path, { at });
      assert.equal(anon.status, 401, path);
      const forged = await call(path, {
        at,
        headers: { Cookie: "sandbee_admin=forged" },
      });
      assert.equal(forged.status, 401, path);
    }
    // Mutations still need the CSRF token, checked once by the first guard.
    for (const [method, path, body] of [
      ["POST", `/customers/${cid}/accounts`, { service: "gmail", label: "x" }],
      [
        "PUT",
        `/installations/${iid}/pos`,
        { rev: 0, config: { slug: "csrf-check" } },
      ],
      ["POST", `/customers/${cid}/files/${randomUUID()}/restore`, {}],
      ["POST", "/customers", {}],
    ]) {
      const res = await call(path, {
        method,
        body,
        at,
        headers: { Cookie: owner.cookie },
      });
      assert.equal(res.status, 403, path);
    }
  });
});

describe("review fixes: POS config defaults (L9)", () => {
  it("lets vercel, image, posAdmin and the optional strings be omitted", async () => {
    const cid = await mkCustomer();
    const iid = await mkInstallation(cid);
    const res = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: { slug: `minimal-${++counter}` } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const pos = res.data.pos;
    assert.deepEqual(pos.vercel, {
      projectId: "",
      orgId: "",
      teamId: "",
      projectName: "",
    });
    assert.equal(pos.image.store, null);
    assert.equal(pos.posAdmin.username, "");
    assert.equal(pos.cloudflare, null);
    assert.equal(pos.deployLock, true);
    assert.equal(pos.host, "");
    const partial = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 1,
        config: {
          slug: pos.slug,
          vercel: { projectId: "prj_1" },
          image: { store: "r2", publicBaseUrl: "https://i.example.com" },
        },
      },
    });
    assert.equal(partial.status, 200, JSON.stringify(partial.data));
    assert.equal(partial.data.pos.vercel.projectId, "prj_1");
    assert.equal(partial.data.pos.vercel.orgId, "");
    // Real validation still applies.
    const bad = await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: {
        rev: 2,
        config: { slug: pos.slug, vercel: { projectId: "bad id!" } },
      },
    });
    assert.equal(bad.status, 400);
  });
});

describe("review fixes: machine-readable stale code (item 10)", () => {
  it("marks every stale-revision 409 with code 'stale' and nothing else", async () => {
    const cid = await mkCustomer();
    const detail = (await call(`/customers/${cid}`, { session: admin })).data;
    const { _id, createdAt, updatedAt, revision, ...body } = detail;
    assert.ok(_id && createdAt && updatedAt);
    const stale = await call(`/customers/${cid}`, {
      method: "PUT",
      session: admin,
      body: { ...body, revision: revision + 5 },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");
    assert.match(stale.data.error, /changed/);
    assert.ok(stale.data.requestId);
    const acc = await mkAccount(cid);
    const staleAccount = await call(`/customers/${cid}/accounts/${acc.id}`, {
      method: "PUT",
      session: admin,
      body: { service: "gmail", label: "x", rev: 9 },
    });
    assert.equal(staleAccount.data.code, "stale");
    const iid = await mkInstallation(cid);
    await call(`/installations/${iid}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 0, config: { slug: `stale-${++counter}` } },
    });
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "PUT",
          session: admin,
          body: { rev: 4, config: { slug: "stale-a" } },
        })
      ).data.code,
      "stale",
    );
    assert.equal(
      (
        await call(`/installations/${iid}/pos/secret`, {
          method: "PUT",
          session: admin,
          body: { rev: 7, field: "mongo.uri", value: POS_VALUES["mongo.uri"] },
        })
      ).data.code,
      "stale",
    );
    assert.equal(
      (
        await call(`/installations/${iid}/pos`, {
          method: "PUT",
          session: admin,
          body: { rev: 0, config: { slug: "again-x" } },
        })
      ).data.code,
      "stale",
    );
    // A claimed file restore is a stale conflict as well.
    const fid = await deletedFile(cid);
    await ctx.db.collection("customers").updateOne(
      { _id: cid },
      {
        $set: {
          "files.0.restoring": {
            token: "t",
            until: new Date(Date.now() + 60000),
          },
        },
      },
    );
    assert.equal(
      (
        await call(`/customers/${cid}/files/${fid}/restore`, {
          method: "POST",
          session: admin,
          body: {},
        })
      ).data.code,
      "stale",
    );
    // Other 409s and other errors keep the plain envelope.
    const notDeleted = (
      await up(admin, cid, { body: Buffer.from("plain-409") })
    ).data;
    const plain = await call(
      `/customers/${cid}/files/${notDeleted.id}/restore`,
      { method: "POST", session: admin, body: {} },
    );
    assert.equal(plain.status, 409);
    assert.deepEqual(Object.keys(plain.data).sort(), ["error", "requestId"]);
    const invalid = await call(`/customers/${cid}/accounts`, {
      method: "POST",
      session: admin,
      body: {},
    });
    assert.deepEqual(Object.keys(invalid.data).sort(), ["error", "requestId"]);
    const bare = await serve({ s3: undefined });
    const off = await up(admin, cid, { body: Buffer.from("x"), at: bare });
    assert.equal(off.data.code, "not-configured");
  });
});
