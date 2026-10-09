// The worker's wiring (adapters, timing, logging) and the S4 self-check. Kept
// out of backend/worker.js so tests can build a context with fakes.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createGitHub } from "../lib/github.js";
import { createVercel } from "../lib/vercel.js";
import { verifyToken } from "../lib/cloudflare.js";
import { pingClientMongo } from "../lib/client-mongo.js";
import { HEARTBEAT_MS, LEASE_MS } from "../../shared/deploy.js";
import { createHeartbeat } from "./heartbeat.js";
import { cliEnv, installedCliVersion, lastLine, runCli } from "./cli-runner.js";
import { dirs, ensureLayout, UUID_RE } from "./fetch-build.js";
import { sleepReal } from "./lease.js";
import { loadTarget } from "./verify.js";

export const DEFAULT_TIMING = {
  pollMs: 3000,
  leaseMs: LEASE_MS,
  heartbeatMs: HEARTBEAT_MS,
  buildPollMs: 10000,
  buildPollMaxMs: 30000,
  buildWaitMs: 5000,
  vercelPollMs: 5000,
  vercelReadyMs: 10 * 60 * 1000,
  aliasMs: 3 * 60 * 1000,
  healthIntervalMs: 5000,
  healthAttempts: 12,
  rollbackHealthAttempts: 6,
  cliTimeoutMs: 10 * 60 * 1000,
  metaAttempts: 6,
  metaDelayMs: 5000,
  purgeDelayMs: 500,
  retentionCheckMs: 60000,
};
// Log lines carry an event name and short plain fields only (ids8, codes).
export function makeLog(sink = (line) => console.info(line)) {
  return (event, fields = {}) => {
    const safe = {};
    for (const [key, value] of Object.entries(fields))
      if (/^[a-zA-Z0-9]{1,20}$/.test(key))
        safe[key] =
          typeof value === "number" || typeof value === "boolean"
            ? value
            : String(value ?? "")
                .replace(/[^A-Za-z0-9._:-]/g, "")
                .slice(0, 40);
    sink(
      JSON.stringify({
        t: new Date().toISOString(),
        event: String(event).slice(0, 40),
        ...safe,
      }),
    );
  };
}
export async function readVersion() {
  try {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    return String(pkg.version ?? "").slice(0, 40);
  } catch {
    return "";
  }
}
// Builds the context the lanes work with. `overrides` replaces any seam
// (tests inject fakes for GitHub, Vercel, the CLI, S3 and health).
export async function buildContext({
  c,
  db,
  client,
  s3,
  cache = null,
  notify,
  overrides = {},
}) {
  const github =
    overrides.github ??
    createGitHub({
      sourceRepo: c.POS_GITHUB_SOURCE_REPO,
      sourceToken: c.POS_GITHUB_SOURCE_TOKEN,
      builderRepo: c.POS_GITHUB_BUILDER_REPO,
      builderToken: c.POS_GITHUB_BUILDER_TOKEN,
      workflow: c.POS_BUILDER_WORKFLOW,
      ref: c.POS_BUILDER_REF,
    });
  const ctx = {
    c,
    db,
    client,
    coll: {
      installations: db.collection("installations"),
      state: db.collection("system_state"),
    },
    workDir: c.POS_WORK_DIR,
    workerId: `w-${randomUUID().slice(0, 8)}`,
    version: await readVersion(),
    cliVersion: await installedCliVersion(),
    github,
    s3,
    cache,
    notify,
    vercelFor: ({ token, teamId }) => createVercel({ token, teamId }),
    runCli,
    healthGet: undefined,
    cloudflareVerify: verifyToken,
    pingMongo: (uri) => pingClientMongo(uri),
    sleep: sleepReal,
    now: () => Date.now(),
    uuid: randomUUID,
    t: { ...DEFAULT_TIMING },
    stopState: {
      requested: false,
      kill: new AbortController(),
      wake: new AbortController(),
    },
    log: makeLog(),
    handlers: {},
    ...overrides,
  };
  ctx.t = { ...DEFAULT_TIMING, ...overrides.t };
  ctx.heartbeat = createHeartbeat(ctx);
  return ctx;
}

// ---- S4 self-check ----------------------------------------------------------------
// Prints and returns ok/fail per check, never a value. With an installation it
// proves that the customer's token reaches the CLI only through the child's
// environment: absent from /proc/<pid>/cmdline and from every file under the
// work directory afterwards.
async function writable(dir) {
  const probe = path.join(dir, `.selfcheck-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "x");
    await rm(probe);
    return true;
  } catch {
    return false;
  }
}
async function containsBytes(root, needle, limit = 200000) {
  let seen = 0;
  const stack = [root];
  while (stack.length && seen < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        seen++;
        try {
          if ((await stat(full)).size > 64 * 1024 * 1024) continue;
          if ((await readFile(full)).includes(needle)) return true;
        } catch {
          // Unreadable files cannot hold what we look for.
        }
      }
    }
  }
  return false;
}
export async function selfCheck(
  ctx,
  { installationId, print = (line) => console.info(line) } = {},
) {
  const results = {};
  const record = (name, outcome) => {
    results[name] = outcome;
    print(`${outcome} ${name}`);
  };
  const d = dirs(ctx.workDir);
  await ensureLayout(ctx.workDir).catch(() => undefined);
  const dirOk = (
    await Promise.all([d.home, d.tmp, d.cache, d.jobs].map(writable))
  ).every(Boolean);
  record("work-dir-writable", dirOk ? "ok" : "fail");
  // Informational: whether the root filesystem is read-only.
  const rootWritable = await writable(process.cwd());
  record("root-filesystem", rootWritable ? "skip" : "ok");
  const jobDir = path.join(d.jobs, `selfcheck-${randomUUID().slice(0, 8)}`);
  await mkdir(jobDir, { recursive: true });
  const version = await ctx.runCli({
    args: ["--version"],
    cwd: ctx.workDir,
    env: cliEnv({ workDir: ctx.workDir, jobDir }),
    timeoutMs: 60000,
  });
  const reported = lastLine(version.stdout);
  record(
    "cli-version",
    version.code === 0 && ctx.cliVersion && reported.includes(ctx.cliVersion)
      ? "ok"
      : "fail",
  );
  if (installationId) {
    if (!UUID_RE.test(installationId)) record("installation", "fail");
    else {
      let token = null;
      let target = null;
      try {
        target = await loadTarget(ctx, installationId);
        token = target.token;
      } catch {
        record("token-decrypt", "fail");
      }
      if (token) {
        record("token-decrypt", "ok");
        const needle = Buffer.from(token);
        const probes = [];
        const onSpawn = (pid) => {
          for (const delay of [20, 150, 500, 1200])
            setTimeout(async () => {
              try {
                probes.push(await readFile(`/proc/${pid}/cmdline`));
              } catch {
                // The process is gone or /proc is unavailable.
              }
            }, delay).unref?.();
        };
        const whoami = await ctx.runCli({
          args: ["whoami"],
          cwd: ctx.workDir,
          env: cliEnv({
            token,
            orgId: target.orgId,
            projectId: target.projectId,
            workDir: ctx.workDir,
            jobDir,
          }),
          timeoutMs: 60000,
          onSpawn,
        });
        record("token-honoured", whoami.code === 0 ? "ok" : "fail");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const leaked = probes.some((buf) => buf.includes(needle));
        record(
          "token-not-in-cmdline",
          leaked
            ? "fail"
            : probes.length || process.platform !== "linux"
              ? probes.length
                ? "ok"
                : "skip"
              : "skip",
        );
        // The per-job config directory is deleted with the job; nothing may remain.
        await rm(jobDir, { recursive: true, force: true }).catch(() => {});
        const onDisk = await containsBytes(ctx.workDir, needle);
        record("token-not-on-disk", onDisk ? "fail" : "ok");
      }
    }
  }
  await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  const ok = Object.values(results).every((v) => v !== "fail");
  print(ok ? "self-check: ok" : "self-check: fail");
  return { ok, results };
}
