// The worker's wiring (adapters, timing, logging) and the S4 self-check. Kept
// out of backend/worker.js so tests can build a context with fakes.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { runDbBackup } from "./db-backup.js";
import { createHeartbeat } from "./heartbeat.js";
import {
  cliEnv,
  installedCliVersion,
  lastLine,
  prepareCliDir,
  prepareDeployRoot,
  removeJobDir,
  runCli,
} from "./cli-runner.js";
import { dirs, ensureLayout, UUID_RE } from "./fetch-build.js";
import { sleepReal } from "./lease.js";
import { loadTarget } from "./verify.js";

export const CLI_UID = 10001;
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
  getuid = () => process.getuid?.(),
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
    // The uid the Vercel CLI runs as (only when the worker itself is root).
    cliUser: getuid() === 0 ? { uid: CLI_UID, gid: CLI_UID } : null,
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
    handlers: { "db-backup": runDbBackup },
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
  let seen = 0,
    unchecked = 0;
  const stack = [root];
  while (stack.length && seen < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unchecked++; // a directory we could not list
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        seen++;
        try {
          if ((await stat(full)).size > 64 * 1024 * 1024) {
            unchecked++;
            continue;
          }
          if ((await readFile(full)).includes(needle))
            return { found: true, unchecked };
        } catch {
          unchecked++; // reported, never silently skipped
        }
      }
    }
  }
  return { found: false, unchecked: unchecked + (stack.length ? 1 : 0) };
}
// Runs a tiny node probe as the CLI's uid. Sub-checks, each with a fixed,
// value-free reason code when it fails:
//   spawn-failed-<errno>        the probe could not be started (uid switch refused, no exec)
//   probe-exit-<status>         the probe crashed
//   probe-bad-output            unexpected probe output
//   not-dropped-uid             the probe still runs as another uid than the CLI's
//   proc1-readable              /proc/1/environ could be read (real isolation failure)
//   proc1-unexpected-<errno>    anything but EACCES/EPERM/ENOENT (hidepid) for it
//   worker-environ-readable     /proc/<worker pid>/environ could be read (real failure)
//   worker-environ-unexpected-<errno>
//   home-path-blocked-at-<n>    a directory on the way to the CLI's HOME is not traversable
//   home-not-writable-<errno>   the CLI's HOME cannot be written
// -> "ok" | "skip" | "fail:<reason>" (a worker that is not root: skip, but in
// production it must fail, as the CLI would run as the worker itself).
export async function isolationProbe(ctx, homeDir) {
  if (!ctx.cliUser)
    return ctx.c?.NODE_ENV === "production" ? "fail:worker-not-root" : "skip";
  const code =
    'const fs=require("fs"),p=require("path");const o=[String(process.getuid())];' +
    'for(const f of ["/proc/1/environ","/proc/"+process.argv[1]+"/environ"]){try{fs.readFileSync(f);o.push("READ")}catch(e){o.push(e.code||"ERR")}}' +
    'let w="OK";try{fs.writeFileSync(p.join(process.argv[2],"probe"),"x")}catch(e){w=e.code||"ERR";' +
    'const parts=process.argv[2].split(p.sep);let cur=p.sep;for(let i=1;i<parts.length;i++){cur=p.join(cur,parts[i]);try{fs.statSync(cur)}catch{w="BLOCKED"+i;break}}}' +
    'o.push(w);process.stdout.write(o.join(","))';
  const r = (ctx.probeSpawn ?? spawnSync)(
    process.execPath,
    ["-e", code, String(process.pid), homeDir],
    {
      uid: ctx.cliUser.uid,
      gid: ctx.cliUser.gid,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 15000,
      shell: false,
    },
  );
  const tag = (x) =>
    String(x ?? "err")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  if (r.error) return `fail:spawn-failed-${tag(r.error.code)}`;
  if (r.status !== 0) return `fail:probe-exit-${tag(r.status)}`;
  const [uid, p1, wk, home] = String(r.stdout ?? "").split(",");
  if (home === undefined) return "fail:probe-bad-output";
  if (Number(uid) !== ctx.cliUser.uid) return "fail:not-dropped-uid";
  // ENOENT (hidepid) is isolation too.
  const denied = (x) => x === "EACCES" || x === "EPERM" || x === "ENOENT";
  if (p1 === "READ") return "fail:proc1-readable";
  if (!denied(p1)) return `fail:proc1-unexpected-${tag(p1)}`;
  if (wk === "READ") return "fail:worker-environ-readable";
  if (!denied(wk)) return `fail:worker-environ-unexpected-${tag(wk)}`;
  if (home?.startsWith("BLOCKED"))
    return `fail:home-path-blocked-at-${home.slice(7)}`;
  if (home !== "OK") return `fail:home-not-writable-${tag(home)}`;
  return "ok";
}
export async function selfCheck(
  ctx,
  { installationId, print = (line) => console.info(line) } = {},
) {
  const results = {};
  // outcome may carry a reason: "fail:<reason>" prints "fail <name> <reason>".
  const record = (name, outcome) => {
    const [state, reason] = String(outcome).split(":");
    results[name] = state;
    print(reason ? `${state} ${name} ${reason}` : `${state} ${name}`);
  };
  const d = dirs(ctx.workDir);
  await ensureLayout(ctx.workDir).catch(() => undefined);
  const dirOk = (
    await Promise.all([d.tmp, d.jobs, d.builds].map(writable))
  ).every(Boolean);
  record("work-dir-writable", dirOk ? "ok" : "fail");
  // Informational: whether the root filesystem is read-only.
  const rootWritable = await writable(process.cwd());
  record("root-filesystem", rootWritable ? "skip" : "ok");
  const jobDir = path.join(d.jobs, `selfcheck-${randomUUID().slice(0, 8)}`);
  await mkdir(jobDir, { recursive: true });
  await prepareCliDir(jobDir);
  // A deploy root prepared exactly like a real job's: the CLI (as its own uid)
  // runs from here, so an EACCES on incidental writes shows up now.
  const deployRoot = path.join(jobDir, "root");
  await prepareDeployRoot(deployRoot, {});
  const cliEnvDirs = cliEnv({ workDir: ctx.workDir, jobDir });
  // The CLI's uid must not be able to read the worker's secrets (/proc/<pid>/environ).
  record(
    "cli-isolation",
    await (ctx.isolationProbe ?? isolationProbe)(ctx, cliEnvDirs.HOME),
  );
  const version = await ctx.runCli({
    args: ["--version"],
    cwd: deployRoot,
    env: cliEnv({ workDir: ctx.workDir, jobDir }),
    timeoutMs: 60000,
    user: ctx.cliUser ?? null,
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
          cwd: deployRoot,
          env: cliEnv({
            token,
            orgId: target.orgId,
            projectId: target.projectId,
            workDir: ctx.workDir,
            jobDir,
          }),
          timeoutMs: 60000,
          onSpawn,
          user: ctx.cliUser ?? null,
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
        await removeJobDir(ctx.cliUser ?? null, jobDir);
        const scan = await containsBytes(ctx.workDir, needle);
        record("token-not-on-disk", scan.found ? "fail" : "ok");
        // Files that could not be read are reported, not skipped silently.
        results.uncheckedFiles = scan.unchecked;
        print(`info unchecked-files ${scan.unchecked}`);
      }
    }
  }
  await removeJobDir(ctx.cliUser ?? null, jobDir);
  const ok = Object.values(results).every((v) => v !== "fail");
  print(ok ? "self-check: ok" : "self-check: fail");
  return { ok, results };
}
