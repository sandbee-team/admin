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
import { buildInputs, buildKeyOf } from "../backend/lib/build-inputs.js";
import { createFakeGitHub, SRC, BLD, SHAS } from "./fakes/github.js";
import { createFakeS3 } from "./fake-s3.js";
import { storedCommit } from "../backend/lib/deploy-view.js";
import { relockLegacyUnlocks } from "../backend/db.js";
import {
  GATES,
  READINESS_IDS,
  taskBlocks,
  buildRowId,
  jobBlocks,
  readinessOf,
} from "../shared/deploy.js";

const SRC_TOKEN = `github_pat_${"S".repeat(60)}`;
const BLD_TOKEN = `github_pat_${"B".repeat(60)}`;
const VERCEL_TOKEN = "vercel-secret-token-1234567890";
const BUILDER = { protocol: 1, nodeVersion: "22.11.0", cliVersion: "39.1.0" };
const SECRETS = [SRC_TOKEN, BLD_TOKEN, VERCEL_TOKEN, VAULT_KEY];
const sha = (n) => String(n).padStart(40, "0");
const SHA_OLD = sha(9),
  SHA_PREV = sha(8);

let ctx, owner, admin, operations, viewer, product;
const fake = createFakeGitHub();
const fakeS3 = createFakeS3();
const flags = { source: true, builder: true };
const real = createGitHub({
  sourceRepo: SRC,
  sourceToken: SRC_TOKEN,
  builderRepo: BLD,
  // No builder token: like production, where compose blanks it for the app.
  fetch: fake.fetch,
  sleep: async () => {},
});
const github = { ...real, configured: () => ({ ...flags }) };
// Cache fake: a hit only for builds listed in `hits` ("<sha>").
const hits = new Set();
const lookups = [];
const buildCache = {
  lookup: async ({ sha: s, buildKey }) => {
    lookups.push({ sha: s, buildKey });
    return hits.has(s)
      ? { state: "hit", manifest: { builtAt: "2026-10-09T10:00:00.000Z" } }
      : { state: "miss", reason: "absent" };
  },
};

const stepUp = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $set: { stepUpUntil: new Date(Date.now() + 600000) } },
    );
const stepDown = (session) =>
  ctx.db
    .collection("sessions")
    .updateOne(
      { _id: digest(session.cookie.split("=")[1]) },
      { $unset: { stepUpUntil: "" } },
    );
// Every response is scanned for secrets and boxes.
async function call(path, { session = owner, ...options } = {}) {
  const res = await ctx.request(path, { session, ...options });
  assertNoSecrets(res.data, SECRETS, `${options.method ?? "GET"} ${path}`);
  return res;
}
const POS_CONFIG = (slug) => ({
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
  cloudflare: {
    accountId: "cfacc123",
    workerName: `${slug}-rt`,
    workerUrl: "https://worker.example.workers.dev",
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
const OK_VERIFY = () => ({
  at: new Date(),
  by: { id: "x", name: "Owner" },
  vercel: "ok",
  project: "ok",
  env: "ok",
  mongo: "ok",
  cloudflare: null,
  health: "ok",
});
// A ready installation: unlocked, token set, verified, worker online.
async function fresh({
  slug = `demo-${randomUUID().slice(0, 8)}`,
  ready = true,
} = {}) {
  const { db } = ctx;
  const customerId = randomUUID(),
    id = randomUUID();
  await db.collection("customers").insertOne({
    _id: customerId,
    name: `Customer ${slug}`,
    email: `${slug}@example.test`,
    status: "active",
    updatedAt: new Date(),
  });
  const pos = newPos(POS_CONFIG(slug));
  if (ready) {
    pos.deployLock = false;
    pos.vercel.token = encrypt(
      VERCEL_TOKEN,
      VAULT_KEY,
      aadOf(id, "vercel.token"),
    );
    pos.verify = OK_VERIFY();
  }
  await db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: product._id,
    name: `${slug} POS`,
    status: "live",
    environment: "production",
    updatedAt: new Date(),
    pos,
  });
  await db.collection("system_state").deleteOne({ _id: "pos-deploy-freeze" });
  await db.collection("rate_limits").deleteMany({});
  await heartbeat();
  flags.source = flags.builder = true;
  fake.state.compare = { status: "ahead", ahead_by: 2, behind_by: 0 };
  hits.clear();
  lookups.length = 0;
  return { id, customerId, slug };
}
const heartbeat = (patch = {}) =>
  ctx.db.collection("system_state").updateOne(
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
        lastBuildMs: 150000,
        ...patch,
      },
    },
    { upsert: true },
  );
const doc = (id) => ctx.db.collection("installations").findOne({ _id: id });
const setPos = (id, set, unset) =>
  ctx.db
    .collection("installations")
    .updateOne(
      { _id: id },
      { ...(set ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) },
    );
const audits = (id, action) =>
  ctx.db
    .collection("audit_events")
    .find({ resourceId: id, ...(action ? { action } : {}) })
    .toArray();
const deployBody = (slug, extra = {}) => ({
  kind: "deploy",
  branch: "main",
  sha: SHAS.a,
  confirm: slug,
  ...extra,
});
const post = (id, path, body, session) =>
  call(`/installations/${id}/pos/${path}`, {
    method: "POST",
    body: body ?? {},
    session,
  });
const version = (n, extra = {}) => ({
  kind: "deploy",
  requestId: randomUUID(),
  branch: "main",
  sha: n === 1 ? SHA_OLD : SHA_PREV,
  at: new Date(),
  by: { id: "u", name: "Owner" },
  vercelDeploymentId: `dpl_${n}`,
  url: `https://demo-${n}.vercel.app`,
  durationMs: 1000,
  runUrl: "https://github.com/owner/builder/actions/runs/77",
  status: "succeeded",
  build: {
    buildKey: "ab".repeat(32),
    objectKey: `builds/${SHA_OLD}/secretobjectkey.tgz.enc`,
    touchedAt: new Date(),
    source: "cache",
  },
  commit: {
    sha: n === 1 ? SHA_OLD : SHA_PREV,
    branch: "main",
    headline: "Headline",
    authorName: "Dev",
    date: new Date(),
  },
  ...extra,
});

before(async () => {
  ctx = await startApp({
    dbName: "stage2_api",
    deps: { github, buildCache, s3: fakeS3.client() },
  });
  owner = await ctx.login("owner@example.test");
  admin = await ctx.login("admin@example.test");
  operations = await ctx.login("operations@example.test");
  viewer = await ctx.login("viewer@example.test");
  await ctx.db
    .collection("staff")
    .updateOne(
      { email: "owner@example.test" },
      { $set: { "totp.enabledAt": new Date() } },
    );
  product = await ctx.db.collection("products").findOne({ slug: "pos" });
  await stepUp(owner);
});
after(() => ctx?.stop());
beforeEach(() => stepUp(owner));

describe("readinessOf (pure)", () => {
  const base = () => ({
    now: Date.now(),
    installationId: "i",
    customerId: "c",
    worker: {
      at: new Date(),
      cliVersion: "1.0.0",
      builder: { ok: true, cliVersion: "1.0.0", checkedAt: new Date() },
    },
    sources: { source: true, builder: true },
    cacheConfigured: true,
    authenticator: true,
    freeze: null,
    pos: {
      host: "h.example.com",
      deployLock: false,
      vercel: { token: { iv: "x" }, projectId: "p", orgId: "o" },
      verify: OK_VERIFY(),
    },
    inputsOk: true,
    customerStatus: "active",
    installationStatus: "live",
  });
  it("lists every item once and is ready when all pass", () => {
    const r = readinessOf(base());
    assert.deepEqual(
      r.items.map((i) => i.id),
      READINESS_IDS,
    );
    assert.equal(r.ready, true);
    assert.ok(r.items.every((i) => i.state === "ok"));
  });
  it("build cache off is amber and never blocks", () => {
    const r = readinessOf({ ...base(), cacheConfigured: false });
    const item = r.items.find((i) => i.id === "build-cache");
    assert.equal(item.state, "warn");
    assert.equal(item.required, false);
    assert.equal(r.ready, true);
  });
  it("stale worker, stale verify and a mismatched CLI block", () => {
    const old = new Date(Date.now() - 120000);
    assert.equal(
      readinessOf({ ...base(), worker: { ...base().worker, at: old } }).ready,
      false,
    );
    const stale = base();
    stale.pos.verify.at = new Date(Date.now() - 25 * 3600000);
    assert.equal(
      readinessOf(stale).items.find((i) => i.id === "verified").state,
      "blocked",
    );
    const cli = base();
    cli.worker.builder.cliVersion = "2.0.0";
    assert.equal(
      readinessOf(cli).items.find((i) => i.id === "builder").state,
      "blocked",
    );
  });
  it("jobBlocks: expired queued and long-dead leases do not block", () => {
    const now = Date.now();
    assert.equal(jobBlocks(null, now), false);
    assert.equal(jobBlocks({ status: "failed" }, now), false);
    assert.equal(
      jobBlocks({ status: "queued", requestedAt: new Date(now) }, now),
      true,
    );
    // Queue expiry (contract b): an old queued job is free only when the
    // worker heartbeat has been stale for 10 minutes or more (or is missing).
    const oldQueued = {
      status: "queued",
      requestedAt: new Date(now - 11 * 60000),
    };
    assert.equal(jobBlocks(oldQueued, now), true, "unknown heartbeat blocks");
    assert.equal(jobBlocks(oldQueued, now, new Date(now - 1000)), true);
    assert.equal(jobBlocks(oldQueued, now, new Date(now - 5 * 60000)), true);
    assert.equal(jobBlocks(oldQueued, now, new Date(now - 11 * 60000)), false);
    assert.equal(jobBlocks(oldQueued, now, null), false, "no heartbeat ever");
    assert.equal(
      jobBlocks(
        { status: "queued", requestedAt: new Date(now - 60000) },
        now,
        new Date(now - 30 * 60000),
      ),
      true,
      "a young queued job always blocks",
    );
    assert.equal(
      taskBlocks(
        { status: "queued", requestedAt: new Date(now - 11 * 60000) },
        now,
        new Date(now - 1000),
      ),
      true,
    );
    assert.equal(
      taskBlocks(
        { status: "queued", requestedAt: new Date(now - 11 * 60000) },
        now,
        null,
      ),
      false,
    );
    assert.equal(
      jobBlocks(
        { status: "running", lease: { until: new Date(now - 60000) } },
        now,
      ),
      true,
    );
    assert.equal(
      jobBlocks(
        { status: "running", lease: { until: new Date(now - 16 * 60000) } },
        now,
      ),
      false,
    );
  });
});

describe("roles, step-up and typed confirmation", () => {
  const routes = (id, slug) => [
    ["POST", `/installations/${id}/pos/deploys`, deployBody(slug)],
    ["POST", `/installations/${id}/pos/rollback`, { confirm: slug }],
    [
      "POST",
      `/installations/${id}/pos/deploys/cancel`,
      { requestId: randomUUID() },
    ],
    [
      "POST",
      `/installations/${id}/pos/deploys/dismiss`,
      { requestId: randomUUID() },
    ],
    ["POST", `/installations/${id}/pos/lock`, {}],
    ["POST", `/installations/${id}/pos/unlock`, { confirm: slug }],
    [
      "POST",
      `/installations/${id}/pos/builds`,
      { branch: "main", sha: SHAS.a },
    ],
    ["POST", `/installations/${id}/pos/purge/preview`, {}],
    [
      "POST",
      `/installations/${id}/pos/purge`,
      { previewTaskId: randomUUID(), digest: "a".repeat(64), confirm: slug },
    ],
    ["POST", "/pos/freeze", {}],
    ["POST", "/pos/unfreeze", {}],
  ];
  it("401 without a session on every new route", async () => {
    const { id, slug } = await fresh();
    const all = [
      ...routes(id, slug),
      ["GET", `/installations/${id}/pos/deploys`],
      ["GET", `/installations/${id}/pos/deploy-plan?branch=main`],
      ["GET", "/pos/branches"],
      ["GET", "/pos/fleet"],
      ["POST", `/installations/${id}/pos/verify`, {}],
      ["POST", "/pos/build-cache/self-test", {}],
    ];
    for (const [method, path, body] of all) {
      const res = await ctx.request(path, { method, body });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });
  it("viewer, operations and admin get 403 on every deploy action", async () => {
    const { id, slug } = await fresh();
    for (const session of [viewer, operations, admin])
      for (const [method, path, body] of [
        ...routes(id, slug),
        ["POST", "/pos/build-cache/self-test", {}],
      ]) {
        const res = await call(path, { method, body, session });
        assert.equal(res.status, 403, `${session.user.role} ${method} ${path}`);
      }
    assert.equal((await doc(id)).pos.deploy.current, null);
    assert.equal((await audits(id, "pos.deploy.requested")).length, 0);
  });
  it("credentials permission for reads and verify: admin yes, operations and viewer no", async () => {
    const { id } = await fresh();
    assert.equal(
      (await call(`/installations/${id}/pos/deploys`, { session: admin }))
        .status,
      200,
    );
    assert.equal((await call("/pos/fleet", { session: admin })).status, 200);
    assert.equal((await call("/pos/branches", { session: admin })).status, 200);
    for (const session of [operations, viewer]) {
      assert.equal(
        (await call(`/installations/${id}/pos/deploys`, { session })).status,
        403,
      );
      assert.equal((await call("/pos/fleet", { session })).status, 403);
      assert.equal((await call("/pos/branches", { session })).status, 403);
      assert.equal((await post(id, "verify", {}, session)).status, 403);
    }
    assert.equal((await post(id, "verify", {}, admin)).status, 201);
  });
  it("the owner needs step-up (428) for deploy, rollback, unlock, freeze, unfreeze and purge; lock does not", async () => {
    const { id, slug } = await fresh();
    await stepDown(owner);
    const needs = [
      "/deploys",
      "/rollback",
      "/unlock",
      "/purge",
      "/freeze",
      "/unfreeze",
    ];
    for (const [method, path, body] of routes(id, slug)) {
      if (!needs.some((s) => path.endsWith(s))) continue;
      assert.equal((await call(path, { method, body })).status, 428, path);
    }
    assert.equal(
      (await post(id, "lock", {})).status,
      200,
      "lock needs no step-up",
    );
    assert.equal((await doc(id)).pos.deploy.current, null);
  });
  it("a typed slug mismatch is 400 for deploy, rollback and unlock", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    for (const [path, body] of [
      ["deploys", deployBody("wrong-slug")],
      ["rollback", { confirm: "wrong-slug" }],
      ["unlock", { confirm: "wrong-slug" }],
    ]) {
      const res = await post(id, path, body);
      assert.equal(res.status, 400, path);
    }
    assert.equal((await doc(id)).pos.deploy.current, null);
  });
  it("bodies are strict: unknown keys and a client-supplied buildKey/lease are rejected", async () => {
    const { id, slug } = await fresh();
    for (const extra of [
      { lease: {} },
      { buildKey: "a".repeat(64) },
      { status: "running" },
    ])
      assert.equal(
        (await post(id, "deploys", deployBody(slug, extra))).status,
        400,
      );
    assert.equal(
      (
        await post(id, "deploys", {
          kind: "redeploy",
          confirm: true,
          sha: SHAS.a,
        })
      ).status,
      400,
    );
    assert.equal((await post(id, "deploys", { kind: "nope" })).status, 400);
  });
});

describe("readiness gate", () => {
  const cases = [
    [
      "worker",
      (id) =>
        ctx.db.collection("system_state").deleteOne({ _id: "pos-worker" }),
    ],
    [
      "builder",
      () =>
        heartbeat({
          builder: {
            sha: SHAS.c,
            nodeVersion: "22.11.0",
            cliVersion: "39.1.0",
            ok: false,
            checkedAt: new Date(),
          },
        }),
    ],
    ["source-token", () => void (flags.source = false)],
    [
      "authenticator",
      () =>
        ctx.db
          .collection("staff")
          .updateOne(
            { email: "owner@example.test" },
            { $unset: { "totp.enabledAt": "" } },
          ),
    ],
    [
      "not-frozen",
      () =>
        ctx.db
          .collection("system_state")
          .updateOne(
            { _id: "pos-deploy-freeze" },
            { $set: { on: true, reason: "x", at: new Date() } },
            { upsert: true },
          ),
    ],
    ["vercel-token", (id) => setPos(id, { "pos.vercel.token": null })],
    ["project-ids", (id) => setPos(id, { "pos.vercel.projectId": "" })],
    ["verified", (id) => setPos(id, null, { "pos.verify": "" })],
    ["host", (id) => setPos(id, { "pos.host": "" })],
    [
      "image-realtime",
      (id) =>
        setPos(id, {
          "pos.image.publicBaseUrl": "http://insecure.example.com",
        }),
    ],
    ["unlocked", (id) => setPos(id, { "pos.deployLock": true })],
    [
      "customer-active",
      (id) =>
        doc(id).then((d) =>
          ctx.db
            .collection("customers")
            .updateOne({ _id: d.customerId }, { $set: { status: "paused" } }),
        ),
    ],
  ];
  for (const [item, mutate] of cases)
    it(`blocks with ${item} and reports it in the checklist`, async () => {
      const { id, slug } = await fresh();
      await mutate(id);
      try {
        const res = await post(id, "deploys", deployBody(slug));
        assert.equal(res.status, 409, JSON.stringify(res.data));
        assert.equal(res.data.code, "not-ready");
        assert.ok(
          res.data.items.includes(item),
          JSON.stringify(res.data.items),
        );
        const state = await call(`/installations/${id}/pos/deploys`);
        assert.equal(state.data.readiness.ready, false);
        const entry = state.data.readiness.items.find((i) => i.id === item);
        assert.equal(entry.state, "blocked");
        assert.ok(entry.reason.length > 0);
        assert.equal((await doc(id)).pos.deploy.current, null);
        // GitHub was not asked: the gate runs before any network call.
        assert.equal(
          fake.calls.filter((c) => c.path.includes("/compare/")).length,
          0,
        );
      } finally {
        await ctx.db
          .collection("staff")
          .updateOne(
            { email: "owner@example.test" },
            { $set: { "totp.enabledAt": new Date() } },
          );
        await ctx.db
          .collection("system_state")
          .deleteOne({ _id: "pos-deploy-freeze" });
      }
    });
  it("with everything in place the checklist is ready and every item is ok", async () => {
    const { id } = await fresh();
    const res = await call(`/installations/${id}/pos/deploys`);
    assert.equal(res.status, 200);
    assert.equal(
      res.data.readiness.ready,
      true,
      JSON.stringify(res.data.readiness.items.filter((i) => i.state !== "ok")),
    );
    assert.deepEqual(
      res.data.readiness.items.map((i) => i.id),
      READINESS_IDS,
    );
    assert.equal(res.data.worker.online, true);
    assert.equal(res.data.cache.configured, true);
    assert.equal(res.data.locked, false);
  });
});

describe("enqueue", () => {
  it("queues a deploy, stores the full contract, returns a whitelist view and audits it", async () => {
    const { id, slug } = await fresh();
    fake.calls.length = 0;
    const res = await post(id, "deploys", deployBody(slug));
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const view = res.data.current;
    assert.equal(view.status, "queued");
    assert.equal(view.kind, "deploy");
    assert.equal(view.branch, "main");
    assert.equal(view.sha, SHAS.a);
    assert.equal(view.steps.length, 8);
    assert.equal(view.by.name, "owner");
    for (const leaked of [
      "lease",
      "fence",
      "buildKey",
      "runId",
      "artifactId",
      "attempt",
    ])
      assert.equal(leaked in view, false, leaked);
    const stored = (await doc(id)).pos.deploy.current;
    assert.match(stored.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(stored.lease, { owner: null, until: null, fence: 0 });
    assert.equal(stored.attempt, 0);
    assert.equal(stored.cancelRequested, false);
    assert.equal(stored.error, null);
    assert.equal(stored.step, "queued");
    assert.deepEqual(
      stored.steps.map((s) => s.name),
      [
        "preflight",
        "resolve",
        "build",
        "fetch",
        "upload",
        "vercel",
        "health",
        "finalize",
      ],
    );
    assert.ok(
      stored.steps.every((s) => s.state === "pending" && s.note === ""),
    );
    assert.equal(stored.by.id, owner.user._id ?? stored.by.id);
    // buildKey = HMAC of the canonical inputs for the fake builder commit.
    const expected = buildKeyOf(
      VAULT_KEY,
      buildInputs({
        pos: (await doc(id)).pos,
        builderSha: SHAS.c,
        builder: BUILDER,
      }),
    );
    assert.equal(stored.buildKey, expected);
    assert.equal(view.buildKey8, expected.slice(0, 8));
    // The rev is untouched: the config form is not marked stale.
    assert.equal((await doc(id)).pos.rev, 1);
    const rows = await audits(id, "pos.deploy.requested");
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].detail,
      `main@${SHAS.a.slice(0, 7)} #${stored.requestId.slice(0, 8)}`,
    );
    assertNoSecrets(rows, SECRETS, "audit rows");
  });
  it("one active job per installation: concurrent enqueue gives one 201 and one 409 busy", async () => {
    const { id, slug } = await fresh();
    const results = await Promise.all([
      post(id, "deploys", deployBody(slug)),
      post(id, "deploys", deployBody(slug)),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      JSON.stringify(results.map((r) => r.data)),
    );
    const loser = results.find((r) => r.status === 409);
    assert.equal(loser.data.code, "busy");
    assert.equal((await audits(id, "pos.deploy.requested")).length, 1);
    // And a third later request is busy too.
    assert.equal(
      (await post(id, "deploys", deployBody(slug))).data.code,
      "busy",
    );
  });
  it("a deploy and a rollback race for the same slot: exactly one wins", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    const results = await Promise.all([
      post(id, "deploys", deployBody(slug)),
      post(id, "rollback", { confirm: slug }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });
  it("an expired queued job and a long-dead lease no longer block", async () => {
    const { id, slug } = await fresh();
    const old = (extra) => ({
      ...extra,
      kind: "deploy",
      requestId: randomUUID(),
      branch: "main",
      sha: SHAS.b,
      steps: [],
    });
    // Contract (b): with a fresh heartbeat an old queued job still blocks.
    await setPos(id, {
      "pos.deploy.current": old({
        status: "queued",
        requestedAt: new Date(Date.now() - 11 * 60000),
      }),
    });
    assert.equal(
      (await post(id, "deploys", deployBody(slug))).data.code,
      "busy",
    );
    await setPos(id, {
      "pos.deploy.current": old({
        status: "running",
        step: "build",
        requestedAt: new Date(),
        lease: {
          owner: "w",
          until: new Date(Date.now() - 20 * 60000),
          fence: 3,
        },
      }),
    });
    assert.equal((await post(id, "deploys", deployBody(slug))).status, 201);
    // A running job with a fresh lease does block.
    await setPos(id, {
      "pos.deploy.current.status": "running",
      "pos.deploy.current.lease.until": new Date(Date.now() + 30000),
    });
    assert.equal(
      (await post(id, "deploys", deployBody(slug))).data.code,
      "busy",
    );
  });
  it("a finished job stays in current until replaced; a new request replaces it", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.current": {
        kind: "deploy",
        requestId: randomUUID(),
        branch: "main",
        sha: SHAS.a,
        status: "failed",
        step: "build",
        steps: [],
        requestedAt: new Date(),
        error: {
          step: "build",
          code: "build-failed",
          message: "x".repeat(300),
        },
      },
    });
    const state = await call(`/installations/${id}/pos/deploys`);
    assert.equal(state.data.current.status, "failed");
    assert.equal(state.data.current.error.message.length, 160);
    assert.equal((await post(id, "deploys", deployBody(slug))).status, 201);
    assert.equal((await doc(id)).pos.deploy.current.status, "queued");
  });
  it("branch-moved, sha-not-on-branch and an ancestor sha", async () => {
    const { id, slug } = await fresh();
    const ask = (extra) => post(id, "deploys", deployBody(slug, extra));
    // Requested sha is not the head: compare decides.
    fake.state.compare = { status: "behind", ahead_by: 0, behind_by: 3 };
    let res = await ask({ sha: sha(77) });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "branch-moved");
    fake.state.compare = { status: "diverged", ahead_by: 1, behind_by: 1 };
    res = await ask({ sha: sha(78) });
    assert.equal(res.data.code, "sha-not-on-branch");
    // An unknown commit (compare 404) is not on the branch either.
    fake.rule(
      (m, p) => m === "GET" && p.includes("/compare/"),
      () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    res = await ask({ sha: sha(79) });
    assert.equal(res.data.code, "sha-not-on-branch");
    // A branch that does not exist.
    res = await ask({ branch: "no-such-branch" });
    assert.equal(res.data.code, "sha-not-on-branch");
    assert.equal((await doc(id)).pos.deploy.current, null);
    // The head itself and an ancestor (compare ahead) are accepted.
    fake.state.compare = { status: "ahead", ahead_by: 4, behind_by: 0 };
    res = await ask({ sha: sha(80) });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal((await doc(id)).pos.deploy.current.sha, sha(80));
  });
  it("accepts the branch head without a compare, and a GitHub failure is a safe 502", async () => {
    const { id, slug } = await fresh();
    fake.calls.length = 0;
    const res = await post(id, "deploys", deployBody(slug));
    assert.equal(res.status, 201);
    assert.equal(
      fake.calls.filter((c) => c.path.includes("/compare/")).length,
      0,
    );
    await post(id, "deploys/cancel", { requestId: res.data.current.requestId });
    // Only this branch fails, so the rule cannot leak into other tests.
    fake.rule(
      (m, p) => m === "GET" && p.endsWith("/branches/flaky-branch"),
      () => new Response("{}", { status: 500 }),
      { times: -1 },
    );
    const bad = await post(
      id,
      "deploys",
      deployBody(slug, { branch: "flaky-branch" }),
    );
    assert.equal(bad.status, 502);
    assert.equal(bad.data.code, "provider-error");
    assert.equal(bad.data.error, "GitHub request failed (unavailable).");
  });
  it("redeploy uses the live commit from the server record, never the request", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    fake.calls.length = 0;
    const res = await post(id, "deploys", { kind: "redeploy", confirm: true });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const job = (await doc(id)).pos.deploy.current;
    assert.equal(job.kind, "redeploy");
    assert.equal(job.sha, SHA_OLD);
    assert.equal(job.branch, "main");
    assert.equal(
      fake.calls.filter(
        (c) =>
          c.path.includes("/compare/") ||
          (c.path.includes("/branches/") && c.path.startsWith(`/repos/${SRC}`)),
      ).length,
      0,
    );
    assert.equal((await audits(id, "pos.redeploy.requested")).length, 1);
    // Redeploy of the previous version.
    await setPos(id, { "pos.deploy.current": null });
    assert.equal(
      (
        await post(id, "deploys", {
          kind: "redeploy",
          of: "previous",
          confirm: true,
        })
      ).status,
      400,
    );
    const prev = await post(id, "deploys", {
      kind: "redeploy",
      of: "previous",
      confirm: (await doc(id)).pos.slug,
    });
    assert.equal(prev.status, 201);
    assert.equal((await doc(id)).pos.deploy.current.sha, SHA_PREV);
  });
  it("redeploy needs a live version; confirm must be true", async () => {
    const { id } = await fresh();
    assert.equal(
      (await post(id, "deploys", { kind: "redeploy", confirm: true })).status,
      409,
    );
    assert.equal(
      (await post(id, "deploys", { kind: "redeploy", confirm: "yes" })).status,
      400,
    );
    assert.equal(
      (
        await post(id, "deploys", {
          kind: "redeploy",
          of: "previous",
          confirm: true,
        })
      ).status,
      400,
      "redeploy of the previous version needs the typed slug",
    );
    const { slug } = await ctx.db
      .collection("installations")
      .findOne({ _id: id })
      .then((d) => d.pos);
    assert.equal(
      (
        await post(id, "deploys", {
          kind: "redeploy",
          of: "previous",
          confirm: slug,
        })
      ).status,
      409,
      "no previous version",
    );
    assert.equal(
      (await post(id, "deploys", { kind: "redeploy", confirm: slug })).status,
      400,
      "the live redeploy confirms with true, not a slug",
    );
  });
  it("rollback only when a previous version exists; the job targets it", async () => {
    const { id, slug } = await fresh();
    let res = await post(id, "rollback", { confirm: slug });
    assert.equal(res.status, 409);
    await setPos(id, { "pos.deploy.last": version(1) });
    assert.equal((await post(id, "rollback", { confirm: slug })).status, 409);
    await setPos(id, { "pos.deploy.previous": version(2) });
    res = await post(id, "rollback", { confirm: slug });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.current.kind, "rollback");
    const job = (await doc(id)).pos.deploy.current;
    assert.equal(job.vercelDeploymentId, "dpl_2");
    assert.equal(job.sha, SHA_PREV);
    assert.deepEqual(
      job.steps.map((s) => s.name),
      ["preflight", "vercel", "health", "finalize"],
    );
    const rows = await audits(id, "pos.rollback.requested");
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].detail,
      `main@${SHA_PREV.slice(0, 7)} #${job.requestId.slice(0, 8)}`,
    );
  });
  it("a paused customer blocks deploy but the lock and rollback gates are independent", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    const { customerId } = await doc(id);
    await ctx.db
      .collection("customers")
      .updateOne({ _id: customerId }, { $set: { status: "archived" } });
    for (const [path, body] of [
      ["deploys", deployBody(slug)],
      ["rollback", { confirm: slug }],
    ]) {
      const res = await post(id, path, body);
      assert.equal(res.data.code, "not-ready");
      assert.ok(res.data.items.includes("customer-active"));
    }
  });
});

describe("freeze", () => {
  it("freezing blocks deploys but not rollback or verify; unfreezing restores", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    const frozen = await call("/pos/freeze", {
      method: "POST",
      body: { reason: "incident 42" },
    });
    assert.equal(frozen.status, 200);
    const state = await call(`/installations/${id}/pos/deploys`);
    assert.equal(state.data.freeze.on, true);
    assert.equal(state.data.freeze.reason, "incident 42");
    const blocked = await post(id, "deploys", deployBody(slug));
    assert.equal(blocked.data.code, "not-ready");
    assert.deepEqual(blocked.data.items, ["not-frozen"]);
    assert.equal((await post(id, "verify", {}, admin)).status, 201);
    assert.equal((await post(id, "rollback", { confirm: slug })).status, 201);
    await setPos(id, { "pos.deploy.current": null });
    assert.equal((await call("/pos/unfreeze", { method: "POST" })).status, 200);
    assert.equal((await post(id, "deploys", deployBody(slug))).status, 201);
    const actions = (
      await ctx.db
        .collection("audit_events")
        .find({ resourceId: "pos-deploy-freeze" })
        .toArray()
    ).map((r) => r.action);
    assert.ok(
      actions.includes("pos.frozen") && actions.includes("pos.unfrozen"),
    );
  });
});

describe("lock and unlock", () => {
  it("unlock needs a clean recent verify, the slug and step-up; lock is idempotent", async () => {
    const { id, slug } = await fresh({ ready: false });
    await setPos(id, {
      "pos.vercel.token": encrypt(
        VERCEL_TOKEN,
        VAULT_KEY,
        aadOf(id, "vercel.token"),
      ),
    });
    let res = await post(id, "unlock", { confirm: slug });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "not-ready");
    assert.deepEqual(res.data.items, ["verified"]);
    await setPos(id, {
      "pos.verify": { ...OK_VERIFY(), mongo: "unreachable" },
    });
    assert.equal((await post(id, "unlock", { confirm: slug })).status, 409);
    await setPos(id, { "pos.verify": OK_VERIFY() });
    res = await post(id, "unlock", { confirm: slug, localLocked: true });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const stored = (await doc(id)).pos;
    assert.equal(stored.deployLock, false);
    assert.ok(stored.localLockConfirmedAt instanceof Date);
    assert.equal(stored.unlockedBy.name, "owner");
    assert.equal(stored.rev, 1);
    const unlocked = await audits(id, "pos.unlocked");
    assert.equal(unlocked.length, 1);
    assert.equal(unlocked[0].detail, `${slug} local-lock-confirmed`);
    assert.equal(
      (await call(`/installations/${id}/pos`)).data.pos.deployLock,
      false,
    );
    // Locking again, twice: one audit.
    assert.equal((await post(id, "lock", {})).status, 200);
    assert.equal((await post(id, "lock", {})).status, 200);
    assert.equal((await doc(id)).pos.deployLock, true);
    assert.equal((await audits(id, "pos.locked")).length, 1);
    const blocked = await post(id, "deploys", deployBody(slug));
    assert.ok(blocked.data.items.includes("unlocked"));
  });
  it("deployLock can no longer be set through the config PUT (finding 1)", async () => {
    const { id, slug } = await fresh();
    for (const deployLock of [true, false]) {
      const res = await call(`/installations/${id}/pos`, {
        method: "PUT",
        session: admin,
        body: { rev: 1, config: { ...POS_CONFIG(slug), deployLock } },
      });
      assert.equal(res.status, 400);
    }
    const ok = await call(`/installations/${id}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, config: POS_CONFIG(slug) },
    });
    assert.equal(ok.status, 200);
    assert.equal(
      (await doc(id)).pos.deployLock,
      false,
      "a config save never changes the lock",
    );
    // A brand-new block is always locked.
    const created = await fresh({ ready: false });
    assert.equal((await doc(created.id)).pos.deployLock, true);
  });
});

describe("cancel, dismiss and edits while a job is active", () => {
  it("cancels a queued job, a pre-upload job and refuses after upload", async () => {
    const { id, slug } = await fresh();
    const queued = await post(id, "deploys", deployBody(slug));
    let res = await post(id, "deploys/cancel", {
      requestId: queued.data.current.requestId,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.current.status, "cancelled");
    assert.equal((await audits(id, "pos.deploy.cancel-requested")).length, 1);
    await setPos(id, { "pos.deploy.current": null });
    const second = await post(id, "deploys", deployBody(slug));
    const rid = second.data.current.requestId;
    await setPos(id, {
      "pos.deploy.current.status": "running",
      "pos.deploy.current.step": "build",
      "pos.deploy.current.lease.until": new Date(Date.now() + 30000),
    });
    res = await post(id, "deploys/cancel", { requestId: rid });
    assert.equal(res.status, 200);
    assert.equal(res.data.current.status, "cancelling");
    assert.equal((await doc(id)).pos.deploy.current.cancelRequested, true);
    await setPos(id, {
      "pos.deploy.current.status": "running",
      "pos.deploy.current.step": "upload",
      "pos.deploy.current.cancelRequested": false,
    });
    res = await post(id, "deploys/cancel", { requestId: rid });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "too-late");
    assert.equal(
      (await post(id, "deploys/cancel", { requestId: randomUUID() })).status,
      404,
    );
  });
  it("dismisses only a finished job", async () => {
    const { id, slug } = await fresh();
    const job = await post(id, "deploys", deployBody(slug));
    const rid = job.data.current.requestId;
    assert.equal(
      (await post(id, "deploys/dismiss", { requestId: rid })).status,
      409,
    );
    await setPos(id, { "pos.deploy.current.status": "unhealthy" });
    assert.equal(
      (await post(id, "deploys/dismiss", { requestId: rid })).status,
      200,
    );
    assert.equal((await doc(id)).pos.deploy.current, null);
    assert.equal((await audits(id, "pos.deploy.dismissed")).length, 1);
  });
  it("config and credential edits and removal return 409 busy while a job is active", async () => {
    const { id, slug } = await fresh();
    await post(id, "deploys", deployBody(slug));
    const put = await call(`/installations/${id}/pos`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, config: POS_CONFIG(slug) },
    });
    assert.equal(put.status, 409);
    assert.equal(put.data.code, "busy");
    const secret = await call(`/installations/${id}/pos/secret`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, field: "vercel.token", value: "another-token-value-123" },
    });
    assert.equal(secret.status, 409);
    const del = await call(`/installations/${id}/pos`, {
      method: "DELETE",
      body: { rev: 1 },
    });
    assert.equal(del.status, 409);
    // A secret that no running job reads is still editable.
    const other = await call(`/installations/${id}/pos/secret`, {
      method: "PUT",
      session: admin,
      body: { rev: 1, field: "posAdmin.password", value: "Str0ng!password" },
    });
    assert.equal(other.status, 200, JSON.stringify(other.data));
  });
});

describe("views are strict whitelists", () => {
  it("posView and GET deploys never leak lease, fence, run ids, object keys or unknown fields", async () => {
    const { id } = await fresh();
    const buildKey = "cd".repeat(32);
    await setPos(id, {
      "pos.deploy.current": {
        kind: "deploy",
        requestId: randomUUID(),
        branch: "main",
        sha: SHAS.a,
        buildKey,
        status: "running",
        step: "build",
        requestedAt: new Date(),
        by: { id: "u", name: "Owner", email: "o@example.test" },
        lease: {
          owner: "worker-secret-owner",
          until: new Date(Date.now() - 1000),
          fence: 987654,
        },
        runId: 424242,
        runUrl: "https://github.com/owner/builder/actions/runs/77",
        artifactId: 31337,
        internalNote: "internal-only-note",
        steps: [
          {
            name: "build",
            state: "running",
            startedAt: new Date(),
            endedAt: null,
            note: "GitHub build",
            hidden: "x",
          },
        ],
        error: {
          step: "build",
          code: "BAD CODE!",
          message: "oops\u0007",
          stack: "stacktrace",
        },
        vercelDeploymentId: "dpl_new",
      },
      "pos.deploy.last": version(1, {
        internal: "last-internal",
        requestId: "rq",
      }),
      "pos.deploy.previous": version(2),
      "pos.task": {
        id: randomUUID(),
        kind: "verify",
        status: "running",
        lease: { owner: "task-owner", fence: 555 },
        params: { secret: "taskparam" },
        result: { vercel: "ok", nested: { x: 1 } },
      },
      "pos.verify": { ...OK_VERIFY(), extra: "verify-extra" },
    });
    for (const path of [
      `/installations/${id}/pos`,
      `/installations/${id}/pos/deploys`,
    ]) {
      const res = await call(path, { session: admin });
      assert.equal(res.status, 200);
      const text = JSON.stringify(res.data);
      for (const banned of [
        "987654",
        "worker-secret-owner",
        "424242",
        "31337",
        "internal-only-note",
        "last-internal",
        "secretobjectkey",
        buildKey,
        "stacktrace",
        "verify-extra",
        "task-owner",
        "taskparam",
        "o@example.test",
        "objectKey",
        '"lease"',
        '"fence"',
        '"runId"',
        '"artifactId"',
        "hidden",
        '"params"',
      ])
        assert.equal(text.includes(banned), false, `${path} leaks ${banned}`);
      const deploy = path.endsWith("/pos") ? res.data.pos.deploy : res.data;
      assert.equal(deploy.current.buildKey8, buildKey.slice(0, 8));
      assert.equal(deploy.current.stalled, true);
      assert.equal(deploy.current.error.code, "failed");
      assert.equal(deploy.current.error.message, "oops");
      assert.equal(deploy.last.build.key8, "abababab");
      assert.equal(deploy.last.build.cached, true);
      assert.equal(deploy.last.build.buildKey, undefined);
      assert.equal(deploy.last.commit.headline, "Headline");
      assert.equal(
        deploy.last.runUrl,
        "https://github.com/owner/builder/actions/runs/77",
      );
    }
  });
  it("the run link disappears after the 7-day retention", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1, {
        at: new Date(Date.now() - 8 * 86400000),
      }),
    });
    const res = await call(`/installations/${id}/pos/deploys`);
    assert.equal(res.data.last.runUrl, null);
  });
  it("overview carries POS attention counts and no installation detail", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.deploy.current": { status: "failed", kind: "deploy" },
    });
    ctx.c; // cache is 5 s: read through a fresh app instance of the route
    const res = await call("/overview", { session: viewer });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.data.pos).sort(), [
      "failed",
      "locked",
      "rolledBack",
      "total",
      "unhealthy",
      "unverified",
      "workerOnline",
    ]);
    assert.equal(typeof res.data.pos.workerOnline, "boolean");
    assert.ok(res.data.pos.failed >= 0);
  });
});

describe("branches, plan and the build-cache flag", () => {
  it("lists branches with a cached badge per head and caches the listing for 60 s", async () => {
    const { id } = await fresh();
    hits.add(SHAS.a);
    fake.calls.length = 0;
    const res = await call(`/pos/branches?installation=${id}`);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const byName = Object.fromEntries(
      res.data.branches.map((b) => [b.name, b]),
    );
    assert.equal(byName.main.cached, true);
    assert.equal(byName["feature/x"].cached, false);
    assert.equal(byName.main.sha, SHAS.a);
    assert.equal(res.data.cache.configured, true);
    // The lookup used this installation's buildKey and the branch head sha.
    const expected = buildKeyOf(
      VAULT_KEY,
      buildInputs({
        pos: (await doc(id)).pos,
        builderSha: SHAS.c,
        builder: BUILDER,
      }),
    );
    assert.ok(lookups.some((l) => l.sha === SHAS.a && l.buildKey === expected));
    const listCalls = () =>
      fake.calls.filter((c) => c.path === `/repos/${SRC}/branches`).length;
    const listed = listCalls();
    assert.ok(listed <= 1);
    await call(`/pos/branches?installation=${id}`);
    assert.equal(
      listCalls(),
      listed,
      "second request served from the 60 s cache",
    );
    const without = await call("/pos/branches");
    assert.ok(without.data.branches.every((b) => b.cached === null));
    assert.equal(
      (await call(`/pos/branches?installation=${randomUUID()}`)).status,
      404,
    );
    assert.equal((await call("/pos/branches?x=1")).status, 400);
  });
  it("the plan reports relation to the live commit, cache state and the estimate", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1, { branch: "plan-branch" }),
    });
    fake.state.branches.push({
      name: "plan-branch",
      sha: sha(55),
      message: "Plan head\nmore",
      date: "2026-10-06T10:00:00Z",
    });
    fake.state.compare = { status: "ahead", ahead_by: 5, behind_by: 0 };
    let res = await call(
      `/installations/${id}/pos/deploy-plan?branch=plan-branch`,
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.head.sha, sha(55));
    assert.equal(res.data.head.headline, "Plan head");
    assert.equal(res.data.relation.behindBy, 5);
    assert.equal(res.data.cache.state, "will-build");
    assert.equal(res.data.estimateMs, 150000);
    assert.equal(res.data.live.sha, SHA_OLD);
    // A branch whose head already has a stored build (lookups are cached for
    // 60 s per sha, so a second head is used instead of waiting).
    fake.state.branches.push({
      name: "plan-cached",
      sha: sha(56),
      message: "Cached head",
      date: "2026-10-06T11:00:00Z",
    });
    hits.add(sha(56));
    res = await call(`/installations/${id}/pos/deploy-plan?branch=plan-cached`);
    assert.equal(res.data.cache.state, "cached");
    assert.equal(res.data.estimateMs, 0);
    assert.equal(
      res.data.settingsChanged,
      true,
      "live build key differs from today's inputs",
    );
    assert.equal(
      (await call(`/installations/${id}/pos/deploy-plan?branch=nope-branch`))
        .data.code,
      "sha-not-on-branch",
    );
    assert.equal(
      (await call(`/installations/${id}/pos/deploy-plan`)).status,
      400,
    );
  });
});

describe("fleet", () => {
  it("computes behindBy with compare, flags a missing branch and classifies state", async () => {
    const live = await fresh();
    const gone = await fresh();
    const locked = await fresh({ ready: false });
    const none = await fresh();
    await setPos(live.id, {
      "pos.deploy.last": version(1, { branch: "main" }),
    });
    await setPos(gone.id, {
      "pos.deploy.last": version(1, { branch: "deleted-branch" }),
    });
    await setPos(locked.id, {
      "pos.deploy.last": version(1, { branch: "main" }),
    });
    fake.state.compare = { status: "ahead", ahead_by: 3, behind_by: 0 };
    hits.add(SHAS.a);
    fake.calls.length = 0;
    const res = await call("/pos/fleet");
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const row = (f) => res.data.rows.find((r) => r.installationId === f.id);
    assert.equal(row(live).behindBy, 3);
    assert.equal(row(live).relation, "behind");
    assert.equal(row(live).state, "live");
    assert.equal(row(live).live.sha7, SHA_OLD.slice(0, 7));
    assert.equal(row(live).head.sha7, SHAS.a.slice(0, 7));
    assert.equal(row(live).cached, true);
    assert.equal(row(live).customerName, `Customer ${live.slug}`);
    assert.equal(row(gone).branchGone, true);
    assert.equal(row(gone).relation, "branch-gone");
    assert.equal(row(gone).behindBy, null);
    assert.equal(row(locked).state, "locked");
    assert.equal(row(none).state, "not-deployed");
    assert.equal(row(none).relation, "none");
    // One compare for the repeated (live sha, head) pair, not one per row.
    const pair = `${SHA_OLD}...${SHAS.a}`;
    const compares = fake.calls.filter((c) => c.path.endsWith(pair));
    assert.equal(compares.length, 1);
    // Diverged and identical.
    fake.state.compare = { status: "diverged", ahead_by: 1, behind_by: 1 };
    await setPos(none.id, {
      "pos.deploy.last": version(2, { branch: "feature/x", sha: sha(66) }),
    });
    const again = await call(`/pos/fleet?customerId=${none.customerId}`);
    assert.equal(again.data.rows.length, 1);
    assert.equal(again.data.rows[0].relation, "diverged");
    await setPos(none.id, {
      "pos.deploy.last": version(2, { branch: "feature/x", sha: SHAS.b }),
      "pos.deploy.current": { status: "queued", requestedAt: new Date() },
    });
    const same = await call(`/pos/fleet?customerId=${none.customerId}`);
    assert.equal(same.data.rows[0].relation, "current");
    assert.equal(same.data.rows[0].behindBy, 0);
    assert.equal(same.data.rows[0].state, "deploying");
    assert.equal((await call("/pos/fleet?customerId=nope")).status, 400);
  });
  it("never returns secrets or boxes, and caps rows at 100", async () => {
    await fresh();
    const res = await call("/pos/fleet");
    assert.ok(res.data.rows.length <= 100);
    assert.equal(typeof res.data.limited, "boolean");
    const text = JSON.stringify(res.data);
    for (const key of ["token", "keys", "uri", "password"])
      assert.equal(text.includes(`"${key}"`), false);
  });
});

describe("prepare build", () => {
  it("creates one single-flight build row, audited, and reports an existing or cached build", async () => {
    const { id } = await fresh();
    const built = buildKeyOf(
      VAULT_KEY,
      buildInputs({
        pos: (await doc(id)).pos,
        builderSha: SHAS.c,
        builder: BUILDER,
      }),
    );
    const res = await post(id, "builds", { branch: "feature/x", sha: SHAS.b });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.build.state, "queued");
    assert.equal(res.data.build.key8, built.slice(0, 8));
    const row = await ctx.db
      .collection("system_state")
      .findOne({ _id: buildRowId(SHAS.b, built) });
    assert.equal(row.kind, "build");
    assert.equal(row.status, "queued");
    assert.deepEqual(row.lease, { owner: null, until: null, fence: 0 });
    assert.deepEqual(row.waiters, []);
    assert.equal(row.branch, "feature/x");
    assert.equal(row.commit.headline, "Feature work");
    assert.equal(row.commit.authorName, "Dev Person");
    assert.equal(row.inputs.builder.sha, SHAS.c);
    assert.equal(
      row.inputs.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL,
      "https://img.example.com/",
    );
    assertNoSecrets(row, SECRETS, "build row");
    assert.equal((await audits(id, "pos.build.requested")).length, 1);
    const again = await post(id, "builds", {
      branch: "feature/x",
      sha: SHAS.b,
    });
    assert.equal(again.status, 200);
    assert.equal(again.data.build.existing, true);
    assert.equal((await audits(id, "pos.build.requested")).length, 1);
    fake.state.branches.push({
      name: "prep-cached",
      sha: sha(41),
      message: "Prepared",
      date: "2026-10-07T10:00:00Z",
    });
    hits.add(sha(41));
    const cached = await post(id, "builds", {
      branch: "prep-cached",
      sha: sha(41),
    });
    assert.equal(cached.status, 200);
    assert.equal(cached.data.build.state, "cached");
    await ctx.db.collection("system_state").deleteOne({ _id: row._id });
  });
  it("applies the branch/sha safety check and the gates", async () => {
    const { id } = await fresh();
    fake.state.compare = { status: "diverged", ahead_by: 1, behind_by: 1 };
    const bad = await post(id, "builds", { branch: "main", sha: sha(90) });
    assert.equal(bad.data.code, "sha-not-on-branch");
    flags.builder = true;
    await heartbeat({
      builder: {
        sha: SHAS.c,
        nodeVersion: "22.11.0",
        cliVersion: "39.1.0",
        ok: false,
        checkedAt: new Date(),
      },
    });
    const blocked = await post(id, "builds", { branch: "main", sha: SHAS.a });
    assert.equal(blocked.data.code, "not-ready");
    assert.ok(blocked.data.items.includes("builder"));
    assert.equal(
      await ctx.db.collection("system_state").countDocuments({ kind: "build" }),
      0,
    );
  });
  it("is limited to 10 per hour per staff member", async () => {
    const { id } = await fresh();
    await clearOfWindow(3600000);
    let last;
    for (let i = 0; i < 11; i++)
      last = await post(id, "builds", { branch: "main", sha: SHAS.a });
    assert.equal(last.status, 429);
    await ctx.db.collection("system_state").deleteMany({ kind: "build" });
  });
  it("the build-cache self-test is owner-only and reports flags only", async () => {
    await fresh();
    const res = await call("/pos/build-cache/self-test", { method: "POST" });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(
      {
        put: res.data.put,
        conditional: res.data.conditional,
        list: res.data.list,
        get: res.data.get,
        del: res.data.del,
        ok: res.data.ok,
      },
      {
        put: true,
        conditional: true,
        list: true,
        get: true,
        del: true,
        ok: true,
      },
    );
    assert.equal(
      fakeS3.liveKeys().filter((k) => k.startsWith("builds/_selftest/")).length,
      0,
    );
    assert.equal(
      await ctx.db
        .collection("audit_events")
        .countDocuments({ action: "pos.build-cache.tested" }),
      1,
    );
  });
});

describe("verify and purge tasks", () => {
  it("verify enqueues one task per installation; a second is busy", async () => {
    const { id } = await fresh();
    const res = await post(id, "verify", {}, admin);
    assert.equal(res.status, 201);
    assert.equal(res.data.task.kind, "verify");
    assert.equal(res.data.task.status, "queued");
    const stored = (await doc(id)).pos.task;
    assert.deepEqual(stored.lease, { owner: null, until: null, fence: 0 });
    assert.equal((await post(id, "verify", {}, admin)).data.code, "busy");
    assert.equal((await audits(id, "pos.verify.requested")).length, 1);
    await ctx.db.collection("system_state").deleteOne({ _id: "pos-worker" });
    await setPos(id, { "pos.task.status": "succeeded" });
    assert.equal((await post(id, "verify", {}, admin)).data.code, "not-ready");
  });
  it("purge: preview then execute is bound to the exact previewed ids by a digest", async () => {
    const { id, slug } = await fresh();
    let res = await post(id, "purge/preview", {});
    assert.equal(res.status, 409, "no cutover yet");
    await setPos(id, { "pos.deploy.cutoverAt": new Date() });
    res = await post(id, "purge/preview", {});
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const taskId = res.data.task.id;
    assert.equal(res.data.task.kind, "purge-preview");
    // Not finished yet: executing is refused.
    assert.equal(
      (
        await post(id, "purge", {
          previewTaskId: taskId,
          digest: "a".repeat(64),
          confirm: slug,
        })
      ).status,
      409,
    );
    // The worker finishes the preview.
    const candidates = ["dpl_a", "dpl_b", "dpl_c"].map((x) => ({
      id: x,
      createdAt: new Date(),
      target: "production",
      state: "READY",
      extra: "dropped",
    }));
    await setPos(id, {
      "pos.task.status": "succeeded",
      "pos.task.finishedAt": new Date(),
      "pos.task.result": {
        at: new Date(),
        candidates,
        total: 3,
        keep: { production: 1 },
      },
    });
    const state = await call(`/installations/${id}/pos/deploys`);
    const view = state.data.task.result;
    assert.equal(view.candidates.length, 3);
    assert.match(view.digest, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(view).includes("dropped"), false);
    const execute = (body, extra) =>
      post(
        id,
        "purge",
        { previewTaskId: taskId, digest: view.digest, confirm: slug, ...body },
        extra,
      );
    assert.equal((await execute({ digest: "f".repeat(64) })).status, 409);
    assert.equal((await execute({ confirm: "nope" })).status, 400);
    assert.equal((await execute({ previewTaskId: randomUUID() })).status, 409);
    // The stored candidates change after the owner looked: digest no longer matches.
    await setPos(id, { "pos.task.result.candidates": candidates.slice(0, 2) });
    assert.equal((await execute({})).status, 409);
    await setPos(id, { "pos.task.result.candidates": candidates });
    // An old preview expires.
    await setPos(id, {
      "pos.task.finishedAt": new Date(Date.now() - 31 * 60000),
    });
    assert.equal((await execute({})).status, 409);
    await setPos(id, { "pos.task.finishedAt": new Date() });
    const ok = await execute({});
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.task.kind, "purge");
    const stored = (await doc(id)).pos.task;
    assert.deepEqual(stored.params.ids, ["dpl_a", "dpl_b", "dpl_c"]);
    assert.equal(stored.params.digest, view.digest);
    assert.equal(stored.params.previewTaskId, taskId);
    assert.equal(stored.status, "queued");
    assert.equal("params" in ok.data.task, false);
    const rows = await audits(id, "pos.purge.requested");
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail, /^3 deployments #/);
    assert.equal((await audits(id, "pos.purge.previewed")).length, 1);
    // The preview is consumed: a replay is refused.
    assert.equal((await execute({})).status, 409);
  });
  it("purge needs an unlocked, active client and an empty preview is refused", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.cutoverAt": new Date(),
      "pos.deployLock": true,
    });
    assert.equal((await post(id, "purge/preview", {})).data.code, "not-ready");
    await setPos(id, { "pos.deployLock": false });
    const res = await post(id, "purge/preview", {});
    await setPos(id, {
      "pos.task.status": "succeeded",
      "pos.task.finishedAt": new Date(),
      "pos.task.result": { at: new Date(), candidates: [], total: 0, keep: {} },
    });
    const view = (await call(`/installations/${id}/pos/deploys`)).data.task
      .result;
    assert.equal(
      (
        await post(id, "purge", {
          previewTaskId: res.data.task.id,
          digest: view.digest,
          confirm: slug,
        })
      ).status,
      409,
    );
  });
});

describe("commit on the job and the build row", () => {
  const DIRTY = "Fix \u202eevil\u0007 headline\u2028 here\nsecond line body";
  it("storedCommit keeps the first line, cleans control and bidi characters and never an e-mail", () => {
    const c = storedCommit(
      {
        headline: DIRTY,
        authorName: "Ann <ann@example.test> bob@example.test\u202e",
        date: "2026-10-05T10:00:00Z",
        email: "x@example.test",
      },
      SHAS.a,
      "main",
    );
    assert.equal(c.headline, "Fix  evil  headline  here");
    assert.equal(c.authorName, "Ann");
    assert.equal(c.sha, SHAS.a);
    assert.ok(c.date instanceof Date);
    assert.equal(JSON.stringify(c).includes("@"), false);
    assert.equal(storedCommit(null, SHAS.a, "main"), null);
    assert.equal(storedCommit({ headline: "x" }, "nope", "main"), null);
    assert.equal(
      storedCommit({ headline: "y".repeat(500) }, SHAS.a, "main").headline
        .length,
      120,
    );
  });
  it("a deploy stores the commit of the exact sha; the view and audit stay clean", async () => {
    const { id, slug } = await fresh();
    fake.state.branches.push({
      name: "commit-branch",
      sha: sha(71),
      message: DIRTY,
      date: "2026-10-06T12:00:00Z",
    });
    const res = await post(
      id,
      "deploys",
      deployBody(slug, { branch: "commit-branch", sha: sha(71) }),
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const stored = (await doc(id)).pos.deploy.current.commit;
    assert.equal(stored.sha, sha(71));
    assert.equal(stored.branch, "commit-branch");
    assert.equal(stored.headline, "Fix  evil  headline  here");
    assert.equal(stored.authorName, "Dev Person");
    assert.ok(stored.date instanceof Date);
    assert.equal(
      JSON.stringify(stored).includes("@"),
      false,
      "no e-mail stored",
    );
    assert.equal(JSON.stringify(stored).includes("dev@example.test"), false);
    assert.equal(res.data.current.commit.headline, "Fix  evil  headline  here");
    assert.equal(res.data.current.commit.authorName, "Dev Person");
    const state = await call(`/installations/${id}/pos/deploys`);
    assert.equal(state.data.current.commit.sha, sha(71));
    assertNoSecrets(state.data, SECRETS, "state");
  });
  it("redeploy and rollback copy the commit from the stored version", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1, {
        commit: {
          sha: SHA_OLD,
          branch: "main",
          headline: "Live headline",
          authorName: "Live Author",
          date: new Date("2026-10-01T00:00:00Z"),
        },
      }),
      "pos.deploy.previous": version(2),
    });
    let res = await post(id, "deploys", { kind: "redeploy", confirm: true });
    assert.equal(res.status, 201);
    let job = (await doc(id)).pos.deploy.current;
    assert.equal(job.commit.headline, "Live headline");
    assert.equal(job.commit.authorName, "Live Author");
    assert.equal(job.commit.sha, SHA_OLD);
    await setPos(id, { "pos.deploy.current": null });
    res = await post(id, "rollback", { confirm: slug });
    assert.equal(res.status, 201);
    job = (await doc(id)).pos.deploy.current;
    assert.equal(job.commit.sha, SHA_PREV);
    assert.equal(job.commit.headline, "Headline");
    // A version without a commit gives null, never a crash.
    await setPos(id, {
      "pos.deploy.current": null,
      "pos.deploy.last": { ...version(1), commit: undefined },
    });
    res = await post(id, "deploys", { kind: "redeploy", confirm: true });
    assert.equal((await doc(id)).pos.deploy.current.commit, null);
  });
  it("fleet rows carry the live headline, author name and date, cleaned", async () => {
    const f = await fresh();
    await setPos(f.id, {
      "pos.deploy.last": version(1, {
        commit: {
          sha: SHA_OLD,
          branch: "main",
          headline: "Ship ‮it\u0007\nbody",
          authorName: "Ann <ann@example.test>",
          date: new Date("2026-10-01T00:00:00Z"),
        },
      }),
    });
    const res = await call(`/pos/fleet?customerId=${f.customerId}`);
    const live = res.data.rows[0].live;
    assert.equal(live.headline, "Ship  it");
    assert.equal(live.authorName, "Ann");
    assert.ok(live.date);
    assert.equal(JSON.stringify(res.data).includes("@"), false);
    assertNoSecrets(res.data, SECRETS, "fleet");
  });
  it("prepare build stores the cleaned commit on the build row", async () => {
    const { id } = await fresh();
    fake.state.branches.push({
      name: "commit-build",
      sha: sha(72),
      message: DIRTY,
      date: "2026-10-06T13:00:00Z",
    });
    const res = await post(id, "builds", {
      branch: "commit-build",
      sha: sha(72),
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const row = await ctx.db
      .collection("system_state")
      .findOne({ kind: "build", sha: sha(72) });
    assert.equal(row.commit.headline, "Fix  evil  headline  here");
    assert.equal(row.commit.authorName, "Dev Person");
    assert.equal(row.commit.sha, sha(72));
    assert.equal(JSON.stringify(row.commit).includes("@"), false);
    assertNoSecrets(row, SECRETS, "build row");
    await ctx.db.collection("system_state").deleteOne({ _id: row._id });
  });
});

describe("API review fixes", () => {
  const BLD_CALLS = () =>
    fake.calls.filter((c) => c.path.startsWith(`/repos/${BLD}/`));
  it("C1: with no builder token on the API, the heartbeat alone drives plan, prepare build and readiness", async () => {
    const { id, slug } = await fresh();
    assert.equal(real.configured().builder, false, "API has no builder token");
    fake.calls.length = 0;
    hits.add(sha(61));
    fake.state.branches.push(
      {
        name: "c1-cached",
        sha: sha(61),
        message: "A",
        date: "2026-10-06T10:00:00Z",
      },
      {
        name: "c1-cold",
        sha: sha(62),
        message: "B",
        date: "2026-10-06T11:00:00Z",
      },
    );
    const state = await call(`/installations/${id}/pos/deploys`);
    assert.equal(state.data.readiness.ready, true);
    const builder = state.data.readiness.items.find((i) => i.id === "builder");
    assert.equal(builder.state, "ok");
    const plan = (b) =>
      call(`/installations/${id}/pos/deploy-plan?branch=${b}`);
    assert.equal((await plan("c1-cached")).data.cache.state, "cached");
    assert.equal((await plan("c1-cold")).data.cache.state, "will-build");
    const built = await post(id, "builds", { branch: "c1-cold", sha: sha(62) });
    assert.equal(built.status, 201, JSON.stringify(built.data));
    const queued = await post(
      id,
      "deploys",
      deployBody(slug, { branch: "c1-cached", sha: sha(61) }),
    );
    assert.equal(queued.status, 201, JSON.stringify(queued.data));
    const expected = buildKeyOf(
      VAULT_KEY,
      buildInputs({
        pos: (await doc(id)).pos,
        builderSha: SHAS.c,
        builder: BUILDER,
      }),
    );
    assert.equal((await doc(id)).pos.deploy.current.buildKey, expected);
    assert.equal(BLD_CALLS().length, 0, "no builder repo call from the API");
    await ctx.db.collection("system_state").deleteMany({ kind: "build" });
  });
  it("C1: a missing, failed, stale or token-less builder blocks with a clear reason", async () => {
    const { id } = await fresh();
    const item = async () =>
      (
        await call(`/installations/${id}/pos/deploys`)
      ).data.readiness.items.find((i) => i.id === "builder");
    const b = (extra) => ({
      sha: SHAS.c,
      protocol: 1,
      nodeVersion: "22.11.0",
      cliVersion: "39.1.0",
      ok: true,
      checkedAt: new Date(),
      ...extra,
    });
    await heartbeat({ builderConfigured: false });
    const got = await item();
    assert.equal(got.state, "blocked");
    assert.match(got.reason, /no builder token/);
    await heartbeat({ builderConfigured: true, builder: b({ ok: false }) });
    assert.match((await item()).reason, /failed/);
    await heartbeat({
      builder: b({ checkedAt: new Date(Date.now() - 40 * 60000) }),
    });
    assert.match((await item()).reason, /stale/);
    // Plan: an unusable descriptor means the cache state is unavailable.
    const plan = await call(`/installations/${id}/pos/deploy-plan?branch=main`);
    assert.equal(plan.data.cache.state, "unavailable");
    assert.equal(plan.data.buildKey8, "");
    const bad = await post(id, "builds", { branch: "main", sha: SHAS.a });
    assert.equal(bad.status, 409);
    assert.equal(bad.data.code, "not-ready");
  });
  it("H1: a pre-admin previous (no sha) can still be rolled back to", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": {
        ...version(2),
        status: "pre-admin",
        sha: "",
        branch: "",
        commit: null,
        build: null,
      },
    });
    const res = await post(id, "rollback", { confirm: slug });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const job = (await doc(id)).pos.deploy.current;
    assert.equal(job.kind, "rollback");
    assert.equal(job.vercelDeploymentId, "dpl_2");
    assert.equal(job.sha, "");
    assert.equal(job.commit, null);
    assert.equal(res.data.current.sha, "");
    assert.match(
      (await audits(id, "pos.rollback.requested"))[0].detail,
      /^pre-admin@- #/,
    );
    // The same version cannot be redeployed (no sha): the cache fallback is gone.
    await setPos(id, { "pos.deploy.current": null });
    assert.equal(
      (
        await post(id, "deploys", {
          kind: "redeploy",
          of: "previous",
          confirm: slug,
        })
      ).status,
      409,
    );
  });
  it("M1: a claimed rollback cannot be cancelled; an unclaimed one and a deploy still can", async () => {
    const { id, slug } = await fresh();
    await setPos(id, {
      "pos.deploy.last": version(1),
      "pos.deploy.previous": version(2),
    });
    let res = await post(id, "rollback", { confirm: slug });
    const rid = res.data.current.requestId;
    const claimed = {
      owner: "w1",
      until: new Date(Date.now() + 30000),
      fence: 1,
    };
    await setPos(id, {
      "pos.deploy.current.status": "running",
      "pos.deploy.current.step": "vercel",
      "pos.deploy.current.lease": claimed,
    });
    res = await post(id, "deploys/cancel", { requestId: rid });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "not-cancellable");
    assert.equal((await doc(id)).pos.deploy.current.status, "running");
    // Not yet claimed: still cancellable.
    await setPos(id, {
      "pos.deploy.current.status": "queued",
      "pos.deploy.current.step": "queued",
      "pos.deploy.current.lease": { owner: null, until: null, fence: 0 },
    });
    assert.equal(
      (await post(id, "deploys/cancel", { requestId: rid })).status,
      200,
    );
    assert.equal((await doc(id)).pos.deploy.current.status, "cancelled");
    // A claimed deploy before upload is unchanged: cancelling.
    await setPos(id, { "pos.deploy.current": null });
    const dep = await post(id, "deploys", deployBody(slug));
    await setPos(id, {
      "pos.deploy.current.status": "running",
      "pos.deploy.current.step": "build",
      "pos.deploy.current.lease": claimed,
    });
    res = await post(id, "deploys/cancel", {
      requestId: dep.data.current.requestId,
    });
    assert.equal(res.data.current.status, "cancelling");
  });
  it("M2: an old queued task with a fresh heartbeat still blocks a new one", async () => {
    const { id } = await fresh();
    await setPos(id, {
      "pos.task": {
        id: randomUUID(),
        kind: "verify",
        status: "queued",
        requestedAt: new Date(Date.now() - 20 * 60000),
        lease: { owner: null, until: null, fence: 0 },
      },
    });
    assert.equal((await post(id, "verify", {}, admin)).data.code, "busy");
  });
  it("M3: the boot migration relocks Stage 1 unlocked blocks once, audited, idempotently", async () => {
    const legacy = (await fresh()).id;
    await setPos(legacy, { "pos.deployLock": false }, { "pos.unlockedAt": "" });
    const legit = (await fresh()).id;
    await setPos(legit, {
      "pos.deployLock": false,
      "pos.unlockedAt": new Date(),
    });
    const locked = (await fresh({ ready: false })).id;
    // Earlier tests left unlocked blocks without unlockedAt: counted too.
    const before = await ctx.db.collection("installations").countDocuments({
      "pos.deployLock": false,
      "pos.unlockedAt": { $exists: false },
    });
    assert.ok(before >= 1);
    const n = await relockLegacyUnlocks(ctx.db);
    assert.equal(n, before);
    assert.equal((await doc(legacy)).pos.deployLock, true);
    assert.ok((await doc(legacy)).pos.relockedAt instanceof Date);
    assert.equal(
      (await doc(legit)).pos.deployLock,
      false,
      "owner unlocks are kept",
    );
    assert.equal((await doc(locked)).pos.deployLock, true);
    const events = await ctx.db
      .collection("audit_events")
      .find({ action: "pos.relocked" })
      .toArray();
    assert.equal(events.length, 1);
    assert.equal(events[0].detail, `${n} installations`);
    assert.equal(events[0].actorId, "system");
    assert.equal(await relockLegacyUnlocks(ctx.db), 0);
    assert.equal(
      await ctx.db
        .collection("audit_events")
        .countDocuments({ action: "pos.relocked" }),
      1,
    );
  });
  describe("M4 verify invalidation and busy tasks", () => {
    const put = (id, config, session = admin) =>
      doc(id).then((d) =>
        call(`/installations/${id}/pos`, {
          method: "PUT",
          session,
          body: { rev: d.pos.rev, config },
        }),
      );
    it("config changes that verify checks drop pos.verify; unrelated ones keep it", async () => {
      const { id, slug } = await fresh();
      const res = await put(id, POS_CONFIG(slug));
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.ok((await doc(id)).pos.verify, "identical config keeps verify");
      const other = {
        ...POS_CONFIG(slug),
        posAdmin: { username: "someoneelse" },
      };
      assert.equal((await put(id, other)).status, 200);
      assert.ok((await doc(id)).pos.verify, "posAdmin is not verified");
      const base = POS_CONFIG(slug);
      const changes = [
        { host: "new.pos.example.com" },
        { tenantId: "tenant_2" },
        { rootDomain: "other.example.com" },
        { vercel: { ...base.vercel, projectId: "prj_other" } },
        { vercel: { ...base.vercel, orgId: "team_other" } },
        {
          cloudflare: {
            ...base.cloudflare,
            workerUrl: "https://w2.example.workers.dev",
          },
        },
        { image: { ...base.image, publicBaseUrl: "https://img2.example.com" } },
      ];
      for (const change of changes) {
        await setPos(id, { "pos.verify": OK_VERIFY() });
        const done = await put(id, { ...base, ...change });
        assert.equal(done.status, 200, JSON.stringify(done.data));
        assert.equal(
          (await doc(id)).pos.verify,
          null,
          JSON.stringify(Object.keys(change)),
        );
        assert.equal(done.data.pos.verify, null);
        await put(id, base);
      }
    });
    it("replacing or removing vercel.token, mongo.uri or cloudflare.token drops pos.verify; other secrets keep it", async () => {
      const { id } = await fresh();
      const secret = async (field, value, session = admin) =>
        call(`/installations/${id}/pos/secret`, {
          method: "PUT",
          session,
          body: { rev: (await doc(id)).pos.rev, field, value },
        });
      assert.equal(
        (await secret("posAdmin.password", "Str0ng!password")).status,
        200,
      );
      assert.ok((await doc(id)).pos.verify);
      for (const [field, value] of [
        ["vercel.token", "another-vercel-token-value-1"],
        ["mongo.uri", "mongodb+srv://u:p@cluster.mongodb.net/db"],
        ["cloudflare.token", "another-cloudflare-token-value"],
      ]) {
        await setPos(id, { "pos.verify": OK_VERIFY() });
        const done = await secret(field, value);
        assert.equal(done.status, 200, JSON.stringify(done.data));
        assert.equal((await doc(id)).pos.verify, null, field);
      }
      await setPos(id, { "pos.verify": OK_VERIFY() });
      await stepUp(owner);
      const removed = await call(`/installations/${id}/pos/secret`, {
        method: "DELETE",
        body: { rev: (await doc(id)).pos.rev, field: "vercel.token" },
      });
      assert.equal(removed.status, 200, JSON.stringify(removed.data));
      assert.equal((await doc(id)).pos.verify, null);
      assertNoSecrets(removed.data, SECRETS, "secret removal");
    });
    it("an active task (verify, purge, backup) blocks config, token and removal edits with 409 busy", async () => {
      const { id, slug } = await fresh();
      for (const kind of ["verify", "purge", "db-backup"]) {
        await setPos(id, {
          "pos.task": {
            id: randomUUID(),
            kind,
            status: "running",
            requestedAt: new Date(),
            lease: {
              owner: "w",
              until: new Date(Date.now() + 30000),
              fence: 1,
            },
          },
        });
        const rev = (await doc(id)).pos.rev;
        const cfg = await put(id, POS_CONFIG(slug));
        assert.equal(cfg.status, 409, kind);
        assert.equal(cfg.data.code, "busy");
        for (const field of ["vercel.token", "mongo.uri"]) {
          const s = await call(`/installations/${id}/pos/secret`, {
            method: "PUT",
            session: admin,
            body: {
              rev,
              field,
              value:
                field === "mongo.uri"
                  ? "mongodb+srv://u:p@c.mongodb.net/db"
                  : "another-token-value-123",
            },
          });
          assert.equal(s.status, 409, `${kind} ${field}`);
          const d = await call(`/installations/${id}/pos/secret`, {
            method: "DELETE",
            body: { rev, field },
          });
          assert.equal(d.status, 409, `${kind} delete ${field}`);
        }
        assert.equal(
          (
            await call(`/installations/${id}/pos`, {
              method: "DELETE",
              body: { rev },
            })
          ).status,
          409,
        );
      }
      // Finished: editable again.
      await setPos(id, { "pos.task.status": "succeeded" });
      assert.equal((await put(id, POS_CONFIG(slug))).status, 200);
    });
  });
  describe("L1 prepare build retry and ownership", () => {
    const rowFor = (s) =>
      ctx.db.collection("system_state").findOne({ kind: "build", sha: s });
    it("a failed or cancelled row is reset by a new request; no stale error remains", async () => {
      const { id } = await fresh();
      fake.state.branches.push({
        name: "l1-retry",
        sha: sha(81),
        message: "R",
        date: "2026-10-06T10:00:00Z",
      });
      const ask = () =>
        post(id, "builds", { branch: "l1-retry", sha: sha(81) });
      assert.equal((await ask()).status, 201);
      for (const status of ["failed", "cancelled"]) {
        await ctx.db.collection("system_state").updateOne(
          { kind: "build", sha: sha(81) },
          {
            $set: {
              status,
              error: { code: "build-failed" },
              runId: 99,
              attempt: 3,
              waiters: ["x"],
              prepared: null,
            },
          },
        );
        const retry = await ask();
        assert.equal(
          retry.status,
          201,
          `${status}: ${JSON.stringify(retry.data)}`,
        );
        const row = await rowFor(sha(81));
        assert.equal(row.status, "queued");
        assert.equal(row.error, null);
        assert.equal(row.runId, null);
        assert.equal(row.attempt, 0);
        assert.deepEqual(row.waiters, []);
        assert.equal(row.prepared.by.name, "owner");
      }
      assert.equal((await audits(id, "pos.build.requested")).length, 3);
      await ctx.db.collection("system_state").deleteMany({ kind: "build" });
    });
    it("a row created by a deploy is marked prepared when the owner requests the same build", async () => {
      const { id } = await fresh();
      fake.state.branches.push({
        name: "l1-join",
        sha: sha(82),
        message: "J",
        date: "2026-10-06T10:00:00Z",
      });
      const built = buildKeyOf(
        VAULT_KEY,
        buildInputs({
          pos: (await doc(id)).pos,
          builderSha: SHAS.c,
          builder: BUILDER,
        }),
      );
      await ctx.db.collection("system_state").insertOne({
        _id: buildRowId(sha(82), built),
        kind: "build",
        status: "building",
        sha: sha(82),
        buildKey: built,
        inputs: {},
        branch: "l1-join",
        commit: null,
        lease: { owner: "w", until: new Date(), fence: 1 },
        attempt: 1,
        runId: 5,
        runUrl: null,
        artifactId: null,
        waiters: ["job-1"],
        prepared: null,
        error: null,
        createdAt: new Date(),
        finishedAt: null,
      });
      const res = await post(id, "builds", { branch: "l1-join", sha: sha(82) });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data, {
        build: {
          state: "building",
          sha7: sha(82).slice(0, 7),
          key8: built.slice(0, 8),
          existing: true,
        },
      });
      const row = await rowFor(sha(82));
      assert.equal(row.prepared.by.name, "owner");
      assert.deepEqual(row.waiters, ["job-1"], "waiters untouched");
      assert.equal(row.status, "building");
      assert.equal((await audits(id, "pos.build.requested")).length, 1);
      // Asking again does not re-mark or re-audit.
      await post(id, "builds", { branch: "l1-join", sha: sha(82) });
      assert.equal((await audits(id, "pos.build.requested")).length, 1);
      await ctx.db.collection("system_state").deleteMany({ kind: "build" });
    });
  });
  describe("fleet: light mode, states and counts", () => {
    it("light=1 makes no GitHub or cache call; unhealthy and rolled-back are distinct states", async () => {
      const a = await fresh(),
        b = await fresh(),
        c = await fresh(),
        d = await fresh();
      for (const [f, status] of [
        [a, "unhealthy"],
        [b, "rolled-back"],
        [c, "failed"],
        [d, "expired"],
      ])
        await setPos(f.id, {
          "pos.deploy.last": version(1, { branch: "main" }),
          "pos.deploy.current": {
            status,
            kind: "deploy",
            requestedAt: new Date(),
          },
        });
      fake.calls.length = 0;
      lookups.length = 0;
      const res = await call("/pos/fleet?light=1");
      assert.equal(res.status, 200);
      const row = (x) => res.data.rows.find((r) => r.installationId === x.id);
      assert.equal(row(a).state, "unhealthy");
      assert.equal(row(b).state, "rolled-back");
      assert.equal(row(c).state, "failed");
      assert.equal(row(d).state, "failed");
      assert.equal(row(a).relation, "unknown");
      assert.equal(row(a).behindBy, null);
      assert.equal(fake.calls.length, 0, "no GitHub call in light mode");
      assert.equal(lookups.length, 0, "no cache lookup in light mode");
      assert.equal((await call("/pos/fleet?light=2")).status, 400);
    });
    it("fleet carries the cleaned global freeze state; overview has total and a real locked count", async () => {
      const f = await fresh();
      let res = await call("/pos/fleet?light=1");
      assert.deepEqual(res.data.freeze, {
        on: false,
        reason: "",
        by: null,
        at: null,
      });
      await call("/pos/freeze", {
        method: "POST",
        body: { reason: "Stop‮ now\u0007 please" },
      });
      res = await call("/pos/fleet?light=1");
      assert.equal(res.data.freeze.on, true);
      assert.equal(res.data.freeze.reason, "Stop  now  please");
      assert.equal(res.data.freeze.by.name, "owner");
      assert.ok(res.data.freeze.at);
      assert.deepEqual(Object.keys(res.data.freeze).sort(), [
        "at",
        "by",
        "on",
        "reason",
      ]);
      await call("/pos/unfreeze", { method: "POST" });
      // Locked count follows pos.deployLock === true.
      const count = async () => {
        await new Promise((x) => setTimeout(x, 5200)); // overview cache is 5 s
        return (await call("/overview", { session: viewer })).data.pos;
      };
      await setPos(f.id, { "pos.deployLock": true });
      const locked = await count();
      const total = await ctx.db
        .collection("installations")
        .countDocuments({ pos: { $exists: true } });
      assert.equal(locked.total, total);
      await setPos(f.id, {
        "pos.deployLock": false,
        "pos.unlockedAt": new Date(),
      });
      const after = await count();
      assert.equal(
        after.locked,
        locked.locked - 1,
        "an unlock drops the count",
      );
      // The M3 migration leaves an owner unlock alone.
      await relockLegacyUnlocks(ctx.db);
      assert.equal((await doc(f.id)).pos.deployLock, false);
    });
    it("the overview counts failed, unhealthy and rolled-back separately", async () => {
      await ctx.db
        .collection("installations")
        .updateMany(
          { "pos.deploy.current": { $ne: null } },
          { $set: { "pos.deploy.current": null } },
        );
      const f = await fresh(),
        u = await fresh(),
        r = await fresh();
      await setPos(f.id, {
        "pos.deploy.current": { status: "failed", kind: "deploy" },
      });
      await setPos(u.id, {
        "pos.deploy.current": { status: "unhealthy", kind: "deploy" },
      });
      await setPos(r.id, {
        "pos.deploy.current": { status: "rolled-back", kind: "deploy" },
      });
      await new Promise((x) => setTimeout(x, 5200)); // the overview is cached for 5 s
      const res = await call("/overview", { session: viewer });
      assert.equal(res.data.pos.failed, 1);
      assert.equal(res.data.pos.unhealthy, 1);
      assert.equal(res.data.pos.rolledBack, 1);
    });
  });
});

describe("secrets never appear in any new surface", () => {
  it("audit rows and the audit/overview endpoints stay clean after all of the above", async () => {
    const rows = await ctx.db
      .collection("audit_events")
      .find({
        action:
          /^pos\.(deploy|redeploy|rollback|build|locked|unlocked|frozen|unfrozen|purge|verify)/,
      })
      .toArray();
    assert.ok(rows.length > 5);
    assertNoSecrets(
      rows.map((r) => r.detail),
      SECRETS,
      "audit details",
    );
    for (const row of rows)
      assert.ok(
        !/https?:\/\//.test(row.detail),
        "audit details carry no URLs or hosts",
      );
    assertNoSecrets((await call("/audit")).data, SECRETS, "/audit");
    assertNoSecrets((await call("/overview")).data, SECRETS, "/overview");
    assert.ok(GATES.deploy.length >= 10);
  });
});
