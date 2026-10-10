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
