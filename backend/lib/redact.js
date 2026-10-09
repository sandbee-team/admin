// Scrubs secrets from text before it can be stored or shown (for example the
// last line of a CLI's stderr). Known secret strings go first (also in their
// URL-encoded and JSON-escaped forms), then well-known token shapes, then any
// long opaque run. The result has no control characters and is capped.
const MARK = "[redacted]";
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /mongodb(?:\+srv)?:\/\/\S+/gi,
  /\bBearer\s+\S+/gi,
  /\bgithub_pat_[A-Za-z0-9_]+/g,
  /\bgh[pousr]_[A-Za-z0-9]+/g,
  /\bvcp_[A-Za-z0-9]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /[A-Za-z0-9+/_=-]{32,}/g,
];
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function redact(text, knownSecrets = [], max = 160) {
  let out = String(text ?? "");
  const variants = new Set();
  for (const secret of knownSecrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(JSON.stringify(secret).slice(1, -1));
    variants.add(Buffer.from(secret).toString("base64"));
  }
  for (const value of [...variants].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(escapeRe(value), "g"), MARK);
  for (const pattern of PATTERNS) out = out.replace(pattern, MARK);
  return out
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
