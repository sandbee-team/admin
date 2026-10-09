import { HttpError } from "./errors.js";
import { mac } from "./crypto.js";
import {
  importClientSchema,
  importProfileSchema,
  posConfigSchema,
  posSecretValue,
  POS_SECRET_FIELDS,
} from "../../shared/schemas.js";

// Pure: turns a go-live client file (+ one deploy-profile entry) into the POS
// block, the secrets to encrypt, the account entries and the lists the preview
// shows. Nothing here reads the database; no message ever echoes a value.

const PLACEHOLDER_RE = /<[^<>\s]+>/;
const has = (v) => typeof v === "string" && v.trim() !== "";
const str = (v) => (has(v) ? v.trim() : "");
const fail = (message) => {
  throw new HttpError(400, message);
};
const formatIssues = (issues, prefix = "") =>
  issues
    .map((i) => `${prefix}${i.path.join(".") || "Input"}: ${i.message}`)
    .join("; ");

// Stable text for hashing: object keys sorted recursively.
export function canonicalJson(value) {
  const walk = (v) =>
    Array.isArray(v)
      ? v.map(walk)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, walk(v[k])]),
          )
        : v;
  return JSON.stringify(walk(value));
}
export const importDigest = (authSecret, client, profile) =>
  mac(
    authSecret,
    `pos-import-v1:${canonicalJson({ client, profile: profile ?? null })}`,
  );

// "mongodb+srv://user:pw@host/db?x" -> {host, database}; credentials dropped.
export function mongoTarget(uri) {
  const unparsed = { host: "(unparsed)", database: "" };
  const m = /^mongodb(?:\+srv)?:\/\/([^/]*)(?:\/([^?]*))?/.exec(uri ?? "");
  if (!m) return unparsed;
  // The userinfo is everything before the LAST "@" of the authority; it is
  // never returned. A "@" in the path means an unescaped "/" in the password.
  const authority = m[1],
    database = m[2] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (
    database.includes("@") ||
    !/^[A-Za-z0-9.\-_:,[\]]+$/.test(host) ||
    !/^[^/\s]+$/.test(database)
  )
    return unparsed;
  return { host, database };
}

// Paths the mapping consumes. Everything else that holds a value is "dropped".
const MAPPED = new Set([
  "slug",
  "subdomain",
  "vercel.token",
  "vercel.project",
  "vercel.teamId",
  "mongodbUri",
  "admin.username",
  "admin.password",
  "cafe.name",
  "image.store",
  "image.accountId",
  "image.accessKeyId",
  "image.secretAccessKey",
  "image.bucket",
  "image.publicBaseUrl",
  "image.cloudName",
  "image.apiKey",
  "image.apiSecret",
  "contact.ownerName",
  "contact.phone",
  "accounts.vercel.email",
  "accounts.vercel.password",
  "accounts.atlas.email",
  "accounts.atlas.password",
  "accounts.images.email",
  "accounts.images.password",
  "accounts.other",
  "deployLock",
  "cloudflare.token",
  "cloudflare.accountId",
  "cloudflare.publishSecret",
  "generated.host",
  "generated.tenantId",
  "generated.rootDomain",
  "generated.projectId",
  "generated.projectName",
  "generated.orgId",
  "generated.authSecret",
  "generated.healthStatsToken",
  "generated.realtime.workerName",
  "generated.realtime.url",
  "generated.realtime.publishSecret",
]);
const empty = (v) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
function collectDropped(value, prefix, out) {
  for (const [key, inner] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (MAPPED.has(path)) continue;
    const partial = [...MAPPED].some((m) => m.startsWith(`${path}.`));
    if (partial && inner && typeof inner === "object" && !Array.isArray(inner))
      collectDropped(inner, path, out);
    else if (!empty(inner)) out.push(path);
  }
}

export function parseImport(input) {
  const client = importClientSchema.safeParse(input.client);
  if (!client.success)
    fail(`Client file: ${formatIssues(client.error.issues)}`);
  let profile = null;
  if (input.profile) {
    const parsed = importProfileSchema.safeParse(input.profile);
    if (!parsed.success) fail(`Profile: ${formatIssues(parsed.error.issues)}`);
    profile = parsed.data;
  }
  const c = client.data,
    g = c.generated ?? {},
    rt = g.realtime ?? {},
    cf = c.cloudflare ?? null,
    img = c.image ?? null,
    entry = profile?.entry ?? {};
  // A forgotten <placeholder> would otherwise look like a real value.
  const placeholders = [
    ["slug", c.slug],
    ["vercel.token", c.vercel?.token],
    ["mongodbUri", c.mongodbUri],
    ["admin.username", c.admin.username],
    ["admin.password", c.admin.password],
    ["cafe.name", c.cafe.name],
    ["cloudflare.token", cf?.token],
    ["accounts.vercel.password", c.accounts?.vercel?.password],
    ["accounts.atlas.password", c.accounts?.atlas?.password],
    ["accounts.images.password", c.accounts?.images?.password],
    ["profile.token", entry.token],
  ]
    .filter(([, v]) => typeof v === "string" && PLACEHOLDER_RE.test(v))
    .map(
      ([name]) => `${name}: still holds a <placeholder> from the example file`,
    );
  if (placeholders.length) fail(placeholders.join("; "));

  const errors = [],
    warnings = [];
  // Profile and file must describe the same Vercel project.
  const projectId = str(g.projectId) || str(entry.projectId),
    orgId = str(g.orgId) || str(entry.orgId);
  if (
    has(g.projectId) &&
    has(entry.projectId) &&
    str(g.projectId) !== str(entry.projectId)
  )
    errors.push(
      "The selected deploy profile points at a different Vercel project than the client file (project id differs).",
    );
  if (has(g.orgId) && has(entry.orgId) && str(g.orgId) !== str(entry.orgId))
    errors.push(
      "The selected deploy profile points at a different Vercel org than the client file (org id differs).",
    );
  if (errors.length) fail(errors.join(" "));

  const cloudflare =
    cf || has(rt.workerName) || has(rt.url)
      ? {
          accountId: str(cf?.accountId),
          workerName: str(rt.workerName),
          workerUrl: str(rt.url),
        }
      : null;
  const image = {
    store: img ? str(img.store) : null,
    publicBaseUrl: str(img?.publicBaseUrl),
    cloudName: str(img?.cloudName),
    r2AccountId: str(img?.accountId),
    bucket: str(img?.bucket),
  };
  const host = str(g.host);
  const rawConfig = {
    slug: str(c.slug),
    subdomain: str(c.subdomain),
    host,
    tenantId: str(g.tenantId),
    rootDomain: str(g.rootDomain),
    deployLock: true,
    vercel: {
      projectId,
      orgId,
      teamId: str(c.vercel?.teamId) || str(entry.scope),
      projectName: str(c.vercel?.project) || str(g.projectName) || str(c.slug),
    },
    cloudflare,
    image,
    posAdmin: { username: str(c.admin.username).toLowerCase() },
  };
  const config = posConfigSchema.safeParse(rawConfig);
  if (!config.success) fail(formatIssues(config.error.issues, "POS setup "));

  // Plaintexts by POS secret field; absent ones stay out of the map.
  const secrets = {};
  const imageKeys = !img
    ? null
    : image.store === "r2"
      ? { accessKeyId: img.accessKeyId, secretAccessKey: img.secretAccessKey }
      : { apiKey: img.apiKey, apiSecret: img.apiSecret };
  const sources = {
    "vercel.token": has(c.vercel?.token) ? c.vercel.token : entry.token,
    "mongo.uri": c.mongodbUri,
    "cloudflare.token": cf?.token,
    "image.keys":
      imageKeys && Object.values(imageKeys).every(has)
        ? JSON.stringify(imageKeys)
        : null,
    "generated.authSecret": g.authSecret,
    "generated.healthStatsToken": g.healthStatsToken,
    "generated.realtimePublishSecret": has(cf?.publishSecret)
      ? cf.publishSecret
      : rt.publishSecret,
    "posAdmin.password": c.admin.password,
  };
  if (
    imageKeys &&
    Object.values(imageKeys).some(has) &&
    !Object.values(imageKeys).every(has)
  )
    errors.push(
      image.store === "r2"
        ? "image.keys: Image keys are incomplete: both the R2 access key id and secret are required."
        : "image.keys: Image keys are incomplete: both the Cloudinary API key and secret are required.",
    );
  for (const field of POS_SECRET_FIELDS) {
    const value = sources[field];
    if (!has(value)) continue;
    const check = posSecretValue(field).safeParse(value);
    if (!check.success)
      errors.push(`${field}: ${check.error.issues[0].message}`);
    else secrets[field] = value;
  }
  if (errors.length) fail(errors.join("; "));

  if (has(entry.tokenEnv))
    warnings.push(
      has(c.vercel?.token) || has(entry.token)
        ? "The deploy profile holds its Vercel token in an environment variable; that is not imported."
        : "The deploy profile holds its Vercel token in an environment variable: enter the Vercel token by hand after the import.",
    );
  else if (!secrets["vercel.token"])
    warnings.push(
      "No Vercel token in the file: enter the Vercel token by hand.",
    );
  if (
    has(c.vercel?.token) &&
    has(entry.token) &&
    c.vercel.token !== entry.token
  )
    warnings.push(
      "The profile's Vercel token differs from the client file's. The client file's token is stored.",
    );
  if (c.deployLock === false)
    warnings.push(
      "The file has deployLock off. It is imported as locked: no admin deploy until you unlock it.",
    );
  if (!host)
    warnings.push(
      "No host in the file: the installation endpoint stays empty.",
    );
  if (!config.data.image.store) warnings.push("No image store in the file.");

  // Account entries; an entry exists only when it has a login or a password.
  const imageService =
    image.store === "r2"
      ? "r2"
      : image.store === "cloudinary"
        ? "cloudinary"
        : "other";
  const accounts = [];
  const add = (key, service, label, login, password) => {
    if (has(login) || has(password))
      accounts.push({
        importKey: `pos-import:${config.data.slug}:${key}`,
        service,
        label,
        login: str(login),
        password: has(password) ? password : null,
      });
  };
  const a = c.accounts ?? {};
  add(
    "vercel",
    "vercel",
    "Vercel account",
    a.vercel?.email,
    a.vercel?.password,
  );
  add(
    "atlas",
    "atlas",
    "MongoDB Atlas account",
    a.atlas?.email,
    a.atlas?.password,
  );
  add(
    "images",
    imageService,
    "Image storage account",
    a.images?.email,
    a.images?.password,
  );
  add(
    "other",
    "other",
    "Other logins (imported)",
    "",
    has(a.other) ? a.other : null,
  );

  const dropped = [];
  collectDropped(c, "", dropped);
  if (profile) {
    if (has(entry.app)) dropped.push("profile.app");
    if (has(entry.tokenEnv)) dropped.push("profile.tokenEnv");
  }
  const cfg = config.data;
  return {
    config: cfg,
    secrets,
    accounts,
    dropped: dropped.sort(),
    warnings,
    installationName: `${str(c.cafe.name)} POS`.slice(0, 120),
    defaults: {
      name: str(c.contact?.ownerName),
      company: str(c.cafe.name).slice(0, 160),
      phone: str(c.contact?.phone).slice(0, 32),
    },
    hints: {
      emails: [
        ...new Set(
          [a.vercel?.email, a.atlas?.email, a.images?.email]
            .filter(has)
            .map((e) => e.trim().toLowerCase()),
        ),
      ],
      names: [str(c.contact?.ownerName), str(c.cafe.name)].filter(Boolean),
    },
    // Non-secret view for the preview.
    mapping: {
      slug: cfg.slug,
      subdomain: cfg.subdomain,
      host: cfg.host,
      tenantId: cfg.tenantId,
      rootDomain: cfg.rootDomain,
      endpoint: cfg.host ? `https://${cfg.host}` : "",
      installationName: `${str(c.cafe.name)} POS`.slice(0, 120),
      deployLock: true,
      fileDeployLock: c.deployLock ?? null,
      vercel: cfg.vercel,
      mongo: mongoTarget(c.mongodbUri),
      cloudflare: cfg.cloudflare,
      image: cfg.image,
      posAdmin: cfg.posAdmin,
    },
  };
}
