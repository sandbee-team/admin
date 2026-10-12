// P3 rollout driver (docs/P3-ROLLOUT.md §5): the worker advances the one
// pos-rollout row through normal deploy jobs, one client at a time, and stops
// at the first failure. Fakes as in stage2-worker.test.js (own setup, the
// Phase 2 pattern).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { indexes } from "../backend/db.js";
import { encrypt } from "../backend/lib/crypto.js";
import { createBuildCache } from "../backend/lib/build-cache.js";
import { buildContext } from "../backend/worker/context.js";
import { createLoop } from "../backend/worker/loop.js";
import { JOB_STEPS, buildRowId } from "../shared/deploy.js";
import { isKnownCode } from "../shared/deploy-errors.js";
import { newRolloutTarget } from "../shared/rollout.js";
import { createFakeS3 } from "./fake-s3.js";
import { createFakeCli } from "./fakes/cli.js";
import {
  createFakeGitHub,
  createFakeVercel,
  createHealthGet,
} from "./fakes/builder.js";
import { VAULT_KEY, assertNoSecrets } from "./helpers.js";

const CLI_VERSION = "63.1.0";
const TOKEN = "vcp_TESTTOKEN_0123456789abcdef0123456789abcdef";
const MONGO_URI =
  "mongodb+srv://clientuser:ClientPass9z@cluster0.abcde.mongodb.net/demo";
const SECRETS = [TOKEN, MONGO_URI, "ClientPass9z", VAULT_KEY];
const SHA1 = "1".repeat(40);
const R2 = "https://pub-1.example.r2.dev";

let repl,
  client,
  counter = 0;
const workDirs = [];
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
  await Promise.all(
    workDirs.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

async function makeEnv() {
  const db = client.db(`r${++counter}`);
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
  const env = {
    db,
    clock,
    s3fake,
    s3,
    cache: createBuildCache({ s3, vaultKey: VAULT_KEY, sleep: async () => {} }),
    gh,
    vercel,
    health,
    logs: [],
    notices: [],
    uploads: 0,
    // Active deploy jobs seen at each upload (proves one at a time).
    activeAtUpload: [],
    onUpload: null,
    c: {
      VAULT_KEY,
      POS_BUILDER_REF: "main",
      POS_BUILDER_WORKFLOW: "build.yml",
    },
  };
  env.cli = createFakeCli({
    onRun: async (call) => {
      env.uploads++;
      env.activeAtUpload.push(
        await db.collection("installations").countDocuments({
          "pos.deploy.current.status": {
            $in: ["queued", "running", "cancelling"],
          },
        }),
      );
      const meta = call.args[call.args.indexOf("--meta") + 1].split("=")[1];
      const deployment = vercel.createFromCli({ sandbeeRequest: meta });
      await env.onUpload?.(env.uploads, deployment);
    },
  });
  env.workDir = await mkdtemp(path.join(tmpdir(), "rollout-test-"));
  workDirs.push(env.workDir);
  env.c.POS_WORK_DIR = env.workDir;
  await db.collection("staff").insertOne({
    _id: "staff-1",
    email: "owner@example.test",
    name: "Owner",
    role: "owner",
    status: "active",
    authVersion: 1,
  });
  return env;
}
async function makeWorker(env) {
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
      pingMongo: async () => "ok",
      cloudflareVerify: async () => ({ ok: true }),
      sleep: async () => {
        if (w.dead) return new Promise(() => {});
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
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
const never = () => new Promise(() => {});
// A POS client ready for a rollout. Every client answers the fake health
// probe as tenant "demo" and shares the fake Vercel project.
async function seedClient(
  env,
  slug,
  { customerStatus = "active", pos = {}, deploy = {} } = {},
) {
  const id = randomUUID(),
    customerId = randomUUID();
  await env.db.collection("customers").insertOne({
    _id: customerId,
    status: customerStatus,
    email: `${customerId}@example.test`,
  });
  await env.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: "pos",
    status: "live",
    pos: {
      rev: 1,
      slug,
      host: `${slug}.example.com`,
      tenantId: "demo",
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
      image: { store: "r2", publicBaseUrl: R2 },
      deploy: {
        current: null,
        last: null,
        previous: null,
        cutoverAt: null,
        ...deploy,
      },
      verify: {
        at: new Date(env.clock.t),
        by: { id: "staff-1", name: "Owner" },
        vercel: "ok",
        project: "ok",
        env: "ok",
        mongo: "ok",
        cloudflare: null,
        health: "ok",
      },
      ...pos,
    },
  });
  return id;
}
// The row as POST /pos/rollout (or a Resume) leaves it.
async function seedRollout(env, clients, over = {}) {
  const doc = {
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
    by: { id: "staff-1", name: "Owner" },
    auth: { id: "staff-1", name: "Owner", authVersion: 1, role: "owner" },
    resumed: null,
    startedAt: new Date(env.clock.t),
    finishedAt: null,
    stopOnFailure: true,
    cancelRequested: false,
    stop: null,
    prepared: false,
    lease: { owner: null, until: null, fence: 0 },
    targets: clients.map(([id, slug]) => newRolloutTarget(id, slug)),
    ...over,
  };
  await env.db.collection("system_state").insertOne(doc);
  return doc;
}
const rolloutOf = (env) =>
  env.db.collection("system_state").findOne({ _id: "pos-rollout" });
const deployOf = async (env, id) =>
  (await env.db.collection("installations").findOne({ _id: id })).pos.deploy;
const statuses = (row) => row.targets.map((t) => [t.slug, t.status]);
const queuedJob = (env, over = {}) => ({
  kind: "deploy",
  requestId: randomUUID(),
  branch: "main",
  sha: SHA1,
  buildKey: null,
  commit: null,
  by: { id: "staff-1", name: "Owner" },
  requestedAt: new Date(env.clock.t),
  status: "queued",
  step: "queued",
  steps: JOB_STEPS.deploy.map((name) => ({
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
  vercelDeploymentId: null,
  url: null,
  baseline: null,
  cancelRequested: false,
  error: null,
  finishedAt: null,
  ...over,
});
async function assertClean(env) {
  assertNoSecrets(
    await env.db
      .collection("system_state")
      .find({ _id: { $ne: "vault-v1" } })
      .toArray(),
    SECRETS,
    "system_state",
  );
  assertNoSecrets(
    await env.db.collection("audit_events").find().toArray(),
    SECRETS,
    "audit",
  );
  assertNoSecrets(env.logs, SECRETS, "logs");
}
const requested = (env, id) =>
  env.db
    .collection("audit_events")
    .find({ action: "pos.deploy.requested", resourceId: id })
    .toArray();

describe("rollout driver: the happy path", () => {
  it("builds once, then deploys demo, alpha, beta one at a time", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const beta = await seedClient(env, "beta");
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    const doc = await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
      [beta, "beta"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.ok(row.finishedAt instanceof Date);
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "succeeded"],
      ["beta", "succeeded"],
    ]);
    // One build key for all three (same inputs): one GitHub build.
    assert.equal(env.gh.state.dispatches.length, 1);
    assert.deepEqual(
      row.targets.map((t) => t.prebuild),
      ["queued", "joined", "joined"],
    );
    // Strictly one deploy job at a time, in order.
    assert.deepEqual(env.activeAtUpload, [1, 1, 1]);
    for (const [i, id] of [demo, alpha, beta].entries()) {
      const deploy = await deployOf(env, id);
      assert.equal(deploy.current, null);
      assert.equal(deploy.last.sha, SHA1);
      assert.equal(deploy.last.requestId, row.targets[i].requestId);
      assert.equal(deploy.last.by.name, "Owner");
      assert.equal(deploy.last.commit.headline, "Rollout commit");
      const events = await requested(env, id);
      assert.equal(events.length, 1);
      assert.equal(events[0].actorId, "worker");
      assert.match(
        events[0].detail,
        new RegExp(`rollout #${doc.id.slice(0, 8)}$`),
      );
    }
    const finished = await env.db
      .collection("audit_events")
      .findOne({ action: "pos.rollout.finished" });
    assert.match(finished.detail, /^completed: 3 ok, 0 failed, 0 skipped #/);
    // Pre-build rows are gone once stored.
    assert.equal(
      await env.db.collection("system_state").countDocuments({ kind: "build" }),
      0,
    );
    await assertClean(env);
  });
  it("uses a cached build without dispatching again", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    await seedRollout(env, [[demo, "demo"]]);
    await w.loop.drain();
    assert.equal(env.gh.state.dispatches.length, 1);
    await env.db.collection("system_state").deleteOne({ _id: "pos-rollout" });
    const alpha = await seedClient(env, "alpha");
    const beta = await seedClient(env, "beta");
    await seedRollout(env, [
      [alpha, "alpha"],
      [beta, "beta"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.deepEqual(
      row.targets.map((t) => t.prebuild),
      ["queued", "joined"],
    );
    assert.equal(env.gh.state.dispatches.length, 1, "no second build");
  });
  it("skips clients locked, inactive or already live at their turn and continues", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha", { pos: { deployLock: true } });
    const beta = await seedClient(env, "beta", { customerStatus: "paused" });
    const gamma = await seedClient(env, "gamma", {
      deploy: { last: { sha: SHA1, requestId: "r-old" } },
    });
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
      [beta, "beta"],
      [gamma, "gamma"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.deepEqual(
      row.targets.map((t) => [t.slug, t.status, t.error?.code ?? null]),
      [
        ["demo", "succeeded", null],
        ["alpha", "skipped", "locked"],
        ["beta", "skipped", "customer-inactive"],
        ["gamma", "skipped", "already-live"],
      ],
    );
    assert.equal(env.uploads, 1);
  });
  it("after a Resume, retries from the client it stopped at (succeeded ones stay)", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo", {
      deploy: { last: { sha: SHA1, requestId: "r-demo" } },
    });
    const alpha = await seedClient(env, "alpha");
    await seedRollout(
      env,
      [
        [demo, "demo"],
        [alpha, "alpha"],
      ],
      {
        targets: [
          {
            ...newRolloutTarget(demo, "demo"),
            status: "succeeded",
            requestId: "r-demo",
          },
          newRolloutTarget(alpha, "alpha"),
        ],
      },
    );
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "succeeded"],
    ]);
    assert.equal(env.uploads, 1, "demo is not deployed again");
  });
});

describe("rollout driver: stops at the first failure", () => {
  it("a failed build stops at demo; the rest are skipped", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    env.gh.state.tweak.fail = "Build";
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.equal(row.stop.slug, "demo");
    assert.ok(isKnownCode(row.stop.code) && row.stop.code !== "job-lost");
    assert.equal(row.targets[0].status, "failed");
    assert.equal(row.targets[0].error.code, row.stop.code);
    assert.deepEqual(row.targets[1], {
      ...row.targets[1],
      status: "skipped",
      error: { code: "rollout-stopped" },
    });
    assert.equal((await deployOf(env, alpha)).last, null, "alpha untouched");
    assert.equal(env.uploads, 0);
    const finished = await env.db
      .collection("audit_events")
      .findOne({ action: "pos.rollout.finished" });
    assert.match(finished.detail, /^stopped: 0 ok, 1 failed, 1 skipped #/);
    await assertClean(env);
  });
  it("an automatic rollback (failed health check) stops at that client", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    env.onUpload = async (n, deployment) => {
      if (n === 2) env.health.bad.add(deployment.id);
    };
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    const beta = await seedClient(env, "beta");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
      [beta, "beta"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "alpha", code: "health-failed" });
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "failed"],
      ["beta", "skipped"],
    ]);
    assert.equal((await deployOf(env, alpha)).current.status, "rolled-back");
    assert.equal(env.uploads, 2);
  });
  it("a client whose verify went stale stops the rollout with the readiness ids", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await env.db
      .collection("installations")
      .updateOne(
        { _id: alpha },
        { $set: { "pos.verify.at": new Date(env.clock.t - 25 * 3600000) } },
      );
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "alpha", code: "target-not-ready" });
    assert.deepEqual(row.targets[1].error, {
      code: "target-not-ready",
      items: ["verified"],
    });
    assert.equal(row.targets[1].status, "failed");
    assert.equal(env.uploads, 1);
  });
  it("a client busy with another deploy stops the rollout", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const alpha = await seedClient(env, "alpha");
    // Someone else's running job with a live lease: the worker leaves it be.
    await env.db.collection("installations").updateOne(
      { _id: alpha },
      {
        $set: {
          "pos.deploy.current": queuedJob(env, {
            status: "running",
            step: "build",
            lease: {
              owner: "w-other",
              until: new Date(env.clock.t + 600000),
              fence: 1,
            },
          }),
        },
      },
    );
    await seedRollout(env, [[alpha, "alpha"]]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "alpha", code: "target-busy" });
    assert.equal(env.uploads, 0);
  });
  it("stops when the starter can no longer deploy", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    env.onUpload = async (n) => {
      if (n === 1)
        await env.db
          .collection("staff")
          .updateOne({ _id: "staff-1" }, { $inc: { authVersion: 1 } });
    };
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "alpha", code: "not-authorized" });
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "skipped"],
    ]);
    assert.equal(env.uploads, 1);
  });
  it("calls a job dismissed before its result was read job-lost", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [], {
      prepared: true,
      targets: [
        {
          ...newRolloutTarget(demo, "demo"),
          status: "building",
          requestId: "r-gone",
        },
        newRolloutTarget(alpha, "alpha"),
      ],
    });
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "job-lost" });
    assert.equal(env.uploads, 0);
  });
});

describe("rollout driver: review fixes", () => {
  it("an unhealthy deploy without rollback stops, and Resume deploys that client again", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    // The live baseline is unhealthy too, so no automatic rollback happens.
    env.health.bad.add("dpl_live");
    env.onUpload = async (n, deployment) => {
      if (n === 1) env.health.bad.add(deployment.id);
    };
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    const doc = await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    let row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "health-failed" });
    const first = await deployOf(env, demo);
    assert.equal(first.current.status, "unhealthy");
    assert.equal(first.last.sha, SHA1);
    assert.equal(first.last.healthy, false, "last says it went live unhealthy");
    // The owner dismisses the unhealthy job, then resumes (as the API does).
    await env.db
      .collection("installations")
      .updateOne({ _id: demo }, { $set: { "pos.deploy.current": null } });
    env.health.bad.clear();
    await env.db.collection("system_state").updateOne(
      { _id: "pos-rollout" },
      {
        $set: {
          status: "running",
          stop: null,
          finishedAt: null,
          prepared: false,
          targets: [
            newRolloutTarget(demo, "demo"),
            newRolloutTarget(alpha, "alpha"),
          ],
        },
      },
    );
    await w.loop.drain();
    row = await rolloutOf(env);
    assert.equal(row.id, doc.id);
    assert.equal(row.status, "completed");
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "succeeded"],
    ]);
    assert.equal(env.uploads, 3, "demo is deployed again, then alpha");
    assert.equal((await deployOf(env, demo)).last.healthy, true);
  });
  it("skips a client locked while its job waited, and goes on", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    const job = queuedJob(env, {
      status: "failed",
      step: "preflight",
      error: { step: "preflight", code: "locked", message: "Locked." },
      finishedAt: new Date(env.clock.t),
    });
    await env.db
      .collection("installations")
      .updateOne({ _id: demo }, { $set: { "pos.deploy.current": job } });
    await seedRollout(env, [], {
      prepared: true,
      targets: [
        {
          ...newRolloutTarget(demo, "demo"),
          status: "building",
          requestId: job.requestId,
        },
        newRolloutTarget(alpha, "alpha"),
      ],
    });
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.deepEqual(
      row.targets.map((t) => [t.slug, t.status, t.error?.code ?? null]),
      [
        ["demo", "skipped", "locked"],
        ["alpha", "succeeded", null],
      ],
    );
  });
  it("an expired job stops the rollout", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    const job = queuedJob(env, {
      status: "expired",
      error: { step: "queued", code: "not-picked-up", message: "Late." },
      finishedAt: new Date(env.clock.t),
    });
    await env.db
      .collection("installations")
      .updateOne({ _id: demo }, { $set: { "pos.deploy.current": job } });
    await seedRollout(env, [], {
      prepared: true,
      targets: [
        {
          ...newRolloutTarget(demo, "demo"),
          status: "building",
          requestId: job.requestId,
        },
        newRolloutTarget(alpha, "alpha"),
      ],
    });
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "not-picked-up" });
    assert.equal(env.uploads, 0);
  });
  it("a freeze during a client's build stops it before upload and stops the rollout", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    env.gh.state.onPoll = async (_run, n) => {
      if (n === 1)
        await env.db
          .collection("system_state")
          .updateOne(
            { _id: "pos-deploy-freeze" },
            { $set: { on: true } },
            { upsert: true },
          );
    };
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "frozen" });
    assert.deepEqual(
      row.targets.map((t) => [t.status, t.error?.code]),
      [
        ["skipped", "frozen"],
        ["skipped", "rollout-stopped"],
      ],
    );
    assert.equal((await deployOf(env, demo)).current.status, "cancelled");
    assert.equal(env.uploads, 0);
  });
});

describe("rollout driver: freeze, cancel, takeover", () => {
  it("never starts a client while deploys are frozen", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    await env.db
      .collection("system_state")
      .insertOne({ _id: "pos-deploy-freeze", on: true });
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    await w.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "frozen" });
    assert.deepEqual(
      row.targets.map((t) => [t.status, t.error?.code]),
      [
        ["skipped", "frozen"],
        ["skipped", "rollout-stopped"],
      ],
    );
    assert.equal((await deployOf(env, demo)).current, null);
  });
  it("cancels its own queued job when deploys are frozen", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const job = queuedJob(env);
    await env.db
      .collection("installations")
      .updateOne({ _id: demo }, { $set: { "pos.deploy.current": job } });
    await env.db
      .collection("system_state")
      .insertOne({ _id: "pos-deploy-freeze", on: true });
    await seedRollout(env, [], {
      prepared: true,
      targets: [
        {
          ...newRolloutTarget(demo, "demo"),
          status: "building",
          requestId: job.requestId,
        },
      ],
    });
    await w.loop.drain();
    const current = (await deployOf(env, demo)).current;
    assert.equal(current.status, "cancelled");
    assert.equal(current.error.code, "frozen");
    const row = await rolloutOf(env);
    assert.equal(row.status, "stopped");
    assert.deepEqual(row.stop, { slug: "demo", code: "frozen" });
    assert.equal(row.targets[0].status, "skipped");
  });
  it("ends a cancelled rollout and releases its pre-builds", async () => {
    const env = await makeEnv();
    const w = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    // As POST /pos/rollout/cancel leaves it: the queued job cancelled at once.
    const job = queuedJob(env, {
      status: "cancelled",
      cancelRequested: true,
      finishedAt: new Date(env.clock.t),
    });
    await env.db
      .collection("installations")
      .updateOne({ _id: demo }, { $set: { "pos.deploy.current": job } });
    const doc = await seedRollout(env, [], {
      status: "cancelling",
      cancelRequested: true,
      prepared: true,
      targets: [
        {
          ...newRolloutTarget(demo, "demo"),
          status: "building",
          requestId: job.requestId,
        },
        newRolloutTarget(alpha, "alpha"),
      ],
    });
    const state = env.db.collection("system_state");
    const row = (id, status, prepared) => ({
      _id: id,
      kind: "build",
      status,
      waiters: [],
      prepared,
      createdAt: new Date(env.clock.t),
      lease: { owner: "w-x", until: new Date(env.clock.t + 600000), fence: 1 },
    });
    const mine = {
      by: { id: "staff-1", name: "Owner" },
      at: new Date(),
      rollout: doc.id,
    };
    await state.insertMany([
      row(buildRowId(SHA1, "a".repeat(64)), "queued", mine),
      row(buildRowId(SHA1, "b".repeat(64)), "building", mine),
      row(buildRowId(SHA1, "c".repeat(64)), "building", {
        by: { id: "x", name: "Owner" },
        at: new Date(),
      }),
    ]);
    // The build lane must not touch the seeded rows during this test.
    await w.ctx.coll.state.updateMany(
      { kind: "build" },
      { $set: { "lease.until": new Date(env.clock.t + 600000) } },
    );
    await w.loop.drain();
    const after = await rolloutOf(env);
    assert.equal(after.status, "cancelled");
    assert.deepEqual(
      after.targets.map((t) => [t.status, t.error?.code]),
      [
        ["skipped", "cancelled"],
        ["skipped", "cancelled"],
      ],
    );
    const builds = await state
      .find({ kind: "build" })
      .sort({ _id: 1 })
      .toArray();
    assert.deepEqual(
      builds.map((b) => [
        b.status,
        b.prepared?.rollout ?? null,
        Boolean(b.prepared),
      ]),
      [
        ["cancelled", null, false],
        ["building", null, false],
        ["building", null, true],
      ],
    );
    assert.equal(env.uploads, 0);
  });
  it("a killed worker's rollout is finished by the next one, without a second enqueue", async () => {
    const env = await makeEnv();
    const a = await makeWorker(env);
    const demo = await seedClient(env, "demo");
    const alpha = await seedClient(env, "alpha");
    await seedRollout(env, [
      [demo, "demo"],
      [alpha, "alpha"],
    ]);
    env.gh.state.onPoll = async (_run, n) => {
      if (n === 1 && !a.dead) {
        await kill(a);
        await never();
      }
    };
    a.loop.drain();
    await until(() => a.dead);
    env.clock.t += 120000;
    const b = await makeWorker(env);
    await b.loop.drain();
    const row = await rolloutOf(env);
    assert.equal(row.status, "completed");
    assert.deepEqual(statuses(row), [
      ["demo", "succeeded"],
      ["alpha", "succeeded"],
    ]);
    assert.equal(env.gh.state.dispatches.length, 1);
    assert.equal((await requested(env, demo)).length, 1);
    assert.equal((await requested(env, alpha)).length, 1);
    assert.equal(env.uploads, 2);
  });
});
