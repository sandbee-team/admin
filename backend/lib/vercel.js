// Vercel adapter, built per client token. Reads and returns whitelisted fields
// only; environment values are returned for plain variables alone and are never
// requested decrypted.
import { ProviderError, request } from "./provider-http.js";

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const META_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const bad = () => new ProviderError("vercel", "invalid");
const id = (value) => {
  if (!ID_RE.test(value ?? "")) throw bad();
  return value;
};
const text = (value, max = 200) =>
  typeof value === "string" ? value.slice(0, max) : "";
const time = (value) => (Number.isFinite(value) ? value : null);
const metaOf = (meta) => {
  const out = {};
  if (meta && typeof meta === "object")
    for (const [key, value] of Object.entries(meta))
      if (META_KEY_RE.test(key) && typeof value === "string")
        out[key] = value.slice(0, 200);
  return out;
};
const deploymentOf = (d) => ({
  id: text(d?.uid ?? d?.id, 100),
  url: text(d?.url, 253),
  projectId: text(d?.projectId, 100),
  readyState: text(d?.readyState ?? d?.state, 30),
  readySubstate: text(d?.readySubstate, 30),
  target: text(d?.target, 30) || null,
  source: text(d?.source, 30),
  prebuilt: typeof d?.prebuilt === "boolean" ? d.prebuilt : null,
  isRollbackCandidate:
    typeof d?.isRollbackCandidate === "boolean" ? d.isRollbackCandidate : null,
  createdAt: time(d?.createdAt ?? d?.created),
  meta: metaOf(d?.meta),
});
export function createVercel({
  token,
  teamId = "",
  fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (teamId && !ID_RE.test(teamId)) throw new Error("Invalid Vercel team id.");
  const call = (path, options = {}) =>
    request({
      provider: "vercel",
      path,
      token,
      fetch: fetchImpl,
      sleep,
      ...options,
      query: { ...(teamId ? { teamId } : {}), ...(options.query ?? {}) },
    });
  const api = {
    async user({ signal } = {}) {
      const { json } = await call("/v2/user", { signal });
      return {
        id: text(json?.user?.id, 100),
        username: text(json?.user?.username, 100),
        defaultTeamId: text(json?.user?.defaultTeamId, 100) || null,
      };
    },
    async project(projectId, { signal } = {}) {
      const { json } = await call(`/v9/projects/${id(projectId)}`, { signal });
      const last = json?.lastAliasRequest;
      return {
        id: text(json?.id, 100),
        name: text(json?.name, 100),
        accountId: text(json?.accountId, 100),
        framework: text(json?.framework, 40) || null,
        rootDirectory:
          json?.rootDirectory == null ? null : text(json.rootDirectory, 200),
        nodeVersion: text(json?.nodeVersion, 20) || null,
        sourceFilesOutsideRootDirectory:
          typeof json?.sourceFilesOutsideRootDirectory === "boolean"
            ? json.sourceFilesOutsideRootDirectory
            : null,
        installCommand:
          json?.installCommand == null ? null : text(json.installCommand, 300),
        buildCommand:
          json?.buildCommand == null ? null : text(json.buildCommand, 300),
        outputDirectory:
          json?.outputDirectory == null
            ? null
            : text(json.outputDirectory, 300),
        productionDeploymentId:
          text(json?.targets?.production?.id, 100) || null,
        lastAliasRequest:
          last && typeof last === "object"
            ? {
                toDeploymentId: text(last.toDeploymentId, 100),
                jobStatus: text(last.jobStatus, 30),
                type: text(last.type, 30),
              }
            : null,
      };
    },
    // Names and plain values only. Encrypted/sensitive entries come back with
    // value null; the endpoint is never asked to decrypt.
    async projectEnv(projectId, { signal } = {}) {
      const { json } = await call(`/v10/projects/${id(projectId)}/env`, {
        signal,
      });
      const list = Array.isArray(json?.envs) ? json.envs : [];
      return list
        .filter((e) => typeof e?.key === "string")
        .map((e) => ({
          key: text(e.key, 100),
          type: text(e.type, 20),
          target: (Array.isArray(e.target) ? e.target : [e.target])
            .filter((t) => typeof t === "string")
            .map((t) => t.slice(0, 20)),
          value:
            e.type === "plain" && typeof e.value === "string" ? e.value : null,
        }));
    },
    async deployment(idOrUrl, { signal } = {}) {
      const ref = String(idOrUrl ?? "");
      if (!ID_RE.test(ref) && !HOST_RE.test(ref)) throw bad();
      const { json } = await call(`/v13/deployments/${ref}`, { signal });
      return {
        ...deploymentOf(json),
        aliasAssigned: Boolean(json?.aliasAssigned),
      };
    },
    // The deployment whose meta[key] === value. The list is matched locally
    // (the CLI's stdout is not trusted to name the deployment) and polled a
    // few times because a fresh deployment can lag the CLI's exit.
    async findDeploymentByMeta(
      projectId,
      key,
      value,
      { attempts = 6, delayMs = 5000, signal } = {},
    ) {
      id(projectId);
      if (!META_KEY_RE.test(key ?? "") || typeof value !== "string" || !value)
        throw bad();
      for (let i = 0; i < attempts; i++) {
        const { json } = await call("/v6/deployments", {
          query: { projectId, limit: 30 },
          signal,
        });
        const found = (json?.deployments ?? []).find(
          (d) => d?.meta?.[key] === value,
        );
        if (found && (found.uid || found.id)) return deploymentOf(found);
        if (i < attempts - 1) await sleep(delayMs);
      }
      return null;
    },
    async promote(projectId, deploymentId, { signal } = {}) {
      const { status } = await call(
        `/v10/projects/${id(projectId)}/promote/${id(deploymentId)}`,
        { method: "POST", idempotent: true, signal, timeoutMs: 60000 },
      );
      return { status };
    },
    async rollback(projectId, deploymentId, { signal } = {}) {
      const { status } = await call(
        `/v1/projects/${id(projectId)}/rollback/${id(deploymentId)}`,
        { method: "POST", idempotent: true, signal, timeoutMs: 60000 },
      );
      return { status };
    },
    // Newest first, following pagination.next until `max` entries.
    async listDeployments(
      projectId,
      { until, limit = 100, max = 500, target, signal } = {},
    ) {
      id(projectId);
      const out = [];
      let cursor = until;
      while (out.length < max) {
        const { json } = await call("/v7/deployments", {
          query: {
            projectId,
            limit: Math.min(limit, max - out.length),
            ...(cursor ? { until: cursor } : {}),
            ...(target ? { target } : {}),
          },
          signal,
        });
        const page = Array.isArray(json?.deployments) ? json.deployments : [];
        out.push(...page.map(deploymentOf));
        const next = json?.pagination?.next;
        if (!page.length || !Number.isFinite(next)) break;
        cursor = next;
      }
      return out.slice(0, max);
    },
    // true when deleted or already gone.
    async deleteDeployment(deploymentId, { signal } = {}) {
      try {
        await call(`/v13/deployments/${id(deploymentId)}`, {
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
  };
  return api;
}
