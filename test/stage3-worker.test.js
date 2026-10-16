// P5 Stage 3 W5: the go-live worker (backend/worker/golive.js, D41-D47): the
// lane, the steps check..ready, waiting for DNS and for Unlock and deploy,
// the observed first deploy and `finish`, Sync env and Update realtime
// Worker, every failure code, kill/takeover per creating step, the stale
// revision, cancel, busy both ways and the bootstrap verify. Fakes: the W2
// Vercel/Cloudflare/DNS fakes, the W3 realtime builder, the Stage 2 builder,
// CLI and health fakes; the POS client DB is a database of the same replica
// set. The happy path goes through the real API (start, Check DNS, Unlock and
// deploy).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import { indexes } from "../backend/db.js";
import { decrypt, digest, encrypt } from "../backend/lib/crypto.js";
import { createBuildCache } from "../backend/lib/build-cache.js";
import { ClientMongoError } from "../backend/lib/client-mongo.js";
import { createDnsCheck } from "../backend/lib/dns-check.js";
import { createVercel } from "../backend/lib/vercel.js";
import { ProviderError } from "../backend/lib/provider-http.js";
import { getText, postText } from "../backend/lib/safe-https.js";
import { missingEnvKeys } from "../backend/lib/golive-env.js";
import { seedPosAdmin } from "../backend/lib/pos-admin-seed.js";
import { newGolive, newJob } from "../backend/lib/deploy-job.js";
import { goliveView, verifyView } from "../backend/lib/deploy-view.js";
import { aadOf, newPos } from "../backend/modules/pos.js";
import { buildContext, cloudflareClient } from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import { verifyStateOf } from "../shared/deploy.js";
import { isKnownCode } from "../shared/deploy-errors.js";
import { newRolloutTarget } from "../shared/rollout.js";
import { createFakeS3 } from "./fake-s3.js";
import { createFakeCli } from "./fakes/cli.js";
import {
  createFakeGitHub,
  createFakeVercel,
  createHealthGet,
} from "./fakes/builder.js";
import { RANK1_CNAME } from "./fakes/vercel.js";
import { ACCOUNT_ID, createFakeCloudflare } from "./fakes/cloudflare.js";
import { createFakeDns } from "./fakes/dns.js";
import { json } from "./fakes/github.js";
import {
  BUNDLE,
  createRealtimeBuilder,
  descriptorOf,
  sha256,
} from "./fakes/realtime-builder.js";
import { VAULT_KEY, assertNoSecrets, startApp, until } from "./helpers.js";

const CLI_VERSION = "63.1.0";
const TOKEN = "vcp_GOLIVETOKEN_0123456789abcdef0123456789";
const MONGO_PASS = "ClientPass9zGolive";
const MONGO_URI = `mongodb+srv://clientuser:${MONGO_PASS}@cluster0.abcde.mongodb.net/cafe`;
const IMAGE_ID = "AKIDGOLIVE12345";
const IMAGE_SECRET = "image-secret-key-golive-abcdef";
const IMAGE_KEYS = JSON.stringify({
  accessKeyId: IMAGE_ID,
  secretAccessKey: IMAGE_SECRET,
});
const CF_TOKEN = "cf_GOLIVETOKEN_0123456789abcdef0123";
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const R2 = "https://img.example.com";
const LABEL = "cafe1";
const HOST = `${LABEL}.sandbee.in`;
const CNAME = RANK1_CNAME.replace(/\.$/, "");
const WORKER_HOST = `pos-realtime-${LABEL}.fake-sub.workers.dev`;
const WORKER_URL = `https://${WORKER_HOST}`;
const BASE_SECRETS = [
  TOKEN,
  MONGO_URI,
  MONGO_PASS,
  VAULT_KEY,
  CF_TOKEN,
  IMAGE_ID,
  IMAGE_SECRET,
];
const OWNER = { id: "staff-1", name: "Owner" };
const never = () => new Promise(() => {});

// ---- the app (its replica set also holds every test's own database) -----------
let app, owner, product;
let counter = 0;
const workDirs = [];
// The API reads the source repo only: branch head, compare, commit.
const apiGitHub = {
  configured: () => ({ source: true, builder: false }),
  branchHead: async () => ({ ref: "main", sha: SHA1 }),
  compare: async () => ({ status: "ahead", ahead_by: 0, behind_by: 0 }),
  commit: async () => {
    throw new ProviderError("github", "not-found", { status: 404 });
  },
};
before(async () => {
  app = await startApp({
    dbName: "p5_golive_worker",
    deps: { github: apiGitHub },
  });
  owner = await app.login("owner@example.test");
  await app.db
    .collection("staff")
    .updateOne(
      { email: "owner@example.test" },
      { $set: { "totp.enabledAt": new Date() } },
    );
  product = await app.db.collection("products").findOne({ slug: "pos" });
});
after(async () => {
  await app?.stop();
  await Promise.all(
    workDirs.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});
const stepUp = (session) =>
  app.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );

// ---- fakes ------------------------------------------------------------------------------
// One Vercel account as both fakes see it: the go-live methods run on the
// stateful HTTP fake (projects, env, domains), the deploy methods on the
// adapter-level fake; the project the go-live creates (prj_new1) is the one
// the deploy job ships to, and the deploy's project read carries what the
// go-live set (name, account, node version).
function goliveVercel() {
  const v = createFakeVercel({ projectId: "prj_new1" });
  v.http.state.projects.clear();
  v.http.state.envs.length = 0;
  v.state.production = null;
  v.state.lastAlias = null;
  v.state.deployments.clear();
  const http = createVercel({
    token: "vcp_FAKETOKENFORTESTS0123456789",
    fetch: v.http.fetch,
    sleep: async () => {},
  });
  const base = v.project;
  v.project = async (projectId, options) => {
    const made = v.http.state.projects.get(projectId);
    if (!made) throw new ProviderError("vercel", "not-found", { status: 404 });
    const p = await base(projectId, options);
    return {
      ...p,
      name: made.name,
      accountId: made.accountId,
      nodeVersion: made.nodeVersion,
      sourceFilesOutsideRootDirectory: made.sourceFilesOutsideRootDirectory,
    };
  };
  v.projectEnv = (projectId, options) => http.projectEnv(projectId, options);
  return v;
}
async function openPosDb(env) {
  if (env.posOpenError) throw env.posOpenError;
  const c = new MongoClient(app.repl.getUri());
  await c.connect();
  return { client: c, db: c.db(env.posDb) };
}
async function makeEnv({ db = null, cf = {}, vercel = null } = {}) {
  const n = ++counter;
  const env = { n };
  env.db = db ?? app.client.db(`golive${n}`);
  if (!db) await indexes(env.db);
  env.posDb = `posclient${n}`;
  env.clock = { t: Date.now() };
  env.s3fake = createFakeS3();
  env.s3 = env.s3fake.client();
  env.cache = createBuildCache({
    s3: env.s3,
    vaultKey: VAULT_KEY,
    sleep: async () => {},
  });
  env.gh = createFakeGitHub({ cliVersion: CLI_VERSION });
  env.rt = createRealtimeBuilder();
  env.vercel = vercel ?? goliveVercel();
  env.cf = createFakeCloudflare(cf);
  env.dns = createFakeDns();
  env.health = createHealthGet(env.vercel, { tenant: LABEL });
  env.mongoPing = async () => "ok";
  env.publishStatus = null; // a forced /publish answer (403/401/400)
  env.tls = () =>
    env.vercel.state.production
      ? { ok: true, status: 200, code: null }
      : { ok: false, status: 0, code: "cert-pending" };
  env.logs = [];
  env.notices = [];
  env.uploads = 0;
  env.cli = createFakeCli({
    onRun: async (call) => {
      env.uploads++;
      const meta = call.args[call.args.indexOf("--meta") + 1].split("=")[1];
      env.vercel.createFromCli({ sandbeeRequest: meta });
    },
  });
  env.workDir = await mkdtemp(path.join(tmpdir(), "golive-test-"));
  workDirs.push(env.workDir);
  env.c = {
    VAULT_KEY,
    POS_BUILDER_REF: "main",
    POS_BUILDER_WORKFLOW: "build.yml",
    POS_WORK_DIR: env.workDir,
  };
  await env.db.collection("staff").updateOne(
    { _id: "staff-1" },
    {
      $set: {
        email: "staff1@example.test",
        name: "Owner",
        role: "owner",
        status: "active",
        authVersion: 1,
      },
    },
    { upsert: true },
  );
  return env;
}
async function makeWorker(env, over = {}) {
  const w = { dead: false };
  const ctx = await buildContext({
    c: env.c,
    db: env.db,
    client: app.client,
    s3: env.s3,
    cache: env.cache,
    notify: async (email, message) => env.notices.push({ email, ...message }),
    overrides: {
      github: env.gh,
      realtimeGitHub: env.rt,
      workDir: env.workDir,
      cliVersion: CLI_VERSION,
      vercelFor: () => env.vercel,
      runCli: env.cli.runCli,
      healthGet: env.health.get,
      pingMongo: (uri) => env.mongoPing(uri),
      cloudflareVerify: async () => ({ ok: true }),
      cloudflareFor: (token) =>
        cloudflareClient(token, { fetch: env.cf.fetch, sleep: async () => {} }),
      dnsCheck: createDnsCheck({
        dns: env.dns.dns,
        Resolver: env.dns.Resolver,
      }),
      openClientDb: () => openPosDb(env),
      realtimeProbe: {
        get: (host, p, o) => getText(host, p, { ...o, send: env.cf.send }),
        post: async (host, p, body, o) => {
          if (env.publishStatus)
            return { status: env.publishStatus, headers: {}, text: "" };
          return postText(host, p, body, { ...o, send: env.cf.send });
        },
      },
      tlsProbe: async (host) => env.tls(host),
      sleep: async () => {
        if (w.dead) return never();
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => env.clock.t,
      log: (event, fields) => env.logs.push({ event, ...fields }),
      t: {
        heartbeatMs: 1e9,
        leaseMs: 60000,
        pollMs: 1,
        buildPollMs: 1,
        buildPollMaxMs: 1,
        buildWaitMs: 1,
        vercelPollMs: 1,
        healthIntervalMs: 1,
        metaAttempts: 2,
        metaDelayMs: 1,
        purgeDelayMs: 0,
        retentionCheckMs: 1e12,
      },
      ...over,
    },
  });
  const loop = createLoop(ctx);
  await loop.boot();
  Object.assign(w, { ctx, loop });
  return w;
}
const kill = async (w) => {
  w.dead = true;
  w.ctx.killed = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
};

// ---- data -------------------------------------------------------------------------------
// A new client entered by hand (plan §3 step 1) as the API's Start leaves it:
// host/tenant/root domain derived, no project ids, locked, never deployed.
async function seedClient(
  env,
  {
    slug = LABEL,
    label = slug,
    realtime = false,
    productId = "pos",
    over = {},
  } = {},
) {
  const id = randomUUID(),
    customerId = randomUUID();
  await env.db.collection("customers").insertOne({
    _id: customerId,
    name: `Customer ${slug}`,
    email: `${slug}-${id.slice(0, 6)}@example.test`,
    status: "active",
    updatedAt: new Date(),
  });
  const pos = newPos({
    slug,
    subdomain: label,
    host: `${label}.sandbee.in`,
    tenantId: label,
    rootDomain: "sandbee.in",
    vercel: { projectId: "", orgId: "", teamId: "", projectName: "" },
    cloudflare: realtime
      ? { accountId: "", workerName: "", workerUrl: "" }
      : null,
    image: {
      store: "r2",
      publicBaseUrl: R2,
      cloudName: "",
      r2AccountId: "r2acc123",
      bucket: "images",
    },
    posAdmin: { username: "owner1" },
  });
  const box = (field, value) => encrypt(value, VAULT_KEY, aadOf(id, field));
  pos.vercel.token = box("vercel.token", TOKEN);
  pos.mongo.uri = box("mongo.uri", MONGO_URI);
  pos.image.keys = box("image.keys", IMAGE_KEYS);
  if (realtime) pos.cloudflare.token = box("cloudflare.token", CF_TOKEN);
  Object.assign(pos, over);
  await env.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId,
    name: `${slug} POS`,
    status: "planned",
    environment: "production",
    updatedAt: new Date(),
    pos,
  });
  return id;
}
// What the API writes for start / Check DNS / Sync env / Update realtime.
async function queue(env, id, { action = "start", sha, branch } = {}) {
  const row = await rowOf(env, id);
  const g = newGolive({
    action,
    branch: ["start", "realtime"].includes(action)
      ? (branch ?? "main")
      : branch,
    sha: ["start", "realtime"].includes(action) ? (sha ?? SHA1) : sha,
    by: OWNER,
    now: env.clock.t,
    prior: row.pos.golive ?? null,
    label: row.pos.subdomain,
    host: row.pos.host,
  });
  await env.db
    .collection("installations")
    .updateOne({ _id: id }, { $set: { "pos.golive": g } });
  return g;
}
// What Unlock and deploy writes (the API test pins the route itself).
async function unlockAndDeploy(env, id) {
  const g = (await rowOf(env, id)).pos.golive;
  assert.equal(g.status, "waiting");
  assert.equal(g.waitingFor, "deploy");
  const job = newJob({
    kind: "deploy",
    branch: g.branch,
    sha: g.sha,
    by: OWNER,
    now: env.clock.t,
  });
  await env.db.collection("installations").updateOne(
    { _id: id },
    {
      $set: {
        "pos.deployLock": false,
        "pos.unlockedAt": new Date(env.clock.t),
        "pos.unlockedBy": OWNER,
        "pos.deploy.current": job,
        "pos.golive.status": "deploying",
        "pos.golive.waitingFor": null,
        "pos.golive.step": "deploy",
        "pos.golive.steps": g.steps.map((s) =>
          s.name === "deploy"
            ? { ...s, state: "running", startedAt: new Date(env.clock.t) }
            : s,
        ),
        "pos.golive.deployRequestId": job.requestId,
      },
    },
  );
  return job;
}
const rowOf = (env, id) =>
  env.db.collection("installations").findOne({ _id: id });
const goliveOf = async (env, id) => (await rowOf(env, id)).pos.golive;
const audits = (env, action) =>
  env.db
    .collection("audit_events")
    .find(action ? { action } : {})
    .toArray();
const states = (g) => Object.fromEntries(g.steps.map((s) => [s.name, s.state]));
const vcalls = (env, method, re) =>
  env.vercel.http.calls.filter((c) => c.method === method && re.test(c.path));
const envPosts = (env) => vcalls(env, "POST", /^\/v10\/projects\/[^/]+\/env$/);
const envRow = (env, key) =>
  env.vercel.http.state.envs.find((r) => r.key === key);
// The owner enters the CNAME at GoDaddy; Vercel then sees it.
const enterDns = (env, host = HOST) => {
  env.dns.add(host, "CNAME", CNAME);
  env.vercel.http.configure(host);
};
// The *.vercel.app name Vercel gives a project (the finish step redirects it).
const vercelAppName = (env, name = `${LABEL}.vercel.app`) =>
  env.vercel.http.state.domains.push({
    name,
    projectId: "prj_new1",
    verified: true,
    verification: [],
  });
async function toWaitingDeploy(env, w, id) {
  await queue(env, id);
  await w.loop.drain();
  enterDns(env);
  await queue(env, id, { action: "check" });
  await w.loop.drain();
  const g = await goliveOf(env, id);
  assert.equal(g.status, "waiting", JSON.stringify(g.error));
  assert.equal(g.waitingFor, "deploy");
}
async function goLive(env, w, id) {
  await toWaitingDeploy(env, w, id);
  await unlockAndDeploy(env, id);
  await w.loop.drain();
  const g = await goliveOf(env, id);
  assert.equal(g.status, "live", JSON.stringify(g.error));
}
// The secrets admin minted (decrypted here, only to prove they never leak).
function mintedOf(row) {
  const out = [];
  const pos = row.pos;
  for (const field of [
    "generated.authSecret",
    "generated.healthStatsToken",
    "generated.realtimePublishSecret",
    "posAdmin.password",
  ]) {
    const box = field.split(".").reduce((v, k) => v?.[k], pos);
    if (box) out.push(decrypt(box, VAULT_KEY, aadOf(row._id, field)));
  }
  return out;
}
// No secret, box or env value in anything the go-live stored, logged or audited.
async function assertClean(env, id) {
  const row = await rowOf(env, id);
  const secrets = [...BASE_SECRETS, ...mintedOf(row)];
  const pos = row.pos;
  assertNoSecrets(pos.golive, secrets, "pos.golive");
  assertNoSecrets(goliveView(pos.golive), secrets, "golive view");
  assertNoSecrets(pos.verify ?? null, secrets, "pos.verify");
  assertNoSecrets({ ...pos.vercel, token: null }, secrets, "pos.vercel");
  assertNoSecrets(
    pos.cloudflare ? { ...pos.cloudflare, token: null } : null,
    secrets,
    "pos.cloudflare",
  );
  assertNoSecrets(
    { host: pos.host, statsHost: pos.statsHost, deploy: pos.deploy },
    secrets,
    "pos",
  );
  assertNoSecrets(await audits(env), secrets, "audit");
  assertNoSecrets(
    await env.db.collection("system_state").find().toArray(),
    secrets,
    "system_state",
  );
  assertNoSecrets(env.logs, secrets, "logs");
  for (const key of pos.golive?.env?.keys ?? [])
    assert.deepEqual(Object.keys(key).sort(), [
      "fp16",
      "name",
      "set",
      "targets",
      "type",
      "updatedAt",
    ]);
}
async function posAdmins(env) {
  const c = new MongoClient(app.repl.getUri());
  await c.connect();
  try {
    return await c
      .db(env.posDb)
      .collection("staffs")
      .find({ role: "admin" })
      .toArray();
  } finally {
    await c.close();
  }
}

// ---- the happy path ---------------------------------------------------------------------
describe("go-live: the happy path through the API", () => {
  it("start -> waiting dns -> Check DNS -> waiting deploy -> Unlock and deploy -> live", async () => {
    for (const name of ["installations", "audit_events", "rate_limits"])
      await app.db.collection(name).deleteMany({});
    await app.db.collection("system_state").deleteMany({});
    const env = await makeEnv({ db: app.db });
    const w = await makeWorker(env);
    const id = await seedClient(env, {
      productId: product._id,
      over: { host: "", tenantId: "", rootDomain: "" },
    });
    vercelAppName(env);
    await stepUp(owner);
    const call = async (p, body) => {
      const res = await app.request(`/installations/${id}${p}`, {
        method: body ? "POST" : "GET",
        body,
        session: owner,
      });
      assertNoSecrets(res.data, BASE_SECRETS, p);
      return res;
    };
    const rev = async () => (await rowOf(env, id)).pos.rev;
    const started = await call("/pos/golive", {
      action: "start",
      rev: await rev(),
      branch: "main",
      sha: SHA1,
      confirm: LABEL,
    });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    await w.loop.drain();

    // 1. Every automatic step, then waiting for the records at GoDaddy.
    let g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "dns");
    assert.equal(g.lease.owner, null);
    assert.equal(g.lease.until, null);
    assert.deepEqual(states(g), {
      check: "done",
      project: "done",
      secrets: "done",
      realtime: "skipped",
      domain: "done",
      env: "done",
      admin: "done",
      dns: "pending",
      ready: "pending",
      deploy: "pending",
      finish: "pending",
    });
    assert.deepEqual(g.warnings, ["dns-pending"]);
    assert.deepEqual(g.address.records, [
      { type: "CNAME", name: LABEL, value: CNAME },
    ]);
    assert.equal(g.address.verified, true);
    assert.equal(g.address.configured, false);
    assert.equal(g.address.state, "pending-dns");
    assert.deepEqual(g.address.cname, { ok: false, found: null });
    assert.equal(g.admin.state, "seeded");
    assert.equal(g.env.keys.length, 21);
    let row = await rowOf(env, id);
    assert.equal(row.pos.vercel.projectId, "prj_new1");
    assert.equal(row.pos.vercel.orgId, "team_x");
    assert.equal(row.pos.vercel.projectName, LABEL);
    assert.equal(row.pos.statsHost, HOST);
    assert.equal(
      row.pos.deployLock,
      true,
      "still locked until Unlock and deploy",
    );
    // The project was created with bom1 and patched (node 22.x).
    const created = env.vercel.http.state.projects.get("prj_new1");
    assert.equal(created.serverlessFunctionRegion, "bom1");
    assert.equal(created.nodeVersion, "22.x");
    assert.equal(created.sourceFilesOutsideRootDirectory, true);
    // The env: buildEnv's 21 keys, realtime blank, no NEXTAUTH_URL.
    assert.equal(env.vercel.http.state.envs.length, 21);
    assert.equal(envRow(env, "TENANT_ID").value, LABEL);
    assert.equal(envRow(env, "ROOT_DOMAIN").value, "sandbee.in");
    assert.equal(envRow(env, "REALTIME_PUBLISH_URL").value, "");
    assert.equal(envRow(env, "NEXTAUTH_URL"), undefined);
    assert.deepEqual(envRow(env, "MONGODB_URI").target, [
      "production",
      "preview",
    ]);
    // The POS admin login: one admin, bcrypt of the vault password.
    const admins = await posAdmins(env);
    assert.equal(admins.length, 1);
    assert.equal(admins[0].username, "owner1");
    const [, , , adminPassword] = mintedOf(row);
    assert.ok(await bcrypt.compare(adminPassword, admins[0].password));

    // 2. Check DNS before the records exist: still waiting.
    let checked = await call("/pos/golive/check", { rev: await rev() });
    assert.equal(checked.status, 201, JSON.stringify(checked.data));
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting");
    assert.equal(g.waitingFor, "dns");
    assert.equal(g.action, "check");
    assert.equal(
      states(g).project,
      "done",
      "Check DNS keeps the earlier steps",
    );

    // 3. The owner adds the CNAME; Check DNS -> bootstrap verify -> waiting.
    enterDns(env);
    checked = await call("/pos/golive/check", { rev: await rev() });
    assert.equal(checked.status, 201);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
    assert.deepEqual(g.address.cname, { ok: true, found: CNAME });
    assert.equal(g.address.configured, true);
    assert.equal(
      g.address.tls,
      false,
      "no certificate before the first deploy",
    );
    assert.equal(g.address.state, "pending-cert");
    assert.equal(states(g).dns, "done");
    assert.equal(states(g).ready, "done");
    row = await rowOf(env, id);
    assert.equal(row.pos.verify.health, "not-deployed");
    assert.equal(verifyStateOf(row.pos.verify), "bootstrap");
    const view = await call("/pos/golive");
    assert.equal(
      view.data.allowed.deploy,
      true,
      JSON.stringify(view.data.deployBlocked),
    );

    // 4. Unlock and deploy: the normal deploy job, then finish -> live.
    const deployed = await call("/pos/golive/deploy", {
      rev: await rev(),
      confirm: LABEL,
    });
    assert.equal(deployed.status, 201, JSON.stringify(deployed.data));
    await w.loop.drain();
    g = await goliveOf(env, id);
    row = await rowOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.ok(g.liveAt instanceof Date);
    assert.equal(g.lease.owner, null);
    assert.deepEqual(
      Object.values(states(g)).filter((s) => !["done", "skipped"].includes(s)),
      [],
    );
    assert.equal(row.pos.deploy.current, null);
    assert.equal(row.pos.deploy.last.requestId, g.deployRequestId);
    assert.equal(row.pos.deploy.last.healthy, true);
    assert.equal(verifyStateOf(row.pos.verify), "ok");
    assert.equal(env.uploads, 1);
    // The *.vercel.app name now 308-redirects to the web address.
    const appName = env.vercel.http.state.domains.find(
      (d) => d.name === `${LABEL}.vercel.app`,
    );
    assert.equal(appName.redirect, HOST);
    assert.equal(appName.redirectStatusCode, 308);
    // Audits: the API's and the worker's, ids and codes only.
    const actions = (await audits(env)).map((a) => a.action);
    for (const action of [
      "pos.golive.started",
      "pos.golive.check",
      "pos.golive.deploy",
      "pos.golive.project-created",
      "pos.golive.env-synced",
      "pos.golive.admin-seeded",
      "pos.golive.live",
    ])
      assert.ok(actions.includes(action), action);
    for (const a of await audits(env))
      if (a.action.startsWith("pos.golive.") && a.actorId === "worker")
        assert.match(a.detail, /^[A-Za-z0-9_ #.=-]*$/);
    assert.equal(actions.filter((a) => a === "pos.golive.live").length, 1);
    await assertClean(env, id);
  });

  it("Cancel ends a queued run and a waiting one; the worker leaves both alone", async () => {
    await app.db.collection("installations").deleteMany({});
    await app.db.collection("rate_limits").deleteMany({});
    const env = await makeEnv({ db: app.db });
    const w = await makeWorker(env);
    const id = await seedClient(env, {
      productId: product._id,
      over: { host: "", tenantId: "", rootDomain: "" },
    });
    await stepUp(owner);
    const post = (p, body) =>
      app.request(`/installations/${id}${p}`, {
        method: "POST",
        body,
        session: owner,
      });
    const rev = async () => (await rowOf(env, id)).pos.rev;
    const startIt = async () =>
      post("/pos/golive", {
        action: "start",
        rev: await rev(),
        branch: "main",
        sha: SHA1,
        confirm: LABEL,
      });
    const first = await startIt();
    assert.equal(first.status, 201);
    const cancelled = await post("/pos/golive/cancel", {
      requestId: first.data.golive.requestId,
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "cancelled");
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 0);
    const second = await startIt();
    assert.equal(second.status, 201, JSON.stringify(second.data));
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting");
    const done = await post("/pos/golive/cancel", {
      requestId: g.requestId,
    });
    assert.equal(done.status, 200);
    const calls = env.vercel.http.calls.length;
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "cancelled");
    assert.equal(g.lease.owner, null);
    assert.equal(env.vercel.http.calls.length, calls, "nothing ran after it");
  });
});

// ---- realtime ------------------------------------------------------------------------------
describe("go-live: the realtime Worker", () => {
  it("realtime on: one bundle run, the Worker uploaded and probed, the realtime env written", async () => {
    const env = await makeEnv({ cf: { joinAfter: 3 } });
    const w = await makeWorker(env);
    const id = await seedClient(env, { realtime: true });
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(states(g).realtime, "done");
    assert.equal(env.rt.state.dispatches.length, 1);
    assert.deepEqual(env.rt.state.dispatches[0].inputs.sha, SHA1);
    assert.equal(env.cf.uploads.length, 1);
    const [upload] = env.cf.uploads;
    assert.equal(upload.name, `pos-realtime-${LABEL}`);
    assert.ok(upload.bundle.equals(BUNDLE));
    assert.deepEqual(upload.metadata.migrations, {
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["CafeRoom"] }],
    });
    assert.deepEqual(
      upload.metadata.bindings.find((b) => b.name === "TENANT_ID").text,
      LABEL,
    );
    assert.equal(
      env.cf.state.scripts[`pos-realtime-${LABEL}`].workersDev,
      true,
    );
    assert.equal(env.cf.state.joinCalls, 4, "the join probe retried");
    const row = await rowOf(env, id);
    assert.equal(row.pos.cloudflare.accountId, ACCOUNT_ID);
    assert.equal(row.pos.cloudflare.workerName, `pos-realtime-${LABEL}`);
    assert.equal(row.pos.cloudflare.workerUrl, WORKER_URL);
    assert.equal(g.realtime.bundleSha256, sha256(BUNDLE));
    assert.equal(g.realtime.sha, SHA1);
    assert.equal(g.realtime.tenantId, LABEL);
    assert.ok(g.realtime.deployedAt instanceof Date);
    assert.ok(g.realtime.verifiedAt instanceof Date);
    assert.equal(g.realtime.run, null);
    const [, , publishSecret] = mintedOf(row);
    assert.equal(
      envRow(env, "REALTIME_PUBLISH_URL").value,
      `${WORKER_URL}/publish`,
    );
    assert.equal(envRow(env, "REALTIME_PUBLISH_SECRET").value, publishSecret);
    assert.equal(
      envRow(env, "NEXT_PUBLIC_REALTIME_URL").value,
      `wss://${WORKER_HOST}/join`,
    );
    assert.equal((await audits(env, "pos.golive.realtime-deployed")).length, 1);
    // Start again (still waiting): nothing is bundled, uploaded or written again.
    await queue(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).status, "waiting");
    assert.equal(env.rt.state.dispatches.length, 1);
    assert.equal(env.cf.uploads.length, 1);
    assert.equal(envPosts(env).length, 1, "the env was not written again");
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 1);
    assert.equal(vcalls(env, "POST", /\/domains$/).length, 1);
    assert.equal((await posAdmins(env)).length, 1);
    await assertClean(env, id);
  });

  it("registers a workers.dev subdomain when the account has none (next candidate on a conflict)", async () => {
    const env = await makeEnv({
      cf: { subdomain: null, takenSubdomains: [`pos-${LABEL}`] },
    });
    const w = await makeWorker(env);
    const id = await seedClient(env, { realtime: true });
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    const sub = env.cf.state.subdomain;
    assert.match(sub, new RegExp(`^pos-${LABEL}-[0-9a-f]{4}$`));
    assert.equal(
      (await rowOf(env, id)).pos.cloudflare.workerUrl,
      `https://pos-realtime-${LABEL}.${sub}.workers.dev`,
    );
  });

  it("Update realtime Worker on a live go-live: same bundle = no upload; a new bundle uploads without migrations", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env, { realtime: true });
    await goLive(env, w, id);
    const liveAt = (await goliveOf(env, id)).liveAt;
    const posts = envPosts(env).length;
    await queue(env, id, { action: "realtime", sha: SHA2 });
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.deepEqual(g.liveAt, liveAt);
    assert.equal(env.rt.state.dispatches.length, 2);
    assert.equal(
      env.cf.uploads.length,
      1,
      "the same bundle is not uploaded again",
    );
    assert.equal(g.realtime.sha, SHA2);
    assert.equal(envPosts(env).length, posts, "the env did not change");
    // A Worker change at a new commit: uploaded, the tag already run.
    const NEXT = Buffer.from("export class CafeRoom {}\nexport default {};\n");
    env.rt.state.tweak.files = (files) => [
      { name: "index.js", data: NEXT },
      { name: "realtime.json", data: JSON.stringify(descriptorOf(NEXT)) },
    ];
    await queue(env, id, { action: "realtime", sha: SHA1 });
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.equal(env.cf.uploads.length, 2);
    assert.equal(env.cf.uploads[1].metadata.migrations, undefined);
    assert.equal(g.realtime.bundleSha256, sha256(NEXT));
    assert.equal((await audits(env, "pos.golive.realtime-deployed")).length, 2);
    await assertClean(env, id);
  });

  it("self-heals a Worker that refuses the publish once (one upload), then gives up with the code", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env, { realtime: true });
    await goLive(env, w, id);
    // The Worker answers 401 (secret drifted): one re-upload, still 401.
    env.publishStatus = 401;
    await queue(env, id, { action: "realtime", sha: SHA1 });
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "realtime-secret-mismatch");
    assert.equal(g.error.step, "realtime");
    assert.equal(env.cf.uploads.length, 2, "exactly one self-heal upload");
    assert.ok(g.liveAt, "still live for the panel: Sync env stays allowed");
  });
});

// ---- Sync env -------------------------------------------------------------------------------
describe("go-live: Sync env", () => {
  it("writes only when something changed (new keys, a hand edit) and goes back to live", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await goLive(env, w, id);
    const liveAt = (await goliveOf(env, id)).liveAt;
    const posts = () => envPosts(env).length;
    const before = posts();
    await queue(env, id, { action: "sync-env" });
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.deepEqual(g.liveAt, liveAt);
    assert.deepEqual(states(g), { secrets: "done", env: "done" });
    assert.equal(posts(), before, "nothing changed: no write");
    // The owner replaced the image keys (the API bumps rev): written.
    const fp = (name) => g.env.keys.find((k) => k.name === name).fp16;
    const oldFp = fp("R2_ACCESS_KEY_ID");
    const NEW_KEYS = JSON.stringify({
      accessKeyId: "AKIDROTATED9876",
      secretAccessKey: "rotated-image-secret-xyz",
    });
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.image.keys": encrypt(
            NEW_KEYS,
            VAULT_KEY,
            aadOf(id, "image.keys"),
          ),
        },
        $inc: { "pos.rev": 1 },
      },
    );
    await queue(env, id, { action: "sync-env" });
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.equal(posts(), before + 1);
    assert.notEqual(fp("R2_ACCESS_KEY_ID"), oldFp);
    assert.equal(envRow(env, "R2_ACCESS_KEY_ID").value, "AKIDROTATED9876");
    // A value edited by hand on Vercel (updatedAt newer): restored.
    const tier = envRow(env, "HOSTING_TIER");
    tier.value = "A";
    tier.updatedAt += 1e9;
    await queue(env, id, { action: "sync-env" });
    await w.loop.drain();
    assert.equal(posts(), before + 2);
    assert.equal(envRow(env, "HOSTING_TIER").value, "B");
    assert.equal((await audits(env, "pos.golive.env-synced")).length, 3);
    await assertClean(env, id);
  });
});

// ---- DNS -------------------------------------------------------------------------------------
describe("go-live: the web address", () => {
  it("shows the TXT row Vercel asks for and waits for it, then for Vercel's verify", async () => {
    const env = await makeEnv();
    env.vercel.http.state.newDomainsVerified = false;
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    const txt = g.address.records.find((r) => r.type === "TXT");
    assert.deepEqual(txt, {
      type: "TXT",
      name: "_vercel",
      value: "vc-domain-verify=fake,0123456789abcdef",
    });
    assert.equal(g.address.state, "pending-verify");
    enterDns(env);
    await queue(env, id, { action: "check" });
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.waitingFor, "dns");
    assert.deepEqual(g.warnings, ["txt-pending"]);
    assert.deepEqual(g.address.txt, { ok: false, found: [] });
    env.dns.add("_vercel.sandbee.in", "TXT", txt.value);
    env.vercel.http.state.verifyPasses = true;
    await queue(env, id, { action: "check" });
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.waitingFor, "deploy", JSON.stringify(g));
    assert.deepEqual(g.address.txt, { ok: true, found: [txt.value] });
    assert.equal(g.address.verified, true);
  });

  it("a CNAME to somewhere else waits with dns-wrong-target", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    env.dns.add(HOST, "CNAME", "elsewhere.example.net");
    await queue(env, id, { action: "check" });
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting");
    assert.deepEqual(g.warnings, ["dns-wrong-target"]);
    assert.deepEqual(g.address.cname, {
      ok: false,
      found: "elsewhere.example.net",
    });
  });
});

// ---- failures -----------------------------------------------------------------------------------
const toDns = async (env, id) => {
  // The run before the failing one, then the owner's records.
  enterDns(env);
};
const CASES = [
  // [name, code, step, {realtime, cf, slug, label, setup(env, id), seed}]
  [
    "no database URI",
    "inputs-missing",
    "check",
    {
      setup: (env, id) =>
        env.db
          .collection("installations")
          .updateOne({ _id: id }, { $set: { "pos.mongo.uri": null } }),
    },
  ],
  ["a reserved label", "label-reserved", "check", { label: "admin" }],
  [
    "a foreign record on the label",
    "label-in-use-dns",
    "check",
    { setup: (env) => env.dns.add(HOST, "CNAME", "old-host.example.net") },
  ],
  [
    "the nameservers do not answer",
    "dns-unreachable",
    "check",
    { setup: (env) => env.dns.failNs(true) },
  ],
  [
    "Vercel rejects the token",
    "vercel-unauthorized",
    "check",
    {
      setup: (env) =>
        (env.vercel.state.userError = new ProviderError(
          "vercel",
          "unauthorized",
          {
            status: 401,
          },
        )),
    },
  ],
  [
    "the database is not Atlas",
    "not-atlas",
    "check",
    { setup: (env) => (env.mongoPing = async () => "not-atlas") },
  ],
  [
    "a Cloudflare token valid only in the future",
    "cloudflare-denied",
    "check",
    { realtime: true, cf: { access: "future-403" } },
  ],
  [
    "a Cloudflare token reaching two accounts",
    "cf-account-ambiguous",
    "check",
    {
      realtime: true,
      cf: {
        accountList: [
          { id: "0123456789abcdef0123456789abcdef" },
          { id: "fedcba9876543210fedcba9876543210" },
        ],
      },
    },
  ],
  [
    "a slug too long for a Worker name",
    "realtime-name",
    "check",
    { realtime: true, slug: `a${"b".repeat(50)}`, label: LABEL },
  ],
  [
    "a project of that name that is already live",
    "project-live",
    "project",
    {
      setup: (env) =>
        env.vercel.http.addProject({ name: LABEL, production: true }),
    },
  ],
  [
    "Vercel refuses the project name",
    "project-name-taken",
    "project",
    {
      setup: (env) =>
        env.vercel.http.rule(
          (m, p) => m === "POST" && p === "/v11/projects",
          () => json(409, { error: { code: "conflict" } }),
          { times: -1 },
        ),
    },
  ],
  [
    "a recorded project this token cannot see",
    "project-not-found",
    "project",
    {
      setup: (env, id) =>
        env.db.collection("installations").updateOne(
          { _id: id },
          {
            $set: {
              "pos.vercel.projectId": "prj_gone",
              "pos.vercel.orgId": "team_x",
            },
          },
        ),
    },
  ],
  [
    "the address is on another project",
    "domain-taken",
    "domain",
    { setup: (env) => env.vercel.http.domainOnOtherProject(HOST) },
  ],
  [
    "Vercel refuses an env row",
    "env-upsert-failed",
    "env",
    { setup: (env) => env.vercel.http.state.envFailKeys.add("TENANT_ID") },
  ],
  [
    "Vercel's env differs from what was written",
    "env-parity",
    "env",
    {
      setup: (env) =>
        env.vercel.http.rule(
          (m, p) => m === "GET" && p === "/v10/projects/prj_new1/env",
          () =>
            json(200, {
              envs: env.vercel.http.state.envs.map((r) =>
                r.key === "HOSTING_TIER" ? { ...r, target: ["production"] } : r,
              ),
            }),
          { times: -1 },
        ),
    },
  ],
  [
    "the realtime bundle run fails",
    "realtime-bundle-failed",
    "realtime",
    {
      realtime: true,
      setup: (env) => (env.rt.state.tweak.fail = "Bundle with wrangler"),
    },
  ],
  [
    "the realtime descriptor is outside the allowlist",
    "realtime-descriptor",
    "realtime",
    {
      realtime: true,
      setup: (env) =>
        (env.rt.state.tweak.files = (files) =>
          files.map((f) =>
            f.name === "realtime.json"
              ? {
                  ...f,
                  data: JSON.stringify(
                    descriptorOf(BUNDLE, {
                      compatibilityFlags: ["nodejs_compat"],
                    }),
                  ),
                }
              : f,
          )),
    },
  ],
  [
    "Cloudflare refuses the upload (migrations at the current tag)",
    "realtime-upload-failed",
    "realtime",
    {
      realtime: true,
      setup: (env) => (env.cf.state.uploadFail = { status: 412, code: 10079 }),
    },
  ],
  [
    "the Worker never answers /join",
    "realtime-probe-failed",
    "realtime",
    { realtime: true, cf: { joinAfter: 1000 } },
  ],
  [
    "the Worker serves another tenant",
    "realtime-tenant-refused",
    "realtime",
    { realtime: true, setup: (env) => (env.publishStatus = 403) },
  ],
  [
    "the Worker refuses the probe envelope",
    "realtime-envelope",
    "realtime",
    { realtime: true, setup: (env) => (env.publishStatus = 400) },
  ],
  [
    "the client database refuses the login",
    "admin-seed-failed",
    "admin",
    {
      setup: (env) => (env.posOpenError = new ClientMongoError("auth-failed")),
    },
  ],
  [
    "the database fails the inline verify",
    "unreachable",
    "ready",
    {
      // Check DNS runs no check step: the inline verify is the first ping.
      twoRuns: true,
      setup: (env) => (env.mongoPing = async () => "unreachable"),
    },
  ],
];
describe("go-live: every failure code the worker can produce", () => {
  for (const [name, code, step, opt] of CASES)
    it(`${name} -> ${code} (${step})`, async () => {
      assert.ok(isKnownCode(code), code);
      const env = await makeEnv({ cf: opt.cf ?? {} });
      const w = await makeWorker(env);
      const id = await seedClient(env, {
        realtime: Boolean(opt.realtime),
        ...(opt.slug ? { slug: opt.slug } : {}),
        ...(opt.label ? { label: opt.label } : {}),
      });
      if (opt.twoRuns) {
        await queue(env, id);
        await w.loop.drain();
        await toDns(env, id);
      }
      await opt.setup?.(env, id);
      await queue(env, id, { action: opt.twoRuns ? "check" : "start" });
      await w.loop.drain();
      const g = await goliveOf(env, id);
      assert.equal(g.status, "failed", JSON.stringify(g));
      assert.equal(g.error.code, code);
      assert.equal(g.error.step, step);
      assert.ok(g.error.message.length > 0 && g.error.message.length <= 160);
      assert.equal(g.lease.owner, null);
      assert.ok(g.endedAt instanceof Date);
      assert.equal(states(g)[step], "failed");
      const failed = await audits(env, "pos.golive.failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].actorId, "worker");
      assert.match(failed[0].detail, new RegExp(`^${step} ${code} #`));
      await assertClean(env, id);
    });

  it("a POS admin that is not ours is kept: warning admin-exists, the run goes on", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    const c = new MongoClient(app.repl.getUri());
    await c.connect();
    await c.db(env.posDb).collection("staffs").insertOne({
      name: "Boss",
      username: "boss",
      role: "admin",
      password: "x",
    });
    await c.close();
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting");
    assert.deepEqual(g.admin.state, "exists");
    assert.deepEqual(g.warnings, ["admin-exists", "dns-pending"]);
    assert.equal((await posAdmins(env)).length, 1);
    assert.equal((await audits(env, "pos.golive.admin-seeded")).length, 0);
  });

  it("settings changed under a running go-live -> golive-stale", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    const real = env.vercel.createProject;
    env.vercel.createProject = async (...args) => {
      const p = await real(...args);
      await env.db
        .collection("installations")
        .updateOne({ _id: id }, { $inc: { "pos.rev": 1 } });
      return p;
    };
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "golive-stale");
    assert.equal(g.error.step, "project");
    assert.equal(
      (await rowOf(env, id)).pos.vercel.projectId,
      "",
      "not written",
    );
    assert.equal(vcalls(env, "POST", /\/domains$/).length, 0);
  });

  it("cancel asked while a step runs stops the run before the next step", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    const real = env.vercel.createProject;
    env.vercel.createProject = async (...args) => {
      const p = await real(...args);
      await env.db
        .collection("installations")
        .updateOne(
          { _id: id },
          { $set: { "pos.golive.cancelRequested": true } },
        );
      return p;
    };
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "cancelled");
    assert.equal(g.error.code, "golive-cancelled");
    assert.equal(states(g).project, "done");
    assert.equal(states(g).secrets, "pending");
    assert.equal(g.lease.owner, null);
    assert.equal(vcalls(env, "POST", /\/domains$/).length, 0);
    assert.equal((await audits(env, "pos.golive.failed")).length, 0);
  });

  it("a worker that died three times -> worker-stopped; a run queued through an outage -> not-picked-up", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    const g0 = await queue(env, id);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.golive.status": "running",
          "pos.golive.step": "project",
          "pos.golive.attempt": 3,
          "pos.golive.lease": {
            owner: "w-dead",
            until: new Date(env.clock.t - 1000),
            fence: 3,
          },
        },
      },
    );
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "worker-stopped");
    assert.equal(g.requestId, g0.requestId);
    // Queued while the worker was away for more than 10 minutes.
    const env2 = await makeEnv();
    const id2 = await seedClient(env2);
    await queue(env2, id2);
    await makeWorker(env2); // boot: no heartbeat yet = stale
    g = await goliveOf(env2, id2);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "not-picked-up");
  });
});

// ---- the first deploy ------------------------------------------------------------------------------
describe("go-live: the observed first deploy", () => {
  it("a first deploy that fails its health check ends unhealthy without a rollback; the go-live fails", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await toWaitingDeploy(env, w, id);
    env.health.bad.add("dpl_1");
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    const row = await rowOf(env, id);
    const current = row.pos.deploy.current;
    assert.equal(current.status, "unhealthy");
    assert.equal(current.error.code, "health-failed");
    assert.equal(current.baseline.vercelDeploymentId, null);
    assert.equal(
      env.vercel.calledWith("rollback").length,
      0,
      "no rollback attempt",
    );
    assert.equal(row.pos.deploy.previous, null);
    assert.equal(row.pos.deploy.last.healthy, false);
    const g = row.pos.golive;
    assert.equal(g.status, "failed");
    assert.deepEqual(
      { step: g.error.step, code: g.error.code },
      { step: "deploy", code: "health-failed" },
    );
    assert.equal(states(g).deploy, "failed");
    assert.equal(g.liveAt, null);
    await assertClean(env, id);
  });

  it("a deploy job dismissed before its result was read -> job-lost", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.deploy.current": null } });
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "job-lost");
  });

  it("finish: a redirect that cannot be set is a warning; a failed inline verify fails, a new Start then finishes", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    vercelAppName(env);
    env.vercel.http.rule(
      (m, p) => m === "PATCH" && p.endsWith(`/domains/${LABEL}.vercel.app`),
      () => json(500, { error: { code: "internal" } }),
      { times: -1 },
    );
    // The client DB refuses once production exists (only the finish verify).
    env.mongoPing = async () =>
      env.vercel.state.production ? "auth-failed" : "ok";
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.deepEqual([g.error.step, g.error.code], ["finish", "auth-failed"]);
    assert.equal(states(g).deploy, "done");
    // Fixed: a new Start reuses everything, sees its own deploy live and finishes.
    env.mongoPing = async () => "ok";
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.deepEqual(g.warnings, ["redirect-failed"]);
    assert.equal(env.uploads, 1, "no second deploy");
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 1);
    assert.equal(envPosts(env).length, 1);
    await assertClean(env, id);
  });
});

// ---- kill / takeover ---------------------------------------------------------------------------------
describe("go-live: a killed worker's successor creates nothing twice", () => {
  // Worker `a` dies (sleeps forever, renews nothing) inside the hook `wrap`
  // installs; after its lease expired, worker `b` takes the run over.
  async function killAfter(env, id, wrap, aOver = () => ({})) {
    let a = null;
    const die = async () => {
      if (a && !a.dead) {
        await kill(a);
        await never();
      }
    };
    const restore = wrap(die);
    a = await makeWorker(env, aOver(die));
    await queue(env, id);
    a.loop.drain();
    await until(() => a.dead, { what: "the kill" });
    restore?.();
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    return b;
  }
  // Runs the real provider call, then dies (the call landed, nothing saved).
  const after = (obj, name) => (die) => {
    const real = obj[name];
    obj[name] = async (...args) => {
      const out = await real(...args);
      await die();
      return out;
    };
    return () => (obj[name] = real);
  };

  it("project: found by name and adopted, one create", async () => {
    const env = await makeEnv();
    const id = await seedClient(env);
    await killAfter(env, id, after(env.vercel, "createProject"));
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.attempt, 2);
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 1);
    assert.equal(env.vercel.http.state.projects.size, 1);
    assert.equal((await rowOf(env, id)).pos.vercel.projectId, "prj_new1");
    assert.equal((await audits(env, "pos.golive.project-adopted")).length, 1);
    assert.equal((await audits(env, "pos.golive.project-created")).length, 0);
    assert.ok(env.logs.some((l) => l.event === "golive-takeover"));
    await assertClean(env, id);
  });

  it("domain: found on the project, one add; the secrets are not minted again", async () => {
    const env = await makeEnv();
    const id = await seedClient(env);
    let boxes = null;
    await killAfter(env, id, (die) =>
      after(
        env.vercel,
        "addDomain",
      )(async () => {
        boxes = (await rowOf(env, id)).pos.generated;
        await die();
      }),
    );
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(vcalls(env, "POST", /\/domains$/).length, 1);
    assert.ok(boxes?.authSecret);
    assert.deepEqual((await rowOf(env, id)).pos.generated, boxes);
  });

  it("realtime: the dead worker's bundle run is reused (one dispatch, one upload)", async () => {
    const env = await makeEnv();
    const id = await seedClient(env, { realtime: true });
    await killAfter(env, id, (die) => {
      env.rt.state.onPoll = async (_run, n) => {
        if (n === 1) await die();
      };
      return () => (env.rt.state.onPoll = null);
    });
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(env.rt.state.dispatches.length, 1);
    assert.equal(env.cf.uploads.length, 1);
    assert.equal(g.realtime.run, null);
  });

  it("realtime: an upload that landed is not repeated", async () => {
    const env = await makeEnv();
    const id = await seedClient(env, { realtime: true });
    await killAfter(
      env,
      id,
      () => undefined,
      (die) => ({
        cloudflareFor: (token) => {
          const c = cloudflareClient(token, {
            fetch: env.cf.fetch,
            sleep: async () => {},
          });
          return {
            ...c,
            uploadWorker: async (...args) => {
              const out = await c.uploadWorker(...args);
              await die();
              return out;
            },
          };
        },
      }),
    );
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(env.cf.uploads.length, 1);
    assert.equal(env.rt.state.dispatches.length, 1);
    assert.equal(g.realtime.pending, null);
    assert.equal(g.realtime.bundleSha256, sha256(BUNDLE));
    assert.equal(
      env.cf.state.scripts[`pos-realtime-${LABEL}`].workersDev,
      true,
    );
    assert.equal((await rowOf(env, id)).pos.cloudflare.workerUrl, WORKER_URL);
    assert.equal((await audits(env, "pos.golive.realtime-deployed")).length, 1);
  });

  it("env: an upsert that landed is proven by Vercel's updatedAt, not repeated", async () => {
    const env = await makeEnv();
    const id = await seedClient(env);
    await killAfter(env, id, after(env.vercel, "upsertEnv"));
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(envPosts(env).length, 1);
    assert.equal(g.env.keys.length, 21);
    assert.equal(g.env.pending, null);
    assert.equal((await audits(env, "pos.golive.env-synced")).length, 1);
  });

  it("admin: the login the dead worker seeded counts as ours (one admin, no warning)", async () => {
    const env = await makeEnv();
    const id = await seedClient(env);
    await killAfter(
      env,
      id,
      () => undefined,
      (die) => ({
        posAdminSeed: async (args) => {
          const out = await seedPosAdmin({
            ...args,
            open: () => openPosDb(env),
          });
          await die();
          return out;
        },
      }),
    );
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.admin.state, "seeded");
    assert.deepEqual(g.warnings, ["dns-pending"]);
    assert.equal((await posAdmins(env)).length, 1);
    assert.equal((await audits(env, "pos.golive.admin-seeded")).length, 1);
  });
});

// ---- busy both ways, bootstrap verify -------------------------------------------------------------
async function enqueueVerify(env, id) {
  await env.db.collection("installations").updateOne(
    { _id: id },
    {
      $set: {
        "pos.task": {
          id: randomUUID(),
          kind: "verify",
          status: "queued",
          step: "queued",
          progress: null,
          lease: { owner: null, until: null, fence: 0 },
          attempt: 0,
          by: OWNER,
          requestedAt: new Date(env.clock.t),
          finishedAt: null,
          params: null,
          result: null,
          error: null,
        },
      },
    },
  );
}
describe("go-live: busy both ways, and the bootstrap verify", () => {
  it("a rollout stops at a client whose go-live run is active (target-busy) and enqueues nothing", async () => {
    const env = await makeEnv({ vercel: createFakeVercel() });
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.deployLock": false,
          "pos.vercel.projectId": env.vercel.state.projectId,
          "pos.vercel.orgId": "team_1",
          "pos.verify": {
            at: new Date(env.clock.t),
            by: OWNER,
            vercel: "ok",
            project: "ok",
            env: "ok",
            mongo: "ok",
            cloudflare: null,
            health: "ok",
          },
          // Another worker runs it right now (live lease).
          "pos.golive.status": "running",
          "pos.golive.lease": {
            owner: "w-other",
            until: new Date(env.clock.t + 600000),
            fence: 1,
          },
        },
      },
    );
    await env.db.collection("system_state").insertOne({
      _id: "pos-rollout",
      id: randomUUID(),
      status: "running",
      branch: "main",
      sha: SHA1,
      commit: {
        sha: SHA1,
        branch: "main",
        headline: "Rollout commit",
        authorName: "Dev",
        date: new Date(env.clock.t),
      },
      by: OWNER,
      auth: { id: "staff-1", name: "Owner", authVersion: 1, role: "owner" },
      resumed: null,
      startedAt: new Date(env.clock.t),
      finishedAt: null,
      stopOnFailure: true,
      cancelRequested: false,
      stop: null,
      prepared: false,
      lease: { owner: null, until: null, fence: 0 },
      targets: [newRolloutTarget(id, LABEL)],
    });
    await w.loop.drain();
    const rollout = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-rollout" });
    assert.equal(rollout.status, "stopped");
    assert.deepEqual(rollout.stop, { slug: LABEL, code: "target-busy" });
    const row = await rowOf(env, id);
    assert.equal(row.pos.deploy.current, null, "no deploy was enqueued");
    assert.equal(
      row.pos.golive.lease.owner,
      "w-other",
      "the run was left alone",
    );
  });

  it("Verify of a project without a production deployment: health not-deployed (bootstrap), nothing probed", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).waitingFor, "dns");
    const probes = env.health.calls.length;
    await enqueueVerify(env, id);
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(
      row.pos.task.status,
      "succeeded",
      JSON.stringify(row.pos.task.error),
    );
    assert.equal(row.pos.verify.health, "not-deployed");
    assert.equal(verifyStateOf(row.pos.verify), "bootstrap");
    assert.equal(env.health.calls.length, probes, "no health probe");
    assert.equal(
      "envKeysMissing" in row.pos.verify,
      false,
      "admin wrote this env",
    );
    assert.deepEqual(verifyView(row.pos.verify).envKeysMissing, []);
  });

  it("Verify of a client whose env admin did not write: names-only parity (env-keys-missing)", async () => {
    const env = await makeEnv({ vercel: createFakeVercel() });
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.vercel.projectId": env.vercel.state.projectId,
          "pos.vercel.orgId": "team_1",
        },
      },
    );
    env.vercel.state.envs = [
      { key: "TENANT_ID", type: "plain", target: ["production"], value: LABEL },
      {
        key: "ROOT_DOMAIN",
        type: "plain",
        target: ["production"],
        value: "sandbee.in",
      },
      {
        key: "MONGODB_URI",
        type: "encrypted",
        target: ["production"],
        value: null,
      },
    ];
    await enqueueVerify(env, id);
    await w.loop.drain();
    const verify = (await rowOf(env, id)).pos.verify;
    assert.equal(verify.env, "ok", "a warning, not a failed flag");
    assert.equal(verify.health, "ok");
    assert.deepEqual(
      verify.envKeysMissing,
      missingEnvKeys(["TENANT_ID", "ROOT_DOMAIN", "MONGODB_URI"]),
    );
    assert.ok(verify.envKeysMissing.includes("AUTH_SECRET"));
    assert.ok(isKnownCode("env-keys-missing"));
    assert.deepEqual(verifyView(verify).envKeysMissing, verify.envKeysMissing);
    assertNoSecrets(verify, BASE_SECRETS, "verify");
  });
});

// ---- session 5 review fixes ----------------------------------------------------------------
describe("go-live: session 5 review fixes", () => {
  it("a new run never reuses an earlier run's bundle run (failed, or another commit)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env, { realtime: true });
    env.rt.state.tweak.fail = "Bundle";
    await queue(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "realtime-bundle-failed");
    assert.ok(g.realtime?.run?.runId, "the failed run is on record");
    // A transient failure: the next Start (another commit) bundles afresh.
    env.rt.state.tweak = {};
    await queue(env, id, { sha: SHA2 });
    assert.equal((await goliveOf(env, id)).realtime.run, null);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(env.rt.state.dispatches.length, 2);
    assert.equal(env.rt.state.dispatches[1].inputs.sha, SHA2);
    assert.equal(g.realtime.sha, SHA2);
  });

  it("an unhealthy first deploy: Start again with a fixed commit reaches Unlock and deploy, then live", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await toWaitingDeploy(env, w, id);
    env.health.bad.add("dpl_1");
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "health-failed");
    await queue(env, id, { sha: SHA2 });
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
    const row = await rowOf(env, id);
    assert.equal(row.pos.verify.health, "first-unhealthy");
    assert.equal(verifyStateOf(row.pos.verify, env.clock.t), "bootstrap");
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.equal(env.uploads, 2);
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 1);
    await assertClean(env, id);
  });

  it("settings changed while waiting: Check DNS stops (golive-settings); running all steps again re-checks the admin login", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).waitingFor, "dns");
    assert.equal((await posAdmins(env)).length, 1);
    // The owner fixes the database URI (a secret write bumps pos.rev); the
    // new database has no admin login yet.
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $inc: { "pos.rev": 1 } });
    env.posDb = `posclient${env.n}b`;
    enterDns(env);
    await queue(env, id, { action: "check" });
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.deepEqual(
      [g.error.step, g.error.code],
      ["ready", "golive-settings"],
    );
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
    assert.equal(
      (await posAdmins(env)).length,
      1,
      "seeded in the new database",
    );
    assert.equal(g.env.rev, (await rowOf(env, id)).pos.rev);
  });

  it("a takeover after setup changed under a dead lease ends golive-stale; it waits while a task holds the client", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    const dead = (rev) => ({
      "pos.golive.rev": rev,
      "pos.golive.status": "running",
      "pos.golive.step": "check",
      "pos.golive.attempt": 1,
      "pos.golive.lease": {
        owner: "w-dead",
        until: new Date(env.clock.t - 1000),
        fence: 1,
      },
    });
    const rev = (await rowOf(env, id)).pos.rev;
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: dead(rev), $inc: { "pos.rev": 1 } });
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.equal(g.error.code, "golive-stale");
    assert.equal(vcalls(env, "POST", /^\/v11\/projects$/).length, 0);
    // A task the API let start beside the dead run: no takeover meanwhile.
    const id2 = await seedClient(env, { slug: "cafe2" });
    await queue(env, id2);
    const rev2 = (await rowOf(env, id2)).pos.rev;
    await env.db.collection("installations").updateOne(
      { _id: id2 },
      {
        $set: {
          ...dead(rev2),
          "pos.task": {
            id: randomUUID(),
            kind: "db-backup",
            status: "running",
            step: "dump",
            lease: {
              owner: "w-other",
              until: new Date(env.clock.t + 600000),
              fence: 1,
            },
            attempt: 1,
            by: OWNER,
            requestedAt: new Date(env.clock.t),
          },
        },
      },
    );
    await w.loop.drain();
    g = await goliveOf(env, id2);
    assert.equal(g.status, "running");
    assert.equal(g.lease.owner, "w-dead");
    await env.db
      .collection("installations")
      .updateOne({ _id: id2 }, { $set: { "pos.task": null } });
    await w.loop.drain();
    g = await goliveOf(env, id2);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
  });

  it("a re-Start accepts the generic Vercel CNAME its own dns step accepted", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    env.dns.add(HOST, "CNAME", "cname.vercel-dns.com");
    env.vercel.http.configure(HOST);
    await queue(env, id, { action: "check" });
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.waitingFor, "deploy", JSON.stringify(g.error));
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
  });

  it("a Cancel asked during the step that ends in waiting is not lost", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    env.tls = async () => {
      await env.db
        .collection("installations")
        .updateOne(
          { _id: id },
          { $set: { "pos.golive.cancelRequested": true } },
        );
      return { ok: false, status: 0, code: "cert-pending" };
    };
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "cancelled");
    assert.equal(g.error.code, "golive-cancelled");
    assert.equal(g.lease.owner, null);
  });

  it("Sync env never mints a new POS admin password once the login exists", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await goLive(env, w, id);
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.posAdmin.password": null } });
    await queue(env, id, { action: "sync-env" });
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(
      row.pos.golive.status,
      "live",
      JSON.stringify(row.pos.golive.error),
    );
    assert.equal(row.pos.posAdmin.password, null);
  });

  it("Verify of an imported client probes its health even without a reported production deployment", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env, { over: { importedAt: new Date() } });
    const project = await env.vercel.createProject(LABEL);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.vercel.projectId": project.id,
          "pos.vercel.orgId": project.accountId,
          "pos.vercel.projectName": project.name,
        },
      },
    );
    const probes = env.health.calls.length;
    await enqueueVerify(env, id);
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(
      row.pos.task.status,
      "succeeded",
      JSON.stringify(row.pos.task.error),
    );
    assert.notEqual(row.pos.verify.health, "not-deployed");
    assert.ok(env.health.calls.length > probes, "health probed");
  });
});

describe("go-live: re-review fixes", () => {
  it("a setup change during the first deploy: finish stops (golive-settings); Start again writes the env and needs a second deploy", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    // While the deploy builds, the owner replaces the database URI.
    const NEW_URI = MONGO_URI.replace("/cafe", "/cafe2");
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.mongo.uri": encrypt(NEW_URI, VAULT_KEY, aadOf(id, "mongo.uri")),
        },
        $inc: { "pos.rev": 1 },
      },
    );
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.deepEqual(
      [g.error.step, g.error.code],
      ["finish", "golive-settings"],
    );
    assert.equal(g.liveAt, null);
    const posts = envPosts(env).length;
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy", "production still runs the old env");
    assert.equal(envPosts(env).length, posts + 1);
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.equal(env.uploads, 2);
  });

  it("a seeded login whose stored password changed is not read as somebody else's (admin-mismatch)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).admin.state, "seeded");
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.posAdmin.password": encrypt(
            "Another#Passw0rd",
            VAULT_KEY,
            aadOf(id, "posAdmin.password"),
          ),
          // As the API stores it with every secret write.
          "pos.secretsChangedAt.posAdmin_password": new Date(
            env.clock.t + 1000,
          ),
        },
        $inc: { "pos.rev": 1 },
      },
    );
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(
      g.status,
      "failed",
      JSON.stringify([g.steps.map((x) => [x.name, x.state, x.note]), g.admin]),
    );
    assert.deepEqual([g.error.step, g.error.code], ["admin", "admin-mismatch"]);
    assert.equal(g.admin.state, "seeded", "not downgraded to exists");
    assert.equal((await posAdmins(env)).length, 1);
  });
});

describe("go-live: re-review round 2 fixes", () => {
  it("a second deploy that fails and rolls back does not lock the go-live out (no project-live)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    // Deploy #1 is healthy, but the finish verify fails (the database refuses).
    env.mongoPing = async () =>
      env.vercel.state.production ? "auth-failed" : "ok";
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.deepEqual([g.error.step, g.error.code], ["finish", "auth-failed"]);
    // The owner fixes the database URI; Start again writes the env.
    env.clock.t += 60000;
    env.mongoPing = async () => "ok";
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.mongo.uri": encrypt(
            MONGO_URI.replace("/cafe", "/cafe2"),
            VAULT_KEY,
            aadOf(id, "mongo.uri"),
          ),
          "pos.secretsChangedAt.mongo_uri": new Date(env.clock.t),
        },
        $inc: { "pos.rev": 1 },
      },
    );
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.waitingFor, "deploy", JSON.stringify(g.error));
    // Deploy #2 fails its health check and is rolled back to #1.
    env.health.bad.add("dpl_2");
    env.clock.t += 60000;
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(row.pos.deploy.current.status, "rolled-back");
    g = row.pos.golive;
    assert.equal(g.status, "failed");
    // Start again: production is still the go-live's own deploy #1, which
    // runs the old env, so it waits for another deploy (never project-live).
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
  });

  it("a login the client re-passworded in the POS stays ours; a new database with an admin only warns", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).admin.state, "seeded");
    // The client changes the password in the POS; the owner saves an
    // unrelated setting (pos.rev moves).
    const c = new MongoClient(app.repl.getUri());
    await c.connect();
    try {
      await c
        .db(env.posDb)
        .collection("staffs")
        .updateOne(
          { role: "admin" },
          { $set: { password: await bcrypt.hash("Client#Changed1", 4) } },
        );
    } finally {
      await c.close();
    }
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $inc: { "pos.rev": 1 } });
    await queue(env, id);
    await w.loop.drain();
    let g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.admin.state, "seeded");
    assert.deepEqual(g.warnings.includes("admin-exists"), false);
    // The owner points the URI at another database that has its own admin.
    env.clock.t += 60000;
    env.posDb = `posclient${env.n}c`;
    await seedPosAdmin({
      uri: MONGO_URI,
      username: "theirs",
      password: "Their#Passw0rd1",
      open: () => openPosDb(env),
    });
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: { "pos.secretsChangedAt.mongo_uri": new Date(env.clock.t) },
        $inc: { "pos.rev": 1 },
      },
    );
    await queue(env, id);
    await w.loop.drain();
    g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.admin.state, "exists");
    assert.ok(g.warnings.includes("admin-exists"));
  });
});

describe("go-live: re-review round 3 fixes", () => {
  it("a project id changed by hand to a live project is refused (project-live), even after the go-live's own deploy", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await toWaitingDeploy(env, w, id);
    env.health.bad.add("dpl_1");
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).status, "failed");
    const theirs = env.vercel.http.addProject({
      name: "theirs",
      production: true,
    });
    // The project the hand-entered id names serves its own production.
    const real = env.vercel.project;
    env.vercel.project = async (pid, options) =>
      pid === theirs
        ? {
            id: theirs,
            name: "theirs",
            accountId: "team_theirs",
            nodeVersion: "22.x",
            sourceFilesOutsideRootDirectory: true,
            productionDeploymentId: "dpl_theirs",
            lastAliasRequest: null,
          }
        : real(pid, options);
    await env.db
      .collection("installations")
      .updateOne(
        { _id: id },
        { $set: { "pos.vercel.projectId": theirs }, $inc: { "pos.rev": 1 } },
      );
    const posts = envPosts(env).length;
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "failed");
    assert.deepEqual([g.error.step, g.error.code], ["project", "project-live"]);
    assert.equal(g.projectId, "prj_new1");
    assert.equal(
      envPosts(env).length,
      posts,
      "nothing written to their project",
    );
  });

  it("after a rollback to an older version, a re-run deploys again before going live", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    env.mongoPing = async () =>
      env.vercel.state.production ? "auth-failed" : "ok";
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).error.code, "auth-failed");
    // What a Deploy-tab rollback leaves: the older version, stamped now.
    env.clock.t += 60000;
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.deploy.last.status": "rolled-back-to",
          "pos.deploy.last.at": new Date(env.clock.t),
        },
      },
    );
    env.mongoPing = async () => "ok";
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.waitingFor, "deploy");
  });

  it("re-saving the same POS admin password is no change; the client's own new password keeps the login ours", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(row.pos.golive.admin.state, "seeded");
    const same = decrypt(
      row.pos.posAdmin.password,
      VAULT_KEY,
      aadOf(id, "posAdmin.password"),
    );
    const c = new MongoClient(app.repl.getUri());
    await c.connect();
    try {
      await c
        .db(env.posDb)
        .collection("staffs")
        .updateOne(
          { role: "admin" },
          { $set: { password: await bcrypt.hash("Client#Changed1", 4) } },
        );
    } finally {
      await c.close();
    }
    env.clock.t += 60000;
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.posAdmin.password": encrypt(
            same,
            VAULT_KEY,
            aadOf(id, "posAdmin.password"),
          ),
          "pos.secretsChangedAt.posAdmin_password": new Date(env.clock.t),
        },
        $inc: { "pos.rev": 1 },
      },
    );
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "waiting", JSON.stringify(g.error));
    assert.equal(g.admin.state, "seeded");
    assert.equal(
      (await audits(env, "pos.golive.admin-seeded")).length,
      1,
      "no second seed audit",
    );
  });
});

describe("go-live: re-review round 4 fixes", () => {
  it("a stale lastAliasRequest does not make the go-live's own project read as an existing client", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    env.mongoPing = async () =>
      env.vercel.state.production ? "auth-failed" : "ok";
    await toWaitingDeploy(env, w, id);
    await unlockAndDeploy(env, id);
    await w.loop.drain();
    assert.equal((await goliveOf(env, id)).error.code, "auth-failed");
    // After a plain promote Vercel may still report an older alias request.
    env.vercel.state.lastAlias = {
      toDeploymentId: "dpl_older",
      jobStatus: "succeeded",
    };
    env.mongoPing = async () => "ok";
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.status, "live", JSON.stringify(g.error));
    assert.equal(env.uploads, 1, "no second deploy");
  });

  it("a login the client re-passworded in the POS is marked, so the page drops the hand-over", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedClient(env);
    await queue(env, id);
    await w.loop.drain();
    assert.equal(goliveView(await goliveOf(env, id)).admin.changedInPos, false);
    const c = new MongoClient(app.repl.getUri());
    await c.connect();
    try {
      await c
        .db(env.posDb)
        .collection("staffs")
        .updateOne(
          { role: "admin" },
          { $set: { password: await bcrypt.hash("Client#Changed1", 4) } },
        );
    } finally {
      await c.close();
    }
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $inc: { "pos.rev": 1 } });
    await queue(env, id);
    await w.loop.drain();
    const g = await goliveOf(env, id);
    assert.equal(g.admin.state, "seeded");
    assert.equal(goliveView(g).admin.changedInPos, true);
    assert.equal("pwFp" in goliveView(g).admin, false);
  });
});
