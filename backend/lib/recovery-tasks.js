import { randomUUID } from "node:crypto";
import { transaction } from "../db.js";
import { decrypt, equal, keyFingerprint } from "./crypto.js";
import { audit } from "./audit.js";
import { clearLimit } from "./limiter.js";
// Maintenance tasks run from scripts/recovery.js with the API stopped. They
// take {db, client, notify?} so tests can drive them against an in-memory
// replica set.
// Clears a lost authenticator: removes TOTP state, signs the member out
// everywhere, lifts any wrong-code lockout and records the reset. The member
// then signs in with email only and enrols again.
export async function resetTotp({ db, client, notify }, email) {
  const address = String(email || "")
    .trim()
    .toLowerCase();
  const result = await transaction(client, async (session) => {
    const user = await db
      .collection("staff")
      .findOne({ email: address }, { session });
    if (!user) throw new Error("No staff member has that email.");
    if (!user.totp && !user.totpPending && !user.totpBackupCodes)
      throw new Error("That staff member has no authenticator to reset.");
    await db.collection("staff").updateOne(
      { _id: user._id },
      {
        $unset: { totp: "", totpPending: "", totpBackupCodes: "" },
        $inc: { authVersion: 1, revision: 1 },
      },
      { session },
    );
    const revoked = await db
      .collection("sessions")
      .deleteMany({ staffId: user._id }, { session });
    await clearLimit(db, `totp:${user._id}`, 900000, { session });
    await clearLimit(db, `totp-fail-day:${user._id}`, 86400000, { session });
    await audit(
      db,
      session,
      null,
      "totp.reset",
      "staff",
      user._id,
      "Authenticator reset by maintenance command",
    );
    return { staffId: user._id, sessionsRevoked: revoked.deletedCount };
  });
  try {
    await notify?.(address, {
      subject: "Your Sandbee Admin authenticator was reset",
      text: "An administrator reset the authenticator on your Sandbee Admin account and signed you out everywhere. Sign in with your password and email code, then set up the authenticator again. If you did not expect this, contact your owner.",
    });
  } catch {
    // Best effort: the reset has already been committed.
  }
  return result;
}

export const KEY_KINDS = ["vault", "backup"];
export const KEY_COPIES = ["server", "password-manager", "offline"];
const HEX_KEY = /^[a-f0-9]{64}$/;
// Proves that a key copy is the right one. The candidate is used in memory
// only: nothing derived from it except its fingerprint is stored or returned.
// A vault candidate must open the stored vault-v1 verifier; a backup candidate
// must have the fingerprint of the configured snapshot key (`backupKey`, "" when
// none is configured). Only a match writes the recovery_checks row; a mismatch
// is audited (kind and copy only) and returns {match: false}.
export async function verifyKey(
  { db, client },
  { kind, copy, key, backupKey = "" },
) {
  if (!KEY_KINDS.includes(kind))
    throw new Error("Kind must be vault or backup.");
  if (!KEY_COPIES.includes(copy))
    throw new Error("Copy must be server, password-manager or offline.");
  const candidate = String(key ?? "")
    .trim()
    .toLowerCase();
  if (!HEX_KEY.test(candidate))
    throw new Error("The key must be exactly 64 hexadecimal characters.");
  let match = false;
  if (kind === "vault") {
    const row = await db
      .collection("system_state")
      .findOne({ _id: "vault-v1" });
    if (!row?.verifier)
      throw new Error(
        "This database has no vault verifier yet. Start Admin once with the correct VAULT_KEY.",
      );
    try {
      match =
        decrypt(row.verifier, candidate, "vault-verifier-v1") ===
        "sandbee-admin-vault";
    } catch {
      match = false;
    }
  } else {
    if (!HEX_KEY.test(backupKey || ""))
      throw new Error(
        "No valid BACKUP_KEY is configured here, so there is nothing to compare with. Admin backups are manual mongodumps.",
      );
    match = equal(keyFingerprint(candidate), keyFingerprint(backupKey));
  }
  const fingerprint = keyFingerprint(candidate);
  await transaction(client, async (session) => {
    const id = randomUUID();
    if (match)
      await db.collection("recovery_checks").insertOne(
        {
          _id: id,
          type: "key-check",
          keyKind: kind,
          copy,
          fingerprint,
          result: "match",
          createdAt: new Date(),
        },
        { session },
      );
    await audit(
      db,
      session,
      null,
      match ? "recovery.key-verified" : "recovery.key-mismatch",
      "recovery_checks",
      match ? id : kind,
      `${kind} key, ${copy} copy`,
    );
  });
  return { match, fingerprint };
}
// Green up to 100 days since the last drill, amber up to 190, else red.
export function drillState(restoredAt, now = new Date()) {
  const time = Date.parse(restoredAt || "");
  if (Number.isNaN(time))
    return { state: "red", lastDrill: null, daysSince: null };
  const daysSince = Math.floor((now.getTime() - time) / 86400000);
  return {
    state: daysSince <= 100 ? "green" : daysSince <= 190 ? "amber" : "red",
    lastDrill: restoredAt,
    daysSince,
  };
}
// Latest key-check per kind x copy: {vault: {server: {at, fingerprint}|null}}.
export async function latestKeyChecks(db) {
  const out = {};
  for (const kind of KEY_KINDS) {
    out[kind] = {};
    for (const copy of KEY_COPIES) {
      const row = await db
        .collection("recovery_checks")
        .findOne(
          { type: "key-check", keyKind: kind, copy },
          { sort: { createdAt: -1 } },
        );
      out[kind][copy] = row
        ? { at: row.createdAt, fingerprint: row.fingerprint }
        : null;
    }
  }
  return out;
}
