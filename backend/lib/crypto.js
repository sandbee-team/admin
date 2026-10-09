import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const mac = (key, value) =>
  createHmac("sha256", key).update(value).digest("hex");
// Non-secret identifier of a 32-byte hex key: an HMAC of a fixed label keyed by
// the key itself, so it reveals nothing usable and is never a slice of the key.
export const keyFingerprint = (hex) =>
  mac(Buffer.from(hex, "hex"), "sandbee-admin-key-fingerprint-v1")
    .slice(0, 16)
    .match(/.{4}/g)
    .join("-");
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(value) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(value, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(value, stored) {
  const [salt, expected] = (
    stored || `${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  const hash = await scrypt(value, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return equal(hash.toString("hex"), expected);
}
export function encrypt(value, key, context) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}
export function decrypt(box, key, context) {
  if (box.version !== 1) throw new Error("Unsupported encrypted data version.");
  // A short GCM tag is easier to forge: only full 16-byte tags are accepted.
  const tag = Buffer.from(box.tag, "base64");
  if (tag.length !== 16) throw new Error("Invalid authentication tag.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(box.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
