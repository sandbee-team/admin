// Cloudflare token verification: user-owned tokens and account-owned tokens
// verify at different endpoints, so the user form is tried first and the
// account form second (when an account id is known). Only status and expiry
// are returned. Plus the Worker request counts of a client account (GraphQL
// Analytics, usage checks): the query text is a constant, inputs travel only
// as GraphQL variables.
import { ProviderError, request } from "./provider-http.js";
import { utcDayStart } from "../../shared/usage.js";

const ACCOUNT_RE = /^[a-f0-9]{32}$/;
const FALLBACK = new Set(["unauthorized", "forbidden", "not-found", "invalid"]);
const STATUSES = new Set(["active", "disabled", "expired"]);
const expiry = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
// -> {ok, form: "user"|"account"|null, status: active|disabled|expired|null,
//     expiresOn: ms|null (null = no expiry or unknown)}
export async function tokenStatus(
  token,
  accountId = "",
  { fetch: fetchImpl, signal, sleep } = {},
) {
  if (accountId && !ACCOUNT_RE.test(accountId))
    throw new ProviderError("cloudflare", "invalid");
  const attempt = async (path) => {
    const { json } = await request({
      provider: "cloudflare",
      path,
      token,
      fetch: fetchImpl,
      signal,
      sleep,
    });
    const status = STATUSES.has(json?.result?.status)
      ? json.result.status
      : null;
    return {
      active: json?.success === true && status === "active",
      status,
      expiresOn: expiry(json?.result?.expires_on),
    };
  };
  let seen = null;
  const notOk = () => ({
    ok: false,
    form: null,
    status: seen?.status ?? null,
    expiresOn: seen?.expiresOn ?? null,
  });
  try {
    const user = await attempt("/user/tokens/verify");
    if (user.active)
      return {
        ok: true,
        form: "user",
        status: user.status,
        expiresOn: user.expiresOn,
      };
    seen = user;
  } catch (error) {
    if (!(error instanceof ProviderError && FALLBACK.has(error.code)))
      throw error;
  }
  if (!accountId) return notOk();
  try {
    const account = await attempt(`/accounts/${accountId}/tokens/verify`);
    if (account.active)
      return {
        ok: true,
        form: "account",
        status: account.status,
        expiresOn: account.expiresOn,
      };
    seen = seen ?? account;
    return notOk();
  } catch (error) {
    if (error instanceof ProviderError && FALLBACK.has(error.code))
      return notOk();
    throw error;
  }
}
// -> {ok, form}; unchanged contract for the Stage 2 verify task.
export async function verifyToken(token, accountId = "", options = {}) {
  const { ok, form } = await tokenStatus(token, accountId, options);
  return { ok, form };
}

// ---- realtime Worker over the REST API (P5 Stage 3, D46; spike S2) ------------
// Every function takes the token first and `{fetch, signal, sleep}` last (the
// test seams). Paths are built from validated ids only; responses are
// whitelisted (ids, names, types, booleans) and provider text, the token and
// the publish secret never leave this module.
const SCRIPT_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TAG_RE = /^[A-Za-z0-9_-]{1,32}$/;
const BINDING_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BINDING_TYPE_RE = /^[a-z_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACCOUNTS = 20;
const MAX_BINDINGS = 50;
const NOT_ALLOWED = new Set(["unauthorized", "forbidden", "denied"]);
export const MAX_UPLOAD_BYTES = 1024 * 1024; // the bundle (D46: ≤ 1 MB)
// Cloudflare: 9109 = the token has no usable grant for this call; 10079 =
// migrations re-sent at the script's current tag.
const CF_NO_GRANT = 9109;
const CF_MIGRATION_REFUSED = 10079;
const invalid = () => new ProviderError("cloudflare", "invalid");
const accountPath = (accountId) => {
  if (!ACCOUNT_RE.test(accountId ?? "")) throw invalid();
  return `/accounts/${accountId}`;
};
const scriptPath = (accountId, name) => {
  if (typeof name !== "string" || !SCRIPT_RE.test(name)) throw invalid();
  return `${accountPath(accountId)}/workers/scripts/${name}`;
};
const coded = (code) => Object.assign(new Error(code), { code });
// A 403 carrying 9109 is a token without the needed permission ("denied"),
// not a rate limit or an unknown refusal.
const deniedIfNoGrant = (error) =>
  error instanceof ProviderError &&
  error.code === "forbidden" &&
  error.providerCodes.includes(CF_NO_GRANT)
    ? new ProviderError("cloudflare", "denied", {
        status: error.status,
        providerCodes: error.providerCodes,
      })
    : error;
const api = async (token, path, options) => {
  try {
    return await request({ provider: "cloudflare", token, path, ...options });
  } catch (error) {
    throw deniedIfNoGrant(error);
  }
};
const pick = (opts) => ({
  fetch: opts?.fetch,
  signal: opts?.signal,
  sleep: opts?.sleep,
});

// -> [{id}] (at most 20, 32-hex ids only). Needs Account Settings: Read; a
// token without a grant is ProviderError "denied" (cloudflare-denied).
export async function accounts(token, opts = {}) {
  const { json } = await api(token, "/accounts", pick(opts));
  if (!Array.isArray(json?.result)) throw bad();
  return json.result
    .filter((row) => ACCOUNT_RE.test(row?.id ?? ""))
    .slice(0, MAX_ACCOUNTS)
    .map((row) => ({ id: row.id }));
}

// -> {subdomain: string|null} (null = none registered yet).
export async function workersSubdomain(token, accountId, opts = {}) {
  try {
    const { json } = await api(
      token,
      `${accountPath(accountId)}/workers/subdomain`,
      pick(opts),
    );
    const value = json?.result?.subdomain;
    if (value === undefined || value === null || value === "")
      return { subdomain: null };
    if (typeof value !== "string" || !SUBDOMAIN_RE.test(value)) throw bad();
    return { subdomain: value };
  } catch (error) {
    if (error instanceof ProviderError && error.code === "not-found")
      return { subdomain: null };
    throw error;
  }
}

// PUT the account's workers.dev subdomain -> {subdomain}. A name somebody else
// holds is ProviderError "conflict" (the caller tries the next candidate).
export async function registerWorkersSubdomain(
  token,
  accountId,
  subdomain,
  opts = {},
) {
  if (typeof subdomain !== "string" || !SUBDOMAIN_RE.test(subdomain))
    throw invalid();
  await api(token, `${accountPath(accountId)}/workers/subdomain`, {
    ...pick(opts),
    method: "PUT",
    body: { subdomain },
    idempotent: false,
  });
  return { subdomain };
}

// The migration tag a deployed script has run up to, or null (no script yet).
// `/workers/services/{name}` first, then the `/workers/scripts` list row.
export async function workerMigrationTag(token, accountId, name, opts = {}) {
  const path = scriptPath(accountId, name).replace(
    "/workers/scripts/",
    "/workers/services/",
  );
  const tagOf = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !TAG_RE.test(value)) throw bad();
    return value;
  };
  let tag = null;
  try {
    const { json } = await api(token, path, pick(opts));
    tag = tagOf(json?.result?.default_environment?.script?.migration_tag);
  } catch (error) {
    if (!(error instanceof ProviderError && error.code === "not-found"))
      throw error;
  }
  if (tag) return tag;
  try {
    const { json } = await api(
      token,
      `${accountPath(accountId)}/workers/scripts`,
      pick(opts),
    );
    if (!Array.isArray(json?.result)) throw bad();
    const row = json.result.find((r) => r?.id === name);
    return row ? tagOf(row.migration_tag) : null;
  } catch (error) {
    if (error instanceof ProviderError && error.code === "not-found")
      return null;
    throw error;
  }
}

// Upload the bundle: PUT multipart `metadata` (JSON) + `index.js`
// (application/javascript+module), exactly as spike S2 sent it. One attempt
// only: a retry after a lost answer would re-send the migrations. Returns
// {name}. Failures: code "realtime-upload-failed" (an Error with `.code`) for
// 412/10079 and for a refused script (400/409/422), a ProviderError for the
// rest (cloudflare-unauthorized/forbidden/denied/rate-limited/unavailable/
// timeout/network).
export async function uploadWorker(
  token,
  { accountId, name, bundle, metadata },
  opts = {},
) {
  const path = scriptPath(accountId, name);
  if (
    !(bundle instanceof Uint8Array) ||
    bundle.length < 1 ||
    bundle.length > MAX_UPLOAD_BYTES ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.main_module !== "index.js"
  )
    throw invalid();
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  form.set(
    "index.js",
    new Blob([bundle], { type: "application/javascript+module" }),
    "index.js",
  );
  try {
    await api(token, path, {
      ...pick(opts),
      method: "PUT",
      form,
      timeoutMs: 60000,
      idempotent: false,
    });
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    if (
      error.status === 412 ||
      error.providerCodes.includes(CF_MIGRATION_REFUSED) ||
      ["invalid", "conflict", "rejected"].includes(error.code)
    )
      throw coded("realtime-upload-failed");
    throw error;
  }
  return { name };
}

// Serve the script on <name>.<subdomain>.workers.dev -> {enabled: true}.
export async function enableWorkersDev(token, accountId, name, opts = {}) {
  await api(token, `${scriptPath(accountId, name)}/subdomain`, {
    ...pick(opts),
    method: "POST",
    body: { enabled: true, previews_enabled: false },
    idempotent: true, // setting a flag again changes nothing
  });
  return { enabled: true };
}

// Binding names/types and the compatibility date of a deployed script, for
// verification only: values (the tenant text, secrets) are never returned.
// -> {bindings: [{name, type}], compatibilityDate: string|null}
export async function scriptSettings(token, accountId, name, opts = {}) {
  const { json } = await api(
    token,
    `${scriptPath(accountId, name)}/settings`,
    pick(opts),
  );
  const rows = json?.result?.bindings;
  if (rows !== undefined && !Array.isArray(rows)) throw bad();
  const date = json?.result?.compatibility_date;
  return {
    bindings: (rows ?? [])
      .filter(
        (b) =>
          typeof b?.name === "string" &&
          BINDING_NAME_RE.test(b.name) &&
          typeof b?.type === "string" &&
          BINDING_TYPE_RE.test(b.type),
      )
      .slice(0, MAX_BINDINGS)
      .map((b) => ({ name: b.name, type: b.type })),
    compatibilityDate:
      typeof date === "string" && DATE_RE.test(date) ? date : null,
  };
}

// Does the token reach the ACCOUNT? `/user/tokens/verify` alone is not proof:
// a token that only becomes valid in the future verifies "active" yet every
// account call fails (S2). With a stored account id the account's
// workers/subdomain is read, else `/accounts` is listed.
// -> {ok: true, accountIds: [...], subdomain} | {ok: false, code} where code is
// the bare provider code ("unauthorized", "forbidden", "denied", "not-found")
// the caller prefixes with `cloudflare-`. Other failures (network, 5xx,
// rate limit) throw the ProviderError.
export async function tokenAccess(token, accountId = "", opts = {}) {
  try {
    if (accountId) {
      accountPath(accountId);
      const { subdomain } = await workersSubdomain(token, accountId, opts);
      return { ok: true, accountIds: [accountId], subdomain };
    }
    const list = await accounts(token, opts);
    return { ok: true, accountIds: list.map((a) => a.id), subdomain: null };
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (NOT_ALLOWED.has(error.code) || error.code === "not-found")
    )
      return { ok: false, code: error.code };
    throw error;
  }
}

// Workers Free counts requests per ACCOUNT per UTC day, so the whole account is
// queried (no script filter): today so far and yesterday's total in one call.
const WORKER_REQUESTS_QUERY = `query SandbeeWorkerRequests($account: string, $todayFrom: string, $todayTo: string, $yesterdayFrom: string, $yesterdayTo: string) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      today: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $todayFrom, datetime_leq: $todayTo }) { sum { requests errors } }
      yesterday: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $yesterdayFrom, datetime_leq: $yesterdayTo }) { sum { requests errors } }
    }
  }
}`;
const COUNT_MAX = 1e12;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const bad = () => new ProviderError("cloudflare", "bad-response");
const countOf = (value, required) => {
  if (value === undefined && !required) return 0;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > COUNT_MAX
  )
    throw bad();
  return Math.round(value);
};
const totalOf = (rows) => {
  if (!Array.isArray(rows)) throw bad();
  let requests = 0;
  let errors = 0;
  for (const row of rows) {
    requests += countOf(row?.sum?.requests, true);
    errors += countOf(row?.sum?.errors, false);
  }
  return { requests, errors };
};
// -> {today: {requests, errors}, yesterday: {requests, errors}}. A GraphQL
// permission error is ProviderError "denied" (token lacks Account Analytics:
// Read); any other GraphQL error or shape is "bad-response".
export async function workerRequests(
  token,
  accountId,
  { now, fetch: fetchImpl, signal, sleep } = {},
) {
  if (!ACCOUNT_RE.test(accountId ?? "") || !Number.isFinite(now))
    throw new ProviderError("cloudflare", "invalid");
  const todayFrom = utcDayStart(now);
  const { json } = await request({
    provider: "cloudflare",
    method: "POST",
    path: "/graphql",
    token,
    body: {
      query: WORKER_REQUESTS_QUERY,
      variables: {
        account: accountId,
        todayFrom: iso(todayFrom),
        todayTo: iso(Math.floor(now / 1000) * 1000),
        yesterdayFrom: iso(todayFrom - 86400000),
        yesterdayTo: iso(todayFrom - 1000),
      },
    },
    idempotent: true, // a read; safe to retry
    fetch: fetchImpl,
    signal,
    sleep,
  });
  if (Array.isArray(json?.errors) && json.errors.length) {
    const authz = json.errors.some(
      (e) =>
        e?.extensions?.code === "authz" ||
        /not authori[sz]ed|does not have access|authz/i.test(
          String(e?.message ?? ""),
        ),
    );
    throw new ProviderError("cloudflare", authz ? "denied" : "bad-response");
  }
  const accounts = json?.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) throw bad();
  // A token that cannot see the account gets no account row back.
  if (!accounts.length) throw new ProviderError("cloudflare", "denied");
  if (accounts.length !== 1) throw bad();
  return {
    today: totalOf(accounts[0]?.today),
    yesterday: totalOf(accounts[0]?.yesterday),
  };
}
