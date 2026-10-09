import { encrypt, decrypt } from "./crypto.js";
export async function verifyVaultKey(db, key) {
  // A persistent verifier prevents writing mixed-key credentials after a mistaken ENV change.
  try {
    await db.collection("system_state").updateOne(
      { _id: "vault-v1" },
      {
        $setOnInsert: {
          verifier: encrypt("sandbee-admin-vault", key, "vault-verifier-v1"),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  const row = await db.collection("system_state").findOne({ _id: "vault-v1" });
  // A wrong key fails GCM authentication inside decrypt, so that failure is
  // the "wrong key" signal, not a crash.
  let matches = false;
  try {
    matches =
      decrypt(row.verifier, key, "vault-verifier-v1") === "sandbee-admin-vault";
  } catch {
    matches = false;
  }
  if (!matches)
    throw new Error(
      "Vault key does not match this database. Restore the original key.",
    );
}
