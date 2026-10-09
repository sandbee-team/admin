// Purge of old SOURCE deployments in the customer's Vercel project: a preview
// task lists what would go; the execute task deletes exactly the ids the owner
// saw (bound by a digest), one at a time, and never touches the live
// production deployment, `last`, `previous`, a prebuilt deployment or anything
// created since the cutover.
import { audit } from "../lib/audit.js";
import { purgeDigest } from "../lib/deploy-view.js";
import { ProviderError } from "../lib/provider-http.js";
import { transaction } from "../db.js";
import { JobFail, LeaseLost, ensureLive, withLease, wait } from "./lease.js";
import { WORKER_ACTOR, failTask, loadTarget, productionOf } from "./verify.js";

const MAX_CANDIDATES = 200;
const when = (value) => {
  const d = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
// -> {keep:Set<id>, candidates:[deployment]}; newest first as listed.
export async function classify(ctx, claim, target, vercel, signal) {
  const deploy = target.pos.deploy ?? {};
  const cutover = when(deploy.cutoverAt);
  if (!cutover)
    throw new JobFail(
      "no-cutover",
      "Purge is available after the first verified admin deploy.",
    );
  const project = await vercel.project(target.projectId, { signal });
  const production = productionOf(project);
  const keep = new Set(
    [
      production,
      project.productionDeploymentId,
      deploy.last?.vercelDeploymentId,
      deploy.previous?.vercelDeploymentId,
    ].filter(Boolean),
  );
  const list = await vercel.listDeployments(target.projectId, {
    max: 500,
    signal,
  });
  const candidates = [];
  let kept = 0;
  for (const d of list) {
    const created = Number.isFinite(d.createdAt) ? d.createdAt : null;
    const protectedId =
      keep.has(d.id) ||
      d.prebuilt === true ||
      created === null ||
      created >= cutover.getTime();
    if (protectedId) kept++;
    else candidates.push(d);
  }
  return { keep, candidates, kept };
}
export async function runPurgePreview(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const target = await loadTarget(ctx, claim.installationId);
      const vercel = ctx.vercelFor({
        token: target.token,
        teamId: target.teamId,
      });
      await slot.mustSet({ step: "list" });
      const { candidates, kept } = await classify(
        ctx,
        claim,
        target,
        vercel,
        signal,
      );
      const result = {
        at: new Date(ctx.now()),
        candidates: candidates.slice(0, MAX_CANDIDATES).map((d) => ({
          id: d.id,
          createdAt: new Date(d.createdAt),
          target: d.target ?? "",
          state: d.readyState,
        })),
        total: candidates.length,
        keep: kept,
      };
      await slot.mustSet({
        status: "succeeded",
        step: "done",
        result,
        finishedAt: new Date(ctx.now()),
        error: null,
      });
    },
    (error) => failTask(ctx, claim, error),
  );
}
export async function runPurge(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const params = claim.doc.params ?? {};
      const ids = Array.isArray(params.ids) ? params.ids : [];
      // The ids must hash to the digest the owner confirmed.
      if (!ids.length || purgeDigest(ids) !== params.digest)
        throw new JobFail(
          "digest-mismatch",
          "The purge list does not match what was confirmed.",
        );
      const target = await loadTarget(ctx, claim.installationId);
      const vercel = ctx.vercelFor({
        token: target.token,
        teamId: target.teamId,
      });
      await slot.mustSet({
        step: "list",
        progress: { done: 0, total: ids.length },
      });
      const { keep, candidates } = await classify(
        ctx,
        claim,
        target,
        vercel,
        signal,
      );
      const allowed = new Set(candidates.map((d) => d.id));
      let deleted = 0,
        skipped = 0,
        failed = 0;
      for (const id of ids) {
        ensureLive(signal);
        // Re-checked per id: never the live, last or previous deployment.
        if (keep.has(id) || !allowed.has(id)) {
          skipped++;
          continue;
        }
        try {
          await vercel.deleteDeployment(id, { signal });
          deleted++;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          if (signal.aborted) throw signal.reason;
          failed++;
        }
        if ((deleted + failed) % 10 === 0)
          await slot.mustSet({
            progress: { done: deleted + skipped + failed, total: ids.length },
          });
        await wait(ctx, ctx.t.purgeDelayMs, signal);
      }
      const now = new Date(ctx.now());
      await transaction(ctx.client, async (session) => {
        const done = await ctx.coll.installations.updateOne(
          slot.filterOf(),
          {
            $set: slot.prefixed({
              status: failed ? "failed" : "succeeded",
              step: "done",
              finishedAt: now,
              result: { deleted, skipped, failed },
              progress: { done: ids.length, total: ids.length },
              error: failed
                ? {
                    code: "delete-failed",
                    message: "Some deployments could not be deleted.",
                  }
                : null,
            }),
          },
          { session },
        );
        if (done.matchedCount !== 1) throw new LeaseLost();
        await audit(
          ctx.db,
          session,
          WORKER_ACTOR,
          "pos.purge.completed",
          "installations",
          claim.installationId,
          `${deleted} deleted ${skipped} skipped ${failed} failed`,
        );
      });
    },
    (error) => failTask(ctx, claim, error),
  );
}
