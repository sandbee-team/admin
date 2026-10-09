// Manual rollback (kind "rollback", deploy lane): point production at the
// stored `previous` deployment (Vercel instant rollback; on the Hobby limit
// (402) redeploy the previous commit from the build cache), check health, then
// swap last <-> previous in one fenced transaction.
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";
import { MAX_ATTEMPTS, sha7 } from "../../shared/deploy.js";
import {
  JobFail,
  LeaseLost,
  ensureLive,
  failMessage,
  withLease,
} from "./lease.js";
import { jobDir, rmDir } from "./fetch-build.js";
import { touchVersionBuild } from "./retention.js";
import { WORKER_ACTOR, loadTarget, productionOf } from "./verify.js";
import {
  JobRun,
  auditFor,
  failJob,
  notifyOwner,
  preflight,
  probe,
  restore,
} from "./deploy.js";

const detailOf = (job) =>
  `${job.branch}@${sha7(job.sha)} #${job.requestId.slice(0, 8)}`;
export async function runRollback(ctx, claim) {
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
          "The worker stopped repeatedly during this rollback.",
          { step: jr.job.step },
        );
      jr.target = await loadTarget(ctx, jr.id);
      jr.vercel = ctx.vercelFor({
        token: jr.target.token,
        teamId: jr.target.teamId,
      });
      await jr.check();
      if (!jr.isDone("preflight")) await preflight(jr);
      const deploy = jr.target.pos.deploy ?? {};
      const previous = deploy.previous;
      let live;
      if (jr.isDone("vercel")) {
        live = {
          id: jr.job.vercelDeploymentId,
          url: jr.job.url ?? previous?.url ?? "",
        };
      } else {
        await jr.begin("vercel");
        // Already switched by an earlier owner? Then only the alias is left.
        const project = await jr.vercel.project(jr.target.projectId, {
          signal,
        });
        const target = jr.job.vercelDeploymentId;
        if (productionOf(project) === target)
          live = { id: target, url: previous?.url ?? "", via: "instant" };
        else live = await restore(jr, target, previous);
        await jr.end(
          "vercel",
          "done",
          live.via === "fallback" ? "Redeployed from the cache" : "",
          {
            vercelDeploymentId: live.id,
            url: live.url,
          },
        );
      }
      ensureLive(signal);
      await jr.begin("health");
      const res = await probe(jr, ctx.t.healthAttempts);
      ensureLive(signal);
      const healthy = res.ok;
      await jr.end(
        "health",
        healthy ? "done" : "failed",
        healthy ? "" : "Health check failed",
      );
      await jr.begin("finalize");
      await finalizeRollback(jr, { live, previous, healthy, res });
      if (!healthy)
        await notifyOwner(
          ctx,
          jr,
          "unhealthy",
          "The rolled-back version is not healthy.",
        );
      await rmDir(jobDir(ctx, jr.rid));
    },
    (error) => failJob(ctx, claim, run, error),
  );
}
async function finalizeRollback(jr, { live, previous, healthy, res }) {
  const { ctx, slot, job } = jr;
  const oldLast = jr.target.pos.deploy?.last ?? null;
  const newLastBuild = previous ? await touchVersionBuild(ctx, previous) : null;
  const oldLastBuild = oldLast ? await touchVersionBuild(ctx, oldLast) : null;
  const now = new Date(ctx.now());
  const i = jr.idx("finalize");
  const error = healthy
    ? null
    : {
        step: "health",
        code: "health-failed",
        message: failMessage(
          `${res.phase === "login" ? "Login page" : "Health"} check failed after the rollback.`,
        ),
      };
  await transaction(ctx.client, async (session) => {
    const row = await ctx.coll.installations.findOne(
      { _id: jr.id },
      { session, projection: { pos: 1 } },
    );
    const deploy = row?.pos?.deploy ?? {};
    const base = deploy.previous ?? previous;
    const newLast = {
      ...base,
      kind: "rollback",
      requestId: job.requestId,
      at: now,
      by: job.by,
      vercelDeploymentId: live.id,
      url: live.url || base?.url || "",
      durationMs: Math.max(
        0,
        ctx.now() -
          new Date(job.steps?.[0]?.startedAt ?? job.requestedAt).getTime(),
      ),
      runUrl: null,
      status: "rolled-back-to",
      build: newLastBuild ?? base?.build ?? null,
    };
    const newPrevious = deploy.last
      ? { ...deploy.last, build: oldLastBuild ?? deploy.last.build ?? null }
      : (deploy.previous ?? null);
    const set = {
      "pos.deploy.last": newLast,
      "pos.deploy.previous": newPrevious,
      ...(healthy
        ? { "pos.deploy.current": null }
        : slot.prefixed({
            status: "unhealthy",
            error,
            finishedAt: now,
            [`steps.${i}.state`]: "done",
            [`steps.${i}.endedAt`]: now,
          })),
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
        ? auditFor("succeeded", "rollback")
        : auditFor("unhealthy", "rollback"),
      "installations",
      jr.id,
      detailOf(job),
    );
  });
}
