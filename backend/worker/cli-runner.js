// The only place the Vercel CLI is run. It is spawned without a shell, with an
// explicit minimal environment (never process.env), the customer token ONLY in
// that environment (never in argv), a timeout and a bounded output. The output
// is never stored or logged: it is reduced to a category code from a fixed
// table. This module is also the test seam (ctx.runCli).
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// The pinned CLI: /opt/vercel-cli in the image, tools/vercel-cli in a checkout.
export function resolveCli(env = process.env) {
  const candidates = [
    env.POS_VERCEL_CLI,
    "/opt/vercel-cli/node_modules/vercel/dist/vc.js",
    join(
      here,
      "..",
      "..",
      "tools",
      "vercel-cli",
      "node_modules",
      "vercel",
      "dist",
      "vc.js",
    ),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates[1];
}
// The exact version of the installed CLI, from its package.json.
export async function installedCliVersion(cliPath = resolveCli()) {
  try {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(
      await readFile(join(cliPath, "..", "..", "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version.slice(0, 40) : "";
  } catch {
    return "";
  }
}
// Allowlisted environment for the CLI. HOME, TMPDIR and the XDG directories
// live under the work volume (the root filesystem is read-only). The global
// config (XDG_DATA_HOME) is per job and deleted with it.
// Everything the CLI may write lives under <job>/cli: a PER-JOB home, never a
// shared one, deleted with the job.
export const cliDirOf = (jobDir) => join(jobDir, "cli");
export function cliEnv({ token, orgId = "", projectId = "", workDir, jobDir }) {
  const base = cliDirOf(jobDir ?? join(workDir, "jobs", "adhoc"));
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: join(base, "home"),
    TMPDIR: join(base, "tmp"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_CONFIG_HOME: join(base, "config"),
    VERCEL_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
    CI: "1",
    NODE_OPTIONS: "--max-old-space-size=200",
  };
  if (token) env.VERCEL_TOKEN = token;
  if (orgId) env.VERCEL_ORG_ID = orgId;
  if (projectId) env.VERCEL_PROJECT_ID = projectId;
  return env;
}
// The CLI runs as an unprivileged uid (the worker, as root without any
// capability but SETUID/SETGID/KILL, drops to it at spawn) so it cannot read
// the worker's /proc/<pid>/environ. The worker creates <job>/cli with mode 1777
// (sticky, world-writable) so that uid can write its HOME/TMP without any chown;
// the payload (<job>/root) stays root-owned 0755/0644: readable, never writable.
export async function prepareCliDir(jobDir) {
  // The CLI's uid must be able to walk down to its scratch dirs: every directory
  // on the way (the job dir and its parent) is explicitly 0755, not left to umask.
  await mkdir(jobDir, { recursive: true });
  await chmod(jobDir, 0o755);
  await chmod(dirname(jobDir), 0o755);
  const dir = cliDirOf(jobDir);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o1777);
  // Root-owned 1777 skeletons: whatever the CLI creates below them is its own
  // and is removable by its uid, with no 10001-owned parent root cannot enter.
  for (const name of ["home", "tmp", "data", "config", "cache"]) {
    await mkdir(join(dir, name), { recursive: true });
    await chmod(join(dir, name), 0o1777);
  }
  return dir;
}
// The deploy root the CLI runs in: payload files stay root-owned and read-only,
// but the root and its .vercel/ are sticky world-writable (1777) so incidental
// CLI writes (README, project.json refresh, lock/cache files) cannot hit EACCES.
// Per-job and deleted with the job; .vercel/output/** is untouched.
export async function prepareDeployRoot(
  root,
  { orgId = "", projectId = "" } = {},
) {
  await mkdir(join(root, "apps", "cafe"), { recursive: true });
  await mkdir(join(root, ".vercel"), { recursive: true });
  await writeFile(
    join(root, ".vercel", "project.json"),
    JSON.stringify({ orgId, projectId }),
  );
  await chmod(root, 0o1777);
  await chmod(join(root, ".vercel"), 0o1777);
}
// Deletes a job directory. Files the CLI created are owned by its uid, which
// the worker cannot touch without DAC capabilities, so <job>/cli is emptied by
// a tiny node child running as that same uid first.
export async function removeJobDir(user, dir) {
  if (user) {
    await new Promise((resolve) => {
      try {
        const child = nodeSpawn(process.execPath, [cleanScript, dir], {
          uid: user.uid,
          gid: user.gid,
          env: { PATH: "/usr/bin:/bin" },
          stdio: "ignore",
          shell: false,
        });
        child.on("error", resolve);
        child.on("close", resolve);
      } catch {
        resolve();
      }
    });
  }
  // true when the skeleton is gone; false leaves it for the boot sweep.
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
const cleanScript = fileURLToPath(
  new URL("./clean-as-uid.js", import.meta.url),
);
// Processes still running as the CLI's uid (scan of /proc/*/status).
export async function listUidProcesses(uid, procRoot = "/proc") {
  const { readdir, readFile } = await import("node:fs/promises");
  const pids = [];
  let names = [];
  try {
    names = await readdir(procRoot);
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(join(procRoot, name, "status"), "utf8");
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m && Number(m[1]) === uid) pids.push(Number(name));
    } catch {
      // Gone already.
    }
  }
  return pids;
}
// After a CLI run (success, failure or timeout): kill everything the CLI's uid
// still runs (kill(-1) as that uid signals only its own processes) and make
// sure nothing is left. -> number of processes still alive (0 = clean).
export async function reapCliProcesses(
  user,
  { procRoot = "/proc", attempts = 20, delayMs = 50, spawn = nodeSpawn } = {},
) {
  if (!user) return 0;
  await new Promise((resolve) => {
    try {
      const child = spawn(
        process.execPath,
        ["-e", "try{process.kill(-1,'SIGKILL')}catch{}"],
        {
          uid: user.uid,
          gid: user.gid,
          env: { PATH: "/usr/bin:/bin" },
          stdio: "ignore",
          shell: false,
        },
      );
      child.on("error", resolve);
      child.on("close", resolve);
    } catch {
      resolve();
    }
  });
  let left = [];
  for (let i = 0; i < attempts; i++) {
    left = await listUidProcesses(user.uid, procRoot);
    if (!left.length) return 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return left.length;
}
// Named stderr fragments -> category (spike S2). Only the id is ever kept.
const FRAGMENTS = [
  [
    "rootdir-missing",
    /root directory.*(does not exist|not found|missing)|The provided path .* does not exist|apps\/cafe.*(does not exist|not found)/i,
  ],
  [
    "settings-mismatch",
    /project settings|settings.*(mismatch|do not match|differ)|vercel\.json/i,
  ],
  [
    "no-prebuilt-output",
    /no prebuilt output|\.vercel\/output.*(not found|does not exist|missing)|no .*output.* found/i,
  ],
  ["framework-missing", /framework|output directory/i],
  [
    "auth-invalid-token",
    /invalid token|not authorized|unauthorized|forbidden|\b40[13]\b/i,
  ],
  ["rate-limited", /rate limit|too many requests|\b429\b/i],
  ["network-error", /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i],
  ["upload-error", /upload|archive|too large|\b413\b/i],
];
export const CLI_CODES = {
  "rootdir-missing": "The Vercel project root directory is not usable.",
  "settings-mismatch": "The Vercel project settings do not match.",
  "no-prebuilt-output": "Vercel found no prebuilt output.",
  "framework-missing": "Vercel could not use the project framework settings.",
  "auth-invalid-token": "Vercel rejected the stored token.",
  "rate-limited": "Vercel is rate limiting requests.",
  "network-error": "The network failed while uploading to Vercel.",
  "upload-error": "The upload to Vercel failed.",
  timeout: "The Vercel upload took too long.",
  "spawn-failed": "The Vercel CLI could not be started.",
  other: "The Vercel upload failed.",
};
export function classifyStderr(text) {
  for (const [id, re] of FRAGMENTS) if (re.test(text)) return id;
  return "other";
}
const STDOUT_MAX = 64 * 1024,
  TAIL_MAX = 16 * 1024;
// -> {code, category, timedOut, aborted, stdout}. `category` is null on exit 0.
export function runCli({
  args,
  cwd,
  env,
  timeoutMs = 10 * 60 * 1000,
  signal,
  spawn = nodeSpawn,
  cliPath = resolveCli(),
  killGraceMs = 10000,
  onSpawn,
  user = null,
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(user ? { uid: user.uid, gid: user.gid } : {}),
      });
    } catch {
      return resolve({
        code: 127,
        category: "spawn-failed",
        timedOut: false,
        aborted: false,
        stdout: "",
      });
    }
    try {
      onSpawn?.(child.pid);
    } catch {
      // The probe is best effort.
    }
    let stdout = "",
      tail = "",
      timedOut = false,
      aborted = false,
      settled = false;
    child.stdout?.on("data", (data) => {
      if (stdout.length < STDOUT_MAX) stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data) => {
      tail = (tail + data.toString("utf8")).slice(-TAIL_MAX);
    });
    let killTimer;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const exit = code ?? -1;
      resolve({
        code: exit,
        timedOut,
        aborted,
        stdout: stdout.slice(0, STDOUT_MAX),
        category:
          exit === 0 && !timedOut && !aborted
            ? null
            : timedOut
              ? "timeout"
              : classifyStderr(tail),
      });
    };
    child.on("error", () => done(127));
    child.on("close", done);
  });
}
// The strict deployment-URL shape (a hint only: the deployment is found by meta).
export const VERCEL_URL_RE =
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app\/?$/;
export const lastLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? "";
