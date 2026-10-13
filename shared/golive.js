// Pure contract of a NEW client's go-live from admin (P5 Stage 3, D41-D47),
// shared by the API, the worker and the panel. Nothing here touches the
// network, the database or the clock.
//
// installations.pos.golive (one slot per installation; written only by
// backend/modules/golive.js and backend/worker/golive.js). Stored form:
//   status        queued | running | waiting | deploying | failed | cancelled
//                 | live                                    (GOLIVE_STATES)
//   action        start | check | sync-env | realtime       (GOLIVE_ACTIONS)
//   requestId     uuid v4 of this run
//   by            {id, name} of the staff member who asked
//   requestedAt   Date (the plan's `at`; the queue-expiry rule reads it)
//   startedAt, endedAt   Date | null (first claim, end of the run)
//   branch, sha   the go-live commit (realtime bundle + first deploy)
//   step          "queued" | a GOLIVE_STEPS name (the current one)
//   steps         [{name, state, startedAt, endedAt, note <= 120}] (<= 12),
//                 state = pending|running|done|skipped|failed
//   waitingFor    null | dns | deploy (status waiting only)
//   lease         {owner, until, fence}; every worker write is filtered on
//                 {requestId, lease.owner, lease.fence}. Nothing holds a lease
//                 while waiting, deploying, or finished
//   attempt       integer, per claim (> MAX_ATTEMPTS => failed)
//   heartbeatAt   Date | null
//   cancelRequested  boolean (a running run stops between steps)
//   error         {step, code, message <= 160} | null (codes: deploy-errors)
//   warnings      [code] (<= 8)
//   address       {label, host, records[<= 4 {type, name, value}],
//                 cname {ok, found <= 253} | null, txt {ok, found[<= 4]} |
//                 null, verified, configured (true|false|null), tls, state
//                 (ADDRESS_STATES), checkedAt}
//   env           {at, keys[<= 30 {name, type, targets, set, fp16,
//                 updatedAt}]} | null   (fp16 never leaves the server)
//   realtime      {bundleSha256, sha, deployedAt, verifiedAt} | null
//   admin         {state seeded|exists, at} | null
//   deployRequestId  the first deploy job (Unlock and deploy) | null
//   liveAt        Date | null (set once, at `live`)
// Learned parts (address, env, realtime, admin, deployRequestId, liveAt) are
// carried into the next run of the same installation; run fields are new.
import { ACTIVE_TASK_STATES, readinessOf, taskBlocks } from "./deploy.js";
import { labelProblem } from "./web-address.js";

export const GOLIVE_STATES = Object.freeze([
  "queued",
  "running",
  "waiting",
  "deploying",
  "failed",
  "cancelled",
  "live",
]);
// queued/running hold (or wait for) a lease: the installation is busy for
// deploys, tasks and POS setup writes (D41), and vice versa.
export const GOLIVE_ACTIVE = Object.freeze(["queued", "running"]);
export const GOLIVE_ACTIONS = Object.freeze([
  "start",
  "check",
  "sync-env",
  "realtime",
]);
// Every step a go-live can show, in order. `deploy` and `finish` belong to
// Unlock and deploy (the normal deploy job, observed by the go-live lane).
export const GOLIVE_STEPS = Object.freeze([
  "check",
  "project",
  "secrets",
  "realtime",
  "domain",
  "env",
  "admin",
  "dns",
  "ready",
  "deploy",
  "finish",
]);
// The steps one run of an action executes, in order.
export const GOLIVE_RUN_STEPS = Object.freeze({
  start: Object.freeze([
    "check",
    "project",
    "secrets",
    "realtime",
    "domain",
    "env",
    "admin",
    "dns",
    "ready",
  ]),
  check: Object.freeze(["dns", "ready"]),
  "sync-env": Object.freeze(["secrets", "env"]),
  realtime: Object.freeze(["realtime", "env"]),
});
export const WAITING_FOR = Object.freeze(["dns", "deploy"]);
export const GOLIVE_LIMITS = Object.freeze({
  steps: 12,
  note: 120,
  message: 160,
  warnings: 8,
  records: 4,
  found: 253,
  txtFound: 4,
  txtValue: 1024,
  envKeys: 30,
});
// Rate limits per installation (per hour).
export const GOLIVE_RATE = Object.freeze({ start: 10, check: 30 });

// Does this go-live still block a deploy, a task or a setup write? Same
// queue-expiry and dead-lease rules as the task slot (shared/deploy.js).
export function goliveBlocks(golive, now = Date.now(), workerAt) {
  if (!golive || !GOLIVE_ACTIVE.includes(golive.status)) return false;
  // taskBlocks reads {status queued|running, requestedAt, lease}.
  return taskBlocks(golive, now, workerAt);
}
// ACTIVE_TASK_STATES and GOLIVE_ACTIVE must stay the same pair of names.
if (ACTIVE_TASK_STATES.join() !== GOLIVE_ACTIVE.join())
  throw new Error("golive active states drifted from the task states");

// Why `action` cannot run now (null = it can). Codes: busy (a run is
// active), golive-state (wrong state for the action). A queued/running run
// whose lease died (or whose queue expired) counts as ended.
export function goliveActionProblem(
  golive,
  action,
  now = Date.now(),
  workerAt,
) {
  // Cancel is for active and waiting runs (a dead one is ended by it).
  if (action === "cancel")
    return golive && ["queued", "running", "waiting"].includes(golive.status)
      ? null
      : "golive-state";
  if (goliveBlocks(golive, now, workerAt)) return "busy";
  const status =
    golive && GOLIVE_ACTIVE.includes(golive.status) ? "failed" : golive?.status;
  const live = Boolean(golive?.liveAt);
  const ended = ["failed", "cancelled"].includes(status);
  switch (action) {
    case "start":
      return !live && (!golive || ended || status === "waiting")
        ? null
        : "golive-state";
    case "check":
      return !live && status === "waiting" ? null : "golive-state";
    case "sync-env":
    case "realtime":
      return live && (status === "live" || ended) ? null : "golive-state";
    case "deploy":
      return !live && status === "waiting" && golive.waitingFor === "deploy"
        ? null
        : "golive-state";
    default:
      return "golive-state";
  }
}

// Fresh step rows of a run. `check` keeps what the earlier steps did and
// resets the rest; the other actions start a new list.
const row = (name) => ({
  name,
  state: "pending",
  startedAt: null,
  endedAt: null,
  note: "",
});
export function goliveStepsFor(action, priorSteps) {
  if (action === "start") return GOLIVE_STEPS.map(row);
  if (action === "check") {
    const prior = Array.isArray(priorSteps) ? priorSteps : [];
    const from = GOLIVE_STEPS.indexOf("dns");
    return GOLIVE_STEPS.map((name, i) => {
      const old = prior.find((s) => s?.name === name);
      return i < from && old
        ? {
            name,
            state: old.state,
            startedAt: old.startedAt ?? null,
            endedAt: old.endedAt ?? null,
            note: old.note ?? "",
          }
        : row(name);
    });
  }
  return GOLIVE_RUN_STEPS[action].map(row);
}

// ---- readiness ---------------------------------------------------------------
// The checklist of the Go live tab and the 409 not-ready gate of its actions.
// ctx = the readinessOf ctx of shared/deploy.js (worker, sources,
// authenticator, pos, customerStatus, installationStatus, ...). Shared items
// are read from readinessOf so both checklists say the same thing.
export const GOLIVE_ITEMS = Object.freeze([
  { id: "worker", group: "admin", required: true },
  { id: "builder", group: "admin", required: true },
  { id: "source-token", group: "admin", required: true },
  { id: "authenticator", group: "admin", required: true },
  { id: "new-client", group: "client", required: true },
  { id: "customer-active", group: "client", required: true },
  { id: "vercel-token", group: "client", required: true },
  { id: "mongo-uri", group: "client", required: true },
  { id: "web-address", group: "client", required: true },
  { id: "image", group: "client", required: true },
  { id: "pos-admin", group: "client", required: true },
  { id: "realtime", group: "client", required: false },
]);
const SHARED_ITEMS = [
  "worker",
  "builder",
  "source-token",
  "authenticator",
  "customer-active",
  "vercel-token",
];
export const GOLIVE_GATES = Object.freeze({
  start: GOLIVE_ITEMS.filter((i) => i.required).map((i) => i.id),
  check: ["worker", "customer-active"],
  "sync-env": [
    "worker",
    "authenticator",
    "customer-active",
    "vercel-token",
    "mongo-uri",
    "image",
  ],
  // An explicit Worker update needs realtime switched on (a warn blocks).
  realtime: [
    "worker",
    "builder",
    "authenticator",
    "customer-active",
    "vercel-token",
    "mongo-uri",
    "image",
    "realtime",
  ],
});
// Longest slug whose Worker name `pos-realtime-<slug>` fits 63 characters.
export const WORKER_SLUG_MAX = 50;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const text = (value) => ({ kind: "text", text: value });
const link = (to, label) => ({ kind: "link", to, label });
export function goliveReadinessOf(ctx) {
  const pos = ctx.pos ?? null;
  const base = `/installations/${ctx.installationId}/pos`;
  const shared = new Map(readinessOf(ctx).items.map((i) => [i.id, i]));
  const OK = [true];
  const no = (reason, fix = null) => [false, reason, fix];
  const warn = (reason, fix = null) => ["warn", reason, fix];
  const label = pos?.subdomain ?? "";
  const problem = label ? labelProblem(label) : "label-missing";
  const image = pos?.image ?? {};
  const imageSet =
    image.store === "r2"
      ? Boolean(image.r2AccountId && image.bucket && image.publicBaseUrl)
      : image.store === "cloudinary"
        ? Boolean(image.cloudName)
        : false;
  const cf = pos?.cloudflare ?? null;
  const results = {
    "new-client":
      pos?.golive || (!pos?.importedAt && !pos?.deploy?.last)
        ? OK
        : no(
            "This client was imported or is already deployed by admin.",
            text("Use Verify and Unlock on the Deploy tab instead."),
          ),
    "mongo-uri": pos?.mongo?.uri
      ? OK
      : no("No database URI is stored.", link(`${base}#secrets`, "Add URI")),
    "web-address":
      problem === null
        ? OK
        : no(
            problem === "label-missing"
              ? "The web address label is not set."
              : problem === "label-reserved"
                ? "This web address label is reserved."
                : "The web address label is not one DNS label.",
            link(`${base}#host`, "Set label"),
          ),
    image: !image.store
      ? warn(
          "No image store: image uploads stay off.",
          link(`${base}#image`, "Choose a store"),
        )
      : !imageSet
        ? no(
            "The image store settings are incomplete.",
            link(`${base}#image`, "Fix settings"),
          )
        : !pos?.image?.keys
          ? no("No image keys are stored.", link(`${base}#secrets`, "Add keys"))
          : OK,
    "pos-admin": pos?.posAdmin?.username
      ? OK
      : no(
          "The POS admin username is not set.",
          link(`${base}#admin`, "Set username"),
        ),
    realtime: !cf
      ? warn(
          "Realtime off: the POS refreshes by polling.",
          link(`${base}#cloudflare`, "Add Cloudflare"),
        )
      : !cf.token
        ? warn(
            "No Cloudflare token: realtime off.",
            link(`${base}#secrets`, "Add token"),
          )
        : cf.accountId && !ACCOUNT_RE.test(cf.accountId)
          ? no(
              "The Cloudflare account id is not 32 hex characters.",
              link(`${base}#cloudflare`, "Fix id"),
            )
          : String(pos?.slug ?? "").length > WORKER_SLUG_MAX
            ? no(
                "The slug is too long for a realtime Worker name.",
                text("Use a slug of at most 50 characters."),
              )
            : OK,
  };
  const items = GOLIVE_ITEMS.map((item) => {
    if (SHARED_ITEMS.includes(item.id)) {
      const s = shared.get(item.id);
      return { ...s, group: item.group, required: item.required };
    }
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
    ready: items.every((i) => !i.required || i.state === "ok"),
  };
}
// Ids that block `action`, in checklist order. For `realtime` a warning on the
// realtime item blocks too (there is nothing to update without a token).
export function goliveBlockedFor(readiness, action) {
  const gate = GOLIVE_GATES[action] ?? [];
  return readiness.items
    .filter(
      (i) =>
        gate.includes(i.id) &&
        (i.state === "blocked" ||
          (action === "realtime" && i.id === "realtime" && i.state !== "ok")),
    )
    .map((i) => i.id);
}
