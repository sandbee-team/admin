// In-memory Cloudflare API fake.
//
// Stage 2/3 usage checks: token verify (user and account forms) and the GraphQL
// Analytics endpoint answering workersInvocationsAdaptive for the `today` and
// `yesterday` aliases.
//
// P5 Stage 3 (D46, shapes verified in spike S2): a stateful account with
//  - GET /accounts (needs `accountsGrant`, else 403/9109)
//  - GET/PUT /accounts/{id}/workers/subdomain (404/10007 until registered;
//    409/10036 for a name in `takenSubdomains`)
//  - GET /workers/services/{name} and GET /workers/scripts (migration tag)
//  - PUT /workers/scripts/{name} multipart (metadata + index.js; 412/10079
//    when migrations are re-sent at the current tag)
//  - GET /workers/scripts/{name}/settings (plain_text keeps its text, as the
//    real API does, so adapters must whitelist)
//  - POST /workers/scripts/{name}/subdomain (workers.dev on)
//  - `access`: "ok" | "future-403" (every account call 403/9109, verify still
//    "active") | "future-401" (401/10000)
// `send(options)` is the safe-https transport seam for the workers.dev probes
// (GET /join answers 426 only after `joinAfter` calls; signed POST /publish
// answers 200 for the right tenant + secret, 404 for another tenant, 401 for a
// wrong signature, 400 for a bad envelope). `calls` records method + path (+
// query/variables); `uploads` records each parsed upload; `probes` each probe.
import { createHmac } from "node:crypto";
import { SafeHttpsError } from "../../backend/lib/safe-https.js";
import { json } from "./github.js";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const CF_ERRORS = {
  noGrant: [403, 9109],
  future: [401, 10000],
};
const fail = (status, code) =>
  json(status, {
    success: false,
    errors: [{ code, message: "SECRET-PROVIDER-TEXT-do-not-leak" }],
    result: null,
  });
const ok = (result) => json(200, { success: true, errors: [], result });

export function createFakeCloudflare({
  verify = { status: "active" }, // null: the user form answers 401
  accountVerify = null, // null: the account form answers 404
  today = [0, 0], // [requests, errors]
  yesterday = [0, 0],
  todayRows, // explicit row arrays override the pairs
  yesterdayRows,
  graphql, // a full GraphQL body overrides everything
  graphqlStatus = 200,
  accountList = [{ id: ACCOUNT_ID, name: "Fake account" }],
  accountsGrant = true, // false: GET /accounts answers 403/9109
  access = "ok",
  subdomain = "fake-sub", // the account's workers.dev subdomain; null = none
  takenSubdomains = [],
  scripts = {}, // name -> {tag, bindings, compatibilityDate, workersDev}
  servicesShowTag = true, // false: only /workers/scripts carries the tag
  joinAfter = 0, // /join answers 404 for this many calls, then 426
} = {}) {
  const calls = [];
  const uploads = [];
  const probes = [];
  const state = {
    verify,
    accountVerify,
    today,
    yesterday,
    todayRows,
    yesterdayRows,
    graphql,
    graphqlStatus,
    accountList,
    accountsGrant,
    access,
    subdomain,
    takenSubdomains,
    scripts: { ...scripts },
    servicesShowTag,
    joinAfter,
    joinCalls: 0,
    uploadFail: null, // {status, code} forces the next upload failures
    failPaths: {}, // "METHOD /suffix" -> {status, code}
  };
  const rows = (explicit, pair) =>
    explicit ?? [{ sum: { requests: pair[0], errors: pair[1] } }];

  async function parseUpload(init) {
    const type = new Headers(init.headers).get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data")) return null;
    const form = await new Response(init.body, {
      headers: { "content-type": type },
    }).formData();
    const metaPart = form.get("metadata");
    const modulePart = form.get("index.js");
    if (!metaPart || !modulePart || typeof metaPart === "string") return null;
    return {
      fields: [...form.keys()],
      metadataType: metaPart.type,
      moduleType: modulePart.type,
      moduleName: modulePart.name,
      metadata: JSON.parse(await metaPart.text()),
      bundle: Buffer.from(await modulePart.arrayBuffer()),
      contentType: type,
    };
  }

  async function accountRoute(u, method, init, call) {
    if (state.access === "future-403") return fail(...CF_ERRORS.noGrant);
    if (state.access === "future-401") return fail(...CF_ERRORS.future);
    const rest = u.pathname.replace(/^\/client\/v4/, "");
    const forced = state.failPaths[`${method} ${rest}`];
    if (forced) return fail(forced.status, forced.code);
    if (rest === "/accounts" && method === "GET")
      return state.accountsGrant
        ? ok(state.accountList)
        : fail(...CF_ERRORS.noGrant);
    const m = rest.match(/^\/accounts\/([^/]+)\/(.+)$/);
    if (!m) return null;
    if (m[1] !== ACCOUNT_ID) return fail(403, 9109);
    const sub = m[2];
    if (sub === "workers/subdomain") {
      if (method === "GET")
        return state.subdomain
          ? ok({ subdomain: state.subdomain })
          : fail(404, 10007);
      if (method === "PUT") {
        const wanted = JSON.parse(init.body).subdomain;
        call.subdomain = wanted;
        if (state.takenSubdomains.includes(wanted)) return fail(409, 10036);
        state.subdomain = wanted;
        return ok({ subdomain: wanted });
      }
    }
    if (sub === "workers/scripts" && method === "GET")
      return ok(
        Object.entries(state.scripts).map(([id, s]) => ({
          id,
          migration_tag: s.tag,
          etag: "e1",
        })),
      );
    const svc = sub.match(/^workers\/services\/([^/]+)$/);
    if (svc && method === "GET") {
      const s = state.scripts[svc[1]];
      return s
        ? ok({
            id: svc[1],
            default_environment: {
              environment: "production",
              script: state.servicesShowTag ? { migration_tag: s.tag } : {},
            },
          })
        : fail(404, 10090);
    }
    const script = sub.match(
      /^workers\/scripts\/([^/]+)(\/settings|\/subdomain)?$/,
    );
    if (!script) return null;
    const [, name, tail] = script;
    if (!tail && method === "PUT") {
      if (state.uploadFail)
        return fail(state.uploadFail.status, state.uploadFail.code);
      const upload = await parseUpload(init);
      if (!upload) return fail(400, 10021);
      call.upload = { name, fields: upload.fields };
      const existing = state.scripts[name];
      const mig = upload.metadata.migrations;
      if (mig && (existing ? mig.old_tag !== existing.tag : mig.old_tag))
        return fail(412, 10079);
      uploads.push({ name, ...upload }); // only accepted uploads are recorded
      const bindings = upload.metadata.bindings ?? [];
      state.scripts[name] = {
        tag: mig?.new_tag ?? existing?.tag ?? null,
        bindings,
        compatibilityDate: upload.metadata.compatibility_date ?? null,
        workersDev: existing?.workersDev ?? false,
      };
      return ok({ id: name, etag: "e2", has_modules: true });
    }
    const s = state.scripts[name];
    if (tail === "/settings" && method === "GET") {
      if (!s) return fail(404, 10007);
      return ok({
        bindings: s.bindings.map(
          (b) =>
            b.type === "secret_text"
              ? { name: b.name, type: b.type }
              : { ...b }, // plain_text keeps its text, as the real API does
        ),
        compatibility_date: s.compatibilityDate,
        compatibility_flags: [],
        usage_model: "standard",
      });
    }
    if (tail === "/subdomain" && method === "POST") {
      if (!s) return fail(404, 10007);
      const body = JSON.parse(init.body);
      call.body = body;
      s.workersDev = body.enabled === true;
      return ok({ enabled: s.workersDev, previews_enabled: false });
    }
    return null;
  }

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
    if (u.pathname.startsWith("/client/v4/accounts")) {
      const routed = await accountRoute(u, method, init, call);
      if (routed) return routed;
    }
    return json(404, { success: false });
  }

  // The workers.dev probes through safe-https' `send` seam. An unknown host
  // (script not served on workers.dev, wrong subdomain) is a connect failure.
  async function send(options) {
    const host = options.hostname;
    const hit = Object.entries(state.scripts).find(
      ([name, s]) =>
        s.workersDev && host === `${name}.${state.subdomain}.workers.dev`,
    );
    probes.push({
      host,
      path: options.path,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    if (!hit) throw new SafeHttpsError("network");
    const [, script] = hit;
    const reply = (status, text = "") => ({
      status,
      headers: {},
      text,
    });
    if (options.path === "/join" && options.method === "GET") {
      state.joinCalls += 1;
      return reply(state.joinCalls > state.joinAfter ? 426 : 404);
    }
    if (options.path === "/publish" && options.method === "POST") {
      const secret = script.bindings.find(
        (b) => b.name === "REALTIME_PUBLISH_SECRET",
      )?.text;
      const tenant = script.bindings.find((b) => b.name === "TENANT_ID")?.text;
      const h = options.headers;
      let body;
      try {
        body = JSON.parse(options.body);
      } catch {
        return reply(400);
      }
      if (!body || typeof body.tenant !== "string" || !body.kind)
        return reply(400);
      if (body.tenant !== tenant) return reply(404); // S2: tenants isolated
      const want = createHmac("sha256", secret ?? "")
        .update(`${h["x-realtime-ts"]}.${options.body}`)
        .digest("hex");
      return h["x-realtime-signature"] === want
        ? reply(200, '{"ok":true}')
        : reply(401);
    }
    return reply(404);
  }
  return { fetch, send, calls, uploads, probes, state };
}
