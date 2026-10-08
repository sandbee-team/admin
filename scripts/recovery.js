import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../backend/config.js";
import { connect, transaction } from "../backend/db.js";
import {
  makeSnapshot,
  parseSnapshot,
  BACKUP_COLLECTIONS,
} from "../backend/lib/snapshot.js";
const [command, file] = process.argv.slice(2),
  c = config();
const backupKey =
  process.env.BACKUP_KEY ||
  readFileSync(".local/backup-key.txt", "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(backupKey))
  throw new Error("A 32-byte hexadecimal BACKUP_KEY is required.");
if (!process.argv.includes("--maintenance"))
  throw new Error(
    "Stop all Admin API replicas, then rerun with --maintenance. The snapshot tool requires a write-free window.",
  );
if (!["backup", "restore"].includes(command))
  throw new Error("Use backup or restore.");
const sourceDb = c.MONGODB_DB;
if (command === "restore") {
  if (
    !file ||
    !/^[a-zA-Z0-9_-]{3,80}$/.test(process.env.RESTORE_DB || "") ||
    process.env.RESTORE_DB === sourceDb
  )
    throw new Error(
      "Restore requires a snapshot path and RESTORE_DB naming a NEW distinct database.",
    );
  c.MONGODB_DB = process.env.RESTORE_DB;
}
const { db, client } = await connect(c);
try {
  if (command === "backup") {
    mkdirSync("backups", { recursive: true });
    const output =
      file && !file.startsWith("--")
        ? resolve(file)
        : resolve(
            "backups",
            `admin-${new Date().toISOString().replaceAll(":", "-")}.enc`,
          );
    const value = await makeSnapshot(db, c.VAULT_KEY, backupKey);
    writeFileSync(output, value, { flag: "wx", mode: 0o600 });
    console.info(
      `Encrypted snapshot created: ${output}. Copy off-machine; keep both keys separate.`,
    );
  } else {
    const snapshot = parseSnapshot(
      readFileSync(file, "utf8"),
      c.VAULT_KEY,
      backupKey,
    );
    for (const item of await db.listCollections().toArray())
      if (await db.collection(item.name).findOne({}))
        throw new Error(
          "Restore destination is not empty. No data was overwritten.",
        );
    await transaction(client, async (session) => {
      for (const name of BACKUP_COLLECTIONS) {
        const rows = snapshot.collections[name];
        if (name === "staff") for (const row of rows) row.authVersion += 1;
        if (rows.length)
          await db.collection(name).insertMany(rows, { session });
      }
    });
    console.info(
      `Restored into ${c.MONGODB_DB}. Sessions were excluded. Verify counts, login and encrypted connections before switching APP configuration.`,
    );
  }
} finally {
  await client.close();
}
