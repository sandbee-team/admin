// In-memory GitHub REST fake: routes by method and path, records every call
// and checks the invariants the adapter must keep (fixed host, manual
// redirects, a bearer token on API calls and none on the blob download).
import { createHash } from "node:crypto";

export const SRC = "owner/source";
export const BLD = "owner/builder";
export const BLOB_HOST = "abcd1234.blob.core.windows.net";
export const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const sha = (n) => String(n).padStart(40, "0");
export const SHAS = { a: sha(1), b: sha(2), c: sha(3) };
export function createFakeGitHub() {
  const calls = [];
  const rules = [];
  const state = {
    dispatchMode: "200", // "200" | "204" | "204-invisible"
    nextRunId: 5001,
    runs: new Map(),
    artifacts: new Map(), // id -> {meta, runId, body}
    blobStatus: 200,
    blobLocation: null,
    blobBody: null,
    blobCalls: [],
    branches: [
      {
        name: "main",
        sha: SHAS.a,
        message: "Main headline\nbody line",
        date: "2026-10-01T10:00:00Z",
      },
      {
        name: "feature/x",
        sha: SHAS.b,
        message: "Feature work",
        date: "2026-10-05T10:00:00Z",
      },
    ],
    compare: { status: "ahead", ahead_by: 2, behind_by: 0 },
  };
  const commitBody = (b) => ({
    sha: b.sha,
    commit: {
      message: b.message,
      author: { name: "Dev Person", email: "dev@example.test", date: b.date },
    },
  });
  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (u.host !== "api.github.com") {
      state.blobCalls.push({ host: u.host, headers, redirect: init.redirect });
      if (init.redirect !== "error")
        throw new Error("blob fetch must refuse redirects");
      if (headers.authorization)
        throw new Error("blob fetch must not carry credentials");
      if (typeof state.blobBody === "function") return state.blobBody();
      return new Response(state.blobBody, { status: state.blobStatus });
    }
    if (init.redirect !== "manual")
      throw new Error("api redirect must be manual");
    if (!/^Bearer \S+$/.test(headers.authorization ?? ""))
      throw new Error("missing token");
    const path = u.pathname;
    calls.push({
      method,
      path,
      query: Object.fromEntries(u.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
      token: headers.authorization.slice(7),
    });
    const rule = rules.find((r) => r.left !== 0 && r.match(method, path));
    if (rule) {
      if (rule.left > 0) rule.left--;
      if (rule.throws) throw rule.throws;
      return rule.respond();
    }
    let m;
    if (method === "GET" && path === `/repos/${SRC}/branches`)
      return json(
        200,
        state.branches.map((b) => ({ name: b.name, commit: { sha: b.sha } })),
      );
    if (
      method === "GET" &&
      (m = path.match(new RegExp(`^/repos/${SRC}/branches/(.+)$`)))
    ) {
      const b = state.branches.find((x) => x.name === decodeURIComponent(m[1]));
      return b
        ? json(200, { name: b.name, commit: commitBody(b) })
        : json(404, { message: "Branch not found" });
    }
    if (
      method === "GET" &&
      (m = path.match(new RegExp(`^/repos/${SRC}/commits/([0-9a-f]{40})$`)))
    ) {
      const b = state.branches.find((x) => x.sha === m[1]);
      return b ? json(200, commitBody(b)) : json(404, { message: "none" });
    }
    if (method === "GET" && path.startsWith(`/repos/${SRC}/compare/`))
      return json(200, { ...state.compare, files: [] });
    if (
      method === "POST" &&
      path.startsWith(`/repos/${BLD}/actions/workflows/`) &&
      path.endsWith("/dispatches")
    ) {
      const body = JSON.parse(init.body);
      if (body.return_run_details !== true) return json(422, { message: "x" });
      const id = state.nextRunId++;
      const title = `pos-build ${body.inputs.request_id}`;
      if (state.dispatchMode !== "204-invisible")
        state.runs.set(id, {
          id,
          status: "queued",
          conclusion: null,
          display_title: title,
          run_attempt: 1,
          head_sha: SHAS.c,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          jobs: [],
        });
      if (state.dispatchMode === "200")
        return json(200, {
          workflow_run_id: id,
          run_url: `https://api.github.com/repos/${BLD}/actions/runs/${id}`,
          html_url: `https://github.com/evil/other/actions/runs/${id}`,
        });
      return new Response(null, { status: 204 });
    }
    if (
      method === "GET" &&
      path.endsWith("/runs") &&
      path.startsWith(`/repos/${BLD}/actions/workflows/`)
    )
      return json(200, { workflow_runs: [...state.runs.values()] });
    if (
      (m = path.match(
        new RegExp(`^/repos/${BLD}/actions/runs/(\\d+)(/[a-z]+)?$`),
      ))
    ) {
      const run = state.runs.get(Number(m[1]));
      if (!run) return json(404, { message: "nf" });
      if (method === "GET" && !m[2]) return json(200, run);
      if (method === "GET" && m[2] === "/jobs")
        return json(200, { jobs: run.jobs });
      if (method === "GET" && m[2] === "/artifacts")
        return json(200, {
          artifacts: [...state.artifacts.values()]
            .filter((a) => a.runId === run.id)
            .map((a) => a.meta),
        });
      if (method === "POST" && m[2] === "/cancel")
        return run.conclusion
          ? json(409, { message: "done" })
          : new Response(null, { status: 202 });
    }
    if (
      (m = path.match(
        new RegExp(`^/repos/${BLD}/actions/artifacts/(\\d+)(/zip)?$`),
      ))
    ) {
      const art = state.artifacts.get(Number(m[1]));
      if (!art) return json(404, { message: "nf" });
      if (method === "DELETE") {
        state.artifacts.delete(art.meta.id);
        return new Response(null, { status: 204 });
      }
      if (m[2])
        return new Response(null, {
          status: 302,
          headers: {
            location:
              state.blobLocation ?? `https://${BLOB_HOST}/blob?sig=SECRETSIG`,
          },
        });
      return json(200, art.meta);
    }
    if (method === "GET" && path.startsWith(`/repos/${BLD}/branches/`))
      return json(200, { commit: { sha: SHAS.c } });
    if (method === "GET" && path.startsWith(`/repos/${BLD}/contents/`))
      return json(200, {
        type: "file",
        encoding: "base64",
        size: 60,
        content: Buffer.from(
          JSON.stringify({
            protocol: 1,
            nodeVersion: "22.11.0",
            cliVersion: "39.1.0",
          }),
        ).toString("base64"),
      });
    return json(404, { message: "no route" });
  }
  return {
    fetch,
    calls,
    state,
    // Answers matching calls with `respond()` (times = -1: always).
    rule(match, respond, { times = 1, throws } = {}) {
      rules.push({ match, respond, left: times, throws });
    },
    addArtifact({ id, runId, body, expired = false, digest }) {
      const meta = {
        id,
        name: `pos-output-${id}`,
        size_in_bytes: body.length,
        expired,
        digest:
          digest ?? `sha256:${createHash("sha256").update(body).digest("hex")}`,
        created_at: "2026-10-10T00:00:00Z",
        expires_at: "2026-10-11T00:00:00Z",
      };
      state.artifacts.set(id, { meta, runId, body });
      state.blobBody = body;
    },
  };
}
