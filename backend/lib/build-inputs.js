// Build identity: which exact inputs a cached build was made from.
//   buildKey = HMAC-SHA256(kBuild, canonicalJSON(inputs))   (64 hex)
//   kBuild   = HMAC(VAULT_KEY bytes, "sandbee-build-key-v1")
// The key is keyed so S3 key names cannot confirm a guess about a client's
// values, and it never contains a value. Used by the app and the worker.
import { createHmac } from "node:crypto";
import { NEXT_PUBLIC_KEYS, isSha } from "../../shared/deploy.js";

export const BUILD_KEY_VERSION = 1;
// The fixed project settings sent to the builder (rev 1, S1).
export const BUILD_SETTINGS = Object.freeze({
  framework: "nextjs",
  rootDirectory: "apps/cafe",
  installCommand: null,
  buildCommand: null,
  outputDirectory: null,
  nodeVersion: "22.x",
  sourceFilesOutsideRootDirectory: true,
});
export const BUILDER_WORKFLOW = "build.yml";
const hmacBytes = (key, value) =>
  createHmac("sha256", key).update(value).digest();
const vaultBytes = (vaultKey) => {
  if (!/^[a-f0-9]{64}$/.test(vaultKey ?? ""))
    throw new Error("Invalid vault key.");
  return Buffer.from(vaultKey, "hex");
};
export const kBuildOf = (vaultKey) =>
  hmacBytes(vaultBytes(vaultKey), "sandbee-build-key-v1");
export const kManifestOf = (vaultKey) =>
  hmacBytes(vaultBytes(vaultKey), "sandbee-build-manifest-v1");
// Deterministic JSON: sorted keys, no undefined, integers only for numbers.
export function canonicalJSON(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Non-integer number.");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  throw new Error("Unsupported value.");
}
// Same derivation as pos.js nextPublic() (a parity test pins them together),
// plus the realtime URL: wss://<worker host>/join, "" when no worker is set.
export function nextPublicOf(pos) {
  const image = pos?.image ?? {};
  let realtime = "";
  try {
    const worker = new URL(pos?.cloudflare?.workerUrl ?? "");
    if (worker.protocol === "https:" && worker.host)
      realtime = `wss://${worker.host}/join`;
  } catch {
    realtime = "";
  }
  return {
    NEXT_PUBLIC_R2_PUBLIC_BASE_URL:
      image.store === "r2" ? (image.publicBaseUrl ?? "") : "",
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME:
      image.store === "cloudinary" ? (image.cloudName ?? "") : "",
    NEXT_PUBLIC_REALTIME_URL: realtime,
  };
}
const VALUE_RE =
  /^(?:|https:\/\/[^\s\u0000-\u001f]{1,490}|wss:\/\/[^\s\u0000-\u001f]{1,490}|[A-Za-z0-9_-]{1,64})$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const CLI_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-.][A-Za-z0-9.]{1,20})?$/;
// The builder's own descriptor (builder.json at a builder commit).
export function parseBuilderJson(raw) {
  const ok =
    raw &&
    typeof raw === "object" &&
    Number.isInteger(raw.protocol) &&
    raw.protocol > 0 &&
    VERSION_RE.test(raw.nodeVersion ?? "") &&
    CLI_RE.test(raw.cliVersion ?? "");
  if (!ok) throw new Error("Invalid builder descriptor.");
  return {
    protocol: raw.protocol,
    nodeVersion: raw.nodeVersion,
    cliVersion: raw.cliVersion,
  };
}
// inputs = {v, settings, env, builder}. `env` is exactly the three
// NEXT_PUBLIC_* keys for now (outcome A of rev 2 section 2.1). Errors name
// keys only, never values.
export function buildInputs({ pos, builderSha, builder }) {
  if (!isSha(builderSha)) throw new Error("Invalid builder commit.");
  const descriptor = parseBuilderJson(builder);
  const env = nextPublicOf(pos);
  for (const key of NEXT_PUBLIC_KEYS)
    if (typeof env[key] !== "string" || !VALUE_RE.test(env[key]))
      throw new Error(`Invalid build input: ${key}`);
  return {
    v: BUILD_KEY_VERSION,
    settings: { ...BUILD_SETTINGS },
    env: Object.fromEntries(NEXT_PUBLIC_KEYS.map((key) => [key, env[key]])),
    builder: {
      sha: builderSha,
      workflow: BUILDER_WORKFLOW,
      nodeVersion: descriptor.nodeVersion,
      cliVersion: descriptor.cliVersion,
    },
  };
}
export const buildKeyOf = (vaultKey, inputs) =>
  createHmac("sha256", kBuildOf(vaultKey))
    .update(canonicalJSON(inputs))
    .digest("hex");
// The manifest form of `env`: names, whether set, and a keyed 16-hex hash of
// the value (never the value).
export const envFingerprints = (vaultKey, env) =>
  NEXT_PUBLIC_KEYS.filter((name) => name in env).map((name) => ({
    name,
    set: env[name] !== "",
    hmac16: createHmac("sha256", kBuildOf(vaultKey))
      .update(`env\0${name}\0${env[name]}`)
      .digest("hex")
      .slice(0, 16),
  }));
