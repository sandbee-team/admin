import { BSON } from "mongodb";
import { encrypt, decrypt } from "./crypto.js";
import { verifySecretBoxes } from "./secrets.js";
// Collections are read one after another: the counters come after the
// documents, so a document issued during a snapshot can never be restored
// with a counter that has not reached it (the next issue would collide).
export const SALES_COLLECTIONS = [
  "sales_settings",
  "sales_assets",
  "sales_profiles",
  "sales_deals",
  "sales_documents",
  "sales_counters",
];
export const BACKUP_COLLECTIONS = [
  "staff",
  "products",
  "customers",
  "installations",
  "connections",
  "tasks",
  "audit_events",
  "recovery_checks",
  "system_state",
  ...SALES_COLLECTIONS,
];
// Added after the first snapshots were taken: a snapshot without them is
// still accepted and they restore empty.
const OPTIONAL_COLLECTIONS = new Set(SALES_COLLECTIONS);
const MAX_BYTES = 50 * 1024 * 1024;
export async function makeSnapshot(db, vaultKey, backupKey) {
  const collections = {};
  let bytes = 0;
  for (const name of BACKUP_COLLECTIONS) {
    collections[name] = [];
    for await (const row of db.collection(name).find({})) {
      verifySecretBoxes(name, row, vaultKey);
      bytes += Buffer.byteLength(BSON.EJSON.stringify(row));
      if (bytes > MAX_BYTES)
        throw new Error(
          "Snapshot exceeds 50 MB. Use managed database snapshots for this installation.",
        );
      collections[name].push(row);
    }
  }
  const value = BSON.EJSON.stringify({
    format: 1,
    createdAt: new Date(),
    collections,
  });
  return JSON.stringify(encrypt(value, backupKey, "sandbee-admin-backup-v1"));
}
export function parseSnapshot(value, vaultKey, backupKey) {
  if (Buffer.byteLength(value) > MAX_BYTES * 1.5)
    throw new Error("Snapshot too large.");
  const snapshot = BSON.EJSON.parse(
    decrypt(JSON.parse(value), backupKey, "sandbee-admin-backup-v1"),
  );
  const names = Object.keys(snapshot.collections ?? {});
  if (
    snapshot.format !== 1 ||
    names.some((name) => !BACKUP_COLLECTIONS.includes(name)) ||
    BACKUP_COLLECTIONS.some(
      (name) => !OPTIONAL_COLLECTIONS.has(name) && !names.includes(name),
    )
  )
    throw new Error("Unsupported snapshot.");
  for (const name of BACKUP_COLLECTIONS) {
    snapshot.collections[name] ??= [];
    if (!Array.isArray(snapshot.collections[name]))
      throw new Error("Invalid snapshot collection.");
  }
  const verifier = snapshot.collections.system_state.find(
    (row) => row._id === "vault-v1",
  );
  if (verifier) {
    let matches = false;
    try {
      matches =
        decrypt(verifier.verifier, vaultKey, "vault-verifier-v1") ===
        "sandbee-admin-vault";
    } catch {
      matches = false;
    }
    if (!matches) throw new Error("Vault verification failed.");
  }
  for (const name of BACKUP_COLLECTIONS)
    for (const row of snapshot.collections[name])
      verifySecretBoxes(name, row, vaultKey);
  return snapshot;
}
