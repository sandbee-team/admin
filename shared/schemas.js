import { z } from "zod";
import { MODELS, INSTALL_STATES, CHECKS } from "./policy.js";
import { PROVIDERS } from "./product-models.js";
import { BRANCH_RE, SHA_RE } from "./deploy.js";
const text = (max) => z.string().trim().max(max);
const name = text(120).min(2);
const id = z.uuid();
const optionalId = z.union([id, z.literal("")]).default("");
const https = z
  .union([
    z
      .url()
      .max(500)
      .refine((value) => {
        try {
          const u = new URL(value);
          return u.protocol === "https:" && !u.username && !u.password;
        } catch {
          return false;
        }
      }, "Use an HTTPS URL without credentials."),
    z.literal(""),
  ])
  .default("");
const date = z.union([z.iso.date(), z.literal("")]).default("");
export const schemas = {
  customers: z
    .object({
      name,
      email: z
        .email()
        .max(254)
        .transform((v) => v.toLowerCase()),
      company: text(160),
      phone: text(32),
      status: z.enum(["lead", "active", "paused", "archived"]),
      notes: text(2000),
      storeWorkspaceId: z
        .string()
        .regex(/^[a-zA-Z0-9_-]{0,100}$/)
        .default(""),
    })
    .strict(),
  products: z
    .object({
      name,
      slug: z.string().regex(/^[a-z][a-z0-9-]{1,48}$/),
      description: text(500),
      category: text(80).min(2),
      model: z.enum(MODELS),
      requiredProviders: z
        .array(z.enum(PROVIDERS))
        .max(PROVIDERS.length)
        .transform((values) => [...new Set(values)])
        .default([]),
      pricing: z.enum([
        "free",
        "prepaid",
        "one-time",
        "subscription",
        "custom",
      ]),
      status: z.enum(["active", "planned", "retired"]),
      website: https,
    })
    .strict(),
  installations: z
    .object({
      name,
      customerId: id,
      productId: id,
      environment: z.enum(["production", "staging", "development"]),
      status: z.enum(INSTALL_STATES),
      release: text(160),
      sourceUrl: https,
      endpoint: https,
      connectionIds: z.array(id).max(10),
      checks: z
        .array(z.enum(CHECKS.map((c) => c.id)))
        .max(CHECKS.length)
        .transform((v) => [...new Set(v)]),
      evidence: text(2000),
      notes: text(2000),
    })
    .strict(),
  connections: z
    .object({
      name,
      customerId: id,
      provider: z.enum(["vercel", "mongodb", "cloudflare", "aws", "other"]),
      ownership: z.enum(["customer", "sandbee"]),
      accountId: text(160),
      resourceId: text(160),
      expiresAt: date,
      status: z.enum(["recorded", "attention", "revoked"]),
      notes: text(1000),
    })
    .strict(),
  tasks: z
    .object({
      title: name,
      customerId: optionalId,
      installationId: optionalId,
      assigneeId: optionalId,
      status: z.enum(["open", "in-progress", "done"]),
      priority: z.enum(["normal", "high", "urgent"]),
      dueAt: date,
      notes: text(2000),
    })
    .strict(),
};
export const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    search: text(100).default(""),
    status: text(30).default(""),
    customerId: optionalId,
    productId: optionalId,
    model: z.union([z.enum(MODELS), z.literal("")]).default(""),
  })
  .strict();

// ---- Client record vault (accounts), files and POS block ------------------
export const ACCOUNT_SERVICES = [
  "gmail",
  "vercel",
  "atlas",
  "cloudflare",
  "godaddy",
  "r2",
  "cloudinary",
  "other",
];
export const ACCOUNT_SECRET_FIELDS = ["password", "totpKey", "backupCodes"];
export const MAX_ACCOUNTS = 50;
// Secrets are never trimmed. Messages never echo the submitted value.
const secretText = (min, max, what) =>
  z
    .string()
    .min(min, `${what} must be ${min}-${max} characters.`)
    .max(max, `${what} must be ${min}-${max} characters.`);
const secretValues = {
  password: secretText(1, 1024, "Password"),
  totpKey: secretText(16, 512, "Authenticator key"),
  backupCodes: z
    .array(secretText(4, 64, "Backup code"))
    .min(1, "Add at least one backup code.")
    .max(30, "At most 30 backup codes."),
};
const accountDetails = {
  service: z.enum(ACCOUNT_SERVICES),
  label: text(80).min(1),
  login: text(254).default(""),
  recoveryContact: text(254).default(""),
  notes: text(1000).default(""),
};
const entryRev = z.number().int().min(1);
export const accountSchemas = {
  create: z
    .object({
      ...accountDetails,
      password: secretValues.password.optional(),
      totpKey: secretValues.totpKey.optional(),
      backupCodes: secretValues.backupCodes.optional(),
    })
    .strict(),
  update: z.object({ ...accountDetails, rev: entryRev }).strict(),
  secret: z.discriminatedUnion("field", [
    z
      .object({
        field: z.literal("password"),
        value: secretValues.password,
        rev: entryRev,
      })
      .strict(),
    z
      .object({
        field: z.literal("totpKey"),
        value: secretValues.totpKey,
        rev: entryRev,
      })
      .strict(),
    z
      .object({
        field: z.literal("backupCodes"),
        value: secretValues.backupCodes,
        rev: entryRev,
      })
      .strict(),
  ]),
  removeSecret: z
    .object({ rev: entryRev, field: z.enum(ACCOUNT_SECRET_FIELDS) })
    .strict(),
  remove: z.object({ rev: entryRev }).strict(),
  reveal: z.object({ field: z.enum(ACCOUNT_SECRET_FIELDS) }).strict(),
  codeUsed: z
    .object({ rev: entryRev, index: z.number().int().min(0).max(29) })
    .strict(),
};

export const FILE_CATEGORIES = [
  "agreement",
  "kyc",
  "invoice",
  "screenshot",
  "db-backup",
  "other",
];
export const FILE_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "txt",
  "csv",
  "json",
  "zip",
  "gz",
  "docx",
  "xlsx",
];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 300;

// Fields of installations.pos that hold encrypted boxes (AAD pos:<id>:<field>).
export const POS_SECRET_FIELDS = [
  "vercel.token",
  "mongo.uri",
  "cloudflare.token",
  "image.keys",
  "generated.authSecret",
  "generated.healthStatsToken",
  "generated.realtimePublishSecret",
  "posAdmin.password",
];
// Copied (not imported) from the go-live tool's validation so both agree.
const RESERVED_SUBDOMAINS = ["www", "app", "api", "admin", "hub"];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MONGO_URI_WITH_DB_RE = /^mongodb(\+srv)?:\/\/[^/?]+\/[^/?]+/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const APEX_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PLACEHOLDER_RE = /<[^<>\s]+>/;
const notPlaceholder = (v) => !PLACEHOLDER_RE.test(v);
export const isStrongPassword = (p) =>
  typeof p === "string" &&
  p.length >= 8 &&
  /\d/.test(p) &&
  /[^A-Za-z0-9]/.test(p);
const posText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(notPlaceholder, "Replace the <placeholder> text.")
    .default("");
const posPattern = (re, message, max = 64) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max)
        .regex(re, message)
        .refine(notPlaceholder, "Replace the <placeholder> text."),
      z.literal(""),
    ])
    .default("");
const posId = posPattern(
  /^[A-Za-z0-9_-]{1,64}$/,
  "Use letters, digits, - or _.",
);
const posHttps = https.refine(
  notPlaceholder,
  "Replace the <placeholder> text.",
);
export const posConfigSchema = z
  .object({
    slug: z
      .string()
      .regex(SLUG_RE, "Use lowercase letters, digits and hyphens (max 52)."),
    subdomain: posPattern(SUBDOMAIN_RE, "Use one DNS label.").refine(
      (v) => !RESERVED_SUBDOMAINS.includes(v),
      "This subdomain is reserved.",
    ),
    host: posPattern(APEX_RE, "Use a lowercase host name.", 253),
    tenantId: posId,
    rootDomain: posPattern(APEX_RE, "Use a lowercase domain.", 253),
    vercel: z
      .object({
        projectId: posId,
        orgId: posId,
        teamId: posId,
        projectName: posPattern(SLUG_RE, "Use a Vercel project name.", 52),
      })
      .strict()
      .prefault({}),
    cloudflare: z
      .object({
        accountId: posId,
        workerName: posPattern(SLUG_RE, "Use a Worker name.", 52),
        workerUrl: posHttps,
      })
      .strict()
      .nullable()
      .default(null),
    image: z
      .object({
        store: z.enum(["r2", "cloudinary"]).nullable().default(null),
        publicBaseUrl: posHttps,
        cloudName: posId,
        r2AccountId: posId,
        bucket: posText(63),
      })
      .strict()
      .prefault({})
      .superRefine((image, ctx) => {
        if (image.store === "r2" && !image.publicBaseUrl)
          ctx.addIssue({
            code: "custom",
            path: ["publicBaseUrl"],
            message: "R2 needs the public base URL.",
          });
        if (image.store === "cloudinary" && !image.cloudName)
          ctx.addIssue({
            code: "custom",
            path: ["cloudName"],
            message: "Cloudinary needs the cloud name.",
          });
      }),
    posAdmin: z
      .object({
        username: posPattern(
          USERNAME_RE,
          "Use 3-32 lowercase letters, digits, . _ -",
          32,
        ),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export const posSecretValue = (field) =>
  z
    .string()
    .min(1)
    .max(4096)
    .refine(notPlaceholder, "Replace the <placeholder> text.")
    .superRefine((value, ctx) => {
      const fail = (message) => ctx.addIssue({ code: "custom", message });
      if (field === "mongo.uri" && !MONGO_URI_WITH_DB_RE.test(value))
        fail("Use a mongodb:// URI that names the database.");
      else if (field === "posAdmin.password" && !isStrongPassword(value))
        fail("Use 8+ characters with a digit and a symbol.");
      else if (field === "image.keys") {
        let parsed;
        try {
          parsed = JSON.parse(value);
        } catch {
          return fail("Image keys must be a JSON object.");
        }
        const keys =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? Object.keys(parsed)
            : [];
        const ok =
          keys.length === 2 &&
          keys.every((k) => typeof parsed[k] === "string" && parsed[k]) &&
          (["accessKeyId", "secretAccessKey"].every((k) => keys.includes(k)) ||
            ["apiKey", "apiSecret"].every((k) => keys.includes(k)));
        if (!ok)
          fail(
            "Image keys must be {accessKeyId, secretAccessKey} or {apiKey, apiSecret}.",
          );
      } else if (
        ["generated.authSecret", "generated.healthStatsToken"].includes(
          field,
        ) &&
        value.length < 16
      )
        fail("Use at least 16 characters.");
    });
const posRev = z.number().int().min(1);
export const posSchemas = {
  put: z
    .object({ rev: z.number().int().min(0), config: posConfigSchema })
    .strict(),
  secret: z
    .object({
      rev: posRev,
      field: z.enum(POS_SECRET_FIELDS),
      value: z.string().max(4096),
    })
    .strict()
    .superRefine((data, ctx) => {
      const check = posSecretValue(data.field).safeParse(data.value);
      if (!check.success)
        for (const issue of check.error.issues)
          ctx.addIssue({
            code: "custom",
            path: ["value"],
            message: issue.message,
          });
    }),
  removeSecret: z
    .object({ rev: posRev, field: z.enum(POS_SECRET_FIELDS) })
    .strict(),
  reveal: z.object({ field: z.enum(POS_SECRET_FIELDS) }).strict(),
  remove: z.object({ rev: posRev }).strict(),
};

// ---- Go-live file import (preview + confirm) -------------------------------
// Value rules live in the mapping step (it feeds posConfigSchema and
// posSecretValue); these schemas fix the SHAPE: every known top-level key of a
// go-live client file, unknown keys rejected, dropped blocks left unchecked.
// Messages never echo a submitted value.
const lax = z.unknown().optional();
const importText = (max) => z.string().max(max).nullable().optional();
const importLogin = z
  .object({ email: importText(254), password: importText(1024) })
  .loose()
  .nullable()
  .optional();
export const importClientSchema = z
  .object({
    _readme: lax,
    slug: z.string().max(80),
    vercel: z
      .object({
        token: importText(4096),
        project: importText(80),
        teamId: importText(64),
      })
      .loose()
      .nullable()
      .optional(),
    subdomain: importText(80),
    mongodbUri: z.string().max(4096),
    admin: z.object({
      username: z.string().max(80),
      password: z.string().max(1024),
    }),
    cafe: z.object({ name: z.string().max(200) }).loose(),
    tables: lax,
    menu: lax,
    image: z
      .object({
        store: z.string().max(20),
        accountId: importText(128),
        accessKeyId: importText(1024),
        secretAccessKey: importText(1024),
        bucket: importText(63),
        publicBaseUrl: importText(500),
        cloudName: importText(128),
        apiKey: importText(1024),
        apiSecret: importText(1024),
      })
      .loose()
      .nullable()
      .optional(),
    contact: z
      .object({ ownerName: importText(120), phone: importText(32) })
      .loose()
      .nullable()
      .optional(),
    accounts: z
      .object({
        vercel: importLogin,
        atlas: importLogin,
        images: importLogin,
        other: importText(4000),
      })
      .loose()
      .nullable()
      .optional(),
    notes: lax,
    deployLock: z.boolean().nullable().optional(),
    demo: lax,
    cloudflare: z
      .object({
        token: importText(4096),
        accountId: importText(128),
        publishSecret: importText(4096),
      })
      .loose()
      .nullable()
      .optional(),
    standbyHosts: lax,
    generated: z
      .object({
        host: importText(253),
        tenantId: importText(64),
        rootDomain: importText(253),
        projectId: importText(128),
        projectName: importText(80),
        orgId: importText(128),
        authSecret: importText(4096),
        healthStatsToken: importText(4096),
        realtime: z
          .object({
            workerName: importText(80),
            url: importText(500),
            publishSecret: importText(4096),
          })
          .loose()
          .nullable()
          .optional(),
      })
      .loose()
      .nullable()
      .optional(),
    lastRun: lax,
  })
  .strict();
// Only the selected deploy.profiles.json entry ever leaves the browser.
export const importProfileSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, digits, - or _."),
    entry: z
      .object({
        app: importText(200),
        orgId: importText(128),
        projectId: importText(128),
        scope: importText(128),
        tokenEnv: importText(200),
        token: importText(4096),
      })
      .strict(),
  })
  .strict();
const importInput = {
  client: importClientSchema,
  profile: importProfileSchema.nullable().default(null),
};
export const posImportSchemas = {
  preview: z.object(importInput).strict(),
  confirm: z
    .object({
      ...importInput,
      digest: z.string().regex(/^[0-9a-f]{64}$/, "Preview the file again."),
      customer: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("existing"), customerId: id }).strict(),
        z
          .object({
            mode: z.literal("new"),
            name,
            email: z.email().max(254),
            company: text(160).default(""),
            phone: text(32).default(""),
          })
          .strict(),
      ]),
    })
    .strict(),
};

// ---- POS deploys (Stage 2) --------------------------------------------------
// `confirm` is the typed slug where a slug is required; redeploy confirms with
// `true`. Every body is strict.
const deployBranch = z.string().max(200).regex(BRANCH_RE, "Use a branch name.");
const deploySha = z.string().regex(SHA_RE, "Use the full 40-character commit.");
const slugConfirm = z.string().trim().min(1).max(60);
export const deploySchemas = {
  enqueue: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("deploy"),
        branch: deployBranch,
        sha: deploySha,
        confirm: slugConfirm,
      })
      .strict(),
    z
      .object({
        kind: z.literal("redeploy"),
        // Which stored version to ship again; the commit comes from the
        // server's record, never from the request.
        of: z.enum(["last", "previous"]).default("last"),
        // true for the live version; the typed slug when of is "previous"
        // (it changes production like a rollback).
        confirm: z.union([z.literal(true), slugConfirm]),
      })
      .strict(),
  ]),
  rollback: z.object({ confirm: slugConfirm }).strict(),
  job: z.object({ requestId: id }).strict(),
  lock: z.object({}).strict(),
  unlock: z
    .object({
      confirm: slugConfirm,
      // Optional attestation that the local clients/<slug>.json now has
      // deployLock:true (POS-STAGE2-PLAN section 6).
      localLocked: z.boolean().optional(),
    })
    .strict(),
  empty: z.object({}).strict(),
  build: z.object({ branch: deployBranch, sha: deploySha }).strict(),
  freeze: z
    .object({ reason: text(200).default("") })
    .strict()
    .prefault({}),
  purge: z
    .object({
      previewTaskId: id,
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      confirm: slugConfirm,
    })
    .strict(),
  plan: z.object({ branch: deployBranch }).strict(),
  branches: z.object({ installation: id.optional() }).strict(),
  fleet: z
    .object({
      customerId: id.optional(),
      // light=1: no GitHub or build-cache lookups (relation "unknown").
      light: z.literal("1").optional(),
    })
    .strict(),
};
