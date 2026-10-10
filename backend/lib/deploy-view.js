// Whitelist views of the stored deploy state (shared/deploy.js, JOB CONTRACT).
// Everything the panel receives goes through here: lease/fence fields, full
// build keys, object keys, run ids and any unknown field are left out. Strings
// from the worker are length-capped and stripped of control characters.
import { createHash } from "node:crypto";
import {
  ERROR_CODE_RE,
  RUN_LINK_DAYS,
  STEP_STATES,
  DEPLOY_STATES,
  DEPLOY_KINDS,
  DEPLOY_STEPS,
  TASK_KINDS,
  TASK_STATES,
  BUILD_SOURCES,
  VERSION_STATUSES,
  isBranch,
  isSha,
  sha7,
  jobBlocks,
  NEXT_PUBLIC_KEYS,
} from "../../shared/deploy.js";

const clean = (value, max) =>
  String(value ?? "")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .trim()
    .slice(0, max);
const date = (value) => {
  const d = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
const oneOf = (list, value, fallback = null) =>
  list.includes(value) ? value : fallback;
const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const person = (by) => ({
  id: clean(by?.id, 64),
  name: clean(by?.name, 120),
});
export const key8 = (key) =>
  typeof key === "string" && /^[0-9a-f]{64}$/.test(key) ? key.slice(0, 8) : "";
const RUN_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d{1,20}$/;
// GitHub deletes the run after the retention window, so the link is hidden.
const runLink = (url, at, now) => {
  const when = date(at);
  if (
    typeof url !== "string" ||
    !RUN_URL_RE.test(url) ||
    !when ||
    now - when.getTime() > RUN_LINK_DAYS * 86400000
  )
    return null;
  return url;
};
const stepView = (step) => ({
  name: oneOf(DEPLOY_STEPS, step?.name, ""),
  state: oneOf(STEP_STATES, step?.state, "pending"),
  startedAt: date(step?.startedAt),
  endedAt: date(step?.endedAt),
  note: clean(step?.note, 120),
});
// The commit as stored on a job or build row: first line of the message,
// the author's NAME only (an e-mail is never kept), control and bidi
// characters removed. `raw` is untrusted (GitHub, or a stored version).
export const storedCommit = (raw, sha, branch) =>
  raw && isSha(sha)
    ? {
        sha,
        branch: isBranch(branch) ? branch : "",
        headline: clean(String(raw.headline ?? "").split(/\r?\n/)[0], 120),
        authorName: clean(
          String(raw.authorName ?? "")
            .replace(/<[^>]*>/g, "")
            .replace(/\S+@\S+/g, ""),
          100,
        ),
        date: date(raw.date),
      }
    : null;
const commitView = (commit) =>
  commit
    ? {
        sha: isSha(commit.sha) ? commit.sha : "",
        branch: isBranch(commit.branch) ? commit.branch : "",
        headline: clean(commit.headline, 120),
        authorName: clean(commit.authorName, 100),
        date: date(commit.date),
      }
    : null;
const errorView = (error) =>
  error
    ? {
        step: oneOf(DEPLOY_STEPS, error.step, ""),
        code: ERROR_CODE_RE.test(error.code ?? "") ? error.code : "failed",
        message: clean(error.message, 160),
      }
    : null;
// The running or last unsuccessful job. `stalled` = a started job whose lease
// has expired (the worker restarted; the panel says "resuming").
export function jobView(job, now = Date.now()) {
  if (!job) return null;
  const until = date(job.lease?.until);
  return {
    kind: oneOf(DEPLOY_KINDS, job.kind, "deploy"),
    requestId: clean(job.requestId, 64),
    branch: isBranch(job.branch) ? job.branch : "",
    sha: isSha(job.sha) ? job.sha : "",
    buildKey8: key8(job.buildKey),
    commit: commitView(job.commit),
    by: person(job.by),
    requestedAt: date(job.requestedAt),
    status: oneOf(DEPLOY_STATES, job.status, "failed"),
    step: oneOf(DEPLOY_STEPS, job.step, "queued"),
    steps: Array.isArray(job.steps) ? job.steps.slice(0, 12).map(stepView) : [],
    stalled:
      ["running", "cancelling"].includes(job.status) &&
      Boolean(until) &&
      until.getTime() < now,
    blocking: jobBlocks(job, now),
    runUrl: runLink(job.runUrl, job.requestedAt, now),
    vercelDeploymentId: clean(job.vercelDeploymentId, 80),
    cancelRequested: job.cancelRequested === true,
    error: errorView(job.error),
    finishedAt: date(job.finishedAt),
  };
}
// last / previous: key8 only for the build, never the object key.
export function versionView(version, now = Date.now()) {
  if (!version) return null;
  const build = version.build
    ? {
        key8: key8(version.build.buildKey),
        touchedAt: date(version.build.touchedAt),
        source: oneOf(BUILD_SOURCES, version.build.source),
        cached: version.build.source === "cache",
      }
    : null;
  return {
    kind: oneOf(DEPLOY_KINDS, version.kind, "deploy"),
    requestId: clean(version.requestId, 64),
    branch: isBranch(version.branch) ? version.branch : "",
    sha: isSha(version.sha) ? version.sha : "",
    at: date(version.at),
    by: person(version.by),
    vercelDeploymentId: clean(version.vercelDeploymentId, 80),
    url: /^https:\/\/[a-z0-9.-]{1,200}$/.test(version.url ?? "")
      ? version.url
      : "",
    durationMs: int(version.durationMs),
    runUrl: runLink(version.runUrl, version.at, now),
    status: oneOf(VERSION_STATUSES, version.status, "succeeded"),
    build,
    commit: commitView(version.commit),
  };
}
const FLAG_RE = /^[a-z0-9-]{1,40}$/;
const flag = (value) =>
  value === "ok" || (typeof value === "string" && FLAG_RE.test(value))
    ? value
    : null;
export const verifyView = (verify) =>
  verify
    ? {
        at: date(verify.at),
        by: person(verify.by),
        vercel: flag(verify.vercel),
        project: flag(verify.project),
        env: flag(verify.env),
        mongo: flag(verify.mongo),
        cloudflare: flag(verify.cloudflare),
        health: flag(verify.health),
      }
    : null;
// One digest of the exact candidate ids: preview and execute are bound by it.
export const purgeDigest = (ids) =>
  createHash("sha256")
    .update(JSON.stringify([...ids].sort()))
    .digest("hex");
const candidateView = (c) => ({
  id: clean(c?.id, 80),
  createdAt: date(c?.createdAt),
  target: clean(c?.target, 20),
  state: clean(c?.state, 20),
});
export function taskView(task) {
  if (!task) return null;
  const result = task.result;
  let view = null;
  if (result && task.kind === "purge-preview") {
    const candidates = Array.isArray(result.candidates)
      ? result.candidates.slice(0, 200).map(candidateView)
      : [];
    view = {
      at: date(result.at),
      total: int(result.total),
      candidates,
      digest: purgeDigest(candidates.map((c) => c.id)),
    };
  } else if (result && typeof result === "object") {
    // Other kinds: counts only.
    view = Object.fromEntries(
      Object.entries(result)
        .filter(([, v]) => Number.isSafeInteger(v) || typeof v === "boolean")
        .slice(0, 12)
        .map(([k, v]) => [clean(k, 30), v]),
    );
  }
  return {
    id: clean(task.id, 64),
    kind: oneOf(TASK_KINDS, task.kind, "verify"),
    status: oneOf(TASK_STATES, task.status, "failed"),
    step: clean(task.step, 30),
    by: person(task.by),
    requestedAt: date(task.requestedAt),
    finishedAt: date(task.finishedAt),
    result: view,
    error: task.error
      ? {
          code: ERROR_CODE_RE.test(task.error.code ?? "")
            ? task.error.code
            : "failed",
          message: clean(task.error.message, 160),
        }
      : null,
  };
}
export const deployView = (deploy, now = Date.now()) => ({
  current: jobView(deploy?.current, now),
  last: versionView(deploy?.last, now),
  previous: versionView(deploy?.previous, now),
});
export const nextPublicView = (nextPublic) =>
  Object.fromEntries(
    NEXT_PUBLIC_KEYS.filter((key) => typeof nextPublic?.[key] === "string").map(
      (key) => [key, clean(nextPublic[key], 500)],
    ),
  );
export const workerView = (row, now = Date.now()) => {
  const at = date(row?.at);
  const builder = row?.builder;
  return {
    online: Boolean(at) && now - at.getTime() < 90000,
    at,
    version: clean(row?.version, 40),
    cliVersion: clean(row?.cliVersion, 40),
    builder: builder
      ? {
          ok: builder.ok === true,
          sha7: sha7(builder.sha),
          nodeVersion: clean(builder.nodeVersion, 20),
          cliVersion: clean(builder.cliVersion, 40),
          checkedAt: date(builder.checkedAt),
        }
      : null,
    lastBuildMs: int(row?.lastBuildMs),
  };
};
export const cutoverView = (deploy) => date(deploy?.cutoverAt);
