// The only place the Vercel CLI is run. It is spawned without a shell, with an
// explicit minimal environment (never process.env), the customer token ONLY in
// that environment (never in argv), a timeout and a bounded output. The output
// is never stored or logged: it is reduced to a category code from a fixed
// table. This module is also the test seam (ctx.runCli).
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
export function cliEnv({ token, orgId = "", projectId = "", workDir, jobDir }) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: join(workDir, "home"),
    TMPDIR: join(workDir, "tmp"),
    XDG_DATA_HOME: join(jobDir ?? workDir, "vc"),
    XDG_CACHE_HOME: join(workDir, "cache"),
    XDG_CONFIG_HOME: join(jobDir ?? workDir, "vc-config"),
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
}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
