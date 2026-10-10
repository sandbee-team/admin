// Whitelist views of `installations.pos.usage` (docs/PHASE2-PLAN.md rev 2, §3
// and §8). Everything the panel receives about a usage check goes through
// here: the lease, attempt, fence, the e-mail memory (`mail`) and any unknown
// or provider field are left out. Codes outside shared/usage-codes.js read as
// "internal", numbers are finite and non-negative, fractions 0..2, strings are
// capped and stripped of control and bidi characters.
import { cleanText } from "./deploy-view.js";
import { isUsageCode } from "../../shared/usage-codes.js";
import { QUEUED_EXPIRY_MS } from "../../shared/deploy.js";
import {
  ALERT_TITLES,
  ALERT_TYPES,
  CHECK_STATES,
  CLUSTER_NAME_RE,
  CLUSTER_ROLES,
  CLUSTER_TAG_RE,
  LEVELS,
  MAX_CLUSTERS,
  SITE_STATES,
  STORAGE_SOURCES,
} from "../../shared/usage.js";

const ALERT_LEVELS = ["warning", "critical"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
const oneOf = (list, value, fallback = null) =>
  list.includes(value) ? value : fallback;
const num = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const fraction = (value) => {
  const n = num(value);
  return n !== null && n <= 2 ? n : null;
};
// A Date, or epoch milliseconds (token expiry is stored as a number).
const date = (value) => {
  if (!(value instanceof Date) && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) || d.getTime() < 0 ? null : d;
};
const day = (value) =>
  typeof value === "string" && DAY_RE.test(value) ? value : null;
const code = (value) => (isUsageCode(value) ? value : "internal");
const optionalCode = (value) =>
  value === undefined || value === null ? null : code(value);
const isActive = (value) => value === true;

/** The one check slot: who asked, when, and how it ended. */
export function checkView(check) {
  const c = object(check);
  if (!c) return null;
  const error = object(c.error);
  return {
    id: cleanText(c.id, 64),
    status: oneOf(CHECK_STATES, c.status, "failed"),
    batch: Boolean(c.batchId),
    requestedAt: date(c.requestedAt),
    startedAt: date(c.startedAt),
    finishedAt: date(c.finishedAt),
    by: { name: cleanText(object(c.by)?.name, 120) },
    error: error ? { code: code(error.code) } : null,
  };
}

const clusterView = (row) => ({
  name: row.name,
  role: oneOf(CLUSTER_ROLES, row.role, null),
  label:
    typeof row.label === "string" && CLUSTER_TAG_RE.test(row.label)
      ? row.label
      : null,
  active: isActive(row.active),
  paused: isActive(row.paused),
  state: row.state === "ok" ? "ok" : "error",
  usedPct: fraction(row.usedPct),
  bytes: num(row.bytes),
});
const clusterList = (rows) =>
  Array.isArray(rows)
    ? rows
        .map(object)
        .filter(
          (row) =>
            row &&
            typeof row.name === "string" &&
            CLUSTER_NAME_RE.test(row.name),
        )
        .slice(0, MAX_CLUSTERS)
        .map(clusterView)
    : [];
const tokenView = (token) => {
  const t = object(token);
  return { code: code(t?.code), expiresAt: date(t?.expiresAt) };
};
const alertList = (alerts) => {
  const all = object(alerts);
  if (!all) return [];
  return ALERT_TYPES.flatMap((type) => {
    const alert = object(all[type]);
    if (!alert || !ALERT_LEVELS.includes(alert.level)) return [];
    return [
      {
        type,
        title: ALERT_TITLES[type],
        level: alert.level,
        detail: cleanText(alert.detail, 120),
      },
    ];
  });
};

/** The latest stored result (`pos.usage.last`), or null before any check. */
export function lastView(last) {
  const l = object(last);
  if (!l) return null;
  const site = object(l.site) ?? {},
    mongo = object(l.mongo) ?? {},
    cf = object(l.cloudflare) ?? {},
    yesterday = object(cf.yesterday) ?? {},
    credentials = object(l.credentials) ?? {};
  return {
    at: date(l.at),
    durationMs: num(l.durationMs),
    level: oneOf(LEVELS, l.level, null),
    site: {
      state: oneOf(SITE_STATES, site.state, "unknown"),
      code: code(site.code),
      httpStatus: num(site.httpStatus),
      latencyMs: num(site.latencyMs),
      probes: num(site.probes),
      deployActive: isActive(site.deployActive),
    },
    mongo: {
      source: oneOf(STORAGE_SOURCES, mongo.source, null),
      code: code(mongo.code),
      statsCode: optionalCode(mongo.statsCode),
      maxPct: fraction(mongo.maxPct),
      clusters: clusterList(mongo.clusters),
    },
    cloudflare: {
      code: code(cf.code),
      day: day(cf.day),
      requests: num(cf.requests),
      errors: num(cf.errors),
      pct: fraction(cf.pct),
      yesterday: { day: day(yesterday.day), requests: num(yesterday.requests) },
    },
    credentials: {
      vercel: tokenView(credentials.vercel),
      cloudflare: tokenView(credentials.cloudflare),
    },
    alerts: alertList(l.alerts),
  };
}

/** One fleet row's summary; reads only the fields GET /pos/fleet projects. */
export function fleetUsageView(usage, installationStatus) {
  const u = object(usage) ?? {},
    last = object(u.last),
    site = object(last?.site),
    check = oneOf(CHECK_STATES, object(u.check)?.status, null),
    watch = u.watch === true;
  return {
    watch,
    // In "Check watched clients": the batch's watch list skips retired
    // clients (they keep their flag).
    batchable: watch && installationStatus !== "retired",
    check,
    level: last ? oneOf(LEVELS, last.level, null) : null,
    site: site ? oneOf(SITE_STATES, site.state, "unknown") : null,
    latencyMs: num(site?.latencyMs),
    storagePct: fraction(object(last?.mongo)?.maxPct),
    workersPct: fraction(object(last?.cloudflare)?.pct),
    workersDay: day(object(last?.cloudflare)?.day),
    checkedAt: date(last?.at),
  };
}

// Has nobody picked this check up although it is queued for longer than
// QUEUED_EXPIRY_MS (10 minutes, by the server clock)? The worker never expires
// it while its heartbeat is fresh, so it may still be waiting its turn.
export function queuedTooLong(check, now = Date.now()) {
  const c = object(check);
  const at = c?.status === "queued" ? date(c.requestedAt) : null;
  return Boolean(at) && now - at.getTime() > QUEUED_EXPIRY_MS;
}

// The worker claims the next queued check on its next poll (seconds), so a
// check that finished a moment ago also means the queue is moving.
export const PROGRESS_MS = 60000;
export function recentlyFinished(check, now = Date.now()) {
  const c = object(check);
  const at =
    c && ["done", "failed", "expired"].includes(c.status)
      ? date(c.finishedAt)
      : null;
  return Boolean(at) && now - at.getTime() < PROGRESS_MS;
}

/**
 * GET /pos/fleet `usageStalled` from the usage blocks of the rows it loaded:
 * no check will run because the worker is offline, or a check has been queued
 * too long while none is running (a long batch runs one at a time, so a
 * running check means the queue is moving).
 */
export function fleetUsageStalled(usages, workerOnline, now = Date.now()) {
  if (!workerOnline) return true;
  const checks = usages.map((usage) => object(object(usage)?.check));
  return (
    !checks.some(
      (check) => check?.status === "running" || recentlyFinished(check, now),
    ) && checks.some((check) => queuedTooLong(check, now))
  );
}
