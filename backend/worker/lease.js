// Leases and fences (JOB CONTRACT, shared/deploy.js). A job, a task or a build
// row is claimed by an atomic conditional update that increments `lease.fence`;
// from then on every write the worker makes carries the filter
// {id, lease.owner, lease.fence}, so a worker whose lease was taken over can
// never land a write ("zombie writes"). Nothing here touches a secret.
import {
  ACTIVE_STATES,
  ACTIVE_TASK_STATES,
  MAX_ATTEMPTS,
  QUEUED_EXPIRY_MS,
} from "../../shared/deploy.js";

export class LeaseLost extends Error {
  constructor() {
    super("Lease lost.");
    this.name = "LeaseLost";
    this.code = "lease-lost";
  }
}
// The worker is shutting down: leave the job as it is for the next worker.
export class Released extends Error {
  constructor() {
    super("Released.");
    this.name = "Released";
    this.code = "released";
  }
}
export const sleepReal = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
const at = (path, field) => (path ? `${path}.${field}` : field);
const prefixed = (path, fields) =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [at(path, k), v]));
const walk = (doc, path) =>
  path ? path.split(".").reduce((v, part) => v?.[part], doc) : doc;
// A handle on one claimed record. `path` is where the record lives inside its
// document ("" for a whole document such as a build row).
export function createSlot(
  ctx,
  { coll, match, path = "", idField, idValue, owner, fence },
) {
  const filterOf = (when = {}) => ({
    ...match,
    [at(path, idField)]: idValue,
    [at(path, "lease.owner")]: owner,
    [at(path, "lease.fence")]: fence,
    ...prefixed(path, when),
  });
  const slot = {
    coll,
    match,
    path,
    idValue,
    owner,
    fence,
    filterOf,
    prefixed: (fields) => prefixed(path, fields),
    // One fenced $set; false when the fence no longer matches.
    async set(fields, { session, when } = {}) {
      const done = await coll.updateOne(
        filterOf(when),
        { $set: prefixed(path, fields) },
        { session },
      );
      return done.matchedCount === 1;
    },
    async mustSet(fields, options) {
      if (!(await slot.set(fields, options))) throw new LeaseLost();
    },
    // Fenced arbitrary update operators; paths inside $set/$unset are relative.
    async apply(operators, { session, when } = {}) {
      const mapped = {};
      for (const [op, fields] of Object.entries(operators))
        mapped[op] = prefixed(path, fields);
      const done = await coll.updateOne(filterOf(when), mapped, { session });
      return done.matchedCount === 1;
    },
    async read() {
      const doc = await coll.findOne(match);
      return walk(doc, path) ?? null;
    },
    // True when the stored record is still ours.
    mine(record) {
      return (
        Boolean(record) &&
        record[idField] === idValue &&
        record.lease?.owner === owner &&
        record.lease?.fence === fence
      );
    },
    renew() {
      const now = ctx.now();
      return slot.set({
        "lease.until": new Date(now + ctx.t.leaseMs),
        heartbeatAt: new Date(now),
      });
    },
    // Lets the next worker claim immediately (graceful stop).
    async release() {
      await slot
        .set({ "lease.until": new Date(ctx.now() - 1) })
        .catch(() => undefined);
    },
  };
  return slot;
}
// Renews the lease on an interval. A failed renewal (fence mismatch) or a
// lease that could not be proven for a whole lease period aborts `controller`
// so every provider call and the CLI stop.
export function startHeartbeat(ctx, slot, controller) {
  let lastOk = ctx.now();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || ctx.killed) return;
    busy = true;
    try {
      if (await slot.renew()) lastOk = ctx.now();
      else controller.abort(new LeaseLost());
    } catch {
      if (ctx.now() - lastOk > ctx.t.leaseMs) controller.abort(new LeaseLost());
    } finally {
      busy = false;
    }
  }, ctx.t.heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
// Throws the abort reason (LeaseLost / Released) when the job must stop.
export function ensureLive(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new LeaseLost();
}
const claimed = (ctx, spec, doc, takeover) => ({
  slot: createSlot(ctx, spec),
  doc,
  takeover,
});

// ---- deploy jobs: installations.pos.deploy.current --------------------------
// -> {slot, doc (the claimed job), installationId, takeover} | null.
export async function claimDeploy(ctx, { frozen = false } = {}) {
  const { installations } = ctx.coll;
  const now = new Date(ctx.now());
  const rows = await installations
    .find(
      { "pos.deploy.current.status": { $in: ACTIVE_STATES } },
      { projection: { "pos.deploy.current": 1 } },
    )
    .sort({ "pos.deploy.current.requestedAt": 1 })
    .limit(50)
    .toArray();
  for (const row of rows) {
    const job = row.pos?.deploy?.current;
    if (!job?.requestId) continue;
    const base = {
      _id: row._id,
      "pos.deploy.current.requestId": job.requestId,
    };
    if (
      job.status === "queued" &&
      now.getTime() - new Date(job.requestedAt).getTime() > QUEUED_EXPIRY_MS
    ) {
      await installations.updateOne(
        { ...base, "pos.deploy.current.status": "queued" },
        {
          $set: {
            "pos.deploy.current.status": "expired",
            "pos.deploy.current.finishedAt": now,
            "pos.deploy.current.error": {
              step: "queued",
              code: "expired",
              message: "The worker did not pick this deploy up in time.",
            },
          },
        },
      );
      continue;
    }
    if (job.status === "queued" && frozen && job.kind !== "rollback") continue;
    let result = null;
    if (job.status === "queued") {
      result = await installations.findOneAndUpdate(
        { ...base, "pos.deploy.current.status": "queued" },
        {
          $set: {
            "pos.deploy.current.status": "running",
            "pos.deploy.current.lease.owner": ctx.workerId,
            "pos.deploy.current.lease.until": new Date(
              ctx.now() + ctx.t.leaseMs,
            ),
            "pos.deploy.current.heartbeatAt": now,
          },
          $inc: {
            "pos.deploy.current.lease.fence": 1,
            "pos.deploy.current.attempt": 1,
          },
        },
        { returnDocument: "after", projection: { "pos.deploy.current": 1 } },
      );
    } else {
      result = await installations.findOneAndUpdate(
        {
          ...base,
          "pos.deploy.current.status": { $in: ["running", "cancelling"] },
          "pos.deploy.current.lease.until": { $lt: now },
        },
        {
          $set: {
            "pos.deploy.current.lease.owner": ctx.workerId,
            "pos.deploy.current.lease.until": new Date(
              ctx.now() + ctx.t.leaseMs,
            ),
            "pos.deploy.current.heartbeatAt": now,
          },
          $inc: {
            "pos.deploy.current.lease.fence": 1,
            "pos.deploy.current.attempt": 1,
          },
        },
        { returnDocument: "after", projection: { "pos.deploy.current": 1 } },
      );
    }
    const claimedJob = result?.pos?.deploy?.current;
    if (!claimedJob) continue;
    return {
      ...claimed(
        ctx,
        {
          coll: installations,
          match: { _id: row._id },
          path: "pos.deploy.current",
          idField: "requestId",
          idValue: job.requestId,
          owner: ctx.workerId,
          fence: claimedJob.lease.fence,
        },
        claimedJob,
        job.status !== "queued",
      ),
      installationId: row._id,
      tooManyAttempts: claimedJob.attempt > MAX_ATTEMPTS,
    };
  }
  return null;
}

// ---- tasks: installations.pos.task -------------------------------------------
export async function claimTask(ctx) {
  const { installations } = ctx.coll;
  const now = new Date(ctx.now());
  const rows = await installations
    .find(
      { "pos.task.status": { $in: ACTIVE_TASK_STATES } },
      { projection: { "pos.task": 1 } },
    )
    .sort({ "pos.task.requestedAt": 1 })
    .limit(50)
    .toArray();
  for (const row of rows) {
    const task = row.pos?.task;
    if (!task?.id) continue;
    const base = { _id: row._id, "pos.task.id": task.id };
    if (
      task.status === "queued" &&
      now.getTime() - new Date(task.requestedAt).getTime() > QUEUED_EXPIRY_MS
    ) {
      await installations.updateOne(
        { ...base, "pos.task.status": "queued" },
        {
          $set: {
            "pos.task.status": "expired",
            "pos.task.finishedAt": now,
            "pos.task.error": {
              code: "expired",
              message: "The worker did not pick this task up in time.",
            },
          },
        },
      );
      continue;
    }
    const filter =
      task.status === "queued"
        ? { ...base, "pos.task.status": "queued" }
        : {
            ...base,
            "pos.task.status": "running",
            "pos.task.lease.until": { $lt: now },
          };
    const update = {
      $set: {
        ...(task.status === "queued" ? { "pos.task.status": "running" } : {}),
        "pos.task.lease.owner": ctx.workerId,
        "pos.task.lease.until": new Date(ctx.now() + ctx.t.leaseMs),
      },
      $inc: { "pos.task.lease.fence": 1, "pos.task.attempt": 1 },
    };
    const result = await installations.findOneAndUpdate(filter, update, {
      returnDocument: "after",
      projection: { "pos.task": 1 },
    });
    const got = result?.pos?.task;
    if (!got) continue;
    return {
      ...claimed(
        ctx,
        {
          coll: installations,
          match: { _id: row._id },
          path: "pos.task",
          idField: "id",
          idValue: task.id,
          owner: ctx.workerId,
          fence: got.lease.fence,
        },
        got,
        task.status !== "queued",
      ),
      installationId: row._id,
      tooManyAttempts: got.attempt > MAX_ATTEMPTS,
    };
  }
  return null;
}

// ---- build rows: system_state {kind:"build"} ----------------------------------
export const BUILD_ACTIVE = [
  "dispatching",
  "building",
  "collecting",
  "storing",
];
export async function claimBuild(ctx) {
  const { state } = ctx.coll;
  const now = new Date(ctx.now());
  const filters = [
    { kind: "build", status: "queued" },
    {
      kind: "build",
      status: { $in: BUILD_ACTIVE },
      "lease.until": { $lt: now },
    },
  ];
  for (const filter of filters) {
    const queued = filter.status === "queued";
    const result = await state.findOneAndUpdate(
      filter,
      {
        $set: {
          ...(queued ? { status: "dispatching" } : {}),
          "lease.owner": ctx.workerId,
          "lease.until": new Date(ctx.now() + ctx.t.leaseMs),
        },
        $inc: { "lease.fence": 1, attempt: 1 },
      },
      { returnDocument: "after", sort: { createdAt: 1 } },
    );
    if (!result?._id) continue;
    return {
      ...claimed(
        ctx,
        {
          coll: state,
          match: { _id: result._id },
          path: "",
          idField: "_id",
          idValue: result._id,
          owner: ctx.workerId,
          fence: result.lease.fence,
        },
        result,
        !queued,
      ),
      tooManyAttempts: result.attempt > MAX_ATTEMPTS,
    };
  }
  return null;
}

// A deliberate failure with a stored, redacted-by-construction message: the
// message is always a fixed string chosen by the worker, never provider text.
export class JobFail extends Error {
  constructor(code, message, { step = null, status = "failed" } = {}) {
    super(message);
    this.name = "JobFail";
    this.code = code;
    this.step = step;
    this.status = status;
  }
}
export const failMessage = (message) => String(message).slice(0, 160);

// Waits `ms`, then stops the job if its lease is gone or the worker is
// shutting down (a waiting job is released for the next worker).
const renewers = new WeakMap();
export async function wait(ctx, ms, signal) {
  await ctx.sleep(ms, signal);
  ensureLive(signal);
  // Every wait also proves the lease (belt and braces next to the interval).
  const renew = renewers.get(signal);
  if (renew && !ctx.killed && !(await renew())) throw new LeaseLost();
  if (ctx.stopState?.requested) throw new Released();
}
// Runs `run(signal)` under a heartbeat. LeaseLost ends quietly (another worker
// owns the record now); Released gives the lease back; anything else goes to
// `fail(error)`, which writes the terminal state (also fenced).
export async function withLease(ctx, claim, run, fail) {
  const controller = new AbortController();
  const stop = startHeartbeat(ctx, claim.slot, controller);
  renewers.set(controller.signal, () => claim.slot.renew());
  try {
    await run(controller.signal);
  } catch (error) {
    const lost =
      error instanceof LeaseLost ||
      (controller.signal.aborted &&
        controller.signal.reason instanceof LeaseLost);
    if (lost) {
      ctx.log("lease-lost", {});
      return;
    }
    if (error instanceof Released || ctx.stopState?.requested) {
      await claim.slot.release();
      return;
    }
    try {
      await fail(error, controller.signal);
    } catch (second) {
      if (!(second instanceof LeaseLost))
        ctx.log("write-failed", {
          code: String(second?.code ?? "error").slice(0, 40),
        });
    }
  } finally {
    stop();
  }
}
