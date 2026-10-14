// Sealing and registration of customer files (SBF1), shared by the upload
// route (modules/files.js) and the client-database backup task. A file object in
// S3 is: SBF1 | iv(12) | AES-256-GCM ciphertext | tag(16), a random data key per
// file, GCM AAD `file:<customerId>:<fileId>`, the data key sealed with
// VAULT_KEY in the customer record. Behaviour is exactly what files.js had.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { encrypt, decrypt, equal } from "./crypto.js";
import { ensure } from "./errors.js";
import { MAX_FILES } from "../../shared/schemas.js";

export const MAGIC = Buffer.from("SBF1");
export const OVERHEAD = MAGIC.length + 12 + 16; // magic + iv + GCM tag
export class SealedIntegrityError extends Error {}
// Reads a stored file (pinned to its versionId) and returns the plaintext only
// when the object's size and magic, the GCM tag and the plaintext SHA-256
// recorded at upload all verify; otherwise SealedIntegrityError. Storage
// errors are rethrown unchanged. Used by file downloads and sales documents.
export async function openSealed(s3, file, aad, vaultKey) {
  let body;
  try {
    body = await s3.get(file.s3Key, file.versionId, file.size + OVERHEAD);
  } catch (error) {
    // An object longer than it can legitimately be is a tampered object.
    if (error.s3Code !== "TooLarge") throw error;
    throw new SealedIntegrityError();
  }
  try {
    if (
      body.length !== file.size + OVERHEAD ||
      !body.subarray(0, MAGIC.length).equals(MAGIC)
    )
      throw new Error();
    const dataKey = Buffer.from(decrypt(file.dataKey, vaultKey, aad), "hex");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      body.subarray(MAGIC.length, MAGIC.length + 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([
      decipher.update(body.subarray(MAGIC.length + 12, body.length - 16)),
      decipher.final(),
    ]);
    if (
      plain.length !== file.size ||
      !equal(createHash("sha256").update(plain).digest("hex"), file.sha256)
    )
      throw new Error();
    return plain;
  } catch {
    throw new SealedIntegrityError();
  }
}
export const DAY = 86400000;
export const PURGE_DAYS = 31;
export const FILE_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  gz: "application/gzip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const aadOf = (cid, fid) => `file:${cid}:${fid}`;
export const keyOf = (cid, fid) => `files/${cid}/${fid}`;
// Incremental sealer: update(chunk) with plaintext, then finish(vaultKey).
export function createSealer(cid, fid) {
  const aad = aadOf(cid, fid),
    dataKey = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(aad));
  const hash = createHash("sha256"),
    parts = [MAGIC, iv];
  return {
    update(chunk) {
      hash.update(chunk);
      parts.push(cipher.update(chunk));
    },
    // -> {object (the bytes for S3), sha256 (of the plaintext), dataKey (sealed box)}
    finish(vaultKey) {
      parts.push(cipher.final(), cipher.getAuthTag());
      return {
        object: Buffer.concat(parts),
        sha256: hash.digest("hex"),
        dataKey: encrypt(dataKey.toString("hex"), vaultKey, aad),
      };
    },
  };
}
// The record stored on customers.files.
export function fileEntry({
  fid,
  name,
  category,
  size,
  sealed,
  ext,
  s3Key,
  versionId,
  by,
  now,
}) {
  return {
    id: fid,
    name,
    category,
    size,
    sha256: sealed.sha256,
    contentType: Object.hasOwn(FILE_TYPES, ext)
      ? FILE_TYPES[ext]
      : "application/octet-stream",
    s3Key,
    versionId,
    dataKey: sealed.dataKey,
    uploadedBy: by.name,
    uploadedById: by._id,
    uploadedAt: now,
    deletedAt: null,
    deletedBy: null,
    restoredAt: null,
    purgedAt: null,
  };
}
// Inside a transaction: drops entries past restoring, then pushes `entry`
// unless the customer is at the cap (409) or gone (404).
export async function pushEntry(customers, session, cid, entry) {
  await customers.updateOne(
    { _id: cid },
    {
      $pull: {
        files: { deletedAt: { $lt: new Date(Date.now() - PURGE_DAYS * DAY) } },
      },
    },
    { session },
  );
  const result = await customers.updateOne(
    { _id: cid, [`files.${MAX_FILES - 1}`]: { $exists: false } },
    { $push: { files: entry } },
    { session },
  );
  if (result.matchedCount !== 1) {
    ensure(
      await customers.findOne(
        { _id: cid },
        { session, projection: { _id: 1 } },
      ),
      404,
      "Customer not found.",
    );
    ensure(false, 409, `A customer can hold at most ${MAX_FILES} files.`);
  }
}
