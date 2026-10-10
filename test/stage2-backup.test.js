// Stage 2 W4: owner-triggered client database backup. A second database on the
// in-memory replica set plays the CLIENT's MongoDB; S3 is the in-memory fake.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { digest, encrypt } from "../backend/lib/crypto.js";
import { openClientDb } from "../backend/lib/client-mongo.js";
import { buildContext } from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import { RestoreError, restoreBackup } from "../scripts/pos-db-restore.js";
import { createFakeS3 } from "./fake-s3.js";
import { VAULT_KEY, assertNoSecrets, startApp } from "./helpers.js";

const MARKER = "CLIENT-ROW-MARKER-7c1d9f3a";
const PASS = "ClientPass9z";
let app,
  fakeS3,
  clientDb,
  clientConn,
  tmp,
  owner,
  admin,
  operations,
  viewer,
  product;

const stepUp = (session, on = true) =>
  app.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      on
        ? { $set: { stepUpUntil: new Date(Date.now() + 600000) } }
        : { $unset: { stepUpUntil: "" } },
    );
const uriFor = (name) => app.repl.getUri(name);
async function seed({
  db = "clientdb",
  slug = `demo-${randomUUID().slice(0, 8)}`,
} = {}) {
  const id = randomUUID(),
    customerId = randomUUID();
  await app.db.collection("customers").insertOne({
    _id: customerId,
    name: slug,
    email: `${slug}@example.test`,
    status: "active",
    updatedAt: new Date(),
  });
  await app.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: product._id,
    environment: "production",
    status: "active",
    updatedAt: new Date(),
    pos: {
      rev: 1,
      slug,
      mongo: { uri: encrypt(uriFor(db), VAULT_KEY, `pos:${id}:mongo.uri`) },
      deploy: { current: null, last: null, previous: null, cutoverAt: null },
    },
  });
  return { id, customerId, slug };
}
// Worker context whose "Atlas only" guard accepts the test replica set.
async function worker(overrides = {}) {
  const ctx = await buildContext({
    c: app.c,
    db: app.db,
    client: app.client,
    s3: overrides.s3 === undefined ? fakeS3.client() : overrides.s3,
    overrides: {
      workDir: tmp,
      cliVersion: "63.1.0",
      sleep: async () => new Promise((resolve) => setImmediate(resolve)),
      log: () => {},
      openClientDb: (uri, options) =>
        openClientDb(uri, { ...options, allowHost: () => true }),
      t: { heartbeatMs: 1e9, pollMs: 1, retentionCheckMs: 1e12 },
      ...overrides.ctx,
    },
  });
  return { ctx, loop: createLoop(ctx) };
}
const enqueueRaw = (id, session = owner) =>
  app.request(`/installations/${id}/pos/db-backup`, {
    method: "POST",
    session,
    body: {},
  });
// The API refuses without a fresh worker heartbeat (like deploys).
const beat = () =>
  app.db
    .collection("system_state")
    .updateOne(
      { _id: "pos-worker" },
      { $set: { at: new Date() } },
      { upsert: true },
    );
const enqueue = async (id, session = owner) => {
  await beat();
  return enqueueRaw(id, session);
};
async function download(session, cid, fid) {
  const res = await fetch(
    `${app.origin}/api/customers/${cid}/files/${fid}/download`,
    {
      method: "POST",
      headers: {
        Origin: app.origin,
        "Content-Type": "application/json",
        Cookie: session.cookie,
        "X-CSRF-Token": session.csrf,
      },
    },
  );
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
const taskOf = async (id) =>
  (await app.db.collection("installations").findOne({ _id: id })).pos.task;
const filesOf = async (cid) =>
  (await app.db.collection("customers").findOne({ _id: cid })).files ?? [];

before(async () => {
  fakeS3 = createFakeS3();
  app = await startApp({
    dbName: "backup_test",
    deps: { s3: fakeS3.client() },
  });
  tmp = await mkdtemp(path.join(tmpdir(), "backup-test-"));
  clientConn = new MongoClient(app.repl.getUri());
  await clientConn.connect();
  clientDb = clientConn.db("clientdb");
  await clientDb.collection("users").insertMany([
    {
      _id: new ObjectId(),
      name: MARKER,
      born: new Date("2020-01-02T03:04:05Z"),
      n: BSON.Long.fromNumber(12345678901),
      d: BSON.Decimal128.fromString("1.50"),
    },
    { _id: new ObjectId(), name: "b", tags: ["x", "y"], nested: { a: 1 } },
    { _id: new ObjectId(), name: "c" },
  ]);
  await clientDb
    .collection("orders")
    .insertMany(
      Array.from({ length: 5 }, (_, i) => ({ _id: i, total: i * 10 })),
    );
  await clientDb.createCollection("empty");
  await clientDb
    .collection("system.profile.fake")
    .insertOne({ a: 1 })
    .catch(() => {});
  owner = await app.login("owner@example.test");
  admin = await app.login("admin@example.test");
  operations = await app.login("operations@example.test");
  viewer = await app.login("viewer@example.test");
  await app.db
    .collection("staff")
    .updateOne(
      { email: "owner@example.test" },
      { $set: { "totp.enabledAt": new Date() } },
    );
  product = await app.db.collection("products").findOne({ slug: "pos" });
  await stepUp(owner);
});
after(async () => {
  await clientConn?.close();
  await app?.stop();
  await rm(tmp, { recursive: true, force: true });
});

describe("client database backup", () => {
  it("backs up every collection, seals it like a client file, and the owner can download and restore it", async () => {
    const { id, customerId, slug } = await seed();
    const queued = await enqueue(id);
    assert.equal(queued.status, 201);
    assert.equal(queued.data.task.status, "queued");
    const w = await worker();
    await w.loop.drain();
    const task = await taskOf(id);
    assert.equal(task.status, "succeeded");
    assert.equal(
      task.result.collections,
      3,
      "users, orders and the empty one; system.* is excluded",
    );
    assert.equal(task.result.documents, 8);
    const files = await filesOf(customerId);
    assert.equal(files.length, 1);
    const file = files[0];
    assert.equal(file.category, "db-backup");
    assert.match(
      file.name,
      new RegExp(`^${slug}-db-\\d{8}-\\d{4}\\.jsonl\\.gz$`),
    );
    assert.equal(file.size, task.result.bytes);
    // Never plaintext in S3.
    const keys = fakeS3
      .liveKeys()
      .filter((k) => k.startsWith(`files/${customerId}/`));
    assert.equal(keys.length, 1);
    const stored = fakeS3.versions(keys[0])[0].body;
    assert.equal(stored.subarray(0, 4).toString(), "SBF1");
    assert.equal(stored.includes(Buffer.from(MARKER)), false);
    assert.equal(zlibLooksPlain(stored), false);
    // Value-free audit, task and responses.
    const audits = await app.db
      .collection("audit_events")
      .find({ resourceId: id })
      .toArray();
    assert.ok(audits.some((a) => a.action === "pos.db-backup.created"));
    assertNoSecrets(
      [audits, task],
      [MARKER, PASS, uriFor("clientdb")],
      "backup rows",
    );
    // Download (owner + step-up) decrypts to the gzip of the EJSON lines.
    const dl = await download(owner, customerId, file.id);
    assert.equal(dl.status, 200);
    const text = zlib.gunzipSync(dl.bytes).toString("utf8").trim().split("\n");
    const header = BSON.EJSON.parse(text[0]);
    assert.equal(header.type, "header");
    assert.deepEqual(header.collections, ["empty", "orders", "users"]);
    const trailer = BSON.EJSON.parse(text.at(-1));
    assert.deepEqual(trailer.counts, { empty: 0, orders: 5, users: 3 });
    // Restore into a scratch database and compare.
    const gz = path.join(tmp, "backup.jsonl.gz");
    await writeFile(gz, dl.bytes);
    const result = await restoreBackup({
      uri: app.repl.getUri(),
      db: "scratch_one",
      file: gz,
    });
    assert.deepEqual(result, { collections: 3, documents: 8 });
    const scratch = clientConn.db("scratch_one");
    const original = await clientDb
      .collection("users")
      .find()
      .sort({ name: 1 })
      .toArray();
    const restored = await scratch
      .collection("users")
      .find()
      .sort({ name: 1 })
      .toArray();
    assert.equal(restored.length, 3);
    assert.equal(restored[0]._id.toString(), original[0]._id.toString());
    assert.ok(restored.find((u) => u.name === MARKER).born instanceof Date);
    assert.equal(restored.find((u) => u.name === MARKER).d.toString(), "1.50");
    assert.deepEqual(
      (await scratch.collection("empty").find().toArray()).length,
      0,
    );
    assert.ok(
      (await scratch.listCollections({ name: "empty" }).toArray()).length === 1,
      "empty collections are recreated",
    );
    // A non-empty target is refused unless --force; an Atlas host is refused; a damaged file is refused.
    await assert.rejects(
      () =>
        restoreBackup({ uri: app.repl.getUri(), db: "scratch_one", file: gz }),
      RestoreError,
    );
    await clientConn
      .db("scratch_force")
      .collection("other")
      .insertOne({ a: 1 });
    await assert.rejects(
      () =>
        restoreBackup({
          uri: app.repl.getUri(),
          db: "scratch_force",
          file: gz,
        }),
      RestoreError,
    );
    assert.deepEqual(
      await restoreBackup({
        uri: app.repl.getUri(),
        db: "scratch_force",
        file: gz,
        force: true,
      }),
      { collections: 3, documents: 8 },
    );
    await assert.rejects(
      () =>
        restoreBackup({
          uri: "mongodb+srv://u:p@c.abc.mongodb.net/x",
          db: "s",
          file: gz,
        }),
      /Atlas/,
    );
    const cut = path.join(tmp, "cut.jsonl.gz");
    await writeFile(cut, dl.bytes.subarray(0, dl.bytes.length - 20));
    await assert.rejects(() =>
      restoreBackup({ uri: app.repl.getUri(), db: "scratch_cut", file: cut }),
    );
  });

  it("aborts cleanly above 20 MB compressed: nothing stored, backup-too-large", async () => {
    await clientConn
      .db("bigdb")
      .collection("blobs")
      .insertMany(
        Array.from({ length: 23 }, (_, i) => ({
          _id: i,
          data: new BSON.Binary(randomBytes(1024 * 1024)),
        })),
      );
    const { id, customerId } = await seed({ db: "bigdb" });
    assert.equal((await enqueue(id)).status, 201);
    const before = fakeS3.liveKeys().length;
    const w = await worker();
    await w.loop.drain();
    const task = await taskOf(id);
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "backup-too-large");
    assert.match(task.error.message, /mongodump/);
    assert.equal((await filesOf(customerId)).length, 0);
    assert.equal(fakeS3.liveKeys().length, before, "no S3 object");
  });

  it("refuses a database URI that is not Atlas, with a fixed code", async () => {
    const { id } = await seed();
    await enqueue(id);
    const w = await worker({ ctx: { openClientDb: undefined } });
    await w.loop.drain();
    assert.equal((await taskOf(id)).error.code, "not-atlas");
  });

  it("a worker restart mid-backup ends it as failed (not resumable)", async () => {
    const { id } = await seed();
    await app.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.task": {
            id: randomUUID(),
            kind: "db-backup",
            status: "running",
            step: "read",
            progress: null,
            lease: {
              owner: "gone",
              until: new Date(Date.now() - 1000),
              fence: 1,
            },
            attempt: 1,
            by: { id: "x", name: "Owner" },
            requestedAt: new Date(),
            finishedAt: null,
            params: null,
            result: null,
            error: null,
          },
        },
      },
    );
    const w = await worker();
    await w.loop.drain();
    assert.equal((await taskOf(id)).error.code, "backup-failed");
  });

  it("without S3 the worker refuses and nothing is stored", async () => {
    const { id } = await seed();
    await enqueue(id);
    const w = await worker({ s3: null });
    await w.loop.drain();
    assert.equal((await taskOf(id)).error.code, "backup-no-storage");
  });
});

// A gzip stream starts 1f 8b; sealed data must not expose it after the SBF1 header.
const zlibLooksPlain = (buffer) =>
  buffer.subarray(4 + 12, 4 + 12 + 2).equals(Buffer.from([0x1f, 0x8b]));

describe("backup API", () => {
  it("gates on the owner's deploy permission and step-up", async () => {
    const { id } = await seed();
    assert.equal(
      (
        await app.request(`/installations/${id}/pos/db-backup`, {
          method: "POST",
          body: {},
        })
      ).status,
      401,
    );
    for (const [who, status] of [
      [admin, 403],
      [operations, 403],
      [viewer, 403],
    ])
      assert.equal((await enqueue(id, who)).status, status);
    await stepUp(owner, false);
    assert.equal((await enqueue(id)).status, 428);
    await stepUp(owner);
    assert.equal((await enqueue(id)).status, 201);
    const again = await enqueue(id);
    assert.equal(again.status, 409, "one active backup per installation");
    assert.equal(again.data.code, "busy");
    const status = await app.request(`/installations/${id}/pos/db-backup`, {
      session: admin,
    });
    assert.equal(status.status, 200);
    assert.equal(status.data.task.status, "queued");
    assert.equal(status.data.configured, true);
    assertNoSecrets(status.data, [PASS, uriFor("clientdb")], "status");
    assert.equal(
      (
        await app.request(`/installations/${id}/pos/db-backup`, {
          session: viewer,
        })
      ).status,
      403,
    );
  });

  it("rate limits to six per hour per installation", async () => {
    const { id } = await seed();
    for (let i = 0; i < 6; i++) {
      await app.db
        .collection("installations")
        .updateOne({ _id: id }, { $set: { "pos.task": null } });
      assert.equal((await enqueue(id)).status, 201, `request ${i + 1}`);
    }
    await app.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.task": null } });
    assert.equal((await enqueue(id)).status, 429);
  });

  it("refusals do not use up the six-per-hour allowance (busy, no URI, worker offline)", async () => {
    // Busy: the one real request, then eight refusals, then a free slot.
    const a = await seed();
    assert.equal((await enqueue(a.id)).status, 201);
    for (let i = 0; i < 8; i++)
      assert.equal((await enqueueRaw(a.id)).data.code, "busy");
    await app.db
      .collection("installations")
      .updateOne({ _id: a.id }, { $set: { "pos.task": null } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await enqueue(a.id)).status, 201, `allowance left ${i}`);
      await app.db
        .collection("installations")
        .updateOne({ _id: a.id }, { $set: { "pos.task": null } });
    }
    assert.equal((await enqueue(a.id)).status, 429, "six real requests used");
    // No URI.
    const b = await seed();
    await app.db
      .collection("installations")
      .updateOne({ _id: b.id }, { $set: { "pos.mongo.uri": null } });
    for (let i = 0; i < 8; i++) assert.equal((await enqueue(b.id)).status, 409);
    const box = encrypt(uriFor("clientdb"), VAULT_KEY, `pos:${b.id}:mongo.uri`);
    await app.db
      .collection("installations")
      .updateOne({ _id: b.id }, { $set: { "pos.mongo.uri": box } });
    assert.equal((await enqueue(b.id)).status, 201);
    // Worker offline: 409 not-ready naming the worker item.
    const c = await seed();
    await app.db.collection("system_state").deleteOne({ _id: "pos-worker" });
    for (let i = 0; i < 8; i++) {
      const res = await enqueueRaw(c.id);
      assert.equal(res.status, 409);
      assert.equal(res.data.code, "not-ready");
      assert.deepEqual(res.data.items, ["worker"]);
    }
    await app.db
      .collection("system_state")
      .updateOne(
        { _id: "pos-worker" },
        { $set: { at: new Date(Date.now() - 120000) } },
        { upsert: true },
      );
    assert.equal((await enqueueRaw(c.id)).data.code, "not-ready", "stale beat");
    assert.equal((await enqueue(c.id)).status, 201);
  });

  it("needs a stored database URI, a POS installation and a strict body", async () => {
    const { id } = await seed();
    await app.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.mongo.uri": null } });
    assert.equal((await enqueue(id)).status, 409);
    const ok = await seed();
    assert.equal(
      (
        await app.request(`/installations/${ok.id}/pos/db-backup`, {
          method: "POST",
          session: owner,
          body: { extra: 1 },
        })
      ).status,
      400,
    );
  });

  it("answers 503 not-configured when file storage is off", async () => {
    const off = await startApp({ dbName: "backup_off" });
    try {
      const session = await off.login("owner@example.test");
      await off.db
        .collection("staff")
        .updateOne(
          { email: "owner@example.test" },
          { $set: { "totp.enabledAt": new Date() } },
        );
      await off.db
        .collection("sessions")
        .updateOne(
          { _id: digest(session.cookie.split("=")[1]) },
          { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
        );
      const res = await off.request(
        `/installations/${randomUUID()}/pos/db-backup`,
        { method: "POST", session, body: {} },
      );
      assert.equal(res.status, 503);
      assert.equal(res.data.code, "not-configured");
    } finally {
      await off.stop();
    }
  });
});
