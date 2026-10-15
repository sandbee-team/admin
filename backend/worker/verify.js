// Shared target loading (decrypting the customer's secrets, in this process
// only), the Vercel project inspection used by both preflight and the verify
// task, and the verify task itself. Results are fixed codes: no provider text,
// no value of any secret and no URL ever reaches a stored field.
import { decrypt } from "../lib/crypto.js";
import { ProviderError } from "../lib/provider-http.js";
import { canonicalEnvValue, nextPublicOf } from "../lib/build-inputs.js";
import { probeHealth, probeLogin } from "../lib/pos-health.js";
import { NEXT_PUBLIC_KEYS } from "../../shared/deploy.js";
import {
  BLOCKING_SETTINGS,
  isKnownCode,
  providerFlag,
} from "../../shared/deploy-errors.js";
import { BUILD_SETTINGS } from "../lib/build-inputs.js";
import { missingEnvKeys } from "../lib/golive-env.js";
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";
import { JobFail, LeaseLost, withLease } from "./lease.js";

export const WORKER_ACTOR = { _id: "worker", name: "Deploy worker" };
export const REQUIRED_ENV = ["TENANT_ID", "ROOT_DOMAIN", "MONGODB_URI"];
const aadOf = (installationId, field) => `pos:${installationId}:${field}`;
const get = (object, path) =>
  path.split(".").reduce((value, part) => value?.[part], object);
// Decrypts one stored secret; null when none is stored. Throws JobFail when a
// stored box cannot be opened (never echoing anything about it).
export function openSecret(ctx, installationId, pos, field) {
  const box = get(pos, field);
  if (!box) return null;
  try {
    return decrypt(box, ctx.c.VAULT_KEY, aadOf(installationId, field));
  } catch {
    throw new JobFail(
      "secret-unreadable",
      "A stored secret could not be decrypted.",
    );
  }
}
// -> {id, pos, customerStatus, installationStatus, token, projectId, orgId, teamId, host, tenantId}
export async function loadTarget(
  ctx,
  installationId,
  { needToken = true } = {},
) {
  const row = await ctx.coll.installations.findOne(
    { _id: installationId },
    { projection: { pos: 1, customerId: 1, status: 1 } },
  );
  if (!row?.pos) throw new JobFail("not-found", "The installation is gone.");
  const customer = await ctx.db
    .collection("customers")
    .findOne({ _id: row.customerId }, { projection: { status: 1 } });
  const pos = row.pos;
  const token = needToken
    ? openSecret(ctx, installationId, pos, "vercel.token")
    : null;
  if (needToken && !token)
    throw new JobFail("no-token", "No Vercel token is stored.");
  const orgId = pos.vercel?.orgId ?? "";
  return {
    id: installationId,
    pos,
    customerStatus: customer?.status,
    installationStatus: row.status,
    token,
    projectId: pos.vercel?.projectId ?? "",
    orgId,
    teamId: pos.vercel?.teamId || (orgId.startsWith("team_") ? orgId : ""),
    host: pos.host ?? "",
    tenantId: pos.tenantId ?? "",
  };
}
// A fixed code from shared/deploy-errors.js (never provider text).
export const providerCode = (error) => {
  const code =
    error instanceof ProviderError ? providerFlag(error.code) : "failed";
  return isKnownCode(code) ? code : "failed";
};
// Vercel user, project settings and env drift. Flags only: "ok" or a fixed
// code; `names` lists KEY NAMES (never values) for the failure message.
const cleanSetting = (value) =>
  value === null || value === undefined
    ? null
    : String(value)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .slice(0, 100);
const majorOf = (value) => /^(\d+)/.exec(String(value ?? ""))?.[1] ?? null;
// The Node.js major the builder uses (builder.json), as "22.x"; the fixed
// build setting when the descriptor is not known yet.
export async function expectedNodeOf(ctx) {
  try {
    const info = await ctx.heartbeat?.builderInfo();
    const major = majorOf(info?.descriptor?.nodeVersion);
    if (major) return `${major}.x`;
  } catch {
    // Fall back below.
  }
  return BUILD_SETTINGS.nodeVersion;
}
export async function inspectProject(
  vercel,
  target,
  { signal, expectedNode = BUILD_SETTINGS.nodeVersion } = {},
) {
  const out = {
    problems: [],
    warnings: [],
    vercel: null,
    project: null,
    env: null,
    names: [],
    projectData: null,
    // KEY NAMES of the production env (never values), for the names-only
    // parity of clients whose env admin did not write (D43); null = unread.
    envNames: null,
  };
  try {
    await vercel.user({ signal });
    out.vercel = "ok";
  } catch (error) {
    out.vercel = providerCode(error);
    return out;
  }
  try {
    const project = await vercel.project(target.projectId, { signal });
    out.projectData = project;
    // Blocking: what a prebuilt deploy really depends on.
    const want = { framework: "nextjs", rootDirectory: "apps/cafe" };
    for (const name of BLOCKING_SETTINGS)
      if (project[name] !== want[name])
        out.problems.push({
          name,
          actual: cleanSetting(project[name]),
          expected: want[name],
        });
    // Warning only: the function runtime comes from the build output.
    if (majorOf(project.nodeVersion) !== majorOf(expectedNode))
      out.warnings.push({
        name: "nodeVersion",
        actual: cleanSetting(project.nodeVersion),
        expected: expectedNode,
      });
    out.project = out.problems.length ? "settings" : "ok";
    out.names.push(...out.problems.map((p) => p.name));
  } catch (error) {
    out.project = providerCode(error);
    return out;
  }
  try {
    const envs = await vercel.projectEnv(target.projectId, { signal });
    const production = envs.filter(
      (e) => e.target.includes("production") || e.target.length === 0,
    );
    const names = new Set(production.map((e) => e.key));
    out.envNames = [...names];
    const missing = REQUIRED_ENV.filter((key) => !names.has(key));
    const derived = nextPublicOf(target.pos);
    const drift = [];
    const canon = (key, value) => {
      try {
        return canonicalEnvValue(key, value);
      } catch {
        return null;
      }
    };
    for (const e of production) {
      if (e.type !== "plain" || e.value === null) continue;
      if (NEXT_PUBLIC_KEYS.includes(e.key)) {
        if (canon(e.key, e.value) !== canon(e.key, derived[e.key] ?? ""))
          drift.push(e.key);
      } else if (e.key === "TENANT_ID" && e.value !== target.tenantId)
        drift.push(e.key);
      else if (
        e.key === "ROOT_DOMAIN" &&
        e.value !== (target.pos.rootDomain ?? "")
      )
        drift.push(e.key);
    }
    out.env = missing.length ? "missing" : drift.length ? "drift" : "ok";
    out.names.push(...missing, ...drift);
  } catch (error) {
    out.env = providerCode(error);
  }
  return out;
}
// Current production deployment id of a project (alias truth first).
export function productionOf(project) {
  const alias = project?.lastAliasRequest;
  if (alias?.toDeploymentId && alias.jobStatus === "succeeded")
    return alias.toDeploymentId;
  return project?.productionDeploymentId ?? null;
}
// Is this deployment the one production serves NOW? Either signal counts, but
// a succeeded alias request never overrides a project whose production target
// names another deployment (an old alias request can be stale: after a plain
// promote Vercel may not report a new one at all).
export function isProduction(project, id) {
  if (!id) return false;
  const prod = project?.productionDeploymentId ?? null;
  if (prod === id) return true;
  const alias = project?.lastAliasRequest;
  const aliasOk =
    alias?.toDeploymentId === id && alias.jobStatus === "succeeded";
  return aliasOk && prod === null;
}
export async function healthFlag(ctx, target, signal) {
  const options = {
    host: target.host,
    tenantId: target.tenantId,
    get: ctx.healthGet,
    signal,
  };
  const health = await probeHealth(options);
  if (!health.ok) return "unhealthy";
  const login = await probeLogin({
    host: target.host,
    get: ctx.healthGet,
    signal,
  });
  return login.ok ? "ok" : "login-failed";
}
export const VERIFY_STEPS = [
  "vercel",
  "project",
  "env",
  "mongo",
  "cloudflare",
  "health",
];
const STEPS = VERIFY_STEPS;
// Every check of one installation, shared by the verify task and the go-live's
// inline Verify (P5). `target` = loadTarget (with the Vercel token); `onStep`
// is awaited before each group (the task records its step). Returns
// {flags, inspected, envKeysMissing}: flags are "ok" | a fixed code | null.
// health = "not-deployed" when the project has no production deployment yet
// (nothing to probe; verifyStateOf "bootstrap", D47). envKeysMissing = the
// go-live env KEY NAMES missing on Vercel, only for a client whose env admin
// did not write (imported or hand-entered; D43 names-only parity).
export async function verifyChecks(
  ctx,
  target,
  { signal, onStep = async () => {} } = {},
) {
  const vercel = ctx.vercelFor({ token: target.token, teamId: target.teamId });
  const flags = {
    vercel: null,
    project: null,
    env: null,
    mongo: null,
    cloudflare: null,
    health: null,
  };
  await onStep("vercel");
  const inspected = await inspectProject(vercel, target, {
    signal,
    expectedNode: await expectedNodeOf(ctx),
  });
  flags.vercel = inspected.vercel;
  flags.project = inspected.project;
  flags.env = inspected.env;
  await onStep("mongo");
  const uri = openSecret(ctx, target.id, target.pos, "mongo.uri");
  flags.mongo = uri ? await ctx.pingMongo(uri) : "not-set";
  await onStep("cloudflare");
  const cfToken = openSecret(ctx, target.id, target.pos, "cloudflare.token");
  if (cfToken) {
    try {
      const verified = await ctx.cloudflareVerify(
        cfToken,
        target.pos.cloudflare?.accountId ?? "",
        { signal },
      );
      flags.cloudflare = verified.ok ? "ok" : "invalid";
    } catch (error) {
      flags.cloudflare = providerCode(error);
    }
  }
  await onStep("health");
  flags.health =
    inspected.project === "ok" && !productionOf(inspected.projectData)
      ? "not-deployed"
      : await healthFlag(ctx, target, signal);
  const envKeysMissing =
    !target.pos.golive?.env && Array.isArray(inspected.envNames)
      ? missingEnvKeys(inspected.envNames, {
          realtime: Boolean(target.pos.cloudflare?.workerUrl),
        })
      : [];
  return { flags, inspected, envKeysMissing };
}
// The stored pos.verify of one run of the checks. `envKeysMissing` (names
// only) is present only when keys are missing (warning env-keys-missing).
export const verifyRecord = ({ flags, inspected, envKeysMissing }, at, by) => ({
  at,
  by: by ?? null,
  ...flags,
  // Non-secret project settings: name, actual, expected.
  problems: inspected.problems,
  warnings: inspected.warnings,
  ...(envKeysMissing.length ? { envKeysMissing } : {}),
});
export async function runVerify(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const task = claim.doc;
      const target = await loadTarget(ctx, claim.installationId);
      const checked = await verifyChecks(ctx, target, {
        signal,
        // The task shows the vercel step for vercel, project and env.
        onStep: (step) => slot.mustSet({ step }),
      });
      const { flags } = checked;
      const failed = STEPS.filter(
        (k) => flags[k] !== null && flags[k] !== "ok",
      ).length;
      const now = new Date(ctx.now());
      const detail = STEPS.map((k) => `${k}=${flags[k] ?? "skipped"}`).join(
        " ",
      );
      await transaction(ctx.client, async (session) => {
        // Guarded on the settings revision read at loadTarget: a config or secret
        // change during the run bumps pos.rev, and this result must not overwrite
        // the invalidation that change made.
        const done = await ctx.coll.installations.updateOne(
          { ...slot.filterOf(), "pos.rev": target.pos.rev },
          {
            $set: {
              ...slot.prefixed({
                status: "succeeded",
                step: "done",
                finishedAt: now,
                error: null,
                result: { checks: STEPS.length, failed },
              }),
              "pos.verify": verifyRecord(checked, now, task.by),
            },
          },
          { session },
        );
        if (done.matchedCount !== 1) {
          const stale = await ctx.coll.installations.updateOne(
            slot.filterOf(),
            {
              $set: slot.prefixed({
                status: "failed",
                step: "done",
                finishedAt: now,
                error: {
                  code: "verify-stale",
                  message:
                    "Settings changed while verifying; run verify again.",
                },
              }),
            },
            { session },
          );
          if (stale.matchedCount !== 1) throw new LeaseLost();
          return;
        }
        await audit(
          ctx.db,
          session,
          WORKER_ACTOR,
          "pos.verify.completed",
          "installations",
          claim.installationId,
          detail,
        );
      });
    },
    (error) => failTask(ctx, claim, error),
  );
}
// Terminal failure of a task (fenced).
export async function failTask(ctx, claim, error) {
  const code =
    error instanceof JobFail
      ? error.code
      : error instanceof ProviderError
        ? providerCode(error)
        : "internal";
  const message =
    error instanceof JobFail
      ? error.message
      : "The task could not be completed.";
  await claim.slot.set({
    status: "failed",
    finishedAt: new Date(ctx.now()),
    error: {
      code: isKnownCode(String(code)) ? String(code) : "internal",
      message: String(message).slice(0, 160),
    },
  });
}
