// P5 Stage 3 W4: the go-live contract (shared/golive.js, bootstrap verify),
// its API (backend/modules/golive.js), the busy rules both ways, the label
// guard and the whitelist view. The worker side is test/stage3-worker (W5).
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
import { newGolive, newJob } from "../backend/lib/deploy-job.js";
import { goliveView } from "../backend/lib/deploy-view.js";
import { readinessOf, verifyStateOf } from "../shared/deploy.js";
import {
  GOLIVE_STEPS,
  goliveActionProblem,
  goliveBlocks,
  goliveStepsFor,
} from "../shared/golive.js";
import { isKnownCode } from "../shared/deploy-errors.js";
import { posConfigSchema } from "../shared/schemas.js";
import { createFakeGitHub, SRC, BLD, SHAS } from "./fakes/github.js";

const SRC_TOKEN = `github_pat_${"S".repeat(60)}`;
const VERCEL_TOKEN = "vercel-secret-token-1234567890";
const MONGO_URI = "mongodb+srv://u:mongo-pass-123@c0.example.net/cafe";
const IMAGE_KEYS = JSON.stringify({
  accessKeyId: "AKIDEXAMPLE1234",
  secretAccessKey: "image-secret-key-abcdef",
});
const SECRETS = [SRC_TOKEN, VERCEL_TOKEN, VAULT_KEY, MONGO_URI, IMAGE_KEYS];
const HOUR = 3600000;

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
const installs = () => ctx.db.collection("installations");
const state = () => ctx.db.collection("system_state");
const posOf = async (id) => (await installs().findOne({ _id: id })).pos;
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
const box = (id, field, value) => encrypt(value, VAULT_KEY, aadOf(id, field));
const OK_VERIFY = (health = "ok", at = new Date()) => ({
  at,
  by: { id: "x", name: "Owner" },
  vercel: "ok",
  project: "ok",
  env: "ok",
  mongo: "ok",
  cloudflare: null,
  health,
});
// A new client entered by hand (P5 §3 step 1): every input, no project ids,
// locked, never deployed. `over` patches the stored pos block.
async function client(slug, { label = slug, over = {}, secrets = true } = {}) {
  const customerId = randomUUID(),
    id = randomUUID();
  await ctx.db.collection("customers").insertOne({
    _id: customerId,
    name: `Customer ${slug}`,
    email: `${slug}-${id.slice(0, 6)}@example.test`,
    status: "active",
    updatedAt: new Date(),
  });
  const pos = newPos({
    slug,
    subdomain: label,
    host: "",
    tenantId: "",
    rootDomain: "",
    vercel: { projectId: "", orgId: "", teamId: "", projectName: "" },
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
  if (secrets) {
    pos.vercel.token = box(id, "vercel.token", VERCEL_TOKEN);
    pos.mongo.uri = box(id, "mongo.uri", MONGO_URI);
    pos.image.keys = box(id, "image.keys", IMAGE_KEYS);
  }
  Object.assign(pos, over);
  await installs().insertOne({
    _id: id,
    customerId,
    productId: product._id,
    name: `${slug} POS`,
    status: "planned",
    environment: "production",
    updatedAt: new Date(),
    pos,
  });
  return id;
}
const by = { id: "u", name: "Owner" };
// A stored go-live as the worker would leave it.
const golive = (over = {}) => ({
  ...newGolive({
    action: "start",
    branch: "main",
    sha: SHAS.a,
    by,
    now: Date.now(),
    label: "cafe1",
    host: "cafe1.sandbee.in",
  }),
  ...over,
});
const waiting = (waitingFor, over = {}) =>
  golive({
    status: "waiting",
    waitingFor,
    step: waitingFor === "dns" ? "dns" : "ready",
    steps: GOLIVE_STEPS.map((name, i) => ({
      name,
      state:
        i < GOLIVE_STEPS.indexOf(waitingFor === "dns" ? "dns" : "ready")
          ? "done"
          : "pending",
      startedAt: null,
      endedAt: null,
      note: "",
    })),
    ...over,
  });
const running = (over = {}) =>
  golive({
    status: "running",
    step: "project",
    lease: { owner: "w1", until: new Date(Date.now() + 60000), fence: 1 },
    ...over,
  });
// The block as the go-live leaves it before Unlock and deploy.
const atDeploy = (id, slug = "cafe1", over = {}) => ({
  host: `${slug}.sandbee.in`,
  tenantId: slug,
  rootDomain: "sandbee.in",
  vercel: {
    projectId: "prj_new1",
    orgId: "team_new1",
    teamId: "",
    projectName: slug,
    token: box(id, "vercel.token", VERCEL_TOKEN),
  },
  verify: OK_VERIFY("not-deployed"),
  golive: waiting("deploy", {
    address: { ...golive().address, label: slug, host: `${slug}.sandbee.in` },
  }),
  ...over,
});
const start = (id, over = {}, session = owner) =>
  posOf(id).then((pos) =>
    post(
      `/installations/${id}/pos/golive`,
      {
        action: "start",
        rev: pos.rev,
        branch: "main",
        sha: SHAS.a,
        confirm: pos.slug,
        ...over,
      },
      session,
    ),
  );

before(async () => {
  ctx = await startApp({ dbName: "p5_golive_api", deps: { github } });
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
  await installs().deleteMany({});
  await state().deleteMany({ _id: { $in: ["pos-deploy-freeze"] } });
  await ctx.db.collection("rate_limits").deleteMany({});
  await ctx.db.collection("audit_events").deleteMany({});
  await heartbeat();
  flags.source = flags.builder = true;
  fake.state.compare = { status: "ahead", ahead_by: 2, behind_by: 0 };
  await stepUp(owner);
});

// ---- pure contract ------------------------------------------------------------
describe("go-live contract", () => {
  it("verifyStateOf reads a never-deployed project as bootstrap, never as ok", () => {
    const now = Date.now();
    assert.equal(verifyStateOf(OK_VERIFY("ok"), now), "ok");
    assert.equal(verifyStateOf(OK_VERIFY("not-deployed"), now), "bootstrap");
    assert.equal(verifyStateOf(OK_VERIFY("unhealthy"), now), "failed");
    assert.equal(
      verifyStateOf(OK_VERIFY("not-deployed", new Date(now - 25 * HOUR)), now),
      "stale",
    );
    assert.equal(
      verifyStateOf(
        { ...OK_VERIFY("not-deployed"), mongo: "auth-failed" },
        now,
      ),
      "failed",
    );
    assert.equal(verifyStateOf(null, now), "missing");
  });
  it("readiness accepts bootstrap only when the caller allows it", () => {
    const base = {
      installationId: "i",
      customerId: "c",
      pos: { verify: OK_VERIFY("not-deployed") },
    };
    const item = (extra) =>
      readinessOf({ ...base, ...extra }).items.find((i) => i.id === "verified");
    assert.equal(item({}).state, "blocked");
    assert.match(item({}).reason, /no production deployment/);
    assert.equal(item({ bootstrap: true }).state, "ok");
    assert.equal(
      readinessOf({
        ...base,
        pos: { verify: OK_VERIFY("unhealthy") },
        bootstrap: true,
      }).items.find((i) => i.id === "verified").state,
      "blocked",
    );
  });
  it("allows each action only in its states", () => {
    const now = Date.now();
    const p = (g, a) => goliveActionProblem(g, a, now, new Date(now));
    assert.equal(p(null, "start"), null);
    assert.equal(p(null, "check"), "golive-state");
    assert.equal(p(null, "deploy"), "golive-state");
    assert.equal(p(null, "cancel"), "golive-state");
    assert.equal(p(golive(), "start"), "busy");
    assert.equal(p(running(), "cancel"), null);
    assert.equal(p(golive(), "cancel"), null);
    assert.equal(p(waiting("dns"), "start"), null);
    assert.equal(p(waiting("dns"), "check"), null);
    assert.equal(p(waiting("dns"), "deploy"), "golive-state");
    assert.equal(p(waiting("deploy"), "deploy"), null);
    assert.equal(p(waiting("deploy"), "cancel"), null);
    assert.equal(p(golive({ status: "failed" }), "start"), null);
    assert.equal(p(golive({ status: "deploying" }), "start"), "golive-state");
    assert.equal(p(golive({ status: "deploying" }), "cancel"), "golive-state");
    const live = golive({ status: "live", liveAt: new Date() });
    assert.equal(p(live, "start"), "golive-state");
    assert.equal(p(live, "sync-env"), null);
    assert.equal(p(live, "realtime"), null);
    assert.equal(p({ ...live, status: "failed" }, "sync-env"), null);
    assert.equal(p(golive({ status: "failed" }), "sync-env"), "golive-state");
    // A run whose lease died long ago no longer blocks: it counts as ended.
    const dead = running({
      lease: { owner: "w1", until: new Date(now - 20 * 60000), fence: 1 },
    });
    assert.equal(goliveBlocks(dead, now, new Date(now)), false);
    assert.equal(p(dead, "start"), null);
  });
  it("Check DNS keeps what the earlier steps did", () => {
    const prior = waiting("dns").steps;
    const steps = goliveStepsFor("check", prior);
    assert.deepEqual(
      steps.map((s) => [s.name, s.state]),
      GOLIVE_STEPS.map((n, i) => [
        n,
        i < GOLIVE_STEPS.indexOf("dns") ? "done" : "pending",
      ]),
    );
    assert.deepEqual(
      goliveStepsFor("sync-env").map((s) => s.name),
      ["secrets", "env"],
    );
    assert.equal(goliveStepsFor("start").length, GOLIVE_STEPS.length);
    assert.ok(GOLIVE_STEPS.length <= 12);
  });
  it("refuses the platform's reserved labels in POS setup", () => {
    const cfg = (subdomain) => ({ slug: "cafe1", subdomain, posAdmin: {} });
    for (const label of ["store", "pos", "wa", "admin", "www", "gstapi"])
      assert.equal(posConfigSchema.safeParse(cfg(label)).success, false, label);
    assert.equal(posConfigSchema.safeParse(cfg("cafe1")).success, true);
    assert.equal(posConfigSchema.safeParse(cfg("")).success, true);
  });
  it("knows every go-live code (plan §9 and the W1/W3 codes)", () => {
    for (const code of [
      "inputs-missing",
      "label-invalid",
      "label-not-single",
      "label-reserved",
      "label-taken",
      "label-in-use-dns",
      "project-live",
      "project-name-taken",
      "domain-taken",
      "dns-unreachable",
      "dns-pending",
      "dns-wrong-target",
      "txt-pending",
      "cert-pending",
      "env-upsert-failed",
      "env-parity",
      "env-keys-missing",
      "realtime-name",
      "realtime-bundle-failed",
      "realtime-bundle-refused",
      "realtime-bundle-timeout",
      "realtime-descriptor",
      "realtime-upload-failed",
      "realtime-probe-failed",
      "realtime-tenant-refused",
      "realtime-secret-mismatch",
      "realtime-envelope",
      "cf-account-ambiguous",
      "admin-exists",
      "admin-seed-failed",
      "golive-cancelled",
      "golive-stale",
    ])
      assert.equal(isKnownCode(code), true, code);
  });
  it("the view leaves out the lease, fingerprints and unknown fields", () => {
    const now = Date.now();
    const view = goliveView(
      {
        ...waiting("dns"),
        lease: { owner: "w1", until: new Date(now - 1), fence: 7 },
        secretField: "x",
        error: { step: "dns", code: "made-up-code", message: "a\u0007b" },
        warnings: ["admin-exists", "nope", "env-parity"],
        steps: [{ name: "dns", state: "weird", note: "x‮y".repeat(200) }],
        address: {
          label: "cafe1",
          host: "cafe1.sandbee.in",
          records: [
            { type: "CNAME", name: "cafe1", value: "abc.vercel-dns-017.com." },
            { type: "TXT", name: "_vercel.cafe1", value: "vc-domain-verify=x" },
            { type: "A", name: "evil", value: "1.2.3.4" },
          ],
          cname: { ok: false, found: "Evil.Example.com.", extra: 1 },
          txt: { ok: null, found: ["a", "b", "c", "d", "e"] },
          verified: "yes",
          configured: null,
          tls: true,
          state: "pending-dns",
          checkedAt: new Date(now),
        },
        env: {
          at: new Date(now),
          keys: [
            {
              name: "MONGODB_URI",
              type: "encrypted",
              targets: ["production", "preview", "development"],
              set: true,
              fp16: "0123456789abcdef",
              updatedAt: new Date(now),
            },
            { name: "bad key", type: "plain" },
          ],
        },
        realtime: {
          bundleSha256: "d".repeat(64),
          sha: SHAS.a,
          deployedAt: new Date(now),
        },
      },
      now,
      new Date(now),
    );
    const text = JSON.stringify(view);
    for (const leak of [
      "lease",
      "fence",
      "fp16",
      "0123456789abcdef",
      "secretField",
      "d".repeat(64),
    ])
      assert.equal(text.includes(leak), false, leak);
    assert.equal(view.error.code, "internal");
    assert.equal(view.error.message, "a b");
    assert.deepEqual(view.warnings, ["admin-exists", "env-parity"]);
    assert.equal(view.steps[0].state, "pending");
    assert.ok(view.steps[0].note.length <= 120);
    assert.deepEqual(
      view.address.records.map((r) => [r.type, r.name, r.value]),
      [
        ["CNAME", "cafe1", "abc.vercel-dns-017.com"],
        ["TXT", "_vercel.cafe1", "vc-domain-verify=x"],
        ["", "evil", "1.2.3.4"],
      ],
    );
    assert.deepEqual(view.address.cname, {
      ok: false,
      found: "evil.example.com",
    });
    assert.equal(view.address.txt.found.length, 4);
    assert.equal(view.address.verified, false);
    assert.deepEqual(view.env.keys, [
      {
        name: "MONGODB_URI",
        type: "encrypted",
        targets: ["production", "preview"],
        set: true,
        updatedAt: new Date(now),
      },
    ]);
    assert.equal(view.realtime.bundle8, "dddddddd");
    assert.equal(view.waitingFor, "dns");
    assert.equal(view.blocking, false);
  });
});

// ---- GET ---------------------------------------------------------------------
describe("GET /installations/:id/pos/golive", () => {
  it("lists readiness and what can be done; viewers are refused", async () => {
    const id = await client("cafe1");
    assert.equal(
      (await call(`/installations/${id}/pos/golive`, { session: viewer }))
        .status,
      403,
    );
    assert.equal(
      (await call(`/installations/${id}/pos/golive`, { session: admin }))
        .status,
      200,
    );
    const res = await call(`/installations/${id}/pos/golive`);
    assert.equal(res.status, 200);
    const d = res.data;
    assert.equal(d.golive, null);
    assert.equal(d.rev, 1);
    assert.equal(d.readiness.ready, true, JSON.stringify(d.readiness.items));
    const items = Object.fromEntries(
      d.readiness.items.map((i) => [i.id, i.state]),
    );
    assert.equal(items.realtime, "warn");
    assert.equal(items["mongo-uri"], "ok");
    assert.deepEqual(d.address, {
      label: "cafe1",
      host: "cafe1.sandbee.in",
      problem: null,
    });
    assert.equal(d.allowed.start, true);
    assert.equal(d.allowed.check, false);
    assert.equal(d.allowed.deploy, false);
    assert.equal(d.worker.online, true);
    assert.equal(d.freeze.on, false);
  });
  it("names what is missing", async () => {
    const id = await client("cafe2", { secrets: false });
    const d = (await call(`/installations/${id}/pos/golive`)).data;
    const blocked = d.readiness.items
      .filter((i) => i.state === "blocked")
      .map((i) => i.id);
    assert.deepEqual(blocked, ["vercel-token", "mongo-uri", "image"]);
    assert.equal(d.readiness.ready, false);
    assert.equal(d.allowed.start, false);
  });
});

// ---- start ---------------------------------------------------------------------
describe("POST /installations/:id/pos/golive (start)", () => {
  it("needs the deploy permission, step-up and the typed slug", async () => {
    const id = await client("cafe1");
    assert.equal((await start(id, {}, admin)).status, 403);
    await stepDown(owner);
    assert.equal((await start(id)).status, 428);
    await stepUp(owner);
    const wrong = await start(id, { confirm: "cafe" });
    assert.equal(wrong.status, 400);
    const stale = await start(id, { rev: 9 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, "stale");
    assert.equal((await posOf(id)).golive, undefined);
  });
  it("queues a run, derives the web address and records it", async () => {
    const id = await client("cafe1");
    await installs().updateOne(
      { _id: id },
      { $set: { "pos.verify": OK_VERIFY() } },
    );
    const res = await start(id);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const g = res.data.golive;
    assert.equal(g.status, "queued");
    assert.equal(g.action, "start");
    assert.equal(g.branch, "main");
    assert.equal(g.sha, SHAS.a);
    assert.deepEqual(
      g.steps.map((s) => s.name),
      GOLIVE_STEPS,
    );
    assert.ok(g.steps.every((s) => s.state === "pending"));
    assert.equal(g.address.host, "cafe1.sandbee.in");
    assert.equal(g.blocking, true);
    const pos = await posOf(id);
    assert.equal(pos.host, "cafe1.sandbee.in");
    assert.equal(pos.tenantId, "cafe1");
    assert.equal(pos.rootDomain, "sandbee.in");
    assert.equal(pos.rev, 2);
    assert.equal(pos.verify, null);
    assert.equal(pos.deployLock, true);
    assert.equal(pos.golive.address.label, "cafe1");
    assert.equal(pos.golive.lease.fence, 0);
    const [entry] = await audits("pos.golive.started");
    assert.match(entry.detail, /^start main@0000000 #[0-9a-f]{8}$/);
    // Visible to GET as the same whitelisted view.
    const view = (await call(`/installations/${id}/pos/golive`)).data;
    assert.equal(view.golive.requestId, g.requestId);
    assert.equal(view.allowed.start, false);
    assert.equal(view.allowed.cancel, true);
    assert.equal("lease" in view.golive, false);
    // POS settings carry only the badge.
    const posView = (await call(`/installations/${id}/pos`)).data.pos;
    assert.deepEqual(posView.golive, { status: "queued", waitingFor: null });
  });
  it("refuses what is not ready, a busy block and a commit off the branch", async () => {
    const missing = await client("cafe2", { secrets: false });
    const notReady = await start(missing);
    assert.equal(notReady.status, 409);
    assert.equal(notReady.data.code, "not-ready");
    assert.deepEqual(notReady.data.items, [
      "vercel-token",
      "mongo-uri",
      "image",
    ]);

    const imported = await client("cafe3", {
      over: { importedAt: new Date() },
    });
    assert.deepEqual((await start(imported)).data.items, ["new-client"]);

    const deploying = await client("cafe4", {
      over: {
        deploy: {
          current: {
            ...newJob({
              kind: "deploy",
              branch: "main",
              sha: SHAS.a,
              by,
              now: Date.now(),
            }),
            status: "running",
            step: "build",
            lease: {
              owner: "w1",
              until: new Date(Date.now() + 60000),
              fence: 1,
            },
          },
          last: null,
          previous: null,
          cutoverAt: null,
        },
      },
    });
    const busy = await start(deploying);
    assert.equal(busy.status, 409);
    assert.equal(busy.data.code, "busy");

    const tasking = await client("cafe5", {
      over: {
        task: {
          id: randomUUID(),
          kind: "verify",
          status: "running",
          step: "x",
          lease: { owner: "w1", until: new Date(Date.now() + 60000), fence: 1 },
          requestedAt: new Date(),
        },
      },
    });
    assert.equal((await start(tasking)).data.code, "busy");

    const id = await client("cafe6");
    assert.equal((await start(id)).status, 201);
    const again = await start(id);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, "busy");

    fake.state.compare = { status: "diverged", ahead_by: 1, behind_by: 1 };
    const other = await client("cafe7");
    const off = await start(other, { sha: SHAS.b });
    assert.equal(off.status, 409);
    assert.equal(off.data.code, "sha-not-on-branch");
  });
  it("refuses a label another installation holds", async () => {
    const byHost = await client("other1", {
      label: "x1",
      over: { host: "cafe1.sandbee.in" },
    });
    assert.ok(byHost);
    const id = await client("cafe1");
    const taken = await start(id);
    assert.equal(taken.status, 409);
    assert.equal(taken.data.code, "label-taken");

    await installs().deleteMany({});
    const holder = await client("other2", {
      label: "cafe2",
      over: {
        golive: golive({
          status: "cancelled",
          address: { label: "cafe2", host: "cafe2.sandbee.in" },
        }),
      },
    });
    assert.ok(holder);
    const second = await client("cafe2");
    assert.equal((await start(second)).data.code, "label-taken");
    // A config save on the apex cannot take it either.
    const pos = await posOf(second);
    const save = await call(`/installations/${second}/pos`, {
      method: "PUT",
      body: {
        rev: pos.rev,
        config: {
          slug: "cafe2",
          subdomain: "cafe2",
          image: {
            store: "r2",
            publicBaseUrl: "https://img.example.com",
            r2AccountId: "r2acc123",
            bucket: "images",
          },
          posAdmin: { username: "owner1" },
        },
      },
    });
    assert.equal(save.status, 409);
    assert.equal(save.data.code, "label-taken");
  });
  it("one go-live label per installation is enforced by a unique index", async () => {
    const names = (await installs().listIndexes().toArray()).map((i) => [
      Object.keys(i.key).join(),
      i.unique === true,
    ]);
    assert.deepEqual(names.filter(([k]) => k.startsWith("pos.golive")).sort(), [
      ["pos.golive.address.label", true],
      ["pos.golive.status", false],
    ]);
    await client("dup1", { over: { golive: golive() } });
    await assert.rejects(
      client("dup2", { over: { golive: golive() } }),
      (error) => error.code === 11000,
    );
  });
  it("a new start keeps what earlier runs learned", async () => {
    const id = await client("cafe1", {
      over: {
        golive: golive({
          status: "failed",
          error: { step: "env", code: "env-upsert-failed", message: "x" },
          env: { at: new Date(), keys: [] },
          admin: { state: "seeded", at: new Date() },
          address: {
            ...golive().address,
            records: [
              { type: "CNAME", name: "cafe1", value: "cname.vercel-dns.com" },
            ],
          },
        }),
      },
    });
    const before = (await posOf(id)).golive.requestId;
    const res = await start(id);
    assert.equal(res.status, 201);
    const g = (await posOf(id)).golive;
    assert.notEqual(g.requestId, before);
    assert.equal(g.error, null);
    assert.equal(g.admin.state, "seeded");
    assert.equal(g.address.records.length, 1);
  });
  it("is limited to 10 starts an hour per installation", async () => {
    await clearOfWindow(HOUR);
    const id = await client("cafe1");
    // The first one queues a run, the next ones are refused as busy: all count.
    for (let i = 0; i < 10; i++)
      assert.equal((await start(id)).status, i === 0 ? 201 : 409);
    assert.equal((await start(id)).status, 429);
  });
});

// ---- busy both ways ---------------------------------------------------------------
describe("an active go-live holds the installation", () => {
  it("refuses setup writes, secrets, removal and tasks", async () => {
    const id = await client("cafe1", { over: { golive: golive() } });
    const pos = await posOf(id);
    const put = await call(`/installations/${id}/pos`, {
      method: "PUT",
      body: {
        rev: pos.rev,
        config: {
          slug: "cafe1",
          subdomain: "cafe1",
          posAdmin: { username: "owner1" },
        },
      },
    });
    assert.equal(put.status, 409);
    assert.equal(put.data.code, "busy");
    const secret = await call(`/installations/${id}/pos/secret`, {
      method: "PUT",
      body: { rev: pos.rev, field: "image.keys", value: IMAGE_KEYS },
    });
    assert.equal(secret.data.code, "busy");
    const removeSecret = await call(`/installations/${id}/pos/secret`, {
      method: "DELETE",
      body: { rev: pos.rev, field: "image.keys" },
    });
    assert.equal(removeSecret.data.code, "busy");
    const remove = await call(`/installations/${id}/pos`, {
      method: "DELETE",
      body: { rev: pos.rev },
    });
    assert.equal(remove.data.code, "busy");
    const verify = await post(`/installations/${id}/pos/verify`, {});
    assert.equal(verify.status, 409);
    assert.equal(verify.data.code, "busy");
  });
  it("lets writes through once the run's lease is long dead", async () => {
    const id = await client("cafe1", {
      over: {
        golive: running({
          lease: {
            owner: "w1",
            until: new Date(Date.now() - 20 * 60000),
            fence: 1,
          },
        }),
      },
    });
    const pos = await posOf(id);
    const secret = await call(`/installations/${id}/pos/secret`, {
      method: "PUT",
      body: { rev: pos.rev, field: "image.keys", value: IMAGE_KEYS },
    });
    assert.equal(secret.status, 200, JSON.stringify(secret.data));
  });
  it("refuses a deploy of a live go-live client while Sync env runs", async () => {
    const id = await client("cafe1");
    await installs().updateOne(
      { _id: id },
      {
        $set: {
          ...Object.fromEntries(
            Object.entries(atDeploy(id)).map(([k, v]) => [`pos.${k}`, v]),
          ),
          "pos.verify": OK_VERIFY("ok"),
          "pos.deployLock": false,
          "pos.unlockedAt": new Date(),
          "pos.golive": golive({
            action: "sync-env",
            liveAt: new Date(),
            steps: goliveStepsFor("sync-env"),
          }),
        },
      },
    );
    const res = await post(`/installations/${id}/pos/deploys`, {
      kind: "deploy",
      branch: "main",
      sha: SHAS.a,
      confirm: "cafe1",
    });
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.equal(res.data.code, "busy");
    assert.equal((await posOf(id)).deploy.current, null);
  });
});

// ---- check DNS -----------------------------------------------------------------------
describe("POST /installations/:id/pos/golive/check", () => {
  it("queues a run from dns only while waiting", async () => {
    const none = await client("cafe0");
    const early = await post(`/installations/${none}/pos/golive/check`, {
      rev: 1,
    });
    assert.equal(early.status, 409);
    assert.equal(early.data.code, "golive-state");

    const id = await client("cafe1", {
      over: {
        subdomain: "cafe1",
        host: "cafe1.sandbee.in",
        golive: waiting("dns"),
      },
    });
    const pos = await posOf(id);
    const res = await post(
      `/installations/${id}/pos/golive/check`,
      { rev: pos.rev },
      admin,
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.golive.status, "queued");
    assert.equal(res.data.golive.action, "check");
    assert.deepEqual(
      res.data.golive.steps.map((s) => s.state),
      GOLIVE_STEPS.map((n, i) =>
        i < GOLIVE_STEPS.indexOf("dns") ? "done" : "pending",
      ),
    );
    assert.equal((await audits("pos.golive.check")).length, 1);
    // Still the go-live commit.
    assert.equal((await posOf(id)).golive.sha, SHAS.a);
  });
  it("refuses a label changed since the go-live started", async () => {
    const id = await client("cafe9", { over: { golive: waiting("dns") } });
    const res = await post(`/installations/${id}/pos/golive/check`, { rev: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.data.code, "golive-address");
  });
  it("is limited to 30 checks an hour", async () => {
    await clearOfWindow(HOUR);
    const id = await client("cafe0");
    for (let i = 0; i < 30; i++)
      assert.equal(
        (await post(`/installations/${id}/pos/golive/check`, { rev: 1 }))
          .status,
        409,
      );
    assert.equal(
      (await post(`/installations/${id}/pos/golive/check`, { rev: 1 })).status,
      429,
    );
  });
});

// ---- unlock and deploy ---------------------------------------------------------------
describe("POST /installations/:id/pos/golive/deploy (Unlock and deploy)", () => {
  async function ready(slug = "cafe1", over = {}) {
    const id = await client(slug);
    const patch = atDeploy(id, slug, over);
    await installs().updateOne(
      { _id: id },
      {
        $set: Object.fromEntries(
          Object.entries(patch).map(([k, v]) => [`pos.${k}`, v]),
        ),
      },
    );
    return id;
  }
  const deploy = async (id, over = {}, session = owner) => {
    const pos = await posOf(id);
    return post(
      `/installations/${id}/pos/golive/deploy`,
      { rev: pos.rev, confirm: pos.slug, ...over },
      session,
    );
  };
  it("unlocks and enqueues the first deploy of the go-live commit in one step", async () => {
    const id = await ready();
    assert.equal((await deploy(id, {}, admin)).status, 403);
    assert.equal((await deploy(id, { confirm: "nope" })).status, 400);
    const res = await deploy(id);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.golive.status, "deploying");
    assert.equal(res.data.current.kind, "deploy");
    assert.equal(res.data.current.sha, SHAS.a);
    const pos = await posOf(id);
    assert.equal(pos.deployLock, false);
    assert.ok(pos.unlockedAt instanceof Date);
    assert.equal(pos.unlockedBy.name, "owner");
    assert.equal(pos.localLockConfirmedAt, null);
    assert.equal(pos.deploy.current.status, "queued");
    assert.equal(pos.deploy.current.branch, "main");
    assert.equal(pos.deploy.current.commit.headline, "Main headline");
    assert.equal(pos.golive.status, "deploying");
    assert.equal(pos.golive.step, "deploy");
    assert.equal(pos.golive.deployRequestId, pos.deploy.current.requestId);
    assert.equal(
      pos.golive.steps.find((s) => s.name === "deploy").state,
      "running",
    );
    assert.equal((await audits("pos.unlocked")).length, 1);
    assert.equal((await audits("pos.golive.deploy")).length, 1);
    // Done once: the go-live no longer waits for a deploy.
    const again = await deploy(id);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, "golive-state");
  });
  it("refuses while frozen, unverified or not waiting for the deploy", async () => {
    const frozen = await ready("cafe1");
    await state().insertOne({
      _id: "pos-deploy-freeze",
      on: true,
      reason: "x",
      by,
      at: new Date(),
    });
    const f = await deploy(frozen);
    assert.equal(f.status, 409);
    assert.deepEqual(f.data.items, ["not-frozen"]);
    await state().deleteOne({ _id: "pos-deploy-freeze" });

    const unhealthy = await ready("cafe2", { verify: OK_VERIFY("unhealthy") });
    assert.deepEqual((await deploy(unhealthy)).data.items, ["verified"]);

    const dns = await ready("cafe3", {
      golive: waiting("dns", {
        address: {
          ...golive().address,
          label: "cafe3",
          host: "cafe3.sandbee.in",
        },
      }),
    });
    assert.equal((await deploy(dns)).data.code, "golive-state");
    assert.equal((await posOf(dns)).deployLock, true);
  });
  it("bootstrap counts for nothing outside Unlock and deploy", async () => {
    const id = await ready("cafe1");
    const unlock = await post(`/installations/${id}/pos/unlock`, {
      confirm: "cafe1",
    });
    assert.equal(unlock.status, 409);
    assert.deepEqual(unlock.data.items, ["verified"]);
    await installs().updateOne(
      { _id: id },
      { $set: { "pos.deployLock": false, "pos.unlockedAt": new Date() } },
    );
    const normal = await post(`/installations/${id}/pos/deploys`, {
      kind: "deploy",
      branch: "main",
      sha: SHAS.a,
      confirm: "cafe1",
    });
    assert.equal(normal.status, 409);
    assert.deepEqual(normal.data.items, ["verified"]);
  });
});

// ---- cancel ----------------------------------------------------------------------------
describe("POST /installations/:id/pos/golive/cancel", () => {
  const cancel = (id, requestId, session = owner) =>
    post(`/installations/${id}/pos/golive/cancel`, { requestId }, session);
  it("cancels a queued or waiting run at once and asks a running one to stop", async () => {
    const q = await client("cafe1", { over: { golive: golive() } });
    const g1 = (await posOf(q)).golive;
    assert.equal((await cancel(q, g1.requestId, admin)).status, 403);
    assert.equal((await cancel(q, randomUUID())).status, 404);
    const r1 = await cancel(q, g1.requestId);
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    assert.equal(r1.data.golive.status, "cancelled");
    assert.ok((await posOf(q)).golive.endedAt instanceof Date);

    await installs().deleteMany({});
    const r = await client("cafe2", {
      label: "cafe2",
      over: {
        golive: running({
          address: { label: "cafe2", host: "cafe2.sandbee.in" },
        }),
      },
    });
    const g2 = (await posOf(r)).golive;
    const r2 = await cancel(r, g2.requestId);
    assert.equal(r2.data.golive.status, "running");
    assert.equal(r2.data.golive.cancelRequested, true);

    const w = await client("cafe3", {
      label: "cafe3",
      over: {
        golive: waiting("dns", {
          address: { label: "cafe3", host: "cafe3.sandbee.in" },
        }),
      },
    });
    const r3 = await cancel(w, (await posOf(w)).golive.requestId);
    assert.equal(r3.data.golive.status, "cancelled");
    assert.equal(r3.data.golive.waitingFor, null);
    assert.equal((await audits("pos.golive.cancelled")).length, 3);

    const live = await client("cafe4", {
      label: "cafe4",
      over: {
        golive: golive({
          status: "live",
          liveAt: new Date(),
          address: { label: "cafe4", host: "cafe4.sandbee.in" },
        }),
      },
    });
    const r4 = await cancel(live, (await posOf(live)).golive.requestId);
    assert.equal(r4.status, 409);
    assert.equal(r4.data.code, "golive-state");
  });
});

// ---- later actions on a live go-live ---------------------------------------------------
describe("Sync env and Update realtime Worker", () => {
  it("run only on a live go-live; realtime needs Cloudflare", async () => {
    const id = await client("cafe1", {
      over: {
        host: "cafe1.sandbee.in",
        tenantId: "cafe1",
        rootDomain: "sandbee.in",
        golive: golive({ status: "live", liveAt: new Date() }),
      },
    });
    assert.equal((await start(id)).data.code, "golive-state");
    const rev = (await posOf(id)).rev;
    const rt = await post(`/installations/${id}/pos/golive`, {
      action: "realtime",
      rev,
      branch: "main",
      sha: SHAS.a,
      confirm: "cafe1",
    });
    assert.equal(rt.status, 409);
    assert.deepEqual(rt.data.items, ["realtime"]);
    const sync = await post(`/installations/${id}/pos/golive`, {
      action: "sync-env",
      rev,
      confirm: "cafe1",
    });
    assert.equal(sync.status, 201, JSON.stringify(sync.data));
    assert.equal(sync.data.golive.action, "sync-env");
    assert.deepEqual(
      sync.data.golive.steps.map((s) => s.name),
      ["secrets", "env"],
    );
    const g = (await posOf(id)).golive;
    assert.ok(g.liveAt instanceof Date);
    assert.equal(g.sha, SHAS.a);
    // A live client's address is not re-derived.
    assert.equal((await posOf(id)).rev, rev);
  });
});
