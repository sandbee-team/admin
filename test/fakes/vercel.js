// In-memory Vercel REST fake with delayed deployment visibility (to test the
// meta lookup retry) and request-level failure injection.
import { json } from "./github.js";

export function createFakeVercel({
  projectId = "prj_test1",
  teamId = "",
} = {}) {
  const calls = [];
  const rules = [];
  const state = {
    deployments: [],
    hiddenPolls: 0, // /v6 list calls that still show nothing
    envs: [
      {
        key: "TENANT_ID",
        type: "plain",
        target: ["production"],
        value: "demo",
      },
      {
        key: "MONGODB_URI",
        type: "encrypted",
        target: ["production"],
        value: "ENCRYPTEDBLOB",
      },
    ],
    project: {
      id: projectId,
      name: "demo",
      accountId: "team_x",
      framework: "nextjs",
      rootDirectory: "apps/cafe",
      nodeVersion: "22.x",
      sourceFilesOutsideRootDirectory: true,
      installCommand: null,
      buildCommand: null,
      outputDirectory: null,
      targets: { production: { id: "dpl_live" } },
      lastAliasRequest: {
        toDeploymentId: "dpl_live",
        jobStatus: "succeeded",
        type: "promote",
        secretExtra: "x",
      },
    },
    pages: null, // optional [{deployments, next}] for pagination
  };
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (u.host !== "api.vercel.com") throw new TypeError("unexpected host");
    if (init.redirect !== "manual") throw new Error("redirect must be manual");
    if (!/^Bearer \S+$/.test(headers.authorization ?? ""))
      throw new Error("missing token");
    const query = Object.fromEntries(u.searchParams);
    calls.push({ method, path: u.pathname, query });
    const rule = rules.find((r) => r.left !== 0 && r.match(method, u.pathname));
    if (rule) {
      if (rule.left > 0) rule.left--;
      return rule.respond();
    }
    if (teamId && query.teamId !== teamId)
      return json(403, { error: { code: "forbidden" } });
    let m;
    if (u.pathname === "/v2/user")
      return json(200, {
        user: {
          id: "u1",
          username: "owner",
          email: "private@example.test",
          defaultTeamId: null,
        },
      });
    if ((m = u.pathname.match(/^\/v9\/projects\/([^/]+)$/)))
      return m[1] === projectId
        ? json(200, state.project)
        : json(404, { error: { code: "not_found", message: "no" } });
    if (u.pathname === `/v10/projects/${projectId}/env`) {
      if (query.decrypt) throw new Error("must never decrypt");
      return json(200, { envs: state.envs });
    }
    if ((m = u.pathname.match(/^\/v13\/deployments\/([^/]+)$/))) {
      const d = state.deployments.find((x) => x.uid === m[1] || x.url === m[1]);
      if (method === "DELETE")
        return d
          ? json(200, { uid: d.uid, state: "DELETED" })
          : json(404, { error: { code: "not_found" } });
      return d
        ? json(200, {
            ...d,
            id: d.uid,
            readyState: d.state,
            aliasAssigned: false,
            creator: { email: "private@example.test" },
          })
        : json(404, { error: { code: "not_found" } });
    }
    if (u.pathname === "/v6/deployments" || u.pathname === "/v7/deployments") {
      if (u.pathname === "/v6/deployments" && state.hiddenPolls > 0) {
        state.hiddenPolls--;
        return json(200, { deployments: [] });
      }
      if (state.pages) {
        const at = query.until
          ? state.pages.findIndex((p) => String(p.after) === query.until)
          : 0;
        const page = state.pages[at] ?? { deployments: [] };
        return json(200, {
          deployments: page.deployments,
          pagination: page.next ? { next: page.next } : {},
        });
      }
      return json(200, { deployments: state.deployments, pagination: {} });
    }
    if (/^\/v10\/projects\/[^/]+\/promote\/[^/]+$/.test(u.pathname))
      return json(201, {});
    if (/^\/v1\/projects\/[^/]+\/rollback\/[^/]+$/.test(u.pathname))
      return json(201, {});
    return json(404, { error: { code: "not_found" } });
  }
  return {
    fetch,
    calls,
    state,
    rule: (match, respond, { times = 1 } = {}) =>
      rules.push({ match, respond, left: times }),
  };
}
