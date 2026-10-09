// The worker loop: three lanes (deploy 1 = deploys and rollbacks, which also
// serialises per Vercel account; build 2; task 1), a poll every few seconds, the
// daily retention sweep, boot clean-up and a graceful stop.
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ACTIVE_STATES } from "../../shared/deploy.js";
import {
  createSlot,
  claimBuild,
  claimDeploy,
  claimTask,
  failMessage,
  withLease,
} from "./lease.js";
import { runBuildLane } from "./build.js";
import { runDeploy } from "./deploy.js";
import { runRollback } from "./rollback.js";
import { failTask, runVerify } from "./verify.js";
import { runPurge, runPurgePreview } from "./purge.js";
import { claimRetention, runRetention } from "./retention.js";
import { dirs, ensureLayout, pruneBuilds } from "./fetch-build.js";

export const LANES = { deploy: 1, build: 2, task: 1 };
export function createLoop(ctx) {
  const lanes = Object.fromEntries(
    Object.entries(LANES).map(([name, cap]) => [
      name,
      { cap, running: new Set() },
    ]),
  );
  const state = { retentionCheckedAt: 0 };
  const handlers = {
    verify: runVerify,
    "purge-preview": runPurgePreview,
    purge: runPurge,
    ...ctx.handlers,
  };
  function start(lane, promise) {
    const tracked = promise
      .catch((error) =>
        ctx.log("runner-error", {
          code: String(error?.code ?? error?.name ?? "error").slice(0, 40),
        }),
      )
      .finally(() => lanes[lane].running.delete(tracked));
    lanes[lane].running.add(tracked);
  }
  const free = (lane) => lanes[lane].running.size < lanes[lane].cap;
  const runTask = (claim) => {
    if (claim.tooManyAttempts)
      return failTask(
        ctx,
        claim,
        Object.assign(new Error("x"), { code: "worker-stopped" }),
      ).catch(() => undefined);
    const handler = handlers[claim.doc.kind];
    if (!handler)
      return claim.slot
        .set({
          status: "failed",
          finishedAt: new Date(ctx.now()),
          error: {
            code: "unsupported",
            message: failMessage(
              "This task is not available in this worker version.",
            ),
          },
        })
        .catch(() => undefined);
    return handler(ctx, claim);
  };
  async function runRetentionClaim(row) {
    const slot = createSlot(ctx, {
      coll: ctx.coll.state,
      match: { _id: "pos-retention" },
      path: "",
      idField: "_id",
      idValue: "pos-retention",
      owner: ctx.workerId,
      fence: row.lease.fence,
    });
    await withLease(
      ctx,
      { slot, doc: row, takeover: false },
      async (signal) => {
        const result = await runRetention(ctx, { signal });
        await slot.mustSet({ status: "idle", at: new Date(ctx.now()), result });
      },
      async () => {
        await slot.set({
          status: "idle",
          at: new Date(ctx.now()),
          result: { failed: 1 },
        });
      },
    );
  }
  // One scheduling pass. -> number of jobs started.
  async function tick() {
    if (ctx.stopState?.requested) return 0;
    let started = 0;
    const freeze = await ctx.coll.state.findOne({ _id: "pos-deploy-freeze" });
    const frozen = freeze?.on === true;
    while (free("deploy")) {
      const claim = await claimDeploy(ctx, { frozen });
      if (!claim) break;
      started++;
      start(
        "deploy",
        (claim.doc.kind === "rollback" ? runRollback : runDeploy)(ctx, claim),
      );
    }
    while (free("build")) {
      const claim = await claimBuild(ctx);
      if (!claim) break;
      started++;
      start("build", runBuildLane(ctx, claim));
    }
    while (free("task")) {
      const claim = await claimTask(ctx);
      if (!claim) break;
      started++;
      start("task", runTask(claim));
    }
    if (
      free("task") &&
      ctx.now() - state.retentionCheckedAt > ctx.t.retentionCheckMs
    ) {
      state.retentionCheckedAt = ctx.now();
      const row = await claimRetention(ctx);
      if (row) {
        started++;
        start("task", runRetentionClaim(row));
      }
    }
    return started;
  }
  const running = () =>
    Object.values(lanes).flatMap((lane) => [...lane.running]);
  // Boot clean-up: scratch space, orphaned job directories, old builds.
  async function boot() {
    await ensureLayout(ctx.workDir);
    const d = dirs(ctx.workDir);
    await rm(d.tmp, { recursive: true, force: true }).catch(() => {});
    await ensureLayout(ctx.workDir);
    let names = [];
    try {
      names = await readdir(d.jobs);
    } catch {
      names = [];
    }
    if (names.length) {
      const live = await ctx.coll.installations
        .find(
          {
            "pos.deploy.current.requestId": { $in: names },
            "pos.deploy.current.status": { $in: ACTIVE_STATES },
          },
          {
            projection: {
              "pos.deploy.current.requestId": 1,
              "pos.deploy.current.lease.until": 1,
            },
          },
        )
        .toArray();
      const keep = new Set(
        live
          .filter(
            (row) =>
              new Date(row.pos.deploy.current.lease?.until ?? 0).getTime() >
              ctx.now(),
          )
          .map((row) => row.pos.deploy.current.requestId),
      );
      for (const name of names)
        if (!keep.has(name))
          await rm(path.join(d.jobs, name), {
            recursive: true,
            force: true,
          }).catch(() => {});
    }
    await pruneBuilds(ctx);
    if (ctx.heartbeat) {
      await ctx.heartbeat.refreshBuilder();
      await ctx.heartbeat.beat();
      ctx.heartbeat.start();
    }
  }
  return {
    lanes,
    tick,
    boot,
    running,
    // Runs until nothing is claimable and nothing is running (tests, drills).
    async drain({ maxPasses = 100000 } = {}) {
      for (let pass = 0; pass < maxPasses; pass++) {
        const started = await tick();
        const all = running();
        if (!started && !all.length) return;
        if (all.length) await Promise.race([...all, ctx.sleep(ctx.t.pollMs)]);
      }
      throw new Error("drain did not settle");
    },
    async run() {
      await boot();
      while (!ctx.stopState.requested) {
        try {
          await tick();
        } catch (error) {
          ctx.log("tick-failed", {
            code: String(error?.code ?? error?.name ?? "error").slice(0, 40),
          });
        }
        await ctx.sleep(ctx.t.pollMs, ctx.stopState.wake.signal);
      }
    },
    // Graceful stop: stop claiming; waiting jobs release their lease; a running
    // CLI gets `cliGraceMs`, then it is killed and the next worker reconciles.
    async stop({ cliGraceMs = 120000, totalMs = 140000 } = {}) {
      ctx.stopState.requested = true;
      ctx.stopState.wake.abort();
      const killTimer = setTimeout(
        () => ctx.stopState.kill.abort(),
        cliGraceMs,
      );
      killTimer.unref?.();
      const deadline = new Promise((resolve) => {
        const t = setTimeout(resolve, totalMs);
        t.unref?.();
      });
      await Promise.race([Promise.allSettled(running()), deadline]);
      clearTimeout(killTimer);
      ctx.heartbeat?.stop();
    },
  };
}
