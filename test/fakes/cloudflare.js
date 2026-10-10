// In-memory Cloudflare API fake: token verify (user and account forms) and the
// GraphQL Analytics endpoint answering workersInvocationsAdaptive for the
// `today` and `yesterday` aliases. Records method, path, query and variables.
import { json } from "./github.js";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export function createFakeCloudflare({
  verify = { status: "active" }, // null: the user form answers 401
  accountVerify = null, // null: the account form answers 404
  today = [0, 0], // [requests, errors]
  yesterday = [0, 0],
  todayRows, // explicit row arrays override the pairs
  yesterdayRows,
  graphql, // a full GraphQL body overrides everything
  graphqlStatus = 200,
} = {}) {
  const calls = [];
  const state = {
    verify,
    accountVerify,
    today,
    yesterday,
    todayRows,
    yesterdayRows,
    graphql,
    graphqlStatus,
  };
  const rows = (explicit, pair) =>
    explicit ?? [{ sum: { requests: pair[0], errors: pair[1] } }];
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (u.host !== "api.cloudflare.com") throw new TypeError("unexpected host");
    if (init.redirect !== "manual") throw new Error("redirect must be manual");
    if (!/^Bearer \S+$/.test(headers.authorization ?? ""))
      throw new Error("missing token");
    const call = { method, path: u.pathname };
    calls.push(call);
    if (u.pathname === "/client/v4/user/tokens/verify")
      return state.verify
        ? json(200, { success: true, result: { id: "t1", ...state.verify } })
        : json(401, { success: false, errors: [{ code: 1000 }] });
    const m = u.pathname.match(
      /^\/client\/v4\/accounts\/([^/]+)\/tokens\/verify$/,
    );
    if (m)
      return state.accountVerify && m[1] === ACCOUNT_ID
        ? json(200, {
            success: true,
            result: { id: "t2", ...state.accountVerify },
          })
        : json(404, { success: false });
    if (u.pathname === "/client/v4/graphql" && method === "POST") {
      const body = JSON.parse(init.body);
      call.query = body.query;
      call.variables = body.variables;
      if (state.graphqlStatus !== 200)
        return json(state.graphqlStatus, {
          data: null,
          errors: [{ message: "denied" }],
        });
      if (state.graphql) return json(200, state.graphql);
      return json(200, {
        data: {
          viewer: {
            accounts: [
              {
                today: rows(state.todayRows, state.today),
                yesterday: rows(state.yesterdayRows, state.yesterday),
              },
            ],
          },
        },
        errors: null,
      });
    }
    return json(404, { success: false });
  }
  return { fetch, calls, state };
}
