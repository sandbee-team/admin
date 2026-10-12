// Pure rules of the "deploy this commit to all clients" rollout (P3, D39,
// docs/P3-ROLLOUT.md). One system_state row `pos-rollout` holds the current or
// last rollout (D4); the worker drives it, one client at a time, through the
// normal deploy job. Shared by the API, the worker and the panel. Nothing here
// touches the network, the database or the clock.
import { ACTIVE_STATES, readinessOf } from "./deploy.js";
import { isKnownCode } from "./deploy-errors.js";

export const ROLLOUT_ROW_ID = "pos-rollout";
export const ROLLOUT_STATES = [
  "running",
  "cancelling",
  "stopped",
  "cancelled",
  "completed",
];
export const ROLLOUT_ACTIVE = ["running", "cancelling"];
export const ROLLOUT_FINISHED = ["stopped", "cancelled", "completed"];
export const TARGET_STATES = [
  "pending",
  "building",
  "deploying",
  "succeeded",
  "failed",
  "skipped",
];
export const PREBUILD_STATES = ["queued", "joined", "unavailable"];
// The canary goes first (owner, 2026-10-12); then every other client A-Z.
export const CANARY_SLUG = "demo";
export const ROLLOUT_CONFIRM = "deploy all";
export const MAX_TARGETS = 100;
// Readiness checked once for the whole rollout (start and resume). The build
// cache is required as well: without it a pre-built artifact lives only 2 h.
export const ROLLOUT_GATE = [
  "worker",
  "builder",
  "source-token",
  "authenticator",
  "not-frozen",
];
// A client's own readiness: blocked = left out of the plan, or the rollout
// stops at that client.
export const TARGET_ITEMS = [
  "vercel-token",
  "project-ids",
  "verified",
  "host",
  "image-realtime",
];
// Job steps that change production: the client shows as "deploying".
export const DEPLOYING_STEPS = ["upload", "vercel", "health", "finalize"];

// The installation fields a rollout reads per client (API plan/start and the
// worker at the client's turn). The Vercel token is reduced to a flag inside
// Mongo, so no secret box is ever read for a rollout decision.
export const TARGET_PROJECTION = {
  customerId: 1,
  status: 1,
  "pos.rev": 1,
  "pos.slug": 1,
  "pos.host": 1,
  "pos.deployLock": 1,
  "pos.deploy.current": 1,
  "pos.deploy.last": 1,
  "pos.verify": 1,
  "pos.vercel.projectId": 1,
  "pos.vercel.orgId": 1,
  "pos.image.store": 1,
  "pos.image.publicBaseUrl": 1,
  "pos.image.cloudName": 1,
  "pos.cloudflare.workerUrl": 1,
  // A stored token is always a sealed box (an object); anything else is none.
  tokenSet: { $eq: [{ $type: "$pos.vercel.token" }, "object"] },
};
// classifyTarget facts from an installation read with TARGET_PROJECTION.
export const targetFacts = (row, customer, inputsOk, now) => ({
  pos: row?.pos
    ? {
        ...row.pos,
        vercel: { ...row.pos.vercel, token: row.tokenSet ? true : null },
      }
    : null,
  installationId: row?._id,
  customerId: row?.customerId,
  installationStatus: row?.status,
  customerStatus: customer?.status,
  inputsOk,
  now,
});

const rank = (target) => (target.slug === CANARY_SLUG ? 0 : 1);
export const orderTargets = (list) =>
  [...list].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );

// Skip codes for deliberate owner states (and a client already on the
// commit): the rollout continues past them, and Resume leaves them skipped.
export const SKIP_CODES = [
  "not-found",
  "locked",
  "customer-inactive",
  "already-live",
];
// The live version runs this commit and passed its health check (the worker
// writes `last.healthy:false` for a deploy that went live unhealthy; older
// versions have no flag and count as healthy).
const liveOn = (last, sha) => last?.sha === sha && last.healthy !== false;

// What a rollout of `sha` does with one POS installation:
//   {kind:"target"} | {kind:"skip", code} | {kind:"blocked", code, items}
// Deliberate owner states (lock, paused/archived customer, retired
// installation, already on the commit) are skips; a client's own readiness
// problem blocks. facts = {pos, installationId, customerId,
// installationStatus, customerStatus, inputsOk, now}.
export function classifyTarget(facts, sha) {
  const pos = facts.pos;
  if (!pos) return { kind: "skip", code: "not-found" };
  if (pos.deployLock !== false) return { kind: "skip", code: "locked" };
  if (
    ["paused", "archived"].includes(facts.customerStatus) ||
    facts.installationStatus === "retired"
  )
    return { kind: "skip", code: "customer-inactive" };
  if (liveOn(pos.deploy?.last, sha))
    return { kind: "skip", code: "already-live" };
  const view = readinessOf({
    now: facts.now,
    installationId: facts.installationId,
    customerId: facts.customerId,
    pos,
    inputsOk: facts.inputsOk,
    customerStatus: facts.customerStatus,
    installationStatus: facts.installationStatus,
  });
  const items = view.items
    .filter(
      (item) => TARGET_ITEMS.includes(item.id) && item.state === "blocked",
    )
    .map((item) => item.id);
  return items.length
    ? { kind: "blocked", code: "target-not-ready", items }
    : { kind: "target" };
}

// Codes for a finished job that stored none (or one outside the table).
const STATUS_CODE = {
  failed: "internal",
  "rolled-back": "health-failed",
  unhealthy: "health-failed",
  expired: "not-picked-up",
};
// The state of the deploy job `requestId` from the installation's
// pos.deploy. `current` is read first: an unhealthy deploy without a rollback
// also writes `last`. Success = `last` carries the id and is not marked
// unhealthy; a job found nowhere was dismissed or replaced before the driver
// saw it (job-lost). A job refused in preflight because the owner locked or
// paused the client meanwhile is a skip (`stop:false`): the rollout goes on.
// Every other end stops it (`stop:true`).
export function targetOutcome(deploy, requestId) {
  const current = deploy?.current ?? null;
  if (current?.requestId === requestId) {
    if (ACTIVE_STATES.includes(current.status))
      return {
        status: DEPLOYING_STEPS.includes(current.step)
          ? "deploying"
          : "building",
      };
    if (current.status === "cancelled")
      return {
        status: "skipped",
        code: current.error?.code === "frozen" ? "frozen" : "cancelled",
        stop: true,
      };
    const code = current.error?.code;
    if (
      current.status === "failed" &&
      current.error?.step === "preflight" &&
      SKIP_CODES.includes(code)
    )
      return { status: "skipped", code, stop: false };
    return {
      status: "failed",
      code: isKnownCode(code)
        ? code
        : (STATUS_CODE[current.status] ?? "internal"),
      stop: true,
    };
  }
  if (deploy?.last?.requestId === requestId)
    return deploy.last.healthy === false
      ? { status: "failed", code: "health-failed", stop: true }
      : { status: "succeeded" };
  return { status: "failed", code: "job-lost", stop: true };
}

// A client that has not had its turn yet (start, and on Resume the client it
// stopped at and every client not reached).
export const newRolloutTarget = (installationId, slug) => ({
  installationId,
  slug,
  status: "pending",
  requestId: null,
  buildKey: null,
  prebuild: null,
  error: null,
  startedAt: null,
  finishedAt: null,
});

// Resume: the client the rollout stopped at and every client not reached get
// their turn again; succeeded clients and deliberate skips stay as they are,
// so the stopped client really goes first.
export const resumeTargets = (targets) =>
  targets.map((t) =>
    t.status === "succeeded" ||
    (t.status === "skipped" && SKIP_CODES.includes(t.error?.code))
      ? t
      : newRolloutTarget(t.installationId, t.slug),
  );

export function rolloutCounts(targets = []) {
  const count = (...states) =>
    targets.filter((t) => states.includes(t.status)).length;
  return {
    total: targets.length,
    pending: count("pending"),
    active: count("building", "deploying"),
    succeeded: count("succeeded"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
}
