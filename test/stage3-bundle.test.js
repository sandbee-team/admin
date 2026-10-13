// P5 Stage 3 W3: the realtime Worker bundle (backend/worker/realtime-bundle.js,
// D46). A fake builder stands in for pos-builder's realtime.yml: dispatch,
// run, provenance, artifact, zip, descriptor allowlist and digest checks.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProviderError } from "../backend/lib/provider-http.js";
import { createGitHub } from "../backend/lib/github.js";
import { JobFail } from "../backend/worker/lease.js";
import {
  REALTIME_RUN_PREFIX,
  REALTIME_WORKFLOW,
  fetchRealtimeBundle,
  realtimeGitHubOf,
} from "../backend/worker/realtime-bundle.js";
import { makeZip } from "./fakes/builder.js";
import {
  createFakeGitHub as createHttpGitHub,
  BLD,
  SRC,
} from "./fakes/github.js";

const SHA = "1d30ac6dd41255f780325bcba9815842f1c5cfd5";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const BUNDLE = Buffer.from(
  "export class CafeRoom {}\nexport default { fetch() { return new Response('ok'); } };\n",
);
const descriptorOf = (bundle = BUNDLE, over = {}) => ({
  v: 1,
  main: "index.js",
  compatibilityDate: "2026-01-01",
  compatibilityFlags: [],
  durableObjects: [{ name: "CAFE_ROOM", className: "CafeRoom" }],
  migrations: [{ tag: "v1", newSqliteClasses: ["CafeRoom"] }],
  bundleSha256: sha256(bundle),
  bundleBytes: bundle.length,
  ...over,
});

// The builder side of realtime.yml as the adapter sees it (createGitHub API).
function createRealtimeBuilder() {
  const state = {
    dispatches: [],
    cancels: [],
    deleted: [],
    found: [],
    runs: new Map(),
    artifacts: new Map(),
    nextRun: 8001,
    nextArtifact: 9501,
    completeAfter: 2,
    configured: { source: false, builder: true },
    // {run(r), files(files, run), artifacts(metas, make), fail, status}
    tweak: {},
  };
  function complete(run) {
    const id = run.inputs.run_id;
    let files = [
      { name: "index.js", data: BUNDLE },
      { name: "realtime.json", data: JSON.stringify(descriptorOf()) },
    ];
    if (state.tweak.files) files = state.tweak.files(files, run) ?? files;
    const zip = makeZip(files);
    const make = (name) => ({
      id: state.nextArtifact++,
      name,
      size: zip.length,
      expired: false,
      digest: `sha256:${sha256(zip)}`,
      createdAt: null,
      expiresAt: null,
    });
    let metas = [make(`pos-realtime-${id}`)];
    if (state.tweak.artifacts)
      metas = state.tweak.artifacts(metas, make) ?? metas;
    for (const meta of metas)
      state.artifacts.set(meta.id, { meta, runId: run.id, zip });
    run.status = "completed";
    run.conclusion = "success";
    state.tweak.run?.(run);
  }
  const view = (run) => ({
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    displayTitle: run.displayTitle,
    runAttempt: 1,
    headSha: "c".repeat(40),
    path: run.path,
    headBranch: run.headBranch,
    event: run.event,
    htmlUrl: `https://github.com/${BLD}/actions/runs/${run.id}`,
    createdAt: null,
    updatedAt: null,
  });
  const api = {
    state,
    configured: () => state.configured,
    runUrl: (id) => `https://github.com/${BLD}/actions/runs/${id}`,
    async dispatch({ buildId, inputs }) {
      state.dispatches.push({ buildId, inputs: { ...inputs } });
      const run = {
        id: state.nextRun++,
        status: "queued",
        conclusion: null,
        displayTitle: `pos-realtime ${inputs.run_id}`,
        path: ".github/workflows/realtime.yml",
        headBranch: "main",
        event: "workflow_dispatch",
        inputs,
        polls: 0,
      };
      state.runs.set(run.id, run);
      return { runId: run.id, htmlUrl: api.runUrl(run.id), via: "response" };
    },
    async findRun(id) {
      state.found.push(id);
      const run = [...state.runs.values()].find(
        (r) => r.displayTitle === `pos-realtime ${id}`,
      );
      return run ? { runId: run.id, htmlUrl: api.runUrl(run.id) } : null;
    },
    async run(id) {
      const run = state.runs.get(id);
      if (!run) throw new ProviderError("github", "not-found", { status: 404 });
      run.polls++;
      if (run.status !== "completed" && !state.tweak.status) {
        if (run.polls === 1) run.status = "in_progress";
        else if (run.polls >= state.completeAfter) {
          if (state.tweak.fail) {
            run.status = "completed";
            run.conclusion =
              state.tweak.fail === "cancelled" ? "cancelled" : "failure";
          } else complete(run);
        }
      } else if (state.tweak.status) run.status = state.tweak.status;
      return view(run);
    },
    async failedStepName() {
      return state.tweak.fail === "cancelled"
        ? null
        : (state.tweak.fail ?? null);
    },
    async cancelRun(id) {
      state.cancels.push(id);
      return true;
    },
    async listArtifacts(runId) {
      return [...state.artifacts.values()]
        .filter((a) => a.runId === runId)
        .map((a) => ({ ...a.meta }));
    },
    async downloadArtifact(id, file, { maxBytes } = {}) {
      const a = state.artifacts.get(id);
      if (!a) throw new ProviderError("github", "not-found", { status: 404 });
      if (a.zip.length > maxBytes)
        throw new ProviderError("github", "too-large");
      if (a.meta.digest !== `sha256:${sha256(a.zip)}`)
        throw new ProviderError("github", "digest-mismatch");
      await writeFile(file, a.zip);
      return { bytes: a.zip.length, sha256: sha256(a.zip) };
    },
    async deleteArtifact(id) {
      state.deleted.push(id);
      state.artifacts.delete(id);
      return true;
    },
  };
  return api;
}

let gh, dir, clock, sleeps;
const ctx = () => ({
  c: { POS_BUILDER_REF: "main" },
  now: () => clock,
  uuid: randomUUID,
  sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
  },
  log: () => {},
});
const fetchIt = (over = {}) =>
  fetchRealtimeBundle(ctx(), {
    github: gh,
    sha: SHA,
    dir,
    t: { pollMs: 1000, pollMaxMs: 2000 },
    ...over,
  });
async function failsWith(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof JobFail, String(error?.stack ?? error));
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

beforeEach(async () => {
  gh = createRealtimeBuilder();
  clock = Date.parse("2026-10-14T10:00:00Z");
  sleeps = [];
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(path.join(tmpdir(), "rt-bundle-"));
});

describe("realtime bundle: the happy path", () => {
  it("dispatches realtime.yml for the commit and returns the checked bundle", async () => {
    const seen = [];
    const out = await fetchIt({
      onDispatched: async (x) => seen.push({ ...x }),
    });
    assert.equal(gh.state.dispatches.length, 1);
    const [{ buildId, inputs }] = gh.state.dispatches;
    assert.deepEqual(Object.keys(inputs).sort(), ["run_id", "sha"]);
    assert.equal(inputs.sha, SHA);
    assert.equal(inputs.run_id, buildId);
    assert.match(buildId, /^[0-9a-f-]{36}$/);
    assert.ok(out.bundle.equals(BUNDLE));
    assert.equal(out.bundleSha256, sha256(BUNDLE));
    assert.deepEqual(out.descriptor, descriptorOf());
    assert.equal(out.id, buildId);
    assert.equal(out.runId, 8001);
    // The caller can store the run before waiting (takeover reuses it).
    assert.deepEqual(
      seen.map((x) => [x.id, x.runId]),
      [
        [buildId, null],
        [buildId, 8001],
      ],
    );
    // The GitHub artifact is deleted and nothing stays on disk.
    assert.equal(gh.state.deleted.length, 1);
    assert.deepEqual(await readdir(dir), []);
    assert.ok(sleeps.length >= 1);
  });
  it("reuses the run of an earlier attempt instead of dispatching again", async () => {
    const first = await gh.dispatch({
      buildId: "x",
      inputs: { run_id: "11111111-1111-4111-8111-111111111111", sha: SHA },
    });
    const out = await fetchIt({
      prior: {
        id: "11111111-1111-4111-8111-111111111111",
        runId: first.runId,
        at: new Date(clock),
      },
    });
    assert.equal(gh.state.dispatches.length, 1);
    assert.equal(out.runId, first.runId);
    // Only the id stored: the run is found by its run-name.
    const id2 = "22222222-2222-4222-8222-222222222222";
    const second = await gh.dispatch({
      buildId: id2,
      inputs: { run_id: id2, sha: SHA },
    });
    const out2 = await fetchIt({
      prior: { id: id2, runId: null, at: new Date(clock) },
    });
    assert.deepEqual(gh.state.found, [id2]);
    assert.equal(out2.runId, second.runId);
    assert.equal(gh.state.dispatches.length, 2);
  });
  it("dispatches again when an earlier run's artifact is already gone", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const old = await gh.dispatch({
      buildId: id,
      inputs: { run_id: id, sha: SHA },
    });
    const run = gh.state.runs.get(old.runId);
    run.status = "completed";
    run.conclusion = "success";
    const out = await fetchIt({
      prior: { id, runId: old.runId, at: new Date(clock) },
    });
    assert.equal(gh.state.dispatches.length, 2);
    assert.notEqual(out.id, id);
    assert.ok(out.bundle.equals(BUNDLE));
  });
});

describe("realtime bundle: refusals", () => {
  it("needs a commit and the builder token", async () => {
    await failsWith(fetchIt({ sha: "main" }), "inputs-missing");
    gh.state.configured = { source: false, builder: false };
    await failsWith(fetchIt(), "realtime-bundle-failed", /builder token/);
    assert.equal(gh.state.dispatches.length, 0);
  });
  it("reports a failed, cancelled or slow run", async () => {
    gh.state.tweak.fail = "Checkout workers/realtime";
    await failsWith(fetchIt(), "realtime-bundle-failed", /source/);
    gh.state.tweak.fail = "Bundle (no Cloudflare credentials)";
    await failsWith(fetchIt(), "realtime-bundle-failed", /bundle/i);
    gh.state.tweak.fail = "cancelled";
    await failsWith(fetchIt(), "realtime-bundle-failed", /cancelled/);
    gh.state.tweak = { status: "queued" };
    await failsWith(fetchIt(), "realtime-bundle-timeout");
    assert.equal(gh.state.cancels.length, 1);
  });
  it("refuses a run that is not this dispatch of realtime.yml on main", async () => {
    for (const [field, value] of [
      ["path", ".github/workflows/build.yml"],
      ["headBranch", "spike-realtime"],
      ["event", "push"],
      ["displayTitle", "pos-realtime spike"],
    ]) {
      gh.state.tweak = { run: (r) => (r[field] = value) };
      await failsWith(fetchIt(), "realtime-bundle-refused");
    }
  });
  it("refuses anything but exactly one fresh pos-realtime-<id> artifact", async () => {
    const cases = [
      (metas, make) => [...metas, make("rtsrc-x")],
      (metas, make) => [make("pos-build-x")],
      (metas) => [{ ...metas[0], expired: true }],
      (metas) => [{ ...metas[0], digest: null }],
      (metas) => [{ ...metas[0], digest: `sha256:${"0".repeat(64)}` }],
    ];
    for (const artifacts of cases) {
      gh.state.tweak = { artifacts };
      await failsWith(fetchIt(), "realtime-bundle-refused");
    }
    assert.deepEqual(await readdir(dir), []);
  });
  it("refuses a zip that is not exactly index.js + realtime.json", async () => {
    const cases = [
      (files) => [...files, { name: "index.js.map", data: "{}" }],
      (files) => files.filter((f) => f.name !== "realtime.json"),
      (files) =>
        files.map((f) =>
          f.name === "index.js" ? { ...f, name: "../index.js" } : f,
        ),
      () => [
        { name: "index.js", data: Buffer.alloc(1024 * 1024 + 1, 0x61) },
        { name: "realtime.json", data: "{}" },
      ],
    ];
    for (const files of cases) {
      gh.state.tweak = { files };
      await failsWith(fetchIt(), "realtime-bundle-refused");
    }
    assert.deepEqual(await readdir(dir), []);
  });
  it("accepts only an allowlisted descriptor that matches the bundle", async () => {
    const with_ = (desc) => (files) =>
      files.map((f) =>
        f.name === "realtime.json"
          ? {
              ...f,
              data: typeof desc === "string" ? desc : JSON.stringify(desc),
            }
          : f,
      );
    for (const desc of [
      "not json",
      descriptorOf(BUNDLE, {
        durableObjects: [
          { name: "A", className: "A" },
          { name: "B", className: "B" },
        ],
      }),
      descriptorOf(BUNDLE, {
        migrations: [{ tag: "v1", deletedClasses: ["X"] }],
      }),
      descriptorOf(BUNDLE, { compatibilityFlags: ["nodejs_compat"] }),
      descriptorOf(BUNDLE, { bundleSha256: "0".repeat(64) }),
      descriptorOf(BUNDLE, { bundleBytes: BUNDLE.length + 1 }),
    ]) {
      gh.state.tweak = { files: with_(desc) };
      await failsWith(fetchIt(), "realtime-descriptor");
    }
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("the realtime builder adapter", () => {
  it("drives realtime.yml and finds runs by their pos-realtime run-name", async () => {
    assert.equal(REALTIME_WORKFLOW, "realtime.yml");
    assert.equal(REALTIME_RUN_PREFIX, "pos-realtime");
    const http = createHttpGitHub();
    http.state.dispatchMode = "204";
    const id = "44444444-4444-4444-8444-444444444444";
    http.state.runs.set(77, {
      id: 77,
      status: "queued",
      conclusion: null,
      display_title: `pos-realtime ${id}`,
      run_attempt: 1,
    });
    http.state.runs.set(78, {
      id: 78,
      status: "queued",
      conclusion: null,
      display_title: `pos-build ${id}`,
      run_attempt: 1,
    });
    const rt = realtimeGitHubOf(
      {
        POS_GITHUB_BUILDER_REPO: BLD,
        POS_GITHUB_BUILDER_TOKEN: "builder-token-123",
        POS_BUILDER_REF: "main",
      },
      { fetch: http.fetch, sleep: async () => {} },
    );
    assert.deepEqual(rt.configured(), { source: false, builder: true });
    const sent = await rt.dispatch({
      buildId: id,
      inputs: { run_id: id, sha: SHA },
    });
    assert.equal(sent.runId, 77);
    const call = http.calls.find((c) => c.method === "POST");
    assert.equal(
      call.path,
      `/repos/${BLD}/actions/workflows/realtime.yml/dispatches`,
    );
    assert.deepEqual(call.body.inputs, { run_id: id, sha: SHA });
    assert.equal(call.body.ref, "main");
    assert.equal(call.token, "builder-token-123");
    // The build lane's adapter keeps its own run-name.
    const build = createGitHub({
      sourceRepo: SRC,
      builderRepo: BLD,
      builderToken: "builder-token-123",
      fetch: http.fetch,
      sleep: async () => {},
    });
    assert.equal((await build.findRun(id, { attempts: 1 })).runId, 78);
  });
});
