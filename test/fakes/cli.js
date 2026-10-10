// Scripted stand-in for the CLI runner seam (backend/worker/cli-runner.js
// runCli). It records every call (argv, env, cwd and a listing of the deploy
// root at call time), never spawns anything, and lets a test script the
// result: succeed (optionally creating the deployment through `onRun`), fail
// with a category, or hang until released/aborted.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const listing = (root) => {
  const out = [];
  const walk = (dir, rel) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      out.push(info.isDirectory() ? `${r}/` : r);
      if (info.isDirectory() && out.length < 200) walk(full, r);
    }
  };
  walk(root, "");
  return out;
};
export function createFakeCli({ onRun } = {}) {
  const calls = [];
  const queue = [];
  const ok = (extra = {}) => ({
    code: 0,
    category: null,
    timedOut: false,
    aborted: false,
    stdout: "https://example-abc123.vercel.app\n",
    ...extra,
  });
  async function runCli(options) {
    const call = {
      args: [...options.args],
      env: { ...options.env },
      cwd: options.cwd,
      listing: options.cwd ? listing(options.cwd) : [],
      timeoutMs: options.timeoutMs,
      user: options.user ?? null,
    };
    calls.push(call);
    const next = queue.shift() ?? { kind: "ok" };
    if (next.before) await next.before(call);
    if (next.kind === "hang") {
      await onRun?.(call);
      next.started?.(call);
      return new Promise((resolve) => {
        next.release = (value) => resolve(value ?? ok());
        options.signal?.addEventListener("abort", () =>
          resolve({
            code: -1,
            category: "other",
            timedOut: false,
            aborted: true,
            stdout: "",
          }),
        );
      });
    }
    if (next.kind === "fail")
      return {
        code: 1,
        category: next.category ?? "other",
        timedOut: false,
        aborted: false,
        stdout: "",
      };
    await onRun?.(call);
    return ok();
  }
  return {
    runCli,
    calls,
    // The next call behaves as scripted: {kind:"ok"|"fail"|"hang", category, before, started}.
    next(behavior) {
      queue.push(behavior);
      return behavior;
    },
    clear() {
      calls.length = 0;
      queue.length = 0;
    },
  };
}
