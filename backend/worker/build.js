// The build lane. One transient system_state row per (sha, buildKey) is the
// single-flight lock: the deploy jobs that need the build (and "Prepare build")
// are its waiters, this lane dispatches the private GitHub builder, polls the
// run, accepts the artifact (REV2 2.6 / builder security review), seals it into
// the S3 build cache and deletes the GitHub artifact once the manifest is
// stored. Takeover resumes from runId; nothing is dispatched twice for a row.
import { mkdir } from "node:fs/promises";
import { isKnownCode } from "../../shared/deploy-errors.js";
import { ProviderError } from "../lib/provider-http.js";
import { BuildCacheError } from "../lib/build-cache.js";
import {
  BUILD_SETTINGS,
  buildKeyOf,
  envFingerprints,
} from "../lib/build-inputs.js";
import {
  JobFail,
  LeaseLost,
  ensureLive,
  failMessage,
  wait,
  withLease,
} from "./lease.js";
import { AcceptError, acceptBuild } from "./artifact.js";
import { buildDir, ensureSpace, writeSidecar } from "./fetch-build.js";

const QUEUED_MAX_MS = 15 * 60 * 1000;
const TOTAL_MAX_MS = 30 * 60 * 1000;
// Failed builder step -> fixed code and message.
const STEP_FAILURES = [
  [
    /checkout source|verify source/i,
    "source-read",
    "The builder could not read the POS source.",
  ],
  [/validate inputs/i, "bad-inputs", "The builder rejected the build inputs."],
  [
    /verify builder versions/i,
    "builder-versions",
    "The builder tool versions do not match.",
  ],
  [/scan|sanitis/i, "scan-failed", "The build output failed the safety scan."],
  [/install|build|pack/i, "build-failed", "The POS build failed."],
];
export function mapFailedStep(name) {
  for (const [re, code, message] of STEP_FAILURES)
    if (re.test(name ?? "")) return { code, message };
  return { code: "build-failed", message: "The GitHub build failed." };
}
const isoOrNull = (value) => {
  const d = new Date(value ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export function buildFailure(error) {
  if (error instanceof JobFail)
    return { code: error.code, message: error.message };
  if (error instanceof AcceptError)
    return {
      code: error.code,
      message: failMessage(
        `The build output was not accepted (${error.code}).`,
      ),
    };
  if (error instanceof ProviderError)
    return {
      code: `github-${error.code}`.slice(0, 40),
      message: failMessage(`GitHub request failed (${error.code}).`),
    };
  return { code: "internal", message: "The worker hit an unexpected error." };
}
export async function runBuildLane(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    (signal) => driveBuild(ctx, claim, signal),
    async (error) => {
      const failure = buildFailure(error);
      const code = isKnownCode(failure.code) ? failure.code : "internal";
      const { message } = failure;
      ctx.log("build-failed", { id: String(slot.idValue).slice(-8), code });
      await slot.set({
        status: "failed",
        error: { code, message },
        finishedAt: new Date(ctx.now()),
      });
    },
  );
}
async function driveBuild(ctx, claim, signal) {
  const { slot } = claim;
  let row = claim.doc;
  const { sha, buildKey } = row;
  const id8 = buildKey.slice(0, 8);
  if (claim.tooManyAttempts)
    throw new JobFail(
      "worker-stopped",
      "The worker stopped repeatedly during this build.",
    );
  await ensureSpace(ctx);
  const dir = buildDir(ctx, sha, buildKey);
  await mkdir(dir, { recursive: true });
  const readyRow = async (extra) => {
    await slot.mustSet({
      status: "ready",
      finishedAt: new Date(ctx.now()),
      error: null,
      ...extra,
    });
  };
  if (ctx.cache) {
    const found = await ctx.cache.lookup({ sha, buildKey }).catch(() => null);
    if (found?.state === "hit") {
      if (row.artifactId)
        await ctx.github.deleteArtifact(row.artifactId).catch(() => {});
      await slot.coll.deleteOne(slot.filterOf());
      ctx.log("build-adopted", { id: id8 });
      return;
    }
  }
  // ---- dispatch (once per row) --------------------------------------------------
  let { runId, buildId } = row;
  if (!runId) {
    if (buildId) {
      const since = new Date(row.dispatchedAt ?? ctx.now()).getTime() - 60000;
      const found = await ctx.github.findRun(buildId, {
        since,
        attempts: 2,
        delayMs: 2000,
        signal,
      });
      if (found) ({ runId } = found);
    }
    if (!runId) {
      buildId = ctx.uuid();
      await slot.mustSet({
        buildId,
        status: "dispatching",
        dispatchedAt: new Date(ctx.now()),
      });
      ensureLive(signal);
      const sent = await ctx.github.dispatch({
        buildId,
        inputs: {
          build_id: buildId,
          sha,
          build_env: JSON.stringify(row.inputs.env),
        },
        signal,
      });
      if (!sent.runId)
        throw new JobFail(
          "dispatch-lost",
          "GitHub did not report the build run.",
        );
      runId = sent.runId;
      await slot.mustSet({
        runId,
        runUrl: ctx.github.runUrl(runId),
        status: "building",
      });
    } else {
      await slot.mustSet({
        runId,
        runUrl: ctx.github.runUrl(runId),
        status: "building",
      });
    }
    row = await slot.read();
  }
  // ---- poll the run ---------------------------------------------------------------
  const startedAt = new Date(row.dispatchedAt ?? ctx.now()).getTime();
  let delay = ctx.t.buildPollMs;
  let run;
  for (;;) {
    ensureLive(signal);
    const fresh = await slot.read();
    if (!slot.mine(fresh)) throw new LeaseLost();
    const wanted = (fresh.waiters?.length ?? 0) > 0 || Boolean(fresh.prepared);
    if (!wanted) {
      await ctx.github.cancelRun(runId, { signal }).catch(() => {});
      await slot.mustSet({
        status: "cancelled",
        finishedAt: new Date(ctx.now()),
        error: null,
      });
      return;
    }
    run = await ctx.github.run(runId, { signal });
    if (run.status === "completed") break;
    const elapsed = ctx.now() - startedAt;
    if (run.status === "queued" && elapsed > QUEUED_MAX_MS) {
      await ctx.github.cancelRun(runId).catch(() => {});
      throw new JobFail(
        "build-queued-timeout",
        "The GitHub build waited too long to start.",
      );
    }
    if (elapsed > TOTAL_MAX_MS) {
      await ctx.github.cancelRun(runId).catch(() => {});
      throw new JobFail("build-timeout", "The GitHub build took too long.");
    }
    await wait(ctx, delay, signal);
    delay = Math.min(Math.round(delay * 1.3), ctx.t.buildPollMaxMs);
  }
  if (run.conclusion !== "success") {
    const name = await ctx.github.failedStepName(runId).catch(() => null);
    const mapped =
      run.conclusion === "cancelled"
        ? {
            code: "build-cancelled",
            message: "The GitHub build was cancelled.",
          }
        : mapFailedStep(name);
    throw new JobFail(mapped.code, mapped.message);
  }
  // ---- collect: acceptance ----------------------------------------------------------
  await slot.mustSet({ status: "collecting" });
  const accepted = await acceptBuild(ctx, {
    runId,
    buildId: row.buildId ?? buildId,
    sha,
    env: row.inputs.env,
    dir,
    signal,
  });
  await writeSidecar(dir, accepted.info.output);
  // Remember the artifact on the row right away: a takeover that finds the
  // manifest already stored deletes it.
  await slot.mustSet({ artifactId: accepted.artifactId });
  // A builder that moved on between key and dispatch: store under the key the
  // output was really made with (REV2 2.6).
  let storedKey = buildKey;
  let inputs = row.inputs;
  if (accepted.builderSha !== row.inputs.builder.sha) {
    inputs = {
      ...row.inputs,
      builder: {
        sha: accepted.builderSha,
        workflow: row.inputs.builder.workflow,
        nodeVersion: accepted.builder.nodeVersion,
        cliVersion: accepted.builder.cliVersion,
      },
    };
    storedKey = buildKeyOf(ctx.c.VAULT_KEY, inputs);
  }
  // ---- store -------------------------------------------------------------------------
  let stored = false;
  if (ctx.cache) {
    await slot.mustSet({ status: "storing" });
    try {
      await ctx.cache.store({
        sha,
        buildKey: storedKey,
        srcPath: accepted.tgzPath,
        workDir: dir,
        info: {
          branch: row.branch,
          commit: {
            message: String(row.commit?.headline ?? "").slice(0, 120),
            authorName: String(row.commit?.authorName ?? "").slice(0, 100),
            date: isoOrNull(row.commit?.date),
          },
          settings: { ...BUILD_SETTINGS },
          env: envFingerprints(ctx.c.VAULT_KEY, inputs.env),
          builder: inputs.builder,
          builtAt:
            isoOrNull(accepted.run.updatedAt) ??
            new Date(ctx.now()).toISOString(),
          ...accepted.info,
        },
      });
      stored = true;
    } catch (error) {
      // Not cached: the deploy continues from the local copy and the artifact.
      if (error?.name === "AbortError" || signal.aborted) throw error;
      ctx.log("build-not-cached", {
        id: id8,
        code:
          error instanceof BuildCacheError
            ? error.code
            : String(error?.s3Code ?? error?.code ?? "error").slice(0, 40),
      });
    }
  }
  if (ctx.heartbeat)
    await ctx.heartbeat.recordBuildMs(ctx.now() - startedAt).catch(() => {});
  if (stored) {
    // Row first (ready, naming the stored key), THEN the GitHub artifact: the
    // manifest is the commit point and the row never points at a deleted
    // artifact it still needs.
    await readyRow({
      artifactId: accepted.artifactId,
      storedKey,
      notCached: false,
    });
    await ctx.github.deleteArtifact(accepted.artifactId).catch(() => {});
    if (storedKey === buildKey) await slot.coll.deleteOne(slot.filterOf());
    else await slot.set({ artifactId: null });
  } else {
    await readyRow({
      artifactId: accepted.artifactId,
      storedKey: null,
      notCached: Boolean(ctx.cache),
    });
  }
  ctx.log("build-ready", { id: id8, cached: stored });
}
