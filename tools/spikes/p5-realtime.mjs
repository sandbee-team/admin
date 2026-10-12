// Spike S2 (P5 Stage 3, docs/P5-STAGE3-PLAN.md §12, D46) — dev PC only,
// against the owner's THROWAWAY Cloudflare account. Not part of `npm test`.
//
//   node tools/spikes/p5-realtime.mjs <bundle-dir>
//
// <bundle-dir> holds index.js + realtime.json as pos-builder's realtime.yml
// produces them (or the same two files bundled locally with the pinned
// wrangler). Uploads Worker `pos-realtime-p5spike` over the Cloudflare REST
// API exactly as admin will (descriptor allowlist, uploadMetadataOf,
// multipart), enables workers.dev and probes 426 + a signed publish.
// Token: env SPIKE_CF_TOKEN only (never argv, never printed); optional
// SPIKE_CF_ACCOUNT_ID when the token sees several accounts. Output: status
// codes, Cloudflare error codes, field names and booleans. Nothing is deleted.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  JOIN_PROBE_STATUS,
  PUBLISH_DEFINITIVE_STATUSES,
  PUBLISH_PROBE_ATTEMPTS,
  PUBLISH_PROBE_INTERVAL_MS,
  SUBDOMAIN_CANDIDATE_ATTEMPTS,
  parseRealtimeDescriptor,
  publishVerdict,
  signedPublishRequest,
  subdomainCandidate,
  uploadMetadataOf,
  workerNameOf,
} from "../../backend/lib/realtime.js";

const SLUG = "p5spike";
const TENANT = "p5spike";
const BASE = "https://api.cloudflare.com/client/v4";
const token = process.env.SPIKE_CF_TOKEN;
if (!token) {
  console.log("SPIKE_CF_TOKEN is not set in this process — nothing done.");
  process.exit(2);
}
const dir = process.argv[2];
if (!dir) {
  console.log("usage: node tools/spikes/p5-realtime.mjs <bundle-dir>");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (step, facts) =>
  console.log(`${step}: ${Object.entries(facts).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : v}`).join(" ")}`);
const fieldsOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);
const cfCodes = (r) => (Array.isArray(r.json?.errors) ? r.json.errors.map((e) => e?.code ?? "?") : []);
async function api(method, p, { json, form } = {}) {
  try {
    const res = await fetch(`${BASE}${p}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : form ? { body: form } : {}),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, json: null, error: error?.cause?.code ?? error?.name ?? "error" };
  }
}

// 1. The bundle: allowlisted descriptor, digest and size checked.
const bundle = readFileSync(path.join(dir, "index.js"));
const descriptor = parseRealtimeDescriptor(JSON.parse(readFileSync(path.join(dir, "realtime.json"), "utf8")));
const sha = createHash("sha256").update(bundle).digest("hex");
line("bundle", { bytes: bundle.length, digestMatches: sha === descriptor.bundleSha256, sizeMatches: bundle.length === descriptor.bundleBytes, binding: descriptor.durableObjects[0].name, migrations: descriptor.migrations.map((m) => m.tag), date: descriptor.compatibilityDate });
if (sha !== descriptor.bundleSha256 || bundle.length !== descriptor.bundleBytes) process.exit(1);

// 2. Token, account, workers.dev subdomain.
const verify = await api("GET", "/user/tokens/verify");
line("token-verify (user token)", { status: verify.status, tokenStatus: verify.json?.result?.status ?? "-", codes: cfCodes(verify) });
const accounts = await api("GET", "/accounts");
const list = Array.isArray(accounts.json?.result) ? accounts.json.result : [];
line("accounts", { status: accounts.status, count: list.length, codes: cfCodes(accounts) });
const accountId = process.env.SPIKE_CF_ACCOUNT_ID || (list.length === 1 ? list[0].id : null);
if (!accountId) {
  line("stop", { reason: list.length ? "cf-account-ambiguous (set SPIKE_CF_ACCOUNT_ID)" : "no-account" });
  process.exit(1);
}
const acct = `/accounts/${accountId}`;
let sub = await api("GET", `${acct}/workers/subdomain`);
line("workers-subdomain-get", { status: sub.status, present: Boolean(sub.json?.result?.subdomain), codes: cfCodes(sub) });
let subdomain = sub.json?.result?.subdomain ?? null;
for (let attempt = 1; !subdomain && attempt <= SUBDOMAIN_CANDIDATE_ATTEMPTS; attempt++) {
  const put = await api("PUT", `${acct}/workers/subdomain`, { json: { subdomain: subdomainCandidate(SLUG, attempt) } });
  line(`workers-subdomain-put try ${attempt}`, { status: put.status, codes: cfCodes(put) });
  if (put.status < 300) subdomain = put.json?.result?.subdomain ?? subdomainCandidate(SLUG, attempt);
}
if (!subdomain) process.exit(1);

// 3. Upload (REST multipart, as admin will), twice: new script, then current.
const name = workerNameOf(SLUG);
const publishSecret = randomBytes(32).toString("hex");
async function migrationTag() {
  const svc = await api("GET", `${acct}/workers/services/${name}`);
  const tag = svc.json?.result?.default_environment?.script?.migration_tag ?? null;
  const scripts = await api("GET", `${acct}/workers/scripts`);
  const row = (scripts.json?.result ?? []).find((s) => s?.id === name);
  line("migration-tag", { servicesStatus: svc.status, fromService: tag ?? "null", scriptsListStatus: scripts.status, fromScriptsList: row?.migration_tag ?? "null" });
  return tag ?? row?.migration_tag ?? null;
}
async function upload(step, tag) {
  const metadata = uploadMetadataOf(descriptor, { tenantId: TENANT, publishSecret, migrationTag: tag });
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("index.js", new Blob([bundle], { type: "application/javascript+module" }), "index.js");
  const r = await api("PUT", `${acct}/workers/scripts/${name}`, { form });
  line(step, { status: r.status, success: r.json?.success ?? "-", codes: cfCodes(r), sentMigrations: "migrations" in metadata, resultFields: fieldsOf(r.json?.result) });
  return r;
}
const first = await upload("upload-1", await migrationTag());
if (first.status >= 300) process.exit(1);
await upload("upload-2 (current tag read back)", await migrationTag());
await upload("upload-3 (migrations re-sent on purpose; expect a refusal code)", null);
const settings = await api("GET", `${acct}/workers/scripts/${name}/settings`);
line("script-settings", { status: settings.status, bindings: (settings.json?.result?.bindings ?? []).map((b) => `${b?.name}:${b?.type}`), compatibilityDate: settings.json?.result?.compatibility_date ?? "-" });

// 4. workers.dev on, then the probes.
const enable = await api("POST", `${acct}/workers/scripts/${name}/subdomain`, { json: { enabled: true, previews_enabled: false } });
line("workers-dev-enable", { status: enable.status, codes: cfCodes(enable) });
const url = `https://${name}.${subdomain}.workers.dev`;
let join = null;
for (let i = 1; i <= 30 && join !== JOIN_PROBE_STATUS; i++) {
  join = await fetch(`${url}/join`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, (e) => e?.cause?.code ?? "error");
  if (join !== JOIN_PROBE_STATUS) await sleep(5_000);
  if (i === 30 || join === JOIN_PROBE_STATUS) line("probe-join", { status: join, tries: i, expected: JOIN_PROBE_STATUS });
}
let publish = null;
for (let i = 1; i <= PUBLISH_PROBE_ATTEMPTS; i++) {
  const { body, headers } = signedPublishRequest(publishSecret, TENANT, Date.now());
  publish = await fetch(`${url}/publish`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => null);
  if (PUBLISH_DEFINITIVE_STATUSES.includes(publish)) {
    line("probe-publish", { status: publish, tries: i, verdict: publishVerdict(publish) });
    break;
  }
  if (i === PUBLISH_PROBE_ATTEMPTS) line("probe-publish", { status: publish ?? "none", tries: i, verdict: publishVerdict(publish) });
  else await sleep(PUBLISH_PROBE_INTERVAL_MS);
}
{
  const { body, headers } = signedPublishRequest(publishSecret, "someone-else", Date.now());
  const other = await fetch(`${url}/publish`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => null);
  line("probe-publish other tenant", { status: other, verdict: publishVerdict(other) });
}
