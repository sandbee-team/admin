// D58: "Copy data from the demo". Two databases on the in-memory replica set
// play the old demo POS (source) and the client's new POS (target).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { digest, encrypt } from "../backend/lib/crypto.js";
import { ClientMongoError, openClientDb } from "../backend/lib/client-mongo.js";
import { verifySecretBoxes } from "../backend/lib/secrets.js";
import { buildContext } from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import { settingsPart } from "../backend/worker/data-copy.js";
import { copyParamsSchema } from "../shared/data-copy.js";
import { VAULT_KEY, assertNoSecrets, startApp } from "./helpers.js";

const ALL = [
  "details",
  "settings",
  "printers",
  "menu",
  "staff",
  "customers",
  "orders",
  "tables",
  "expenses",
  "bookings",
];
const FROM = "2026-10-01";
const ATLAS =
  "mongodb+srv://demo-user:DemoPass77x@cluster0.abcd1.mongodb.net/demo";
let app, conn, tmp, owner, admin, operations, viewer, product;

const at = (iso) => new Date(iso);
const ids = {
  srcAdmin: new ObjectId(),
  ravi: new ObjectId(),
  dstAdmin: new ObjectId(),
  kitchen: new ObjectId(),
  bar: new ObjectId(),
  twinKitchen: new ObjectId(),
  drinks: new ObjectId(),
  tea: new ObjectId(),
  coffee: new ObjectId(),
  hall: new ObjectId(),
  oldCustomer: new ObjectId(),
  oldUnused: new ObjectId(),
  newCustomer: new ObjectId(),
  rent: new ObjectId(),
  dstSettings: new ObjectId(),
};
const stepUp = (session, on = true) =>
  app.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      on
        ? { $set: { stepUpUntil: new Date(Date.now() + 600000) } }
        : { $unset: { stepUpUntil: "" } },
    );
const beat = () =>
  app.db
    .collection("system_state")
    .updateOne(
      { _id: "pos-worker" },
      { $set: { at: new Date() } },
      { upsert: true },
    );
const uriFor = (name) => app.repl.getUri(name);
const raw = (db, name, filter = {}) =>
  db.collection(name).find(filter, { promoteValues: false }).toArray();

async function seedSource(db) {
  await db.collection("settings").insertOne({
    _id: new ObjectId(),
    restaurantName: "Blue Cup",
    gstNumber: "27ABCDE1234F1Z5",
    logo: "r2:logo.png",
    billPaperWidth: new BSON.Int32(80),
    kotShowPrices: true,
    billTemplate: { blocks: [{ type: "header" }] },
    telegramBotTokenEnc: "enc-box",
    telegramBotId: 4242,
    createdAt: at("2026-08-01T00:00:00Z"),
    updatedAt: at("2026-10-01T00:00:00Z"),
  });
  await db
    .collection("brandingassets")
    .insertOne({ _id: "logo:1", dataB64: "aGk=" });
  await db.collection("stations").createIndex({ name: 1 }, { unique: true });
  await db.collection("stations").insertMany([
    { _id: ids.kitchen, name: "Kitchen" },
    { _id: ids.bar, name: "Bar" },
  ]);
  await db.collection("printers").insertMany([
    {
      name: "Front",
      connection: { kind: "lan", host: "192.168.1.9", port: 9100 },
      slips: { kotStations: [String(ids.kitchen)] },
      unreachable: true,
      health: { at: at("2026-10-20T00:00:00Z"), ok: false },
    },
    { name: "Counter BT", connection: { kind: "device", deviceId: "dev-1" } },
  ]);
  await db
    .collection("printhosts")
    .insertOne({ key: "primary", deviceId: "dev-1" });
  await db
    .collection("categories")
    .insertOne({ _id: ids.drinks, name: "Drinks", stationId: ids.bar });
  await db.collection("products").createIndex({ name: "text" });
  await db.collection("products").insertMany([
    {
      _id: ids.tea,
      name: "Tea",
      categoryId: ids.drinks,
      price: new BSON.Double(20),
      image: "r2:tea.png",
    },
    {
      _id: ids.coffee,
      name: "Coffee",
      categoryId: ids.drinks,
      price: new BSON.Int32(30),
      image: "",
    },
  ]);
  await db.collection("areas").insertOne({ _id: ids.hall, name: "Hall" });
  await db.collection("tables").createIndex({ tableNo: 1 }, { unique: true });
  await db.collection("tables").insertMany([
    {
      tableNo: "T-1",
      areaId: ids.hall,
      status: "Occupied",
      currentOrderId: "ORD-20261020-001",
    },
    {
      tableNo: "T-2",
      areaId: ids.hall,
      status: "Occupied",
      currentOrderId: "ORD-20260901-001",
    },
    { tableNo: "T-3", areaId: ids.hall, status: "Reserved" },
  ]);
  await db.collection("staffs").createIndex({ username: 1 }, { unique: true });
  await db.collection("staffs").insertMany([
    {
      _id: ids.srcAdmin,
      username: "admin",
      password: "$2a$12$demoAdminHash",
      role: "admin",
    },
    {
      _id: ids.ravi,
      username: "ravi",
      password: "$2a$12$raviHash",
      role: "staff",
    },
  ]);
  await db.collection("customers").createIndex({ mobile: 1 }, { unique: true });
  await db.collection("customers").insertMany([
    {
      _id: ids.oldCustomer,
      mobile: "9000000001",
      totalDue: 100,
      createdAt: at("2026-09-01T10:00:00Z"),
    },
    {
      _id: ids.oldUnused,
      mobile: "9000000002",
      createdAt: at("2026-09-02T10:00:00Z"),
    },
    // 00:30 India time on the From date: inside the window.
    {
      _id: ids.newCustomer,
      mobile: "9000000003",
      createdAt: at("2026-09-30T19:00:00Z"),
    },
  ]);
  await db.collection("duepayments").insertMany([
    {
      customerId: ids.newCustomer,
      amount: 50,
      createdAt: at("2026-10-06T10:00:00Z"),
    },
    {
      customerId: ids.oldUnused,
      amount: 10,
      createdAt: at("2026-09-05T10:00:00Z"),
    },
  ]);
  await db
    .collection("rewardcampaigns")
    .insertOne({ name: "Diwali", customerIds: [ids.newCustomer] });
  await db.collection("orders").createIndex({ orderId: 1 }, { unique: true });
  await db.collection("orders").insertMany([
    {
      orderId: "ORD-20260901-001",
      customerId: ids.oldCustomer,
      status: "Completed",
      total: 10,
      createdAt: at("2026-09-01T10:00:00Z"),
    },
    {
      orderId: "ORD-20261010-001",
      customerId: ids.oldCustomer,
      staffId: ids.srcAdmin,
      items: [
        {
          productId: ids.tea,
          name: "Tea",
          qty: new BSON.Int32(2),
          price: new BSON.Double(20),
        },
      ],
      status: "Completed",
      total: new BSON.Double(40),
      createdAt: at("2026-10-10T10:00:00Z"),
    },
    {
      orderId: "ORD-20261020-001",
      staffId: ids.ravi,
      status: "Pending",
      total: 0,
      createdAt: at("2026-10-20T10:00:00Z"),
    },
    // An old open tab: stays behind (a note says so).
    {
      orderId: "ORD-20260920-001",
      status: "Pending",
      total: 0,
      createdAt: at("2026-09-20T10:00:00Z"),
    },
  ]);
  await db.collection("promoredemptions").insertOne({
    code: "WELCOME",
    mobile: "9000000003",
    createdAt: at("2026-10-11T10:00:00Z"),
  });
  await db.collection("counters").insertMany([
    { _id: "order-20261020", seq: new BSON.Int32(1) },
    { _id: "kot-20261020", seq: new BSON.Int32(3) },
    { _id: "invoice-2627", seq: new BSON.Int32(7) },
  ]);
  await db
    .collection("expensecategories")
    .insertOne({ _id: ids.rent, name: "Rent" });
  await db.collection("expenseentries").insertMany([
    {
      categoryId: ids.rent,
      date: "2026-10-12",
      amountPaise: new BSON.Int32(50000),
      createdById: String(ids.srcAdmin),
      v: 1,
    },
    {
      categoryId: ids.rent,
      date: "2026-09-12",
      amountPaise: new BSON.Int32(1000),
      createdById: String(ids.srcAdmin),
      v: 1,
    },
  ]);
  await db.collection("reservations").insertMany([
    { name: "A", date: "2026-10-25", tableNo: "T-3" },
    { name: "B", date: "2026-09-25" },
  ]);
  await db
    .collection("events")
    .insertOne({ eventName: "Party", date: "2026-11-01" });
  await db.collection("printjobs").insertOne({ orderId: "ORD-20261020-001" });
  await db.collection("dinersessions").insertOne({ _id: "cookie-token" });
  await db
    .collection("dailyRollup")
    .insertOne({ _id: "2026-10-10", total: 40 });
}
// What a freshly deployed POS holds: the go-live admin, its settings and the
// auto-seeded "Kitchen" station (a twin of the demo's, other _id).
async function seedTarget(db) {
  await db.collection("staffs").createIndex({ username: 1 }, { unique: true });
  await db.collection("staffs").insertOne({
    _id: ids.dstAdmin,
    username: "admin",
    password: "$2a$12$clientAdminHash",
    role: "admin",
  });
  await db.collection("settings").insertOne({
    _id: ids.dstSettings,
    restaurantName: "Blue Cup Cafe",
    tokenEnabled: true,
    gstRate: 5,
  });
  await db.collection("stations").createIndex({ name: 1 }, { unique: true });
  await db
    .collection("stations")
    .insertOne({ _id: ids.twinKitchen, name: "Kitchen" });
  await db
    .collection("counters")
    .insertOne({ _id: "order-20261020", seq: new BSON.Int32(5) });
}
async function seed({ source, target, sourceUri, targetUri } = {}) {
  const id = randomUUID(),
    customerId = randomUUID(),
    src = source ?? `src_${id.slice(0, 8)}`,
    dst = target ?? `dst_${id.slice(0, 8)}`;
  await app.db.collection("customers").insertOne({
    _id: customerId,
    name: `copy-${id.slice(0, 6)}`,
    email: `copy-${id.slice(0, 6)}@example.test`,
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
      slug: `copy-${id.slice(0, 6)}`,
      mongo: {
        uri: encrypt(
          targetUri ?? uriFor(dst),
          VAULT_KEY,
          `pos:${id}:mongo.uri`,
        ),
      },
      copy: {
        source: encrypt(
          sourceUri ?? uriFor(src),
          VAULT_KEY,
          `pos:${id}:copy.source`,
        ),
        info: { hosts: ["127.0.0.1"], db: src, savedAt: new Date() },
      },
      deploy: { current: null, last: null, previous: null, cutoverAt: null },
    },
  });
  return { id, src: conn.db(src), dst: conn.db(dst) };
}
async function worker(ctx = {}) {
  const built = await buildContext({
    c: app.c,
    db: app.db,
    client: app.client,
    s3: null,
    overrides: {
      workDir: tmp,
      cliVersion: "63.1.0",
      sleep: async () => new Promise((resolve) => setImmediate(resolve)),
      log: () => {},
      openClientDb: (uri, options) =>
        openClientDb(uri, { ...options, allowHost: () => true }),
      t: { heartbeatMs: 1e9, pollMs: 1, retentionCheckMs: 1e12 },
      ...ctx,
    },
  });
  return createLoop(built);
}
const post = async (
  id,
  mode,
  body = { from: FROM, groups: ALL },
  session = owner,
) => {
  await beat();
  return app.request(
    `/installations/${id}/pos/data-copy${mode === "check" ? "/check" : ""}`,
    {
      method: "POST",
      session,
      body,
    },
  );
};
const taskOf = async (id) =>
  (await app.db.collection("installations").findOne({ _id: id })).pos.task;
async function run(id, mode, body, ctx) {
  const res = await post(id, mode, body);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await (await worker(ctx)).drain();
  return taskOf(id);
}
const snapshot = async (db) => {
  const out = {};
  for (const { name } of await db.listCollections().toArray())
    out[name] = BSON.EJSON.stringify(
      await db.collection(name).find().sort({ _id: 1 }).toArray(),
      { relaxed: false },
    );
  return out;
};

before(async () => {
  app = await startApp({ dbName: "copy_test" });
  tmp = await mkdtemp(path.join(tmpdir(), "copy-test-"));
  conn = new MongoClient(app.repl.getUri());
  await conn.connect();
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
  await conn?.close();
  await app?.stop();
  await rm(tmp, { recursive: true, force: true });
});

describe("copy data from the demo: plan", () => {
  it("splits settings into cafe details and bill & print settings, never Telegram", () => {
    assert.equal(settingsPart("restaurantName"), "details");
    assert.equal(settingsPart("upiId"), "details");
    assert.equal(settingsPart("billPaperWidth"), "settings");
    assert.equal(settingsPart("kotTemplate"), "settings");
    assert.equal(settingsPart("telegramBotTokenEnc"), null);
    assert.equal(settingsPart("telegramWebhookUrl"), null);
    for (const own of ["_id", "createdAt", "updatedAt", "__v"])
      assert.equal(settingsPart(own), null);
  });
  it("accepts only real dates and known kinds", () => {
    assert.equal(
      copyParamsSchema.safeParse({ from: FROM, groups: ALL }).success,
      true,
    );
    for (const bad of [
      { from: "2026-02-30", groups: ["menu"] },
      { from: "2019-12-31", groups: ["menu"] },
      { from: FROM, groups: [] },
      { from: FROM, groups: ["menu", "menu"] },
      { from: FROM, groups: ["telegram"] },
      { from: FROM, groups: ["menu"], extra: 1 },
    ])
      assert.equal(
        copyParamsSchema.safeParse(bad).success,
        false,
        JSON.stringify(bad),
      );
  });
  it("lists the old database's connection string among the vault boxes", () => {
    const id = randomUUID();
    const row = {
      _id: id,
      pos: {
        copy: { source: encrypt(ATLAS, VAULT_KEY, `pos:${id}:copy.source`) },
      },
    };
    verifySecretBoxes("installations", row, VAULT_KEY);
    row.pos.copy.source = encrypt(
      ATLAS,
      VAULT_KEY,
      `pos:${randomUUID()}:copy.source`,
    );
    assert.throws(() => verifySecretBoxes("installations", row, VAULT_KEY));
  });
});

describe("copy data from the demo: worker", () => {
  it("Check counts what would be copied and changes neither database", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    const before = [await snapshot(src), await snapshot(dst)];
    const task = await run(id, "check");
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    const r = task.result;
    assert.equal(r.mode, "check");
    assert.deepEqual(r.groups, {
      details: 4, // restaurantName, gstNumber, logo + 1 branding asset
      settings: 3, // billPaperWidth, kotShowPrices, billTemplate
      printers: 5,
      menu: 3,
      staff: 1, // ravi; admin is kept
      customers: 4, // new + old (in a copied bill) + 1 due payment + 1 campaign
      orders: 3, // 2 bills from the date + 1 promo redemption
      tables: 4,
      expenses: 2,
      bookings: 2,
    });
    assert.equal(r.kept, 1);
    assert.equal(r.blocked, null);
    assert.equal(r.older, 1);
    assert.equal(r.open, 1);
    assert.equal(r.oldOpen, 1);
    assert.deepEqual(r.needs, []);
    assert.deepEqual([...r.notes].sort(), [
      "device-printers",
      "images",
      "old-open-orders",
      "older-customers",
      "open-orders",
      "telegram",
    ]);
    assert.deepEqual(r.others, [{ name: "dailyRollup", count: 1 }]);
    assert.deepEqual([await snapshot(src), await snapshot(dst)], before);
    const view = await app.request(`/installations/${id}/pos/data-copy`, {
      session: owner,
    });
    assert.equal(view.status, 200);
    assert.equal(view.data.task.result.groups.menu, 3);
    const { sourceAt, ...params } = view.data.task.params;
    assert.deepEqual(params, { mode: "check", from: FROM, groups: ALL });
    assert.equal(
      new Date(sourceAt).getTime(),
      new Date(view.data.source.savedAt).getTime(),
      "the run names the saved old database it read",
    );
    assertNoSecrets(
      view.data,
      [uriFor(src.databaseName), "DemoPass77x"],
      "view",
    );
  });

  it("Copy keeps ids, types and links; replaces seeded twins; keeps the new admin; is safe to repeat", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    const sourceBefore = await snapshot(src);
    const task = await run(id, "copy");
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    assert.equal(task.result.mode, "copy");
    assert.ok(task.result.removed >= 1, "the seeded Kitchen twin is replaced");
    assert.deepEqual(
      await snapshot(src),
      sourceBefore,
      "the demo is only read",
    );

    // Settings: merged into the new POS's own document, Telegram never copied.
    const settings = await raw(dst, "settings");
    assert.equal(settings.length, 1);
    assert.equal(String(settings[0]._id), String(ids.dstSettings));
    assert.equal(settings[0].restaurantName, "Blue Cup");
    assert.equal(settings[0].billPaperWidth._bsontype, "Int32");
    assert.deepEqual(settings[0].billTemplate, {
      blocks: [{ type: "header" }],
    });
    assert.equal("telegramBotTokenEnc" in settings[0], false);
    assert.equal("telegramBotId" in settings[0], false);
    assert.equal(
      "tokenEnabled" in settings[0],
      false,
      "a field the demo lacks reads as the default",
    );
    assert.equal("gstRate" in settings[0], false);
    assert.equal(await dst.collection("brandingassets").countDocuments(), 1);

    // Printers: same ids (categories and slips still point at them), no old health.
    const stations = await dst.collection("stations").find().toArray();
    assert.deepEqual(
      stations.map((s) => String(s._id)).sort(),
      [String(ids.kitchen), String(ids.bar)].sort(),
    );
    const front = await dst.collection("printers").findOne({ name: "Front" });
    assert.equal("unreachable" in front, false);
    assert.equal("health" in front, false);
    assert.deepEqual(front.slips.kotStations, [String(ids.kitchen)]);
    assert.equal(await dst.collection("printhosts").countDocuments(), 1);

    // Menu: exact BSON types and references; the text index came along.
    const [tea] = await raw(dst, "products", { _id: ids.tea });
    assert.equal(tea.price._bsontype, "Double");
    assert.equal(String(tea.categoryId), String(ids.drinks));
    const [coffee] = await raw(dst, "products", { _id: ids.coffee });
    assert.equal(coffee.price._bsontype, "Int32");
    const productIndexes = await dst
      .collection("products")
      .listIndexes()
      .toArray();
    assert.ok(productIndexes.some((ix) => ix.key._fts === "text"));

    // Staff: the go-live admin keeps its password; old ids point at it.
    const staff = await dst
      .collection("staffs")
      .find()
      .sort({ username: 1 })
      .toArray();
    assert.deepEqual(
      staff.map((s) => s.username),
      ["admin", "ravi"],
    );
    assert.equal(staff[0].password, "$2a$12$clientAdminHash");
    assert.equal(String(staff[1]._id), String(ids.ravi));

    // Bills from the date, staff remapped, numbering continues.
    const orders = await dst
      .collection("orders")
      .find()
      .sort({ orderId: 1 })
      .toArray();
    assert.deepEqual(
      orders.map((o) => o.orderId),
      ["ORD-20261010-001", "ORD-20261020-001"],
    );
    assert.equal(String(orders[0].staffId), String(ids.dstAdmin));
    assert.equal(String(orders[1].staffId), String(ids.ravi));
    assert.equal(String(orders[0].items[0].productId), String(ids.tea));
    const [rawOrder] = await raw(dst, "orders", {
      orderId: "ORD-20261010-001",
    });
    assert.equal(rawOrder.items[0].qty._bsontype, "Int32");
    assert.ok(
      (await dst.collection("orders").listIndexes().toArray()).some(
        (ix) => ix.unique && ix.key.orderId === 1,
      ),
      "unique bill numbers hold in the new POS",
    );
    assert.equal(await dst.collection("promoredemptions").countDocuments(), 1);
    const counters = Object.fromEntries(
      (await dst.collection("counters").find().toArray()).map((c) => [
        c._id,
        c.seq,
      ]),
    );
    assert.deepEqual(counters, {
      "order-20261020": 5,
      "kot-20261020": 3,
      "invoice-2627": 7,
    });

    // Customers: from the date plus those of copied bills.
    const customers = await dst.collection("customers").find().toArray();
    assert.deepEqual(
      customers.map((c) => String(c._id)).sort(),
      [String(ids.oldCustomer), String(ids.newCustomer)].sort(),
    );
    assert.equal(await dst.collection("duepayments").countDocuments(), 1);
    assert.equal(await dst.collection("rewardcampaigns").countDocuments(), 1);

    // Tables: busy only while their open bill came along.
    const tables = Object.fromEntries(
      (await dst.collection("tables").find().toArray()).map((t) => [
        t.tableNo,
        t,
      ]),
    );
    assert.equal(tables["T-1"].status, "Occupied");
    assert.equal(tables["T-1"].currentOrderId, "ORD-20261020-001");
    assert.equal(tables["T-2"].status, "Available");
    assert.equal("currentOrderId" in tables["T-2"], false);
    assert.equal(tables["T-3"].status, "Reserved");
    assert.equal(String(tables["T-1"].areaId), String(ids.hall));

    // Expenses and bookings from the date; runtime state never copied.
    const entries = await raw(dst, "expenseentries");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].amountPaise._bsontype, "Int32");
    assert.equal(entries[0].createdById, String(ids.dstAdmin));
    assert.equal(await dst.collection("reservations").countDocuments(), 1);
    assert.equal(await dst.collection("events").countDocuments(), 1);
    for (const name of ["printjobs", "dinersessions", "dailyRollup"])
      assert.equal(await dst.collection(name).countDocuments(), 0, name);

    const row = await app.db.collection("installations").findOne({ _id: id });
    assert.equal(row.pos.copy.last.from, FROM);
    assert.equal(row.pos.copy.last.documents, task.result.documents);
    const audits = await app.db
      .collection("audit_events")
      .find({ resourceId: id })
      .toArray();
    assert.ok(audits.some((a) => a.action === "pos.data-copy.done"));
    assertNoSecrets(
      audits,
      [uriFor(src.databaseName), "demoAdminHash", "clientAdminHash"],
      "audit",
    );

    // Again, after one more bill in the demo: in place, no duplicates.
    await src.collection("orders").insertOne({
      orderId: "ORD-20261021-001",
      status: "Completed",
      total: 5,
      createdAt: at("2026-10-21T10:00:00Z"),
    });
    const again = await run(id, "copy");
    assert.equal(again.status, "succeeded", JSON.stringify(again.error));
    assert.equal(await dst.collection("orders").countDocuments(), 3);
    assert.equal(await dst.collection("customers").countDocuments(), 2);
    assert.equal(await dst.collection("stations").countDocuments(), 2);
    assert.equal(await dst.collection("staffs").countDocuments(), 2);
  });

  it("copies only the kinds picked; a settings-less new POS gets the demo's whole settings document", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    const task = await run(id, "copy", {
      from: FROM,
      groups: ["details", "settings", "orders"],
    });
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    const [settings] = await raw(dst, "settings");
    assert.equal(settings.kotShowPrices, true);
    assert.equal(settings.restaurantName, "Blue Cup");
    assert.equal("telegramBotId" in settings, false);
    assert.equal(
      await dst.collection("brandingassets").countDocuments(),
      1,
      "cafe details include the branding images",
    );
    assert.equal(await dst.collection("products").countDocuments(), 0);
    assert.equal(await dst.collection("orders").countDocuments(), 2);
    // Customers of the copied bills always come along (they are on the bill).
    assert.deepEqual(
      (await dst.collection("customers").find().toArray()).map((c) =>
        String(c._id),
      ),
      [String(ids.oldCustomer)],
    );
    assert.equal(await dst.collection("duepayments").countDocuments(), 0);
  });

  it("refuses when the new POS already has its own records, and writes nothing", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    await dst
      .collection("orders")
      .insertOne({ orderId: "ORD-20261101-001", createdAt: new Date() });
    await dst
      .collection("customers")
      .insertOne({ mobile: "9999999999", createdAt: new Date() });
    const check = await run(id, "check");
    assert.equal(check.status, "succeeded");
    assert.deepEqual(check.result.blocked, {
      orders: 1,
      customers: 1,
      payments: 0,
      expenses: 0,
    });
    const before = await snapshot(dst);
    const copy = await run(id, "copy");
    assert.equal(copy.status, "failed");
    assert.equal(copy.error.code, "copy-target-used");
    assert.deepEqual(await snapshot(dst), before);
  });

  it("refuses the client's own database as the old one", async () => {
    const name = `same_${randomUUID().slice(0, 8)}`;
    const { id, src } = await seed({ source: name, target: name });
    await seedSource(src);
    const before = await snapshot(src);
    const task = await run(id, "copy");
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "copy-same-db");
    assert.deepEqual(await snapshot(src), before);
  });

  it("names the side that failed to connect", async () => {
    const { id, src } = await seed();
    await seedSource(src);
    const sourceUri = uriFor(src.databaseName);
    const task = await run(id, "check", undefined, {
      openClientDb: (uri, options) =>
        uri === sourceUri
          ? Promise.reject(new ClientMongoError("auth-failed"))
          : openClientDb(uri, { ...options, allowHost: () => true }),
    });
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "copy-source-auth-failed");
    assert.doesNotMatch(JSON.stringify(task.error), /mongodb:|127\.0\.0\.1/);
  });

  it("after a copy: refuses once the new POS changed or made records, not when the demo deleted one", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    assert.equal((await run(id, "copy")).status, "succeeded");
    // The demo deletes a copied bill: copying again is still fine.
    await src.collection("orders").deleteOne({ orderId: "ORD-20261010-001" });
    const again = await run(id, "copy");
    assert.equal(again.status, "succeeded", JSON.stringify(again.error));
    assert.equal(again.result.blocked, null);
    // The new POS settles a copied open bill and adds a customer.
    const later = new Date(Date.now() + 1000);
    await dst
      .collection("orders")
      .updateOne(
        { orderId: "ORD-20261020-001" },
        { $set: { status: "Completed", updatedAt: later } },
      );
    await dst
      .collection("customers")
      .insertOne({ mobile: "9111111111", createdAt: later, updatedAt: later });
    const check = await run(id, "check");
    assert.deepEqual(check.result.blocked, {
      orders: 1,
      customers: 1,
      payments: 0,
      expenses: 0,
    });
    const before = await snapshot(dst);
    const copy = await run(id, "copy");
    assert.equal(copy.error.code, "copy-target-used");
    assert.deepEqual(await snapshot(dst), before, "the settled bill stays");
  });

  it("after a copy: demo-side changes and an interrupted run never read as the new POS's own; its login changes stay", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    assert.equal((await run(id, "copy")).status, "succeeded");
    // An interrupted later run wrote a customer with the demo's time, then
    // the demo billed that customer again.
    const t3 = new Date(Date.now() + 1000),
      t5 = new Date(Date.now() + 2000);
    await dst
      .collection("customers")
      .updateOne({ _id: ids.newCustomer }, { $set: { updatedAt: t3 } });
    await src
      .collection("customers")
      .updateOne(
        { _id: ids.newCustomer },
        { $set: { updatedAt: t5, visits: 2 } },
      );
    const check = await run(id, "check");
    assert.equal(
      check.result.blocked,
      null,
      JSON.stringify(check.result.blocked),
    );
    // The new POS resets a copied login's password: a re-run keeps it.
    await dst
      .collection("staffs")
      .updateOne(
        { _id: ids.ravi },
        {
          $set: {
            password: "$2a$12$newPosHash",
            updatedAt: new Date(Date.now() + 3000),
          },
        },
      );
    const again = await run(id, "copy");
    assert.equal(again.status, "succeeded", JSON.stringify(again.error));
    assert.equal(
      again.result.kept,
      2,
      "admin (other id) and ravi (changed here)",
    );
    const ravi = await dst.collection("staffs").findOne({ _id: ids.ravi });
    assert.equal(ravi.password, "$2a$12$newPosHash");
    const customer = await dst
      .collection("customers")
      .findOne({ _id: ids.newCustomer });
    assert.equal(customer.visits, 2, "the demo's newer customer came along");
  });

  it("a copy from another old database does not count as the last one", async () => {
    const { id, src, dst } = await seed();
    await seedSource(src);
    await seedTarget(dst);
    assert.equal((await run(id, "copy")).status, "succeeded");
    const other = conn.db(`other_${randomUUID().slice(0, 8)}`);
    await other.collection("settings").insertOne({ restaurantName: "Other" });
    await app.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.copy.source": encrypt(
            uriFor(other.databaseName),
            VAULT_KEY,
            `pos:${id}:copy.source`,
          ),
        },
      },
    );
    const check = await run(id, "check");
    assert.equal(check.status, "succeeded");
    assert.ok(
      check.result.blocked?.orders >= 2,
      "the first demo's bills are the new POS's own now",
    );
  });

  it("staff logins need the go-live admin; one settings part needs the settings document", async () => {
    const { id, src } = await seed();
    await seedSource(src);
    const body = { from: FROM, groups: ["staff", "settings"] };
    const check = await run(id, "check", body);
    assert.deepEqual(check.result.needs, ["admin", "settings"]);
    const copy = await run(id, "copy", body);
    assert.equal(copy.error.code, "copy-no-admin");
  });

  it("matches older hex-string customer and staff ids", async () => {
    const { id, src, dst } = await seed();
    await seedTarget(dst);
    await src
      .collection("staffs")
      .insertOne({ _id: ids.srcAdmin, username: "admin" });
    await src.collection("customers").insertOne({
      _id: ids.oldCustomer,
      mobile: "9000000001",
      createdAt: at("2026-09-01T10:00:00Z"),
    });
    await src.collection("orders").insertOne({
      orderId: "ORD-20261012-001",
      customerId: String(ids.oldCustomer),
      staffId: String(ids.srcAdmin),
      createdAt: at("2026-10-12T10:00:00Z"),
    });
    const task = await run(id, "copy", { from: FROM, groups: ["orders"] });
    assert.equal(task.status, "succeeded", JSON.stringify(task.error));
    assert.equal(
      await dst
        .collection("customers")
        .countDocuments({ _id: ids.oldCustomer }),
      1,
    );
    const order = await dst
      .collection("orders")
      .findOne({ orderId: "ORD-20261012-001" });
    // Remapped to the new admin and stored as the current model's ObjectIds.
    assert.ok(order.staffId instanceof ObjectId);
    assert.equal(String(order.staffId), String(ids.dstAdmin));
    assert.ok(order.customerId instanceof ObjectId);
    assert.equal(String(order.customerId), String(ids.oldCustomer));
  });

  it("refuses the same database under another host spelling", async () => {
    const name = `alias_${randomUUID().slice(0, 8)}`;
    const { id, src } = await seed({
      source: name,
      target: name,
      targetUri: uriFor(name).replace("127.0.0.1", "localhost"),
    });
    await seedSource(src);
    const task = await run(id, "check");
    assert.equal(task.error?.code, "copy-same-db");
  });
});

describe("copy data from the demo: API", () => {
  it("stores the old connection string encrypted and shows only host and database", async () => {
    const { id } = await seed();
    const path = `/installations/${id}/pos/data-copy/source`;
    const bad = await app.request(path, {
      method: "PUT",
      session: owner,
      body: { uri: "mongodb://10.0.0.5:27017/demo" },
    });
    assert.equal(bad.status, 400);
    const noDb = await app.request(path, {
      method: "PUT",
      session: owner,
      body: { uri: "mongodb+srv://u:p@cluster0.abcd1.mongodb.net/" },
    });
    assert.equal(noDb.status, 400);
    const saved = await app.request(path, {
      method: "PUT",
      session: owner,
      body: { uri: ATLAS },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.source.hosts, ["cluster0.abcd1.mongodb.net"]);
    assert.equal(saved.data.source.db, "demo");
    const row = await app.db.collection("installations").findOne({ _id: id });
    assert.equal(typeof row.pos.copy.source, "object");
    assert.equal(
      JSON.stringify(row.pos).includes("DemoPass77x"),
      false,
      "stored encrypted",
    );
    verifySecretBoxes("installations", row, VAULT_KEY);
    const view = await app.request(`/installations/${id}/pos/data-copy`, {
      session: admin,
    });
    assert.equal(view.status, 200);
    assert.equal(view.data.source.db, "demo");
    assertNoSecrets(view.data, [ATLAS, "DemoPass77x"], "view");
    const audits = await app.db
      .collection("audit_events")
      .find({ resourceId: id })
      .toArray();
    assertNoSecrets(audits, [ATLAS, "DemoPass77x"], "audit");
    const removed = await app.request(path, {
      method: "DELETE",
      session: owner,
      body: {},
    });
    assert.equal(removed.status, 200);
    assert.equal(
      (
        await app.request(`/installations/${id}/pos/data-copy`, {
          session: owner,
        })
      ).data.source,
      null,
    );
  });

  it("refuses the client's own database at save time", async () => {
    const { id } = await seed({ targetUri: ATLAS });
    const res = await app.request(`/installations/${id}/pos/data-copy/source`, {
      method: "PUT",
      session: owner,
      body: { uri: ATLAS.replace("demo-user:DemoPass77x", "other:Other99x") },
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "same-db");
  });

  it("gates on the owner's deploy permission; Copy and the source need a step-up, Check does not", async () => {
    const { id } = await seed();
    for (const who of [admin, operations, viewer]) {
      assert.equal((await post(id, "check", undefined, who)).status, 403);
      assert.equal((await post(id, "copy", undefined, who)).status, 403);
      assert.equal(
        (
          await app.request(`/installations/${id}/pos/data-copy/source`, {
            method: "PUT",
            session: who,
            body: { uri: ATLAS },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await app.request(`/installations/${id}/pos/data-copy`, {
          session: viewer,
        })
      ).status,
      403,
    );
    await stepUp(owner, false);
    try {
      assert.equal((await post(id, "copy")).status, 428);
      assert.equal(
        (
          await app.request(`/installations/${id}/pos/data-copy/source`, {
            method: "PUT",
            session: owner,
            body: { uri: ATLAS },
          })
        ).status,
        428,
      );
      const check = await post(id, "check");
      assert.equal(check.status, 201);
      assert.equal(check.data.task.params.mode, "check");
    } finally {
      await stepUp(owner);
    }
    const busy = await post(id, "copy");
    assert.equal(busy.status, 409);
    assert.equal(busy.data.code, "busy");
    const invalid = await post(randomUUID(), "check", {
      from: "yesterday",
      groups: ["menu"],
    });
    assert.equal(invalid.status, 400);
  });

  it("refuses while a go-live run is active (it seeds the admin login)", async () => {
    const { id } = await seed();
    await app.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.golive": {
            status: "running",
            requestedAt: new Date(),
            lease: {
              owner: "w",
              until: new Date(Date.now() + 60000),
              fence: 1,
            },
          },
        },
      },
    );
    const res = await post(id, "check");
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "busy");
  });

  it("refuses without an old database or a client database", async () => {
    const { id } = await seed();
    await app.db
      .collection("installations")
      .updateOne({ _id: id }, { $unset: { "pos.copy": "" } });
    const none = await post(id, "check");
    assert.equal(none.status, 409);
    assert.equal(none.data.code, "no-source");
    const { id: other } = await seed();
    await app.db
      .collection("installations")
      .updateOne({ _id: other }, { $unset: { "pos.mongo": "" } });
    const noTarget = await post(other, "check");
    assert.equal(noTarget.status, 409);
    assert.equal(noTarget.data.code, "no-target");
  });
});
