// Restore a downloaded client-database backup (.jsonl.gz, already decrypted by
// the panel's Download) into a SCRATCH MongoDB. The target URI comes from the
// environment only (RESTORE_MONGODB_URI), never from an argument, and an Atlas
// host is refused unless --allow-atlas is given, so a restore drill cannot be
// pointed at a client's live cluster by accident. A target database that
// already holds data is refused unless --force. Counts are verified at the end.
//
//   RESTORE_MONGODB_URI=mongodb://127.0.0.1:27017 \
//     node scripts/pos-db-restore.js --file demo-db-20261010-1200.jsonl.gz --db demo_restore
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { BSON, MongoClient } from "mongodb";
import { hostsOf } from "../backend/lib/client-mongo.js";

const FORMAT = "sandbee-db-backup/1";
const DB_RE = /^[A-Za-z0-9_-]{1,60}$/;
// Case and trailing dots must not slip an Atlas host past the check.
const normHost = (h) => String(h).toLowerCase().replace(/\.+$/, "");
export class RestoreError extends Error {}
const die = (message) => {
  throw new RestoreError(message);
};
// -> {collections, documents}. Throws RestoreError with a value-free message.
export async function restoreBackup({
  uri,
  db: dbName,
  file,
  force = false,
  allowAtlas = false,
  log = () => {},
}) {
  if (!uri) die("RESTORE_MONGODB_URI is not set.");
  if (!DB_RE.test(dbName ?? "")) die("--db must be a plain database name.");
  if (
    !allowAtlas &&
    hostsOf(uri).some((h) => normHost(h).endsWith(".mongodb.net"))
  )
    die(
      "Refusing an Atlas host: restore into a scratch database (or pass --allow-atlas).",
    );
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 2,
  });
  try {
    await client.connect();
    const db = client.db(dbName);
    const existing = (
      await db.listCollections({}, { nameOnly: true }).toArray()
    ).filter((c) => !c.name.startsWith("system."));
    if (existing.length && !force)
      die("The target database is not empty. Use a fresh database or --force.");
    const rl = createInterface({
      input: createReadStream(file).pipe(zlib.createGunzip()),
      crlfDelay: Infinity,
    });
    let header = null,
      trailer = null;
    const restored = {};
    const batches = new Map();
    const flush = async (name) => {
      const batch = batches.get(name);
      if (!batch?.length) return;
      batches.set(name, []);
      await db.collection(name).insertMany(batch, { ordered: true });
    };
    for await (const text of rl) {
      if (!text) continue;
      let record;
      try {
        record = BSON.EJSON.parse(text, { relaxed: false });
      } catch {
        die("The backup file is damaged (unreadable line).");
      }
      if (!header) {
        if (record?.type !== "header" || record.format !== FORMAT)
          die("This is not a sandbee database backup.");
        header = record;
        for (const name of header.collections) {
          if (typeof name !== "string" || name.startsWith("system."))
            die("The backup file is damaged (bad collection name).");
          await db.createCollection(name).catch((error) => {
            if (error?.code !== 48) throw error;
          });
        }
        continue;
      }
      if (record?.type === "trailer") {
        trailer = record;
        continue;
      }
      if (trailer) die("The backup file has data after its trailer.");
      const name = record?.c;
      if (
        typeof name !== "string" ||
        !header.collections.includes(name) ||
        !record.d
      )
        die("The backup file is damaged (unexpected record).");
      const batch = batches.get(name) ?? [];
      batch.push(record.d);
      batches.set(name, batch);
      restored[name] = (restored[name] ?? 0) + 1;
      if (batch.length >= 500) await flush(name);
    }
    if (!header || !trailer) die("The backup file is incomplete (no trailer).");
    for (const name of batches.keys()) await flush(name);
    // Verify: the file's own counts, then what is really in the database.
    let documents = 0;
    for (const name of header.collections) {
      const expected = Number(trailer.counts?.[name]?.valueOf?.() ?? 0);
      if ((restored[name] ?? 0) !== expected)
        die("The backup file's counts do not match its contents.");
      const actual = await db.collection(name).countDocuments({});
      if (actual !== expected && !force)
        die("Restored counts do not match the backup.");
      documents += expected;
      log(`restored ${name}: ${expected}`);
    }
    return { collections: header.collections.length, documents };
  } finally {
    await client.close().catch(() => {});
  }
}
async function main() {
  const args = process.argv.slice(2);
  const val = (flag) =>
    args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1) ??
    args[args.indexOf(flag) + 1];
  if (args.some((a) => a.startsWith("--uri")))
    die("Pass the URI in RESTORE_MONGODB_URI, never as an argument.");
  const result = await restoreBackup({
    uri: process.env.RESTORE_MONGODB_URI,
    db: val("--db"),
    file: val("--file"),
    force: args.includes("--force"),
    allowAtlas: args.includes("--allow-atlas"),
    log: (line) => console.info(line),
  });
  console.info(
    `restored ${result.documents} documents in ${result.collections} collections`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof RestoreError ? error.message : "Restore failed.",
    );
    process.exit(1);
  });
