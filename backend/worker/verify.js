// Shared target loading (decrypting the customer's secrets, in this process
// only), the Vercel project inspection used by both preflight and the verify
// task, and the verify task itself. Results are fixed codes: no provider text,
// no value of any secret and no URL ever reaches a stored field.
import { decrypt } from "../lib/crypto.js";
import { ProviderError } from "../lib/provider-http.js";
import { canonicalEnvValue, nextPublicOf } from "../lib/build-inputs.js";
import { probeHealth, probeLogin } from "../lib/pos-health.js";
import { NEXT_PUBLIC_KEYS } from "../../shared/deploy.js";
import { isKnownCode, providerFlag } from "../../shared/deploy-errors.js";
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
export async function inspectProject(vercel, target, { signal } = {}) {
  const out = {
    vercel: null,
    project: null,
    env: null,
    names: [],
    projectData: null,
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
    const wrong = [];
    if (project.framework !== "nextjs") wrong.push("framework");
    if (project.rootDirectory !== "apps/cafe") wrong.push("rootDirectory");
    if (project.nodeVersion !== "22.x") wrong.push("nodeVersion");
    out.project = wrong.length ? "settings" : "ok";
    out.names.push(...wrong);
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
const STEPS = ["vercel", "project", "env", "mongo", "cloudflare", "health"];
export async function runVerify(ctx, claim) {
  const { slot } = claim;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const task = claim.doc;
      const target = await loadTarget(ctx, claim.installationId);
      const vercel = ctx.vercelFor({
        token: target.token,
        teamId: target.teamId,
      });
      const flags = {
        vercel: null,
        project: null,
        env: null,
        mongo: null,
        cloudflare: null,
        health: null,
      };
      await slot.mustSet({ step: "vercel" });
      const inspected = await inspectProject(vercel, target, { signal });
      flags.vercel = inspected.vercel;
      flags.project = inspected.project;
      flags.env = inspected.env;
      await slot.mustSet({ step: "mongo" });
      const uri = openSecret(
        ctx,
        claim.installationId,
        target.pos,
        "mongo.uri",
      );
      flags.mongo = uri ? await ctx.pingMongo(uri) : "not-set";
      await slot.mustSet({ step: "cloudflare" });
      const cfToken = openSecret(
        ctx,
        claim.installationId,
        target.pos,
        "cloudflare.token",
      );
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
      await slot.mustSet({ step: "health" });
      flags.health = await healthFlag(ctx, target, signal);
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
              "pos.verify": { at: now, by: task.by ?? null, ...flags },
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
