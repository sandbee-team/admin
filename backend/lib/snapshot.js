import { BSON } from "mongodb";
import { encrypt, decrypt } from "./crypto.js";
import { verifySecretBoxes } from "./secrets.js";
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
];
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
  if (
    snapshot.format !== 1 ||
    Object.keys(snapshot.collections).sort().join(",") !==
      [...BACKUP_COLLECTIONS].sort().join(",")
  )
    throw new Error("Unsupported snapshot.");
  for (const name of BACKUP_COLLECTIONS)
    if (!Array.isArray(snapshot.collections[name]))
      throw new Error("Invalid snapshot collection.");
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
