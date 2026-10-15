// In-memory Vercel REST fake (a `fetch` for createVercel) with delayed
// deployment visibility (to test the meta lookup retry) and request-level
// failure injection (`rule`).
//
// Go-live surface (P5 Stage 3, shapes verified in spike S1; every response
// carries MORE fields than the adapter may keep, including env `value`s, so a
// leak shows up in tests):
//  - state.projects  Map id -> project. The default project (`projectId`, name
//    "demo") has a production deployment (targets.production). POST /v11/projects
//    creates one (409 when the name exists) with serverlessFunctionRegion and the
//    posted framework/rootDirectory, node "20.x" until PATCH /v9/projects/{id}
//    sets nodeVersion / sourceFilesOutsideRootDirectory. GET works by id or name.
//  - Env per project (state.envs is the default project's list;
//    envsOf(id) any project's): POST /v10/projects/{id}/env?upsert=true takes
//    an array, accepts blank values, replaces rows by key, and bumps
//    `updatedAt` (state.clock, +1000 per row) on EVERY upserted row, even with
//    the same value. Rows carry id, key, type, target[], value (returned for
//    encrypted rows too, as Vercel does), updatedAt and extra fields.
//    state.envFailKeys = keys that come back in failed[] (code "bad_request").
//    GET ...?decrypt is a test error.
//  - state.domains [{name, projectId, verified, verification[], redirect,
//    redirectStatusCode}]. POST /v10/projects/{id}/domains: 200 {verified: true}
//    at once (set state.newDomainsVerified = false for the TXT flow: the domain
//    is unverified with a verification[] TXT entry until state.verifyPasses is
//    true and POST .../verify is called; before that verify answers 400); 400
//    when it is already on this project; 409 when another project has it
//    (fake.domainOnOtherProject(name)). PATCH .../domains/{name} sets
//    redirect/redirectStatusCode. GET /v6/domains/{name}/config -> misconfigured
//    true until fake.configure(name) (then false, configuredBy "CNAME");
//    recommendedCNAME has 2 ranked entries, rank 2 listed FIRST.
//  - fake.addProject({name, production}) seeds another project.
import { json } from "./github.js";

const body = (init) => {
  try {
    return init.body ? JSON.parse(init.body) : undefined;
  } catch {
    return undefined;
  }
};
export const RANK1_CNAME = "5f0a9c2b7d13e468.vercel-dns-017.com.";

export function createFakeVercel({
  projectId = "prj_test1",
  teamId = "",
} = {}) {
  const calls = [];
  const rules = [];
  const state = {
    clock: 1_760_000_000_000, // env updatedAt source (ms)
    seq: 0,
    newDomainsVerified: true,
    verifyPasses: false,
    configured: new Set(), // domain names whose DNS is right
    domains: [],
    envFailKeys: new Set(),
    envsByProject: new Map(),
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
    token: { id: "tok_1", name: "sandbee-admin" }, // GET /v5/user/tokens/current
  };
  state.projects = new Map([[projectId, state.project]]);
  const projectBy = (ref) =>
    state.projects.get(ref) ??
    [...state.projects.values()].find((p) => p.name === ref);
  const envsOf = (pid) =>
    pid === projectId
      ? state.envs
      : (state.envsByProject.get(pid) ??
        state.envsByProject.set(pid, []).get(pid));
  const tick = () => (state.clock += 1000);
  const domainView = (d) => ({
    apexName: d.name.split(".").slice(-2).join("."),
    createdAt: 1_760_000_000_000,
    customEnvironmentId: null,
    gitBranch: null,
    name: d.name,
    projectId: d.projectId,
    redirect: d.redirect ?? null,
    redirectStatusCode: d.redirectStatusCode ?? null,
    updatedAt: 1_760_000_000_000,
    verified: d.verified,
    ...(d.verified ? {} : { verification: d.verification }),
  });
  const configView = (name) => ({
    aValues: ["76.76.21.21"],
    acceptedChallenges: ["dns-01", "http-01"],
    cnames: [],
    configuredBy: state.configured.has(name) ? "CNAME" : null,
    conflicts: [],
    ipStatus: null,
    misconfigured: !state.configured.has(name),
    nameservers: ["ns1.example.test"],
    recommendedCNAME: [
      { rank: 2, value: "cname.vercel-dns.com." },
      { rank: 1, value: RANK1_CNAME },
    ],
    recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
    serviceType: "external",
  });
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
    calls.push({ method, path: u.pathname, query, body: body(init) });
    const rule = rules.find((r) => r.left !== 0 && r.match(method, u.pathname));
    if (rule) {
      if (rule.left > 0) rule.left--;
      return rule.respond();
    }
    // Token metadata is per token, never per team (no teamId check).
    if (u.pathname === "/v5/user/tokens/current")
      return json(200, state.token ? { token: state.token } : {});
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
    const NOT_FOUND = () =>
      json(404, { error: { code: "not_found", message: "no" } });
    const sent = body(init);
    if (u.pathname === "/v11/projects" && method === "POST") {
      if (projectBy(sent?.name))
        return json(409, {
          error: { code: "conflict", message: "name SECRET-TEXT" },
        });
      const created = {
        id: `prj_new${++state.seq}`,
        name: sent.name,
        accountId: "team_x",
        framework: sent.framework ?? null,
        rootDirectory: sent.rootDirectory ?? null,
        nodeVersion: "20.x",
        sourceFilesOutsideRootDirectory: false,
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        serverlessFunctionRegion: sent.serverlessFunctionRegion ?? null,
        resourceConfig: {
          functionDefaultRegions: [sent.serverlessFunctionRegion ?? "iad1"],
        },
        targets: {},
        link: { token: "must-not-leak" },
      };
      state.projects.set(created.id, created);
      return json(200, created);
    }
    if ((m = u.pathname.match(/^\/v9\/projects\/([^/]+)$/))) {
      const p = projectBy(m[1]);
      if (!p) return NOT_FOUND();
      if (method === "PATCH") {
        for (const k of ["nodeVersion", "sourceFilesOutsideRootDirectory"])
          if (sent && k in sent) p[k] = sent[k];
      }
      return json(200, p);
    }
    if ((m = u.pathname.match(/^\/v10\/projects\/([^/]+)\/env$/))) {
      const p = projectBy(m[1]);
      if (!p) return NOT_FOUND();
      const rows = envsOf(p.id);
      if (method === "POST") {
        if (query.upsert !== "true" || !Array.isArray(sent))
          return json(400, { error: { code: "bad_request" } });
        const created = [];
        const failed = [];
        for (const e of sent) {
          if (state.envFailKeys.has(e.key)) {
            failed.push({
              error: { code: "bad_request", key: e.key, message: "TEXT" },
            });
            continue;
          }
          const at = tick();
          let row = rows.find((r) => r.key === e.key);
          if (!row) {
            row = { id: `env_${++state.seq}`, key: e.key, createdAt: at };
            rows.push(row);
          }
          Object.assign(row, {
            type: e.type,
            target: [...e.target],
            value: e.value,
            updatedAt: at,
            decrypted: false,
            createdBy: "u1",
            lastEditedByDisplayName: "Owner",
            securityIssues: [],
          });
          created.push({ ...row });
        }
        return json(201, { created, failed });
      }
      if (query.decrypt) throw new Error("must never decrypt");
      return json(200, { envs: rows });
    }
    if ((m = u.pathname.match(/^\/v9\/projects\/([^/]+)\/domains$/))) {
      const p = projectBy(m[1]);
      if (!p) return NOT_FOUND();
      return json(200, {
        domains: state.domains
          .filter((d) => d.projectId === p.id)
          .map(domainView),
      });
    }
    if ((m = u.pathname.match(/^\/v10\/projects\/([^/]+)\/domains$/))) {
      const p = projectBy(m[1]);
      if (!p) return NOT_FOUND();
      const had = state.domains.find((d) => d.name === sent?.name);
      if (had)
        return had.projectId === p.id
          ? json(400, { error: { code: "bad_request", message: "TEXT" } })
          : json(409, { error: { code: "domain_already_in_use" } });
      const d = {
        name: sent.name,
        projectId: p.id,
        verified: state.newDomainsVerified,
        verification: state.newDomainsVerified
          ? []
          : [
              {
                type: "TXT",
                domain: `_vercel.${sent.name.split(".").slice(1).join(".")}`,
                value: "vc-domain-verify=fake,0123456789abcdef",
                reason: "pending",
              },
            ],
      };
      state.domains.push(d);
      return json(200, domainView(d));
    }
    if (
      (m = u.pathname.match(
        /^\/v9\/projects\/([^/]+)\/domains\/([^/]+?)(\/verify)?$/,
      ))
    ) {
      const p = projectBy(m[1]);
      const d = p && state.domains.find((x) => x.name === m[2]);
      if (!d || d.projectId !== p.id) return NOT_FOUND();
      if (m[3]) {
        if (!d.verified && !state.verifyPasses)
          return json(400, {
            error: { code: "missing_txt_record", message: "TEXT" },
          });
        d.verified = true;
        d.verification = [];
      } else if (method === "PATCH") {
        d.redirect = sent?.redirect ?? null;
        d.redirectStatusCode = sent?.redirectStatusCode ?? null;
      }
      return json(200, domainView(d));
    }
    if ((m = u.pathname.match(/^\/v6\/domains\/([^/]+)\/config$/)))
      return json(200, configView(m[1]));
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
    envsOf,
    // Another project (default: no production deployment) -> its id.
    addProject({ name, production = false, id } = {}) {
      const pid = id ?? `prj_seed${++state.seq}`;
      state.projects.set(pid, {
        id: pid,
        name,
        accountId: "team_x",
        framework: "nextjs",
        rootDirectory: "apps/cafe",
        nodeVersion: "22.x",
        sourceFilesOutsideRootDirectory: true,
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
        targets: production ? { production: { id: "dpl_prod" } } : {},
      });
      return pid;
    },
    // The name is attached to a different project of the account.
    domainOnOtherProject(name) {
      state.domains.push({
        name,
        projectId: "prj_other",
        verified: true,
        verification: [],
      });
    },
    // DNS is right for the name: config answers misconfigured false.
    configure: (name, on = true) =>
      on ? state.configured.add(name) : state.configured.delete(name),
    rule: (match, respond, { times = 1 } = {}) =>
      rules.push({ match, respond, left: times }),
  };
}
