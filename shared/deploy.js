// Pure constants shared by the API, worker and panel for POS deploys (Stage 2).
// Nothing here touches the network, the database or the clock.
export const DEPLOY_STATES = [
  "queued",
  "running",
  "cancelling",
  "failed",
  "cancelled",
  "rolled-back",
  "unhealthy",
  "expired",
];
export const DEPLOY_KINDS = ["deploy", "redeploy", "rollback"];
// Internal worker steps, in order (rev 2 section 1, row 5).
export const DEPLOY_STEPS = [
  "queued",
  "preflight",
  "resolve",
  "build",
  "fetch",
  "upload",
  "vercel",
  "health",
  "finalize",
];
// The five steps the panel shows, mapped from the internal ones.
export const UI_STEPS = [
  { id: "resolve", label: "Resolve", steps: ["preflight", "resolve"] },
  { id: "build", label: "Build", steps: ["build", "fetch"] },
  { id: "upload", label: "Upload", steps: ["upload"] },
  { id: "live", label: "Go live", steps: ["vercel"] },
  { id: "health", label: "Health", steps: ["health", "finalize"] },
];
export const BUILD_STATES = [
  "queued",
  "dispatching",
  "building",
  "collecting",
  "storing",
  "ready",
  "failed",
  "cancelled",
];
export const TASK_KINDS = ["verify", "db-backup", "purge-preview", "purge"];
export const BUILD_SOURCES = ["cache", "fresh", "artifact"];
// Readiness item ids: one list for the UI checklist and the 409 not-ready body.
export const READINESS_ITEMS = [
  { id: "worker", group: "admin", required: true },
  { id: "builder", group: "admin", required: true },
  { id: "source-token", group: "admin", required: true },
  { id: "build-cache", group: "admin", required: false },
  { id: "authenticator", group: "admin", required: true },
  { id: "not-frozen", group: "admin", required: true },
  { id: "vercel-token", group: "client", required: true },
  { id: "project-ids", group: "client", required: true },
  { id: "verified", group: "client", required: true },
  { id: "host", group: "client", required: true },
  { id: "image-realtime", group: "client", required: true },
  { id: "unlocked", group: "client", required: true },
  { id: "customer-active", group: "client", required: true },
];
export const READINESS_IDS = READINESS_ITEMS.map((item) => item.id);
export const NEXT_PUBLIC_KEYS = [
  "NEXT_PUBLIC_R2_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
  "NEXT_PUBLIC_REALTIME_URL",
];
export const SHA_RE = /^[0-9a-f]{40}$/;
export const BUILD_KEY_RE = /^[0-9a-f]{64}$/;
export const BRANCH_RE =
  /^(?!-)(?!.*\.\.)(?!\/)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const isSha = (value) => typeof value === "string" && SHA_RE.test(value);
export const isBranch = (value) =>
  typeof value === "string" && BRANCH_RE.test(value);
export const sha7 = (sha) => (isSha(sha) ? sha.slice(0, 7) : "");

// ============================================================================
// JOB CONTRACT (Stage 2 W3). The API only ENQUEUES and READS; the worker (W2)
// executes. Every shape below is the stored form (MongoDB). What the panel
// receives is a whitelisted view (backend/lib/deploy-view.js): lease and fence
// fields, full build keys, object keys and run ids never leave the server.
// The full prose version is docs/API.md "Deploy job contract".
//
// installations.pos.deploy = { current, last, previous, cutoverAt }
//
// current (one slot per installation; null when idle; a failed/cancelled/
// rolled-back/unhealthy/expired job STAYS here until dismissed or replaced):
//   kind            deploy | redeploy | rollback
//   requestId       uuid v4. Job id, build run-name suffix, artifact name and
//                   Vercel meta `sandbeeRequest` (idempotency key)
//   branch, sha     what to ship (sha is the exact 40-hex commit). For a
//                   rollback they describe the TARGET (previous.*)
//   buildKey        64 hex or null. The API fills it at enqueue when the
//                   builder descriptor is readable; the worker recomputes it
//                   in `resolve` and overwrites
//   commit          {sha, branch, headline <= 120 (first line), authorName
//                   (name only, never an e-mail), date} | null. Set by the API
//                   at enqueue (deploy: from GitHub for the exact sha;
//                   redeploy/rollback: copied from the stored version) because
//                   the worker has no source token. The worker copies it into
//                   last.commit at finalize. Control and bidi characters removed
//   by              {id, name} of the staff member
//   requestedAt     Date
//   status          queued | running | cancelling | failed | cancelled |
//                   rolled-back | unhealthy | expired   (DEPLOY_STATES)
//   step            queued | preflight | resolve | build | fetch | upload |
//                   vercel | health | finalize          (DEPLOY_STEPS)
//   steps           [{name, state, startedAt, endedAt, note}], state is
//                   pending|running|done|skipped|failed (STEP_STATES), note
//                   <= 120 chars. Deploy/redeploy: JOB_STEPS.deploy;
//                   rollback: JOB_STEPS.rollback. All "pending" at enqueue
//   lease           {owner, until, fence}: owner = worker id, until = Date,
//                   fence = integer incremented by every claim. Every worker
//                   write is filtered on {requestId, lease.owner, lease.fence}
//   attempt         integer, incremented per claim (> MAX_ATTEMPTS => failed)
//   heartbeatAt     Date | null
//   runId, runUrl, artifactId   GitHub build run (null until dispatched)
//   uploadStartedAt Date | null (takeover reconcile window)
//   vercelDeploymentId  deployment this job concerns: the rollback TARGET at
//                   enqueue; the new deployment once uploaded
//   url             deployment URL | null
//   baseline        {vercelDeploymentId, healthy} | null (set in preflight)
//   cancelRequested boolean
//   error           {step, code, message <= 160} | null  (code ERROR_CODE_RE)
//   finishedAt      Date | null
//
// last / previous (the live production deployment made by admin, and the
// rollback target; both written by the worker's finalize transaction):
//   kind, requestId, branch, sha, at, by{id,name}, vercelDeploymentId, url,
//   durationMs, runUrl,
//   status  succeeded | rolled-back-to | pre-admin     (VERSION_STATUSES)
//   build   {buildKey, objectKey, touchedAt, source: cache|fresh|artifact}
//   commit  {sha, branch, headline <= 120, authorName, date}
// cutoverAt: Date | null, the first verified prebuilt deploy.
//
// installations.pos.task (one slot, one active task per installation):
//   id uuid, kind (TASK_KINDS), status queued|running|succeeded|failed|
//   cancelled|expired (TASK_STATES), step, progress {..counts only..},
//   lease{owner,until,fence}, attempt, by{id,name}, requestedAt, finishedAt,
//   params (purge only: {ids[], digest, previewTaskId}),
//   result (kind specific; purge-preview: {at, candidates[<=200 {id,
//   createdAt, target, state}], total, keep}), error {code, message <= 160}
// installations.pos.verify = {at, by, vercel, project, env, mongo,
//   cloudflare, health}, each "ok" | a fixed code | null (skipped).
//
// system_state rows:
//   pos-worker        heartbeat: {_id, at, workerId, version, cliVersion,
//                     builderConfigured, builder{sha, protocol, nodeVersion, cliVersion,
//                     ok, checkedAt}, lastBuildMs}. Online = at < 90 s old
//   pos-deploy-freeze {_id, on, reason, by{id,name}, at}   global freeze
//   pos-build:<sha>:<buildKey>   transient build row: {_id, kind:"build",
//                     status (BUILD_STATES), sha, buildKey, inputs{settings,
//                     env, builder}, branch, commit, lease{owner,until,fence},
//                     attempt, runId, runUrl, artifactId, waiters[<=20 job
//                     ids], prepared{by,at} | null, error, createdAt,
//                     finishedAt}. The unique _id is the single-flight lock
//   pos-retention     daily copy-forward sweep: {_id, status, at, lease, result}
// ============================================================================
export const STEP_STATES = ["pending", "running", "done", "skipped", "failed"];
export const TASK_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];
export const VERSION_STATUSES = ["succeeded", "rolled-back-to", "pre-admin"];
export const JOB_STEPS = {
  deploy: [
    "preflight",
    "resolve",
    "build",
    "fetch",
    "upload",
    "vercel",
    "health",
    "finalize",
  ],
  rollback: ["preflight", "vercel", "health", "finalize"],
};
export const ACTIVE_STATES = ["queued", "running", "cancelling"];
export const TERMINAL_STATES = DEPLOY_STATES.filter(
  (state) => !ACTIVE_STATES.includes(state),
);
export const ACTIVE_TASK_STATES = ["queued", "running"];
// A job may be cancelled only before the upload step.
export const CANCELLABLE_STEPS = [
  "queued",
  "preflight",
  "resolve",
  "build",
  "fetch",
];
export const ERROR_CODE_RE = /^[a-z0-9-]{1,40}$/;
export const WORKER_ONLINE_MS = 90 * 1000;
export const LEASE_MS = 60 * 1000;
export const HEARTBEAT_MS = 15 * 1000;
export const QUEUED_EXPIRY_MS = 10 * 60 * 1000;
// An active job whose lease has been dead this long no longer blocks a new one.
export const DEAD_LEASE_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const VERIFY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BUILDER_CHECK_MAX_AGE_MS = 30 * 60 * 1000;
export const RUN_LINK_DAYS = 7;
export const PURGE_WINDOW_MS = 30 * 60 * 1000;
export const BUILD_ROW_PREFIX = "pos-build:";
export const buildRowId = (sha, buildKey) =>
  `${BUILD_ROW_PREFIX}${sha}:${buildKey}`;
export const isActiveState = (status) => ACTIVE_STATES.includes(status);
const ms = (value) =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
// Does this `current` job still block a new request? (Shared by the enqueue
// filter in the API and by the views.) A queued job older than the expiry and
// an active job whose lease has been dead for DEAD_LEASE_MS do not.
// Queue expiry rule (shared with the worker's lease.js): a queued job or task
// is never free/expired while the worker heartbeat is fresh; only when the
// heartbeat has been stale for QUEUED_EXPIRY_MS (or never existed) AND the
// item itself is older than that. `workerAt` undefined = unknown: a queued
// item then always blocks (conservative).
export const workerStale = (workerAt, now = Date.now()) => {
  const at = ms(workerAt);
  return !Number.isFinite(at) || now - at >= QUEUED_EXPIRY_MS;
};
export const queuedExpired = (item, workerAt, now = Date.now()) =>
  workerAt !== undefined &&
  now - ms(item?.requestedAt) > QUEUED_EXPIRY_MS &&
  workerStale(workerAt, now);
export function jobBlocks(current, now = Date.now(), workerAt) {
  if (!current || !isActiveState(current.status)) return false;
  if (current.status === "queued")
    return !queuedExpired(current, workerAt, now);
  const until = ms(current.lease?.until);
  return !(Number.isFinite(until) && now - until > DEAD_LEASE_MS);
}
// Same rule for the one task slot (status queued|running).
export function taskBlocks(task, now = Date.now(), workerAt) {
  if (!task || !ACTIVE_TASK_STATES.includes(task.status)) return false;
  if (task.status === "queued") return !queuedExpired(task, workerAt, now);
  const until = ms(task.lease?.until);
  return !(Number.isFinite(until) && now - until > DEAD_LEASE_MS);
}

// ---- readiness ---------------------------------------------------------------
// One function for the checklist in the panel and for the enqueue gate (409
// {code:"not-ready", items:[ids]}). Pure: every fact is passed in.
// ctx: {now, installationId, customerId, worker (heartbeat row | null),
//   sources{source (API source token), builder (the WORKER's builder token,
//   from its heartbeat builderConfigured)}, cacheConfigured,
//   authenticator (staff has TOTP), freeze ({on} | null), pos (stored pos),
//   inputsOk (build inputs derivable), customerStatus, installationStatus}
// Item: {id, group, required, state: ok|blocked|warn, reason, fix}
const link = (to, label) => ({ kind: "link", to, label });
const note = (value) => ({ kind: "text", text: value });
const allRequired = READINESS_ITEMS.filter((item) => item.required).map(
  (item) => item.id,
);
// Which readiness items gate which operation.
export const GATES = {
  deploy: allRequired,
  redeploy: allRequired,
  rollback: [
    "worker",
    "authenticator",
    "vercel-token",
    "project-ids",
    "host",
    "unlocked",
    "customer-active",
  ],
  build: ["worker", "builder", "source-token", "image-realtime"],
  verify: ["worker"],
  unlock: [
    "vercel-token",
    "project-ids",
    "host",
    "verified",
    "customer-active",
  ],
  purge: [
    "worker",
    "vercel-token",
    "project-ids",
    "unlocked",
    "customer-active",
  ],
};
// "ok" | "failed" (a flag is not ok) | "stale" (all ok but older than 24 h)
// | "missing" (never verified).
export function verifyStateOf(verify, now = Date.now()) {
  if (!verify) return "missing";
  const flagsOk =
    ["vercel", "project", "env", "mongo", "health"].every(
      (key) => verify[key] === "ok",
    ) && [undefined, null, "ok"].includes(verify.cloudflare);
  if (!flagsOk) return "failed";
  return now - ms(verify.at) <= VERIFY_MAX_AGE_MS ? "ok" : "stale";
}
export function readinessOf(ctx) {
  const now = ctx.now ?? Date.now();
  const pos = ctx.pos ?? null;
  const base = `/installations/${ctx.installationId}/pos`;
  const beat = ctx.worker ? ms(ctx.worker.at) : NaN;
  const online = Number.isFinite(beat) && now - beat < WORKER_ONLINE_MS;
  const builder = ctx.worker?.builder ?? null;
  const verify = pos?.verify ?? null;
  const verified = verifyStateOf(verify, now);
  const OK = [true];
  const no = (reason, fix = null) => [false, reason, fix];
  const results = {
    worker: online
      ? OK
      : no(
          "The deploy worker is offline.",
          note("Check the worker container."),
        ),
    builder: !online
      ? no("Needs the deploy worker.")
      : !ctx.sources?.builder
        ? no(
            "The worker has no builder token.",
            note("Set POS_GITHUB_BUILDER_TOKEN on the worker container."),
          )
        : !builder?.ok
          ? no(
              "The builder check failed.",
              note("Check pos-builder (builder.json, token)."),
            )
          : !(now - ms(builder.checkedAt) < BUILDER_CHECK_MAX_AGE_MS)
            ? no(
                "The builder check is stale.",
                note("Wait for the next worker check."),
              )
            : builder.cliVersion !== ctx.worker.cliVersion
              ? no(
                  "The builder and worker CLI versions differ.",
                  note("Update the worker image or pos-builder."),
                )
              : OK,
    "source-token": ctx.sources?.source
      ? OK
      : no(
          "The source token is not configured.",
          note("Set POS_GITHUB_SOURCE_TOKEN."),
        ),
    "build-cache": ctx.cacheConfigured
      ? OK
      : [
          "warn",
          "Build cache off: every deploy builds again.",
          note("Configure S3, then use Test build storage."),
        ],
    authenticator: ctx.authenticator
      ? OK
      : no(
          "Your authenticator is not enrolled.",
          link("/account", "Set up authenticator"),
        ),
    "not-frozen": ctx.freeze?.on
      ? no("Deploys are frozen.", note("The owner can unfreeze deploys."))
      : OK,
    "vercel-token": pos?.vercel?.token
      ? OK
      : no("No Vercel token is stored.", link(`${base}#secrets`, "Add token")),
    "project-ids":
      pos?.vercel?.projectId && pos?.vercel?.orgId
        ? OK
        : no(
            "The Vercel project or organisation id is missing.",
            link(`${base}#vercel`, "Add ids"),
          ),
    verified:
      verified === "failed" || verified === "missing"
        ? no("Credentials are not verified.", note("Run Verify now."))
        : verified === "stale"
          ? no(
              "The last verification is older than 24 hours.",
              note("Run Verify now."),
            )
          : OK,
    host: pos?.host
      ? OK
      : no("The web address is not set.", link(`${base}#host`, "Set host")),
    "image-realtime": ctx.inputsOk
      ? OK
      : no(
          "Image or realtime settings cannot be used for a build.",
          link(`${base}#image`, "Fix settings"),
        ),
    unlocked:
      pos && pos.deployLock === false
        ? OK
        : no(
            "Deploys are locked for this client.",
            note("The owner can unlock after a clean verify."),
          ),
    "customer-active":
      ["paused", "archived"].includes(ctx.customerStatus) ||
      ctx.installationStatus === "retired"
        ? no(
            "The customer is paused or archived, or the installation is retired.",
            link(`/customers/${ctx.customerId}`, "Open customer"),
          )
        : OK,
  };
  const items = READINESS_ITEMS.map((item) => {
    const [ok, reason = "", fix = null] = results[item.id];
    return {
      id: item.id,
      group: item.group,
      required: item.required,
      state: ok === true ? "ok" : ok === "warn" ? "warn" : "blocked",
      reason: ok === true ? "" : reason,
      fix: ok === true ? null : fix,
    };
  });
  return {
    items,
    ready: items.every((item) => !item.required || item.state === "ok"),
  };
}
// Ids that block one operation (see GATES), in checklist order.
export const blockedFor = (readiness, gate) =>
  readiness.items
    .filter(
      (item) =>
        GATES[gate].includes(item.id) &&
        item.required &&
        item.state === "blocked",
    )
    .map((item) => item.id);
