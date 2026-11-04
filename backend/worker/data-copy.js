// Owner-triggered "Copy data from the demo" (D58): a POS's data is copied from
// another POS database (the demo the client used) into this client's own,
// still unused, database. One task kind, two modes on the same params:
// "check" only counts, "copy" writes. The old database is only read.
// Documents keep their _id and exact BSON types (promoteValues off), so every
// reference between them stays valid and a second copy updates in place.
// Neither URI, a document nor a value reaches a log, a row or an audit: counts,
// collection names and fixed note codes only.
import { BSON, ObjectId } from "mongodb";
import { audit } from "../lib/audit.js";
import {
  ClientMongoError,
  hostsOf,
  openClientDb,
} from "../lib/client-mongo.js";
import { describeCode } from "../../shared/deploy-errors.js";
import {
  COPY_BLOCKERS,
  copyParamsSchema,
  dayStart,
  sortGroups,
} from "../../shared/data-copy.js";
import { transaction } from "../db.js";
import {
  JobFail,
  LeaseLost,
  Released,
  ensureLive,
  withLease,
} from "./lease.js";
import { WORKER_ACTOR, failTask, loadTarget, openSecret } from "./verify.js";

const READ_BATCH = 500;
// Small writes: Atlas M0 throttles operations per second.
const WRITE_BATCH = 100;
const TIMEOUT_MS = 15000;
const RAW = { promoteValues: false };
const HEX_RE = /^[0-9a-f]{24}$/i;
const fail = (code) => {
  const d = describeCode(code);
  return new JobFail(code, `${d.plainMessage} ${d.action}`.slice(0, 160));
};
// Settings fields of "Cafe details"; every other field except Telegram's
// (bound to the old deployment's AUTH_SECRET and host) and the record's own
// keys belongs to "Bill & print settings".
const DETAIL_FIELDS = new Set([
  "restaurantName",
  "tagline",
  "mobile",
  "address",
  "receiptHeader",
  "receiptFooter",
  "fssai",
  "gstEnabled",
  "gstNumber",
  "gstRate",
  "gstMode",
  "logo",
  "productLogo",
  "upiId",
  "upiRules",
  "payQrMode",
  "payQrValidMinutes",
]);
const OWN_KEYS = new Set(["_id", "createdAt", "updatedAt", "__v"]);
export const settingsPart = (field) =>
  OWN_KEYS.has(field) || field.startsWith("telegram")
    ? null
    : DETAIL_FIELDS.has(field)
      ? "details"
      : "settings";
// Copied whole: the new POS's rows are replaced by the old ones.
const WHOLE = {
  details: ["brandingassets"],
  printers: ["stations", "printers", "printhosts"],
  menu: ["categories", "products"],
  customers: ["rewardcampaigns"],
  tables: ["areas", "tables"],
  expenses: ["expensecategories"],
};
const KNOWN = new Set([
  ...Object.values(WHOLE).flat(),
  "settings",
  "staffs",
  "customers",
  "duepayments",
  "orders",
  "promoredemptions",
  "counters",
  "expenseentries",
  "reservations",
  "events",
]);
// Runtime state the new POS rebuilds itself (sessions, queues, kitchen ticks,
// the old Telegram bot's chats): never copied, never listed.
const RUNTIME = new Set([
  "dinersessions",
  "publicratelimits",
  "printjobs",
  "printdevices",
  "kotticks",
  "orderrequests",
  "telegramchats",
  "telegraminvites",
]);
// The new POS's own use of these blocks a copy (it would be overwritten or mixed).
const BLOCKER_COLLECTIONS = {
  orders: "orders",
  customers: "customers",
  payments: "duepayments",
  expenses: "expenseentries",
};
const time = (value) => (value instanceof Date ? value.getTime() : null);
const idKey = (id) => BSON.EJSON.stringify(id, { relaxed: false });
// A copied row the new POS changed since the last copy started: the POS
// stamps updatedAt on every write and a copy keeps the demo's, so the new
// POS's write is later than both (a row an interrupted run wrote holds the
// demo's own time and does not count).
const changedHere = (row, old, lastAt) => {
  const mine = time(row.updatedAt) ?? 0;
  return lastAt !== null && mine > lastAt && mine > (time(old?.updatedAt) ?? 0);
};
// Rows the new POS made or changed itself. Before any copy (`lastAt` null):
// every id the old database lacks. After a copy: ids it lacks created since
// that copy started (an older one is a copied row the demo deleted since),
// and copied rows it changed (changedHere).
async function usedCount(src, dst, name, lastAt, signal) {
  let used = 0,
    batch = [];
  const flush = async () => {
    if (!batch.length) return;
    ensureLive(signal);
    const theirs = new Map();
    for await (const row of src
      .collection(name)
      .find(
        { _id: { $in: batch.map((r) => r._id) } },
        { projection: { updatedAt: 1 }, ...RAW },
      ))
      theirs.set(idKey(row._id), row);
    for (const row of batch) {
      const old = theirs.get(idKey(row._id));
      if (!old) {
        if (lastAt === null || (time(row.createdAt) ?? 0) > lastAt) used++;
      } else if (changedHere(row, old, lastAt)) used++;
    }
    batch = [];
  };
  for await (const row of dst.collection(name).find(
    {},
    {
      projection: { createdAt: 1, updatedAt: 1 },
      batchSize: READ_BATCH,
      ...RAW,
    },
  )) {
    batch.push(row);
    if (batch.length >= READ_BATCH) await flush();
  }
  await flush();
  return used;
}
// listIndexes shows a text index as {_fts, _ftsx} + weights; createIndex
// wants the field names.
function indexKey(key, weights) {
  if (key._fts !== "text") return key;
  const out = {};
  for (const [field, value] of Object.entries(key)) {
    if (field === "_fts")
      for (const name of Object.keys(weights ?? {})) out[name] = "text";
    else if (field !== "_ftsx") out[field] = value;
  }
  return out;
}
// The old database's indexes the new one lacks (by name), before any write:
// unique names, collations and partial indexes then hold for the copied rows.
async function copyIndexes(src, dst, name, stats) {
  const list = (db) =>
    db
      .collection(name)
      .listIndexes()
      .toArray()
      .catch(() => []);
  const have = new Set((await list(dst)).map((spec) => spec.name));
  for (const spec of await list(src)) {
    const { v, key, ns, ...options } = spec;
    if (options.name === "_id_" || have.has(options.name)) continue;
    try {
      await dst
        .collection(name)
        .createIndex(indexKey(key, options.weights), options);
    } catch {
      stats.indexSkipped++;
    }
  }
}
// Copies the matching rows by _id (replace or insert). `map` may change a row.
async function upsertAll(run, name, filter, map) {
  const { src, dst } = run;
  let ops = [],
    n = 0;
  const flush = async () => {
    if (!ops.length) return;
    run.live();
    await dst.collection(name).bulkWrite(ops, { ordered: true });
    n += ops.length;
    run.done += ops.length;
    ops = [];
    await run.tick();
  };
  const cursor = src
    .collection(name)
    .find(filter, { batchSize: READ_BATCH, ...RAW });
  try {
    for await (const doc of cursor) {
      const row = map ? await map(doc) : doc;
      ops.push({
        replaceOne: {
          filter: { _id: row._id },
          replacement: row,
          upsert: true,
        },
      });
      if (ops.length >= WRITE_BATCH) await flush();
    }
    await flush();
  } finally {
    await cursor.close().catch(() => {});
  }
  return n;
}
// The new POS's rows the old one does not have go first (seeded twins with the
// same name would collide on a unique index), then every old row is copied.
async function replaceWhole(run, name, map) {
  const ids = [];
  for await (const { _id } of run.src
    .collection(name)
    .find({}, { projection: { _id: 1 }, batchSize: READ_BATCH, ...RAW }))
    ids.push(_id);
  run.live();
  const gone = await run.dst
    .collection(name)
    .deleteMany({ _id: { $nin: ids } });
  run.stats.removed += gone.deletedCount;
  return upsertAll(run, name, {}, map);
}
async function copySettings(run, part) {
  const { src, dst } = run;
  const old = await src.collection("settings").findOne({}, RAW);
  if (!old) return 0;
  const fields = Object.keys(old).filter((k) => settingsPart(k) === part);
  const set = Object.fromEntries(fields.map((k) => [k, old[k]]));
  const now = new Date(run.ctx.now());
  run.live();
  // The POS reads the first settings document, like findOne() here.
  const mine = await dst.collection("settings").findOne({}, RAW);
  if (!mine) {
    await dst
      .collection("settings")
      .insertOne({ _id: old._id, ...set, createdAt: now, updatedAt: now });
    return fields.length;
  }
  // Omit-empty: a field the old settings do not have reads as the default.
  const unset = Object.keys(mine).filter(
    (k) => settingsPart(k) === part && !(k in old),
  );
  await dst.collection("settings").updateOne(
    { _id: mine._id },
    {
      $set: { ...set, updatedAt: now },
      ...(unset.length
        ? { $unset: Object.fromEntries(unset.map((k) => [k, ""])) }
        : {}),
    },
  );
  return fields.length;
}
// Same username under another id: the new POS keeps its own login (the
// go-live admin) and the old id is pointed at it in copied bills and
// expenses. A login copied earlier (same id) is copied again unless the new
// POS changed it since (a password, PIN or active flag set there).
async function staffIds(src, dst, lastAt) {
  const mine = new Map();
  for await (const row of dst
    .collection("staffs")
    .find({}, { projection: { username: 1, updatedAt: 1 } }))
    mine.set(row.username, row);
  const map = new Map(),
    kept = [];
  for await (const row of src
    .collection("staffs")
    .find({}, { projection: { username: 1, updatedAt: 1 }, ...RAW })) {
    const own = mine.get(row.username);
    if (own === undefined) continue;
    if (String(own._id) !== String(row._id)) {
      kept.push(row._id);
      map.set(String(row._id), own._id);
    } else if (changedHere(own, row, lastAt)) kept.push(row._id);
  }
  const admin = await dst
    .collection("staffs")
    .countDocuments({ role: "admin" }, { limit: 1 });
  return { map, kept, admin: admin > 0 };
}
// Bill, KOT, token and invoice numbers: never lowers a number the new POS
// already used, so numbering continues after the copied bills.
async function copyCounters(run) {
  let ops = [];
  const flush = async () => {
    if (!ops.length) return;
    run.live();
    await run.dst.collection("counters").bulkWrite(ops, { ordered: true });
    ops = [];
  };
  for await (const row of run.src
    .collection("counters")
    .find({}, { batchSize: READ_BATCH, ...RAW })) {
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: { $max: { seq: row.seq } },
        upsert: true,
      },
    });
    if (ops.length >= WRITE_BATCH) await flush();
  }
  await flush();
}

// What a choice copies: filters and per-group counts (check and copy alike).
async function planOf(src, params) {
  const groups = new Set(params.groups),
    start = dayStart(params.from),
    since = { createdAt: { $gte: start } },
    onDay = { date: { $gte: params.from } };
  // Customers of the copied bills and due payments always come along. Older
  // POS data may hold the id as a hex string: both spellings match.
  const refs = [];
  const add = (values) => {
    for (const value of values) {
      refs.push(value);
      if (typeof value === "string" && HEX_RE.test(value))
        refs.push(new ObjectId(value));
    }
  };
  if (groups.has("orders"))
    add(
      await src
        .collection("orders")
        .distinct("customerId", { ...since, customerId: { $ne: null } }),
    );
  if (groups.has("customers"))
    add(
      await src
        .collection("duepayments")
        .distinct("customerId", { ...since, customerId: { $ne: null } }),
    );
  const customers = groups.has("customers")
    ? { $or: [since, { _id: { $in: refs } }] }
    : refs.length
      ? { _id: { $in: refs } }
      : null;
  return {
    groups,
    since,
    onDay,
    customers,
    customerGroup: groups.has("customers") ? "customers" : "orders",
    olderFilter: refs.length
      ? { _id: { $in: refs }, createdAt: { $lt: start } }
      : null,
  };
}
async function countPlan(src, plan, staffKept) {
  const count = (name, filter = {}) =>
    src.collection(name).countDocuments(filter);
  const sum = async (names) =>
    (await Promise.all(names.map((name) => count(name)))).reduce(
      (a, b) => a + b,
      0,
    );
  const settings = await src.collection("settings").findOne({}, RAW);
  const fieldsOf = (part) =>
    settings
      ? Object.keys(settings).filter((k) => settingsPart(k) === part).length
      : 0;
  const out = {};
  const add = (group, n) => {
    out[group] = (out[group] ?? 0) + n;
  };
  const g = plan.groups;
  if (g.has("details"))
    add("details", fieldsOf("details") + (await sum(WHOLE.details)));
  if (g.has("settings")) add("settings", fieldsOf("settings"));
  if (g.has("printers")) add("printers", await sum(WHOLE.printers));
  if (g.has("menu")) add("menu", await sum(WHOLE.menu));
  if (g.has("staff"))
    add("staff", Math.max(0, (await count("staffs")) - staffKept));
  if (plan.customers)
    add(plan.customerGroup, await count("customers", plan.customers));
  if (g.has("customers"))
    add(
      "customers",
      (await count("duepayments", plan.since)) + (await sum(WHOLE.customers)),
    );
  if (g.has("orders"))
    add(
      "orders",
      (await count("orders", plan.since)) +
        (await count("promoredemptions", plan.since)),
    );
  if (g.has("tables")) add("tables", await sum(WHOLE.tables));
  if (g.has("expenses"))
    add(
      "expenses",
      (await count("expenseentries", plan.onDay)) + (await sum(WHOLE.expenses)),
    );
  if (g.has("bookings"))
    add(
      "bookings",
      (await count("reservations", plan.onDay)) +
        (await count("events", plan.onDay)),
    );
  return out;
}
async function notesOf(src, plan) {
  const g = plan.groups,
    has = async (name, filter) =>
      (await src.collection(name).countDocuments(filter, { limit: 1 })) > 0,
    notes = [],
    extra = { older: 0, open: 0, oldOpen: 0, undated: 0 };
  const settings = await src.collection("settings").findOne(
    {},
    {
      projection: {
        telegramBotId: 1,
        telegramBotTokenEnc: 1,
        logo: 1,
        productLogo: 1,
      },
    },
  );
  if (settings?.telegramBotId || settings?.telegramBotTokenEnc)
    notes.push("telegram");
  if (
    g.has("printers") &&
    (await has("printers", { "connection.kind": "device" }))
  )
    notes.push("device-printers");
  if (
    (g.has("menu") &&
      (await has("products", { image: { $nin: [null, ""] } }))) ||
    (g.has("details") && (settings?.logo || settings?.productLogo))
  )
    notes.push("images");
  if (plan.olderFilter) {
    extra.older = await src
      .collection("customers")
      .countDocuments(plan.olderFilter);
    if (extra.older) notes.push("older-customers");
  }
  if (g.has("orders")) {
    extra.open = await src
      .collection("orders")
      .countDocuments({ ...plan.since, status: "Pending" });
    if (extra.open) notes.push("open-orders");
    // Open tabs from before the date stay behind (and free their tables).
    extra.oldOpen = await src.collection("orders").countDocuments({
      createdAt: { $lt: plan.since.createdAt.$gte },
      status: "Pending",
    });
    if (extra.oldOpen) notes.push("old-open-orders");
    extra.undated = await src
      .collection("orders")
      .countDocuments({ createdAt: { $exists: false } });
    if (extra.undated) notes.push("undated");
  }
  return { notes, ...extra };
}
// Collections of the old database this tool does not copy (names + counts).
async function othersOf(src) {
  const listed = await src.listCollections({}, { nameOnly: false }).toArray();
  const names = listed
    .filter(
      (c) =>
        c.type !== "view" &&
        !c.name.startsWith("system.") &&
        !KNOWN.has(c.name) &&
        !RUNTIME.has(c.name),
    )
    .map((c) => c.name)
    .sort()
    .slice(0, 20);
  return Promise.all(
    names.map(async (name) => ({
      name,
      count: await src.collection(name).estimatedDocumentCount(),
    })),
  );
}
async function blockersOf(src, dst, lastAt, signal) {
  const out = {};
  for (const key of COPY_BLOCKERS)
    out[key] = await usedCount(
      src,
      dst,
      BLOCKER_COLLECTIONS[key],
      lastAt,
      signal,
    );
  return Object.values(out).some(Boolean) ? out : null;
}
// What the new POS must have before this choice can be copied (COPY_NEEDS).
async function needsOf(dst, plan, staff) {
  const needs = [];
  if (plan.groups.has("staff") && !staff.admin) needs.push("admin");
  const parts = ["details", "settings"].filter((g) => plan.groups.has(g));
  if (
    parts.length === 1 &&
    !(await dst.collection("settings").countDocuments({}, { limit: 1 }))
  )
    needs.push("settings");
  return needs;
}

async function copyPlan(run, plan, staff) {
  const g = plan.groups,
    copied = {};
  const step = async (group, work) => {
    await run.enter(group);
    copied[group] = (copied[group] ?? 0) + (await work());
  };
  const whole = (group, map = {}) =>
    step(group, async () => {
      let n = 0;
      for (const name of WHOLE[group]) {
        await copyIndexes(run.src, run.dst, name, run.stats);
        n += await replaceWhole(run, name, map[name]);
      }
      return n;
    });
  const dated = (group, name, filter, map) =>
    step(group, async () => {
      await copyIndexes(run.src, run.dst, name, run.stats);
      return upsertAll(run, name, filter, map);
    });
  // Keeps the stored spelling (ObjectId, or a hex string in older data).
  const remapStaff = (field) => (doc) => {
    const to = doc[field] ? staff.map.get(String(doc[field])) : undefined;
    if (to === undefined) return doc;
    return {
      ...doc,
      [field]: typeof doc[field] === "string" ? String(to) : to,
    };
  };
  // Older POS data may hold these links as hex strings; the current models
  // (Order.customerId/staffId, DuePayment.customerId) are ObjectIds.
  const asObjectIds =
    (...fields) =>
    (doc) => {
      let out = doc;
      for (const field of fields)
        if (typeof doc[field] === "string" && HEX_RE.test(doc[field]))
          out = { ...out, [field]: new ObjectId(doc[field]) };
      return out;
    };
  const orderRow = (doc) =>
    asObjectIds("customerId", "staffId")(remapStaff("staffId")(doc));

  if (g.has("details")) {
    await step("details", () => copySettings(run, "details"));
    await whole("details");
  }
  if (g.has("settings"))
    await step("settings", () => copySettings(run, "settings"));
  // Server-kept reachability and health are the old site's; the new POS
  // measures its own.
  if (g.has("printers"))
    await whole("printers", {
      printers: ({ unreachable, health, ...row }) => row,
    });
  if (g.has("menu")) await whole("menu");
  if (g.has("staff"))
    await dated("staff", "staffs", { _id: { $nin: staff.kept } });
  if (plan.customers)
    await dated(plan.customerGroup, "customers", plan.customers);
  if (g.has("customers")) {
    await dated(
      "customers",
      "duepayments",
      plan.since,
      asObjectIds("customerId"),
    );
    await whole("customers");
  }
  if (g.has("orders")) {
    await dated("orders", "orders", plan.since, orderRow);
    await dated("orders", "promoredemptions", plan.since);
    await run.enter("orders");
    await copyCounters(run);
  }
  // A table stays "in use" only when its open bill was copied too.
  if (g.has("tables"))
    await whole("tables", {
      tables: async (row) => {
        if (!row.currentOrderId) return row;
        const open = await run.dst
          .collection("orders")
          .findOne({ orderId: row.currentOrderId }, { projection: { _id: 1 } });
        if (open) return row;
        const { currentOrderId, ...rest } = row;
        return rest.status === "Occupied"
          ? { ...rest, status: "Available" }
          : rest;
      },
    });
  if (g.has("expenses")) {
    await whole("expenses");
    await dated(
      "expenses",
      "expenseentries",
      plan.onDay,
      remapStaff("createdById"),
    );
  }
  if (g.has("bookings")) {
    await dated("bookings", "reservations", plan.onDay);
    await dated("bookings", "events", plan.onDay);
  }
  return copied;
}

const where = (uri, db) =>
  `${hostsOf(uri).sort().join(",")}/${db.databaseName}`;
// Also the same database under another host spelling (SRV name vs seed list):
// its collections carry the same UUIDs on the same replica set. A restored
// snapshot on another cluster keeps the UUIDs but not the set name.
async function sameDatabase(sourceUri, src, targetUri, dst) {
  if (where(sourceUri, src) === where(targetUri, dst)) return true;
  const uuids = async (db) =>
    new Set(
      (await db.listCollections({}, { nameOnly: false }).toArray())
        .map((c) => (c.info?.uuid ? idKey(c.info.uuid) : null))
        .filter(Boolean),
    );
  const setOf = async (db) =>
    (
      await db
        .admin()
        .command({ hello: 1 })
        .catch(() => null)
    )?.setName ?? null;
  const [a, b, setA, setB] = await Promise.all([
    uuids(src),
    uuids(dst),
    setOf(src),
    setOf(dst),
  ]);
  if (setA && setB && setA !== setB) return false;
  return [...a].some((uuid) => b.has(uuid));
}
export async function runDataCopy(ctx, claim) {
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const task = claim.doc,
        mode = task.params?.mode;
      const parsed = copyParamsSchema.safeParse({
        from: task.params?.from,
        groups: task.params?.groups,
      });
      if (!parsed.success || !["check", "copy"].includes(mode))
        throw fail("invalid");
      const params = {
        from: parsed.data.from,
        groups: sortGroups(parsed.data.groups),
      };
      const target = await loadTarget(ctx, claim.installationId, {
        needToken: false,
      });
      const targetUri = openSecret(
        ctx,
        claim.installationId,
        target.pos,
        "mongo.uri",
      );
      if (!targetUri) throw fail("copy-no-target");
      const sourceUri = openSecret(
        ctx,
        claim.installationId,
        target.pos,
        "copy.source",
      );
      if (!sourceUri) throw fail("copy-no-source");
      const open = ctx.openClientDb ?? openClientDb;
      let src, dst;
      try {
        try {
          src = await open(sourceUri, {
            readPreference: "secondaryPreferred",
            timeoutMs: TIMEOUT_MS,
          });
        } catch (error) {
          throw error instanceof ClientMongoError
            ? fail(`copy-source-${error.code}`)
            : fail("copy-failed");
        }
        try {
          dst = await open(targetUri, { timeoutMs: TIMEOUT_MS });
        } catch (error) {
          throw error instanceof ClientMongoError
            ? fail(error.code)
            : fail("copy-failed");
        }
        if (await sameDatabase(sourceUri, src.db, targetUri, dst.db))
          throw fail("copy-same-db");
        // The last copy counts only when it read this same old database.
        // Its start, not its end: what the new POS did during it counts too.
        const source = where(sourceUri, src.db),
          last = target.pos.copy?.last,
          startedAt = ctx.now();
        const result = await work(ctx, claim, signal, {
          mode,
          params,
          src: src.db,
          dst: dst.db,
          lastAt:
            last?.source === source
              ? (time(last.startedAt) ?? time(last.at))
              : null,
        });
        await finish(
          ctx,
          claim,
          mode,
          { ...params, source, startedAt },
          result,
        );
      } catch (error) {
        if (
          error instanceof JobFail ||
          error instanceof LeaseLost ||
          error instanceof Released
        )
          throw error;
        if (signal.aborted) throw signal.reason;
        throw fail(error?.code === 11000 ? "copy-duplicate" : "copy-failed");
      } finally {
        await src?.client.close().catch(() => {});
        await dst?.client.close().catch(() => {});
      }
    },
    (error) => failTask(ctx, claim, error),
  );
}
async function work(ctx, claim, signal, { mode, params, src, dst, lastAt }) {
  const { slot } = claim;
  await slot.mustSet({ step: "check", progress: null });
  const plan = await planOf(src, params);
  const staff = await staffIds(src, dst, lastAt);
  const blocked = await blockersOf(src, dst, lastAt, signal);
  const needs = await needsOf(dst, plan, staff);
  const base = {
    mode,
    from: params.from,
    groups: await countPlan(src, plan, staff.kept.length),
    kept: staff.kept.length,
    blocked,
    needs,
    ...(await notesOf(src, plan)),
    others: await othersOf(src),
  };
  if (mode === "check") return base;
  if (blocked) throw fail("copy-target-used");
  if (needs.length)
    throw fail(needs[0] === "admin" ? "copy-no-admin" : "copy-no-settings");
  let lastProgress = 0;
  const run = {
    ctx,
    src,
    dst,
    done: 0,
    stats: { removed: 0, indexSkipped: 0 },
    live() {
      ensureLive(signal);
      if (ctx.stopState?.requested) throw new Released();
    },
    async enter(group) {
      run.live();
      await slot.mustSet({ step: group, progress: { documents: run.done } });
      lastProgress = ctx.now();
    },
    async tick() {
      if (ctx.now() - lastProgress < 2000) return;
      lastProgress = ctx.now();
      await slot.mustSet({ progress: { documents: run.done } });
    },
  };
  const copied = await copyPlan(run, plan, staff);
  if (run.stats.indexSkipped) base.notes.push("index-skipped");
  return {
    ...base,
    copied,
    removed: run.stats.removed,
    documents: Object.values(copied).reduce((a, b) => a + b, 0),
  };
}
async function finish(ctx, claim, mode, params, result) {
  const { slot } = claim,
    now = new Date(ctx.now());
  await transaction(ctx.client, async (session) => {
    const done = await ctx.coll.installations.updateOne(
      slot.filterOf(),
      {
        $set: {
          ...slot.prefixed({
            status: "succeeded",
            step: "done",
            finishedAt: now,
            error: null,
            progress: null,
            result,
          }),
          ...(mode === "copy"
            ? {
                "pos.copy.last": {
                  at: now,
                  startedAt: new Date(params.startedAt),
                  // host/database of the old database (no credentials)
                  source: params.source,
                  from: params.from,
                  groups: params.groups,
                  documents: result.documents,
                },
              }
            : {}),
        },
      },
      { session },
    );
    if (done.matchedCount !== 1) throw new LeaseLost();
    if (mode === "copy")
      await audit(
        ctx.db,
        session,
        WORKER_ACTOR,
        "pos.data-copy.done",
        "installations",
        claim.installationId,
        `from ${params.from}: ${result.documents} records (${params.groups.join(",")})`.slice(
          0,
          200,
        ),
      );
  });
}
