import { MongoMemoryReplSet } from "mongodb-memory-server";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../backend/config.js";
import { connect } from "../backend/db.js";
import { createApp } from "../backend/app.js";
import { hashPassword } from "../backend/lib/crypto.js";
import { seedCatalog } from "../backend/modules/catalog-seed.js";
import { createFakeS3 } from "./fake-s3.js";
import { createServer } from "node:http";
import { verifyVaultKey } from "../backend/lib/vault.js";
import { verifyKey } from "../backend/lib/recovery-tasks.js";
import { encrypt } from "../backend/lib/crypto.js";
import { createGitHub } from "../backend/lib/github.js";
import { aadOf, newPos } from "../backend/modules/pos.js";
import { JOB_STEPS } from "../shared/deploy.js";
import { GOLIVE_RUN_STEPS, GOLIVE_STEPS } from "../shared/golive.js";
import { addressStateOf } from "../shared/web-address.js";
import { newGolive } from "../backend/lib/deploy-job.js";
import { GOLIVE_ENV_KEYS } from "../backend/lib/golive-env.js";
import {
  MONGO_LIMIT_BYTES,
  WORKER_FREE_REQUESTS,
  evaluateAlerts,
  utcDay,
} from "../shared/usage.js";
import { createFakeGitHub, BLD, SRC, SHAS } from "./fakes/github.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMongoHome } from "./mongo-home.js";
// Playwright stops this server hard, so the data folder is our own and the
// next start removes the folders of runs that are gone (test/mongo-home.js).
// The clean-up never blocks a start: without it the library's own temp folder
// is used, as before.
let dbPath = null;
try {
  dbPath = prepareMongoHome(join(tmpdir(), "sandbee-ui-mongo"));
} catch (error) {
  console.warn(
    `ui-server: own Mongo folder unavailable (${error.code ?? error.message})`,
  );
}
const repl = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
  instanceOpts: dbPath ? [{ dbPath }] : [],
});
const c = config({
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:8108",
  MONGODB_URI: repl.getUri(),
  MONGODB_DB: "admin_ui_test",
  VAULT_KEY: "a".repeat(64),
  AUTH_SECRET: "b".repeat(64),
  // Specs give themselves a client address (X-Forwarded-For), so the sign-in
  // rate limit counts each spec separately instead of the whole run at once.
  TRUST_PROXY_HOPS: "1",
});
const { db, client } = await connect(c);
await seedCatalog(db);
for (const role of ["owner", "viewer"])
  await db.collection("staff").insertOne({
    _id: randomUUID(),
    email: `${role}@example.test`,
    name: `${role} tester`,
    role,
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    createdAt: new Date(),
  });
// Dedicated owner for security.spec.js: it enrols an authenticator, which must
// not change how the other specs sign in.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "security-owner@example.test",
  name: "security owner",
  role: "owner",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// Admin for the queued step-up case in security.spec.js.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "stepup-admin@example.test",
  name: "stepup admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// Admin for the unsaved-backup-codes guard case in security.spec.js.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "guard-admin@example.test",
  name: "guard admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// client-record.spec.js: an owner who enrols an authenticator, an admin (vault
// access without secrets), and one customer with a POS installation.
for (const [email, role] of [
  ["client-owner@example.test", "owner"],
  ["client-admin@example.test", "admin"],
  // import.spec.js: owner without an authenticator (import needs no step-up).
  ["import-owner@example.test", "owner"],
])
  await db.collection("staff").insertOne({
    _id: randomUUID(),
    email,
    name: email.split("@")[0],
    role,
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    createdAt: new Date(),
  });
const posProduct = await db.collection("products").findOne({ slug: "pos" });
const stamp = { revision: 1, createdAt: new Date(), updatedAt: new Date() };
await db.collection("customers").insertOne({
  _id: "00000000-0000-4000-8000-0000000000c1",
  name: "Record Customer",
  company: "Record Cafe",
  email: "record-customer@example.test",
  phone: "",
  status: "active",
  notes: "",
  storeWorkspaceId: "",
  ...stamp,
});
await db.collection("installations").insertOne({
  _id: "00000000-0000-4000-8000-0000000000a1",
  name: "Record POS production",
  customerId: "00000000-0000-4000-8000-0000000000c1",
  productId: posProduct._id,
  environment: "production",
  status: "planned",
  release: "",
  sourceUrl: "",
  endpoint: "",
  connectionIds: [],
  checks: ["ownership"],
  evidence: "",
  notes: "",
  ...stamp,
});
// A connection two people can edit at once (lost-update case).
await db.collection("connections").insertOne({
  _id: "00000000-0000-4000-8000-0000000000b1",
  name: "Shared Vercel",
  customerId: "00000000-0000-4000-8000-0000000000c1",
  provider: "vercel",
  ownership: "customer",
  accountId: "team-original",
  resourceId: "",
  expiresAt: "",
  status: "recorded",
  notes: "",
  ...stamp,
});
// ---- POS deploy fixtures (deploys.spec.js) ----------------------------------
// Owners with a known authenticator key (the spec derives codes from it), one
// per test, because a TOTP step can only be used once per account.
const DEPLOY_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
for (const name of [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  // usage.spec.js
  "r",
  "s",
  "t",
  // purge.spec.js
  "u",
  "v",
  "w",
  // rollout.spec.js
  "x",
  "y",
  "z",
]) {
  const _id = randomUUID();
  await db.collection("staff").insertOne({
    _id,
    email: `deploy-owner-${name}@example.test`,
    name: `deploy owner ${name}`,
    role: "owner",
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    totp: {
      key: encrypt(DEPLOY_KEY, c.VAULT_KEY, `staff:${_id}:totp`),
      enabledAt: new Date(),
      lastStep: null,
    },
    createdAt: new Date(),
  });
}
// golive.spec.js (P5): the deploy-owner letters are used up.
for (const name of ["a", "b", "c", "d", "e", "f"]) {
  const _id = randomUUID();
  await db.collection("staff").insertOne({
    _id,
    email: `golive-owner-${name}@example.test`,
    name: `golive owner ${name}`,
    role: "owner",
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    totp: {
      key: encrypt(DEPLOY_KEY, c.VAULT_KEY, `staff:${_id}:totp`),
      enabledAt: new Date(),
      lastStep: null,
    },
    createdAt: new Date(),
  });
}
// Its own admin (email code): the sign-in limit per staff member is shared by
// every spec that signs deploy-admin in.
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "golive-admin@example.test",
  name: "golive admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// ---- Sales documents (sales.spec.js) ----------------------------------------
// Owners with the deploy key (settings need a step-up), an admin, a customer.
for (const name of ["a", "b"]) {
  const _id = randomUUID();
  await db.collection("staff").insertOne({
    _id,
    email: `sales-owner-${name}@example.test`,
    name: `sales owner ${name}`,
    role: "owner",
    status: "active",
    revision: 1,
    authVersion: 1,
    passwordHash: await hashPassword("Browser test passphrase 2026!"),
    totp: {
      key: encrypt(DEPLOY_KEY, c.VAULT_KEY, `staff:${_id}:totp`),
      enabledAt: new Date(),
      lastStep: null,
    },
    createdAt: new Date(),
  });
}
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "sales-admin@example.test",
  name: "sales admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
await db.collection("customers").insertOne({
  _id: "00000000-0000-4000-8000-0000000000c5",
  name: "Sales Customer",
  company: "Cafe Blue",
  email: "cafe-blue@example.test",
  phone: "",
  status: "active",
  notes: "",
  storeWorkspaceId: "",
  revision: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});
await db.collection("staff").insertOne({
  _id: randomUUID(),
  email: "deploy-admin@example.test",
  name: "deploy admin",
  role: "admin",
  status: "active",
  revision: 1,
  authVersion: 1,
  passwordHash: await hashPassword("Browser test passphrase 2026!"),
  createdAt: new Date(),
});
// Distinct leading characters so a short sha tells the commits apart.
const sha = (n) => String(n).repeat(40);
const nid = (kind, n) =>
  `00000000-0000-4000-8000-${kind}${String(n).padStart(11, "0")}`;
const ago = (ms) => new Date(Date.now() - ms);
const RUN = "https://github.com/owner/builder/actions/runs/123";
const version = (n, extra = {}) => ({
  kind: "deploy",
  requestId: randomUUID(),
  branch: "main",
  sha: sha(n),
  at: ago(n === 9 ? 5 * 3600000 : 30 * 3600000),
  by: { id: "u", name: "Owner" },
  vercelDeploymentId: `dpl_${n}`,
  url: `https://demo-${n}.vercel.app`,
  durationMs: 90000,
  runUrl: RUN,
  status: "succeeded",
  build: {
    buildKey: "ab".repeat(32),
    objectKey: `builds/${sha(n)}/secretobjectkey.tgz.enc`,
    touchedAt: new Date(),
    source: "cache",
  },
  commit: {
    sha: sha(n),
    branch: "main",
    headline: n === 9 ? "Add table QR codes" : "Fix receipt rounding",
    authorName: "Dev",
    date: ago(40 * 3600000),
  },
  ...extra,
});
const NOTES = {
  build: "GitHub build 2:13",
  fetch: "Downloading the build",
  upload: "Uploading files",
  health: "Probing the site",
};
// A job at one step (what the worker would have written by then).
function job({
  kind = "deploy",
  branch = "feature/x",
  target = sha(2),
  status = "running",
  step = "build",
  error = null,
  stalled = false,
  claimed = false,
  requestedAt = new Date(),
  runUrl = null,
  requestId = randomUUID(),
} = {}) {
  const names = kind === "rollback" ? JOB_STEPS.rollback : JOB_STEPS.deploy;
  const at = status === "queued" ? -1 : names.indexOf(step);
  const bad = ["failed", "unhealthy", "rolled-back"].includes(status);
  return {
    kind,
    requestId,
    branch,
    sha: target,
    buildKey: null,
    commit: {
      sha: target,
      branch,
      headline: "Feature work in progress",
      authorName: "Dev Person",
      date: ago(3600000),
    },
    by: { id: "u", name: "deploy owner" },
    requestedAt,
    status,
    step: status === "queued" ? "queued" : step,
    steps: names.map((name, i) => ({
      name,
      state:
        i < at
          ? "done"
          : i === at
            ? bad
              ? "failed"
              : status === "cancelled"
                ? "pending"
                : "running"
            : "pending",
      startedAt: i <= at ? ago(120000 - i * 1000) : null,
      endedAt: i < at ? ago(90000 - i * 1000) : null,
      note: i === at && !bad ? (NOTES[name] ?? "") : "",
    })),
    lease: {
      owner: status === "queued" && !claimed ? null : "w1",
      until: stalled ? ago(120000) : new Date(Date.now() + 60000),
      fence: 1,
    },
    attempt: status === "queued" ? 0 : 1,
    heartbeatAt: null,
    runId: null,
    runUrl,
    artifactId: null,
    uploadStartedAt: null,
    vercelDeploymentId: kind === "rollback" ? "dpl_8" : null,
    url: null,
    baseline: null,
    cancelRequested: status === "cancelling",
    error,
    finishedAt: ["queued", "running", "cancelling"].includes(status)
      ? null
      : new Date(),
  };
}
const READY = {
  unlocked: true,
  token: true,
  verify: "ok",
  last: () => version(9),
  previous: () => version(8),
};
// ---- Phase 2 usage fixtures (usage.spec.js) ---------------------------------
// The stored shape of docs/PHASE2-PLAN.md §3 as the worker writes it: cluster
// `label` (never `tag`), token expiry in ms, and alerts keyed by type plus the
// level from the same pure evaluateAlerts the worker uses.
const DAY = 86400000;
const MIB = 1048576;
const cluster = (name, role, bytes, extra = {}) => ({
  name,
  role,
  label: null,
  active: false,
  paused: false,
  state: "ok",
  usedPct: Math.round((bytes / MONGO_LIMIT_BYTES) * 10000) / 10000,
  bytes,
  ...extra,
});
const share = (fraction) => Math.round(fraction * MONGO_LIMIT_BYTES);
const storage = (source, statsCode, clusters) => ({
  source,
  code: "ok",
  statsCode,
  clusters,
  maxPct: Math.max(...clusters.map((c) => c.usedPct)),
});
const cfCount = (requests, yesterday, now) => ({
  code: "ok",
  day: utcDay(now),
  requests,
  errors: 3,
  pct: Math.round((requests / WORKER_FREE_REQUESTS) * 10000) / 10000,
  yesterday: { day: utcDay(now - DAY), requests: yesterday },
});
const cfNone = (code) => ({
  code,
  day: null,
  requests: null,
  errors: null,
  pct: null,
  yesterday: null,
});
const siteUp = (latencyMs) => ({
  state: "up",
  code: "ok",
  httpStatus: 200,
  latencyMs,
  probes: 1,
  deployActive: false,
});
const USAGE_RESULTS = {
  healthy: (now) => ({
    site: siteUp(142),
    mongo: storage("health", "ok", [cluster("core", "core", 128 * MIB)]),
    cloudflare: cfCount(12000, 15400, now),
    credentials: {
      vercel: { code: "ok", expiresAt: null },
      cloudflare: { code: "ok", expiresAt: now + 120 * DAY },
    },
  }),
  // 466 MB core (91 %, critical) + a 30 % active ledger; Workers at 80 %.
  full: (now) => ({
    ...USAGE_RESULTS.healthy(now),
    mongo: storage("health", "ok", [
      cluster("core", "core", 466 * MIB),
      cluster("ledger-a", "ledger", share(0.3), { label: "A", active: true }),
    ]),
    cloudflare: cfCount(80000, 61000, now),
  }),
  // Paused by Vercel: no stats, so the direct check measured the core only.
  paused: () => ({
    site: {
      state: "paused",
      code: "paused",
      httpStatus: 503,
      latencyMs: 88,
      probes: 1,
      deployActive: false,
    },
    mongo: storage("direct", "stats-unavailable", [
      cluster("core", "core", share(0.4)),
    ]),
    cloudflare: cfNone("cf-not-set"),
    credentials: {
      vercel: { code: "ok", expiresAt: null },
      cloudflare: { code: "token-not-set", expiresAt: null },
    },
  }),
  // Stats token refused, so a direct check; the Cloudflare token cannot read
  // analytics; the Vercel token expires in 10 days (warning).
  denied: (now) => ({
    site: siteUp(95),
    mongo: storage("direct", "stats-denied", [
      cluster("core", "core", share(0.2)),
    ]),
    cloudflare: cfNone("cf-denied"),
    credentials: {
      vercel: { code: "ok", expiresAt: now + 10 * DAY - 3600000 },
      cloudflare: { code: "ok", expiresAt: null },
    },
  }),
};
// `now` dates the counts (today's Worker requests); `ageMs` only the check.
function usageLast(kind, now, ageMs = 0) {
  const measured = USAGE_RESULTS[kind](now);
  const { alerts, level } = evaluateAlerts(measured, now);
  return {
    ...measured,
    alerts,
    level,
    at: new Date(now - ageMs),
    durationMs: 4200,
  };
}
const usageCheck = (status, at, extra = {}) => ({
  id: randomUUID(),
  status,
  batchId: null,
  requestedAt: new Date(at - 6000),
  by: { id: "u", name: "deploy owner" },
  lease: { owner: "w1", until: new Date(at + 90000), fence: 1 },
  attempt: 1,
  startedAt: status === "queued" ? null : new Date(at - 5000),
  finishedAt: ["queued", "running"].includes(status) ? null : new Date(at),
  error: null,
  ...extra,
});
const usageScenario = (
  n,
  slug,
  customer,
  { watch, result, ageMs = 600000 },
) => ({
  n,
  slug,
  customer,
  ...READY,
  usageResult: result ?? "healthy",
  usage: () => {
    const now = Date.now();
    return result
      ? {
          watch,
          check: usageCheck("done", now - ageMs),
          last: usageLast(result, now, ageMs),
          mail: {},
        }
      : { watch };
  },
});
const SCENARIOS = {
  ready: { n: 1, slug: "ui-ready", customer: "Ready Cafe", ...READY },
  deploy: { n: 2, slug: "ui-deploy", customer: "Deploy Cafe", ...READY },
  redeploy: { n: 3, slug: "ui-redeploy", customer: "Redeploy Cafe", ...READY },
  unlock: {
    n: 4,
    slug: "ui-unlock",
    customer: "Unlock Cafe",
    unlocked: false,
    token: true,
    verify: "ok",
  },
  blocked: {
    n: 5,
    slug: "ui-blocked",
    customer: "Blocked Cafe",
    unlocked: false,
    token: false,
    ids: false,
    host: "",
    verify: null,
  },
  failed: {
    n: 6,
    slug: "ui-failed",
    customer: "Failed Cafe",
    ...READY,
    current: () =>
      job({
        status: "failed",
        step: "build",
        runUrl: RUN,
        error: {
          step: "build",
          code: "build-failed",
          message: "The build failed.",
        },
      }),
  },
  stalled: {
    n: 7,
    slug: "ui-stalled",
    customer: "Stalled Cafe",
    ...READY,
    current: () => job({ status: "running", step: "build", stalled: true }),
  },
  rolledback: {
    n: 8,
    slug: "ui-rolledback",
    customer: "Rolledback Cafe",
    ...READY,
    last: () => version(8, { status: "rolled-back-to" }),
    previous: () => null,
    current: () =>
      job({
        status: "rolled-back",
        step: "health",
        runUrl: RUN,
        requestedAt: ago(10 * 86400000),
        error: {
          step: "health",
          code: "health-failed",
          message: "Health failed.",
        },
      }),
  },
  unverified: {
    n: 9,
    slug: "ui-unverified",
    customer: "Unverified Cafe",
    unlocked: true,
    token: true,
    verify: null,
    last: () => version(9),
  },
  diverged: {
    n: 10,
    slug: "ui-diverged",
    customer: "Diverged Cafe",
    ...READY,
    last: () => version(7),
    previous: () => null,
  },
  backup: {
    n: 12,
    slug: "ui-backup",
    customer: "Backup Cafe",
    ...READY,
    mongo: true,
  },
  backuprun: {
    n: 13,
    slug: "ui-backuprun",
    customer: "Backuprun Cafe",
    ...READY,
    mongo: true,
    task: () => task("running"),
  },
  backupdone: {
    n: 14,
    slug: "ui-backupdone",
    customer: "Backupdone Cafe",
    ...READY,
    mongo: true,
    task: () => task("succeeded"),
  },
  backupbig: {
    n: 15,
    slug: "ui-backupbig",
    customer: "Backupbig Cafe",
    ...READY,
    mongo: true,
    task: () =>
      task("failed", {
        error: {
          code: "backup-too-large",
          message: "Over the limit.",
        },
      }),
  },
  preadmin: {
    n: 16,
    slug: "ui-preadmin",
    customer: "Preadmin Cafe",
    ...READY,
    previous: () =>
      version(8, {
        status: "pre-admin",
        sha: "",
        branch: "",
        commit: null,
        build: null,
      }),
  },
  unhealthy: {
    n: 17,
    slug: "ui-unhealthy",
    customer: "Unhealthy Cafe",
    ...READY,
    current: () =>
      job({
        status: "unhealthy",
        step: "health",
        error: { step: "health", code: "health-failed", message: "x" },
      }),
  },
  healthunknown: {
    n: 19,
    slug: "ui-healthunknown",
    customer: "Unknown Cafe",
    ...READY,
    current: () =>
      job({
        status: "unhealthy",
        step: "health",
        error: {
          step: "health",
          code: "health-unknown",
          message: "Could not check the site after going live. Check it now.",
        },
      }),
  },
  settings: {
    n: 18,
    slug: "ui-settings",
    customer: "Settings Cafe",
    ...READY,
    verify: "issues",
  },
  gone: {
    n: 11,
    slug: "ui-gone",
    customer: "Gone Cafe",
    ...READY,
    last: () => version(9, { branch: "old-branch" }),
    previous: () => null,
  },
  // usage.spec.js (Phase 2).
  usageok: usageScenario(21, "ui-usage-ok", "Usage Ok Cafe", {
    watch: true,
    result: "healthy",
  }),
  usagefull: usageScenario(22, "ui-usage-full", "Full Cafe", {
    watch: true,
    result: "full",
  }),
  usagepaused: usageScenario(23, "ui-usage-paused", "Paused Cafe", {
    watch: false,
    result: "paused",
    ageMs: 2 * 3600000,
  }),
  usagedenied: usageScenario(24, "ui-usage-denied", "Denied Cafe", {
    watch: true,
    result: "denied",
    ageMs: 3 * 3600000,
  }),
  usagenever: usageScenario(25, "ui-usage-never", "Never Cafe", {
    watch: true,
  }),
  // purge.spec.js: cutover set (READY has a live version) unless noted.
  purge: { n: 26, slug: "ui-purge", customer: "Purge Cafe", ...READY },
  purgebig: { n: 27, slug: "ui-purge-big", customer: "Big Cafe", ...READY },
  purgenocut: {
    n: 28,
    slug: "ui-purge-nocut",
    customer: "New Cafe",
    unlocked: true,
    token: true,
    verify: "ok",
  },
  purgelocked: {
    n: 29,
    slug: "ui-purge-locked",
    customer: "Locked Cafe",
    ...READY,
    unlocked: false,
  },
  // rollout.spec.js: the canary a rollout deploys first. Its live sha(6) is
  // newer than main (the fake compare says "behind"), so main moves it back.
  demo: {
    n: 30,
    slug: "demo",
    customer: "Demo Cafe",
    ...READY,
    last: () => version(6),
  },
};
const task = (status, extra = {}) => ({
  id: randomUUID(),
  kind: "db-backup",
  status,
  step: status === "running" ? "dump" : status,
  progress:
    status === "running"
      ? { collections: 4, documents: 1200, bytes: 2 * 1048576 }
      : null,
  lease: { owner: "w1", until: new Date(Date.now() + 60000), fence: 1 },
  attempt: 1,
  by: { id: "u", name: "deploy owner" },
  requestedAt: ago(120000),
  finishedAt: ["queued", "running"].includes(status) ? null : new Date(),
  params: null,
  result:
    status === "succeeded"
      ? { collections: 6, documents: 4200, bytes: 3 * 1048576 }
      : null,
  error: null,
  ...extra,
});
// A purge-preview or purge slot as backend/worker/purge.js (and lease.js for
// `expired`) leaves it. `q` reads the control query: candidates, total, keep,
// ageMin (minutes since it finished), done, deleted, skipped, failed, code.
// `old` (the slot's task of the same kind, e.g. the one the panel queued)
// keeps its id, requester and params, like the worker finishing it.
const purgeTask = (kind, status, q, old) => {
  const n = (name, fallback = 0) => Number(q(name) ?? fallback),
    ended = !["queued", "running"].includes(status),
    size = n("candidates", 3),
    finishedAt = ended ? ago(n("ageMin") * 60000) : null,
    handled = n("deleted") + n("skipped") + n("failed");
  let result = null;
  if (kind === "purge-preview" && status === "succeeded")
    result = {
      at: finishedAt,
      candidates: Array.from({ length: size }, (_, i) => ({
        id: `dpl_${String(i + 1).padStart(8, "0")}SourceUpload`,
        createdAt: ago((40 + i) * 86400000),
        target: i % 2 ? "" : "production",
        state: "READY",
      })),
      total: n("total", size),
      keep: n("keep", 5),
    };
  else if (
    kind === "purge" &&
    (status === "succeeded" ||
      (status === "failed" &&
        (q("code") ?? "delete-failed") === "delete-failed"))
  )
    result = {
      deleted: n("deleted"),
      skipped: n("skipped"),
      failed: n("failed"),
    };
  const slot = {
    kind,
    status,
    step: ended ? "done" : status === "running" ? "list" : "queued",
    progress:
      kind !== "purge" || ["queued", "expired"].includes(status)
        ? null
        : status === "running"
          ? { done: n("done"), total: n("total", 3) }
          : { done: handled, total: handled },
    finishedAt,
    result,
    error:
      status === "failed"
        ? {
            code: q("code") ?? (kind === "purge" ? "delete-failed" : "failed"),
            message: "The step failed.",
          }
        : status === "expired"
          ? { code: "not-picked-up", message: "Not picked up in time." }
          : null,
  };
  const next =
    old?.kind === kind
      ? { ...old, ...slot }
      : task(status, {
          ...slot,
          params:
            kind === "purge"
              ? { ids: [], digest: "0".repeat(64), previewTaskId: randomUUID() }
              : null,
        });
  if (finishedAt && next.requestedAt > finishedAt)
    next.requestedAt = new Date(finishedAt.getTime() - 4000);
  return next;
};
const POS_CONFIG = (slug, host) => ({
  slug,
  subdomain: "cafe",
  host: host ?? `${slug}.pos.example.com`,
  tenantId: "tenant_1",
  rootDomain: "pos.example.com",
  vercel: {
    projectId: "prj_abc123",
    orgId: "team_abc123",
    teamId: "team_abc123",
    projectName: `${slug}-app`,
  },
  cloudflare: null,
  image: {
    store: "r2",
    publicBaseUrl: "https://img.example.com",
    cloudName: "",
    r2AccountId: "r2acc123",
    bucket: "images",
  },
  posAdmin: { username: "owner1" },
});
async function seedPos(name, spec = SCENARIOS[name]) {
  const id = nid("d", spec.n),
    customerId = nid("e", spec.n);
  const pos = newPos(POS_CONFIG(spec.slug, spec.host));
  if (spec.ids === false) {
    pos.vercel.projectId = "";
    pos.vercel.orgId = "";
  }
  pos.deployLock = !spec.unlocked;
  if (spec.mongo)
    pos.mongo.uri = encrypt(
      "mongodb+srv://u:p@cluster.example.test/db",
      c.VAULT_KEY,
      aadOf(id, "mongo.uri"),
    );
  pos.task = spec.task?.() ?? null;
  if (spec.usage) pos.usage = spec.usage();
  if (spec.token)
    pos.vercel.token = encrypt(
      "vercel-secret-token-1234567890",
      c.VAULT_KEY,
      aadOf(id, "vercel.token"),
    );
  if (spec.verify === "issues")
    pos.verify = {
      at: new Date(),
      by: { id: "x", name: "Owner" },
      vercel: "ok",
      project: "settings",
      env: "ok",
      mongo: "ok",
      cloudflare: null,
      health: "ok",
      problems: [
        { name: "rootDirectory", actual: "src", expected: "apps/cafe" },
      ],
      warnings: [{ name: "nodeVersion", actual: "24.x", expected: "22.x" }],
    };
  if (spec.verify === "ok")
    pos.verify = {
      at: new Date(),
      by: { id: "x", name: "Owner" },
      vercel: "ok",
      project: "ok",
      env: "ok",
      mongo: "ok",
      cloudflare: null,
      health: "ok",
    };
  pos.deploy = {
    current: spec.current?.() ?? null,
    last: spec.last?.() ?? null,
    previous: spec.previous?.() ?? null,
    cutoverAt: spec.last ? new Date() : null,
  };
  spec.extra?.(pos, id);
  await db.collection("installations").deleteOne({ _id: id });
  await db.collection("customers").deleteOne({ _id: customerId });
  await db.collection("customers").insertOne({
    _id: customerId,
    name: spec.customer,
    company: spec.customer,
    email: `${spec.slug}@example.test`,
    phone: "",
    status: "active",
    notes: "",
    storeWorkspaceId: "",
    ...stamp,
  });
  await db.collection("installations").insertOne({
    _id: id,
    name: `${spec.customer} POS production`,
    customerId,
    productId: posProduct._id,
    environment: "production",
    status: "live",
    release: "",
    sourceUrl: "",
    endpoint: "",
    connectionIds: [],
    checks: [],
    evidence: "",
    notes: "",
    ...stamp,
    pos,
  });
}
for (const name of Object.keys(SCENARIOS)) await seedPos(name);
// ---- Go-live fixtures (golive.spec.js, P5) ----------------------------------
// New clients entered by hand (P5 §3 step 1) and go-live slots as the worker
// (backend/worker/golive.js) leaves them. Kept out of SCENARIOS: they are
// seeded only by `reset?scenario=<name>` and removed by `reset?scenario=all`,
// so the fleet, overview and rollout specs never see them.
const CNAME = "0123456789abcdef.vercel-dns-017.com";
const ENV_MISSING = ["REALTIME_URL", "REALTIME_PUBLISH_SECRET", "TENANT_ID"];
// The stored slot at `phase` (running | failed | waiting-dns | waiting-deploy
// | live), built on `old` (the slot a real route wrote) when there is one.
// q: step, code, warnings=a,b, txt=1, admin=seeded|exists, realtime=1.
function goliveAt(phase, q, old, label, host) {
  const base =
    old ??
    newGolive({
      action: "start",
      branch: "main",
      sha: "a".repeat(40),
      by: { id: "u", name: "golive owner" },
      now: Date.now() - 600000,
      label,
      host,
    });
  const names = ["start", "check"].includes(base.action)
    ? GOLIVE_STEPS
    : GOLIVE_RUN_STEPS[base.action];
  const index = (name) => names.indexOf(name);
  const upto = Math.max(
    0,
    phase === "running"
      ? index(q("step") ?? names[0])
      : phase === "failed"
        ? index(q("step") ?? "project")
        : phase === "waiting-dns"
          ? index("dns")
          : phase === "waiting-deploy"
            ? index("deploy")
            : names.length,
  );
  const realtimeOn = q("realtime") === "1";
  const passed = (name) => index(name) !== -1 && index(name) < upto;
  const NOTE = {
    project: "Project created",
    secrets: "Secrets minted",
    realtime: realtimeOn
      ? "Worker uploaded"
      : "No Cloudflare token: realtime off",
    domain: "Address added",
    env: `${GOLIVE_ENV_KEYS.length} variables written`,
    admin: "Admin login created",
  };
  const steps = names.map((name, i) => ({
    name,
    state:
      i < upto
        ? name === "realtime" && !realtimeOn
          ? "skipped"
          : "done"
        : i === upto
          ? phase === "running"
            ? "running"
            : phase === "failed"
              ? "failed"
              : "pending"
          : "pending",
    startedAt: i <= upto ? ago(300000 - i * 10000) : null,
    endedAt: i < upto ? ago(295000 - i * 10000) : null,
    note:
      i < upto
        ? (NOTE[name] ?? "")
        : i === upto && phase === "waiting-dns"
          ? `Waiting for DNS (${q("warnings")?.split(",")[0] || "dns-pending"})`
          : "",
  }));
  const status = {
    running: "running",
    failed: "failed",
    "waiting-dns": "waiting",
    "waiting-deploy": "waiting",
    live: "live",
  }[phase];
  const ready = ["waiting-deploy", "live"].includes(phase);
  const txt = q("txt") === "1";
  const fence = base.lease?.fence ?? 0;
  return {
    ...base,
    status,
    step:
      phase === "waiting-dns"
        ? "dns"
        : phase === "waiting-deploy"
          ? "ready"
          : (names[Math.min(upto, names.length - 1)] ?? "check"),
    steps,
    startedAt: base.startedAt ?? ago(300000),
    endedAt: status === "running" ? null : new Date(),
    waitingFor:
      phase === "waiting-dns"
        ? "dns"
        : phase === "waiting-deploy"
          ? "deploy"
          : null,
    lease:
      status === "running"
        ? { owner: "w1", until: new Date(Date.now() + 60000), fence: fence + 1 }
        : { owner: null, until: null, fence },
    attempt: 1,
    cancelRequested: false,
    error:
      phase === "failed"
        ? {
            step: q("step") ?? "project",
            code: q("code") ?? "project-live",
            message: "The step failed.",
          }
        : null,
    warnings: (q("warnings") ?? "").split(",").filter(Boolean),
    address:
      passed("domain") || (phase === "live" && base.address?.records?.length)
        ? {
            ...base.address,
            records: [
              { type: "CNAME", name: label, value: CNAME },
              ...(txt
                ? [
                    {
                      type: "TXT",
                      name: `_vercel.${label}`,
                      value: `vc-domain-verify=${host},5f3a9c`,
                    },
                  ]
                : []),
            ],
            cname:
              phase === "waiting-dns"
                ? { ok: false, found: null }
                : { ok: true, found: CNAME },
            txt: txt
              ? phase === "waiting-dns"
                ? { ok: false, found: [] }
                : { ok: true, found: [`vc-domain-verify=${host},5f3a9c`] }
              : null,
            verified: ready,
            configured: ready ? true : phase === "waiting-dns" ? false : null,
            tls: phase === "live",
            // As the dns step stores it.
            state: addressStateOf({
              verified: ready,
              configured: ready ? true : phase === "waiting-dns" ? false : null,
              reachable: phase === "live",
              hasTxtRow: txt,
              answeredAs: null,
            }),
            checkedAt: ["waiting-dns", "waiting-deploy", "live"].includes(phase)
              ? ago(60000)
              : null,
          }
        : base.address,
    env: passed("env")
      ? {
          at: ago(240000),
          keys: GOLIVE_ENV_KEYS.map((name) => ({
            name,
            type: "encrypted",
            targets: ["production", "preview"],
            set: true,
            fp16: "0123456789abcdef",
            updatedAt: Date.now() - 240000,
          })),
        }
      : base.env,
    admin: passed("admin")
      ? { state: q("admin") ?? "seeded", at: ago(200000) }
      : base.admin,
    realtime:
      realtimeOn && passed("realtime")
        ? {
            bundleSha256: "d".repeat(64),
            sha: base.sha,
            tenantId: label,
            deployedAt: ago(250000),
            verifiedAt: ago(250000),
          }
        : base.realtime,
    deployRequestId:
      phase === "live"
        ? (base.deployRequestId ?? randomUUID())
        : base.deployRequestId,
    liveAt: phase === "live" ? (base.liveAt ?? new Date()) : base.liveAt,
  };
}
// The slot plus the POS fields the same worker steps write.
function applyGolive(pos, phase, q, id) {
  const label = pos.subdomain,
    host = `${label}.sandbee.in`;
  if (!pos.golive) {
    // What Start writes (backend/modules/golive.js).
    pos.host = host;
    pos.tenantId = label;
    pos.rootDomain = "sandbee.in";
  }
  const g = goliveAt(phase, q, pos.golive ?? null, label, host);
  pos.golive = g;
  if (g.steps.some((s) => s.name === "project" && s.state === "done")) {
    pos.vercel.projectId = `prj_gl${String(id).slice(-4)}`;
    pos.vercel.orgId = "team_gl";
    pos.vercel.projectName = pos.slug;
    g.projectId = pos.vercel.projectId;
  }
  // The worker runs against the stored rev and records it with the env and
  // the admin login (Unlock and deploy refuses a later change).
  pos.rev = pos.rev ?? 1;
  g.rev = pos.rev;
  if (g.env) g.env = { ...g.env, rev: pos.rev };
  if (g.admin) g.admin = { ...g.admin, rev: pos.rev };
  const verify = (health) => ({
    at: new Date(),
    by: { id: "w", name: "Worker" },
    vercel: "ok",
    project: "ok",
    env: "ok",
    mongo: "ok",
    cloudflare: null,
    health,
  });
  // ready: the inline bootstrap verify (D47); live: the finish step's verify.
  if (phase === "waiting-deploy") pos.verify = verify("not-deployed");
  if (phase === "live") {
    pos.verify = verify("ok");
    pos.deployLock = false;
    pos.unlockedAt = pos.unlockedAt ?? new Date();
    pos.deploy = {
      ...pos.deploy,
      current: null,
      last: version(9, { requestId: g.deployRequestId, sha: "a".repeat(40) }),
      cutoverAt: new Date(),
    };
  }
}
// A client entered by hand: label = slug, no project ids, locked, never
// deployed, every secret it needs.
const newClient =
  (phase, params = {}, cloudflare = null) =>
  (pos, id) => {
    pos.subdomain = pos.slug;
    pos.host = "";
    pos.tenantId = "";
    pos.rootDomain = "";
    pos.vercel = { ...pos.vercel, projectId: "", orgId: "", projectName: "" };
    pos.cloudflare = cloudflare;
    pos.image.keys = encrypt(
      JSON.stringify({ accessKeyId: "AKIDUI", secretAccessKey: "ui-secret" }),
      c.VAULT_KEY,
      aadOf(id, "image.keys"),
    );
    // What the secrets step mints before the admin step seeds the login.
    pos.posAdmin.password = encrypt(
      "Ui#Admin-Pass1",
      c.VAULT_KEY,
      aadOf(id, "posAdmin.password"),
    );
    if (phase) applyGolive(pos, phase, (name) => params[name] ?? null, id);
  };
const GOLIVE_CLIENT = {
  token: true,
  mongo: true,
  unlocked: false,
  verify: null,
};
const GOLIVE_SCENARIOS = {
  glstart: {
    n: 31,
    slug: "ui-gl-start",
    customer: "Golive Start Cafe",
    ...GOLIVE_CLIENT,
    extra: newClient(null),
  },
  glwait: {
    n: 32,
    slug: "ui-gl-wait",
    customer: "Golive Wait Cafe",
    ...GOLIVE_CLIENT,
    extra: newClient("waiting-dns", { warnings: "dns-pending", txt: "1" }),
  },
  glfail: {
    n: 33,
    slug: "ui-gl-fail",
    customer: "Golive Fail Cafe",
    ...GOLIVE_CLIENT,
    extra: newClient("failed", { step: "project", code: "project-live" }),
  },
  gllive: {
    n: 34,
    slug: "ui-gl-live",
    customer: "Golive Live Cafe",
    ...GOLIVE_CLIENT,
    extra: newClient("live", { warnings: "redirect-failed", admin: "exists" }),
  },
  // Session 4 open item 1: a Worker URL entered by hand, no Cloudflare token.
  glworker: {
    n: 35,
    slug: "ui-gl-worker",
    customer: "Golive Worker Cafe",
    ...GOLIVE_CLIENT,
    extra: newClient(
      null,
      {},
      {
        accountId: "",
        workerName: "pos-realtime-ui-gl-worker",
        workerUrl: "https://pos-realtime-ui-gl-worker.demo.workers.dev",
      },
    ),
  },
  // An imported client whose Vercel env misses keys (verify warning, D43).
  envmissing: {
    n: 36,
    slug: "ui-env-missing",
    customer: "Env Missing Cafe",
    ...READY,
    extra: (pos) => {
      pos.importedAt = new Date();
      pos.verify.envKeysMissing = ENV_MISSING;
    },
  },
};
const goliveSpecOf = (name) => GOLIVE_SCENARIOS[name];
// Fake GitHub (branches, commits, compare) and build cache: no network. main's
// head has a stored build, feature/x does not. A live commit of sha(7) has a
// different history from main.
const fakeGitHub = createFakeGitHub();
const realGitHub = createGitHub({
  sourceRepo: SRC,
  sourceToken: `github_pat_${"S".repeat(60)}`,
  builderRepo: BLD,
  builderToken: `github_pat_${"B".repeat(60)}`,
  fetch: fakeGitHub.fetch,
  sleep: async () => {},
});
const github = {
  ...realGitHub,
  configured: () => ({ source: true, builder: true }),
  compare: (base, head, options) =>
    base === sha(7)
      ? Promise.resolve({ status: "diverged", aheadBy: 1, behindBy: 1 })
      : base === sha(6)
        ? Promise.resolve({ status: "behind", aheadBy: 0, behindBy: 2 })
        : realGitHub.compare(base, head, options),
};
fakeGitHub.state.branches[0].sha = "a".repeat(40);
fakeGitHub.state.branches[1].sha = "b".repeat(40);
const stored = new Set(["a".repeat(40)]);
const buildCache = {
  lookup: async ({ sha: head }) =>
    stored.has(head)
      ? { state: "hit", manifest: { builtAt: ago(2 * 3600000).toISOString() } }
      : { state: "miss", reason: "absent" },
};
// The worker heartbeat (online unless a spec switches it off).
let workerOnline = true;
let builderMode = "ok";
const beat = async () => {
  if (!workerOnline) return;
  await db.collection("system_state").updateOne(
    { _id: "pos-worker" },
    {
      $set: {
        at: new Date(),
        workerId: "w1",
        version: "1.0.0",
        cliVersion: "39.1.0",
        builderConfigured: builderMode !== "noconf",
        builder:
          builderMode === "missing"
            ? null
            : {
                sha: SHAS.c,
                nodeVersion: "22.11.0",
                cliVersion: "39.1.0",
                ok: builderMode !== "notok",
                checkedAt:
                  builderMode === "stale" ? ago(2 * 3600000) : new Date(),
              },
        lastBuildMs: 150000,
      },
    },
    { upsert: true },
  );
};
await beat();
const heartbeat = setInterval(() => beat().catch(() => {}), 15000);

mkdirSync("test-results", { recursive: true });
const app = createApp({
  db,
  client,
  c,
  s3: createFakeS3().client(),
  github,
  buildCache,
  sendCode: async (email, code) =>
    writeFileSync(
      `test-results/otp-${email.split("@")[0]}.json`,
      JSON.stringify({ code }),
    ),
  // sales.spec.js reads what would have been e-mailed (never sent anywhere).
  sendDocument: async (to, message) =>
    writeFileSync(
      "test-results/sales-mail.json",
      JSON.stringify({
        to,
        subject: message.subject,
        filename: message.filename,
        pdf: message.content.subarray(0, 5).toString("latin1"),
      }),
    ),
});
// `failing` makes matching API reads answer 503 (stale-banner specs).
let failing = "";
const server = createServer((req, res) => {
  if (failing && req.url.includes(failing)) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Service unavailable." }));
  }
  app(req, res);
}).listen(8108, "127.0.0.1");
// recovery.spec.js: stands in for the verify-key CLI (same task) on a loopback
// control port, since the specs cannot reach the in-memory database.
await verifyVaultKey(db, c.VAULT_KEY);
const control = createServer(async (req, res) => {
  const url = new URL(req.url, "http://control");
  if (req.method === "POST" && url.pathname.startsWith("/pos/")) {
    // POS fixtures: /pos/reset?scenario=NAME|all, /pos/worker?state=...,
    // /pos/job?scenario=NAME&status=..&step=.. (stands in for the worker).
    const scenario = url.searchParams.get("scenario");
    const query = (name) => url.searchParams.get(name);
    if (url.pathname === "/pos/reset") {
      if (goliveSpecOf(scenario))
        await seedPos(scenario, goliveSpecOf(scenario));
      else
        for (const name of scenario === "all"
          ? Object.keys(SCENARIOS)
          : [scenario])
          await seedPos(name);
      // The go-live clients exist only while golive.spec.js runs.
      if (scenario === "all")
        for (const spec of Object.values(GOLIVE_SCENARIOS)) {
          await db
            .collection("installations")
            .deleteOne({ _id: nid("d", spec.n) });
          await db.collection("customers").deleteOne({ _id: nid("e", spec.n) });
        }
      // No spec ever starts with a rollout left over from another one.
      await db.collection("system_state").deleteOne({ _id: "pos-rollout" });
    } else if (url.pathname === "/pos/golive") {
      // /pos/golive?scenario=NAME&phase=running|failed|waiting-dns|
      // waiting-deploy|live[&step=..&code=..&warnings=a,b&txt=1&admin=..]:
      // moves the go-live slot (and the POS fields its steps write) as the
      // go-live worker lane would. Keeps the run a real route created.
      const spec = goliveSpecOf(scenario);
      if (!spec) return res.writeHead(404).end('{"error":"No such client."}');
      const id = nid("d", spec.n);
      const row = await db.collection("installations").findOne({ _id: id });
      applyGolive(row.pos, query("phase") ?? "running", query, id);
      await db
        .collection("installations")
        .updateOne({ _id: id }, { $set: { pos: row.pos } });
    } else if (url.pathname === "/pos/rollout") {
      // Moves the row a real POST /pos/rollout created, as the worker would:
      // ?target=SLUG&tstatus=..[&code=..&items=a,b] (one client),
      // ?prebuild=SLUG:queued|joined|unavailable, ?stop=SLUG:CODE,
      // ?status=running|cancelling|stopped|cancelled|completed; ?clear=1
      // deletes it. Never creates a row.
      const rollouts = db.collection("system_state");
      if (query("clear") === "1") {
        await rollouts.deleteOne({ _id: "pos-rollout" });
        return res.writeHead(200).end("{}");
      }
      const row = await rollouts.findOne({ _id: "pos-rollout" });
      if (!row) return res.writeHead(409).end('{"error":"No rollout."}');
      const now = new Date(),
        targets = row.targets.map((t) => ({ ...t })),
        find = (slug) => targets.find((t) => t.slug === slug),
        next = {};
      const errorOf = (code) =>
        code
          ? {
              code,
              ...(query("items") ? { items: query("items").split(",") } : {}),
            }
          : null;
      if (query("target")) {
        const t = find(query("target"));
        if (!t) return res.writeHead(404).end('{"error":"No such client."}');
        const status = query("tstatus") ?? t.status;
        t.status = status;
        t.startedAt = status === "pending" ? null : (t.startedAt ?? now);
        t.finishedAt = ["succeeded", "failed", "skipped"].includes(status)
          ? now
          : null;
        t.requestId =
          status === "pending" ? null : (t.requestId ?? randomUUID());
        t.error = ["failed", "skipped"].includes(status)
          ? (errorOf(query("code")) ?? t.error)
          : null;
        // &job=1: the client's own deploy job, as the worker enqueued it.
        if (query("job") === "1" && ["building", "deploying"].includes(status))
          await db.collection("installations").updateOne(
            { _id: t.installationId },
            {
              $set: {
                "pos.deploy.current": job({
                  status: "running",
                  step: status === "deploying" ? "upload" : "build",
                  branch: row.branch,
                  target: row.sha,
                  requestId: t.requestId,
                }),
              },
            },
          );
      }
      if (query("prebuild")) {
        const [slug, state] = query("prebuild").split(":");
        const t = find(slug);
        if (!t) return res.writeHead(404).end('{"error":"No such client."}');
        if (!["queued", "joined", "unavailable"].includes(state))
          return res.writeHead(400).end('{"error":"No such pre-build state."}');
        t.prebuild = state;
        // No build row behind the key, so the panel reads it as ready.
        t.buildKey = ["queued", "joined"].includes(state)
          ? "ab".repeat(32)
          : null;
      }
      if (query("stop")) {
        const [slug, code] = query("stop").split(":");
        const t = find(slug);
        if (!t) return res.writeHead(404).end('{"error":"No such client."}');
        // The client it stopped at carries the reason; like the worker, a
        // freeze, lost authority or a cancel skip it, anything else fails it.
        Object.assign(t, {
          status: ["frozen", "not-authorized", "cancelled"].includes(code)
            ? "skipped"
            : "failed",
          startedAt: t.startedAt ?? now,
          finishedAt: now,
          error: errorOf(code),
        });
        next.stop = { slug, code };
      }
      const status = query("status");
      if (status) {
        next.status = status;
        next.cancelRequested = status === "cancelling";
        const ended = ["stopped", "cancelled", "completed"].includes(status);
        next.finishedAt = ended ? now : null;
        if (status === "running") next.stop = null;
        // Stopped or cancelled: the clients not reached are skipped.
        if (status === "stopped" || status === "cancelled")
          for (const t of targets)
            if (t.status === "pending")
              Object.assign(t, {
                status: "skipped",
                finishedAt: now,
                error: {
                  code: status === "stopped" ? "rollout-stopped" : "cancelled",
                },
              });
      }
      await rollouts.updateOne(
        { _id: "pos-rollout" },
        { $set: { ...next, targets } },
      );
    } else if (url.pathname === "/pos/lock") {
      // /pos/lock?scenario=NAME&on=1|0: that client's deploy lock.
      await db
        .collection("installations")
        .updateOne(
          { _id: nid("d", SCENARIOS[scenario].n) },
          { $set: { "pos.deployLock": query("on") === "1" } },
        );
    } else if (url.pathname === "/pos/freeze") {
      await db.collection("system_state").updateOne(
        { _id: "pos-deploy-freeze" },
        {
          $set: {
            on: query("on") === "1",
            reason: query("reason") ?? "",
            by: { id: "u", name: "deploy owner" },
            at: new Date(),
          },
        },
        { upsert: true },
      );
    } else if (url.pathname === "/pos/fail") {
      failing = query("match") ?? "";
    } else if (url.pathname === "/pos/worker") {
      workerOnline = query("state") !== "offline";
      builderMode = query("builder") ?? "ok";
      if (workerOnline) await beat();
      else
        await db
          .collection("system_state")
          .updateOne({ _id: "pos-worker" }, { $set: { at: ago(10 * 60000) } });
    } else if (url.pathname === "/pos/usage-check") {
      // /pos/usage-check?scenario=NAME&status=queued|running|failed|expired
      // [&code=]: the check slot as the worker leaves it at that point.
      const id = nid("d", SCENARIOS[scenario].n);
      const row = await db.collection("installations").findOne({ _id: id });
      const status = query("status") ?? "running";
      const now = Date.now();
      const old = row.pos.usage?.check ?? usageCheck("queued", now);
      const ended = !["queued", "running"].includes(status);
      await db.collection("installations").updateOne(
        { _id: id },
        {
          $set: {
            "pos.usage.check": {
              ...old,
              status,
              startedAt:
                status === "queued" ? null : (old.startedAt ?? new Date(now)),
              finishedAt: ended ? new Date(now) : null,
              error: ended
                ? {
                    code:
                      query("code") ??
                      (status === "expired" ? "not-picked-up" : "internal"),
                  }
                : null,
            },
          },
        },
      );
    } else if (url.pathname === "/pos/usage-finish") {
      // Finishes every queued or running check the way the worker does: the
      // scenario's result overwrites pos.usage.last and the slot is done.
      const now = Date.now();
      const rows = await db
        .collection("installations")
        .find(
          { "pos.usage.check.status": { $in: ["queued", "running"] } },
          { projection: { "pos.usage.check": 1 } },
        )
        .toArray();
      for (const row of rows) {
        const name = Object.keys(SCENARIOS).find(
          (key) => nid("d", SCENARIOS[key].n) === row._id,
        );
        await db.collection("installations").updateOne(
          { _id: row._id },
          {
            $set: {
              "pos.usage.last": usageLast(
                SCENARIOS[name]?.usageResult ?? "healthy",
                now,
              ),
              "pos.usage.check.status": "done",
              "pos.usage.check.startedAt":
                row.pos.usage.check.startedAt ?? new Date(now - 4000),
              "pos.usage.check.finishedAt": new Date(now),
              "pos.usage.check.error": null,
            },
          },
        );
      }
    } else if (url.pathname === "/pos/retention") {
      // /pos/retention?failed=N&missing=N&hours=H | ?clear=1: the daily build
      // retention sweep's summary in the heartbeat row.
      await db.collection("system_state").updateOne(
        { _id: "pos-worker" },
        query("clear") === "1"
          ? { $unset: { retention: "" } }
          : {
              $set: {
                retention: {
                  at: ago(Number(query("hours") ?? 1) * 3600000),
                  checked: 5,
                  copied: 2,
                  missing: Number(query("missing") ?? 0),
                  failed: Number(query("failed") ?? 0),
                },
              },
            },
        { upsert: true },
      );
    } else if (url.pathname === "/pos/task") {
      // /pos/task?scenario=NAME&status=..[&kind=purge-preview|purge&...]
      // (see purgeTask); without a kind, a db-backup task.
      const id = nid("d", SCENARIOS[scenario].n);
      const status = query("status") ?? "running",
        kind = query("kind");
      let next = task(status);
      if (kind) {
        const row = await db.collection("installations").findOne({ _id: id });
        next = purgeTask(kind, status, query, row.pos.task);
      }
      await db
        .collection("installations")
        .updateOne({ _id: id }, { $set: { "pos.task": next } });
    } else if (url.pathname === "/pos/job") {
      const id = nid("d", SCENARIOS[scenario].n);
      const row = await db.collection("installations").findOne({ _id: id });
      const old = row.pos.deploy.current;
      const status = query("status") ?? "running";
      const next =
        status === "clear"
          ? null
          : job({
              kind: query("kind") ?? old?.kind,
              claimed: query("claimed") === "1",
              branch: old?.branch,
              target: old?.sha,
              requestId: old?.requestId,
              status,
              step: query("step") ?? "build",
              stalled: query("stalled") === "1",
              runUrl: query("run") ? RUN : null,
              error:
                status === "failed"
                  ? {
                      step: query("step") ?? "build",
                      code: "build-failed",
                      message: "The build failed.",
                    }
                  : null,
            });
      await db
        .collection("installations")
        .updateOne({ _id: id }, { $set: { "pos.deploy.current": next } });
    } else return res.writeHead(404).end();
    return res.writeHead(200).end("{}");
  }
  if (req.method !== "POST" || req.url !== "/verify-key")
    return res.writeHead(404).end();

  const result = await verifyKey(
    { db, client },
    { kind: "vault", copy: "password-manager", key: c.VAULT_KEY },
  );
  res.writeHead(200).end(JSON.stringify({ match: result.match }));
}).listen(8109, "127.0.0.1");
async function stop() {
  clearInterval(heartbeat);
  server.close();
  control.close();
  try {
    await client.close();
    await repl.stop({ doCleanup: true, force: true });
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
