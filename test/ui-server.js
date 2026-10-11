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
async function seedPos(name) {
  const spec = SCENARIOS[name],
    id = nid("d", spec.n),
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
      for (const name of scenario === "all"
        ? Object.keys(SCENARIOS)
        : [scenario])
        await seedPos(name);
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
