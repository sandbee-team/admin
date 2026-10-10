// The worker's own heartbeat: system_state row "pos-worker" (the panel shows
// "online" when it is under 90 s old) plus a file on the work volume for the
// container health check. The builder descriptor is re-read every 5 minutes.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBuilderJson } from "../lib/build-inputs.js";

export const BUILDER_CHECK_EVERY_MS = 5 * 60 * 1000;
export function createHeartbeat(ctx) {
  const state = { builder: null, timer: null };
  // {sha, descriptor, ok, checkedAt (ms)}. Never throws.
  async function refreshBuilder() {
    const at = ctx.now();
    if (!ctx.github?.configured().builder) {
      state.builder = { sha: "", descriptor: null, ok: false, checkedAt: at };
      return state.builder;
    }
    try {
      const head = await ctx.github.builderHead();
      const descriptor = parseBuilderJson(
        await ctx.github.builderFile(head.sha),
      );
      state.builder = {
        sha: head.sha,
        descriptor,
        // The worker's CLI must be exactly the builder's (the readiness rule).
        ok: descriptor.cliVersion === ctx.cliVersion,
        checkedAt: at,
      };
    } catch {
      state.builder = { sha: "", descriptor: null, ok: false, checkedAt: at };
    }
    return state.builder;
  }
  // The builder info a deploy resolves against (re-read when stale).
  async function builderInfo({ fresh = false } = {}) {
    const info = state.builder;
    if (fresh || !info || ctx.now() - info.checkedAt > BUILDER_CHECK_EVERY_MS)
      return refreshBuilder();
    return info;
  }
  async function beat() {
    const builder = await builderInfo();
    const at = new Date(ctx.now());
    await ctx.coll.state.updateOne(
      { _id: "pos-worker" },
      {
        $set: {
          at,
          workerId: ctx.workerId,
          version: ctx.version,
          cliVersion: ctx.cliVersion,
          builderConfigured: Boolean(ctx.github?.configured().builder),
          builder: {
            sha: builder.sha,
            protocol: builder.descriptor?.protocol ?? 0,
            nodeVersion: builder.descriptor?.nodeVersion ?? "",
            cliVersion: builder.descriptor?.cliVersion ?? "",
            ok: builder.ok,
            checkedAt: new Date(builder.checkedAt),
          },
        },
      },
      { upsert: true },
    );
    try {
      await mkdir(ctx.workDir, { recursive: true });
      await writeFile(path.join(ctx.workDir, "heartbeat"), String(Date.now()));
    } catch {
      // The health file is best effort.
    }
  }
  async function recordBuildMs(ms) {
    await ctx.coll.state.updateOne(
      { _id: "pos-worker" },
      { $set: { lastBuildMs: Math.max(0, Math.round(ms)) } },
      { upsert: true },
    );
  }
  return {
    refreshBuilder,
    builderInfo,
    beat,
    recordBuildMs,
    start() {
      state.timer = setInterval(
        () => beat().catch(() => undefined),
        ctx.t.heartbeatMs,
      );
      state.timer.unref?.();
    },
    stop() {
      clearInterval(state.timer);
    },
  };
}
