// The runtime env a go-live writes into the client's Vercel project (P5 Stage 3,
// D43): an EXACT port of the local go-live tool's buildEnv/mintSecrets
// (F:\lucifer\scripts\go-live lib.mjs:337-392) and realtimeEnvOf/realtimeOffEnv
// (realtime.mjs:72-92), plus admin's side: mapping the POS setup + vault values
// to the go-live client shape, keyed fingerprints and drift. tools/p5-parity.mjs
// compares both buildEnvs. No IO here.
import { createHmac, randomBytes as nodeRandomBytes } from "node:crypto";

export const ENV_TARGETS = Object.freeze(["production", "preview"]);
export const AUTH_SECRET_BYTES = 32;
export const HEALTH_TOKEN_BYTES = 32;
export const PUBLISH_SECRET_BYTES = 32;
export const REALTIME_ENV_KEYS = Object.freeze([
  "REALTIME_PUBLISH_URL",
  "REALTIME_PUBLISH_SECRET",
  "NEXT_PUBLIC_REALTIME_URL",
]);
const BASE_ENV_KEYS = Object.freeze([
  "MONGODB_URI",
  "CORE_MONGODB_URI",
  "NEXTAUTH_SECRET",
  "AUTH_SECRET",
  "HEALTH_STATS_TOKEN",
  "HOSTING_TIER",
  "ROOT_DOMAIN",
  "TENANT_ID",
  "IMAGE_STORE",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
]);
// Every key a go-live writes, in buildEnv's order.
export const GOLIVE_ENV_KEYS = Object.freeze([
  ...BASE_ENV_KEYS,
  ...REALTIME_ENV_KEYS,
]);
export const MAX_ENV_KEYS = 30;

const ENC = "encrypted";
const PLAIN = "plain";
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const env = (key, value, type) => ({
  key,
  value,
  type,
  target: [...ENV_TARGETS],
});

// The runtime env for one cafe. `client` = {mongodbUri, image} in the go-live
// client shape (envClientOf), `tenant` = {tenantId, rootDomain}, `generated` =
// {authSecret, healthStatsToken}. Every image-store key is written on every
// run, the unselected store's as "" (upsert cannot delete). `realtimeEnv`: []
// leaves REALTIME_* untouched, realtimeOffEnv() blanks them, realtimeEnvOf()
// sets them. NEXTAUTH_URL/AUTH_URL are never set (trustHost).
export function buildEnv(client, tenant, generated, realtimeEnv = []) {
  const out = [
    env("MONGODB_URI", client.mongodbUri, ENC),
    env("CORE_MONGODB_URI", client.mongodbUri, ENC),
    env("NEXTAUTH_SECRET", generated.authSecret, ENC),
    env("AUTH_SECRET", generated.authSecret, ENC),
    env("HEALTH_STATS_TOKEN", generated.healthStatsToken, ENC),
    env("HOSTING_TIER", "B", PLAIN),
    env("ROOT_DOMAIN", tenant.rootDomain, PLAIN),
  ];
  if (tenant.tenantId) out.push(env("TENANT_ID", tenant.tenantId, PLAIN));
  const img = client.image;
  const r2 = img && img.store === "r2" ? img : {};
  const cl = img && img.store === "cloudinary" ? img : {};
  out.push(
    env(
      "IMAGE_STORE",
      img && img.store === "cloudinary" ? "cloudinary" : "r2",
      PLAIN,
    ),
    env("R2_ACCOUNT_ID", r2.accountId ?? "", ENC),
    env("R2_ACCESS_KEY_ID", r2.accessKeyId ?? "", ENC),
    env("R2_SECRET_ACCESS_KEY", r2.secretAccessKey ?? "", ENC),
    env("R2_BUCKET", r2.bucket ?? "", PLAIN),
    env("NEXT_PUBLIC_R2_PUBLIC_BASE_URL", r2.publicBaseUrl ?? "", PLAIN),
    env("CLOUDINARY_CLOUD_NAME", cl.cloudName ?? "", PLAIN),
    env("CLOUDINARY_API_KEY", cl.apiKey ?? "", ENC),
    env("CLOUDINARY_API_SECRET", cl.apiSecret ?? "", ENC),
    env("NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", cl.cloudName ?? "", PLAIN),
  );
  out.push(...realtimeEnv);
  return out;
}

// The three REALTIME_* entries when the Worker is on.
export function realtimeEnvOf({ url, secret }) {
  const host = url.replace(/^https:\/\//, "");
  return [
    env(REALTIME_ENV_KEYS[0], `${url}/publish`, ENC),
    env(REALTIME_ENV_KEYS[1], secret, ENC),
    env(REALTIME_ENV_KEYS[2], `wss://${host}/join`, PLAIN),
  ];
}

// The three REALTIME_* keys as "" (realtime off).
export const realtimeOffEnv = () =>
  REALTIME_ENV_KEYS.map((k) =>
    env(k, "", k === REALTIME_ENV_KEYS[2] ? PLAIN : ENC),
  );

const inputsMissing = () =>
  Object.assign(new Error("inputs-missing"), { code: "inputs-missing" });

// Admin's POS setup (`pos.image`) + vault values (the Mongo URI and the
// `image.keys` box, a JSON string or object) -> the go-live client shape
// buildEnv reads. A selected store without all its values is refused: blanks
// would silently switch image uploads off.
export function envClientOf(pos, { mongoUri, imageKeys } = {}) {
  if (!isStr(mongoUri)) throw inputsMissing();
  const image = pos?.image ?? {};
  if (!image.store) return { mongodbUri: mongoUri, image: null };
  let keys = imageKeys;
  if (typeof keys === "string") {
    try {
      keys = JSON.parse(keys);
    } catch {
      throw inputsMissing();
    }
  }
  const has = (o, names) => names.every((n) => isStr(o?.[n]));
  if (image.store === "r2") {
    if (
      !has(keys, ["accessKeyId", "secretAccessKey"]) ||
      !has(image, ["r2AccountId", "bucket", "publicBaseUrl"])
    )
      throw inputsMissing();
    return {
      mongodbUri: mongoUri,
      image: {
        store: "r2",
        accountId: image.r2AccountId,
        accessKeyId: keys.accessKeyId,
        secretAccessKey: keys.secretAccessKey,
        bucket: image.bucket,
        publicBaseUrl: image.publicBaseUrl,
      },
    };
  }
  if (image.store === "cloudinary") {
    if (!has(keys, ["apiKey", "apiSecret"]) || !has(image, ["cloudName"]))
      throw inputsMissing();
    return {
      mongodbUri: mongoUri,
      image: {
        store: "cloudinary",
        cloudName: image.cloudName,
        apiKey: keys.apiKey,
        apiSecret: keys.apiSecret,
      },
    };
  }
  throw inputsMissing();
}

// Keep already-minted secrets (re-minting logs every device out and breaks
// the stats token and the Worker); mint only what is missing. Same formats as
// the go-live tool: auth secret base64, stats token and publish secret hex.
export function mintSecrets(generated, randomBytes = nodeRandomBytes) {
  const g = { ...(generated || {}) };
  if (!isStr(g.authSecret))
    g.authSecret = randomBytes(AUTH_SECRET_BYTES).toString("base64");
  if (!isStr(g.healthStatsToken))
    g.healthStatsToken = randomBytes(HEALTH_TOKEN_BYTES).toString("hex");
  if (!isStr(g.realtimePublishSecret))
    g.realtimePublishSecret = randomBytes(PUBLISH_SECRET_BYTES).toString("hex");
  return g;
}

// A POS admin password that passes the POS seeder's rule (8+ chars, a digit,
// a symbol): 144 random bits in three groups plus one random digit.
export function mintPosAdminPassword(randomBytes = nodeRandomBytes) {
  const core = randomBytes(18).toString("base64url");
  const digit = randomBytes(1)[0] % 10;
  return `${core.slice(0, 8)}-${core.slice(8, 16)}-${core.slice(16)}${digit}`;
}

// Fingerprint of one env value: HMAC under kEnv = HMAC(VAULT_KEY bytes,
// "sandbee-env-fp-v1") over [key, value], first 16 hex. Keyed, so a stored
// fingerprint cannot confirm a guessed value without the vault key.
export function envFp(vaultKey, key, value) {
  if (!/^[a-f0-9]{64}$/.test(vaultKey ?? ""))
    throw new Error("Invalid vault key.");
  const kEnv = createHmac("sha256", Buffer.from(vaultKey, "hex"))
    .update("sandbee-env-fp-v1")
    .digest();
  return createHmac("sha256", kEnv)
    .update(JSON.stringify([key, value]))
    .digest("hex")
    .slice(0, 16);
}

// Vercel lists one row per key, or one per key and environment: read together.
function metaByKey(meta) {
  const out = new Map();
  for (const row of Array.isArray(meta) ? meta : []) {
    if (!row || typeof row.key !== "string") continue;
    const seen = out.get(row.key) ?? {
      types: new Set(),
      targets: new Set(),
      updatedAt: null,
      fp16: null,
    };
    seen.types.add(row.type);
    for (const t of Array.isArray(row.target) ? row.target : [row.target])
      if (typeof t === "string") seen.targets.add(t);
    if (Number.isFinite(row.updatedAt))
      seen.updatedAt = Math.max(seen.updatedAt ?? 0, row.updatedAt);
    if (typeof row.fp16 === "string") seen.fp16 = row.fp16;
    out.set(row.key, seen);
  }
  return out;
}

// What admin stores after a write (pos.golive.env.keys): per key name, type,
// targets, set, fp16 and Vercel's updatedAt read right after the write.
export function envFingerprints(vaultKey, envs, meta = []) {
  const byKey = metaByKey(meta);
  return envs.slice(0, MAX_ENV_KEYS).map((e) => ({
    name: e.key,
    type: e.type,
    targets: [...e.target],
    set: e.value !== "",
    fp16: envFp(vaultKey, e.key, e.value),
    updatedAt: byKey.get(e.key)?.updatedAt ?? null,
  }));
}

// Drift between what admin wrote and Vercel's metadata now. `meta` rows:
// {key, type, target, updatedAt, fp16?}; fp16 only for plain values (the
// adapter fingerprints them in memory; encrypted values are never read).
// One reason per key, first match: missing, type, targets, value, edited.
export function envDrift(stored, meta) {
  const byKey = metaByKey(meta);
  const out = [];
  for (const k of Array.isArray(stored) ? stored : []) {
    const m = byKey.get(k.name);
    let reason = null;
    if (!m) reason = "missing";
    else if (m.types.size !== 1 || !m.types.has(k.type)) reason = "type";
    else if (
      m.targets.size !== k.targets.length ||
      !k.targets.every((t) => m.targets.has(t))
    )
      reason = "targets";
    else if (k.type === PLAIN && m.fp16 !== null && m.fp16 !== k.fp16)
      reason = "value";
    else if (
      Number.isFinite(k.updatedAt) &&
      m.updatedAt !== null &&
      m.updatedAt > k.updatedAt
    )
      reason = "edited";
    if (reason) out.push({ name: k.name, reason });
    if (out.length === MAX_ENV_KEYS) break;
  }
  return out;
}

// Names-only parity for clients whose env admin did not write (Verify
// warning env-keys-missing): the go-live keys absent from `names`.
export function missingEnvKeys(names, { realtime = false } = {}) {
  const have = new Set(Array.isArray(names) ? names : []);
  const want = realtime ? GOLIVE_ENV_KEYS : BASE_ENV_KEYS;
  return want.filter((k) => !have.has(k));
}
