// Health probe for a POS host with the same verdict as the local go-live
// console: GET /api/health must be 200 with ok:true, db:"up" and the expected
// tenant. On top of that /login must answer 200 HTML, which proves the edge
// middleware routes the tenant (the health path is not covered by it).
import { getText, validPublicHost } from "./safe-https.js";

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
