// Builders of the stored deploy documents (JOB CONTRACT, shared/deploy.js),
// shared by the API (enqueue, prepare build), the worker's build step, the
// rollout driver (P3) and the go-live (P5), so every writer creates exactly
// the same shapes.
import { randomUUID } from "node:crypto";
import {
  CANCELLABLE_STEPS,
  DEAD_LEASE_MS,
  JOB_STEPS,
  QUEUED_EXPIRY_MS,
  workerStale,
} from "../../shared/deploy.js";
import { GOLIVE_ACTIVE, goliveStepsFor } from "../../shared/golive.js";
import { PLATFORM_APEX } from "../../shared/web-address.js";

export const person = (staff) => ({ id: staff._id, name: staff.name });
export const stepsFor = (kind) =>
  JOB_STEPS[kind === "rollback" ? "rollback" : "deploy"].map((name) => ({
    name,
    state: "pending",
    startedAt: null,
    endedAt: null,
    note: "",
  }));
export const leaseless = () => ({ owner: null, until: null, fence: 0 });
// A slot is free when empty, finished, expired while queued, or its lease has
// been dead for DEAD_LEASE_MS (mirrors jobBlocks in shared/deploy.js).
export const freeSlot = (path, active, now, workerAt) => ({
  $or: [
    { [path]: null },
    { [`${path}.status`]: { $nin: active } },
    // A queued item only counts as expired when the worker has been silent
    // for QUEUED_EXPIRY_MS (shared/deploy.js queuedExpired).
    ...(workerStale(workerAt, now)
      ? [
          {
            [`${path}.status`]: "queued",
            [`${path}.requestedAt`]: {
              $lt: new Date(now - QUEUED_EXPIRY_MS),
            },
          },
        ]
      : []),
    {
      [`${path}.status`]: { $in: active.filter((s) => s !== "queued") },
      [`${path}.lease.until`]: { $lt: new Date(now - DEAD_LEASE_MS) },
    },
  ],
});
// A queued deploy/redeploy/rollback job. `by` = {id, name}.
export const newJob = ({
  kind,
  branch,
  sha,
  buildKey,
  commit,
  by,
  now,
  target,
}) => ({
  kind,
  requestId: randomUUID(),
  branch,
  sha,
  buildKey: buildKey ?? null,
  commit: commit ?? null,
  by,
  requestedAt: new Date(now),
  status: "queued",
  step: "queued",
  steps: stepsFor(kind),
  lease: leaseless(),
  attempt: 0,
  heartbeatAt: null,
  runId: null,
  runUrl: null,
  artifactId: null,
  uploadStartedAt: null,
  vercelDeploymentId: target ?? null,
  url: null,
  baseline: null,
  cancelRequested: false,
  error: null,
  finishedAt: null,
});
// A queued build row `pos-build:<sha>:<buildKey>`; `now` is a Date.
export const newBuildRow = ({
  _id,
  sha,
  buildKey,
  inputs,
  branch,
  commit,
  waiters,
  prepared,
  now,
}) => ({
  _id,
  kind: "build",
  status: "queued",
  sha,
  buildKey,
  inputs,
  branch,
  commit,
  lease: leaseless(),
  attempt: 0,
  runId: null,
  runUrl: null,
  artifactId: null,
  waiters,
  prepared,
  error: null,
  createdAt: now,
  finishedAt: null,
});
// ---- go-live (P5, shared/golive.js) ----------------------------------------------
// Filter part: the installation has no go-live run that still blocks (D41).
export const goliveFree = (now, workerAt) =>
  freeSlot("pos.golive", GOLIVE_ACTIVE, now, workerAt);
// Another installation that holds `label` on the platform apex: its go-live
// address, the same host, or the same label entered by hand on sandbee.in.
// The unique index on pos.golive.address.label backs the first part.
export const labelHolderFilter = (id, label, host) => ({
  _id: { $ne: id },
  $or: [
    { "pos.golive.address.label": label },
    { "pos.host": host },
    { "pos.subdomain": label, "pos.rootDomain": PLATFORM_APEX },
  ],
});
// The address a run starts with: the learned one while the label is the same.
const addressFor = (prior, label, host) =>
  prior?.label === label && prior?.host === host
    ? prior
    : {
        label,
        host,
        records: [],
        cname: null,
        txt: null,
        verified: false,
        configured: null,
        tls: false,
        state: "pending-dns",
        checkedAt: null,
      };
// A queued go-live run. `prior` = the stored pos.golive (or null): its learned
// parts are carried, its run fields are not. `branch`/`sha` default to the
// prior go-live commit (sync-env, check). `rev` = the pos.rev the run writes
// against (after the enqueue's own bump). An earlier run's realtime bundle run
// is never reused (it may have failed, or be another commit's): only a
// takeover of the same run reuses it.
export const newGolive = ({
  action,
  branch,
  sha,
  by,
  now,
  prior = null,
  label,
  host,
  rev = null,
}) => ({
  status: "queued",
  action,
  requestId: randomUUID(),
  by,
  requestedAt: new Date(now),
  startedAt: null,
  endedAt: null,
  branch: branch ?? prior?.branch ?? "",
  sha: sha ?? prior?.sha ?? "",
  step: "queued",
  steps: goliveStepsFor(action, prior?.steps),
  waitingFor: null,
  lease: leaseless(),
  attempt: 0,
  heartbeatAt: null,
  cancelRequested: false,
  error: null,
  warnings: [],
  address: addressFor(prior?.address, label, host),
  env: prior?.env ?? null,
  realtime: prior?.realtime ? { ...prior.realtime, run: null } : null,
  admin: prior?.admin ?? null,
  projectId: prior?.projectId ?? null,
  rev,
  deployRequestId: prior?.deployRequestId ?? null,
  liveAt: prior?.liveAt ?? null,
});

// The fields (relative to the job) that cancel an active job: a queued one at
// once, a running one only before the upload (the worker then stops it).
// null = too late.
export function cancelFields(job, now) {
  if (job.status === "queued")
    return {
      status: "cancelled",
      cancelRequested: true,
      finishedAt: new Date(now),
    };
  if (!CANCELLABLE_STEPS.includes(job.step)) return null;
  return { status: "cancelling", cancelRequested: true };
}

// A rollout (P3) gives up its pre-builds (cancelled, dismissed or replaced): a
// queued row nobody waits for is cancelled at once, a running one loses the
// rollout's marker (the build lane then cancels it unless a deploy waits for
// it). Rows prepared by anyone else are never touched.
export async function releasePrebuilds(
  state,
  rolloutId,
  now,
  { session } = {},
) {
  await state.updateMany(
    {
      kind: "build",
      "prepared.rollout": rolloutId,
      status: "queued",
      waiters: { $size: 0 },
    },
    { $set: { status: "cancelled", prepared: null, finishedAt: now } },
    { session },
  );
  await state.updateMany(
    { kind: "build", "prepared.rollout": rolloutId },
    { $set: { prepared: null } },
    { session },
  );
}
