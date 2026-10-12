// A POS client's web address `<label>.sandbee.in` (P5 Stage 3, D44): label
// rules, the DNS records the owner enters at GoDaddy and the address state.
// Ported from the local go-live tool (F:\lucifer\scripts\go-live lib.mjs
// webAddressRecords, web-address.mjs recommendedCnameOf/stateOf, dns-check.mjs
// VERCEL_CNAME_RE, ui/pure.mjs subdomainFromInput); tools/p5-parity.mjs
// compares both. Shared by the API, the worker and the UI: no Node imports.

export const PLATFORM_APEX = "sandbee.in";
// Refused labels (D44): the platform's own names (P4 §7) and the names other
// code or docs reserve. "@", "_dmarc" and "_domainconnect" can never pass the
// label shape either; they are listed so the list stays the record.
export const PLATFORM_LABELS = Object.freeze([
  "@",
  "www",
  "admin",
  "store",
  "gstapi",
  "ocrapi",
  "_dmarc",
  "_domainconnect",
  "app",
  "api",
  "hub",
  "ecom",
  "ocr",
  "pos",
  "notify",
  "whatsapp",
  "wa",
  "waadmin",
]);
// One DNS label: lowercase letters, digits, inner hyphens, 1-63 chars.
export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Vercel's CNAME targets: cname.vercel-dns.com or a project-specific
// xxxx.vercel-dns-017.com.
export const VERCEL_CNAME_RE = /(^|\.)vercel-dns(-\d+)?\.com$/i;
export const VERCEL_CNAME_TARGET = "cname.vercel-dns.com";
export const MAX_ADDRESS_RECORDS = 4;
export const ADDRESS_STATES = Object.freeze([
  "ready",
  "check-failed",
  "pending-verify",
  "pending-dns",
  "tenant-mismatch",
  "pending-cert",
]);

// null when the label can be used, else "label-invalid" | "label-reserved".
// Whether another installation or a DNS record already holds it is checked by
// the API (unique index) and the worker (authoritative lookup).
export function labelProblem(label) {
  if (typeof label !== "string" || !SUBDOMAIN_RE.test(label))
    return "label-invalid";
  return PLATFORM_LABELS.includes(label) ? "label-reserved" : null;
}

// What the owner typed (a bare label, a full host or a pasted URL) as a label.
// Empty -> {label: null, problem: null}.
export function labelFromInput(raw, apex = PLATFORM_APEX) {
  let value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (value === "") return { label: null, problem: null };
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const suffix = `.${String(apex).toLowerCase()}`;
  if (value.endsWith(suffix)) value = value.slice(0, -suffix.length);
  if (value.includes(".")) return { label: null, problem: "label-not-single" };
  const problem = labelProblem(value);
  return problem ? { label: null, problem } : { label: value, problem: null };
}

export const hostOf = (label, apex = PLATFORM_APEX) => `${label}.${apex}`;

// The CNAME/TXT rows the owner adds at the DNS provider. `name` is RELATIVE to
// the apex ("@" for the apex itself). At most MAX_ADDRESS_RECORDS rows.
export function webAddressRecords({
  subdomain,
  apex,
  recommendedCname,
  verification,
}) {
  const records = [{ type: "CNAME", name: subdomain, value: recommendedCname }];
  const suffix = `.${apex}`;
  for (const v of Array.isArray(verification) ? verification : []) {
    if (!v || v.type !== "TXT") continue;
    const name =
      v.domain === apex
        ? "@"
        : v.domain && v.domain.toLowerCase().endsWith(suffix)
          ? v.domain.slice(0, -suffix.length)
          : v.domain;
    records.push({ type: "TXT", name, value: v.value });
  }
  return records.slice(0, MAX_ADDRESS_RECORDS);
}

// Vercel's recommended CNAME target: the lowest-ranked `recommendedCNAME`
// entry without trailing dots, else the documented fallback. A value that is
// not a Vercel DNS name is never shown to the owner.
export function recommendedCnameOf(config) {
  const list = Array.isArray(config?.recommendedCNAME)
    ? config.recommendedCNAME
    : [];
  if (list.length === 0) return VERCEL_CNAME_TARGET;
  const sorted = [...list].sort((a, b) => (a?.rank ?? 0) - (b?.rank ?? 0));
  const value =
    typeof sorted[0]?.value === "string"
      ? sorted[0].value.replace(/\.+$/, "")
      : "";
  return value.length <= 253 && VERCEL_CNAME_RE.test(value)
    ? value
    : VERCEL_CNAME_TARGET;
}

// Readiness of the address. Vercel's own verdict (`configured` =
// misconfigured:false; null = the config call did not answer), the verified
// flag and our HTTPS probe decide; `answeredAs` = the tenant a foreign
// deployment answered as.
export function addressStateOf({
  verified,
  configured,
  reachable,
  hasTxtRow,
  answeredAs,
}) {
  if (verified && configured === true && reachable) return "ready";
  if (configured === null) return "check-failed";
  if (hasTxtRow && !verified) return "pending-verify";
  if (configured !== true) return "pending-dns";
  if (answeredAs) return "tenant-mismatch";
  return "pending-cert";
}
