// The builder side of pos-builder's realtime.yml as the adapter sees it (the
// createGitHub API used by backend/worker/realtime-bundle.js): dispatch, run,
// provenance fields, one `pos-realtime-<id>` artifact holding index.js +
// realtime.json. Extracted from test/stage3-bundle.test.js (W3) so the go-live
// worker tests (W5) use the same fake.
//   state.tweak = {run(r), files(files, run), artifacts(metas, make), fail,
//                  status}; state.onPoll = async (run, n) hook.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ProviderError } from "../../backend/lib/provider-http.js";
import { makeZip } from "./builder.js";
import { BLD } from "./github.js";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export const BUNDLE = Buffer.from(
  "export class CafeRoom {}\nexport default { fetch() { return new Response('ok'); } };\n",
);
export const descriptorOf = (bundle = BUNDLE, over = {}) => ({
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

export function createRealtimeBuilder() {
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
    onPoll: null,
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
      await state.onPoll?.(run, run.polls);
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
