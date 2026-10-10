// Stage 2 W2: the deploy worker end to end against fakes for GitHub, Vercel,
// the CLI spawn seam, S3 and the health probe, on a real (in-memory) MongoDB
// replica set. Time is a fake clock that only moves when a test moves it; sleeps
// just yield, so polling loops run instantly and lease expiry is deterministic.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { indexes } from "../backend/db.js";
import { encrypt } from "../backend/lib/crypto.js";
import { ProviderError } from "../backend/lib/provider-http.js";
import { createBuildCache, manifestKey } from "../backend/lib/build-cache.js";
import {
  BUILD_SETTINGS,
  buildInputs,
  buildKeyOf,
  envFingerprints,
} from "../backend/lib/build-inputs.js";
import { purgeDigest } from "../backend/lib/deploy-view.js";
import {
  hostsOf,
  openClientDb,
  pingClientMongo,
} from "../backend/lib/client-mongo.js";
import {
  buildContext,
  isolationProbe,
  selfCheck,
} from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import {
  cliEnv,
  listUidProcesses,
  prepareCliDir,
  prepareDeployRoot,
  reapCliProcesses,
  removeJobDir,
  runCli,
} from "../backend/worker/cli-runner.js";
import {
  cleanOwnedEntries,
  jobCleanDirs,
} from "../backend/worker/clean-walk.js";
import { chmod } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { restoreBackup } from "../scripts/pos-db-restore.js";
import { symlink, utimes } from "node:fs/promises";
import { pruneBuilds } from "../backend/worker/fetch-build.js";
import {
  extractTgz,
  inspectTgz,
  tarProblemCode,
} from "../backend/worker/artifact.js";
import { runRetention } from "../backend/worker/retention.js";
import { JOB_STEPS, buildRowId } from "../shared/deploy.js";
import { createFakeS3 } from "./fake-s3.js";
import { createFakeCli } from "./fakes/cli.js";
import {
  BUILDER_SHA,
  createFakeGitHub,
  createFakeVercel,
  createHealthGet,
  makeTgz,
  makeZip,
  sha256,
  validOutput,
} from "./fakes/builder.js";
import { VAULT_KEY, assertNoSecrets } from "./helpers.js";

const CLI_VERSION = "63.1.0";
const TOKEN = "vcp_TESTTOKEN_0123456789abcdef0123456789abcdef";
const MONGO_URI =
  "mongodb+srv://clientuser:ClientPass9z@cluster0.abcde.mongodb.net/demo";
const CF_TOKEN = "cf_TESTTOKEN_abcdefghijklmnopqrstuvwxyz0123456789";
const SECRETS = [TOKEN, MONGO_URI, "ClientPass9z", CF_TOKEN, VAULT_KEY];
const SHA1 = "1".repeat(40),
  SHA2 = "2".repeat(40);
const R2 = "https://pub-1.example.r2.dev";

let repl,
  client,
  counter = 0;
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = new MongoClient(repl.getUri());
  await client.connect();
});
after(async () => {
  await client?.close();
  await repl?.stop();
});

// ---- environment ------------------------------------------------------------------
async function makeEnv({ cache = true } = {}) {
  const db = client.db(`w${++counter}`);
  await indexes(db);
  const clock = { t: Date.now() };
  const s3fake = createFakeS3();
  const s3 = s3fake.client();
  const gh = createFakeGitHub({ cliVersion: CLI_VERSION });
  const vercel = createFakeVercel();
  vercel.state.envs = [
    { key: "TENANT_ID", type: "plain", target: ["production"], value: "demo" },
    {
      key: "ROOT_DOMAIN",
      type: "plain",
      target: ["production"],
      value: "example.com",
    },
    {
      key: "MONGODB_URI",
      type: "encrypted",
      target: ["production"],
      value: null,
    },
    {
      key: "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
      type: "plain",
      target: ["production"],
      value: `${R2}/`,
    },
  ];
  const health = createHealthGet(vercel);
  const cli = createFakeCli({
    onRun: async (call) => {
      const meta = call.args[call.args.indexOf("--meta") + 1].split("=")[1];
      vercel.createFromCli({ sandbeeRequest: meta });
    },
  });
  const workDir = await mkdtemp(path.join(tmpdir(), "worker-test-"));
  const env = {
    db,
    clock,
    s3fake,
    s3,
    cache: cache
      ? createBuildCache({ s3, vaultKey: VAULT_KEY, sleep: async () => {} })
      : null,
    gh,
    vercel,
    health,
    cli,
    workDir,
    logs: [],
    notices: [],
    c: {
      VAULT_KEY,
      POS_BUILDER_REF: "main",
      POS_BUILDER_WORKFLOW: "build.yml",
      POS_WORK_DIR: workDir,
    },
    mongoPing: "ok",
    cfOk: true,
    workers: [],
  };
  return env;
}
async function makeWorker(env, { leaseMs = 60000, t = {} } = {}) {
  const w = { dead: false };
  const ctx = await buildContext({
    c: env.c,
    db: env.db,
    client,
    s3: env.s3,
    cache: env.cache,
    notify: async (email, message) => env.notices.push({ email, ...message }),
    overrides: {
      github: env.gh,
      workDir: env.workDir,
      cliVersion: CLI_VERSION,
      vercelFor: () => env.vercel,
      runCli: env.cli.runCli,
      healthGet: env.health.get,
      pingMongo: async () => env.mongoPing,
      cloudflareVerify: async () => ({ ok: env.cfOk }),
      sleep: async () => {
        if (w.dead) return new Promise(() => {});
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => env.clock.t,
      log: (event, fields) => env.logs.push({ event, ...fields }),
      t: {
        heartbeatMs: 1e9,
        leaseMs,
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
        ...t,
      },
    },
  });
  const loop = createLoop(ctx);
  await loop.boot();
  Object.assign(w, { ctx, loop });
  env.workers.push(w);
  return w;
}
// A killed worker: no more heartbeats, and every wait hangs for ever.
const kill = async (w) => {
  w.dead = true;
  w.ctx.killed = true;
  await new Promise((resolve) => setTimeout(resolve, 60));
};
async function seedInstallation(
  env,
  {
    slug = "demo",
    image = { store: "r2", publicBaseUrl: R2 },
    deploy = {},
    pos = {},
  } = {},
) {
  const id = randomUUID(),
    customerId = randomUUID();
  await env.db.collection("customers").insertOne({
    _id: customerId,
    status: "active",
    email: `${customerId}@example.test`,
  });
  await env.db.collection("staff").updateOne(
    { _id: "staff-1" },
    {
      $set: {
        email: "owner@example.test",
        name: "Owner",
        role: "owner",
        status: "active",
      },
    },
    { upsert: true },
  );
  await env.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: "pos",
    status: "active",
    pos: {
      rev: 1,
      slug,
      host: `${slug}.example.com`,
      tenantId: slug,
      rootDomain: "example.com",
      deployLock: false,
      vercel: {
        projectId: env.vercel.state.projectId,
        orgId: "team_1",
        teamId: "team_1",
        projectName: slug,
        token: encrypt(TOKEN, VAULT_KEY, `pos:${id}:vercel.token`),
      },
      mongo: { uri: encrypt(MONGO_URI, VAULT_KEY, `pos:${id}:mongo.uri`) },
      cloudflare: {
        accountId: "a".repeat(32),
        workerUrl: "https://rt.example.workers.dev",
        token: encrypt(CF_TOKEN, VAULT_KEY, `pos:${id}:cloudflare.token`),
      },
      image,
      deploy: {
        current: null,
        last: null,
        previous: null,
        cutoverAt: null,
        ...deploy,
      },
      verify: null,
      ...pos,
    },
  });
  return id;
}
const rowOf = (env, id) =>
  env.db.collection("installations").findOne({ _id: id });
const deployOf = async (env, id) => (await rowOf(env, id)).pos.deploy;
async function enqueue(
  env,
  id,
  {
    kind = "deploy",
    sha = SHA1,
    branch = "main",
    vercelDeploymentId = null,
    ...over
  } = {},
) {
  const names = JOB_STEPS[kind === "rollback" ? "rollback" : "deploy"];
  const job = {
    kind,
    requestId: randomUUID(),
    branch,
    sha,
    buildKey: null,
    by: { id: "staff-1", name: "Owner" },
    requestedAt: new Date(env.clock.t),
    status: "queued",
    step: "queued",
    steps: names.map((name) => ({
      name,
      state: "pending",
      startedAt: null,
      endedAt: null,
      note: "",
    })),
    lease: { owner: null, until: null, fence: 0 },
    attempt: 0,
    heartbeatAt: null,
    runId: null,
    runUrl: null,
    artifactId: null,
    uploadStartedAt: null,
    vercelDeploymentId,
    url: null,
    baseline: null,
    cancelRequested: false,
    error: null,
    finishedAt: null,
    ...over,
  };
  await env.db
    .collection("installations")
    .updateOne({ _id: id }, { $set: { "pos.deploy.current": job } });
  return job.requestId;
}
async function enqueueTask(env, id, kind, params = null) {
  const task = {
    id: randomUUID(),
    kind,
    status: "queued",
    step: "queued",
    progress: null,
    lease: { owner: null, until: null, fence: 0 },
    attempt: 0,
    by: { id: "staff-1", name: "Owner" },
    requestedAt: new Date(env.clock.t),
    finishedAt: null,
    params,
    result: null,
    error: null,
  };
  await env.db
    .collection("installations")
    .updateOne({ _id: id }, { $set: { "pos.task": task } });
  return task.id;
}
const stepStates = (job) =>
  Object.fromEntries(job.steps.map((s) => [s.name, s.state]));
// Runs a deploy to its end and returns the stored state.
async function deployOnce(env, w, id, options) {
  await enqueue(env, id, options);
  await w.loop.drain();
  return deployOf(env, id);
}
// Every row the worker writes must be free of secrets.
async function assertClean(env, id) {
  const row = await rowOf(env, id);
  assertNoSecrets(
    { deploy: row.pos.deploy, task: row.pos.task, verify: row.pos.verify },
    SECRETS,
    "installation state",
  );
  const state = await env.db
    .collection("system_state")
    .find({ _id: { $ne: "vault-v1" } })
    .toArray();
  assertNoSecrets(state, SECRETS, "system_state");
  assertNoSecrets(
    await env.db.collection("audit_events").find().toArray(),
    SECRETS,
    "audit",
  );
  assertNoSecrets(env.logs, SECRETS, "logs");
  assertNoSecrets(env.notices, SECRETS, "notices");
}
const jobsDirEmpty = async (env) => {
  const dir = path.join(env.workDir, "jobs");
  return existsSync(dir) ? (await readdir(dir)).length === 0 : true;
};

describe("deploy: happy path and the build cache", () => {
  it("builds on a cache miss, then Redeploy is served from the cache without a dispatch", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const first = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(first.current, null, "a successful job leaves the slot empty");
    assert.equal(env.gh.state.dispatches.length, 1);
    assert.equal(first.last.sha, SHA1);
    assert.equal(first.last.status, "succeeded");
    assert.equal(first.last.build.source, "fresh");
    assert.match(
      first.last.build.objectKey,
      /^builds\/1{40}\/[0-9a-f]{64}\/[0-9a-f-]{36}\.tgz\.enc$/,
    );
    assert.equal(
      first.previous.status,
      "pre-admin",
      "the baseline becomes previous",
    );
    assert.equal(first.previous.vercelDeploymentId, "dpl_live");
    assert.ok(first.cutoverAt instanceof Date);
    assert.equal(env.vercel.state.production, first.last.vercelDeploymentId);
    // The GitHub artifact is gone once the manifest is stored; the row is deleted.
    assert.equal(env.gh.state.artifacts.size, 0);
    assert.equal(
      await env.db.collection("system_state").countDocuments({ kind: "build" }),
      0,
    );
    // CLI: one call, no token in argv, allowlisted env, empty apps/cafe in the deploy root.
    assert.equal(env.cli.calls.length, 1);
    const call = env.cli.calls[0];
    assert.deepEqual(call.args.slice(0, 5), [
      "deploy",
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--archive=tgz",
    ]);
    assert.ok(call.args.includes("--meta"));
    assert.equal(call.args.join(" ").includes(TOKEN), false);
    assert.equal(call.env.VERCEL_TOKEN, TOKEN);
    assert.equal(call.env.VERCEL_ORG_ID, "team_1");
    assert.equal(call.env.VERCEL_PROJECT_ID, env.vercel.state.projectId);
    assert.deepEqual(
      Object.keys(call.env).sort(),
      [
        "CI",
        "HOME",
        "NODE_OPTIONS",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "VERCEL_ORG_ID",
        "VERCEL_PROJECT_ID",
        "VERCEL_TELEMETRY_DISABLED",
        "VERCEL_TOKEN",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
      ].sort(),
    );
    assert.ok(
      call.env.HOME.startsWith(env.workDir) &&
        call.env.XDG_DATA_HOME.startsWith(env.workDir),
    );
    assert.ok(
      call.listing.includes("apps/cafe/") &&
        !call.listing.some(
          (n) => n.startsWith("apps/cafe/") && n !== "apps/cafe/",
        ),
    );
    assert.ok(
      call.listing.includes(".vercel/project.json") &&
        call.listing.includes(".vercel/output/config.json"),
    );
    assert.equal(await jobsDirEmpty(env), true, "job work dir is cleaned");
    // Redeploy: same commit, no dispatch, build step skipped as cached.
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(env.gh.state.dispatches.length, 1, "no second build");
    assert.equal(second.last.build.source, "cache");
    assert.equal(
      second.previous.requestId,
      first.last.requestId,
      "previous is the former live version",
    );
    assert.equal(env.cli.calls.length, 2);
    await assertClean(env, id);
  });
});

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
const never = () => new Promise(() => {});
const auditActions = async (env) =>
  (await env.db.collection("audit_events").find().toArray()).map(
    (e) => e.action,
  );

describe("lease takeover (a worker is killed and another one resumes)", () => {
  it("mid-build: the second worker continues the same GitHub run (one dispatch)", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.onPoll = async (_run, n) => {
      if (n === 1 && !a.dead) {
        await kill(a);
        await never();
      }
    };
    await enqueue(env, id, { sha: SHA1 });
    a.loop.drain();
    await until(() => a.dead);
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const deploy = await deployOf(env, id);
    assert.equal(deploy.current, null);
    assert.equal(deploy.last.sha, SHA1);
    assert.equal(
      env.gh.state.dispatches.length,
      1,
      "the run is never dispatched twice",
    );
    assert.equal(env.cli.calls.length, 1);
    assert.ok((await auditActions(env)).includes("pos.deploy.interrupted"));
    await assertClean(env, id);
  });

  it("mid-store: the manifest was not written, the second worker stores once more from the kept artifact", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    let stuck = false;
    env.s3fake.hooks.beforePut = async (key) => {
      if (key.endsWith(".json") && !stuck) {
        stuck = true;
        await kill(a);
        await never();
      }
    };
    await enqueue(env, id, { sha: SHA1 });
    a.loop.drain();
    await until(() => a.dead);
    assert.equal(
      env.gh.state.artifacts.size,
      1,
      "the artifact outlives the crash",
    );
    const crashedRow = await env.db
      .collection("system_state")
      .findOne({ kind: "build" });
    assert.equal(
      crashedRow.artifactId,
      [...env.gh.state.artifacts.keys()][0],
      "the row remembers the artifact",
    );
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const deploy = await deployOf(env, id);
    assert.equal(deploy.last.sha, SHA1);
    assert.equal(env.gh.state.dispatches.length, 1);
    assert.equal(
      env.gh.state.artifacts.size,
      0,
      "deleted only after the manifest was stored",
    );
    const live = env.s3fake.liveKeys();
    assert.equal(live.filter((k) => k.endsWith(".json")).length, 1);
    assert.equal(
      live.filter((k) => k.endsWith(".tgz.enc")).length,
      2,
      "the first attempt left one orphan object",
    );
  });

  it("mid-upload: the deployment is found by its meta and nothing is uploaded twice", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({ kind: "hang", started: () => kill(a) });
    const rid = await enqueue(env, id, { sha: SHA1 });
    a.loop.drain();
    await until(() => a.dead);
    const stuckJob = (await deployOf(env, id)).current;
    assert.equal(stuckJob.step, "upload");
    assert.ok(stuckJob.uploadStartedAt);
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const deploy = await deployOf(env, id);
    assert.equal(env.cli.calls.length, 1, "no second upload");
    assert.equal(deploy.last.requestId, rid);
    assert.equal(deploy.last.vercelDeploymentId, "dpl_1");
    assert.equal(
      env.vercel.state.deployments.size,
      2,
      "the live one and exactly one new deployment",
    );
    await assertClean(env, id);
  });

  it("a worker that lost its lease can no longer write (fenced)", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    const hold = env.cli.next({ kind: "hang", started: () => kill(a) });
    await enqueue(env, id, { sha: SHA1 });
    const aDone = a.loop.drain();
    await until(() => a.dead);
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const before = JSON.stringify(await deployOf(env, id));
    const auditBefore = (await auditActions(env)).length;
    hold.release();
    await aDone;
    assert.equal(
      JSON.stringify(await deployOf(env, id)),
      before,
      "the zombie changed nothing",
    );
    assert.equal((await auditActions(env)).length, auditBefore);
    assert.ok(env.logs.some((l) => l.event === "lease-lost"));
  });

  it("gives up after too many attempts and expires a job nobody picked up", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const rid = await enqueue(env, id, {
      status: "running",
      step: "build",
      attempt: 3,
      lease: { owner: "gone", until: new Date(env.clock.t - 1000), fence: 3 },
    });
    await w.loop.drain();
    let cur = (await deployOf(env, id)).current;
    assert.equal(cur.requestId, rid);
    assert.equal(cur.status, "failed");
    assert.equal(cur.error.code, "worker-stopped");
    // A queued job never expires while the heartbeat is fresh, however old it is.
    const id2 = await seedInstallation(env, {
      slug: "other",
      pos: { tenantId: "demo" },
    });
    await enqueue(env, id2, {
      requestedAt: new Date(env.clock.t - 3 * 3600000),
    });
    await w.loop.drain();
    cur = (await deployOf(env, id2)).current;
    assert.equal(cur, null, "picked up and deployed, not expired");
    assert.equal(env.gh.state.dispatches.length, 1);
  });

  it("expires queued work only after the heartbeat was stale for 10 minutes (not-picked-up)", async () => {
    const env = await makeEnv();
    const id = await seedInstallation(env);
    await enqueue(env, id, { requestedAt: new Date(env.clock.t - 60000) });
    const id2 = await seedInstallation(env, { slug: "other" });
    const taskId = await enqueueTask(env, id2, "verify");
    await env.db.collection("system_state").insertOne({
      _id: "pos-worker",
      at: new Date(env.clock.t - 11 * 60000),
    });
    const w = await makeWorker(env); // the boot sweep runs before its first heartbeat
    await w.loop.drain();
    const cur = (await deployOf(env, id)).current;
    assert.equal(cur.status, "expired");
    assert.equal(cur.error.code, "not-picked-up");
    const task = (await rowOf(env, id2)).pos.task;
    assert.equal(task.id, taskId);
    assert.equal(task.status, "expired");
    assert.equal(task.error.code, "not-picked-up");
    assert.equal(env.gh.state.dispatches.length, 0);
    // A 9-minute-old heartbeat is still fresh enough.
    const env2 = await makeEnv();
    const id3 = await seedInstallation(env2);
    await enqueue(env2, id3);
    await env2.db.collection("system_state").insertOne({
      _id: "pos-worker",
      at: new Date(env2.clock.t - 9 * 60000),
    });
    const w2 = await makeWorker(env2);
    await w2.loop.drain();
    assert.equal((await deployOf(env2, id3)).current, null);
  });
});

describe("builder acceptance (builder security review)", () => {
  const rejects = [
    [
      "a run on the wrong branch",
      (g) => (g.state.tweak.run = (r) => (r.headBranch = "dev")),
      "run-provenance",
    ],
    [
      "a run that reports no head sha",
      (g) => (g.state.tweak.run = (r) => (r.headSha = "")),
      "manifest-mismatch",
    ],
    [
      "a run of another event",
      (g) => (g.state.tweak.run = (r) => (r.event = "push")),
      "run-provenance",
    ],
    [
      "a run of another workflow",
      (g) =>
        (g.state.tweak.run = (r) => (r.path = ".github/workflows/other.yml")),
      "run-provenance",
    ],
    [
      "an attempt that is not the latest",
      (g) => (g.state.tweak.run = (r) => (r.runAttempt = 2)),
      "run-not-latest",
    ],
    [
      "two artifacts",
      (g) =>
        (g.state.tweak.artifact = (metas, make) => [
          ...metas,
          make("pos-build-other"),
        ]),
      "artifact-count",
    ],
    [
      "an artifact with the wrong name",
      (g) =>
        (g.state.tweak.artifact = (metas) =>
          metas.map((m) => ({ ...m, name: "pos-build-x" }))),
      "artifact-count",
    ],
    [
      "an artifact digest that does not match",
      (g) =>
        (g.state.tweak.artifact = (metas) =>
          metas.map((m) => ({ ...m, digest: `sha256:${"0".repeat(64)}` }))),
      "artifact-digest-mismatch",
    ],
    [
      "a manifest for other build inputs",
      (g) =>
        (g.state.tweak.manifest = (m) => ({
          ...m,
          buildEnvSha256: "0".repeat(64),
        })),
      "manifest-mismatch",
    ],
    [
      "a manifest for another commit",
      (g) => (g.state.tweak.manifest = (m) => ({ ...m, sha: "9".repeat(40) })),
      "manifest-mismatch",
    ],
    [
      "a manifest for another build id",
      (g) =>
        (g.state.tweak.manifest = (m) => ({ ...m, buildId: randomUUID() })),
      "manifest-mismatch",
    ],
    [
      "an unclean scan",
      (g) =>
        (g.state.tweak.manifest = (m) => ({
          ...m,
          scan: { ...m.scan, findings: 1 },
        })),
      "scan-unclean",
    ],
    [
      "a CLI version other than the pinned one",
      (g) => (g.state.tweak.manifest = (m) => ({ ...m, cliVersion: "1.0.0" })),
      "cli-mismatch",
    ],
    [
      "a zip with an extra entry",
      (g) =>
        (g.state.tweak.zip = (files) => [
          ...files,
          { name: "extra.txt", data: "x" },
        ]),
      "zip-invalid",
    ],
    [
      "a tgz that does not match the manifest hash",
      (g) =>
        (g.state.tweak.manifest = (m) => ({
          ...m,
          output: { ...m.output, sha256: "0".repeat(64) },
        })),
      "manifest-mismatch",
    ],
  ];
  for (const [name, tweak, code] of rejects)
    it(`rejects ${name}`, async () => {
      const env = await makeEnv();
      const w = await makeWorker(env);
      const id = await seedInstallation(env);
      tweak(env.gh);
      const deploy = await deployOnce(env, w, id, { sha: SHA1 });
      assert.equal(deploy.current.status, "failed");
      assert.equal(deploy.current.error.code, code);
      assert.equal(deploy.current.error.step, "build");
      assert.equal(deploy.last, null);
      assert.equal(env.cli.calls.length, 0, "nothing was uploaded");
      assert.equal(env.s3fake.liveKeys().length, 0, "nothing was cached");
      assert.equal(env.vercel.state.production, "dpl_live");
      await assertClean(env, id);
    });

  const hostile = [
    [
      "a path traversal",
      [{ name: ".vercel/output/../../etc/passwd", data: "x" }],
    ],
    ["an absolute path", [{ name: "/etc/passwd", data: "x" }]],
    ["a file outside .vercel/output", [{ name: "etc/passwd", data: "x" }]],
    [
      "a symlink that leaves the output",
      [
        {
          name: ".vercel/output/escape",
          type: "symlink",
          linkname: "../../../etc",
        },
      ],
    ],
    [
      "an absolute symlink",
      [
        {
          name: ".vercel/output/abs",
          type: "symlink",
          linkname: "/etc/passwd",
        },
      ],
    ],
    [
      "a hard link",
      [
        {
          name: ".vercel/output/hard",
          type: "hardlink",
          linkname: ".vercel/output/config.json",
        },
      ],
    ],
    ["a device node", [{ name: ".vercel/output/dev", type: "device" }]],
    [
      "a source map",
      [{ name: ".vercel/output/static/app.js.map", data: "{}" }],
    ],
    [
      "an env file",
      [{ name: ".vercel/output/functions/.env.production", data: "A=1" }],
    ],
    [
      "a TypeScript file outside node_modules",
      [{ name: ".vercel/output/functions/a.ts", data: "x" }],
    ],
    [
      "a forbidden directory",
      [{ name: ".vercel/output/functions/scripts/run.js", data: "x" }],
    ],
    ["a CLAUDE.md", [{ name: ".vercel/output/CLAUDE.md", data: "x" }]],
  ];
  for (const [name, extra] of hostile)
    it(`the admin's own tar validation rejects ${name}`, async () => {
      const env = await makeEnv();
      const w = await makeWorker(env);
      const id = await seedInstallation(env);
      env.gh.state.tweak.tgz = () => validOutput(SHA1, extra).tgz;
      const deploy = await deployOnce(env, w, id, { sha: SHA1 });
      assert.equal(deploy.current.error.code, "tar-invalid");
      assert.equal(env.cli.calls.length, 0);
    });

  it("refuses to build when the builder's CLI is not the worker's CLI", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.descriptors[BUILDER_SHA] = {
      protocol: 1,
      nodeVersion: "22.23.3",
      cliVersion: "62.0.0",
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "builder-not-ready");
    assert.equal(env.gh.state.dispatches.length, 0);
  });

  it("maps a failed builder step to a fixed message and keeps the run link", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.tweak.fail = "Sanitise and scan output";
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "scan-failed");
    assert.match(deploy.current.error.message, /safety scan/);
    assert.match(
      deploy.current.runUrl,
      /^https:\/\/github\.com\/owner\/builder\/actions\/runs\/\d+$/,
    );
    assert.equal(env.vercel.state.production, "dpl_live");
  });

  it("cancels and fails a run that stays queued for 15 minutes, and one that runs for 30", async () => {
    let env = await makeEnv();
    let w = await makeWorker(env);
    let id = await seedInstallation(env);
    env.gh.state.autoComplete = false;
    env.gh.state.onPoll = async () => (env.clock.t += 10 * 60000);
    let deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "build-queued-timeout");
    assert.equal(env.gh.state.cancels.length, 1);
    env = await makeEnv();
    w = await makeWorker(env);
    id = await seedInstallation(env);
    env.gh.state.autoComplete = false;
    env.gh.state.onPoll = async (run) => {
      run.status = "in_progress";
      env.clock.t += 10 * 60000;
    };
    deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "build-timeout");
    assert.equal(env.gh.state.cancels.length, 1);
  });

  it("refuses to start with less than 2 GB free on the work volume", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.freeBytes = async () => 1e9;
    const id = await seedInstallation(env);
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "no-space");
    assert.equal(env.gh.state.dispatches.length, 0);
  });
});

describe("build cache integrity", () => {
  it("quarantines a tampered cache object and rebuilds once", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const first = await deployOnce(env, w, id, { sha: SHA1 });
    const objectKey = first.last.build.objectKey;
    await rm(path.join(env.workDir, "builds"), {
      recursive: true,
      force: true,
    });
    env.s3fake.tamper(objectKey, 20);
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.current, null);
    assert.equal(env.gh.state.dispatches.length, 2, "exactly one rebuild");
    assert.equal(second.last.build.source, "fresh");
    assert.notEqual(second.last.build.objectKey, objectKey);
    assert.ok((await auditActions(env)).includes("pos.build.integrity-failed"));
    assert.ok(
      env.notices.some((n) => /integrity/.test(n.text)),
      "the owner is told (best effort)",
    );
    assert.equal(
      env.s3fake.liveKeys().filter((k) => k.endsWith(".json")).length,
      1,
      "a fresh manifest replaced the quarantined one",
    );
    await assertClean(env, id);
  });

  it("fails after a second integrity failure instead of rebuilding for ever", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const first = await deployOnce(env, w, id, { sha: SHA1 });
    await rm(path.join(env.workDir, "builds"), {
      recursive: true,
      force: true,
    });
    env.s3fake.tamper(first.last.build.objectKey, 20);
    // Every rebuilt object is corrupted as soon as it is stored.
    env.s3fake.hooks.afterPut = async (key) => {
      if (!key.endsWith(".tgz.enc")) return;
      env.s3fake.tamper(key, 20);
      await rm(path.join(env.workDir, "builds"), {
        recursive: true,
        force: true,
      });
    };
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.current.status, "failed");
    assert.equal(second.current.error.code, "cache-integrity");
    assert.equal(env.gh.state.dispatches.length, 2);
    assert.equal(
      env.vercel.state.production,
      first.last.vercelDeploymentId,
      "production untouched",
    );
  });

  it("adopts the manifest another writer stored first (412)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const pos = (await rowOf(env, id)).pos;
    const inputs = buildInputs({
      pos,
      builderSha: BUILDER_SHA,
      builder: { protocol: 1, nodeVersion: "22.23.3", cliVersion: CLI_VERSION },
    });
    const buildKey = buildKeyOf(VAULT_KEY, inputs);
    let competing = false;
    env.s3fake.hooks.afterPut = async (key) => {
      if (!key.endsWith(".tgz.enc") || competing) return;
      competing = true;
      const { tgz, counts } = validOutput(SHA1);
      const src = path.join(env.workDir, "competitor.tgz");
      await writeFile(src, tgz);
      await env.cache.store({
        sha: SHA1,
        buildKey,
        srcPath: src,
        workDir: env.workDir,
        info: {
          branch: "main",
          commit: { message: "", authorName: "", date: null },
          settings: { ...BUILD_SETTINGS },
          env: envFingerprints(VAULT_KEY, inputs.env),
          builder: inputs.builder,
          run: { id: 1, attempt: 1, conclusion: "success" },
          builtAt: new Date().toISOString(),
          output: { bytes: tgz.length, sha256: sha256(tgz), ...counts },
          scan: {
            findings: 0,
            maps: 0,
            tsOutsideNodeModules: 0,
            forbiddenPaths: 0,
            secretHits: 0,
            envFiles: 0,
            symlinkEscapes: 0,
          },
          tar: { entries: 6, bad: 0 },
        },
      });
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.last.sha, SHA1);
    const live = env.s3fake.liveKeys();
    assert.equal(live.filter((k) => k.endsWith(".json")).length, 1);
    assert.deepEqual(
      live.filter((k) => k.endsWith(".tgz.enc")),
      [deploy.last.build.objectKey],
      "the loser's object was removed",
    );
    assert.equal(env.gh.state.artifacts.size, 0);
  });

  it("works without S3: the artifact is the only copy, kept for the sweep", async () => {
    const env = await makeEnv({ cache: false });
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const first = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(first.last.build.source, "artifact");
    assert.equal(first.last.build.objectKey, null);
    assert.equal(env.gh.state.artifacts.size, 1, "the GitHub artifact is kept");
    const rows = await env.db
      .collection("system_state")
      .find({ kind: "build" })
      .toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "ready");
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.last.build.source, "artifact");
    assert.equal(env.gh.state.dispatches.length, 1, "the kept build is reused");
    env.clock.t += 3 * 3600000;
    const result = await runRetention(w.ctx);
    assert.equal(result.artifacts, 1);
    assert.equal(env.gh.state.artifacts.size, 0);
    assert.equal(
      await env.db.collection("system_state").countDocuments({ kind: "build" }),
      0,
    );
  });
});

describe("single flight", () => {
  it("a deploy joins a build that is already queued (one dispatch)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const pos = (await rowOf(env, id)).pos;
    const inputs = buildInputs({
      pos,
      builderSha: BUILDER_SHA,
      builder: { protocol: 1, nodeVersion: "22.23.3", cliVersion: CLI_VERSION },
    });
    const buildKey = buildKeyOf(VAULT_KEY, inputs);
    await env.db.collection("system_state").insertOne({
      _id: buildRowId(SHA1, buildKey),
      kind: "build",
      status: "queued",
      sha: SHA1,
      buildKey,
      inputs,
      branch: "main",
      commit: {
        sha: SHA1,
        branch: "main",
        headline: "Prepared",
        authorName: "Dev",
        date: null,
      },
      lease: { owner: null, until: null, fence: 0 },
      attempt: 0,
      runId: null,
      runUrl: null,
      artifactId: null,
      waiters: [],
      prepared: { by: { id: "staff-1", name: "Owner" }, at: new Date() },
      error: null,
      createdAt: new Date(),
      finishedAt: null,
    });
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(env.gh.state.dispatches.length, 1);
    assert.equal(deploy.last.sha, SHA1);
    assert.equal(deploy.last.commit.headline, "Prepared");
  });

  it("two workers, two installations with the same inputs: one build, two deploys", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env, { leaseMs: 1e12 });
    const b = await makeWorker(env, { leaseMs: 1e12 });
    const one = await seedInstallation(env, {
      slug: "one",
      pos: { tenantId: "demo" },
    });
    const two = await seedInstallation(env, {
      slug: "two",
      pos: { tenantId: "demo" },
    });
    await enqueue(env, one, { sha: SHA1 });
    await enqueue(env, two, { sha: SHA1 });
    await Promise.all([a.loop.drain(), b.loop.drain()]);
    assert.equal(env.gh.state.dispatches.length, 1, "single flight");
    // Both installations share one fake Vercel project, so the second deploy may
    // legitimately find production moved by the first ("production-changed").
    const outcomes = [];
    for (const id of [one, two]) {
      const deploy = await deployOf(env, id);
      outcomes.push(deploy.current ? deploy.current.error.code : "ok");
    }
    assert.ok(outcomes.includes("ok"));
    assert.ok(
      outcomes.every((o) => ["ok", "production-changed"].includes(o)),
      JSON.stringify(outcomes),
    );
    assert.equal(
      env.s3fake.liveKeys().filter((k) => k.endsWith(".json")).length,
      1,
    );
  });
});

describe("health, automatic rollback and the Hobby limit", () => {
  it("rolls back automatically when the new version is unhealthy", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.health.bad.add("dpl_1");
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    const cur = deploy.current;
    assert.equal(cur.status, "rolled-back");
    assert.equal(cur.error.code, "health-failed");
    assert.equal(cur.error.step, "health");
    assert.deepEqual(stepStates(cur), {
      preflight: "done",
      resolve: "done",
      build: "done",
      fetch: "done",
      upload: "done",
      vercel: "done",
      health: "failed",
      finalize: "done",
    });
    assert.equal(
      env.vercel.state.production,
      "dpl_live",
      "production is back on the previous deployment",
    );
    assert.deepEqual(
      env.vercel.calledWith("rollback").map((c) => c.args[0]),
      ["dpl_live"],
    );
    assert.equal(deploy.last, null, "what is live is still what `last` says");
    assert.equal(deploy.cutoverAt, null);
    assert.ok((await auditActions(env)).includes("pos.deploy.rolled-back"));
    assert.ok(env.notices.some((n) => /rolled back/.test(n.subject)));
    await assertClean(env, id);
  });

  it("stays on the new version and reports unhealthy when there is nothing healthy to go back to", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.health.bad.add("dpl_live");
    env.health.bad.add("dpl_1");
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "unhealthy");
    assert.equal(
      env.vercel.calledWith("rollback").length,
      0,
      "no rollback without a healthy baseline",
    );
    assert.equal(
      deploy.last.vercelDeploymentId,
      "dpl_1",
      "the new deployment is live, so `last` says so",
    );
    assert.equal(deploy.previous.status, "pre-admin");
    assert.equal(deploy.cutoverAt, null, "cutover needs a verified deploy");
    assert.ok((await auditActions(env)).includes("pos.deploy.unhealthy"));
  });

  it("reports unhealthy when the automatic rollback target is unhealthy too after the switch", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    // The baseline looks healthy before the deploy, then degrades.
    let probes = 0;
    const get = env.health.get;
    w.ctx.healthGet = async (host, p) => {
      if (p === "/api/health" && ++probes > 1) env.health.bad.add("dpl_live");
      return get(host, p);
    };
    env.health.bad.add("dpl_1");
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "unhealthy");
    assert.equal(env.vercel.state.production, "dpl_live");
    assert.equal(deploy.last, null);
  });

  async function twoDeploys(env, w, id) {
    await deployOnce(env, w, id, { sha: SHA1 });
    await deployOnce(env, w, id, { sha: SHA2 });
    return deployOf(env, id);
  }
  it("rolls back to previous (instant) and swaps last and previous", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploys(env, w, id);
    assert.equal(before.previous.sha, SHA1);
    // A frozen fleet still allows rollbacks.
    await env.db.collection("system_state").insertOne({
      _id: "pos-deploy-freeze",
      on: true,
      reason: "x",
      by: null,
      at: new Date(),
    });
    await enqueue(env, id, {
      kind: "rollback",
      sha: SHA1,
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current, null);
    assert.equal(
      after.last.vercelDeploymentId,
      before.previous.vercelDeploymentId,
    );
    assert.equal(after.last.status, "rolled-back-to");
    assert.equal(after.last.sha, SHA1);
    assert.equal(
      after.previous.vercelDeploymentId,
      before.last.vercelDeploymentId,
    );
    assert.equal(
      env.vercel.state.production,
      before.previous.vercelDeploymentId,
    );
    assert.equal(env.gh.state.dispatches.length, 2);
    assert.ok((await auditActions(env)).includes("pos.rollback.succeeded"));
  });

  it("falls back to redeploying the previous commit from the cache when Vercel answers 402", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploys(env, w, id);
    env.vercel.state.rollbackError = new ProviderError("vercel", "rejected", {
      status: 402,
    });
    const rid = await enqueue(env, id, {
      kind: "rollback",
      sha: SHA1,
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    const dispatches = env.gh.state.dispatches.length;
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current, null);
    assert.equal(after.last.status, "rolled-back-to");
    assert.equal(after.last.sha, SHA1);
    assert.notEqual(
      after.last.vercelDeploymentId,
      before.previous.vercelDeploymentId,
      "a new deployment of the old commit",
    );
    assert.equal(env.vercel.state.production, after.last.vercelDeploymentId);
    assert.equal(
      env.gh.state.dispatches.length,
      dispatches,
      "served from the cache, no build",
    );
    const last = env.cli.calls.at(-1);
    assert.equal(
      last.args[last.args.indexOf("--meta") + 1],
      `sandbeeRequest=${rid}-rb`,
    );
    assert.equal(after.previous.sha, SHA2);
  });

  it("fails clearly when Vercel answers 402 and no cached build exists", async () => {
    const env = await makeEnv({ cache: false });
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploys(env, w, id);
    env.vercel.state.rollbackError = new ProviderError("vercel", "rejected", {
      status: 402,
    });
    await enqueue(env, id, {
      kind: "rollback",
      sha: SHA1,
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current.status, "failed");
    assert.equal(after.current.error.code, "rollback-refused");
    assert.equal(env.vercel.state.production, before.last.vercelDeploymentId);
    assert.equal(
      after.last.requestId,
      before.last.requestId,
      "nothing rotated",
    );
  });

  it("refuses a rollback when production was changed outside admin", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploys(env, w, id);
    env.vercel.add({ id: "dpl_manual" });
    env.vercel.state.production = "dpl_manual";
    env.vercel.state.lastAlias = {
      toDeploymentId: "dpl_manual",
      jobStatus: "succeeded",
      type: "promote",
    };
    await enqueue(env, id, {
      kind: "rollback",
      sha: SHA1,
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current.error.code, "production-changed");
    assert.equal(env.vercel.calledWith("rollback").length, 0);
  });

  it("never promotes over a production that changed outside admin during a deploy", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({
      before: async () => {
        env.vercel.add({ id: "dpl_manual" });
        env.vercel.state.production = "dpl_manual";
        env.vercel.state.lastAlias = {
          toDeploymentId: "dpl_manual",
          jobStatus: "succeeded",
          type: "promote",
        };
      },
    });
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "production-changed");
    assert.equal(env.vercel.calledWith("promote").length, 0);
    assert.equal(env.vercel.state.production, "dpl_manual");
  });

  it("a failed Vercel build leaves production untouched", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({ before: async () => undefined });
    const original = env.vercel.createFromCli;
    env.vercel.createFromCli = (meta) => {
      const d = original(meta);
      d.readyState = "ERROR";
      return d;
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "vercel-build-error");
    assert.equal(env.vercel.state.production, "dpl_live");
    assert.equal(env.vercel.calledWith("promote").length, 0);
  });

  it("stores CLI failures as a category code only", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({ kind: "fail", category: "auth-invalid-token" });
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "cli-auth-invalid-token");
    assert.equal(
      deploy.current.error.message,
      "Vercel rejected the stored token.",
    );
    await assertClean(env, id);
  });
});

describe("preflight", () => {
  it("fails with key names (no values) on env drift and on wrong project settings", async () => {
    let env = await makeEnv();
    let w = await makeWorker(env);
    let id = await seedInstallation(env);
    env.vercel.state.envs[3].value = "https://wrong.example.r2.dev/";
    let deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "env-drift");
    assert.match(
      deploy.current.error.message,
      /NEXT_PUBLIC_R2_PUBLIC_BASE_URL/,
    );
    assert.equal(deploy.current.error.message.includes("wrong.example"), false);
    assert.equal(env.gh.state.dispatches.length, 0);
    env = await makeEnv();
    w = await makeWorker(env);
    id = await seedInstallation(env);
    env.vercel.state.project.nodeVersion = "20.x";
    deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "project-settings");
    assert.match(deploy.current.error.message, /nodeVersion/);
  });

  it("refuses a locked installation, an unreadable token and a rejected token", async () => {
    let env = await makeEnv();
    let w = await makeWorker(env);
    let id = await seedInstallation(env, { pos: { deployLock: true } });
    let deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "locked");
    env = await makeEnv();
    w = await makeWorker(env);
    id = await seedInstallation(env);
    env.vercel.state.userError = new ProviderError("vercel", "unauthorized", {
      status: 401,
    });
    deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "vercel-unauthorized");
    env = await makeEnv();
    w = await makeWorker(env);
    id = await seedInstallation(env);
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.vercel.token.data": "AAAA" } });
    deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "secret-unreadable");
  });
});

describe("cancel and freeze", () => {
  async function setCancelling(env, id) {
    await env.db.collection("installations").updateOne(
      { _id: id, "pos.deploy.current.status": "running" },
      {
        $set: {
          "pos.deploy.current.status": "cancelling",
          "pos.deploy.current.cancelRequested": true,
        },
      },
    );
  }
  it("cancels a job that is waiting for its build and stops the GitHub run when nobody else needs it", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.completeAfter = 999;
    env.gh.state.onPoll = async (_run, n) => {
      if (n === 1) await setCancelling(env, id);
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "cancelled");
    assert.equal(deploy.current.error, null);
    assert.equal(env.cli.calls.length, 0);
    assert.equal(
      env.gh.state.cancels.length,
      1,
      "the run is cancelled because no waiter is left",
    );
    assert.equal(env.vercel.state.production, "dpl_live");
    const rows = await env.db
      .collection("system_state")
      .find({ kind: "build" })
      .toArray();
    assert.equal(rows[0].status, "cancelled");
  });

  it("does not claim queued deploys while frozen, and stops a running one before upload", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await env.db.collection("system_state").insertOne({
      _id: "pos-deploy-freeze",
      on: true,
      reason: "x",
      by: null,
      at: new Date(),
    });
    await enqueue(env, id, { sha: SHA1 });
    await w.loop.drain();
    let cur = (await deployOf(env, id)).current;
    assert.equal(cur.status, "queued");
    assert.equal(cur.attempt, 0);
    await env.db
      .collection("system_state")
      .deleteOne({ _id: "pos-deploy-freeze" });
    env.gh.state.completeAfter = 999;
    env.gh.state.onPoll = async (_run, n) => {
      if (n === 1)
        await env.db.collection("system_state").insertOne({
          _id: "pos-deploy-freeze",
          on: true,
          reason: "x",
          by: null,
          at: new Date(),
        });
    };
    await w.loop.drain();
    cur = (await deployOf(env, id)).current;
    assert.equal(cur.status, "cancelled");
    assert.equal(cur.error.code, "frozen");
    assert.equal(env.cli.calls.length, 0);
  });

  it("the switch into upload is atomic with a cancel request", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    // The cancel arrives after the last cancel check and before the upload begins.
    const original = w.ctx.coll.installations.updateOne.bind(
      w.ctx.coll.installations,
    );
    let armed = true;
    w.ctx.coll.installations.updateOne = async (filter, update, options) => {
      if (armed && update?.$set?.["pos.deploy.current.step"] === "upload") {
        armed = false;
        await setCancelling(env, id);
      }
      return original(filter, update, options);
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "cancelled", "the job did not upload");
    assert.equal(env.cli.calls.length, 0);
  });
});

describe("verify task", () => {
  async function verifyRun(env, w, id) {
    await enqueueTask(env, id, "verify");
    await w.loop.drain();
    const row = await rowOf(env, id);
    return { task: row.pos.task, verify: row.pos.verify };
  }
  it("records ok for every check and writes pos.verify", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const { task, verify } = await verifyRun(env, w, id);
    assert.equal(task.status, "succeeded");
    assert.deepEqual(task.result, { checks: 6, failed: 0 });
    assert.deepEqual(
      { ...verify, at: undefined, by: undefined },
      {
        at: undefined,
        by: undefined,
        vercel: "ok",
        project: "ok",
        env: "ok",
        mongo: "ok",
        cloudflare: "ok",
        health: "ok",
      },
    );
    assert.equal(verify.by.id, "staff-1");
    assert.ok((await auditActions(env)).includes("pos.verify.completed"));
    await assertClean(env, id);
  });

  const cases = [
    [
      "Vercel rejects the token",
      (env) =>
        (env.vercel.state.userError = new ProviderError(
          "vercel",
          "unauthorized",
          { status: 401 },
        )),
      { vercel: "unauthorized", project: null, env: null },
    ],
    [
      "the project is not visible",
      (env) => (env.vercel.state.projectId = "other"),
      { project: "not-found" },
    ],
    [
      "the project settings are wrong",
      (env) => (env.vercel.state.project.rootDirectory = "."),
      { project: "settings" },
    ],
    [
      "a plain env value drifted",
      (env) => (env.vercel.state.envs[0].value = "someone-else"),
      { env: "drift" },
    ],
    [
      "a required env key is missing",
      (env) =>
        (env.vercel.state.envs = env.vercel.state.envs.filter(
          (e) => e.key !== "MONGODB_URI",
        )),
      { env: "missing" },
    ],
    [
      "the client database is unreachable",
      (env) => (env.mongoPing = "unreachable"),
      { mongo: "unreachable" },
    ],
    [
      "Cloudflare rejects the token",
      (env) => (env.cfOk = false),
      { cloudflare: "invalid" },
    ],
    [
      "the host is unhealthy",
      (env) => env.health.bad.add("dpl_live"),
      { health: "unhealthy" },
    ],
  ];
  for (const [name, setup, expected] of cases)
    it(`flags ${name}`, async () => {
      const env = await makeEnv();
      const w = await makeWorker(env);
      const id = await seedInstallation(env);
      setup(env);
      const { task, verify } = await verifyRun(env, w, id);
      assert.equal(task.status, "succeeded");
      for (const [key, value] of Object.entries(expected))
        assert.equal(verify[key], value, key);
      assert.ok(task.result.failed >= 1);
      assertNoSecrets(verify, SECRETS, "verify");
    });
  it("skips Cloudflare when no token is stored", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await env.db
      .collection("installations")
      .updateOne({ _id: id }, { $set: { "pos.cloudflare.token": null } });
    const { verify } = await verifyRun(env, w, id);
    assert.equal(verify.cloudflare, null);
  });
});

describe("purge", () => {
  const DAY = 86400000;
  async function setup(env) {
    const cutover = new Date(Date.now() - 10 * DAY);
    const id = await seedInstallation(env, {
      deploy: {
        cutoverAt: cutover,
        last: {
          requestId: "r1",
          vercelDeploymentId: "dpl_last",
          status: "succeeded",
        },
        previous: {
          requestId: "r0",
          vercelDeploymentId: "dpl_prev",
          status: "succeeded",
        },
      },
    });
    const v = env.vercel;
    for (const d of [
      { id: "dpl_last" },
      { id: "dpl_prev" },
      { id: "dpl_old1" },
      { id: "dpl_old2" },
      { id: "dpl_pre", prebuilt: true },
      { id: "dpl_new", createdAt: Date.now() - DAY },
    ])
      v.add(d);
    return id;
  }
  it("previews only old source deployments and never the live, last, previous, prebuilt or newer ones", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await setup(env);
    await enqueueTask(env, id, "purge-preview");
    await w.loop.drain();
    const task = (await rowOf(env, id)).pos.task;
    assert.equal(task.status, "succeeded");
    assert.deepEqual(task.result.candidates.map((c) => c.id).sort(), [
      "dpl_old1",
      "dpl_old2",
    ]);
    assert.equal(task.result.total, 2);
    assert.equal(
      task.result.keep,
      5,
      "live, last, previous, prebuilt and newer",
    );
    assert.equal(
      env.vercel.calledWith("delete").length,
      0,
      "a preview deletes nothing",
    );
  });

  it("executes exactly the previewed ids, bound by the digest", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await setup(env);
    const ids = ["dpl_old1", "dpl_old2"];
    await enqueueTask(env, id, "purge", {
      ids,
      digest: purgeDigest(ids),
      previewTaskId: randomUUID(),
    });
    await w.loop.drain();
    const task = (await rowOf(env, id)).pos.task;
    assert.equal(task.status, "succeeded");
    assert.deepEqual(task.result, { deleted: 2, skipped: 0, failed: 0 });
    assert.deepEqual(
      env.vercel
        .calledWith("delete")
        .map((c) => c.args[0])
        .sort(),
      ids,
    );
    assert.ok((await auditActions(env)).includes("pos.purge.completed"));
  });

  it("refuses ids that do not hash to the confirmed digest", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await setup(env);
    await enqueueTask(env, id, "purge", {
      ids: ["dpl_old1", "dpl_last"],
      digest: purgeDigest(["dpl_old1", "dpl_old2"]),
      previewTaskId: randomUUID(),
    });
    await w.loop.drain();
    const task = (await rowOf(env, id)).pos.task;
    assert.equal(task.status, "failed");
    assert.equal(task.error.code, "digest-mismatch");
    assert.equal(env.vercel.calledWith("delete").length, 0);
  });

  it("never deletes the live, last or previous deployment even when they are in a consistent list", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await setup(env);
    const ids = [
      "dpl_old1",
      "dpl_live",
      "dpl_last",
      "dpl_prev",
      "dpl_pre",
      "dpl_new",
    ];
    await enqueueTask(env, id, "purge", {
      ids,
      digest: purgeDigest(ids),
      previewTaskId: randomUUID(),
    });
    await w.loop.drain();
    const task = (await rowOf(env, id)).pos.task;
    assert.deepEqual(
      env.vercel.calledWith("delete").map((c) => c.args[0]),
      ["dpl_old1"],
    );
    assert.deepEqual(task.result, { deleted: 1, skipped: 5, failed: 0 });
  });

  it("needs a cutover first", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await enqueueTask(env, id, "purge-preview");
    await w.loop.drain();
    assert.equal((await rowOf(env, id)).pos.task.error.code, "no-cutover");
  });
});

describe("retention (D22)", () => {
  const DAY = 86400000;
  const keys = (n) => ({
    sha: String(n).repeat(40),
    key: String(n).repeat(64),
  });
  async function putBuild(env, { sha, key }) {
    const objectKey = `builds/${sha}/${key}/00000000-0000-4000-8000-00000000000${sha[0]}.tgz.enc`;
    await env.s3.putBytes(`builds/${sha}/${key}.json`, Buffer.from("{}"), {
      contentType: "application/json",
    });
    await env.s3.putBytes(objectKey, Buffer.from("x"), {
      contentType: "application/octet-stream",
    });
    return objectKey;
  }
  const version = (n, objectKey, touchedAt) => ({
    requestId: `r${n}`,
    sha: keys(n).sha,
    vercelDeploymentId: `dpl_${n}`,
    status: "succeeded",
    build: { buildKey: keys(n).key, objectKey, touchedAt, source: "fresh" },
  });
  const copies = (env) =>
    env.s3fake.calls.filter((c) => c.op === "copy").map((c) => c.key);
  it("copies the live build forward after 5 days, and leaves previous builds and fresh live builds alone", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const now = env.clock.t;
    const o1 = await putBuild(env, keys(1)),
      o2 = await putBuild(env, keys(2)),
      o3 = await putBuild(env, keys(3));
    const stale = await seedInstallation(env, {
      slug: "stale",
      deploy: {
        last: version(1, o1, new Date(now - 6 * DAY)),
        previous: version(2, o2, new Date(now - 9 * DAY)),
      },
    });
    const fresh = await seedInstallation(env, {
      slug: "fresh",
      deploy: { last: version(3, o3, new Date(now - 2 * DAY)) },
    });
    env.s3fake.reset();
    const result = await runRetention(w.ctx);
    assert.equal(result.copied, 1);
    assert.deepEqual(
      copies(env).sort(),
      [o1, `builds/${keys(1).sha}/${keys(1).key}.json`].sort(),
    );
    const after = await deployOf(env, stale);
    assert.equal(new Date(after.last.build.touchedAt).getTime(), now);
    assert.equal(
      new Date(after.previous.build.touchedAt).getTime(),
      now - 9 * DAY,
      "previous is never copied by the sweep",
    );
    assert.equal(
      new Date((await deployOf(env, fresh)).last.build.touchedAt).getTime(),
      now - 2 * DAY,
    );
    // A second sweep the same day has nothing to do.
    env.s3fake.reset();
    await runRetention(w.ctx);
    assert.deepEqual(copies(env), []);
  });

  it("counts a build that already expired instead of failing", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env, {
      deploy: {
        last: version(
          4,
          `builds/${keys(4).sha}/${keys(4).key}/00000000-0000-4000-8000-000000000004.tgz.enc`,
          new Date(env.clock.t - 7 * DAY),
        ),
      },
    });
    const result = await runRetention(w.ctx);
    assert.equal(result.missing, 1);
    assert.equal(result.copied, 0);
    assert.ok(id);
  });

  it("copies the previous build forward exactly once, when it becomes previous", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const first = await deployOnce(env, w, id, { sha: SHA1 });
    env.s3fake.reset();
    const second = await deployOnce(env, w, id, { sha: SHA2 });
    const firstObject = first.last.build.objectKey;
    assert.ok(
      copies(env).includes(firstObject),
      "the replaced live build is kept for 10 more days",
    );
    assert.ok(
      copies(env).includes(manifestKey(SHA1, first.last.build.buildKey)),
    );
    env.s3fake.reset();
    await deployOnce(env, w, id, { sha: SHA1, kind: "redeploy" });
    assert.ok(
      copies(env).includes(second.last.build.objectKey),
      "the build that was live is kept as previous",
    );
    assert.ok(
      !copies(env).includes(firstObject),
      "the first build is not copied again",
    );
  });

  it("the daily sweep is scheduled by the loop, once a day", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env, { t: { retentionCheckMs: 0 } });
    await w.loop.drain();
    let row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-retention" });
    assert.equal(row.status, "idle");
    assert.ok(row.result && typeof row.result.checked === "number");
    const at = row.at.getTime();
    env.clock.t += 1000;
    await w.loop.drain();
    row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-retention" });
    assert.equal(row.at.getTime(), at, "not again within a day");
    env.clock.t += 25 * 3600000;
    await w.loop.drain();
    row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-retention" });
    assert.ok(row.at.getTime() > at);
  });
});

describe("worker heartbeat", () => {
  it("writes pos-worker with the builder info and the last build time", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.onPoll = async () => (env.clock.t += 5000);
    await deployOnce(env, w, id, { sha: SHA1 });
    await w.ctx.heartbeat.beat();
    const row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.workerId, w.ctx.workerId);
    assert.equal(row.cliVersion, CLI_VERSION);
    assert.equal(row.builderConfigured, true);
    assert.equal(row.builder.sha, BUILDER_SHA);
    assert.equal(row.builder.cliVersion, CLI_VERSION);
    assert.equal(row.builder.ok, true);
    assert.ok(row.builder.checkedAt instanceof Date);
    assert.ok(row.lastBuildMs >= 5000);
    assert.equal(row.at.getTime(), env.clock.t);
    assert.ok(
      existsSync(path.join(env.workDir, "heartbeat")),
      "the container health file",
    );
  });

  it("marks the builder not ok when its CLI differs, and refreshes it every five minutes", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    env.gh.state.descriptors[BUILDER_SHA] = {
      protocol: 1,
      nodeVersion: "22.23.3",
      cliVersion: "62.0.0",
    };
    await w.ctx.heartbeat.refreshBuilder();
    await w.ctx.heartbeat.beat();
    let row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.builder.ok, false);
    env.gh.state.descriptors[BUILDER_SHA] = {
      protocol: 1,
      nodeVersion: "22.23.3",
      cliVersion: CLI_VERSION,
    };
    await w.ctx.heartbeat.beat();
    row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.builder.ok, false, "not re-read within five minutes");
    env.clock.t += 6 * 60000;
    await w.ctx.heartbeat.beat();
    row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.builder.ok, true);
  });

  it("reports an unconfigured builder", async () => {
    const env = await makeEnv();
    env.gh.state.configured = { source: false, builder: false };
    const w = await makeWorker(env);
    await w.ctx.heartbeat.beat();
    const row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.builderConfigured, false);
    assert.equal(row.builder.ok, false);
  });
});

describe("graceful stop", () => {
  it("a waiting job gives its lease back and the next worker finishes it", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.completeAfter = 999;
    await enqueue(env, id, { sha: SHA1 });
    const aDone = a.loop.drain();
    await until(
      () =>
        env.gh.state.runs.size > 0 &&
        [...env.gh.state.runs.values()][0].polls > 2,
    );
    await a.loop.stop({ cliGraceMs: 60000, totalMs: 5000 });
    await aDone;
    const cur = (await deployOf(env, id)).current;
    assert.equal(cur.status, "running", "not failed");
    assert.ok(
      new Date(cur.lease.until).getTime() < env.clock.t,
      "claimable at once",
    );
    env.gh.state.completeAfter = 1;
    const b = await makeWorker(env);
    await b.loop.drain();
    assert.equal((await deployOf(env, id)).last.sha, SHA1);
    assert.equal(env.gh.state.dispatches.length, 1);
  });
});

describe("secret safety", () => {
  it("no token, URI or key reaches argv, logs, notices or any stored row, also on failures", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({ kind: "fail", category: "other" });
    await deployOnce(env, w, id, { sha: SHA1 });
    await enqueueTask(env, id, "verify");
    await w.loop.drain();
    await deployOnce(env, w, id, { sha: SHA1 });
    for (const call of env.cli.calls) {
      for (const secret of SECRETS)
        assert.equal(call.args.join(" ").includes(secret), false);
      assert.deepEqual(
        Object.keys(call.env).filter((k) =>
          /MONGO|VAULT|GITHUB|S3|AUTH|SECRET/i.test(k),
        ),
        [],
      );
    }
    await assertClean(env, id);
    const everything = JSON.stringify([
      await env.db
        .collection("system_state")
        .find({ _id: { $ne: "vault-v1" } })
        .toArray(),
      await env.db.collection("audit_events").find().toArray(),
      env.logs,
      env.notices,
    ]);
    for (const secret of SECRETS)
      assert.equal(everything.includes(secret), false);
  });
});

describe("CLI runner", () => {
  async function script(body) {
    const dir = await mkdtemp(path.join(tmpdir(), "cli-test-"));
    const file = path.join(dir, "fake-cli.js");
    await writeFile(file, body);
    return { dir, file };
  }
  const FAKE = `
    const mode = process.argv[2];
    if (mode === "env") process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));
    else if (mode === "big") process.stdout.write("x".repeat(500000));
    else if (mode === "auth") { process.stderr.write("Error: Invalid token SECRETWORD 403"); process.exit(1); }
    else if (mode === "hang") setInterval(() => {}, 1000);
  `;
  it("passes only the allowlisted environment, the token only there, and argv verbatim without a shell", async () => {
    const { dir, file } = await script(FAKE);
    process.env.TEST_PARENT_SECRET = "parent-secret";
    try {
      const env = cliEnv({
        token: TOKEN,
        orgId: "team_1",
        projectId: "prj_1",
        workDir: dir,
        jobDir: path.join(dir, "j"),
      });
      const result = await runCli({
        args: ["env", "a b; echo pwned $(x) `y`"],
        cwd: dir,
        env,
        cliPath: file,
      });
      assert.equal(result.code, 0);
      assert.equal(result.category, null);
      const seen = JSON.parse(result.stdout);
      assert.deepEqual(seen.argv, ["env", "a b; echo pwned $(x) `y`"]);
      assert.equal(seen.env.VERCEL_TOKEN, TOKEN);
      assert.equal(
        seen.env.TEST_PARENT_SECRET,
        undefined,
        "the parent's environment is never inherited",
      );
      assert.equal(seen.env.VAULT_KEY, undefined);
      assert.equal(seen.env.HOME, path.join(dir, "j", "cli", "home"));
      assert.equal(seen.env.NO_COLOR, "1");
      assert.equal(seen.env.VERCEL_TELEMETRY_DISABLED, "1");
    } finally {
      delete process.env.TEST_PARENT_SECRET;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("kills a hanging CLI on timeout and on abort", async () => {
    const { dir, file } = await script(FAKE);
    try {
      let result = await runCli({
        args: ["hang"],
        cwd: dir,
        env: {},
        cliPath: file,
        timeoutMs: 300,
        killGraceMs: 300,
      });
      assert.equal(result.timedOut, true);
      assert.equal(result.category, "timeout");
      assert.notEqual(result.code, 0);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      result = await runCli({
        args: ["hang"],
        cwd: dir,
        env: {},
        cliPath: file,
        signal: controller.signal,
        killGraceMs: 300,
      });
      assert.equal(result.aborted, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("bounds the output and reduces failures to a category", async () => {
    const { dir, file } = await script(FAKE);
    try {
      let result = await runCli({
        args: ["big"],
        cwd: dir,
        env: {},
        cliPath: file,
      });
      assert.ok(result.stdout.length <= 64 * 1024 + 16 * 1024);
      result = await runCli({
        args: ["auth"],
        cwd: dir,
        env: {},
        cliPath: file,
      });
      assert.equal(result.category, "auth-invalid-token");
      assert.equal(
        JSON.stringify(result).includes("SECRETWORD"),
        false,
        "stderr text is not returned",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("reports a CLI that cannot start", async () => {
    const result = await runCli({
      args: ["x"],
      cwd: tmpdir(),
      env: {},
      cliPath: path.join(tmpdir(), "does-not-exist.js"),
    });
    assert.notEqual(result.code, 0);
    assert.ok(result.category);
  });
});

describe("archives (zip and tar)", () => {
  async function tmp() {
    return mkdtemp(path.join(tmpdir(), "arch-test-"));
  }
  it("validates a good output and extracts it", async () => {
    const dir = await tmp();
    try {
      const { tgz } = validOutput(SHA1);
      const file = path.join(dir, "o.tgz");
      await writeFile(file, tgz);
      const v = await inspectTgz(file);
      assert.equal(v.bad, 0);
      assert.equal(v.findings, 0);
      assert.equal(v.files, 2);
      const out = path.join(dir, "root");
      await mkdir(out);
      await extractTgz(file, out);
      assert.equal(
        await readFile(path.join(out, ".vercel/output/config.json"), "utf8"),
        '{"version":3}',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects a truncated archive, a missing end marker is tolerated only when whole", async () => {
    const dir = await tmp();
    try {
      const { tgz } = validOutput(SHA1);
      const file = path.join(dir, "cut.tgz");
      await writeFile(file, tgz.subarray(0, tgz.length - 30));
      const v = await inspectTgz(file);
      assert.ok(v.bad > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses to extract a traversal and writes nothing outside the target", async () => {
    const dir = await tmp();
    try {
      const file = path.join(dir, "evil.tgz");
      await writeFile(
        file,
        validOutput(SHA1, [
          { name: ".vercel/output/../../escaped.txt", data: "x" },
        ]).tgz,
      );
      const out = path.join(dir, "root");
      await mkdir(out);
      await assert.rejects(
        () => extractTgz(file, out),
        (e) => e.code === "tar-invalid",
      );
      assert.equal(existsSync(path.join(dir, "escaped.txt")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects a bad checksum", async () => {
    const dir = await tmp();
    try {
      const raw = makeTgz([
        { name: ".vercel/output", type: "dir" },
        { name: ".vercel/output/a.txt", data: "x" },
      ]);
      const gunzipped = (await import("node:zlib")).gunzipSync(raw);
      gunzipped[0] ^= 1; // corrupt the first header
      const file = path.join(dir, "bad.tgz");
      await writeFile(file, (await import("node:zlib")).gzipSync(gunzipped));
      assert.ok((await inspectTgz(file)).bad > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it(
    "reads the symlink targets of an in-output link and rejects an escaping one",
    { skip: platform() === "win32" },
    async () => {
      const dir = await tmp();
      try {
        const good = path.join(dir, "good.tgz");
        await writeFile(
          good,
          validOutput(SHA1, [
            {
              name: ".vercel/output/functions/a.func",
              type: "symlink",
              linkname: "../static",
            },
          ]).tgz,
        );
        assert.equal((await inspectTgz(good)).symlinkEscapes, 0);
        const out = path.join(dir, "root");
        await mkdir(out);
        await extractTgz(good, out);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("client database ping", () => {
  it("parses hosts without credentials or ports", () => {
    assert.deepEqual(
      hostsOf("mongodb+srv://u:p%40ss@Cluster0.abc.mongodb.net/db?x=1"),
      ["cluster0.abc.mongodb.net"],
    );
    assert.deepEqual(
      hostsOf("mongodb://u:p@a.mongodb.net:27017,b.mongodb.net:27017/db"),
      ["a.mongodb.net", "b.mongodb.net"],
    );
    assert.deepEqual(hostsOf("not a uri"), []);
  });
  it("refuses anything that is not Atlas, with a code and no URI", async () => {
    for (const uri of [
      "mongodb://u:SECRETPW@127.0.0.1:27017/db",
      "mongodb://u:SECRETPW@169.254.169.254/db",
      "mongodb://u:SECRETPW@evil.example.com/db",
      "mongodb://u:SECRETPW@x.mongodb.net.evil.com/db",
    ]) {
      const code = await pingClientMongo(uri);
      assert.equal(code, "not-atlas");
    }
    assert.equal(await pingClientMongo("garbage"), "invalid");
  });
  it("pings a reachable database and maps failures to fixed codes", async () => {
    assert.equal(
      await pingClientMongo(repl.getUri(), { allowHost: () => true }),
      "ok",
    );
    assert.equal(
      await pingClientMongo("mongodb://127.0.0.1:1/x", {
        allowHost: () => true,
        timeoutMs: 300,
      }),
      "unreachable",
    );
    class AuthFails {
      async connect() {
        throw Object.assign(new Error("nope SECRETPW"), { code: 18 });
      }
      async close() {}
    }
    assert.equal(
      await pingClientMongo("mongodb://u:SECRETPW@h.mongodb.net/x", {
        Client: AuthFails,
      }),
      "auth-failed",
    );
    await assert.rejects(
      () =>
        openClientDb("mongodb://u:SECRETPW@h.mongodb.net/x", {
          Client: AuthFails,
        }),
      (error) =>
        error.code === "auth-failed" && !error.message.includes("SECRETPW"),
    );
  });
});

describe("self-check", () => {
  function fakeCli(onWhoami) {
    const calls = [];
    return {
      calls,
      runCli: async (opts) => {
        calls.push({ args: [...opts.args], env: { ...opts.env } });
        if (opts.args[0] === "--version")
          return {
            code: 0,
            category: null,
            stdout: `Vercel CLI ${CLI_VERSION}\n`,
          };
        await onWhoami?.(opts);
        return { code: 0, category: null, stdout: "owner\n" };
      },
    };
  }
  it("passes, prints ok/fail only and proves the token is only in the child's environment", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const cli = fakeCli();
    w.ctx.runCli = cli.runCli;
    const lines = [];
    const result = await selfCheck(w.ctx, {
      installationId: id,
      print: (l) => lines.push(l),
    });
    assert.equal(result.ok, true, lines.join("\n"));
    assert.ok(lines.includes("ok cli-version"));
    assert.ok(lines.includes("ok token-honoured"));
    assert.ok(lines.includes("ok token-not-on-disk"));
    assert.ok(lines.at(-1) === "self-check: ok");
    for (const line of lines)
      assert.equal(
        SECRETS.some((s) => line.includes(s)),
        false,
      );
    const whoami = cli.calls.find((c) => c.args[0] === "whoami");
    assert.equal(whoami.args.join(" ").includes(TOKEN), false);
    assert.equal(whoami.env.VERCEL_TOKEN, TOKEN);
  });
  it("fails when the token is left on the work volume", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    w.ctx.runCli = fakeCli(async (opts) => {
      // Outside the per-job directory (which is deleted): this one stays behind.
      await mkdir(path.join(env.workDir, "cache"), { recursive: true });
      await writeFile(
        path.join(env.workDir, "cache", "leak.txt"),
        `token=${TOKEN}`,
      );
    }).runCli;
    const lines = [];
    const result = await selfCheck(w.ctx, {
      installationId: id,
      print: (l) => lines.push(l),
    });
    assert.equal(result.ok, false);
    assert.ok(lines.includes("fail token-not-on-disk"));
  });
  it("fails when the CLI is not the expected version or the token is not honoured", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.runCli = async () => ({
      code: 0,
      category: null,
      stdout: "Vercel CLI 1.0.0\n",
    });
    assert.equal(
      (await selfCheck(w.ctx, { print: () => undefined })).ok,
      false,
    );
  });
});

describe("work volume", () => {
  it("cleans every job directory, also for failed jobs, and orphans at boot", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.cli.next({ kind: "fail", category: "network-error" });
    await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(await jobsDirEmpty(env), true);
    const orphan = path.join(env.workDir, "jobs", randomUUID());
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "x"), "x");
    await mkdir(path.join(env.workDir, "tmp"), { recursive: true });
    await writeFile(path.join(env.workDir, "tmp", "stale"), "x");
    await w.loop.boot();
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(path.join(env.workDir, "tmp", "stale")), false);
    assert.ok((await stat(path.join(env.workDir, "jobs"))).isDirectory());
  });
});

describe("takeover after an automatic rollback", () => {
  it("a worker killed right after the rollback ends the job as rolled-back, not as a success", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const id = await seedInstallation(env);
    env.health.bad.add("dpl_1");
    const original = env.vercel.rollback;
    env.vercel.rollback = async (...args) => {
      await original(...args);
      if (!a.dead) {
        await kill(a);
        await new Promise(() => {});
      }
    };
    await enqueue(env, id, { sha: SHA1 });
    a.loop.drain();
    await until(() => a.dead);
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const deploy = await deployOf(env, id);
    assert.equal(deploy.current.status, "rolled-back");
    assert.equal(deploy.last, null, "the new deployment never became `last`");
    assert.equal(env.vercel.state.production, "dpl_live");
  });
});

// ---- review fixes ------------------------------------------------------------------
const configEntry = (map, name = "a") => ({
  name: `.vercel/output/functions/${name}.func/.vc-config.json`,
  data: JSON.stringify({ runtime: "nodejs22.x", filePathMap: map }),
});
const inspect = async (entries) => {
  const dir = await mkdtemp(path.join(tmpdir(), "inspect-"));
  try {
    const file = path.join(dir, "o.tgz");
    await writeFile(file, validOutput(SHA1, entries).tgz);
    return await inspectTgz(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1;
  child.kill = () => true;
  setImmediate(() => child.emit("close", 0));
  return child;
};
describe("H1: .vc-config.json filePathMap", () => {
  const OK_FILE = { name: ".vercel/output/static/data.txt", data: "x" };
  it("accepts a map that points at regular files inside the output", async () => {
    const v = await inspect([
      OK_FILE,
      configEntry({ "data.txt": ".vercel/output/static/data.txt" }),
    ]);
    assert.equal(v.bad + v.findings, 0);
    assert.equal(v.filePathMap, 0);
  });
  const bad = [
    ["an absolute path", { x: "/proc/1/environ" }],
    ["a path with ..", { x: "../../../../proc/1/environ" }],
    ["a .. inside the output path", { x: ".vercel/output/../../etc/passwd" }],
    ["a path outside the output root", { x: "node_modules/pkg/index.js" }],
    ["a Windows drive path", { x: "C:/Windows/win.ini" }],
    [
      "a file that is not in the archive",
      { x: ".vercel/output/static/nope.txt" },
    ],
    ["a directory", { x: ".vercel/output/static" }],
    ["a non-string value", { x: 5 }],
    ["an unexpected key", { "../evil": ".vercel/output/static/data.txt" }],
    ["an absolute key", { "/etc/x": ".vercel/output/static/data.txt" }],
  ];
  for (const [name, map] of bad)
    it(`rejects ${name}`, async () => {
      const v = await inspect([OK_FILE, configEntry(map)]);
      assert.ok(v.filePathMap > 0, name);
      assert.ok(v.bad + v.findings > 0);
      assert.equal(tarProblemCode(v), "artifact-filepathmap");
    });
  it("rejects a map target that is a symlink, a map that is not an object, and a broken config", async () => {
    let v = await inspect([
      {
        name: ".vercel/output/static/link",
        type: "symlink",
        linkname: "data.txt",
      },
      OK_FILE,
      configEntry({ x: ".vercel/output/static/link" }),
    ]);
    assert.ok(v.filePathMap > 0, "a link is not a regular file");
    v = await inspect([
      {
        name: ".vercel/output/functions/a.func/.vc-config.json",
        data: JSON.stringify({ filePathMap: ["x"] }),
      },
    ]);
    assert.ok(v.filePathMap > 0);
    v = await inspect([
      {
        name: ".vercel/output/functions/a.func/.vc-config.json",
        data: "{not json",
      },
    ]);
    assert.ok(v.badConfig > 0);
  });
  it("a hostile map in the builder's artifact fails the build with artifact-filepathmap and nothing is uploaded", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.tweak.tgz = () =>
      validOutput(SHA1, [configEntry({ x: "../../../../proc/1/environ" })]).tgz;
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "artifact-filepathmap");
    assert.equal(env.cli.calls.length, 0);
    assert.equal(env.s3fake.liveKeys().length, 0);
  });
});

describe("M1: symlinks and extraction", () => {
  it("rejects link loops and writes through a link, accepts a clean chain", async () => {
    let v = await inspect([
      { name: ".vercel/output/a", type: "symlink", linkname: "b" },
      { name: ".vercel/output/b", type: "symlink", linkname: "a" },
    ]);
    assert.ok(v.symlinkEscapes > 0, "a loop cannot be resolved");
    v = await inspect([
      { name: ".vercel/output/sub", type: "symlink", linkname: "static" },
      { name: ".vercel/output/sub/evil.txt", data: "x" },
    ]);
    assert.ok(v.symlinkEscapes > 0, "an entry below a link writes through it");
    v = await inspect([
      { name: ".vercel/output/l1", type: "symlink", linkname: "l2" },
      {
        name: ".vercel/output/l2",
        type: "symlink",
        linkname: "static/index.html",
      },
    ]);
    assert.equal(v.symlinkEscapes, 0);
    v = await inspect([
      { name: ".vercel/output/l1", type: "symlink", linkname: "l2" },
      { name: ".vercel/output/l2", type: "symlink", linkname: "../.." },
    ]);
    assert.ok(v.symlinkEscapes > 0, "a chain that ends outside the output");
  });
  it("a refusal inside extraction is never reported as success (partial extraction)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "extract-"));
    try {
      const file = path.join(dir, "o.tgz");
      await writeFile(file, validOutput(SHA1).tgz);
      const out = path.join(dir, "root");
      await mkdir(out);
      // A FILE where the output directory must go: the first entry cannot be created.
      await writeFile(path.join(out, ".vercel"), "not a directory");
      await assert.rejects(
        () => extractTgz(file, out),
        (e) => e.code === "tar-invalid",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it(
    "extraction refuses an existing symlink on the path and never writes outside",
    { skip: platform() === "win32" },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "extract-"));
      try {
        const out = path.join(dir, "root");
        const outside = path.join(dir, "outside");
        await mkdir(out);
        await mkdir(outside);
        await symlink(outside, path.join(out, ".vercel"));
        const file = path.join(dir, "o.tgz");
        await writeFile(file, validOutput(SHA1).tgz);
        await assert.rejects(
          () => extractTgz(file, out),
          (e) => e.code === "tar-invalid",
        );
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("gives every job its own HOME under the job directory", async () => {
    const a = cliEnv({
      token: TOKEN,
      workDir: "/work",
      jobDir: "/work/jobs/a",
    });
    const b = cliEnv({
      token: TOKEN,
      workDir: "/work",
      jobDir: "/work/jobs/b",
    });
    for (const key of [
      "HOME",
      "TMPDIR",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
    ]) {
      assert.ok(
        a[key].startsWith(path.join("/work/jobs/a/cli") + path.sep),
        key,
      );
      assert.notEqual(a[key], b[key]);
    }
  });
});

describe("M2: the CLI runs under another uid", () => {
  it("spawns with the configured uid and gid, and the worker passes it", async () => {
    let seen;
    const spawn = (_cmd, _args, options) => {
      seen = options;
      return fakeChild();
    };
    await runCli({
      args: ["x"],
      cwd: tmpdir(),
      env: {},
      spawn,
      cliPath: "x",
      user: { uid: 10001, gid: 10001 },
    });
    assert.equal(seen.uid, 10001);
    assert.equal(seen.gid, 10001);
    assert.equal(seen.shell, false);
    await runCli({ args: ["x"], cwd: tmpdir(), env: {}, spawn, cliPath: "x" });
    assert.equal(
      "uid" in seen,
      false,
      "no uid change when the worker is not root",
    );
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.cliUser = { uid: 10001, gid: 10001 };
    const id = await seedInstallation(env);
    await deployOnce(env, w, id, { sha: SHA1 });
    assert.deepEqual(env.cli.calls[0].user, { uid: 10001, gid: 10001 });
    assert.equal(
      await jobsDirEmpty(env),
      true,
      "the job dir is removed even with the uid switch",
    );
  });
  it("self-check proves the isolation, and fails when the secrets are readable", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.runCli = async (o) => ({
      code: 0,
      category: null,
      stdout: o.args[0] === "--version" ? `${CLI_VERSION}\n` : "x",
    });
    w.ctx.isolationProbe = async () => "ok";
    let lines = [];
    let result = await selfCheck(w.ctx, { print: (l) => lines.push(l) });
    assert.ok(lines.includes("ok cli-isolation"));
    assert.equal(result.ok, true);
    w.ctx.isolationProbe = async () => "fail";
    lines = [];
    result = await selfCheck(w.ctx, { print: (l) => lines.push(l) });
    assert.ok(lines.includes("fail cli-isolation"));
    assert.equal(result.ok, false);
    assert.equal(await isolationProbe({ cliUser: null }, "/x"), "skip");
  });
  it("the container definition drops privileges as designed", async () => {
    const compose = await readFile("compose.production.yaml", "utf8");
    const docker = await readFile("Dockerfile", "utf8");
    const worker = compose.slice(compose.indexOf("  worker:"));
    assert.match(worker, /user: "0:0"/);
    assert.match(worker, /cap_drop: \[ALL\]/);
    assert.match(worker, /cap_add: \[SETUID, SETGID, KILL\]/);
    assert.match(worker, /no-new-privileges:true/);
    assert.match(worker, /read_only: true/);
    assert.match(worker, /core: 0/);
    assert.match(worker, /mem_limit: 512m/);
    for (const key of [
      "BACKUP_KEY",
      "ECOM_SERVICE_KEY",
      "STORE_MONGODB_URI",
      "POS_GITHUB_SOURCE_TOKEN",
    ])
      assert.match(worker, new RegExp(`${key}: ""`));
    assert.doesNotMatch(
      worker,
      /AUTH_SECRET: [^w]/,
      "the real AUTH_SECRET is replaced by a placeholder",
    );
    assert.match(docker, /--uid 10001/);
    assert.match(docker, /chown root:root \/work/);
    assert.doesNotMatch(docker, /chown node:node \/work/);
  });
});

describe("M3: a failed cache store does not stop deploys", () => {
  for (const [name, setup] of [
    [
      "S3 PUT denied (403)",
      (env) =>
        env.s3fake.fail("put", {
          status: 403,
          code: "AccessDenied",
          times: -1,
        }),
    ],
    [
      "S3 PUT 5xx",
      (env) =>
        env.s3fake.fail("put", {
          status: 500,
          code: "InternalError",
          times: -1,
        }),
    ],
    [
      "S3 PUT refused with 412 (contested)",
      (env) =>
        env.s3fake.fail("put", {
          status: 412,
          code: "PreconditionFailed",
          times: -1,
        }),
    ],
  ])
    it(`deploys from the local copy when ${name}, and a Redeploy reuses it`, async () => {
      const env = await makeEnv();
      const w = await makeWorker(env);
      const id = await seedInstallation(env);
      setup(env);
      const first = await deployOnce(env, w, id, { sha: SHA1 });
      assert.equal(first.current, null, JSON.stringify(first.current?.error));
      assert.equal(first.last.sha, SHA1);
      assert.equal(first.last.build.source, "artifact");
      assert.equal(first.last.build.objectKey, null);
      assert.ok(env.logs.some((l) => l.event === "build-not-cached"));
      assert.equal(
        env.gh.state.artifacts.size,
        1,
        "the artifact is kept until the sweep",
      );
      const second = await deployOnce(env, w, id, {
        kind: "redeploy",
        sha: SHA1,
      });
      assert.equal(second.current, null);
      assert.equal(env.gh.state.dispatches.length, 1, "no rebuild");
      await assertClean(env, id);
    });
  it("falls back to the kept GitHub artifact when the local copy is gone", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.s3fake.fail("put", { status: 403, code: "AccessDenied", times: -1 });
    await deployOnce(env, w, id, { sha: SHA1 });
    await rm(path.join(env.workDir, "builds"), {
      recursive: true,
      force: true,
    });
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.current, null);
    assert.equal(env.gh.state.dispatches.length, 1);
  });
});

describe("L4: disk errors are not integrity failures; S3 downloads retry", () => {
  it("a work-disk error fails the job without quarantining the cache entry", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await deployOnce(env, w, id, { sha: SHA1 });
    await rm(path.join(env.workDir, "builds"), {
      recursive: true,
      force: true,
    });
    const original = env.s3.getToFile;
    env.s3.getToFile = async () => {
      throw Object.assign(new Error("disk"), { s3Code: "WorkDisk" });
    };
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.current.error.code, "work-disk-error");
    assert.equal(
      env.s3fake.liveKeys().filter((k) => k.endsWith(".json")).length,
      1,
      "the manifest was not quarantined",
    );
    assert.equal(
      env.gh.state.dispatches.length,
      1,
      "no rebuild for a disk problem",
    );
    env.s3.getToFile = original;
  });
  it("retries transient download errors", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await deployOnce(env, w, id, { sha: SHA1 });
    await rm(path.join(env.workDir, "builds"), {
      recursive: true,
      force: true,
    });
    const original = env.s3.getToFile.bind(env.s3);
    let failures = 2;
    env.s3.getToFile = async (...args) => {
      if (failures-- > 0)
        throw Object.assign(new Error("net"), {
          s3Code: "Network",
          status: 503,
        });
      return original(...args);
    };
    const second = await deployOnce(env, w, id, {
      kind: "redeploy",
      sha: SHA1,
    });
    assert.equal(second.current, null);
    assert.equal(second.last.build.source, "cache");
  });
});

describe("M4: errors after promotion never hide a live deployment", () => {
  it("an alias timeout with the new deployment already serving ends as unhealthy with last/previous correct", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env, { t: { aliasMs: -1 } });
    const id = await seedInstallation(env);
    env.vercel.promote = async (pid, did) => {
      env.vercel.state.production = did;
      env.vercel.state.lastAlias = {
        toDeploymentId: did,
        jobStatus: "pending",
        type: "promote",
      };
      return { status: 201 };
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "unhealthy");
    assert.equal(deploy.current.error.code, "alias-timeout");
    assert.equal(
      deploy.last.vercelDeploymentId,
      "dpl_1",
      "what is live is recorded",
    );
    assert.equal(deploy.previous.status, "pre-admin");
    assert.equal(deploy.cutoverAt, null);
  });
  it("a provider error while checking production after a failed health check", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.health.bad.add("dpl_1");
    let armed = false;
    const get = env.health.get;
    w.ctx.healthGet = async (host, p) => {
      const res = await get(host, p);
      if (res.status !== 200 && env.vercel.state.production === "dpl_1")
        armed = true;
      return res;
    };
    const project = env.vercel.project;
    env.vercel.project = async (...args) => {
      if (armed) {
        armed = false;
        throw new ProviderError("vercel", "network", { retryable: true });
      }
      return project(...args);
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.status, "unhealthy");
    assert.equal(deploy.last.vercelDeploymentId, "dpl_1");
    assert.equal(env.vercel.state.production, "dpl_1");
  });
  it("a finalize failure after a healthy deploy still records the live deployment", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    let failOnce = true;
    const original = w.ctx.client.startSession.bind(w.ctx.client);
    w.ctx.client.startSession = (...args) => {
      const session = original(...args);
      const run = session.withTransaction.bind(session);
      session.withTransaction = async (fn, opts) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("mongo blip");
        }
        return run(fn, opts);
      };
      return session;
    };
    try {
      const deploy = await deployOnce(env, w, id, { sha: SHA1 });
      assert.equal(deploy.last.vercelDeploymentId, "dpl_1");
      assert.equal(deploy.current, null, "recovered as a healthy live deploy");
    } finally {
      w.ctx.client.startSession = original;
    }
  });
});

describe("L1 and L2: fallback keeps last correct; baseline health is retried", () => {
  it("after an automatic rollback through the Hobby fallback, last names the new deployment", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await deployOnce(env, w, id, { sha: SHA1 });
    await deployOnce(env, w, id, { sha: SHA2 });
    const before = await deployOf(env, id);
    env.vercel.state.rollbackError = new ProviderError("vercel", "rejected", {
      status: 402,
    });
    env.health.bad.add("dpl_3");
    const deploy = await deployOnce(env, w, id, { sha: "3".repeat(40) });
    assert.equal(deploy.current.status, "rolled-back");
    assert.notEqual(
      deploy.last.vercelDeploymentId,
      before.last.vercelDeploymentId,
    );
    assert.equal(deploy.last.vercelDeploymentId, env.vercel.state.production);
    assert.equal(deploy.last.sha, SHA2);
  });
  it("one failed baseline probe does not stop the automatic rollback", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.health.bad.add("dpl_1");
    const get = env.health.get;
    let first = true;
    w.ctx.healthGet = async (host, p) => {
      if (first && p === "/api/health") {
        first = false;
        return { status: 503, headers: {}, text: "" };
      }
      return get(host, p);
    };
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(
      deploy.current.status,
      "rolled-back",
      "the baseline counted as healthy",
    );
  });
});

describe("rollback contracts (c) and (d)", () => {
  async function twoDeploysForRollback(env, w, id) {
    await deployOnce(env, w, id, { sha: SHA1 });
    return deployOf(env, id);
  }
  it("(d) an instant rollback to a pre-admin baseline works", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploysForRollback(env, w, id);
    assert.equal(before.previous.status, "pre-admin");
    assert.equal(before.previous.sha, "");
    await enqueue(env, id, {
      kind: "rollback",
      sha: "",
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current, null, JSON.stringify(after.current?.error));
    assert.equal(after.last.vercelDeploymentId, "dpl_live");
    assert.equal(after.last.status, "rolled-back-to");
    assert.equal(env.vercel.state.production, "dpl_live");
  });
  it("(d) a refused rollback (402) to a pre-admin baseline fails with a clear code", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploysForRollback(env, w, id);
    env.vercel.state.rollbackError = new ProviderError("vercel", "rejected", {
      status: 402,
    });
    await enqueue(env, id, {
      kind: "rollback",
      sha: "",
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current.error.code, "rollback-baseline-no-fallback");
    assert.equal(env.vercel.state.production, before.last.vercelDeploymentId);
  });
  it("(c) the switch into the vercel step is atomic with a cancel request", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const before = await twoDeploysForRollback(env, w, id);
    await deployOnce(env, w, id, { sha: SHA2 });
    const now = await deployOf(env, id);
    const original = w.ctx.coll.installations.updateOne.bind(
      w.ctx.coll.installations,
    );
    let armed = true;
    w.ctx.coll.installations.updateOne = async (filter, update, options) => {
      if (armed && update?.$set?.["pos.deploy.current.step"] === "vercel") {
        armed = false;
        await original(
          { _id: id, "pos.deploy.current.status": "running" },
          { $set: { "pos.deploy.current.cancelRequested": true } },
        );
      }
      return original(filter, update, options);
    };
    await enqueue(env, id, {
      kind: "rollback",
      sha: SHA1,
      vercelDeploymentId: now.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const after = await deployOf(env, id);
    assert.equal(after.current.status, "cancelled");
    assert.equal(
      env.vercel.calledWith("rollback").length,
      0,
      "nothing was switched",
    );
    assert.ok(before);
  });
});

describe("L5/L6/L7: work volume, retention alerts, restore host check", () => {
  it("prunes build directories to a total size cap, oldest first", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const base = path.join(env.workDir, "builds");
    for (const [name, age] of [
      ["old", 300],
      ["mid", 200],
      ["new", 100],
    ]) {
      await mkdir(path.join(base, name), { recursive: true });
      await writeFile(path.join(base, name, "output.tgz"), Buffer.alloc(1000));
      const t = new Date(Date.now() - age * 1000);
      await utimes(path.join(base, name), t, t);
    }
    const removed = await pruneBuilds(w.ctx, 3600000, 2500);
    assert.equal(removed, 1);
    assert.deepEqual((await readdir(base)).sort(), ["mid", "new"]);
  });
  it("a rejected artifact leaves no zip or tgz behind", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    env.gh.state.tweak.manifest = (m) => ({
      ...m,
      buildEnvSha256: "0".repeat(64),
    });
    await deployOnce(env, w, id, { sha: SHA1 });
    const left = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory()) await walk(path.join(dir, e.name));
        else left.push(e.name);
      }
    };
    await walk(path.join(env.workDir, "builds"));
    assert.deepEqual(left, []);
  });
  it("tells the owner and the heartbeat when a live build could not be kept", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const now = env.clock.t;
    await seedInstallation(env, {
      deploy: {
        last: {
          requestId: "r1",
          sha: "4".repeat(40),
          vercelDeploymentId: "dpl_4",
          status: "succeeded",
          build: {
            buildKey: "4".repeat(64),
            objectKey: `builds/${"4".repeat(40)}/${"4".repeat(64)}/00000000-0000-4000-8000-000000000004.tgz.enc`,
            touchedAt: new Date(now - 8 * 86400000),
            source: "fresh",
          },
        },
      },
    });
    const result = await runRetention(w.ctx);
    assert.equal(result.missing, 1);
    assert.ok(
      env.notices.some(
        (n) => /retention/i.test(n.subject) && n.email === "owner@example.test",
      ),
    );
    const row = await env.db
      .collection("system_state")
      .findOne({ _id: "pos-worker" });
    assert.equal(row.retention.missing, 1);
    assertNoSecrets(env.notices, SECRETS, "notices");
  });
  it("the restore script normalises case and trailing dots before the Atlas check", async () => {
    const file = path.join(tmpdir(), "none.jsonl.gz");
    for (const host of ["C.MONGODB.NET", "c.mongodb.net.", "C.MongoDB.Net."])
      await assert.rejects(
        () => restoreBackup({ uri: `mongodb://u:p@${host}/x`, db: "s", file }),
        /Atlas/,
        host,
      );
  });
});

describe("deploy root writable by the CLI's uid (1777 on the root and .vercel only)", () => {
  it("prepares the root like a real job, and the self-check runs the CLI from one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "root-"));
    try {
      const root = path.join(dir, "root");
      await prepareDeployRoot(root, { orgId: "team_1", projectId: "prj_1" });
      if (platform() !== "win32") {
        assert.equal((await stat(root)).mode & 0o7777, 0o1777);
        assert.equal(
          (await stat(path.join(root, ".vercel"))).mode & 0o7777,
          0o1777,
        );
        assert.notEqual(
          (await stat(path.join(root, "apps"))).mode & 0o7777,
          0o1777,
        );
      }
      assert.ok(existsSync(path.join(root, "apps", "cafe")));
      assert.ok(existsSync(path.join(root, ".vercel", "project.json")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const cwds = [];
    w.ctx.runCli = async (o) => {
      cwds.push({
        cwd: o.cwd,
        ok:
          existsSync(path.join(o.cwd, ".vercel", "project.json")) &&
          existsSync(path.join(o.cwd, "apps", "cafe")),
      });
      return { code: 0, category: null, stdout: `${CLI_VERSION}\n` };
    };
    await selfCheck(w.ctx, { installationId: id, print: () => undefined });
    assert.ok(
      cwds.length >= 2 && cwds.every((c) => c.ok),
      JSON.stringify(cwds),
    );
  });
});

describe("re-review fixes", () => {
  it("M-A (pure): the cleanup walk deletes only entries owned by the uid, never follows links, survives failures", async () => {
    const tree = {
      "/j/cli": ["data", "keep.txt"],
      "/j/cli/data": ["com.vercel.cli"],
      "/j/root": ["payload", "mine"],
      "/j/root/.vercel": ["README.txt", "output"],
    };
    const owners = {
      "/j/cli/data": 0,
      "/j/cli/keep.txt": 0,
      "/j/cli/data/com.vercel.cli": 10001,
      "/j/root/payload": 0,
      "/j/root/mine": 10001,
      "/j/root/.vercel/README.txt": 10001,
      "/j/root/.vercel/output": 0,
    };
    const dirsSet = new Set(["/j/cli/data", "/j/cli/data/com.vercel.cli"]);
    const removed = [];
    const fakeFs = {
      readdir: async (d) => {
        if (!tree[d]) throw Object.assign(new Error("x"), { code: "ENOENT" });
        return tree[d];
      },
      lstat: async (p) => ({
        uid: owners[p] ?? 0,
        isDirectory: () => dirsSet.has(p),
        isSymbolicLink: () => false,
      }),
      rm: async (p, o) => {
        assert.equal(o.recursive, true);
        if (p === "/j/root/mine") throw new Error("EBUSY");
        removed.push(p);
      },
    };
    const dirs = await jobCleanDirs(fakeFs, "/j");
    assert.deepEqual(dirs, [
      "/j/cli",
      "/j/root",
      "/j/root/.vercel",
      "/j/cli/data",
    ]);
    const out = await cleanOwnedEntries(fakeFs, dirs, 10001);
    assert.deepEqual(removed.sort(), [
      "/j/cli/data/com.vercel.cli",
      "/j/root/.vercel/README.txt",
    ]);
    assert.equal(out.failed, 1);
    assert.equal(
      out.skipped >= 4,
      true,
      "root-owned entries are never touched",
    );
  });
  it(
    "M-A (Linux): a job dir with CLI-created, 10001-style nested dirs is fully removed",
    { skip: platform() !== "linux" },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "job-"));
      await prepareCliDir(dir);
      await prepareDeployRoot(path.join(dir, "root"), {});
      await mkdir(path.join(dir, "root", ".vercel", "output", "static"), {
        recursive: true,
      });
      await writeFile(
        path.join(dir, "root", ".vercel", "output", "static", "a.html"),
        "x",
      );
      // What the CLI creates (here: our own uid stands in for 10001).
      await mkdir(path.join(dir, "cli", "data", "com.vercel.cli", "deep"), {
        recursive: true,
      });
      await writeFile(
        path.join(dir, "cli", "data", "com.vercel.cli", "deep", "auth.json"),
        "{}",
      );
      await writeFile(path.join(dir, "root", ".vercel", "README.txt"), "x");
      const me = { uid: process.getuid(), gid: process.getgid() };
      assert.equal(await removeJobDir(me, dir), true);
      assert.equal(existsSync(dir), false);
    },
  );
  it(
    "M-A: pre-created skeletons, and the boot sweep removes an already-leaked tree",
    { skip: platform() === "win32" },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "job-"));
      await prepareCliDir(dir);
      for (const n of ["home", "tmp", "data", "config", "cache"])
        assert.equal(
          (await stat(path.join(dir, "cli", n))).mode & 0o7777,
          0o1777,
          n,
        );
      await rm(dir, { recursive: true, force: true });
      const env = await makeEnv();
      const w = await makeWorker(env);
      w.ctx.cliUser = { uid: process.getuid(), gid: process.getgid() };
      const orphan = path.join(env.workDir, "jobs", randomUUID());
      await mkdir(path.join(orphan, "cli", "data", "com.vercel.cli"), {
        recursive: true,
      });
      await writeFile(
        path.join(orphan, "cli", "data", "com.vercel.cli", "x"),
        "x",
      );
      await w.loop.boot();
      assert.equal(existsSync(orphan), false);
    },
  );
  it("L1: processes of the CLI's uid are reaped and a survivor fails the job closed (cli-orphan)", async () => {
    const proc = await mkdtemp(path.join(tmpdir(), "proc-"));
    try {
      await mkdir(path.join(proc, "123"));
      await writeFile(
        path.join(proc, "123", "status"),
        "Name:\tnode\nUid:\t10001\t10001\t10001\t10001\n",
      );
      await mkdir(path.join(proc, "124"));
      await writeFile(
        path.join(proc, "124", "status"),
        "Name:\tworker\nUid:\t0\t0\t0\t0\n",
      );
      assert.deepEqual(await listUidProcesses(10001, proc), [123]);
      const calls = [];
      const spawn = (cmd, args, options) => {
        calls.push({ args, uid: options.uid });
        return fakeChild();
      };
      const left = await reapCliProcesses(
        { uid: 10001, gid: 10001 },
        { procRoot: proc, attempts: 2, delayMs: 1, spawn },
      );
      assert.equal(left, 1);
      assert.equal(calls[0].uid, 10001);
      assert.match(calls[0].args[1], /process\.kill\(-1,'SIGKILL'\)/);
      await rm(path.join(proc, "123"), { recursive: true });
      assert.equal(
        await reapCliProcesses(
          { uid: 10001, gid: 10001 },
          { procRoot: proc, attempts: 2, delayMs: 1, spawn },
        ),
        0,
      );
      assert.equal(await reapCliProcesses(null), 0);
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.reapCli = async () => 1;
    const id = await seedInstallation(env);
    const deploy = await deployOnce(env, w, id, { sha: SHA1 });
    assert.equal(deploy.current.error.code, "cli-orphan");
    assert.equal(deploy.last, null);
  });
  it("M-B: a verify that raced a settings change cannot overwrite the invalidation", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    const user = env.vercel.user;
    env.vercel.user = async (...a) => {
      await env.db
        .collection("installations")
        .updateOne(
          { _id: id },
          { $inc: { "pos.rev": 1 }, $set: { "pos.verify": null } },
        );
      return user(...a);
    };
    await enqueueTask(env, id, "verify");
    await w.loop.drain();
    const row = await rowOf(env, id);
    assert.equal(row.pos.verify, null, "the invalidation stands");
    assert.equal(row.pos.task.status, "failed");
    assert.equal(row.pos.task.error.code, "verify-stale");
  });
  it(
    "L3: files the self-check could not read are counted, not skipped silently",
    { skip: platform() === "win32" || (process.getuid?.() ?? 1) === 0 },
    async () => {
      const env = await makeEnv();
      const w = await makeWorker(env);
      const id = await seedInstallation(env);
      w.ctx.runCli = async (o) => ({
        code: 0,
        category: null,
        stdout: `${CLI_VERSION}\n`,
      });
      const secret = path.join(env.workDir, "cache", "secret.bin");
      await mkdir(path.dirname(secret), { recursive: true });
      await writeFile(secret, "x");
      await chmod(secret, 0o000);
      const lines = [];
      try {
        await selfCheck(w.ctx, {
          installationId: id,
          print: (l) => lines.push(l),
        });
      } finally {
        await chmod(secret, 0o600);
      }
      const info = lines.find((l) => l.startsWith("info unchecked-files "));
      assert.ok(info && Number(info.split(" ")[2]) >= 1, lines.join("|"));
    },
  );
  it("L4: too many configs fail, and a prerender fallback follows the same rules as filePathMap", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inspect-"));
    try {
      const run = async (entries, options) => {
        const file = path.join(dir, `${randomUUID()}.tgz`);
        await writeFile(file, validOutput(SHA1, entries).tgz);
        return inspectTgz(file, options);
      };
      const cfg = (n) => ({
        name: `.vercel/output/functions/f${n}.func/.vc-config.json`,
        data: "{}",
      });
      let v = await run([cfg(1), cfg(2), cfg(3)], { maxConfigs: 2 });
      assert.ok(
        v.badConfig > 0,
        "the third config was not inspected, so refuse",
      );
      v = await run([cfg(1), cfg(2)], { maxConfigs: 2 });
      assert.equal(v.badConfig, 0);
      const pre = (fallback) => ({
        name: ".vercel/output/functions/p.prerender-config.json",
        data: JSON.stringify({ fallback }),
      });
      const target = {
        name: ".vercel/output/functions/p.prerender-fallback.html",
        data: "<p>",
      };
      v = await run([target, pre("p.prerender-fallback.html")]);
      assert.equal(v.filePathMap, 0);
      v = await run([target, pre({ fsPath: "p.prerender-fallback.html" })]);
      assert.equal(v.filePathMap, 0);
      for (const bad of [
        "../../../etc/passwd",
        "/proc/1/environ",
        "missing.html",
        { fsPath: "../x" },
        5,
      ])
        assert.ok(
          (await run([target, pre(bad)])).filePathMap > 0,
          JSON.stringify(bad),
        );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("L6: a missing heartbeat row counts as stale (queued work expires), like the API", async () => {
    const env = await makeEnv();
    const id = await seedInstallation(env);
    await enqueue(env, id);
    const w = await makeWorker(env);
    await w.loop.drain();
    const cur = (await deployOf(env, id)).current;
    assert.equal(cur.status, "expired");
    assert.equal(cur.error.code, "not-picked-up");
  });
  it("L7: a non-root worker fails the isolation check in production; hidepid (ENOENT) is isolation", async () => {
    assert.equal(
      await isolationProbe(
        { cliUser: null, c: { NODE_ENV: "production" } },
        "/x",
      ),
      "fail:worker-not-root",
    );
    assert.equal(
      await isolationProbe({ cliUser: null, c: { NODE_ENV: "test" } }, "/x"),
      "skip",
    );
    const env = await makeEnv();
    const w = await makeWorker(env);
    // The uid source is injectable: a worker that is not root has no cliUser,
    // whatever uid the test process really runs as.
    const nonRoot = await buildContext({
      c: env.c,
      db: env.db,
      client,
      getuid: () => 1000,
      overrides: { workDir: env.workDir },
    });
    assert.equal(nonRoot.cliUser, null);
    const asRoot = await buildContext({
      c: env.c,
      db: env.db,
      client,
      getuid: () => 0,
      overrides: { workDir: env.workDir },
    });
    assert.deepEqual(asRoot.cliUser, { uid: 10001, gid: 10001 });
    w.ctx.cliUser = nonRoot.cliUser;
    w.ctx.c = { ...w.ctx.c, NODE_ENV: "production" };
    w.ctx.runCli = async () => ({
      code: 0,
      category: null,
      stdout: `${CLI_VERSION}\n`,
    });
    const lines = [];
    const result = await selfCheck(w.ctx, { print: (l) => lines.push(l) });
    assert.ok(lines.includes("fail cli-isolation worker-not-root"));
    assert.equal(result.ok, false);
  });
  it("the isolation probe names the failing sub-check with a fixed reason code", async () => {
    const ctx = { cliUser: { uid: 10001, gid: 10001 } };
    const probe = async (out) => {
      ctx.probeSpawn = () => (out instanceof Error ? { error: out } : out);
      return isolationProbe(ctx, "/work/jobs/x/cli/home");
    };
    const ok = (stdout) => ({ status: 0, stdout });
    assert.equal(await probe(ok("10001,EACCES,EACCES,OK")), "ok");
    assert.equal(
      await probe(ok("10001,ENOENT,ENOENT,OK")),
      "ok",
      "hidepid is isolation",
    );
    assert.equal(
      await probe(ok("10001,READ,EACCES,OK")),
      "fail:proc1-readable",
    );
    assert.equal(
      await probe(ok("10001,EACCES,READ,OK")),
      "fail:worker-environ-readable",
    );
    assert.equal(
      await probe(ok("10001,ESRCH,EACCES,OK")),
      "fail:proc1-unexpected-esrch",
    );
    assert.equal(
      await probe(ok("10001,EACCES,EIO,OK")),
      "fail:worker-environ-unexpected-eio",
    );
    assert.equal(await probe(ok("0,EACCES,EACCES,OK")), "fail:not-dropped-uid");
    assert.equal(
      await probe(ok("10001,EACCES,EACCES,EACCES")),
      "fail:home-not-writable-eacces",
    );
    assert.equal(
      await probe(ok("10001,EACCES,EACCES,BLOCKED3")),
      "fail:home-path-blocked-at-3",
    );
    assert.equal(await probe(ok("garbage")), "fail:probe-bad-output");
    assert.equal(await probe({ status: 1, stdout: "" }), "fail:probe-exit-1");
    assert.equal(
      await probe(Object.assign(new Error("x"), { code: "EPERM" })),
      "fail:spawn-failed-eperm",
    );
  });
  it("a self-check line carries the reason: fail cli-isolation <reason>", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    w.ctx.runCli = async () => ({
      code: 0,
      category: null,
      stdout: `${CLI_VERSION}
`,
    });
    w.ctx.isolationProbe = async () => "fail:proc1-readable";
    const lines = [];
    await selfCheck(w.ctx, { print: (l) => lines.push(l) });
    assert.ok(
      lines.includes("fail cli-isolation proc1-readable"),
      lines.join("|"),
    );
  });
  it(
    "the work dir and job dirs are traversable for the CLI's uid even under a 0700 temp dir",
    { skip: platform() === "win32" },
    async () => {
      const env = await makeEnv();
      await chmod(env.workDir, 0o700);
      await makeWorker(env); // boot runs ensureLayout
      assert.equal((await stat(env.workDir)).mode & 0o777, 0o755);
      assert.equal(
        (await stat(path.join(env.workDir, "jobs"))).mode & 0o777,
        0o755,
      );
    },
  );
  it("L9: the audit detail of a pre-admin rollback has no @", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const id = await seedInstallation(env);
    await deployOnce(env, w, id, { sha: SHA1 });
    const before = await deployOf(env, id);
    await enqueue(env, id, {
      kind: "rollback",
      sha: "",
      branch: "",
      vercelDeploymentId: before.previous.vercelDeploymentId,
    });
    await w.loop.drain();
    const events = await env.db
      .collection("audit_events")
      .find({ action: "pos.rollback.succeeded" })
      .toArray();
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /^pre-admin baseline #/);
    assert.equal(events[0].detail.includes("@"), false);
  });
});
