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
  READINESS_IDS,
  buildRowId,
} from "../../shared/deploy.js";
import { isKnownCode } from "../../shared/deploy-errors.js";
import {
  MAX_TARGETS,
  ROLLOUT_STATES,
  TARGET_STATES,
  rolloutCounts,
} from "../../shared/rollout.js";
import {
  GOLIVE_ACTIONS,
  GOLIVE_LIMITS,
  GOLIVE_STATES,
  GOLIVE_STEPS,
  WAITING_FOR,
  goliveBlocks,
} from "../../shared/golive.js";
import { ADDRESS_STATES } from "../../shared/web-address.js";

export const cleanText = (value, max) => clean(value, max);
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
export function jobView(job, now = Date.now(), workerAt) {
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
    blocking: jobBlocks(job, now, workerAt),
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
// Non-secret Vercel project settings only (name, actual, expected).
const SETTING_NAMES = [
  "framework",
  "rootDirectory",
  "nodeVersion",
  "sourceFilesOutsideRootDirectory",
];
const settingIssues = (list) =>
  Array.isArray(list)
    ? list
        .filter((i) => SETTING_NAMES.includes(i?.name))
        .slice(0, 6)
        .map((i) => ({
          name: i.name,
          actual:
            i.actual === null || i.actual === undefined
              ? null
              : clean(i.actual, 100),
          expected: clean(i.expected, 100),
        }))
    : [];
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
        problems: settingIssues(verify.problems),
        warnings: settingIssues(verify.warnings),
        // P5 D43: names-only env parity of a client whose env admin did not
        // write (warning env-keys-missing). Key names only, never values.
        envKeysMissing: (Array.isArray(verify.envKeysMissing)
          ? verify.envKeysMissing
          : []
        )
          .filter((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name ?? ""))
          .slice(0, 30),
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
      keep: int(result.keep),
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
    // A purge's progress (deleted + skipped + failed of the confirmed ids).
    progress:
      task.kind === "purge" && task.progress
        ? { done: int(task.progress.done), total: int(task.progress.total) }
        : null,
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
export const deployView = (deploy, now = Date.now(), workerAt) => ({
  current: jobView(deploy?.current, now, workerAt),
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

// ---- go-live (P5, shared/golive.js) ----------------------------------------------
// The panel never sees the lease, the env fingerprints, the full bundle digest
// or any unknown field; worker strings are capped and cleaned, codes outside
// the table read as "internal". DNS names and answers are public data.
const NAME_RE = /^[a-z0-9_@](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const dnsName = (value) => {
  const v = String(value ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
  return NAME_RE.test(v) && v.length <= GOLIVE_LIMITS.found ? v : "";
};
const recordView = (r) => ({
  type: oneOf(["CNAME", "TXT"], r?.type, ""),
  name: dnsName(r?.name),
  value:
    r?.type === "CNAME"
      ? dnsName(r?.value)
      : clean(r?.value, GOLIVE_LIMITS.found),
});
const answer = (part, many) =>
  part
    ? {
        ok: part.ok === true ? true : part.ok === false ? false : null,
        found: many
          ? (Array.isArray(part.found) ? part.found : [])
              .slice(0, GOLIVE_LIMITS.txtFound)
              .map((v) => clean(v, GOLIVE_LIMITS.found))
          : part.found
            ? dnsName(part.found)
            : null,
      }
    : null;
const addressView = (a) =>
  a
    ? {
        label: dnsName(a.label),
        host: dnsName(a.host),
        records: (Array.isArray(a.records) ? a.records : [])
          .slice(0, GOLIVE_LIMITS.records)
          .map(recordView),
        cname: answer(a.cname, false),
        txt: answer(a.txt, true),
        verified: a.verified === true,
        configured:
          a.configured === true ? true : a.configured === false ? false : null,
        tls: a.tls === true,
        state: oneOf(ADDRESS_STATES, a.state, "pending-dns"),
        checkedAt: date(a.checkedAt),
      }
    : null;
const envView = (e) =>
  e
    ? {
        at: date(e.at),
        keys: (Array.isArray(e.keys) ? e.keys : [])
          .filter((k) => ENV_KEY_RE.test(k?.name ?? ""))
          .slice(0, GOLIVE_LIMITS.envKeys)
          .map((k) => ({
            name: k.name,
            type: oneOf(["encrypted", "plain"], k.type, "encrypted"),
            targets: (Array.isArray(k.targets) ? k.targets : []).filter((t) =>
              ["production", "preview"].includes(t),
            ),
            set: k.set === true,
            updatedAt: date(k.updatedAt),
          })),
      }
    : null;
const goliveStepView = (step) => ({
  name: oneOf(GOLIVE_STEPS, step?.name, ""),
  state: oneOf(STEP_STATES, step?.state, "pending"),
  startedAt: date(step?.startedAt),
  endedAt: date(step?.endedAt),
  note: clean(step?.note, GOLIVE_LIMITS.note),
});
export function goliveView(golive, now = Date.now(), workerAt) {
  if (!golive) return null;
  const until = date(golive.lease?.until);
  return {
    status: oneOf(GOLIVE_STATES, golive.status, "failed"),
    action: oneOf(GOLIVE_ACTIONS, golive.action, "start"),
    requestId: clean(golive.requestId, 64),
    by: person(golive.by),
    requestedAt: date(golive.requestedAt),
    startedAt: date(golive.startedAt),
    endedAt: date(golive.endedAt),
    branch: isBranch(golive.branch) ? golive.branch : "",
    sha: isSha(golive.sha) ? golive.sha : "",
    step: oneOf(["queued", ...GOLIVE_STEPS], golive.step, "queued"),
    steps: Array.isArray(golive.steps)
      ? golive.steps.slice(0, GOLIVE_LIMITS.steps).map(goliveStepView)
      : [],
    waitingFor:
      golive.status === "waiting"
        ? oneOf(WAITING_FOR, golive.waitingFor)
        : null,
    stalled:
      golive.status === "running" && Boolean(until) && until.getTime() < now,
    blocking: goliveBlocks(golive, now, workerAt),
    cancelRequested: golive.cancelRequested === true,
    error: golive.error
      ? {
          step: oneOf(GOLIVE_STEPS, golive.error.step, ""),
          code: knownOr(golive.error.code),
          message: clean(golive.error.message, GOLIVE_LIMITS.message),
        }
      : null,
    warnings: (Array.isArray(golive.warnings) ? golive.warnings : [])
      .filter((c) => ERROR_CODE_RE.test(c ?? "") && isKnownCode(c))
      .slice(0, GOLIVE_LIMITS.warnings),
    address: addressView(golive.address),
    env: envView(golive.env),
    realtime: golive.realtime
      ? {
          bundle8: key8(golive.realtime.bundleSha256),
          sha7: sha7(golive.realtime.sha),
          deployedAt: date(golive.realtime.deployedAt),
          verifiedAt: date(golive.realtime.verifiedAt),
        }
      : null,
    admin: golive.admin
      ? {
          state: oneOf(["seeded", "exists"], golive.admin.state),
          at: date(golive.admin.at),
          changedInPos: golive.admin.changedInPos === true,
        }
      : null,
    deployRequestId: clean(golive.deployRequestId, 64),
    liveAt: date(golive.liveAt),
  };
}
// What the POS settings view and the fleet need to know (tab, badge). `live`:
// the client went live once (a later Sync env run is not "going live").
export const goliveBadge = (golive) =>
  golive
    ? {
        status: oneOf(GOLIVE_STATES, golive.status, "failed"),
        waitingFor:
          golive.status === "waiting"
            ? oneOf(WAITING_FOR, golive.waitingFor)
            : null,
        live: Boolean(date(golive.liveAt)),
      }
    : null;

// ---- rollout (P3) ---------------------------------------------------------------
// The plan and the start are bound by the commit AND the exact client order.
export const rolloutDigest = (sha, ids) =>
  createHash("sha256")
    .update(JSON.stringify([String(sha), [...ids].map(String)]))
    .digest("hex");
const knownOr = (code) =>
  ERROR_CODE_RE.test(code ?? "") && isKnownCode(code) ? code : "internal";
const ACTIVE_BUILD = [
  "queued",
  "dispatching",
  "building",
  "collecting",
  "storing",
];
// A waiting client's pre-build: building, ready (a stored or cache-adopted
// row is deleted by the build lane, so a missing row reads as ready) or failed.
function prebuildView(target, row, builds) {
  if (!["queued", "joined"].includes(target.prebuild)) return null;
  const build = builds.get(buildRowId(row.sha, target.buildKey));
  if (!build) return "ready";
  if (ACTIVE_BUILD.includes(build.status)) return "building";
  return build.status === "ready" ? "ready" : "failed";
}
// The one pos-rollout row as the panel sees it: never the lease, the
// starter's authority fields, job request ids, build keys or the full sha.
// `builds` = Map of build-row id -> {status} for the pre-built keys.
export function rolloutView(row, builds = new Map()) {
  if (!row) return null;
  const targets = (Array.isArray(row.targets) ? row.targets : [])
    .slice(0, MAX_TARGETS)
    .map((t) => ({
      installationId: clean(t?.installationId, 64),
      slug: clean(t?.slug, 60),
      status: oneOf(TARGET_STATES, t?.status, "pending"),
      build: prebuildView(t ?? {}, row, builds),
      error: t?.error
        ? {
            code: knownOr(t.error.code),
            items: Array.isArray(t.error.items)
              ? t.error.items.filter((id) => READINESS_IDS.includes(id))
              : [],
          }
        : null,
      startedAt: date(t?.startedAt),
      finishedAt: date(t?.finishedAt),
    }));
  return {
    id: clean(row.id, 64),
    status: oneOf(ROLLOUT_STATES, row.status, "stopped"),
    branch: isBranch(row.branch) ? row.branch : "",
    sha7: sha7(row.sha),
    commit: row.commit
      ? {
          headline: clean(row.commit.headline, 120),
          authorName: clean(row.commit.authorName, 100),
          date: date(row.commit.date),
        }
      : null,
    by: { name: clean(row.by?.name, 120) },
    resumed: row.resumed
      ? {
          by: { name: clean(row.resumed.by?.name, 120) },
          at: date(row.resumed.at),
        }
      : null,
    startedAt: date(row.startedAt),
    finishedAt: date(row.finishedAt),
    cancelRequested: row.cancelRequested === true,
    stop: row.stop
      ? { slug: clean(row.stop.slug, 60), code: knownOr(row.stop.code) }
      : null,
    counts: rolloutCounts(targets),
    targets,
  };
}
