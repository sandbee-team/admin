// The per-cafe realtime Worker (P5 Stage 3, D46): names, the signed publish
// probe, verdicts, the bundle descriptor allowlist and the Cloudflare upload
// metadata. Ported from the local go-live tool (F:\lucifer\scripts\go-live
// realtime.mjs, cloudflare-api.mjs, cloudflare-validate.mjs) where it decides
// the same thing; the upload metadata replaces `wrangler deploy` (the admin
// container has no wrangler). No IO here.
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";
import { PUBLISH_SECRET_BYTES } from "./golive-env.js";

export { PUBLISH_SECRET_BYTES };
export const WORKER_NAME_PREFIX = "pos-realtime-";
export const WORKER_NAME_MAX_LEN = 63;
export const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
export const PUBLISH_SECRET_MIN_LEN = 16;
export const JOIN_PROBE_STATUS = 426;
export const PROBE_ATTEMPTS = 6;
export const PROBE_INTERVAL_MS = 2_000;
// Long enough to outlast secret/version propagation after an upload, well
// inside the Worker's ±300 s timestamp window.
export const PUBLISH_PROBE_ATTEMPTS = 10;
export const PUBLISH_PROBE_INTERVAL_MS = 3_000;
// 200, or 400 (the Worker judged the envelope): waiting will not change them.
export const PUBLISH_DEFINITIVE_STATUSES = Object.freeze([200, 400]);
export const SUBDOMAIN_CANDIDATE_ATTEMPTS = 3;
// Mirrors apps/cafe/lib/realtime-publish.ts and workers/realtime/src/index.ts.
export const REALTIME_SIG_HEADER = "x-realtime-signature";
export const REALTIME_TS_HEADER = "x-realtime-ts";
const PUBLISH_PROBE_KIND = "print-job";
export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const DESCRIPTOR_VERSION = 1;

const coded = (code) => Object.assign(new Error(code), { code });

// `pos-realtime-<slug>`; a name breaking the Worker name rule is refused.
export function workerNameOf(slug) {
  const name = `${WORKER_NAME_PREFIX}${slug}`;
  if (name.length > WORKER_NAME_MAX_LEN || !WORKER_NAME_RE.test(name))
    throw coded("realtime-name");
  return name;
}

// The first https://<name>.<sub>.workers.dev URL in `text`, trailing
// punctuation stripped, or null.
export function parseWorkerUrl(text) {
  const m = String(text ?? "").match(
    /https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i,
  );
  return m ? m[0].replace(/[.,;:)]+$/, "") : null;
}

// The exact signed request the cafe sends for one nudge (lowercase hex
// HMAC-SHA256 over `${tsSeconds}.${rawBody}`); "print-job" with no listeners
// is a safe no-op on a live cafe.
export function signedPublishRequest(secret, tenantId, nowMs) {
  const body = JSON.stringify({
    tenant: tenantId,
    kind: PUBLISH_PROBE_KIND,
    at: new Date(nowMs).toISOString(),
  });
  const ts = String(Math.floor(nowMs / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${ts}.${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      [REALTIME_TS_HEADER]: ts,
      [REALTIME_SIG_HEADER]: signature,
    },
  };
}

// The publish probe's final status -> "ok" or an error code. 403 = deployed
// for another TENANT_ID (a redeploy heals it), 401 = the secret drifted (a
// re-upload heals it), 400 = the probe envelope no longer matches the Worker
// (code drift, not setup).
export function publishVerdict(status) {
  if (status === 200) return "ok";
  if (status === 403) return "realtime-tenant-refused";
  if (status === 401) return "realtime-secret-mismatch";
  if (status === 400) return "realtime-envelope";
  return "realtime-probe-failed";
}

// Upload again only when something the Worker serves changed.
export function realtimeNeedsDeploy(prior, next) {
  return (
    !prior ||
    prior.workerName !== next.workerName ||
    prior.tenantId !== next.tenantId ||
    prior.bundleSha256 !== next.bundleSha256 ||
    prior.url !== next.url
  );
}

// The workers.dev subdomain to register on try `attempt` (1-based): pos-<slug>,
// then pos-<slug>-<4 hex>; null after SUBDOMAIN_CANDIDATE_ATTEMPTS.
export function subdomainCandidate(
  slug,
  attempt,
  randomBytes = nodeRandomBytes,
) {
  if (attempt === 1) return `pos-${slug}`;
  if (attempt > SUBDOMAIN_CANDIDATE_ATTEMPTS) return null;
  return `pos-${slug}-${randomBytes(2).toString("hex")}`;
}

// The Cloudflare inputs: null = realtime off. Returns the bad field names.
export function validateCloudflare(cf) {
  if (cf === undefined || cf === null) return [];
  if (typeof cf !== "object" || Array.isArray(cf)) return ["cloudflare"];
  const errors = [];
  const empty = (v) => v === undefined || v === null || v === "";
  if (
    typeof cf.token !== "string" ||
    cf.token.trim() === "" ||
    /<[^<>\s]+>/.test(cf.token)
  )
    errors.push("cloudflare.token");
  if (!empty(cf.accountId) && !ACCOUNT_ID_RE.test(String(cf.accountId)))
    errors.push("cloudflare.accountId");
  if (
    !empty(cf.publishSecret) &&
    !(
      typeof cf.publishSecret === "string" &&
      cf.publishSecret.length >= PUBLISH_SECRET_MIN_LEN
    )
  )
    errors.push("cloudflare.publishSecret");
  return errors;
}

const BINDING_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLASS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The builder's realtime.json, allowlisted (D46): one Durable Object binding,
// new_sqlite_classes migrations only (mandatory on the Workers Free plan) that
// create exactly that class, no compatibility flags, a bundle ≤ 1 MB. Returns
// a clean copy; anything else -> code realtime-descriptor.
export function parseRealtimeDescriptor(raw) {
  const fail = () => {
    throw coded("realtime-descriptor");
  };
  if (!isPlain(raw) || raw.v !== DESCRIPTOR_VERSION) fail();
  if (raw.main !== "index.js") fail();
  if (
    typeof raw.compatibilityDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.compatibilityDate)
  )
    fail();
  if (
    !Array.isArray(raw.compatibilityFlags) ||
    raw.compatibilityFlags.length !== 0
  )
    fail();
  const dos = raw.durableObjects;
  if (!Array.isArray(dos) || dos.length !== 1 || !isPlain(dos[0])) fail();
  const [binding] = dos;
  if (
    Object.keys(binding).sort().join() !== "className,name" ||
    !BINDING_RE.test(binding.name) ||
    !CLASS_RE.test(binding.className)
  )
    fail();
  const migrations = raw.migrations;
  if (
    !Array.isArray(migrations) ||
    migrations.length < 1 ||
    migrations.length > 16
  )
    fail();
  const tags = new Set();
  const created = [];
  for (const m of migrations) {
    if (
      !isPlain(m) ||
      Object.keys(m).sort().join() !== "newSqliteClasses,tag" ||
      !TAG_RE.test(m.tag) ||
      tags.has(m.tag) ||
      !Array.isArray(m.newSqliteClasses) ||
      !m.newSqliteClasses.every(
        (c) => typeof c === "string" && CLASS_RE.test(c),
      )
    )
      fail();
    tags.add(m.tag);
    created.push(...m.newSqliteClasses);
  }
  if (created.length !== 1 || created[0] !== binding.className) fail();
  if (
    typeof raw.bundleSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.bundleSha256)
  )
    fail();
  if (
    !Number.isSafeInteger(raw.bundleBytes) ||
    raw.bundleBytes < 1 ||
    raw.bundleBytes > MAX_BUNDLE_BYTES
  )
    fail();
  return {
    v: DESCRIPTOR_VERSION,
    main: "index.js",
    compatibilityDate: raw.compatibilityDate,
    compatibilityFlags: [],
    durableObjects: [{ name: binding.name, className: binding.className }],
    migrations: migrations.map((m) => ({
      tag: m.tag,
      newSqliteClasses: [...m.newSqliteClasses],
    })),
    bundleSha256: raw.bundleSha256,
    bundleBytes: raw.bundleBytes,
  };
}

// The `metadata` part of the Cloudflare script upload (PUT
// /accounts/{id}/workers/scripts/{name}, multipart): main module, date, the
// DO binding, TENANT_ID and the publish secret, and the migrations the script
// has not run yet (`migrationTag` = the script's current tag, null for a new
// script), as wrangler sends them.
export function uploadMetadataOf(
  descriptor,
  { tenantId, publishSecret, migrationTag },
) {
  const d = parseRealtimeDescriptor(descriptor);
  if (
    typeof tenantId !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenantId) ||
    typeof publishSecret !== "string" ||
    publishSecret.length < PUBLISH_SECRET_MIN_LEN
  )
    throw coded("inputs-missing");
  const tags = d.migrations.map((m) => m.tag);
  let pending = d.migrations;
  if (migrationTag !== null && migrationTag !== undefined) {
    const at = tags.indexOf(migrationTag);
    if (at < 0) throw coded("realtime-descriptor");
    pending = d.migrations.slice(at + 1);
  }
  const [binding] = d.durableObjects;
  const metadata = {
    main_module: d.main,
    compatibility_date: d.compatibilityDate,
    bindings: [
      {
        type: "durable_object_namespace",
        name: binding.name,
        class_name: binding.className,
      },
      { type: "plain_text", name: "TENANT_ID", text: tenantId },
      {
        type: "secret_text",
        name: "REALTIME_PUBLISH_SECRET",
        text: publishSecret,
      },
    ],
  };
  if (pending.length > 0)
    metadata.migrations = {
      ...(migrationTag ? { old_tag: migrationTag } : {}),
      new_tag: tags[tags.length - 1],
      steps: pending.map((m) => ({ new_sqlite_classes: m.newSqliteClasses })),
    };
  return metadata;
}
