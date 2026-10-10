// Sealing and registration of customer files (SBF1), shared by the upload
// route (modules/files.js) and the client-database backup task. A file object in
// S3 is: SBF1 | iv(12) | AES-256-GCM ciphertext | tag(16), a random data key per
// file, GCM AAD `file:<customerId>:<fileId>`, the data key sealed with
// VAULT_KEY in the customer record. Behaviour is exactly what files.js had.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { encrypt } from "./crypto.js";
import { ensure } from "./errors.js";
import { MAX_FILES } from "../../shared/schemas.js";

export const MAGIC = Buffer.from("SBF1");
export const OVERHEAD = MAGIC.length + 12 + 16; // magic + iv + GCM tag
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
