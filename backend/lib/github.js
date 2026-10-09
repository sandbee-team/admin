// GitHub adapter: reads the POS source repo (branches, commits, compare) with
// the source token, and drives the builder repo (dispatch, runs, artifacts)
// with the builder token. Every call goes through provider-http (fixed host,
// no redirects, no bodies in errors). The two tokens are never mixed.
import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { HttpError } from "./errors.js";
import { GITHUB_REPO_RE } from "../config.js";
import { ProviderError, request } from "./provider-http.js";
import { isBranch, isSha } from "../../shared/deploy.js";

// Hosts a GitHub artifact download may redirect to (S2 spike result).
export const BLOB_SUFFIXES = [
  ".blob.core.windows.net",
  ".actions.githubusercontent.com",
];
const BUILD_ID_RE = /^[A-Za-z0-9_.-]{8,100}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;
const clean = (text, max) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, max);
const headlineOf = (message) =>
  clean(String(message ?? "").split("\n")[0], 120);
const dateOf = (value) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
export const notConfigured = () => {
  const error = new HttpError(503, "GitHub is not configured.", true);
  error.apiCode = "not-configured";
  return error;
};
const bad = () => new ProviderError("github", "invalid");
const encodeRef = (name) => {
  if (!isBranch(name)) throw bad();
  return name.split("/").map(encodeURIComponent).join("/");
};
const mapCommit = (data) => ({
  sha: isSha(data?.sha) ? data.sha : "",
  headline: headlineOf(data?.commit?.message),
  // Author name only: e-mail addresses are never kept.
  authorName: clean(data?.commit?.author?.name, 100),
  date: dateOf(data?.commit?.author?.date ?? data?.commit?.committer?.date),
});
// The blob host for an artifact download must be public HTTPS on an allowed
// suffix, with no credentials and the default port.
export function allowedBlobUrl(location) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !BLOB_SUFFIXES.some(
      (suffix) => host.endsWith(suffix) && host.length > suffix.length,
    )
  )
    return null;
  return url;
}
export function createGitHub({
  sourceRepo,
  sourceToken = "",
  builderRepo,
  builderToken = "",
  workflow = "build.yml",
  ref = "main",
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  for (const repo of [sourceRepo, builderRepo])
    if (repo !== undefined && !GITHUB_REPO_RE.test(repo))
      throw new Error("Invalid GitHub repository name.");
  const sides = {
    source: { repo: sourceRepo, token: sourceToken },
    builder: { repo: builderRepo, token: builderToken },
  };
  function call(side, path, options = {}) {
    const { repo, token } = sides[side];
    if (!repo || !token) throw notConfigured();
    return request({
      provider: "github",
      path: `/repos/${repo}${path}`,
      token,
      fetch: fetchImpl,
      sleep,
      ...options,
    });
  }
  const runUrl = (id) =>
    `https://github.com/${sides.builder.repo}/actions/runs/${id}`;
  const runId = (value) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw bad();
    return value;
  };
  const api = {
    configured: () => ({
      source: Boolean(sourceRepo && sourceToken),
      builder: Boolean(builderRepo && builderToken),
    }),
    runUrl,
    // Branch list: first 100 branches, newest commit first, at most `limit`.
    async branches({ limit = 30, concurrency = 5, signal } = {}) {
      const { json } = await call("source", "/branches", {
        query: { per_page: 100 },
        signal,
      });
      const names = (Array.isArray(json) ? json : [])
        .filter((b) => isBranch(b?.name) && isSha(b?.commit?.sha))
        .slice(0, limit);
      const out = [];
      let next = 0;
      async function worker() {
        while (next < names.length) {
          const item = names[next++];
          const commit = await api.commit(item.commit.sha, { signal });
          out.push({
            name: item.name,
            sha: item.commit.sha,
            headline: commit.headline,
            date: commit.date,
          });
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, names.length) }, worker),
      );
      return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    },
    async branchHead(name, { signal } = {}) {
      const { json } = await call("source", `/branches/${encodeRef(name)}`, {
        signal,
      });
      const commit = mapCommit(json?.commit);
      if (!commit.sha) throw new ProviderError("github", "bad-response");
      return {
        name,
        sha: commit.sha,
        headline: commit.headline,
        date: commit.date,
      };
    },
    async commit(sha, { signal } = {}) {
      if (!isSha(sha)) throw bad();
      const { json } = await call("source", `/commits/${sha}`, { signal });
      const commit = mapCommit(json);
      if (commit.sha !== sha) throw new ProviderError("github", "bad-response");
      return commit;
    },
    // status: identical | ahead | behind | diverged (head relative to base).
    async compare(base, head, { signal } = {}) {
      if (!isSha(base) || !isSha(head)) throw bad();
      const { json } = await call("source", `/compare/${base}...${head}`, {
        // The response can list up to 300 changed files; one commit keeps the
        // commits part small and a larger body cap covers the files part.
        query: { per_page: 1 },
        maxBytes: 6 * 1024 * 1024,
        signal,
      });
      if (!["identical", "ahead", "behind", "diverged"].includes(json?.status))
        throw new ProviderError("github", "bad-response");
      return {
        status: json.status,
        aheadBy: int(json.ahead_by),
        behindBy: int(json.behind_by),
      };
    },
    // Starts the builder workflow. With return_run_details the 200 body has the
    // run id; if it is missing (204 or odd body) the run is found by its
    // run-name `pos-build <buildId>`.
    async dispatch({ buildId, inputs, signal }) {
      if (!BUILD_ID_RE.test(buildId ?? "")) throw bad();
      const entries = Object.entries(inputs ?? {});
      if (
        entries.length > 25 ||
        entries.some(
          ([k, v]) => !/^[a-z_]{1,40}$/.test(k) || typeof v !== "string",
        ) ||
        JSON.stringify(inputs).length > 60000
      )
        throw bad();
      const startedAt = now();
      const { status, json } = await call(
        "builder",
        `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        {
          method: "POST",
          body: { ref, inputs, return_run_details: true },
          idempotent: false,
          signal,
        },
      );
      if (
        status === 200 &&
        Number.isSafeInteger(json?.workflow_run_id) &&
        json.workflow_run_id > 0
      )
        return {
          runId: json.workflow_run_id,
          htmlUrl: runUrl(json.workflow_run_id),
          via: "response",
        };
      const found = await api.findRun(buildId, {
        since: startedAt - 60000,
        signal,
      });
      return found
        ? { ...found, via: "search" }
        : { runId: null, htmlUrl: null, via: "none" };
    },
    // Finds a run by run-name; a few polls because the run can lag the 204.
    async findRun(
      buildId,
      { since = 0, attempts = 5, delayMs = 2000, signal } = {},
    ) {
      if (!BUILD_ID_RE.test(buildId ?? "")) throw bad();
      for (let i = 0; i < attempts; i++) {
        const { json } = await call(
          "builder",
          `/actions/workflows/${encodeURIComponent(workflow)}/runs`,
          {
            query: {
              event: "workflow_dispatch",
              per_page: 30,
              ...(since
                ? { created: `>=${new Date(since).toISOString()}` }
                : {}),
            },
            signal,
          },
        );
        const run = (json?.workflow_runs ?? []).find(
          (r) =>
            r?.display_title === `pos-build ${buildId}` &&
            Number.isSafeInteger(r?.id),
        );
        if (run) return { runId: run.id, htmlUrl: runUrl(run.id) };
        if (i < attempts - 1) await sleep(delayMs);
      }
      return null;
    },
    async run(id, { signal } = {}) {
      const { json } = await call("builder", `/actions/runs/${runId(id)}`, {
        signal,
      });
      return {
        id,
        status: clean(json?.status, 30),
        conclusion: json?.conclusion ? clean(json.conclusion, 30) : null,
        displayTitle: clean(json?.display_title, 150),
        runAttempt: int(json?.run_attempt),
        headSha: isSha(json?.head_sha) ? json.head_sha : "",
        // Provenance the worker checks before it accepts a build.
        path: clean(json?.path, 150),
        headBranch: clean(json?.head_branch, 200),
        event: clean(json?.event, 40),
        htmlUrl: runUrl(id),
        createdAt: dateOf(json?.created_at),
        updatedAt: dateOf(json?.updated_at),
      };
    },
    // Name of the first failed step, for a fixed message table; never logs.
    async failedStepName(id, { signal } = {}) {
      const { json } = await call(
        "builder",
        `/actions/runs/${runId(id)}/jobs`,
        {
          query: { per_page: 30 },
          signal,
        },
      );
      for (const job of json?.jobs ?? [])
        for (const step of job?.steps ?? [])
          if (step?.conclusion === "failure") return clean(step.name, 80);
      return null;
    },
    // true when the cancel request was accepted; false if the run was already done.
    async cancelRun(id, { signal } = {}) {
      try {
        await call("builder", `/actions/runs/${runId(id)}/cancel`, {
          method: "POST",
          idempotent: true,
          signal,
        });
        return true;
      } catch (error) {
        if (error instanceof ProviderError && error.code === "conflict")
          return false;
        throw error;
      }
    },
    async listArtifacts(id, { signal } = {}) {
      const { json } = await call(
        "builder",
        `/actions/runs/${runId(id)}/artifacts`,
        {
          query: { per_page: 100 },
          signal,
        },
      );
      return (json?.artifacts ?? [])
        .filter((a) => Number.isSafeInteger(a?.id))
        .map((a) => ({
          id: a.id,
          name: clean(a.name, 100),
          size: int(a.size_in_bytes),
          expired: Boolean(a.expired),
          digest: DIGEST_RE.test(a.digest ?? "") ? a.digest : null,
          createdAt: dateOf(a.created_at),
          expiresAt: dateOf(a.expires_at),
        }));
    },
    // Downloads artifact `id` to `file` (through `file.part`). The first call
    // returns a 302 to a short-lived blob URL; it is followed only for an
    // allowed host, without credentials, and the bytes must match the
    // artifact's sha256 digest.
    async downloadArtifact(
      id,
      file,
      { maxBytes, stallMs = 30000, totalMs = 300000, signal } = {},
    ) {
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        !Number.isSafeInteger(maxBytes)
      )
        throw bad();
      const meta = await call("builder", `/actions/artifacts/${id}`, {
        signal,
      });
      const digest = DIGEST_RE.exec(meta.json?.digest ?? "")?.[1];
      if (!digest) throw new ProviderError("github", "no-digest");
      if (meta.json?.expired) throw new ProviderError("github", "expired");
      const size = int(meta.json?.size_in_bytes);
      if (size > maxBytes) throw new ProviderError("github", "too-large");
      const first = await call("builder", `/actions/artifacts/${id}/zip`, {
        followRedirect: true,
        signal,
      });
      if (first.status !== 302 || !first.location)
        throw new ProviderError("github", "bad-response", {
          status: first.status,
        });
      const target = allowedBlobUrl(first.location);
      if (!target) throw new ProviderError("github", "redirect-host");
      const abort = new AbortController();
      const timers = { stall: null };
      const total = setTimeout(() => abort.abort("timeout"), totalMs);
      const onAbort = () => abort.abort("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const part = `${file}.part`;
      let handle;
      try {
        let response;
        try {
          response = await fetchImpl(target, {
            method: "GET",
            // No Authorization: the blob URL carries its own signature.
            headers: { "user-agent": "sandbee-admin" },
            redirect: "error",
            signal: abort.signal,
          });
        } catch {
          throw new ProviderError(
            "github",
            signal?.aborted
              ? "aborted"
              : abort.signal.reason === "timeout"
                ? "timeout"
                : "network",
            { retryable: true },
          );
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new ProviderError("github", "blob-failed", {
            status: response.status,
          });
        }
        const hash = createHash("sha256");
        const reader = response.body.getReader();
        handle = await open(part, "w");
        let bytes = 0;
        for (;;) {
          const stalled = new Promise((_, reject) => {
            timers.stall = setTimeout(
              () => reject(new Error("stalled")),
              stallMs,
            );
          });
          let chunk;
          try {
            chunk = await Promise.race([reader.read(), stalled]);
          } catch (error) {
            await reader.cancel().catch(() => {});
            abort.abort();
            throw new ProviderError(
              "github",
              error?.message === "stalled"
                ? "stalled"
                : signal?.aborted
                  ? "aborted"
                  : abort.signal.reason === "timeout"
                    ? "timeout"
                    : "network",
              { retryable: true },
            );
          } finally {
            clearTimeout(timers.stall);
          }
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > maxBytes || bytes > size + 1024) {
            await reader.cancel().catch(() => {});
            throw new ProviderError("github", "too-large");
          }
          hash.update(chunk.value);
          await handle.write(chunk.value);
        }
        await handle.close();
        handle = null;
        if (hash.digest("hex") !== digest)
          throw new ProviderError("github", "digest-mismatch");
        await rename(part, file);
        return { bytes, sha256: digest };
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(part).catch(() => {});
        throw error instanceof ProviderError
          ? error
          : new ProviderError("github", "network");
      } finally {
        clearTimeout(total);
        clearTimeout(timers.stall);
        signal?.removeEventListener("abort", onAbort);
      }
    },
    // true when deleted (or already gone).
    async deleteArtifact(id, { signal } = {}) {
      if (!Number.isSafeInteger(id) || id <= 0) throw bad();
      try {
        await call("builder", `/actions/artifacts/${id}`, {
          method: "DELETE",
          idempotent: true,
          signal,
        });
      } catch (error) {
        if (!(error instanceof ProviderError && error.code === "not-found"))
          throw error;
      }
      return true;
    },
    // Head commit of the builder ref (must be a branch name).
    async builderHead({ signal } = {}) {
      const { json } = await call("builder", `/branches/${encodeRef(ref)}`, {
        signal,
      });
      const sha = json?.commit?.sha;
      if (!isSha(sha)) throw new ProviderError("github", "bad-response");
      return { ref, sha };
    },
    // One small JSON file of the builder repo at an exact commit.
    async builderFile(sha, name = "builder.json") {
      if (!isSha(sha) || !FILE_RE.test(name)) throw bad();
      const { json } = await call("builder", `/contents/${name}`, {
        query: { ref: sha },
      });
      if (
        json?.type !== "file" ||
        json?.encoding !== "base64" ||
        int(json?.size) > 65536
      )
        throw new ProviderError("github", "bad-response");
      try {
        return JSON.parse(
          Buffer.from(String(json.content), "base64").toString("utf8"),
        );
      } catch {
        throw new ProviderError("github", "bad-response");
      }
    },
  };
  return api;
}
