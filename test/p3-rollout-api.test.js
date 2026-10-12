// P3 rollout API (docs/P3-ROLLOUT.md §4): plan, start gates, cancel, resume,
// dismiss and the whitelist view. The worker side is test/p3-rollout-worker.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assertNoSecrets,
  clearOfWindow,
  startApp,
  VAULT_KEY,
} from "./helpers.js";
import { digest, encrypt } from "../backend/lib/crypto.js";
import { createGitHub } from "../backend/lib/github.js";
import { newPos, aadOf } from "../backend/modules/pos.js";
import { rolloutDigest } from "../backend/lib/deploy-view.js";
import { newJob } from "../backend/lib/deploy-job.js";
import { buildRowId } from "../shared/deploy.js";
import { buildInputs, buildKeyOf } from "../backend/lib/build-inputs.js";
import { createFakeGitHub, SRC, BLD, SHAS } from "./fakes/github.js";

const SRC_TOKEN = `github_pat_${"S".repeat(60)}`;
const VERCEL_TOKEN = "vercel-secret-token-1234567890";
const SECRETS = [SRC_TOKEN, VERCEL_TOKEN, VAULT_KEY];
const OLD = "9".repeat(40);
const KEY = "d".repeat(64);

let ctx, owner, admin, viewer, product;
const fake = createFakeGitHub();
const flags = { source: true, builder: true };
const real = createGitHub({
  sourceRepo: SRC,
  sourceToken: SRC_TOKEN,
  builderRepo: BLD,
  fetch: fake.fetch,
  sleep: async () => {},
});
const github = { ...real, configured: () => ({ ...flags }) };
const hits = new Set();
const buildCache = {
  lookup: async ({ sha }) =>
    hits.has(sha)
      ? { state: "hit", manifest: { builtAt: "2026-10-09T10:00:00.000Z" } }
      : { state: "miss", reason: "absent" },
};

const sessionId = (session) => digest(session.cookie.split("=")[1]);
const stepUp = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: sessionId(session) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );
const stepDown = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne({ _id: sessionId(session) }, { $unset: { stepUpUntil: "" } });
async function call(path, { session = owner, ...options } = {}) {
  const res = await ctx.request(path, { session, ...options });
  assertNoSecrets(res.data, SECRETS, `${options.method ?? "GET"} ${path}`);
  return res;
}
const post = (path, body, session = owner) =>
  call(path, { method: "POST", body: body ?? {}, session });
const state = () => ctx.db.collection("system_state");
const rolloutDoc = () => state().findOne({ _id: "pos-rollout" });
const audits = (action) =>
  ctx.db.collection("audit_events").find({ action }).toArray();
const heartbeat = (patch = {}) =>
  state().updateOne(
    { _id: "pos-worker" },
    {
      $set: {
        at: new Date(),
        workerId: "w1",
        version: "1.0.0",
        cliVersion: "39.1.0",
        builderConfigured: true,
        builder: {
          sha: SHAS.c,
          protocol: 1,
          nodeVersion: "22.11.0",
          cliVersion: "39.1.0",
          ok: true,
          checkedAt: new Date(),
        },
        ...patch,
      },
    },
    { upsert: true },
  );
const OK_VERIFY = (at = new Date()) => ({
  at,
  by: { id: "x", name: "Owner" },
  vercel: "ok",
  project: "ok",
  env: "ok",
  mongo: "ok",
  cloudflare: null,
  health: "ok",
});
// One POS client. Ready unless told otherwise; live on OLD by default.
async function client(
  slug,
  {
    ready = true,
    lock = false,
    customerStatus = "active",
    status = "live",
    liveSha = OLD,
    verify = OK_VERIFY(),
    current = null,
  } = {},
) {
  const customerId = randomUUID(),
    id = randomUUID();
  await ctx.db.collection("customers").insertOne({
    _id: customerId,
    name: `Customer ${slug}`,
    email: `${slug}-${id.slice(0, 6)}@example.test`,
    status: customerStatus,
    updatedAt: new Date(),
  });
  const pos = newPos({
    slug,
    subdomain: "cafe",
    host: `${slug}.pos.example.com`,
    tenantId: "tenant_1",
    rootDomain: "pos.example.com",
    vercel: {
      projectId: "prj_abc123",
      orgId: "team_abc123",
      teamId: "team_abc123",
      projectName: slug,
    },
    image: {
      store: "r2",
      publicBaseUrl: "https://img.example.com",
      cloudName: "",
      r2AccountId: "r2acc123",
      bucket: "images",
    },
    posAdmin: { username: "owner1" },
  });
  if (ready) {
    pos.deployLock = lock;
    pos.vercel.token = encrypt(
      VERCEL_TOKEN,
      VAULT_KEY,
      aadOf(id, "vercel.token"),
    );
    pos.verify = verify;
  }
  pos.deploy = {
    current,
    last: liveSha
      ? {
          kind: "deploy",
          requestId: randomUUID(),
          branch: "main",
          sha: liveSha,
          at: new Date(),
          by: { id: "u", name: "Owner" },
          status: "succeeded",
        }
      : null,
    previous: null,
    cutoverAt: null,
  };
  await ctx.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: product._id,
    name: `${slug} POS`,
    status,
    environment: "production",
    updatedAt: new Date(),
    pos,
  });
  return id;
}
const running = (over = {}) => ({
  ...newJob({
    kind: "deploy",
    branch: "main",
    sha: SHAS.a,
    buildKey: null,
    commit: null,
    by: { id: "u", name: "Owner" },
    now: Date.now(),
  }),
  status: "running",
  step: "build",
  lease: { owner: "w1", until: new Date(Date.now() + 60000), fence: 1 },
  ...over,
});
async function plan(branch = "main", session = owner) {
  const res = await call(`/pos/rollout/plan?branch=${branch}`, { session });
  return res;
}
async function start(over = {}, session = owner) {
  const p = (await plan()).data;
  return post(
    "/pos/rollout",
    {
      branch: "main",
      sha: p.head?.sha ?? SHAS.a,
      digest: p.digest,
      confirm: "deploy all",
      ...over,
    },
    session,
  );
}
// A rollout row as the worker would leave it.
async function seedRollout(over = {}, targets = []) {
  const doc = {
    _id: "pos-rollout",
    id: randomUUID(),
    status: "stopped",
    branch: "main",
    sha: SHAS.a,
    commit: null,
    by: { id: "u", name: "Owner" },
    auth: { id: "u", name: "Owner", authVersion: 1, role: "owner" },
    resumed: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    stopOnFailure: true,
    cancelRequested: false,
    stop: null,
    prepared: true,
    lease: { owner: "w1", until: new Date(Date.now() - 1), fence: 3 },
    targets,
    ...over,
  };
  await state().replaceOne({ _id: "pos-rollout" }, doc, { upsert: true });
  return doc;
}
const target = (installationId, slug, status, over = {}) => ({
  installationId,
  slug,
  status,
  requestId: null,
  buildKey: null,
  prebuild: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

before(async () => {
  ctx = await startApp({
    dbName: "p3_rollout_api",
    deps: { github, buildCache },
  });
  owner = await ctx.login("owner@example.test");
  admin = await ctx.login("admin@example.test");
  viewer = await ctx.login("viewer@example.test");
  await ctx.db
    .collection("staff")
    .updateOne(
      { email: "owner@example.test" },
      { $set: { "totp.enabledAt": new Date() } },
    );
  product = await ctx.db.collection("products").findOne({ slug: "pos" });
});
after(() => ctx?.stop());
beforeEach(async () => {
  await ctx.db.collection("installations").deleteMany({});
  await state().deleteMany({
    _id: { $in: ["pos-rollout", "pos-deploy-freeze"] },
  });
  await state().deleteMany({ kind: "build" });
  await ctx.db.collection("rate_limits").deleteMany({});
  await heartbeat();
  flags.source = flags.builder = true;
  fake.state.compare = { status: "ahead", ahead_by: 2, behind_by: 0 };
  hits.clear();
  await stepUp(owner);
});

describe("rollout plan", () => {
  it("orders demo first then A-Z and explains every client left out", async () => {
    const zeta = await client("zeta");
    const demo = await client("demo");
    const alpha = await client("alpha", { liveSha: null });
    await client("locked", { lock: true });
    await client("paused", { customerStatus: "paused" });
    await client("retired", { status: "retired" });
    await client("current", { liveSha: SHAS.a });
    await client("stale", {
      verify: OK_VERIFY(new Date(Date.now() - 25 * 3600000)),
    });
    hits.add(SHAS.a);
    const res = await plan();
    assert.equal(res.status, 200);
    const p = res.data;
    assert.equal(p.branch, "main");
    assert.equal(p.head.sha, SHAS.a);
    assert.equal(p.head.sha7, SHAS.a.slice(0, 7));
    assert.equal(p.head.headline, "Main headline");
    assert.equal(p.head.authorName, "Dev Person");
    assert.deepEqual(
      p.targets.map((t) => t.slug),
      ["demo", "alpha", "zeta"],
    );
    assert.deepEqual(
      p.targets.map((t) => t.installationId),
      [demo, alpha, zeta],
    );
    assert.equal(p.targets[0].customerName, "Customer demo");
    assert.deepEqual(p.targets[0].live, {
      branch: "main",
      sha7: OLD.slice(0, 7),
    });
    assert.equal(p.targets[1].live, null);
    assert.equal(p.targets[0].cached, true);
    assert.equal(p.targets[0].older, false);
    assert.deepEqual(
      p.excluded.map((e) => [e.slug, e.code, e.items ?? null]),
      [
        ["current", "already-live", null],
        ["locked", "locked", null],
        ["paused", "customer-inactive", null],
        ["retired", "customer-inactive", null],
        ["stale", "target-not-ready", ["verified"]],
      ],
    );
    assert.deepEqual(p.blocked, []);
    assert.deepEqual(p.busy, []);
    assert.equal(p.active, false);
    assert.equal(p.limited, false);
    assert.equal(p.digest, rolloutDigest(SHAS.a, [demo, alpha, zeta]));
  });
  it("warns when a client runs a newer commit and lists running deploys", async () => {
    // A live commit no other test uses: compares are cached for 10 minutes.
    const NEWER = "7".repeat(40);
    await client("alpha", { liveSha: NEWER });
    await client("beta", { liveSha: NEWER, current: running() });
    fake.state.compare = { status: "behind", ahead_by: 0, behind_by: 3 };
    const p = (await plan()).data;
    assert.deepEqual(
      p.targets.map((t) => [t.slug, t.older, t.diverged]),
      [
        ["alpha", true, false],
        ["beta", true, false],
      ],
    );
    assert.deepEqual(p.busy, ["beta"]);
  });
  it("includes a client live on this commit but unhealthy, and says so", async () => {
    const sick = await client("sick", { liveSha: SHAS.a });
    await ctx.db
      .collection("installations")
      .updateOne({ _id: sick }, { $set: { "pos.deploy.last.healthy": false } });
    await client("fine", { liveSha: SHAS.a });
    const p = (await plan()).data;
    assert.deepEqual(
      p.targets.map((t) => [t.slug, t.unhealthy]),
      [["sick", true]],
    );
    assert.deepEqual(
      p.excluded.map((e) => [e.slug, e.code]),
      [["fine", "already-live"]],
    );
  });
  it("tells a diverged live commit apart from an older one", async () => {
    const SIDE = "6".repeat(40);
    await client("alpha", { liveSha: SIDE });
    fake.state.compare = { status: "diverged", ahead_by: 2, behind_by: 1 };
    const [t] = (await plan()).data.targets;
    assert.equal(t.older, false);
    assert.equal(t.diverged, true);
  });
  it("reports what blocks the whole rollout", async () => {
    await client("alpha");
    await heartbeat({ at: new Date(Date.now() - 5 * 60000) });
    await state().updateOne(
      { _id: "pos-deploy-freeze" },
      { $set: { on: true, reason: "", at: new Date() } },
      { upsert: true },
    );
    const p = (await plan()).data;
    assert.deepEqual(p.blocked, ["worker", "builder", "not-frozen"]);
  });
  it("is readable by owner and admin only; a missing branch is 409", async () => {
    await client("alpha");
    assert.equal((await plan("main", admin)).status, 200);
    assert.equal((await plan("main", viewer)).status, 403);
    const gone = await plan("nope");
    assert.equal(gone.status, 409);
    assert.equal(gone.data.code, "sha-not-on-branch");
  });
});

describe("rollout start", () => {
  it("stores one row with the ordered targets and audits it", async () => {
    const beta = await client("beta");
    const demo = await client("demo");
    const res = await start();
    assert.equal(res.status, 201);
    const view = res.data.rollout;
    assert.equal(view.status, "running");
    assert.equal(view.sha7, SHAS.a.slice(0, 7));
    assert.deepEqual(
      view.targets.map((t) => [t.slug, t.status]),
      [
        ["demo", "pending"],
        ["beta", "pending"],
      ],
    );
    const row = await rolloutDoc();
    assert.equal(row.sha, SHAS.a);
    assert.equal(row.branch, "main");
    assert.equal(row.commit.headline, "Main headline");
    assert.equal(row.prepared, false);
    assert.equal(row.stopOnFailure, true);
    assert.equal(row.auth.role, "owner");
    assert.equal(row.auth.authVersion, 1);
    assert.deepEqual(
      row.targets.map((t) => t.installationId),
      [demo, beta],
    );
    const [event] = await audits("pos.rollout.started");
    assert.equal(event.resource, "system");
    assert.equal(event.resourceId, "pos-rollout");
    assert.match(
      event.detail,
      new RegExp(`^main@${SHAS.a.slice(0, 7)} 2 clients #[0-9a-f]{8}$`),
    );
    // The view never carries the lease, the authority or job ids.
    const text = JSON.stringify((await call("/pos/rollout")).data);
    for (const hidden of ["authVersion", "lease", "requestId", SHAS.a])
      assert.ok(!text.includes(hidden), hidden);
  });
  it("refuses in the documented order", async () => {
    await client("alpha");
    const p = (await plan()).data;
    const body = {
      branch: "main",
      sha: SHAS.a,
      digest: p.digest,
      confirm: "deploy all",
    };
    assert.equal((await post("/pos/rollout", body, admin)).status, 403);
    await stepDown(owner);
    assert.equal((await post("/pos/rollout", body)).status, 428);
    await stepUp(owner);
    const phrase = await post("/pos/rollout", { ...body, confirm: "deploy" });
    assert.equal(phrase.status, 400);
    assert.match(phrase.data.error, /deploy all/);
    await state().updateOne(
      { _id: "pos-deploy-freeze" },
      { $set: { on: true } },
      { upsert: true },
    );
    const frozen = await post("/pos/rollout", body);
    assert.equal(frozen.status, 409);
    assert.equal(frozen.data.code, "not-ready");
    assert.deepEqual(frozen.data.items, ["not-frozen"]);
    await state().deleteOne({ _id: "pos-deploy-freeze" });
    const wrong = await post("/pos/rollout", {
      ...body,
      digest: "0".repeat(64),
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.data.code, "targets-changed");
    fake.state.compare = { status: "behind", ahead_by: 0, behind_by: 1 };
    const moved = await post("/pos/rollout", { ...body, sha: SHAS.b });
    assert.equal(moved.status, 409);
    assert.equal(moved.data.code, "branch-moved");
  });
  it("refuses while a rollout or any deploy is running, or with nothing to do", async () => {
    const alpha = await client("alpha");
    await seedRollout({ status: "running" });
    const busy = await start();
    assert.equal(busy.status, 409);
    assert.equal(busy.data.code, "busy");
    await state().deleteOne({ _id: "pos-rollout" });
    await ctx.db
      .collection("installations")
      .updateOne({ _id: alpha }, { $set: { "pos.deploy.current": running() } });
    const deploying = await start();
    assert.equal(deploying.status, 409);
    assert.equal(deploying.data.code, "busy");
    assert.match(deploying.data.error, /alpha/);
    await ctx.db
      .collection("installations")
      .updateOne(
        { _id: alpha },
        { $set: { "pos.deploy.current": null, "pos.deploy.last.sha": SHAS.a } },
      );
    const none = await start();
    assert.equal(none.status, 409);
    assert.equal(none.data.code, "no-targets");
  });
  it("replaces a finished rollout; two starts at once give one 201", async () => {
    await client("alpha");
    await seedRollout({ status: "completed" });
    const p = (await plan()).data;
    const body = {
      branch: "main",
      sha: SHAS.a,
      digest: p.digest,
      confirm: "deploy all",
    };
    const results = await Promise.all([
      post("/pos/rollout", body),
      post("/pos/rollout", body),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409).data.code, "busy");
    assert.equal((await rolloutDoc()).status, "running");
  });
  it("needs the build cache", async () => {
    const other = await startApp({
      dbName: "p3_rollout_nocache",
      deps: { github, buildCache: null },
    });
    try {
      const session = await other.login("owner@example.test");
      await other.db
        .collection("staff")
        .updateOne(
          { email: "owner@example.test" },
          { $set: { "totp.enabledAt": new Date() } },
        );
      await other.db
        .collection("sessions")
        .updateOne(
          { _id: sessionId(session) },
          { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
        );
      const p = await other.request("/pos/rollout/plan?branch=main", {
        session,
      });
      assert.ok(p.data.blocked.includes("build-cache"));
      const res = await other.request("/pos/rollout", {
        method: "POST",
        session,
        body: {
          branch: "main",
          sha: SHAS.a,
          digest: "0".repeat(64),
          confirm: "deploy all",
        },
      });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, "cache-off");
    } finally {
      await other.stop();
    }
  });
  it("allows 10 starts or resumes per hour per person", async () => {
    await clearOfWindow(3600000);
    await client("alpha");
    const body = {
      branch: "main",
      sha: SHAS.a,
      digest: "0".repeat(64),
      confirm: "deploy all",
    };
    for (let i = 0; i < 10; i++)
      assert.equal((await post("/pos/rollout", body)).status, 409);
    assert.equal((await post("/pos/rollout", body)).status, 429);
  });
});

describe("rollout cancel, resume, dismiss", () => {
  const flying = async (job) => {
    const alpha = await client("alpha", { current: job });
    const beta = await client("beta");
    const doc = await seedRollout({ status: "running", finishedAt: null }, [
      target(alpha, "alpha", job.step === "upload" ? "deploying" : "building", {
        requestId: job.requestId,
      }),
      target(beta, "beta", "pending"),
    ]);
    return { alpha, beta, doc };
  };
  const currentOf = async (id) =>
    (await ctx.db.collection("installations").findOne({ _id: id })).pos.deploy
      .current;
  it("cancels a queued client job at once", async () => {
    const job = running({
      status: "queued",
      step: "queued",
      lease: { owner: null, until: null, fence: 0 },
    });
    const { alpha, doc } = await flying(job);
    const res = await post("/pos/rollout/cancel", { id: doc.id });
    assert.equal(res.status, 200);
    assert.equal(res.data.rollout.status, "cancelling");
    assert.equal(res.data.rollout.cancelRequested, true);
    const after = await currentOf(alpha);
    assert.equal(after.status, "cancelled");
    assert.equal(after.cancelRequested, true);
    assert.equal((await audits("pos.rollout.cancel-requested")).length, 1);
    assert.equal((await audits("pos.deploy.cancel-requested")).length, 1);
    // Idempotent while cancelling.
    assert.equal(
      (await post("/pos/rollout/cancel", { id: doc.id })).status,
      200,
    );
  });
  it("asks a running job to stop before upload, and leaves an upload alone", async () => {
    const early = await flying(running({ step: "build" }));
    await post("/pos/rollout/cancel", { id: early.doc.id });
    const job = await currentOf(early.alpha);
    assert.equal(job.status, "cancelling");
    assert.equal(job.cancelRequested, true);
    await ctx.db.collection("installations").deleteMany({});
    const late = await flying(running({ step: "upload" }));
    const res = await post("/pos/rollout/cancel", { id: late.doc.id });
    assert.equal(res.status, 200);
    assert.equal(res.data.rollout.status, "cancelling");
    const untouched = await currentOf(late.alpha);
    assert.equal(untouched.status, "running");
    assert.equal(untouched.cancelRequested, false);
  });
  it("refuses cancel for a finished rollout, a wrong id or a non-owner", async () => {
    const doc = await seedRollout({ status: "stopped" });
    assert.equal(
      (await post("/pos/rollout/cancel", { id: doc.id })).status,
      409,
    );
    assert.equal(
      (await post("/pos/rollout/cancel", { id: randomUUID() })).status,
      404,
    );
    assert.equal(
      (await post("/pos/rollout/cancel", { id: doc.id }, admin)).status,
      403,
    );
  });
  it("resumes a stopped rollout from the client it stopped at", async () => {
    const demo = await client("demo", { liveSha: SHAS.a });
    const early = await client("early");
    const alpha = await client("alpha");
    const beta = await client("beta");
    const doc = await seedRollout(
      { status: "stopped", stop: { slug: "alpha", code: "build-failed" } },
      [
        target(demo, "demo", "succeeded", { requestId: "r1" }),
        target(early, "early", "skipped", { error: { code: "locked" } }),
        target(alpha, "alpha", "failed", {
          requestId: "r2",
          error: { code: "build-failed" },
          buildKey: KEY,
          prebuild: "queued",
        }),
        target(beta, "beta", "skipped", { error: { code: "rollout-stopped" } }),
      ],
    );
    await stepDown(owner);
    assert.equal(
      (await post("/pos/rollout/resume", { id: doc.id })).status,
      428,
    );
    await stepUp(owner);
    const res = await post("/pos/rollout/resume", { id: doc.id });
    assert.equal(res.status, 200);
    assert.equal(res.data.rollout.status, "running");
    assert.equal(res.data.rollout.resumed.by.name, "owner");
    const row = await rolloutDoc();
    assert.deepEqual(
      row.targets.map((t) => [t.slug, t.status, t.error, t.requestId]),
      [
        ["demo", "succeeded", null, "r1"],
        ["early", "skipped", { code: "locked" }, null],
        ["alpha", "pending", null, null],
        ["beta", "pending", null, null],
      ],
    );
    assert.equal(row.targets[2].buildKey, null);
    assert.equal(row.prepared, false);
    assert.equal(row.stop, null);
    assert.equal(row.finishedAt, null);
    assert.equal(row.by.name, "Owner");
    assert.equal(row.auth.role, "owner");
    assert.equal((await audits("pos.rollout.resumed")).length, 1);
    // Only a stopped rollout resumes.
    assert.equal(
      (await post("/pos/rollout/resume", { id: doc.id })).status,
      409,
    );
  });
  it("re-checks the branch and the gates before resuming", async () => {
    await client("alpha");
    const doc = await seedRollout({ status: "stopped", branch: "gone-branch" });
    const gone = await post("/pos/rollout/resume", { id: doc.id });
    assert.equal(gone.status, 409);
    assert.equal(gone.data.code, "sha-not-on-branch");
    await seedRollout({ id: doc.id, status: "stopped" });
    await state().updateOne(
      { _id: "pos-deploy-freeze" },
      { $set: { on: true } },
      { upsert: true },
    );
    const frozen = await post("/pos/rollout/resume", { id: doc.id });
    assert.equal(frozen.status, 409);
    assert.deepEqual(frozen.data.items, ["not-frozen"]);
    assert.equal((await rolloutDoc()).status, "stopped");
  });
  it("dismisses only a finished rollout and releases its pre-builds", async () => {
    const doc = await seedRollout({ status: "running", finishedAt: null });
    const refused = await post("/pos/rollout/dismiss", { id: doc.id });
    assert.equal(refused.status, 409);
    await seedRollout({ id: doc.id, status: "stopped" });
    const mine = {
      by: { id: "u", name: "Owner" },
      at: new Date(),
      rollout: doc.id,
    };
    await state().insertMany([
      {
        _id: buildRowId(SHAS.a, "a".repeat(64)),
        kind: "build",
        status: "queued",
        waiters: [],
        prepared: mine,
      },
      {
        _id: buildRowId(SHAS.a, "b".repeat(64)),
        kind: "build",
        status: "building",
        waiters: [],
        prepared: mine,
      },
      {
        _id: buildRowId(SHAS.a, "c".repeat(64)),
        kind: "build",
        status: "queued",
        waiters: [],
        prepared: { by: { id: "u", name: "Owner" }, at: new Date() },
      },
    ]);
    const res = await post("/pos/rollout/dismiss", { id: doc.id });
    assert.equal(res.status, 200);
    assert.equal(await rolloutDoc(), null);
    assert.equal((await audits("pos.rollout.dismissed")).length, 1);
    assert.equal((await call("/pos/rollout")).data.rollout, null);
    const builds = await state()
      .find({ kind: "build" })
      .sort({ _id: 1 })
      .toArray();
    assert.deepEqual(
      builds.map((b) => [
        b.status,
        Boolean(b.prepared),
        b.prepared?.rollout ?? null,
      ]),
      [
        ["cancelled", false, null],
        ["building", false, null],
        ["queued", true, null],
      ],
    );
  });
  it("lets a stuck cancelling rollout be dismissed once its client is idle", async () => {
    const alpha = await client("alpha", { current: running() });
    const job = (
      await ctx.db.collection("installations").findOne({ _id: alpha })
    ).pos.deploy.current;
    const doc = await seedRollout(
      { status: "cancelling", cancelRequested: true, finishedAt: null },
      [target(alpha, "alpha", "building", { requestId: job.requestId })],
    );
    const busy = await post("/pos/rollout/dismiss", { id: doc.id });
    assert.equal(busy.status, 409);
    assert.match(busy.data.error, /still deploying/);
    await ctx.db.collection("installations").updateOne(
      { _id: alpha },
      {
        $set: {
          "pos.deploy.current.status": "cancelled",
          "pos.deploy.current.finishedAt": new Date(),
        },
      },
    );
    assert.equal(
      (await post("/pos/rollout/dismiss", { id: doc.id })).status,
      200,
    );
    assert.equal(await rolloutDoc(), null);
  });
  it("Resume shares the 10 per hour of the start", async () => {
    await clearOfWindow(3600000);
    await client("alpha");
    const doc = await seedRollout({ status: "stopped", branch: "gone-branch" });
    const body = {
      branch: "main",
      sha: SHAS.a,
      digest: "0".repeat(64),
      confirm: "deploy all",
    };
    for (let i = 0; i < 9; i++)
      assert.equal((await post("/pos/rollout", body)).status, 409);
    assert.equal(
      (await post("/pos/rollout/resume", { id: doc.id })).status,
      409,
    );
    assert.equal(
      (await post("/pos/rollout/resume", { id: doc.id })).status,
      429,
    );
  });
  it("hands a rollout's pre-build to an owner's Prepare build", async () => {
    const alpha = await client("alpha");
    const inputs = buildInputs({
      pos: (await ctx.db.collection("installations").findOne({ _id: alpha }))
        .pos,
      builderSha: SHAS.c,
      builder: { protocol: 1, nodeVersion: "22.11.0", cliVersion: "39.1.0" },
    });
    // feature/x: no other test looks this commit up (cache answers are memoised).
    const _id = buildRowId(SHAS.b, buildKeyOf(VAULT_KEY, inputs));
    await state().insertOne({
      _id,
      kind: "build",
      status: "queued",
      waiters: [],
      prepared: {
        by: { id: "u", name: "Owner" },
        at: new Date(),
        rollout: "r-x",
      },
    });
    const res = await post(`/installations/${alpha}/pos/builds`, {
      branch: "feature/x",
      sha: SHAS.b,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.build.existing, true);
    const row = await state().findOne({ _id });
    assert.equal(
      row.prepared.rollout,
      undefined,
      "a rollout cancel no longer releases it",
    );
    assert.equal(row.prepared.by.name, "owner");
  });
  it("shows each waiting client's pre-build from the build rows", async () => {
    const alpha = await client("alpha");
    const beta = await client("beta");
    await seedRollout({ status: "running", finishedAt: null }, [
      target(alpha, "alpha", "pending", { buildKey: KEY, prebuild: "queued" }),
      target(beta, "beta", "pending", { prebuild: "unavailable" }),
    ]);
    await state().insertOne({
      _id: buildRowId(SHAS.a, KEY),
      kind: "build",
      status: "building",
    });
    const res = await call("/pos/rollout", { session: admin });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.freeze, { on: false, reason: "" });
    assert.equal(res.data.workerOnline, true);
    assert.deepEqual(
      res.data.rollout.targets.map((t) => t.build),
      ["building", null],
    );
    assert.equal((await call("/pos/rollout", { session: viewer })).status, 403);
  });
});
