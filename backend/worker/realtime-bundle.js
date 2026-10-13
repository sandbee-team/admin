// The realtime Worker bundle of a go-live (P5 Stage 3, D46). The admin worker
// cannot run wrangler, so pos-builder's realtime.yml bundles lucifer's
// workers/realtime at the go-live commit (no Cloudflare credentials on
// GitHub). This module dispatches that workflow, waits for the run, checks
// its provenance, downloads `pos-realtime-<id>` with the builder token (the
// adapter checks the artifact's sha256), reads exactly index.js +
// realtime.json, accepts only an allowlisted descriptor whose digest and size
// match the bundle, and returns the bundle in memory. Nothing of the bundle
// is executed, logged or kept on disk; the GitHub artifact is deleted after
// reading. Provider errors (ProviderError) are left to the caller's failure
// mapping (`github-<code>`), as in the build lane.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createGitHub } from "../lib/github.js";
import { ProviderError } from "../lib/provider-http.js";
import { MAX_BUNDLE_BYTES, parseRealtimeDescriptor } from "../lib/realtime.js";
import { isSha } from "../../shared/deploy.js";
import { AcceptError, extractZipEntry, readZipEntries } from "./artifact.js";
import { JobFail, ensureLive, wait } from "./lease.js";

export const REALTIME_WORKFLOW = "realtime.yml";
export const REALTIME_RUN_PREFIX = "pos-realtime";
export const REALTIME_ARTIFACT_PREFIX = "pos-realtime-";
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const FILES = ["index.js", "realtime.json"];
export const REALTIME_TIMING = Object.freeze({
  pollMs: 5000,
  pollMaxMs: 15000,
  queuedMaxMs: 10 * 60 * 1000,
  totalMaxMs: 15 * 60 * 1000,
});
// Failed builder step -> fixed message (codes stay realtime-bundle-failed).
const STEP_MESSAGES = [
  [/validate inputs/i, "The builder rejected the realtime bundle inputs."],
  [/checkout|verify source/i, "The builder could not read the Worker source."],
  [/wrangler/i, "The builder's pinned wrangler could not be installed."],
  [/bundle|descriptor/i, "The realtime Worker bundle failed on the builder."],
];
const stepMessage = (name) =>
  STEP_MESSAGES.find(([re]) => re.test(name ?? ""))?.[1] ??
  "The realtime bundle run failed on GitHub.";
const refused = (why) =>
  new JobFail(
    "realtime-bundle-refused",
    `The realtime bundle was not accepted (${why}).`,
  );
const badDescriptor = (why) =>
  new JobFail(
    "realtime-descriptor",
    `The realtime Worker descriptor was refused (${why}).`,
  );

// The builder-repo adapter for realtime.yml: the worker's builder token and
// ref, its own workflow and run-name. `overrides` = test seams (fetch, sleep).
export function realtimeGitHubOf(c, overrides = {}) {
  return createGitHub({
    builderRepo: c.POS_GITHUB_BUILDER_REPO,
    builderToken: c.POS_GITHUB_BUILDER_TOKEN,
    workflow: REALTIME_WORKFLOW,
    ref: c.POS_BUILDER_REF ?? "main",
    runPrefix: REALTIME_RUN_PREFIX,
    ...overrides,
  });
}

// ctx: {c, now, uuid, sleep, ...} (the worker context). `github` = the
// realtimeGitHubOf adapter. `prior` = {id, runId, at} of an earlier attempt
// of the same step (takeover): its run is reused instead of a new dispatch.
// `onDispatched({id, runId, at})` is awaited before the dispatch (runId null)
// and once the run id is known, so the caller can store both.
// Returns {descriptor, bundle (Buffer), bundleSha256, id, runId, runUrl}.
export async function fetchRealtimeBundle(
  ctx,
  { github, sha, dir, prior = null, onDispatched = async () => {}, signal, t },
) {
  const timing = { ...REALTIME_TIMING, ...t };
  if (!isSha(sha))
    throw new JobFail("inputs-missing", "The go-live commit is not set.");
  if (!github?.configured?.().builder)
    throw new JobFail(
      "realtime-bundle-failed",
      "The worker has no builder token for the realtime bundle.",
    );
  let run = await locate(ctx, github, prior, signal);
  let fresh = !run;
  for (;;) {
    if (!run) run = await dispatch(ctx, github, sha, onDispatched, signal);
    const done = await waitFor(ctx, github, run, timing, signal);
    if (done.conclusion !== "success") {
      const step =
        done.conclusion === "cancelled"
          ? null
          : await github.failedStepName(run.runId).catch(() => null);
      throw new JobFail(
        "realtime-bundle-failed",
        done.conclusion === "cancelled"
          ? "The realtime bundle run was cancelled."
          : stepMessage(step),
      );
    }
    checkRun(ctx, done, run.id);
    const artifacts = await github.listArtifacts(run.runId, { signal });
    // An earlier attempt's run whose artifact is already gone (read before,
    // or expired): bundle once more.
    if (!fresh && artifacts.length === 0) {
      run = null;
      fresh = true;
      continue;
    }
    const out = await readArtifact(github, artifacts, run.id, dir, signal);
    await github.deleteArtifact(out.artifactId).catch(() => {});
    return {
      descriptor: out.descriptor,
      bundle: out.bundle,
      bundleSha256: out.bundleSha256,
      id: run.id,
      runId: run.runId,
      runUrl: github.runUrl(run.runId),
    };
  }
}

async function locate(ctx, github, prior, signal) {
  if (!prior?.id) return null;
  const at = new Date(prior.at ?? ctx.now()).getTime();
  if (Number.isSafeInteger(prior.runId) && prior.runId > 0)
    return { id: prior.id, runId: prior.runId, at };
  const found = await github.findRun(prior.id, {
    since: at - 60000,
    attempts: 2,
    delayMs: 2000,
    signal,
  });
  return found ? { id: prior.id, runId: found.runId, at } : null;
}

async function dispatch(ctx, github, sha, onDispatched, signal) {
  const id = ctx.uuid();
  const at = ctx.now();
  await onDispatched({ id, runId: null, at: new Date(at) });
  ensureLive(signal);
  const sent = await github.dispatch({
    buildId: id,
    inputs: { run_id: id, sha },
    signal,
  });
  if (!sent.runId)
    throw new JobFail(
      "realtime-bundle-failed",
      "GitHub did not report the realtime bundle run.",
    );
  await onDispatched({ id, runId: sent.runId, at: new Date(at) });
  return { id, runId: sent.runId, at };
}

async function waitFor(ctx, github, run, timing, signal) {
  let delay = timing.pollMs;
  for (;;) {
    ensureLive(signal);
    const state = await github.run(run.runId, { signal });
    if (state.status === "completed") return state;
    const elapsed = ctx.now() - run.at;
    if (
      (state.status === "queued" && elapsed > timing.queuedMaxMs) ||
      elapsed > timing.totalMaxMs
    ) {
      await github.cancelRun(run.runId).catch(() => {});
      throw new JobFail(
        "realtime-bundle-timeout",
        state.status === "queued"
          ? "The realtime bundle run waited too long to start."
          : "The realtime bundle run took too long.",
      );
    }
    await wait(ctx, delay, signal);
    delay = Math.min(Math.round(delay * 1.3), timing.pollMaxMs);
  }
}

// Provenance (as the build lane's acceptBuild): the run must be THIS
// dispatch of realtime.yml on the builder ref.
function checkRun(ctx, state, id) {
  if (
    state.path !== `.github/workflows/${REALTIME_WORKFLOW}` ||
    state.headBranch !== (ctx.c?.POS_BUILDER_REF ?? "main") ||
    state.event !== "workflow_dispatch" ||
    state.displayTitle !== `${REALTIME_RUN_PREFIX} ${id}`
  )
    throw refused("run-provenance");
}

async function readArtifact(github, artifacts, id, dir, signal) {
  const name = `${REALTIME_ARTIFACT_PREFIX}${id}`;
  if (artifacts.length !== 1 || artifacts[0].name !== name)
    throw refused("artifact-count");
  const [artifact] = artifacts;
  if (artifact.expired) throw refused("artifact-expired");
  if (!artifact.digest) throw refused("artifact-digest");
  await mkdir(dir, { recursive: true });
  const zipPath = path.join(dir, `${name}.zip`);
  const files = Object.fromEntries(
    FILES.map((f) => [f, path.join(dir, `${name}.${f}`)]),
  );
  try {
    try {
      await github.downloadArtifact(artifact.id, zipPath, {
        maxBytes: MAX_ZIP_BYTES,
        signal,
      });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        ["digest-mismatch", "too-large", "redirect-host"].includes(error.code)
      )
        throw refused(`artifact-${error.code}`);
      throw error;
    }
    let bundle, raw;
    try {
      const { entries, size } = await readZipEntries(zipPath, {
        maxEntries: FILES.length,
      });
      const names = entries.map((e) => e.name).sort();
      if (names.join() !== FILES.join()) throw refused("zip-files");
      for (const entry of entries)
        await extractZipEntry(zipPath, entry, files[entry.name], {
          maxBytes:
            entry.name === "index.js" ? MAX_BUNDLE_BYTES : MAX_DESCRIPTOR_BYTES,
          zipSize: size,
        });
      bundle = await readFile(files["index.js"]);
      raw = await readFile(files["realtime.json"], "utf8");
    } catch (error) {
      if (error instanceof AcceptError) throw refused(error.code);
      throw error;
    }
    let descriptor;
    try {
      descriptor = parseRealtimeDescriptor(JSON.parse(raw));
    } catch {
      throw badDescriptor("allowlist");
    }
    const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
    if (
      bundleSha256 !== descriptor.bundleSha256 ||
      bundle.length !== descriptor.bundleBytes
    )
      throw badDescriptor("digest");
    return { descriptor, bundle, bundleSha256, artifactId: artifact.id };
  } finally {
    for (const file of [zipPath, ...Object.values(files)])
      await rm(file, { force: true }).catch(() => {});
  }
}
