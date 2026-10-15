// Vercel adapter, built per client token. Reads and returns whitelisted fields
// only; environment values are returned for plain variables alone and are never
// requested decrypted.
import { recommendedCnameOf } from "../../shared/web-address.js";
import { BUILD_SETTINGS } from "./build-inputs.js";
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
// Go-live codes (shared/deploy-errors.js, section 9), not provider-http codes.
const PROJECT_TAKEN = "project-name-taken";
const DOMAIN_TAKEN = "domain-taken";
const ENV_FAILED = "env-upsert-failed";
const FUNCTION_REGION = "bom1";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const ENV_TYPES = new Set(["plain", "encrypted", "sensitive"]);
const ENV_TARGETS = new Set(["production", "preview", "development"]);
const MAX_ENVS = 50;
const SNAKE_RE = /^[a-z_]{1,40}$/;
const FP_RE = /^[a-f0-9]{16}$/;
const TAKEN_CODES = new Set(["domain_already_in_use", "domain_taken"]);
// A request Vercel understood and refused (not auth, limits or outage).
const REFUSED = new Set(["invalid", "conflict", "rejected"]);
const host = (value) => {
  if (!HOST_RE.test(value ?? "") || String(value).includes("..")) throw bad();
  return value;
};
// Runs a provider call; a ProviderError whose `pick(error)` answers a code is
// rethrown with that code (fixed message, no provider text), others pass.
async function mapErrors(fn, pick) {
  try {
    return await fn();
  } catch (error) {
    const code = error instanceof ProviderError ? pick(error) : null;
    if (code) throw new ProviderError("vercel", code, { status: error.status });
    throw error;
  }
}
const projectOf = (json) => {
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
      json?.outputDirectory == null ? null : text(json.outputDirectory, 300),
    serverlessFunctionRegion: text(json?.serverlessFunctionRegion, 20) || null,
    productionDeploymentId: text(json?.targets?.production?.id, 100) || null,
    lastAliasRequest:
      last && typeof last === "object"
        ? {
            toDeploymentId: text(last.toDeploymentId, 100),
            jobStatus: text(last.jobStatus, 30),
            type: text(last.type, 30),
          }
        : null,
  };
};
// Domain whitelist; verification[] entries are public DNS records.
const domainOf = (d) => ({
  name: text(d?.name, 253),
  projectId: text(d?.projectId, 100),
  verified: d?.verified === true,
  redirect: d?.redirect == null ? null : text(d.redirect, 253),
  redirectStatusCode: Number.isFinite(d?.redirectStatusCode)
    ? d.redirectStatusCode
    : null,
  verification: (Array.isArray(d?.verification) ? d.verification : [])
    .slice(0, 10)
    .map((v) => ({
      type: text(v?.type, 10),
      domain: text(v?.domain, 253),
      value: text(v?.value, 500),
    })),
});
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
    // Expiry of the token itself (usage checks). Token metadata is per token,
    // so no team id is sent. -> {expiresAt: ms | null (never expires)}.
    async tokenInfo({ signal } = {}) {
      const { json } = await request({
        provider: "vercel",
        path: "/v5/user/tokens/current",
        token,
        fetch: fetchImpl,
        sleep,
        signal,
      });
      if (!json?.token || typeof json.token !== "object")
        throw new ProviderError("vercel", "bad-response");
      return { expiresAt: time(json.token.expiresAt) };
    },
    async project(projectId, { signal } = {}) {
      const { json } = await call(`/v9/projects/${id(projectId)}`, { signal });
      return projectOf(json);
    },
    // Go-live (D42). The project by NAME, or null when there is none (404).
    // The name goes through the same path check as an id.
    async projectByName(name, { signal } = {}) {
      try {
        const { json } = await call(`/v9/projects/${id(name)}`, { signal });
        return projectOf(json);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not-found")
          return null;
        throw error;
      }
    },
    // New project with the fixed settings and Function Region bom1 (S1). The
    // node version and sourceFilesOutsideRootDirectory follow in patchProject.
    // 409 -> project-name-taken. Not retried (not idempotent).
    async createProject(name, { signal } = {}) {
      const { json } = await mapErrors(
        () =>
          call("/v11/projects", {
            method: "POST",
            body: {
              name: id(name),
              framework: BUILD_SETTINGS.framework,
              rootDirectory: BUILD_SETTINGS.rootDirectory,
              serverlessFunctionRegion: FUNCTION_REGION,
            },
            signal,
          }),
        (e) => (e.status === 409 ? PROJECT_TAKEN : null),
      );
      return projectOf(json);
    },
    // node 22.x and sourceFilesOutsideRootDirectory from BUILD_SETTINGS.
    async patchProject(projectId, { signal } = {}) {
      const { json } = await call(`/v9/projects/${id(projectId)}`, {
        method: "PATCH",
        idempotent: true,
        body: {
          nodeVersion: BUILD_SETTINGS.nodeVersion,
          sourceFilesOutsideRootDirectory:
            BUILD_SETTINGS.sourceFilesOutsideRootDirectory,
        },
        signal,
      });
      return projectOf(json);
    },
    // Upsert by key (blank values are accepted, S1). `envs` = buildEnv rows
    // [{key, value, type, target[]}]; values are sent and never kept.
    // -> {created: n, failed: [{key, code}]} (provider text is dropped).
    // A refused request (4xx other than auth/limits) -> env-upsert-failed.
    async upsertEnv(projectId, envs, { signal } = {}) {
      id(projectId);
      if (!Array.isArray(envs) || envs.length < 1 || envs.length > MAX_ENVS)
        throw bad();
      for (const e of envs)
        if (
          !ENV_KEY_RE.test(e?.key ?? "") ||
          typeof e.value !== "string" ||
          !ENV_TYPES.has(e.type) ||
          !Array.isArray(e.target) ||
          !e.target.length ||
          !e.target.every((t) => ENV_TARGETS.has(t))
        )
          throw bad();
      const { json } = await mapErrors(
        () =>
          call(`/v10/projects/${projectId}/env`, {
            method: "POST",
            query: { upsert: "true" },
            idempotent: true,
            body: envs.map((e) => ({
              key: e.key,
              value: e.value,
              type: e.type,
              target: [...e.target],
            })),
            signal,
          }),
        (e) => (REFUSED.has(e.code) ? ENV_FAILED : null),
      );
      const created = Array.isArray(json?.created)
        ? json.created.length
        : json?.created && typeof json.created === "object"
          ? 1
          : 0;
      const failed = (Array.isArray(json?.failed) ? json.failed : [])
        .slice(0, MAX_ENVS)
        .map((f) => ({
          key: ENV_KEY_RE.test(f?.error?.key ?? f?.error?.envVarKey ?? "")
            ? (f.error.key ?? f.error.envVarKey)
            : "unknown",
          code: SNAKE_RE.test(f?.error?.code ?? "") ? f.error.code : "unknown",
        }));
      return { created, failed };
    },
    // Env metadata only: [{key, type, target[], updatedAt, fp16?}] (D43).
    // Values are never returned. For a plain row (and only then) the caller's
    // `fingerprint(key, value)` is called in memory and must answer 16 hex
    // characters, kept as fp16; any other answer, or a throw, fails the call
    // with a fixed error, so nothing the callback returns can carry a value.
    async envMeta(projectId, { fingerprint, signal } = {}) {
      if (fingerprint !== undefined && typeof fingerprint !== "function")
        throw bad();
      const { json } = await call(`/v10/projects/${id(projectId)}/env`, {
        signal,
      });
      const list = Array.isArray(json?.envs) ? json.envs : [];
      return list
        .filter((e) => typeof e?.key === "string")
        .map((e) => {
          const row = {
            key: text(e.key, 100),
            type: text(e.type, 20),
            target: (Array.isArray(e.target) ? e.target : [e.target])
              .filter((t) => typeof t === "string")
              .map((t) => t.slice(0, 20)),
            updatedAt: time(e.updatedAt),
          };
          if (
            fingerprint &&
            row.type === "plain" &&
            typeof e.value === "string"
          ) {
            let fp;
            try {
              fp = fingerprint(row.key, e.value);
            } catch {
              throw bad();
            }
            if (typeof fp !== "string" || !FP_RE.test(fp)) throw bad();
            row.fp16 = fp;
          }
          return row;
        });
    },
    // The project's domains (names, verified, redirect).
    async projectDomains(projectId, { signal } = {}) {
      const { json } = await call(`/v9/projects/${id(projectId)}/domains`, {
        signal,
      });
      return (Array.isArray(json?.domains) ? json.domains : [])
        .slice(0, 100)
        .map(domainOf);
    },
    // One domain on the project, or null when it is not attached (404).
    async projectDomain(projectId, name, { signal } = {}) {
      try {
        const { json } = await call(
          `/v9/projects/${id(projectId)}/domains/${host(name)}`,
          { signal },
        );
        return domainOf(json);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not-found")
          return null;
        throw error;
      }
    },
    // Attach a domain. Already on THIS project (400) -> that domain (adopt);
    // on another project (409) -> domain-taken.
    async addDomain(projectId, name, { signal } = {}) {
      id(projectId);
      host(name);
      try {
        const { json } = await call(`/v10/projects/${projectId}/domains`, {
          method: "POST",
          body: { name },
          signal,
        });
        return domainOf(json);
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        if (error.status === 400) {
          const own = await api.projectDomain(projectId, name, { signal });
          if (own) return own;
          if (TAKEN_CODES.has(error.providerCode))
            throw new ProviderError("vercel", DOMAIN_TAKEN, { status: 400 });
        }
        if (error.status === 409)
          throw new ProviderError("vercel", DOMAIN_TAKEN, { status: 409 });
        throw error;
      }
    },
    // Re-check a domain. A 400 means "not verified yet" -> {verified: false,
    // verification: []}; other failures throw.
    async verifyDomain(projectId, name, { signal } = {}) {
      try {
        const { json } = await call(
          `/v9/projects/${id(projectId)}/domains/${host(name)}/verify`,
          { method: "POST", idempotent: true, signal },
        );
        return domainOf(json);
      } catch (error) {
        if (error instanceof ProviderError && error.status === 400)
          return { ...domainOf({ name }), verified: false };
        throw error;
      }
    },
    // DNS readiness Vercel computed: {misconfigured, configuredBy,
    // recommendedCname (rank 1, W1's recommendedCnameOf), recommendedCNAME
    // [{rank, value}] ranked}. A missing/odd `misconfigured` counts as true.
    async domainConfig(name, { signal } = {}) {
      const { json } = await call(`/v6/domains/${host(name)}/config`, {
        signal,
      });
      const list = Array.isArray(json?.recommendedCNAME)
        ? json.recommendedCNAME
        : [];
      return {
        misconfigured: json?.misconfigured !== false,
        configuredBy: text(json?.configuredBy, 30) || null,
        recommendedCname: recommendedCnameOf(json),
        recommendedCNAME: list
          .filter((r) => typeof r?.value === "string")
          .map((r) => ({
            rank: Number.isFinite(r.rank) ? r.rank : 0,
            value: text(r.value, 253),
          }))
          .sort((a, b) => a.rank - b.rank)
          .slice(0, 10),
      };
    },
    // 308 (default) redirect of a project domain to `redirect` (a host name);
    // null clears it. Used for the project's *.vercel.app names.
    async setDomainRedirect(
      projectId,
      name,
      redirect,
      { statusCode = 308, signal } = {},
    ) {
      id(projectId);
      host(name);
      if (redirect !== null) host(redirect);
      if (![301, 302, 307, 308].includes(statusCode)) throw bad();
      const { json } = await call(`/v9/projects/${projectId}/domains/${name}`, {
        method: "PATCH",
        idempotent: true,
        body: {
          redirect,
          redirectStatusCode: redirect === null ? null : statusCode,
        },
        signal,
      });
      return domainOf(json);
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
