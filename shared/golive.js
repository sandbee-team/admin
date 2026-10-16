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
//   env           {at, rev, keys[<= 30 {name, type, targets, set, fp16,
//                 updatedAt}]} | null   (fp16 never leaves the server; rev =
//                 the pos.rev the env was written at)
//   realtime      {bundleSha256, sha, url, deployedAt, verifiedAt} | null
//   admin         {state seeded|exists, at, rev} | null
//   projectId     the Vercel project this go-live created or adopted | null
//   rev           the pos.rev this run writes against (set at enqueue, moved
//                 by the worker's own bumps; a takeover checks it)
//   deployRequestId  the first deploy job (Unlock and deploy) | null
//   liveAt        Date | null (set once, at `live`)
// Learned parts (address, env, realtime minus its bundle run, admin,
// projectId, deployRequestId, liveAt) are carried into the next run of the
// same installation; run fields are new.
import {
  ACTIVE_TASK_STATES,
  VERIFY_MAX_AGE_MS,
  readinessOf,
  taskBlocks,
} from "./deploy.js";
import { PLATFORM_APEX, labelProblem } from "./web-address.js";

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
// `realtime` is optional: its warning (realtime off) never blocks Start or
// Sync env, but a blocked realtime item (bad account id, slug too long, a
// Worker URL without a token) does, since the env would not match it.
export const GOLIVE_GATES = Object.freeze({
  start: [
    ...GOLIVE_ITEMS.filter((i) => i.required).map((i) => i.id),
    "realtime",
  ],
  check: ["worker", "customer-active"],
  "sync-env": [
    "worker",
    "authenticator",
    "customer-active",
    "vercel-token",
    "mongo-uri",
    "image",
    "realtime",
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
// A project id entered by hand that no Verify of the last 24 hours found
// without a production deployment (health not-deployed; Verify writes it only
// when the project itself checked ok, and a new project has no env yet, so
// the whole verify cannot be "ok"): it may be an existing client (D42).
export const handEnteredLive = (pos, now = Date.now()) => {
  if (!pos?.vercel?.projectId) return false;
  const at = new Date(pos.verify?.at ?? NaN).getTime();
  return !(
    pos.verify?.health === "not-deployed" &&
    Number.isFinite(at) &&
    now - at <= VERIFY_MAX_AGE_MS
  );
};
// Production of this installation is admin's own deploy made after the
// go-live's first Unlock and deploy (that deploy, a later one, a rollback to
// it or a Redeploy) ON THE GO-LIVE'S OWN PROJECT: before the first Unlock and
// deploy the block is locked, so no other admin deploy can exist. Such a
// project is not an "existing client" (D42); a project id changed by hand is.
export const goliveOwnsProduction = (pos) =>
  Boolean(
    pos?.golive?.deployRequestId &&
    pos.golive.projectId &&
    pos.vercel?.projectId === pos.golive.projectId &&
    pos.deploy?.last?.requestId &&
    pos.deploy.last.sha,
  );
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
    // A Vercel project id entered by hand is an existing client (D42) unless
    // Verify found no production deployment on it: Start would otherwise
    // rewrite a live client's address before the project step refuses.
    "new-client":
      pos?.golive ||
      (!pos?.importedAt &&
        !pos?.deploy?.last &&
        !handEnteredLive(pos, ctx.now ?? Date.now()))
        ? OK
        : no(
            pos?.importedAt || pos?.deploy?.last
              ? "This client was imported or is already deployed by admin."
              : "A Vercel project id was entered by hand and no Verify of the last 24 hours shows it was never deployed.",
            text(
              "A live client: Verify and Unlock on the Deploy tab. A new one: run Verify now first (fix any project settings it reports).",
            ),
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
    // Once admin created the login, its password must stay stored (the
    // admin step checks it on every run; it is never minted again).
    "pos-admin": !pos?.posAdmin?.username
      ? no(
          "The POS admin username is not set.",
          link(`${base}#admin`, "Set username"),
        )
      : pos?.golive?.admin?.state === "seeded" &&
          !pos.golive.liveAt &&
          !pos?.posAdmin?.password
        ? no(
            "The POS admin password was removed after admin created the login.",
            link(`${base}#secrets`, "Add it again"),
          )
        : OK,
    realtime: !cf
      ? warn(
          "Realtime off: the POS refreshes by polling.",
          link(`${base}#cloudflare`, "Add Cloudflare"),
        )
      : !cf.token && cf.workerUrl
        ? // Without a token the env step writes REALTIME_* blank, which
          // would not match a hand-entered Worker (Verify: env drift).
          no(
            "A realtime Worker URL is set but no Cloudflare token is stored. Add the token, or clear the Worker URL to run without realtime.",
            link(`${base}#cloudflare`, "Fix realtime"),
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
  // The Start gate's rule: nothing blocked (a warning, e.g. no image store or
  // realtime off, does not hold the go-live back).
  return { items, ready: items.every((i) => i.state !== "blocked") };
}

// Why POS setup no longer matches what this go-live set up, for `action`
// (null = it does; Start re-derives everything, Cancel never writes).
// golive-address: web address, tenant, root domain or Vercel project changed
// (a run would write or check another tenant or project); golive-settings:
// setup changed after the env was written (the first deploy would ship the
// old env and admin login); golive-realtime: Sync env would write a Worker
// that is not the verified one. `pos` = the stored POS block.
export function goliveDriftOf(pos, action) {
  const g = pos?.golive;
  if (!g || action === "start" || action === "cancel") return null;
  const a = g.address ?? {};
  if (
    !a.label ||
    pos.subdomain !== a.label ||
    pos.host !== a.host ||
    pos.tenantId !== a.label ||
    pos.rootDomain !== PLATFORM_APEX ||
    (g.projectId && pos.vercel?.projectId !== g.projectId)
  )
    return "golive-address";
  // Check DNS ends in the ready step, which refuses the same change.
  if (["deploy", "check"].includes(action) && (g.env?.rev ?? null) !== pos.rev)
    return "golive-settings";
  if (action === "sync-env") {
    const rt = g.realtime;
    if (rt?.deployedAt && !rt.verifiedAt && pos.cloudflare?.token)
      return "golive-realtime";
    if (
      rt?.url &&
      pos.cloudflare?.workerUrl &&
      pos.cloudflare.workerUrl !== rt.url
    )
      return "golive-realtime";
  }
  return null;
}
export const DRIFT_MESSAGES = Object.freeze({
  "golive-address":
    "The web address, tenant or Vercel project in POS setup changed since the go-live started. Put the old values back (before go-live, Start again also works).",
  "golive-settings":
    "POS settings changed after the environment was written. Run the go-live again (Run all steps again / Start again) first.",
  "golive-realtime":
    "The realtime Worker is not the one admin verified. Press Update realtime Worker first, or remove the Cloudflare token to switch realtime off.",
});
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
