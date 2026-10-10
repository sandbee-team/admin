// Health probe for a POS host with the same verdict as the local go-live
// console: GET /api/health must be 200 with ok:true, db:"up" and the expected
// tenant. On top of that /login must answer 200 HTML, which proves the edge
// middleware routes the tenant (the health path is not covered by it).
import { getText, validPublicHost } from "./safe-https.js";
import {
  CLUSTER_NAME_RE,
  CLUSTER_ROLES,
  CLUSTER_TAG_RE,
  MAX_CLUSTERS,
  MONGO_LIMIT_BYTES,
} from "../../shared/usage.js";

const TENANT_LABEL = /^[A-Za-z0-9_-]{1,64}$/;
// What a host reports about itself is not trusted text: only a short label
// shape is echoed back.
const label = (value) =>
  typeof value === "string" && TENANT_LABEL.test(value)
    ? value
    : "(unreadable)";
/** The verdict on GET /api/health for the production host (ported from go-live). */
export function healthVerdict(status, body, tenantId) {
  if (status !== 200)
    return {
      ok: false,
      reason:
        body && body.db === "down"
          ? "app is up but cannot reach the cluster — check the Atlas Network Access allowlist (0.0.0.0/0) and mongodbUri"
          : `HTTP ${Number.isInteger(status) ? status : 0}`,
    };
  if (!body || body.ok !== true || body.db !== "up")
    return { ok: false, reason: "unexpected health body" };
  if (body.tenant !== tenantId)
    return {
      ok: false,
      reason: `health says tenant "${label(body.tenant)}" but TENANT_ID is "${label(tenantId)}" — the host label and TENANT_ID disagree (every page would 404)`,
    };
  return { ok: true, reason: "ok" };
}
/** The /login probe: 200 and an HTML document. */
export function loginVerdict(status, headers, text) {
  if (status !== 200)
    return {
      ok: false,
      reason: `login page HTTP ${Number.isInteger(status) ? status : 0}`,
    };
  const type = String(headers?.["content-type"] ?? "").toLowerCase();
  if (
    !type.includes("text/html") ||
    !/<html[\s>]|<!doctype html/i.test(text ?? "")
  )
    return { ok: false, reason: "login page is not HTML" };
  return { ok: true, reason: "ok" };
}
const failure = (error) => ({
  ok: false,
  reason: `no response (${error?.code ?? "error"})`,
});
export async function probeHealth({
  host,
  tenantId,
  get = getText,
  timeoutMs = 10000,
  signal,
}) {
  if (!validPublicHost(host)) return { ok: false, reason: "invalid host" };
  try {
    const res = await get(host, "/api/health", {
      timeoutMs,
      signal,
      headers: { accept: "application/json" },
    });
    let body = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = null;
    }
    return healthVerdict(res.status, body, tenantId);
  } catch (error) {
    return failure(error);
  }
}
export async function probeLogin({
  host,
  get = getText,
  timeoutMs = 10000,
  signal,
}) {
  if (!validPublicHost(host)) return { ok: false, reason: "invalid host" };
  try {
    const res = await get(host, "/login", {
      timeoutMs,
      signal,
      headers: { accept: "text/html" },
    });
    return loginVerdict(res.status, res.headers, res.text);
  } catch (error) {
    return failure(error);
  }
}
// ---- usage checks (Phase 2) -------------------------------------------------
// A paused Vercel deployment answers 503 with the code DEPLOYMENT_PAUSED (in the
// x-vercel-error header; the body is matched too in case the header is absent).
const PAUSED = "DEPLOYMENT_PAUSED";
export function isPaused(status, headers, text) {
  if (status !== 503) return false;
  const raw = headers?.["x-vercel-error"];
  const header = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  return (
    header.toUpperCase().includes(PAUSED) ||
    String(text ?? "")
      .slice(0, 65536)
      .includes(PAUSED)
  );
}
const SIZE_MAX = 1e12;
const size = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= SIZE_MAX
    ? Math.round(value)
    : null;
const fraction4 = (value) => Math.round(value * 10000) / 10000;
// The cafe's ?stats=1 body -> {code, bootstrap, clusters}. Untrusted: only
// known fields of known shapes are kept, the fraction is recomputed from bytes,
// rows with a bad name/role or a duplicate name are dropped, ≤ MAX_CLUSTERS.
export function parseStats(body) {
  const none = (code) => ({ code, bootstrap: false, clusters: [] });
  if (!body || typeof body !== "object") return none("stats-bad-body");
  if (body.stats === "denied") return none("stats-denied");
  if (body.stats === "error") return none("stats-error");
  if (!Array.isArray(body.clusters)) return none("stats-bad-body");
  const clusters = [];
  for (const row of body.clusters) {
    if (clusters.length >= MAX_CLUSTERS) break;
    if (!row || typeof row !== "object") continue;
    const { name, role } = row;
    if (typeof name !== "string" || !CLUSTER_NAME_RE.test(name)) continue;
    if (!CLUSTER_ROLES.includes(role)) continue;
    if (clusters.some((c) => c.name === name)) continue;
    const dataSize = size(row.dataSize);
    const indexSize = size(row.indexSize);
    let bytes = null;
    let usedPct = null;
    if (row.state === "ok") {
      if (dataSize !== null && indexSize !== null) {
        bytes = dataSize + indexSize;
        usedPct = fraction4(bytes / MONGO_LIMIT_BYTES);
      } else if (
        row.dataSize === undefined &&
        row.indexSize === undefined &&
        typeof row.usedPct === "number" &&
        Number.isFinite(row.usedPct) &&
        row.usedPct >= 0 &&
        row.usedPct <= 2
      )
        usedPct = fraction4(row.usedPct);
    }
    clusters.push({
      name,
      role,
      // The ledger tag (C, A, A2…), stored as `label`: a `tag` key reads as a
      // vault box to the response secret checks.
      label:
        typeof row.tag === "string" && CLUSTER_TAG_RE.test(row.tag)
          ? row.tag
          : null,
      active: row.active === true,
      paused: row.paused === true,
      state: usedPct === null ? "error" : "ok",
      usedPct,
      bytes,
    });
  }
  if (!clusters.length) return none("stats-bad-body");
  return { code: "ok", bootstrap: body.bootstrap === true, clusters };
}
const SITE_ERRORS = new Set(["timeout", "blocked", "too-large", "aborted"]);
const siteErrorCode = (error) =>
  SITE_ERRORS.has(error?.code) ? error.code : "no-response";
// One usage probe of GET /api/health (optionally ?stats=1 with the stats
// token) -> {state: up|down|paused, code, httpStatus, latencyMs, stats?}.
// Never throws; never returns anything the host said beyond fixed codes and
// the parsed stats. `stats` is present whenever stats were asked for.
export async function probeSite({
  host,
  tenantId,
  get = getText,
  stats = false,
  statsToken = null,
  timeoutMs = 10000,
  signal,
  now = () => performance.now(),
}) {
  const statsOf = (parsed) => (stats ? { stats: parsed } : {});
  const unavailable = {
    code: "stats-unavailable",
    bootstrap: false,
    clusters: [],
  };
  if (!validPublicHost(host))
    return {
      state: "down",
      code: "bad-host",
      httpStatus: 0,
      latencyMs: null,
      ...statsOf(unavailable),
    };
  const started = now();
  let res;
  try {
    res = await get(host, "/api/health", {
      timeoutMs,
      signal,
      headers: {
        accept: "application/json",
        ...(stats && statsToken ? { "x-stats-token": statsToken } : {}),
      },
      ...(stats ? { query: { stats: "1" } } : {}),
    });
  } catch (error) {
    return {
      state: "down",
      code: siteErrorCode(error),
      httpStatus: 0,
      latencyMs: null,
      ...statsOf(unavailable),
    };
  }
  const latencyMs = Math.max(0, Math.round(now() - started));
  const httpStatus = Number.isInteger(res.status) ? res.status : 0;
  if (isPaused(res.status, res.headers, res.text))
    return {
      state: "paused",
      code: "paused",
      httpStatus,
      latencyMs,
      ...statsOf(unavailable),
    };
  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = null;
  }
  if (!healthVerdict(res.status, body, tenantId).ok)
    return {
      state: "down",
      code:
        res.status !== 200
          ? body?.db === "down"
            ? "db-down"
            : "http-error"
          : body?.ok === true && body?.db === "up"
            ? "tenant-mismatch"
            : "bad-body",
      httpStatus,
      latencyMs,
      ...statsOf(unavailable),
    };
  if (!stats) return { state: "up", code: "ok", httpStatus, latencyMs };
  let parsed = parseStats(body);
  // Without a stored token "denied" means the POS requires one we do not have.
  if (parsed.code === "stats-denied" && !statsToken)
    parsed = { ...parsed, code: "stats-not-set" };
  return { state: "up", code: "ok", httpStatus, latencyMs, stats: parsed };
}

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Up to `attempts` health probes `intervalMs` apart; once healthy, the login
// page must pass too (same attempts budget for that part). Returns
// {ok, phase: "health" | "login", reason, attempts}.
export async function waitHealthy({
  host,
  tenantId,
  attempts = 12,
  intervalMs = 5000,
  sleep = sleepReal,
  get = getText,
  signal,
}) {
  let last = { ok: false, reason: "no response" };
  let used = 0;
  for (let i = 1; i <= attempts; i++) {
    if (signal?.aborted)
      return { ok: false, phase: "health", reason: "aborted", attempts: i - 1 };
    used = i;
    last = await probeHealth({ host, tenantId, get, signal });
    if (last.ok) break;
    if (i < attempts) await sleep(intervalMs);
  }
  if (!last.ok) return { ...last, phase: "health", attempts: used };
  for (let i = 1; i <= 3; i++) {
    last = await probeLogin({ host, get, signal });
    if (last.ok)
      return { ok: true, phase: "login", reason: "ok", attempts: used };
    if (i < 3) await sleep(intervalMs);
  }
  return { ...last, phase: "login", attempts: used };
}
