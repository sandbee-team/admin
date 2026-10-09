import { z } from "zod";
import { readFileSync } from "node:fs";
import { BUCKET_RE, REGION_RE } from "./lib/s3.js";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8098),
  APP_URL: z.url().default("http://localhost:8098"),
  MONGODB_URI: z.string().min(10),
  MONGODB_DB: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("sandbee_admin"),
  VAULT_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  // Optional and never validated here: a bad value is reported as `invalid` on
  // the Recovery page instead of stopping the boot.
  BACKUP_KEY: z.string().default(""),
  AUTH_SECRET: z.string().min(48),
  SMTP_HOST: z.string().min(1).default("127.0.0.1"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1031),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  MAIL_FROM: z.string().default("Sandbee Admin <admin@sandbee.in>"),
  STORE_MONGODB_URI: z.string().default(""),
  STORE_MONGODB_DB: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default("sandbee_platform"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  ECOM_SERVICE_URL: z.string().default(""),
  ECOM_SERVICE_KEY: z.string().default(""),
  FILES_S3_REGION: z.string().default(""),
  FILES_S3_BUCKET: z.string().default(""),
  FILES_S3_ACCESS_KEY_ID: z.string().default(""),
  FILES_S3_SECRET_ACCESS_KEY: z.string().default(""),
});
const FILES_VARS = [
  "FILES_S3_REGION",
  "FILES_S3_BUCKET",
  "FILES_S3_ACCESS_KEY_ID",
  "FILES_S3_SECRET_ACCESS_KEY",
];
export function config(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid environment fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = parsed.data,
    url = new URL(c.APP_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("APP_URL must be an HTTP(S) origin.");
  if (
    c.NODE_ENV === "production" &&
    (url.protocol !== "https:" || !c.SMTP_USER || !c.SMTP_PASSWORD)
  )
    throw new Error("Production requires HTTPS and authenticated SMTP.");
  if (c.STORE_MONGODB_URI && c.MONGODB_DB === c.STORE_MONGODB_DB)
    throw new Error("Admin and Store databases must be separate.");
  if (c.ECOM_SERVICE_URL) {
    const ecom = new URL(c.ECOM_SERVICE_URL);
    if (
      ecom.username ||
      ecom.password ||
      ecom.pathname !== "/" ||
      ecom.search ||
      ecom.hash ||
      !(
        ecom.protocol === "https:" ||
        (c.NODE_ENV !== "production" &&
          ecom.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(ecom.hostname))
      ) ||
      c.ECOM_SERVICE_KEY.length < 48
    )
      throw new Error(
        "Ecom bridge requires an HTTPS origin and a service key (loopback HTTP allowed locally).",
      );
  }
  // Client files: all four unset disables the feature; a partial or malformed
  // set stops the boot. Only variable NAMES are ever reported.
  const filesSet = FILES_VARS.filter((name) => c[name] !== "");
  if (filesSet.length) {
    const bad = [];
    if (c.FILES_S3_REGION === "") c.FILES_S3_REGION = "ap-south-1";
    for (const name of FILES_VARS.slice(1)) if (c[name] === "") bad.push(name);
    if (!bad.length) {
      if (!REGION_RE.test(c.FILES_S3_REGION)) bad.push("FILES_S3_REGION");
      if (!BUCKET_RE.test(c.FILES_S3_BUCKET)) bad.push("FILES_S3_BUCKET");
      if (!/^[A-Z0-9]{16,128}$/.test(c.FILES_S3_ACCESS_KEY_ID))
        bad.push("FILES_S3_ACCESS_KEY_ID");
      if (!/^\S{20,128}$/.test(c.FILES_S3_SECRET_ACCESS_KEY))
        bad.push("FILES_S3_SECRET_ACCESS_KEY");
    }
    if (bad.length)
      throw new Error(`Invalid file storage settings: ${bad.join(", ")}`);
  }
  return c;
}
// The snapshot key as scripts/recovery.js reads it: BACKUP_KEY, else the local
// key file. The key is returned only for in-memory use; `state` is
// "configured", "missing" or "invalid".
export function backupKeyInfo(c, file = ".local/backup-key.txt") {
  let key = (c.BACKUP_KEY || "").trim();
  if (!key) {
    try {
      key = readFileSync(file, "utf8").trim();
    } catch {
      key = "";
    }
  }
  if (!key) return { state: "missing", key: "" };
  return /^[a-f0-9]{64}$/.test(key)
    ? { state: "configured", key }
    : { state: "invalid", key: "" };
}
