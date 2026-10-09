// One door to the three provider APIs (GitHub, Vercel, Cloudflare). Fixed
// base URLs only, no redirects, hard timeouts, bounded reads, retries for
// idempotent calls. Failures become a ProviderError with a fixed message and a
// code: neither response bodies nor request details (tokens, URLs with
// secrets) ever reach a message, a property or a log.
export const BASES = Object.freeze({
  github: "https://api.github.com",
  vercel: "https://api.vercel.com",
  cloudflare: "https://api.cloudflare.com/client/v4",
});
const NAMES = { github: "GitHub", vercel: "Vercel", cloudflare: "Cloudflare" };
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;
const RETRY_MS = [2000, 5000, 10000];
const MAX_RETRY_AFTER_MS = 30000;
const CODE_RE = /^[a-z_]{1,40}$/;
export class ProviderError extends Error {
  constructor(
    provider,
    code,
    { status = 0, retryable = false, providerCode = "", retryAfterMs = 0 } = {},
  ) {
    super(`${NAMES[provider] ?? "Provider"} request failed (${code})`);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    // A provider's own error code, kept only when it is a short snake_case token.
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
  }
}
const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function retryAfterOf(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return 0;
  if (/^\d{1,6}$/.test(raw.trim())) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}
export function codeForStatus(provider, status, headers) {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate-limited";
  if (status === 403)
    return headers.get("x-ratelimit-remaining") === "0" ||
      headers.get("retry-after")
      ? "rate-limited"
      : "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 422) return "invalid";
  if (status >= 500) return "unavailable";
  if (status >= 300 && status < 400) return "redirect";
  return "rejected";
}
async function readCapped(response, maxBytes) {
  if (!response.body) return null;
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    parts.push(Buffer.from(value));
  }
  return { buffer: Buffer.concat(parts) };
}
const CONTROL = /[\u0000-\u001f\u007f]/;
// Builds the request URL from a fixed base: the path may only be a plain
// absolute path, so no input can change the host.
export function urlFor(provider, path, query = {}) {
  const base = BASES[provider];
  if (!base) throw new ProviderError(provider, "invalid");
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\@]|:\/\/|%2e|%2f|%5c/i.test(path) ||
    path.split("/").some((part) => part === ".." || part === ".") ||
    CONTROL.test(path)
  )
    throw new ProviderError(provider, "invalid");
  const url = new URL(base + path);
  const fixed = new URL(base);
  if (url.origin !== fixed.origin || !url.pathname.startsWith(fixed.pathname))
    throw new ProviderError(provider, "invalid");
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  return url;
}
// request({provider, path, ...}) -> {status, json, headers, location}
//  - idempotent: retry 429/5xx/network (default: GET and HEAD)
//  - followRedirect: return a 3xx (with `location`) instead of failing; used
//    only for the GitHub artifact download, which validates the target itself
export async function request({
  provider,
  path,
  query,
  method = "GET",
  token,
  body,
  timeoutMs = 30000,
  signal,
  fetch: fetchImpl = globalThis.fetch,
  sleep = sleepReal,
  idempotent = method === "GET" || method === "HEAD",
  maxBytes = MAX_RESPONSE_BYTES,
  followRedirect = false,
  headers: extra = {},
  retryDelays = RETRY_MS,
}) {
  const url = urlFor(provider, path, query);
  if (typeof token !== "string" || token.length < 8 || CONTROL.test(token))
    throw new ProviderError(provider, "invalid");
  const limit = Math.min(maxBytes, HARD_MAX_BYTES);
  const headers = {
    authorization: `Bearer ${token}`,
    "user-agent": "sandbee-admin",
    accept:
      provider === "github"
        ? "application/vnd.github+json"
        : "application/json",
    ...(provider === "github" ? { "x-github-api-version": "2022-11-28" } : {}),
    ...Object.fromEntries(
      Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const outcome = await once();
    if (outcome.error) {
      const error = outcome.error;
      const wait = retryDelays[attempt];
      const canRetry =
        idempotent &&
        error.retryable &&
        wait !== undefined &&
        !signal?.aborted &&
        error.retryAfterMs <= MAX_RETRY_AFTER_MS;
      if (!canRetry) throw error;
      await sleep(Math.max(wait, error.retryAfterMs));
      continue;
    }
    return outcome.value;
  }
  async function once() {
    let response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: "manual",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted)
        return { error: new ProviderError(provider, "aborted") };
      return {
        error: new ProviderError(
          provider,
          error?.name === "TimeoutError" ? "timeout" : "network",
          { retryable: true },
        ),
      };
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => {});
      if (followRedirect && [301, 302, 303, 307, 308].includes(status))
        return {
          value: {
            status,
            json: null,
            headers: response.headers,
            location: response.headers.get("location"),
          },
        };
      return { error: new ProviderError(provider, "redirect", { status }) };
    }
    let read;
    try {
      read = await readCapped(response, response.ok ? limit : ERROR_BODY_BYTES);
    } catch (error) {
      if (signal?.aborted)
        return { error: new ProviderError(provider, "aborted") };
      return {
        error: new ProviderError(
          provider,
          error?.name === "TimeoutError" ? "timeout" : "network",
          { status, retryable: true },
        ),
      };
    }
    const type = response.headers.get("content-type") ?? "";
    let json = null;
    if (read?.buffer?.length && type.includes("json")) {
      try {
        json = JSON.parse(read.buffer.toString("utf8"));
      } catch {
        json = undefined;
      }
    }
    if (!response.ok) {
      const code = codeForStatus(provider, status, response.headers);
      const kept = json?.error?.code;
      return {
        error: new ProviderError(provider, code, {
          status,
          retryable: code === "rate-limited" || code === "unavailable",
          retryAfterMs: retryAfterOf(response.headers),
          providerCode:
            typeof kept === "string" && CODE_RE.test(kept) ? kept : "",
        }),
      };
    }
    if (read?.tooLarge)
      return { error: new ProviderError(provider, "too-large", { status }) };
    if (json === undefined)
      return { error: new ProviderError(provider, "bad-response", { status }) };
    return {
      value: { status, json, headers: response.headers, location: null },
    };
  }
}
