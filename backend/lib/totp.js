import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
// RFC 6238 TOTP (HOTP, RFC 4226, over a time counter) with node:crypto only.
// verify() returns the matched time step so callers can enforce a replay guard.
// Nothing here logs or echoes keys or codes, and errors never contain input.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = { sha1: "sha1", sha256: "sha256", sha512: "sha512" };
const DEFAULTS = { algorithm: "sha1", digits: 6, period: 30 };
export function base32Encode(buffer) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("Invalid base32 key.");
  let bits = 0,
    value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}
export const generateKey = () => randomBytes(20);
function options(input = {}) {
  const o = { ...DEFAULTS, ...input };
  if (!Object.hasOwn(ALGORITHMS, o.algorithm))
    throw new Error("Unsupported algorithm.");
  if (![6, 8].includes(o.digits)) throw new Error("Unsupported digits.");
  if (![30, 60].includes(o.period)) throw new Error("Unsupported period.");
  return o;
}
export const stepAt = (nowMs, period = DEFAULTS.period) =>
  Math.floor(nowMs / 1000 / period);
export function codeAt(key, step, input) {
  const { algorithm, digits } = options(input);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac(algorithm, key).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  const binary =
    ((hash[offset] & 127) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}
// Returns the matched step (within +/- window steps of now) or null.
export function verify(key, code, nowMs, input) {
  const o = options(input),
    window = input?.window ?? 1;
  const submitted = String(code ?? "").trim();
  if (submitted.length !== o.digits || !/^[0-9]+$/.test(submitted)) return null;
  const center = stepAt(nowMs, o.period),
    wanted = Buffer.from(submitted);
  let matched = null;
  // Every candidate is compared so timing does not reveal which step was close.
  for (let offset = -window; offset <= window; offset++) {
    const step = center + offset;
    if (step < 0) continue;
    const expected = Buffer.from(codeAt(key, step, o));
    if (timingSafeEqual(expected, wanted) && matched === null) matched = step;
  }
  return matched;
}
export function otpauthUri(key, account, issuer) {
  const params = new URLSearchParams({
    secret: base32Encode(key),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${params}`;
}
// Accepts a bare base32 key or an otpauth://totp URI; returns {key, params}.
export function parseKeyInput(text) {
  const input = String(text ?? "").trim();
  let secret = input,
    params = { ...DEFAULTS };
  if (/^otpauth:/i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Invalid authenticator URI.");
    }
    if (url.protocol !== "otpauth:" || url.hostname !== "totp")
      throw new Error("Only time-based authenticator URIs are supported.");
    const q = url.searchParams;
    secret = q.get("secret") || "";
    params = options({
      algorithm: (q.get("algorithm") || "sha1").toLowerCase(),
      digits: Number(q.get("digits") || 6),
      period: Number(q.get("period") || 30),
    });
  }
  const key = base32Decode(secret);
  if (key.length < 10 || key.length > 64)
    throw new Error("Invalid authenticator key length.");
  return { key, params };
}
