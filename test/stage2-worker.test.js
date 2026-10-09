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
import { buildContext, selfCheck } from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import { cliEnv, runCli } from "../backend/worker/cli-runner.js";
import { extractTgz, inspectTgz } from "../backend/worker/artifact.js";
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
    cache: cache ? createBuildCache({ s3, vaultKey: VAULT_KEY }) : null,
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
  await env.db
    .collection("staff")
    .updateOne(
      { _id: "staff-1" },
      { $set: { email: "owner@example.test", name: "Owner" } },
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
    // A queued job older than ten minutes expires instead of running.
    const id2 = await seedInstallation(env, { slug: "other" });
    await enqueue(env, id2, {
      requestedAt: new Date(env.clock.t - 11 * 60000),
    });
    await w.loop.drain();
    cur = (await deployOf(env, id2)).current;
    assert.equal(cur.status, "expired");
    assert.equal(env.gh.state.dispatches.length, 0);
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
      assert.equal(seen.env.HOME, path.join(dir, "home"));
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
      await mkdir(opts.env.HOME, { recursive: true });
      await writeFile(path.join(opts.env.HOME, "leak.txt"), `token=${TOKEN}`);
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
