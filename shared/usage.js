// Phase 2 usage checks (docs/PHASE2-PLAN.md rev 2): free-tier limits, levels
// and the pure rules shared by the worker, the API views and the panel. A
// check runs only when the owner triggers it and stores only the current
// result, so nothing here deals with history. Pure: no network, database or
// clock (callers pass `now`).
export const MIB = 1024 * 1024;
export const MONGO_LIMIT_BYTES = 512 * MIB; // Atlas M0: dataSize + indexSize
export const WORKER_FREE_REQUESTS = 100000; // Workers Free: per account per UTC day
export const WARN_PCT = 0.75;
export const CRIT_PCT = 0.9;
export const SITE_ATTEMPTS = 3; // "down" = this many failed probes in a row
export const EXPIRY_WARN_DAYS = 14;
export const EXPIRY_CRIT_DAYS = 3;
export const MAIL_EVERY_MS = 24 * 3600000; // one email per client per type
// Queued checks expire only after the worker heartbeat was stale for 10 minutes
// (QUEUED_EXPIRY_MS, shared/deploy.js): a long batch is never cut short.
export const MAX_CHECK_ATTEMPTS = 3;
export const MAX_CLUSTERS = 12;
export const CLUSTER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const CLUSTER_TAG_RE = /^[A-Z][A-Z0-9]{0,7}$/;

export const CHECK_STATES = ["queued", "running", "done", "failed", "expired"];
export const ACTIVE_CHECK_STATES = ["queued", "running"];
export const SITE_STATES = ["up", "down", "paused", "unknown"];
export const CLUSTER_ROLES = ["core", "ledger", "standby"];
export const STORAGE_SOURCES = ["health", "direct"];
export const LEVELS = ["ok", "warning", "critical"];
export const ALERT_TYPES = [
  "storage",
  "workers",
  "site-down",
  "site-paused",
  "credential",
];
export const ALERT_TITLES = Object.freeze({
  storage: "Database storage",
  workers: "Cloudflare Worker requests",
  "site-down": "POS site down",
  "site-paused": "POS site paused by Vercel",
  credential: "Token expiry",
});
// Reference only: Vercel offers no usage numbers on Hobby, so nothing is
// measured against these (vercel.com/docs/pricing, 2026-09).
export const HOBBY_LIMITS = Object.freeze([
  { label: "Fast data transfer", value: "100 GB / month" },
  { label: "Edge requests", value: "1,000,000 / month" },
  { label: "Function invocations", value: "1,000,000 / month" },
  { label: "Active CPU", value: "4 hours / month" },
]);

const DAY_MS = 86400000;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const levelOf = (fraction) =>
  !finite(fraction)
    ? "ok"
    : fraction >= CRIT_PCT
      ? "critical"
      : fraction >= WARN_PCT
        ? "warning"
        : "ok";
export const maxLevel = (levels) =>
  LEVELS[Math.max(0, ...levels.map((level) => LEVELS.indexOf(level)))];
export const pctText = (fraction) =>
  `${Math.round((finite(fraction) ? fraction : 0) * 1000) / 10}%`;
export const mbText = (bytes) => `${Math.round(bytes / MIB)} MB`;
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const utcDayStart = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const count = (n) => Math.round(n).toLocaleString("en-US");
const daysLeft = (expiresAt, now) => Math.ceil((expiresAt - now) / DAY_MS);

/** Level of one token: {code, expiresAt(ms)|null} -> "warning" | "critical" | null. */
export function credentialLevel(token, now) {
  if (!token) return null;
  if (token.code === "token-invalid") return "critical";
  if (!finite(token.expiresAt)) return null;
  const days = (token.expiresAt - now) / DAY_MS;
  if (days <= EXPIRY_CRIT_DAYS) return "critical";
  if (days <= EXPIRY_WARN_DAYS) return "warning";
  return null;
}
const tokenText = (service, token, now) => {
  if (token.code === "token-invalid") return `${service} token is invalid`;
  const days = daysLeft(token.expiresAt, now);
  return days <= 0
    ? `${service} token has expired`
    : `${service} token expires in ${days} day${days === 1 ? "" : "s"}`;
};
const cut = (text) => text.slice(0, 120);

/**
 * Alerts of ONE check result (`pos.usage.last`): {alerts: {type: {level, value,
 * detail}}, level}. Types appear in ALERT_TYPES order; details are ≤ 120 chars.
 */
export function evaluateAlerts(last, now) {
  const alerts = {};
  const clusters = Array.isArray(last?.mongo?.clusters)
    ? last.mongo.clusters.filter((c) => c?.state === "ok" && finite(c.usedPct))
    : [];
  if (clusters.length) {
    const top = clusters.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
    const level = levelOf(top.usedPct);
    if (level !== "ok")
      alerts.storage = {
        level,
        value: top.usedPct,
        detail: cut(
          `${top.name} at ${pctText(top.usedPct)} of 512 MB` +
            (finite(top.bytes) ? ` (${mbText(top.bytes)} used)` : ""),
        ),
      };
  }
  const cf = last?.cloudflare;
  if (cf?.code === "ok" && cf.day === utcDay(now) && finite(cf.requests)) {
    const fraction = cf.requests / WORKER_FREE_REQUESTS;
    const level = levelOf(fraction);
    if (level !== "ok")
      alerts.workers = {
        level,
        value: Math.round(fraction * 10000) / 10000,
        detail: cut(
          `${count(cf.requests)} of ${count(WORKER_FREE_REQUESTS)} requests today (${pctText(fraction)})`,
        ),
      };
  }
  const site = last?.site;
  // Down only after SITE_ATTEMPTS failed probes in a row (a bad or blocked host
  // is not retried and is a setup problem, not an outage).
  if (
    site?.state === "down" &&
    site.deployActive !== true &&
    Number.isFinite(site.probes) &&
    site.probes >= SITE_ATTEMPTS
  )
    alerts["site-down"] = {
      level: "critical",
      value: null,
      detail: cut(`No healthy answer in ${site.probes} attempts`),
    };
  if (site?.state === "paused")
    alerts["site-paused"] = {
      level: "critical",
      value: null,
      detail: "Vercel answered 503 DEPLOYMENT_PAUSED",
    };
  const tokens = [
    ["Vercel", last?.credentials?.vercel],
    ["Cloudflare", last?.credentials?.cloudflare],
  ]
    .map(([service, token]) => [service, token, credentialLevel(token, now)])
    .filter(([, , level]) => level);
  if (tokens.length)
    alerts.credential = {
      level: maxLevel(tokens.map(([, , level]) => level)),
      value: null,
      detail: cut(
        tokens
          .map(([service, token]) => tokenText(service, token, now))
          .join("; "),
      ),
    };
  return {
    alerts,
    level: maxLevel(Object.values(alerts).map((alert) => alert.level)),
  };
}

/**
 * Which alerts of a client to email now: [{type, level}]. A type is due when it
 * was not emailed in the last 24 h, or once more when a warning became critical.
 * `mail` = stored {type: {at, level}}.
 */
export function dueMail(mail, alerts, now) {
  const due = [];
  for (const type of ALERT_TYPES) {
    const alert = alerts?.[type];
    if (!alert || !LEVELS.includes(alert.level) || alert.level === "ok")
      continue;
    const sent = mail?.[type];
    const at = new Date(sent?.at ?? NaN).getTime();
    // A mail time in the future (clock skew) does not suppress mail.
    const fresh = Number.isFinite(at) && at <= now && now - at < MAIL_EVERY_MS;
    if (!fresh || (sent.level === "warning" && alert.level === "critical"))
      due.push({ type, level: alert.level });
  }
  return due;
}
