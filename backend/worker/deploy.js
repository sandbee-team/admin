// The deploy state machine (rev 1 section 5, rev 2 section 1 row 5):
//   queued -> preflight -> resolve -> build|cache -> fetch -> upload -> vercel
//          -> health -> finalize
// into the CUSTOMER'S OWN Vercel account with the customer's token. Every write
// is fenced on the lease (lease.js); every step is resumable after a takeover
// (a started upload is reconciled through the deployment's meta, never
// repeated blindly). Messages stored on a job are fixed strings; nothing from a
// provider, the CLI or a secret is ever copied into a stored field or a log.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { audit } from "../lib/audit.js";
import { ProviderError } from "../lib/provider-http.js";
import { waitHealthy } from "../lib/pos-health.js";
import { buildInputs, buildKeyOf } from "../lib/build-inputs.js";
import { BuildCacheError } from "../lib/build-cache.js";
import { transaction } from "../db.js";
import {
  CANCELLABLE_STEPS,
  JOB_STEPS,
  MAX_ATTEMPTS,
  buildRowId,
  sha7,
} from "../../shared/deploy.js";
import { key8 } from "../lib/deploy-view.js";
import {
  JobFail,
  LeaseLost,
  Released,
  ensureLive,
  failMessage,
  wait,
  withLease,
} from "./lease.js";
import { AcceptError, extractTgz, inspectTgz } from "./artifact.js";
import { CLI_CODES, cliEnv } from "./cli-runner.js";
import { ensureSpace, fetchBuild, jobDir, rmDir } from "./fetch-build.js";
import {
  COPY_FORWARD_AFTER_MS,
  copyForward,
  touchVersionBuild,
} from "./retention.js";
import {
  WORKER_ACTOR,
  healthFlag,
  inspectProject,
  loadTarget,
  productionOf,
} from "./verify.js";

const MAX_WAITERS = 20;
const META_KEY = "sandbeeRequest";
const vercelUrl = (url) =>
  url ? (/^https?:\/\//.test(url) ? url : `https://${url}`) : "";

// ---- the running job -----------------------------------------------------------
export class JobRun {
  constructor(ctx, claim, signal) {
    this.ctx = ctx;
    this.claim = claim;
    this.slot = claim.slot;
    this.id = claim.installationId;
    this.job = claim.doc;
    this.signal = signal;
    this.names =
      JOB_STEPS[this.job.kind === "rollback" ? "rollback" : "deploy"];
    this.target = null;
    this.vercel = null;
    this.tgz = null;
  }
  get rid() {
    return this.job.requestId;
  }
  get id8() {
    return this.job.requestId.slice(0, 8);
  }
  idx(name) {
    return this.names.indexOf(name);
  }
  isDone(name) {
    const state = this.job.steps?.[this.idx(name)]?.state;
    return state === "done" || state === "skipped";
  }
  // Mirrors a fenced $set into the local copy.
  mirror(fields) {
    for (const [key, value] of Object.entries(fields)) {
      const m = /^steps\.(\d+)\.(\w+)$/.exec(key);
      if (m) {
        this.job.steps ??= [];
        this.job.steps[Number(m[1])] = {
          ...this.job.steps[Number(m[1])],
          [m[2]]: value,
        };
      } else this.job[key] = value;
    }
  }
  async patch(fields, options) {
    await this.slot.mustSet(fields, options);
    this.mirror(fields);
  }
  async reload() {
    const current = await this.slot.read();
    if (!this.slot.mine(current)) throw new LeaseLost();
    this.job = current;
    return current;
  }
  async begin(name, note = "", extra = {}, options) {
    const i = this.idx(name);
    await this.patch(
      {
        step: name,
        [`steps.${i}.state`]: "running",
        [`steps.${i}.startedAt`]: new Date(this.ctx.now()),
        [`steps.${i}.endedAt`]: null,
        [`steps.${i}.note`]: note.slice(0, 120),
        ...extra,
      },
      options,
    );
  }
  async end(name, state = "done", note, extra = {}) {
    const i = this.idx(name);
    await this.patch({
      [`steps.${i}.state`]: state,
      [`steps.${i}.endedAt`]: new Date(this.ctx.now()),
      ...(note === undefined
        ? {}
        : { [`steps.${i}.note`]: note.slice(0, 120) }),
      ...extra,
    });
  }
  async note(name, note) {
    await this.patch({ [`steps.${this.idx(name)}.note`]: note.slice(0, 120) });
  }
  async resetSteps(names) {
    const fields = {};
    for (const name of names) {
      const i = this.idx(name);
      fields[`steps.${i}.state`] = "pending";
      fields[`steps.${i}.startedAt`] = null;
      fields[`steps.${i}.endedAt`] = null;
      fields[`steps.${i}.note`] = "";
    }
    await this.patch(fields);
  }
  async frozen() {
    const row = await this.ctx.coll.state.findOne({ _id: "pos-deploy-freeze" });
    return row?.on === true;
  }
  // Lease still ours? Cancel requested (before upload)? Frozen (deploys only)?
  async check({ cancellable = true } = {}) {
    ensureLive(this.signal);
    const current = await this.reload();
    if (!cancellable) return current;
    if (
      (current.status === "cancelling" || current.cancelRequested) &&
      CANCELLABLE_STEPS.includes(current.step)
    )
      throw new JobFail("cancelled", "Cancelled.", { status: "cancelled" });
    if (
      current.kind !== "rollback" &&
      CANCELLABLE_STEPS.includes(current.step) &&
      (await this.frozen())
    )
      throw new JobFail("frozen", "Deploys are frozen.", {
        status: "cancelled",
      });
    return current;
  }
  cliSignal() {
    return this.ctx.stopState?.kill
      ? AbortSignal.any([this.signal, this.ctx.stopState.kill.signal])
      : this.signal;
  }
}
const fail = (code, message, step) => new JobFail(code, message, { step });
const providerMessage = {
  unauthorized: "Vercel rejected the stored token.",
  forbidden: "Vercel refused the stored token's access.",
  "not-found": "The Vercel project is not visible to this token.",
};

// ---- preflight -----------------------------------------------------------------
export async function preflight(jr) {
  const { ctx, target } = jr;
  await jr.begin("preflight");
  if (target.pos.deployLock !== false)
    throw fail("locked", "Deploys are locked for this client.", "preflight");
  if (
    ["paused", "archived"].includes(target.customerStatus) ||
    target.installationStatus === "retired"
  )
    throw fail(
      "customer-inactive",
      "The customer is paused or archived, or the installation is retired.",
      "preflight",
    );
  const ins = await inspectProject(jr.vercel, target, { signal: jr.signal });
  if (ins.vercel !== "ok")
    throw fail(
      `vercel-${ins.vercel}`.slice(0, 40),
      providerMessage[ins.vercel] ??
        `Vercel could not be reached (${ins.vercel}).`,
      "preflight",
    );
  if (ins.project !== "ok")
    throw fail(
      ins.project === "settings"
        ? "project-settings"
        : `project-${ins.project}`.slice(0, 40),
      failMessage(
        ins.project === "settings"
          ? `Vercel project settings differ: ${ins.names.filter((n) => !/^[A-Z]/.test(n)).join(", ")}`
          : (providerMessage[ins.project] ??
              `The Vercel project could not be read (${ins.project}).`),
      ),
      "preflight",
    );
  if (ins.env !== "ok")
    throw fail(
      ins.env === "drift" || ins.env === "missing"
        ? `env-${ins.env}`
        : `env-${ins.env}`.slice(0, 40),
      failMessage(
        ins.env === "drift" || ins.env === "missing"
          ? `Vercel environment ${ins.env === "drift" ? "differs" : "is missing keys"}: ${ins.names.filter((n) => /^[A-Z]/.test(n)).join(", ")}`
          : `The Vercel environment could not be read (${ins.env}).`,
      ),
      "preflight",
    );
  const production = productionOf(ins.projectData);
  const healthy = production
    ? (await healthFlag(ctx, target, jr.signal)) === "ok"
    : false;
  await jr.patch({ baseline: { vercelDeploymentId: production, healthy } });
  if (jr.job.kind === "rollback") {
    const deploy = target.pos.deploy ?? {};
    if (
      !deploy.previous?.vercelDeploymentId ||
      deploy.previous.vercelDeploymentId !== jr.job.vercelDeploymentId
    )
      throw fail(
        "target-changed",
        "The rollback target changed. Reload and try again.",
        "preflight",
      );
    if (
      deploy.last?.vercelDeploymentId &&
      production !== deploy.last.vercelDeploymentId
    )
      throw fail(
        "production-changed",
        "Production changed outside admin; rollback was not run.",
        "preflight",
      );
  }
  await jr.end("preflight");
}

// ---- resolve --------------------------------------------------------------------
async function resolveStep(jr) {
  const { ctx, target } = jr;
  if (jr.isDone("resolve") && jr.job.buildKey && jr.job.buildInputs) return;
  await jr.begin("resolve");
  const info = await ctx.heartbeat.builderInfo({ fresh: true });
  if (!info.ok || !info.descriptor)
    throw fail(
      "builder-not-ready",
      "The builder is not ready or its CLI version differs.",
      "resolve",
    );
  let inputs;
  try {
    inputs = buildInputs({
      pos: target.pos,
      builderSha: info.sha,
      builder: info.descriptor,
    });
  } catch {
    throw fail(
      "build-inputs",
      "Image or realtime settings cannot be used for a build.",
      "resolve",
    );
  }
  const buildKey = buildKeyOf(ctx.c.VAULT_KEY, inputs);
  await jr.patch({ buildKey, buildInputs: inputs });
  await jr.end("resolve", "done", "");
}

// ---- build (single flight) ------------------------------------------------------
const commitSeed = (jr) => {
  const c = jr.job.commit ?? {};
  const deploy = jr.target.pos.deploy ?? {};
  const known = [deploy.last, deploy.previous].find(
    (v) => v?.sha === jr.job.sha,
  )?.commit;
  const src = c.headline !== undefined ? c : (known ?? {});
  return {
    sha: jr.job.sha,
    branch: jr.job.branch,
    headline: String(src.headline ?? "").slice(0, 120),
    authorName: String(src.authorName ?? "").slice(0, 100),
    date: src.date ?? null,
  };
};
async function ensureRow(jr, rowId) {
  const { ctx, job } = jr;
  const { state } = ctx.coll;
  const row = () => ({
    _id: rowId,
    kind: "build",
    status: "queued",
    sha: job.sha,
    buildKey: job.buildKey,
    inputs: job.buildInputs,
    branch: job.branch,
    commit: commitSeed(jr),
    lease: { owner: null, until: null, fence: 0 },
    attempt: 0,
    runId: null,
    runUrl: null,
    artifactId: null,
    waiters: [jr.rid],
    prepared: null,
    error: null,
    createdAt: new Date(ctx.now()),
    finishedAt: null,
  });
  for (let i = 0; i < 3; i++) {
    try {
      await state.insertOne(row());
      return "created";
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    const existing = await state.findOne({ _id: rowId });
    if (!existing) continue;
    if (["failed", "cancelled"].includes(existing.status)) {
      const reset = await state.replaceOne(
        { _id: rowId, status: existing.status },
        row(),
      );
      if (reset.matchedCount === 1) return "created";
      continue;
    }
    if (
      !existing.waiters?.includes(jr.rid) &&
      (existing.waiters?.length ?? 0) >= MAX_WAITERS
    )
      throw fail(
        "build-busy",
        "Too many deploys are waiting for this build.",
        "build",
      );
    await state.updateOne({ _id: rowId }, { $addToSet: { waiters: jr.rid } });
    return "joined";
  }
  throw fail("build-busy", "The build could not be queued.", "build");
}
export async function dropWaiter(ctx, job) {
  if (!job.buildKey || !job.sha) return;
  await ctx.coll.state
    .updateOne(
      { _id: buildRowId(job.sha, job.buildKey) },
      { $pull: { waiters: job.requestId } },
    )
    .catch(() => undefined);
}
async function buildStep(jr) {
  const { ctx } = jr;
  const cached = Boolean(ctx.cache);
  await jr.begin(
    "build",
    cached ? "Building (not cached yet)" : "Building (cache off)",
  );
  let tries = 0;
  let joined = false;
  for (;;) {
    const rowId = buildRowId(jr.job.sha, jr.job.buildKey);
    const how = await ensureRow(jr, rowId);
    joined = joined || how === "joined";
    if (how === "joined")
      await jr.note("build", "Waiting for a build already running");
    for (;;) {
      await jr.check();
      const row = await ctx.coll.state.findOne({ _id: rowId });
      if (!row) {
        const hit = ctx.cache
          ? await ctx.cache
              .lookup({ sha: jr.job.sha, buildKey: jr.job.buildKey })
              .catch(() => null)
          : null;
        if (hit?.state === "hit") {
          await jr.end("build", "done", "Build ready");
          await jr.patch({ buildSource: "fresh" });
          return;
        }
        if (++tries > 2)
          throw fail(
            "build-vanished",
            "The build disappeared before it finished.",
            "build",
          );
        break; // recreate the row
      }
      if (row.status === "failed")
        throw fail(
          row.error?.code ?? "build-failed",
          failMessage(row.error?.message ?? "The GitHub build failed."),
          "build",
        );
      if (row.status === "cancelled") {
        if (++tries > 2)
          throw fail("build-cancelled", "The build was cancelled.", "build");
        break;
      }
      if (row.runId && row.runId !== jr.job.runId)
        await jr.patch({ runId: row.runId, runUrl: row.runUrl });
      if (row.status === "ready") {
        const storedKey = row.storedKey ?? jr.job.buildKey;
        await jr.end(
          "build",
          "done",
          joined ? "Joined a running build" : "Build ready",
          {
            buildKey: storedKey,
            buildSource: cached && !row.notCached ? "fresh" : "artifact",
          },
        );
        return;
      }
      await wait(ctx, ctx.t.buildWaitMs, jr.signal);
    }
  }
}

// ---- fetch -----------------------------------------------------------------------
async function quarantine(jr, key, reason) {
  const { ctx } = jr;
  await ctx.cache
    .quarantine({ sha: jr.job.sha, buildKey: key })
    .catch(() => undefined);
  await audit(
    ctx.db,
    undefined,
    WORKER_ACTOR,
    "pos.build.integrity-failed",
    "installations",
    jr.id,
    `${sha7(jr.job.sha)} ${key8(key)} ${String(reason).slice(0, 30)}`,
  ).catch(() => undefined);
  await notifyOwner(
    ctx,
    jr,
    "integrity",
    "A cached build failed its integrity check and will be rebuilt.",
  );
  ctx.log("build-integrity-failed", {
    id: jr.id8,
    reason: String(reason).slice(0, 30),
  });
}
// Resolves the build (cache hit or fresh) and fetches a verified tgz.
// -> {path, manifest|null}
export async function acquire(jr) {
  const { ctx } = jr;
  await ensureSpace(ctx);
  let rebuilt = false;
  for (;;) {
    await jr.check();
    let from =
      jr.isDone("build") && jr.job.buildSource ? jr.job.buildSource : null;
    if (!from) {
      let found = null;
      if (ctx.cache)
        try {
          found = await ctx.cache.lookup({
            sha: jr.job.sha,
            buildKey: jr.job.buildKey,
          });
        } catch {
          await jr.note("resolve", "Cache unavailable");
        }
      if (found?.state === "invalid")
        await quarantine(jr, jr.job.buildKey, found.reason);
      if (found?.state === "hit") {
        await jr.begin("build", "Using cached build");
        await jr.end("build", "skipped", "Using cached build", {
          buildSource: "cache",
        });
        from = "cache";
      } else {
        await buildStep(jr);
        from = jr.job.buildSource;
      }
    }
    if (!jr.isDone("fetch")) await jr.begin("fetch");
    const row = await ctx.coll.state.findOne({
      _id: buildRowId(jr.job.sha, jr.job.buildKey),
    });
    const got = await fetchBuild(ctx, {
      sha: jr.job.sha,
      buildKey: jr.job.buildKey,
      row,
      signal: jr.signal,
    });
    if (got.state === "ok") {
      const commit = got.manifest
        ? {
            headline: String(got.manifest.commit?.message ?? "").slice(0, 120),
            authorName: String(got.manifest.commit?.authorName ?? "").slice(
              0,
              100,
            ),
            date: got.manifest.commit?.date ?? null,
          }
        : null;
      await jr.patch({
        build: {
          buildKey: jr.job.buildKey,
          objectKey: got.manifest?.object.key ?? null,
          storedAt: got.manifest?.storedAt ?? null,
          source: from,
          commit,
        },
      });
      if (!jr.isDone("fetch")) await jr.end("fetch", "done");
      return { path: got.path, manifest: got.manifest };
    }
    if (rebuilt)
      throw fail(
        got.state === "invalid" ? "cache-integrity" : "build-gone",
        got.state === "invalid"
          ? "The stored build failed its integrity check twice."
          : "The built output is no longer available.",
        "fetch",
      );
    rebuilt = true;
    if (got.state === "invalid")
      await quarantine(jr, jr.job.buildKey, got.reason);
    // The row of an expired artifact must not satisfy the rebuild.
    if (row?.status === "ready")
      await ctx.coll.state.deleteOne({ _id: row._id, status: "ready" });
    await jr.resetSteps(["build", "fetch"]);
    await jr.patch({ buildSource: null });
  }
}

// ---- upload ----------------------------------------------------------------------
// Extracts the verified tgz into a fresh deploy root and runs the CLI. The
// deployment is then found through the REST API by its meta value (the CLI's
// output is never trusted or stored). -> {id, url}
export async function uploadDeployment(jr, { tgzPath, metaValue }) {
  const { ctx, target } = jr;
  const dir = jobDir(ctx, jr.rid);
  const root = path.join(dir, "root");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const v = await inspectTgz(tgzPath, { signal: jr.signal });
  if (v.bad || v.findings)
    throw fail("tar-invalid", "The build output failed validation.", "upload");
  try {
    await extractTgz(tgzPath, root, { signal: jr.signal });
  } catch (error) {
    if (error instanceof AcceptError)
      throw fail(
        "tar-invalid",
        "The build output failed validation.",
        "upload",
      );
    throw error;
  }
  // D25: an EMPTY apps/cafe in the deploy root; project settings are never changed.
  await mkdir(path.join(root, "apps", "cafe"), { recursive: true });
  await mkdir(path.join(root, ".vercel"), { recursive: true });
  await writeFile(
    path.join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId: target.orgId, projectId: target.projectId }),
  );
  const args = [
    "deploy",
    "--prebuilt",
    "--prod",
    "--skip-domain",
    "--archive=tgz",
    "--yes",
    "--non-interactive",
    "--meta",
    `${META_KEY}=${metaValue}`,
  ];
  if (args.some((arg) => arg.includes(target.token)))
    throw fail(
      "internal",
      "The worker refused an unsafe command line.",
      "upload",
    );
  const env = cliEnv({
    token: target.token,
    orgId: target.orgId,
    projectId: target.projectId,
    workDir: ctx.workDir,
    jobDir: dir,
  });
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.TMPDIR, { recursive: true });
  await mkdir(env.XDG_CACHE_HOME, { recursive: true });
  const result = await ctx.runCli({
    args,
    cwd: root,
    env,
    timeoutMs: ctx.t.cliTimeoutMs,
    signal: jr.cliSignal(),
  });
  ensureLive(jr.signal);
  if (ctx.stopState?.requested && jr.cliSignal().aborted) throw new Released();
  const found = await jr.vercel.findDeploymentByMeta(
    target.projectId,
    META_KEY,
    metaValue,
    {
      attempts: ctx.t.metaAttempts,
      delayMs: ctx.t.metaDelayMs,
      signal: jr.signal,
    },
  );
  await rm(root, { recursive: true, force: true });
  if (!found) {
    const category = result.category;
    if (category)
      throw fail(
        `cli-${category}`.slice(0, 40),
        CLI_CODES[category] ?? CLI_CODES.other,
        "upload",
      );
    throw fail(
      "deployment-not-found",
      "Vercel did not report the new deployment.",
      "upload",
    );
  }
  return { id: found.id, url: vercelUrl(found.url) };
}
async function findUploaded(jr, metaValue) {
  const found = await jr.vercel.findDeploymentByMeta(
    jr.target.projectId,
    META_KEY,
    metaValue,
    {
      attempts: 1,
      delayMs: 0,
      signal: jr.signal,
    },
  );
  return found ? { id: found.id, url: vercelUrl(found.url) } : null;
}
async function uploadStep(jr) {
  const { ctx, job } = jr;
  // Reconcile: a previous owner may have uploaded already.
  if (job.vercelDeploymentId)
    return { id: job.vercelDeploymentId, url: job.url ?? "" };
  if (job.uploadStartedAt) {
    const found = await findUploaded(jr, jr.rid);
    if (found) {
      await jr.patch({ vercelDeploymentId: found.id, url: found.url });
      if (!jr.isDone("upload"))
        await jr.end("upload", "done", "Found the earlier upload");
      return found;
    }
  }
  const build = await acquire(jr);
  await jr.check();
  // The atomic switch into upload: after it the job can no longer be cancelled.
  const i = jr.idx("upload");
  const entered = await jr.slot.set(
    {
      step: "upload",
      [`steps.${i}.state`]: "running",
      [`steps.${i}.startedAt`]: new Date(ctx.now()),
      [`steps.${i}.endedAt`]: null,
      [`steps.${i}.note`]: "",
      uploadStartedAt: job.uploadStartedAt ?? new Date(ctx.now()),
    },
    { when: { status: "running", cancelRequested: { $ne: true } } },
  );
  if (!entered) {
    await jr.reload();
    throw new JobFail("cancelled", "Cancelled.", { status: "cancelled" });
  }
  await jr.reload();
  await ensureSpace(ctx);
  const found = await uploadDeployment(jr, {
    tgzPath: build.path,
    metaValue: jr.rid,
  });
  await jr.patch({ vercelDeploymentId: found.id, url: found.url });
  await jr.end("upload", "done");
  return found;
}

// ---- vercel: ready -> promote -> alias ---------------------------------------------
export async function waitReady(jr, deploymentId) {
  const { ctx } = jr;
  const started = ctx.now();
  for (;;) {
    ensureLive(jr.signal);
    const d = await jr.vercel.deployment(deploymentId, { signal: jr.signal });
    if (d.readyState === "READY") return d;
    if (d.readyState === "ERROR" || d.readyState === "CANCELED")
      throw fail(
        "vercel-build-error",
        "Vercel could not make the deployment ready; production was not changed.",
        "vercel",
      );
    if (ctx.now() - started > ctx.t.vercelReadyMs)
      throw fail(
        "vercel-timeout",
        "Vercel took too long to make the deployment ready.",
        "vercel",
      );
    await wait(ctx, ctx.t.vercelPollMs, jr.signal);
  }
}
export async function awaitAlias(jr, deploymentId) {
  const { ctx } = jr;
  const started = ctx.now();
  for (;;) {
    ensureLive(jr.signal);
    const project = await jr.vercel.project(jr.target.projectId, {
      signal: jr.signal,
    });
    const alias = project.lastAliasRequest;
    if (alias?.toDeploymentId === deploymentId) {
      if (alias.jobStatus === "succeeded") return;
      if (alias.jobStatus === "failed")
        throw fail(
          "alias-failed",
          "Vercel could not point production at the deployment.",
          "vercel",
        );
    }
    if (ctx.now() - started > ctx.t.aliasMs)
      throw fail(
        "alias-timeout",
        "Vercel took too long to switch production.",
        "vercel",
      );
    await wait(ctx, ctx.t.vercelPollMs, jr.signal);
  }
}
async function vercelStep(jr, deployment) {
  await jr.begin("vercel");
  await waitReady(jr, deployment.id);
  const project = await jr.vercel.project(jr.target.projectId, {
    signal: jr.signal,
  });
  const production = productionOf(project);
  if (production !== deployment.id) {
    const baseline = jr.job.baseline?.vercelDeploymentId ?? null;
    if (production !== baseline)
      throw fail(
        "production-changed",
        "Production changed outside admin; the new deployment was not promoted.",
        "vercel",
      );
    try {
      await jr.vercel.promote(jr.target.projectId, deployment.id, {
        signal: jr.signal,
      });
    } catch (error) {
      if (error instanceof ProviderError && !jr.signal.aborted)
        throw fail(
          "promote-failed",
          failMessage(`Vercel did not promote the deployment (${error.code}).`),
          "vercel",
        );
      throw error;
    }
  }
  await awaitAlias(jr, deployment.id);
  await jr.end("vercel", "done");
}

// ---- rollback to a previous deployment (instant, with a cache fallback) -------------
// `version` = the stored version being restored ({sha, build, url}). Returns the
// deployment that is live afterwards: {id, url, via}.
export async function restore(jr, targetId, version) {
  const { ctx, target } = jr;
  try {
    await jr.vercel.rollback(target.projectId, targetId, { signal: jr.signal });
    await awaitAlias(jr, targetId);
    return { id: targetId, url: version?.url ?? "", via: "instant" };
  } catch (error) {
    if (!(error instanceof ProviderError) || jr.signal.aborted) throw error;
    if (error.status === 404 || error.code === "not-found")
      throw fail(
        "rollback-gone",
        "The previous deployment no longer exists; deploy that branch again.",
        "vercel",
      );
    if (error.status !== 402)
      throw fail(
        "rollback-refused",
        "Vercel did not allow this rollback; deploy that branch again.",
        "vercel",
      );
  }
  // Hobby allows only the immediately previous deployment (402): redeploy the
  // previous commit from the cache when its build is still there.
  const keyOfVersion = version?.build?.buildKey;
  if (!ctx.cache || !keyOfVersion || !version?.sha)
    throw fail(
      "rollback-refused",
      "Vercel refused the instant rollback and no cached build is available; deploy that branch again.",
      "vercel",
    );
  const got = await fetchBuild(ctx, {
    sha: version.sha,
    buildKey: keyOfVersion,
    signal: jr.signal,
  });
  if (got.state !== "ok")
    throw fail(
      "rollback-refused",
      "Vercel refused the instant rollback and the previous build is no longer cached; deploy that branch again.",
      "vercel",
    );
  const metaValue = `${jr.rid}-rb`;
  await jr.patch({
    fallbackStartedAt: jr.job.fallbackStartedAt ?? new Date(ctx.now()),
  });
  let dep = await findUploaded(jr, metaValue);
  if (!dep) dep = await uploadDeployment(jr, { tgzPath: got.path, metaValue });
  await waitReady(jr, dep.id);
  const project = await jr.vercel.project(target.projectId, {
    signal: jr.signal,
  });
  if (productionOf(project) !== dep.id)
    await jr.vercel
      .promote(target.projectId, dep.id, { signal: jr.signal })
      .catch((error) => {
        throw error instanceof ProviderError
          ? fail(
              "promote-failed",
              failMessage(
                `Vercel did not promote the deployment (${error.code}).`,
              ),
              "vercel",
            )
          : error;
      });
  await awaitAlias(jr, dep.id);
  return { id: dep.id, url: dep.url, via: "fallback" };
}

// ---- health (and automatic rollback) --------------------------------------------------
export async function probe(jr, attempts) {
  const { ctx, target } = jr;
  return waitHealthy({
    host: target.host,
    tenantId: target.tenantId,
    attempts,
    intervalMs: ctx.t.healthIntervalMs,
    sleep: (ms) => wait(ctx, ms, jr.signal),
    get: ctx.healthGet,
    signal: jr.signal,
  });
}
const reasonNote = (res) =>
  `${res.phase === "login" ? "Login page" : "Health"} check failed`;

// ---- terminal writes -----------------------------------------------------------------
const AUDIT = {
  failed: ["pos.deploy.failed", "pos.rollback.failed"],
  succeeded: ["pos.deploy.succeeded", "pos.rollback.succeeded"],
  "rolled-back": ["pos.deploy.rolled-back", "pos.rollback.failed"],
  unhealthy: ["pos.deploy.unhealthy", "pos.rollback.failed"],
  cancelled: ["pos.deploy.cancelled", "pos.deploy.cancelled"],
};
export const auditFor = (status, kind) =>
  AUDIT[status]?.[kind === "rollback" ? 1 : 0];
const detailOf = (job) =>
  `${job.branch}@${sha7(job.sha)} #${job.requestId.slice(0, 8)}`;
export async function notifyOwner(ctx, jr, status, text) {
  if (!ctx.notify) return;
  try {
    const staff = await ctx.db
      .collection("staff")
      .findOne({ _id: jr.job.by?.id }, { projection: { email: 1 } });
    if (!staff?.email) return;
    await ctx.notify(staff.email, {
      subject: `POS deploy ${status}: ${jr.target?.pos?.slug ?? "installation"}`,
      text: `${jr.target?.pos?.slug ?? ""} (${jr.job.kind}) ${status}. ${text}`.slice(
        0,
        400,
      ),
    });
  } catch {
    // Best effort.
  }
}
// One fenced write for a job that ends without rotating versions.
async function endJob(
  jr,
  { status, error = null, extra = {}, stepFailed = true },
) {
  const { slot, job, ctx } = jr;
  const fields = { status, error, finishedAt: new Date(ctx.now()), ...extra };
  if (stepFailed) {
    const running = (jr.job.steps ?? []).findIndex(
      (s) => s?.state === "running",
    );
    if (running >= 0) {
      fields[`steps.${running}.state`] = "failed";
      fields[`steps.${running}.endedAt`] = new Date(ctx.now());
    }
  }
  await transaction(ctx.client, async (session) => {
    if (!(await slot.set(fields, { session }))) throw new LeaseLost();
    const action = auditFor(status, job.kind);
    if (action)
      await audit(
        ctx.db,
        session,
        WORKER_ACTOR,
        action,
        "installations",
        jr.id,
        detailOf(job),
      );
  });
  jr.mirror(fields);
}
const durationOf = (jr) =>
  Math.max(
    0,
    jr.ctx.now() -
      new Date(
        jr.job.steps?.[0]?.startedAt ?? jr.job.requestedAt ?? jr.ctx.now(),
      ).getTime(),
  );
const commitOf = (jr) => {
  const deploy = jr.target.pos.deploy ?? {};
  const fromJob = jr.job.commit;
  const known = [deploy.last, deploy.previous].find(
    (v) => v?.sha === jr.job.sha,
  )?.commit;
  const fromBuild = jr.job.build?.commit;
  const src =
    fromJob?.headline !== undefined ? fromJob : (known ?? fromBuild ?? {});
  return {
    sha: jr.job.sha,
    branch: jr.job.branch,
    headline: String(src.headline ?? "").slice(0, 120),
    authorName: String(src.authorName ?? "").slice(0, 100),
    date: src.date ?? null,
  };
};
// Copy-forward bookkeeping for the build that is about to be live.
async function liveBuild(jr) {
  const { ctx, job } = jr;
  const b = job.build;
  if (!b) return null;
  let touchedAt = b.storedAt ? new Date(b.storedAt) : new Date(ctx.now());
  if (
    ctx.cache &&
    b.objectKey &&
    ctx.now() - touchedAt.getTime() > COPY_FORWARD_AFTER_MS
  ) {
    const done = await copyForward(ctx, {
      sha: job.sha,
      buildKey: b.buildKey,
      objectKey: b.objectKey,
    });
    if (done === "copied") touchedAt = new Date(ctx.now());
  }
  return {
    buildKey: b.buildKey,
    objectKey: b.objectKey ?? null,
    touchedAt,
    source: b.source ?? "fresh",
  };
}
const preAdmin = (baseline) => ({
  kind: "deploy",
  requestId: "",
  branch: "",
  sha: "",
  at: null,
  by: { id: "", name: "" },
  vercelDeploymentId: baseline.vercelDeploymentId,
  url: "",
  durationMs: 0,
  runUrl: null,
  status: "pre-admin",
  build: null,
  commit: null,
});
// Final write of a deploy that left a NEW deployment live: previous <- last
// (or the pre-admin baseline), last <- the new deployment, cutoverAt on the
// first healthy one. `healthy` false = status unhealthy (job stays in `current`).
export async function finalizeLive(jr, { deployment, healthy, error }) {
  const { ctx, slot, job } = jr;
  const [build, oldLast] = [
    await liveBuild(jr),
    jr.target.pos.deploy?.last ?? null,
  ];
  const previousBuild = oldLast ? await touchVersionBuild(ctx, oldLast) : null;
  const now = new Date(ctx.now());
  const result = {
    kind: job.kind,
    requestId: job.requestId,
    branch: job.branch,
    sha: job.sha,
    at: now,
    by: job.by,
    vercelDeploymentId: deployment.id,
    url: deployment.url,
    durationMs: durationOf(jr),
    runUrl: job.runUrl ?? null,
    status: "succeeded",
    build,
    commit: commitOf(jr),
  };
  const i = jr.idx("finalize");
  await transaction(ctx.client, async (session) => {
    const row = await ctx.coll.installations.findOne(
      { _id: jr.id },
      { session, projection: { pos: 1 } },
    );
    const deploy = row?.pos?.deploy ?? {};
    const previous = deploy.last
      ? { ...deploy.last, build: previousBuild ?? deploy.last.build ?? null }
      : job.baseline?.vercelDeploymentId
        ? preAdmin(job.baseline)
        : (deploy.previous ?? null);
    const set = {
      "pos.deploy.last": result,
      "pos.deploy.previous": previous,
      ...(healthy && !deploy.cutoverAt ? { "pos.deploy.cutoverAt": now } : {}),
      ...(healthy
        ? { "pos.deploy.current": null }
        : {
            ...slot.prefixed({
              status: "unhealthy",
              error,
              finishedAt: now,
              [`steps.${i}.state`]: "done",
              [`steps.${i}.endedAt`]: now,
            }),
          }),
    };
    const done = await ctx.coll.installations.updateOne(
      slot.filterOf(),
      { $set: set },
      { session },
    );
    if (done.matchedCount !== 1) throw new LeaseLost();
    await audit(
      ctx.db,
      session,
      WORKER_ACTOR,
      healthy
        ? auditFor("succeeded", job.kind)
        : auditFor("unhealthy", job.kind),
      "installations",
      jr.id,
      detailOf(job),
    );
  });
}
// Fail handler for a job: maps any error to a stored, fixed-string failure.
export function failureOf(error, step) {
  if (error instanceof JobFail)
    return {
      status: error.status,
      step: error.step ?? step,
      code: error.code,
      message: error.message,
    };
  if (error instanceof AcceptError)
    return {
      status: "failed",
      step,
      code: error.code,
      message: failMessage(
        `The build output was not accepted (${error.code}).`,
      ),
    };
  if (error instanceof ProviderError)
    return {
      status: "failed",
      step,
      code: `${error.provider}-${error.code}`.slice(0, 40),
      message: failMessage(
        `${error.provider === "github" ? "GitHub" : error.provider === "vercel" ? "Vercel" : "Provider"} request failed (${error.code}).`,
      ),
    };
  if (error instanceof BuildCacheError)
    return {
      status: "failed",
      step,
      code: `cache-${error.code}`.slice(0, 40),
      message: failMessage(`The build cache failed (${error.code}).`),
    };
  return {
    status: "failed",
    step,
    code: "internal",
    message: "The worker hit an unexpected error.",
  };
}
export async function failJob(ctx, claim, jr, error) {
  const current = (await claim.slot.read()) ?? {};
  const info = failureOf(error, current.step ?? "queued");
  const run =
    jr ??
    new JobRun(ctx, { ...claim, doc: current }, new AbortController().signal);
  run.job = current;
  const userCancelled =
    info.status === "cancelled" && info.code === "cancelled";
  await endJob(run, {
    status: info.status,
    error: userCancelled
      ? null
      : {
          step: DEPLOY_STEP_NAMES.includes(info.step)
            ? info.step
            : (current.step ?? "queued"),
          code: String(info.code).slice(0, 40),
          message: failMessage(info.message),
        },
  });
  ctx.log("job-ended", {
    id: current.requestId?.slice(0, 8) ?? "",
    status: info.status,
    code: String(info.code).slice(0, 40),
  });
  await dropWaiter(ctx, current);
  if (info.status === "failed")
    await notifyOwner(ctx, run, "failed", info.message);
  await rmDir(jobDir(ctx, claim.doc.requestId));
}
const DEPLOY_STEP_NAMES = [
  "queued",
  "preflight",
  "resolve",
  "build",
  "fetch",
  "upload",
  "vercel",
  "health",
  "finalize",
];

// ---- the deploy / redeploy job ---------------------------------------------------------
export async function runDeploy(ctx, claim) {
  let run = null;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      run = new JobRun(ctx, claim, signal);
      const jr = run;
      if (claim.takeover)
        await audit(
          ctx.db,
          undefined,
          WORKER_ACTOR,
          "pos.deploy.interrupted",
          "installations",
          jr.id,
          `${detailOf(jr.job)} attempt ${jr.job.attempt}`,
        ).catch(() => undefined);
      if (claim.tooManyAttempts || jr.job.attempt > MAX_ATTEMPTS)
        throw new JobFail(
          "worker-stopped",
          "The worker stopped repeatedly during this deploy.",
          { step: jr.job.step },
        );
      jr.target = await loadTarget(ctx, jr.id);
      jr.vercel = ctx.vercelFor({
        token: jr.target.token,
        teamId: jr.target.teamId,
      });
      await jr.check();
      if (!jr.isDone("preflight")) await preflight(jr);
      await jr.check();
      await resolveStep(jr);
      const deployment = await uploadStep(jr);
      if (!jr.isDone("upload")) await jr.end("upload", "done");
      if (!jr.isDone("vercel")) await vercelStep(jr, deployment);
      await jr.reload();
      // ---- health, with automatic rollback --------------------------------------
      await jr.begin("health");
      const res = await probe(jr, ctx.t.healthAttempts);
      ensureLive(signal);
      const finalizeIdx = jr.idx("finalize");
      if (res.ok) {
        // A takeover after an automatic rollback finds a healthy production
        // that is NOT the new deployment: that is the rolled-back outcome.
        const nowLive = productionOf(
          await jr.vercel.project(jr.target.projectId, { signal }),
        );
        if (nowLive !== deployment.id) {
          await jr.end("health", "failed", "Rolled back");
          await jr.begin("finalize");
          await endJob(jr, {
            status: "rolled-back",
            error: {
              step: "health",
              code: "health-failed",
              message:
                "The new version failed its health check; rolled back to the previous version.",
            },
            extra: {
              [`steps.${finalizeIdx}.state`]: "done",
              [`steps.${finalizeIdx}.endedAt`]: new Date(ctx.now()),
            },
            stepFailed: false,
          });
          await rmDir(jobDir(ctx, jr.rid));
          return;
        }
        await jr.end("health", "done");
        await jr.begin("finalize");
        await finalizeLive(jr, { deployment, healthy: true });
        await rmDir(jobDir(ctx, jr.rid));
        return;
      }
      await jr.end("health", "failed", reasonNote(res));
      const baseline = jr.job.baseline;
      const error = {
        step: "health",
        code: "health-failed",
        message: failMessage(
          `${reasonNote(res)} after the new deployment went live.`,
        ),
      };
      let rolledBack = false;
      if (baseline?.vercelDeploymentId && baseline.healthy === true) {
        const project = await jr.vercel.project(jr.target.projectId, {
          signal,
        });
        if (productionOf(project) === deployment.id) {
          await jr.note("health", "Rolling back");
          try {
            const last = jr.target.pos.deploy?.last;
            await restore(
              jr,
              baseline.vercelDeploymentId,
              last?.vercelDeploymentId === baseline.vercelDeploymentId
                ? last
                : null,
            );
            const again = await probe(jr, ctx.t.rollbackHealthAttempts);
            rolledBack = again.ok;
          } catch (caught) {
            if (!(caught instanceof JobFail)) throw caught;
          }
        }
      }
      await jr.begin("finalize");
      if (rolledBack) {
        await endJob(jr, {
          status: "rolled-back",
          error: {
            ...error,
            message: failMessage(
              `${reasonNote(res)}; rolled back to the previous version.`,
            ),
          },
          extra: {
            [`steps.${finalizeIdx}.state`]: "done",
            [`steps.${finalizeIdx}.endedAt`]: new Date(ctx.now()),
          },
          stepFailed: false,
        });
        await notifyOwner(ctx, jr, "rolled back", error.message);
      } else {
        // No rollback happened (baseline unhealthy or missing) or it failed: the
        // new deployment is still live unless a rollback switched production.
        const project = await jr.vercel.project(jr.target.projectId, {
          signal,
        });
        const newIsLive = productionOf(project) === deployment.id;
        if (newIsLive)
          await finalizeLive(jr, { deployment, healthy: false, error });
        else
          await endJob(jr, {
            status: "unhealthy",
            error,
            extra: {
              [`steps.${finalizeIdx}.state`]: "done",
              [`steps.${finalizeIdx}.endedAt`]: new Date(ctx.now()),
            },
            stepFailed: false,
          });
        await notifyOwner(ctx, jr, "unhealthy", error.message);
      }
      await rmDir(jobDir(ctx, jr.rid));
    },
    (error) => failJob(ctx, claim, run, error),
  );
}
