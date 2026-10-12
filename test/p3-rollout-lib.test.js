// P3 rollout (docs/P3-ROLLOUT.md): the pure rules shared by the API, the
// worker's rollout driver and the panel, the whitelist view, and the job /
// build-row builders every writer now shares.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANARY_SLUG,
  ROLLOUT_CONFIRM,
  ROLLOUT_GATE,
  TARGET_ITEMS,
  classifyTarget,
  newRolloutTarget,
  orderTargets,
  resumeTargets,
  rolloutCounts,
  targetOutcome,
} from "../shared/rollout.js";
import { ERROR_CODES, isKnownCode } from "../shared/deploy-errors.js";
import { JOB_STEPS, READINESS_IDS, buildRowId } from "../shared/deploy.js";
import { rolloutDigest, rolloutView } from "../backend/lib/deploy-view.js";
import {
  cancelFields,
  freeSlot,
  leaseless,
  newBuildRow,
  newJob,
  person,
  stepsFor,
} from "../backend/lib/deploy-job.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const KEY = "c".repeat(64);
const NOW = Date.parse("2026-10-12T10:00:00Z");
const okVerify = (at = new Date(NOW - 3600000)) => ({
  at,
  vercel: "ok",
  project: "ok",
  env: "ok",
  mongo: "ok",
  cloudflare: null,
  health: "ok",
});
const readyPos = (over = {}) => ({
  slug: "x",
  host: "x.example.com",
  deployLock: false,
  vercel: { token: { box: 1 }, projectId: "prj_1", orgId: "team_1" },
  verify: okVerify(),
  deploy: { last: { sha: OTHER, requestId: "r0" } },
  ...over,
});
const facts = (pos, over = {}) => ({
  pos,
  installationId: "i1",
  customerId: "c1",
  installationStatus: "live",
  customerStatus: "active",
  inputsOk: true,
  now: NOW,
  ...over,
});

describe("rollout order and target rules", () => {
  it("puts the canary first, then every other client by slug", () => {
    const out = orderTargets([
      { slug: "zeta" },
      { slug: "alpha" },
      { slug: CANARY_SLUG },
      { slug: "beta" },
    ]).map((t) => t.slug);
    assert.deepEqual(out, ["demo", "alpha", "beta", "zeta"]);
    assert.deepEqual(
      orderTargets([{ slug: "b" }, { slug: "a" }]).map((t) => t.slug),
      ["a", "b"],
    );
    assert.equal(CANARY_SLUG, "demo");
    assert.equal(ROLLOUT_CONFIRM, "deploy all");
  });
  it("skips deliberate owner states before checking readiness", () => {
    for (const lock of [true, undefined, null])
      assert.deepEqual(
        classifyTarget(facts(readyPos({ deployLock: lock })), SHA),
        { kind: "skip", code: "locked" },
      );
    for (const over of [
      { customerStatus: "paused" },
      { customerStatus: "archived" },
      { installationStatus: "retired" },
    ])
      assert.deepEqual(classifyTarget(facts(readyPos(), over), SHA), {
        kind: "skip",
        code: "customer-inactive",
      });
    assert.deepEqual(
      classifyTarget(facts(readyPos({ deploy: { last: { sha: SHA } } })), SHA),
      { kind: "skip", code: "already-live" },
    );
    assert.deepEqual(classifyTarget(facts(null), SHA), {
      kind: "skip",
      code: "not-found",
    });
    // A locked client is "locked" even when its verify is stale too.
    assert.equal(
      classifyTarget(facts(readyPos({ deployLock: true, verify: null })), SHA)
        .code,
      "locked",
    );
  });
  it("blocks a client whose own readiness fails, with the readiness ids", () => {
    const stale = classifyTarget(
      facts(readyPos({ verify: okVerify(new Date(NOW - 25 * 3600000)) })),
      SHA,
    );
    assert.deepEqual(stale, {
      kind: "blocked",
      code: "target-not-ready",
      items: ["verified"],
    });
    const many = classifyTarget(
      facts(readyPos({ vercel: {}, host: "" }), { inputsOk: false }),
      SHA,
    );
    assert.equal(many.code, "target-not-ready");
    assert.deepEqual(many.items, [
      "vercel-token",
      "project-ids",
      "host",
      "image-realtime",
    ]);
    for (const id of many.items) assert.ok(TARGET_ITEMS.includes(id));
  });
  it("does not count an unhealthy live version as already live", () => {
    assert.deepEqual(
      classifyTarget(
        facts(readyPos({ deploy: { last: { sha: SHA, healthy: false } } })),
        SHA,
      ),
      { kind: "target" },
    );
    assert.deepEqual(
      classifyTarget(
        facts(readyPos({ deploy: { last: { sha: SHA, healthy: true } } })),
        SHA,
      ),
      { kind: "skip", code: "already-live" },
    );
  });
  it("on Resume resets the stopped client and those not reached only", () => {
    const t = (slug, status, code) => ({
      ...newRolloutTarget(`i-${slug}`, slug),
      status,
      requestId: status === "pending" ? null : `r-${slug}`,
      error: code ? { code } : null,
    });
    const out = resumeTargets([
      t("demo", "succeeded"),
      t("alpha", "skipped", "locked"),
      t("beta", "skipped", "already-live"),
      t("gamma", "failed", "health-failed"),
      t("delta", "skipped", "rollout-stopped"),
      t("eps", "skipped", "frozen"),
    ]);
    assert.deepEqual(
      out.map((x) => [x.slug, x.status, x.error?.code ?? null, x.requestId]),
      [
        ["demo", "succeeded", null, "r-demo"],
        ["alpha", "skipped", "locked", "r-alpha"],
        ["beta", "skipped", "already-live", "r-beta"],
        ["gamma", "pending", null, null],
        ["delta", "pending", null, null],
        ["eps", "pending", null, null],
      ],
    );
  });
  it("accepts a ready client, also one that was never deployed", () => {
    assert.deepEqual(classifyTarget(facts(readyPos()), SHA), {
      kind: "target",
    });
    assert.deepEqual(
      classifyTarget(facts(readyPos({ deploy: undefined })), SHA),
      { kind: "target" },
    );
  });
  it("gates the whole rollout on the admin items only", () => {
    assert.deepEqual(ROLLOUT_GATE, [
      "worker",
      "builder",
      "source-token",
      "authenticator",
      "not-frozen",
    ]);
    for (const id of [...ROLLOUT_GATE, ...TARGET_ITEMS])
      assert.ok(READINESS_IDS.includes(id), id);
  });
});

describe("rollout job outcome", () => {
  const job = (over) => ({ requestId: "r1", step: "queued", ...over });
  it("maps an active job to building or deploying by its step", () => {
    for (const step of ["queued", "preflight", "resolve", "build", "fetch"])
      assert.deepEqual(
        targetOutcome({ current: job({ status: "running", step }) }, "r1"),
        { status: "building" },
      );
    for (const step of ["upload", "vercel", "health", "finalize"])
      assert.deepEqual(
        targetOutcome({ current: job({ status: "running", step }) }, "r1"),
        { status: "deploying" },
      );
    assert.equal(
      targetOutcome({ current: job({ status: "queued" }) }, "r1").status,
      "building",
    );
    assert.equal(
      targetOutcome(
        { current: job({ status: "cancelling", step: "build" }) },
        "r1",
      ).status,
      "building",
    );
  });
  it("reads success from last, failures from current (current first)", () => {
    assert.deepEqual(
      targetOutcome({ current: null, last: { requestId: "r1" } }, "r1"),
      { status: "succeeded" },
    );
    assert.deepEqual(
      targetOutcome(
        {
          current: job({ requestId: "r9", status: "queued" }),
          last: { requestId: "r1" },
        },
        "r1",
      ),
      { status: "succeeded" },
    );
    // Unhealthy without a rollback writes last too: current wins.
    assert.deepEqual(
      targetOutcome(
        {
          current: job({
            status: "unhealthy",
            error: { code: "health-failed" },
          }),
          last: { requestId: "r1" },
        },
        "r1",
      ),
      { status: "failed", code: "health-failed", stop: true },
    );
    // An unhealthy deploy's result lost from current (dismissed, replaced):
    // last carries the id but is marked unhealthy, so it is no success.
    assert.deepEqual(
      targetOutcome(
        { current: null, last: { requestId: "r1", healthy: false } },
        "r1",
      ),
      { status: "failed", code: "health-failed", stop: true },
    );
    assert.deepEqual(
      targetOutcome(
        { current: null, last: { requestId: "r1", healthy: true } },
        "r1",
      ),
      { status: "succeeded" },
    );
  });
  it("keeps a known job code and derives one otherwise", () => {
    const failed = (status, error) =>
      targetOutcome({ current: job({ status, error }) }, "r1");
    assert.deepEqual(failed("failed", { code: "build-failed" }), {
      status: "failed",
      code: "build-failed",
      stop: true,
    });
    assert.deepEqual(failed("failed", { code: "made-up-code" }), {
      status: "failed",
      code: "internal",
      stop: true,
    });
    assert.deepEqual(failed("rolled-back", null), {
      status: "failed",
      code: "health-failed",
      stop: true,
    });
    assert.deepEqual(failed("unhealthy", null), {
      status: "failed",
      code: "health-failed",
      stop: true,
    });
    assert.deepEqual(failed("expired", null), {
      status: "failed",
      code: "not-picked-up",
      stop: true,
    });
  });
  it("treats a cancelled job as skipped (cancelled or frozen)", () => {
    assert.deepEqual(
      targetOutcome(
        { current: job({ status: "cancelled", error: null }) },
        "r1",
      ),
      { status: "skipped", code: "cancelled", stop: true },
    );
    assert.deepEqual(
      targetOutcome(
        { current: job({ status: "cancelled", error: { code: "frozen" } }) },
        "r1",
      ),
      { status: "skipped", code: "frozen", stop: true },
    );
  });
  it("skips a client the owner locked or paused while its job waited", () => {
    for (const code of ["locked", "customer-inactive", "not-found"])
      assert.deepEqual(
        targetOutcome(
          {
            current: job({
              status: "failed",
              error: { step: "preflight", code },
            }),
          },
          "r1",
        ),
        { status: "skipped", code, stop: false },
      );
    // The same code from another step is a failure.
    assert.equal(
      targetOutcome(
        {
          current: job({
            status: "failed",
            error: { step: "upload", code: "locked" },
          }),
        },
        "r1",
      ).status,
      "failed",
    );
  });
  it("calls a job that vanished before it was seen job-lost", () => {
    for (const deploy of [
      null,
      { current: null, last: { requestId: "r0" } },
      { current: job({ requestId: "r2", status: "failed" }) },
    ])
      assert.deepEqual(targetOutcome(deploy, "r1"), {
        status: "failed",
        code: "job-lost",
        stop: true,
      });
  });
  it("counts targets by state", () => {
    assert.deepEqual(
      rolloutCounts([
        { status: "pending" },
        { status: "building" },
        { status: "deploying" },
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "failed" },
        { status: "skipped" },
      ]),
      { total: 7, pending: 1, active: 2, succeeded: 2, failed: 1, skipped: 1 },
    );
  });
  it("registers every new code in the shared table", () => {
    for (const code of [
      "rollout-stopped",
      "already-live",
      "target-not-ready",
      "target-busy",
      "job-lost",
      "not-authorized",
    ]) {
      assert.ok(isKnownCode(code), code);
      assert.ok(ERROR_CODES[code].plainMessage.length <= 160);
    }
  });
});

describe("rollout view and digest", () => {
  const row = (over = {}) => ({
    _id: "pos-rollout",
    id: "11111111-1111-4111-8111-111111111111",
    status: "running",
    branch: "main",
    sha: SHA,
    commit: {
      sha: SHA,
      branch: "main",
      headline: "Fix‮ things",
      authorName: "Dev",
      date: new Date(NOW),
    },
    by: { id: "staff-1", name: "Owner" },
    auth: { authVersion: 3, role: "owner" },
    resumed: null,
    startedAt: new Date(NOW),
    finishedAt: null,
    stopOnFailure: true,
    cancelRequested: false,
    stop: null,
    prepared: true,
    lease: { owner: "w1", until: new Date(NOW), fence: 4 },
    targets: [
      {
        installationId: "i1",
        slug: "demo",
        status: "deploying",
        requestId: "r-secret-ish",
        buildKey: KEY,
        prebuild: "joined",
        error: null,
        startedAt: new Date(NOW),
        finishedAt: null,
      },
      {
        installationId: "i2",
        slug: "alpha",
        status: "pending",
        requestId: null,
        buildKey: KEY,
        prebuild: "queued",
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      {
        installationId: "i3",
        slug: "beta",
        status: "failed",
        requestId: "r3",
        buildKey: null,
        prebuild: "unavailable",
        error: {
          code: "target-not-ready",
          items: ["verified", "evil"],
          message: "x",
        },
        startedAt: null,
        finishedAt: null,
      },
    ],
    ...over,
  });
  it("is a whitelist: no lease, authority, job ids or build keys", () => {
    const view = rolloutView(row());
    const text = JSON.stringify(view);
    for (const secret of [
      "w1",
      "authVersion",
      "r-secret-ish",
      KEY,
      SHA,
      "staff-1",
    ])
      assert.ok(!text.includes(secret), secret);
    assert.equal(view.sha7, SHA.slice(0, 7));
    // The bidi override becomes a space (cleanText).
    assert.equal(view.commit.headline, "Fix  things");
    assert.deepEqual(view.by, { name: "Owner" });
    assert.deepEqual(Object.keys(view.targets[0]).sort(), [
      "build",
      "error",
      "finishedAt",
      "installationId",
      "slug",
      "startedAt",
      "status",
    ]);
    assert.deepEqual(view.targets[2].error, {
      code: "target-not-ready",
      items: ["verified"],
    });
    assert.deepEqual(view.counts, {
      total: 3,
      pending: 1,
      active: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });
  });
  it("derives each pre-build's state from the build rows", () => {
    const id = buildRowId(SHA, KEY);
    const at = (status) =>
      rolloutView(row(), new Map(status ? [[id, { status }]] : [])).targets.map(
        (t) => t.build,
      );
    assert.deepEqual(at("building"), ["building", "building", null]);
    assert.deepEqual(at("queued"), ["building", "building", null]);
    assert.deepEqual(at("ready"), ["ready", "ready", null]);
    assert.deepEqual(at("failed"), ["failed", "failed", null]);
    assert.deepEqual(at("cancelled"), ["failed", "failed", null]);
    // Gone = stored in the cache (the build lane deletes a stored row).
    assert.deepEqual(at(null), ["ready", "ready", null]);
  });
  it("cleans unknown values instead of passing them on", () => {
    const view = rolloutView(
      row({
        status: "weird",
        branch: "bad..branch",
        stop: { slug: "demo", code: "Not A Code" },
        targets: [{ installationId: "i1", slug: "demo", status: "odd" }],
      }),
    );
    assert.equal(view.status, "stopped");
    assert.equal(view.branch, "");
    assert.deepEqual(view.stop, { slug: "demo", code: "internal" });
    assert.equal(view.targets[0].status, "pending");
    assert.equal(rolloutView(null), null);
  });
  it("binds the digest to the commit and the exact order of clients", () => {
    const d = rolloutDigest(SHA, ["i1", "i2"]);
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.notEqual(d, rolloutDigest(SHA, ["i2", "i1"]));
    assert.notEqual(d, rolloutDigest(OTHER, ["i1", "i2"]));
    assert.equal(d, rolloutDigest(SHA, ["i1", "i2"]));
  });
});

describe("shared job and build-row builders", () => {
  it("builds the queued deploy job of the JOB CONTRACT", () => {
    const job = newJob({
      kind: "deploy",
      branch: "main",
      sha: SHA,
      buildKey: undefined,
      commit: null,
      by: { id: "s1", name: "Owner" },
      now: NOW,
    });
    assert.match(job.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { ...job, requestId: "x" },
      {
        kind: "deploy",
        requestId: "x",
        branch: "main",
        sha: SHA,
        buildKey: null,
        commit: null,
        by: { id: "s1", name: "Owner" },
        requestedAt: new Date(NOW),
        status: "queued",
        step: "queued",
        steps: stepsFor("deploy"),
        lease: leaseless(),
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
      },
    );
    assert.deepEqual(
      stepsFor("deploy").map((s) => s.name),
      JOB_STEPS.deploy,
    );
    assert.deepEqual(
      stepsFor("rollback").map((s) => s.name),
      JOB_STEPS.rollback,
    );
    assert.deepEqual(person({ _id: "s1", name: "Owner", role: "owner" }), {
      id: "s1",
      name: "Owner",
    });
  });
  it("builds one build-row shape for every writer", () => {
    const at = new Date(NOW);
    assert.deepEqual(
      newBuildRow({
        _id: "pos-build:x",
        sha: SHA,
        buildKey: KEY,
        inputs: { v: 1 },
        branch: "main",
        commit: null,
        waiters: ["r1"],
        prepared: null,
        now: at,
      }),
      {
        _id: "pos-build:x",
        kind: "build",
        status: "queued",
        sha: SHA,
        buildKey: KEY,
        inputs: { v: 1 },
        branch: "main",
        commit: null,
        lease: leaseless(),
        attempt: 0,
        runId: null,
        runUrl: null,
        artifactId: null,
        waiters: ["r1"],
        prepared: null,
        error: null,
        createdAt: at,
        finishedAt: null,
      },
    );
  });
  it("cancels a queued job at once and a running one only before upload", () => {
    assert.deepEqual(cancelFields({ status: "queued", step: "queued" }, NOW), {
      status: "cancelled",
      cancelRequested: true,
      finishedAt: new Date(NOW),
    });
    assert.deepEqual(cancelFields({ status: "running", step: "build" }, NOW), {
      status: "cancelling",
      cancelRequested: true,
    });
    assert.equal(
      cancelFields({ status: "running", step: "upload" }, NOW),
      null,
    );
  });
  it("keeps the free-slot filter of the API", () => {
    const filter = freeSlot(
      "pos.deploy.current",
      ["queued", "running"],
      NOW,
      null,
    );
    assert.equal(filter.$or.length, 4);
    assert.equal(
      freeSlot("pos.deploy.current", ["queued", "running"], NOW, new Date(NOW))
        .$or.length,
      3,
    );
  });
});
