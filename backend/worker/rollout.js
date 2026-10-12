// The rollout driver (P3, docs/P3-ROLLOUT.md §5): "deploy this commit to all
// clients". On every loop pass it advances the one `pos-rollout` row a little:
// pre-build every client's build, then enqueue ONE normal deploy job at a time
// and read its outcome, stopping at the first failure. It never waits and
// never calls a provider itself; the deploy and build lanes do the work.
// Every write is fenced on the row's lease AND on the status it read, so a
// cancel from the API or a takeover by another worker makes a write miss
// instead of landing (the next pass reads again).
import { audit } from "../lib/audit.js";
import { transaction } from "../db.js";
import { buildInputs, buildKeyOf, inputsOkOf } from "../lib/build-inputs.js";
import {
  freeSlot,
  newBuildRow,
  newJob,
  releasePrebuilds,
} from "../lib/deploy-job.js";
import {
  ACTIVE_STATES,
  buildRowId,
  jobBlocks,
  sha7,
} from "../../shared/deploy.js";
import { can } from "../../shared/policy.js";
import {
  ROLLOUT_ACTIVE,
  ROLLOUT_ROW_ID,
  TARGET_PROJECTION,
  classifyTarget,
  rolloutCounts,
  targetFacts,
  targetOutcome,
} from "../../shared/rollout.js";
import { WORKER_ACTOR } from "./verify.js";

const IN_FLIGHT = ["building", "deploying"];
const INPUT_FIELDS = {
  "pos.image.store": 1,
  "pos.image.publicBaseUrl": 1,
  "pos.image.cloudName": 1,
  "pos.cloudflare.workerUrl": 1,
};
// A write that must not land (slot taken, row changed): retried next pass.
class Missed extends Error {}

const fenced = (row) => ({
  _id: ROLLOUT_ROW_ID,
  id: row.id,
  status: row.status,
  "lease.owner": row.lease.owner,
  "lease.fence": row.lease.fence,
});
async function write(ctx, row, set, { session, when = {} } = {}) {
  const done = await ctx.coll.state.updateOne(
    { ...fenced(row), ...when },
    { $set: set },
    { session },
  );
  return done.matchedCount === 1;
}
const targetSet = (i, fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      `targets.${i}.${key}`,
      value,
    ]),
  );
const setTarget = (ctx, row, i, fields) =>
  write(ctx, row, targetSet(i, fields), {
    when: { [`targets.${i}.requestId`]: row.targets[i].requestId },
  });
const isFrozen = async (ctx) =>
  (
    await ctx.coll.state.findOne(
      { _id: "pos-deploy-freeze" },
      { projection: { on: 1 } },
    )
  )?.on === true;

// The lease: taken when free or expired, renewed by its owner every pass.
function claim(ctx) {
  const now = ctx.now();
  return ctx.coll.state.findOneAndUpdate(
    {
      _id: ROLLOUT_ROW_ID,
      status: { $in: ROLLOUT_ACTIVE },
      $or: [
        { "lease.owner": ctx.workerId },
        { "lease.until": null },
        { "lease.until": { $lt: new Date(now) } },
      ],
    },
    {
      $set: {
        "lease.owner": ctx.workerId,
        "lease.until": new Date(now + ctx.t.leaseMs),
      },
      $inc: { "lease.fence": 1 },
    },
    { returnDocument: "after" },
  );
}

// One pass. -> 1 when the row changed (keeps loop.drain() going), else 0.
export async function rolloutStep(ctx) {
  // A killed worker renews no lease (the rule of lease.js renew/heartbeat).
  if (ctx.killed) return 0;
  const peek = await ctx.coll.state.findOne(
    { _id: ROLLOUT_ROW_ID },
    { projection: { status: 1 } },
  );
  if (!ROLLOUT_ACTIVE.includes(peek?.status)) return 0;
  let row = await claim(ctx);
  if (!row) return 0;
  let changed = 0;
  // Several actions per pass (settle a client, start the next, skip a few),
  // bounded by the number of clients.
  for (let n = 0; n <= row.targets.length + 2; n++) {
    if (!(await act(ctx, row))) break;
    changed = 1;
    row = await ctx.coll.state.findOne({
      _id: ROLLOUT_ROW_ID,
      id: row.id,
      "lease.owner": ctx.workerId,
      "lease.fence": row.lease.fence,
    });
    if (!ROLLOUT_ACTIVE.includes(row?.status)) break;
  }
  return changed;
}

// The next action for the row as read. -> true when something was written.
async function act(ctx, row) {
  const flight = row.targets.findIndex((t) => IN_FLIGHT.includes(t.status));
  if (flight >= 0) return observe(ctx, row, flight);
  if (row.status === "cancelling") return finish(ctx, row, "cancelled");
  const next = row.targets.findIndex((t) => t.status === "pending");
  if (next < 0) return finish(ctx, row, "completed");
  if (await isFrozen(ctx))
    return stopAt(ctx, row, next, { status: "skipped", code: "frozen" });
  if (!row.prepared) return prebuild(ctx, row);
  return advance(ctx, row, next);
}

// ---- the client in flight ------------------------------------------------------
async function observe(ctx, row, i) {
  const t = row.targets[i];
  const inst = await ctx.coll.installations.findOne(
    { _id: t.installationId },
    {
      projection: {
        "pos.deploy.current": 1,
        "pos.deploy.last.requestId": 1,
        "pos.deploy.last.healthy": 1,
      },
    },
  );
  const deploy = inst?.pos?.deploy;
  const out = targetOutcome(deploy, t.requestId);
  if (IN_FLIGHT.includes(out.status)) {
    // Frozen while still queued: the deploy lane never claims it, so the
    // driver cancels its own job (a running one stops itself before upload).
    if (deploy.current.status === "queued" && (await isFrozen(ctx)))
      return cancelQueued(ctx, t, deploy.current);
    return out.status !== t.status
      ? setTarget(ctx, row, i, { status: out.status })
      : false;
  }
  const finishedAt = new Date(ctx.now());
  if (out.status === "succeeded")
    return setTarget(ctx, row, i, {
      status: "succeeded",
      error: null,
      finishedAt,
    });
  // A client locked or paused while its job waited is skipped and the rollout
  // goes on; a cancelled rollout records the client and the next action ends
  // it. Anything else stops the rollout here.
  if (!out.stop || row.status === "cancelling")
    return setTarget(ctx, row, i, {
      status: out.status,
      error: { code: out.code },
      finishedAt,
    });
  return stopAt(ctx, row, i, { status: out.status, code: out.code });
}
async function cancelQueued(ctx, t, job) {
  return transaction(ctx.client, async (session) => {
    const done = await ctx.coll.installations.updateOne(
      {
        _id: t.installationId,
        "pos.deploy.current.requestId": job.requestId,
        "pos.deploy.current.status": "queued",
      },
      {
        $set: {
          "pos.deploy.current.status": "cancelled",
          "pos.deploy.current.cancelRequested": true,
          "pos.deploy.current.finishedAt": new Date(ctx.now()),
          "pos.deploy.current.error": {
            step: "queued",
            code: "frozen",
            message: "Deploys are frozen.",
          },
        },
      },
      { session },
    );
    if (done.matchedCount !== 1) return false;
    await audit(
      ctx.db,
      session,
      WORKER_ACTOR,
      "pos.deploy.cancelled",
      "installations",
      t.installationId,
      `${String(job.branch).slice(0, 80)}@${sha7(job.sha)} #${job.requestId.slice(0, 8)} frozen`,
    );
    return true;
  });
}

// ---- ending ------------------------------------------------------------------------
// One write: the final status, the client it stopped at (if any) and every
// client not reached marked skipped; then the audit row.
async function finish(ctx, row, status, at = null, stop = null) {
  const now = new Date(ctx.now());
  const unreached = {
    code: status === "cancelled" ? "cancelled" : "rollout-stopped",
  };
  const targets = row.targets.map((t, j) =>
    at && j === at.i
      ? { ...t, ...at.fields }
      : t.status === "pending"
        ? { ...t, status: "skipped", error: unreached, finishedAt: now }
        : t,
  );
  const counts = rolloutCounts(targets);
  const ended = await transaction(ctx.client, async (session) => {
    if (
      !(await write(
        ctx,
        row,
        { status, targets, stop, finishedAt: now },
        { session },
      ))
    )
      return false;
    await audit(
      ctx.db,
      session,
      WORKER_ACTOR,
      "pos.rollout.finished",
      "system",
      ROLLOUT_ROW_ID,
      `${status}: ${counts.succeeded} ok, ${counts.failed} failed, ${counts.skipped} skipped #${row.id.slice(0, 8)}`,
    );
    return true;
  });
  if (ended) {
    ctx.log("rollout-finished", { status, id: row.id.slice(0, 8) });
    if (status === "cancelled")
      await releasePrebuilds(ctx.coll.state, row.id, now).catch(() =>
        ctx.log("rollout-release-failed", { id: row.id.slice(0, 8) }),
      );
  }
  return ended;
}
function stopAt(ctx, row, i, { status, code, items }) {
  return finish(
    ctx,
    row,
    "stopped",
    {
      i,
      fields: {
        status,
        error: items ? { code, items } : { code },
        finishedAt: new Date(ctx.now()),
      },
    },
    { slug: row.targets[i].slug, code },
  );
}
// ---- pre-builds ----------------------------------------------------------------------
// Once per start/resume: every waiting client's build key gets a build row
// marked prepared for this rollout (one per distinct key, in rollout order so
// the canary builds first). Mongo only: no S3 call in the loop pass; the
// build lane checks the cache first and adopts a cached build at once.
async function prebuild(ctx, row) {
  const info = await ctx.heartbeat.builderInfo().catch(() => null);
  const set = { prepared: true };
  const seen = new Map();
  for (const [i, t] of row.targets.entries()) {
    if (t.status !== "pending") continue;
    let key = null,
      state = "unavailable";
    try {
      const inst = await ctx.coll.installations.findOne(
        { _id: t.installationId },
        { projection: INPUT_FIELDS },
      );
      if (ctx.cache && info?.ok && info.descriptor && inst?.pos) {
        const inputs = buildInputs({
          pos: inst.pos,
          builderSha: info.sha,
          builder: info.descriptor,
        });
        key = buildKeyOf(ctx.c.VAULT_KEY, inputs);
        if (seen.has(key))
          state = seen.get(key) === "queued" ? "joined" : seen.get(key);
        else {
          state = await prepareRow(ctx, row, key, inputs);
          seen.set(key, state);
        }
      }
    } catch {
      key = null;
      state = "unavailable";
    }
    Object.assign(set, targetSet(i, { buildKey: key, prebuild: state }));
  }
  return write(ctx, row, set);
}
// Insert, reset (failed/cancelled) or join the build row, like the deploy
// job's single flight; an existing marker is never replaced.
async function prepareRow(ctx, row, key, inputs) {
  const { state } = ctx.coll;
  const _id = buildRowId(row.sha, key);
  const now = new Date(ctx.now());
  const prepared = {
    by: { id: row.auth?.id ?? "", name: row.auth?.name ?? "" },
    at: now,
    rollout: row.id,
  };
  const fresh = () =>
    newBuildRow({
      _id,
      sha: row.sha,
      buildKey: key,
      inputs,
      branch: row.branch,
      commit: row.commit ?? {
        sha: row.sha,
        branch: row.branch,
        headline: "",
        authorName: "",
        date: null,
      },
      waiters: [],
      prepared,
      now,
    });
  for (let n = 0; n < 3; n++) {
    try {
      await state.insertOne(fresh());
      return "queued";
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    const existing = await state.findOne({ _id });
    if (!existing) continue;
    if (["failed", "cancelled"].includes(existing.status)) {
      const reset = await state.replaceOne(
        { _id, status: existing.status },
        fresh(),
      );
      if (reset.matchedCount === 1) return "queued";
      continue;
    }
    await state.updateOne({ _id, prepared: null }, { $set: { prepared } });
    return "joined";
  }
  return "unavailable";
}

// ---- the next client's turn -------------------------------------------------------
async function advance(ctx, row, i) {
  const t = row.targets[i];
  const now = ctx.now();
  const auth = row.auth ?? {};
  // The person whose authority the rollout runs under must still be able to
  // deploy (same conditions as authorizeWrite: active, same role and
  // authVersion; a password reset or "sign out everywhere" stops it).
  const staff = await ctx.db.collection("staff").findOne(
    {
      _id: auth.id,
      status: "active",
      authVersion: auth.authVersion,
      role: auth.role,
    },
    { projection: { role: 1 } },
  );
  if (!staff || !can(staff.role, "deploy"))
    return stopAt(ctx, row, i, { status: "skipped", code: "not-authorized" });
  const inst = await ctx.coll.installations.findOne(
    { _id: t.installationId },
    { projection: TARGET_PROJECTION },
  );
  const customer = inst
    ? await ctx.db
        .collection("customers")
        .findOne({ _id: inst.customerId }, { projection: { status: 1 } })
    : null;
  const facts = targetFacts(inst, customer, inputsOkOf(inst?.pos), now);
  const verdict = classifyTarget(facts, row.sha);
  if (verdict.kind === "skip")
    return setTarget(ctx, row, i, {
      status: "skipped",
      error: { code: verdict.code },
      finishedAt: new Date(now),
    });
  if (verdict.kind === "blocked")
    return stopAt(ctx, row, i, {
      status: "failed",
      code: verdict.code,
      items: verdict.items,
    });
  const workerAt =
    (
      await ctx.coll.state.findOne(
        { _id: "pos-worker" },
        { projection: { at: 1 } },
      )
    )?.at ?? null;
  if (jobBlocks(facts.pos.deploy?.current, now, workerAt))
    return stopAt(ctx, row, i, { status: "failed", code: "target-busy" });
  const job = newJob({
    kind: "deploy",
    branch: row.branch,
    sha: row.sha,
    buildKey: t.buildKey,
    commit: row.commit,
    by: { id: auth.id, name: auth.name },
    now,
  });
  // The client's deploy slot and this target, in one transaction, which also
  // writes the staff record like authorizeWrite: a concurrent revoke then
  // conflicts instead of letting one more job through.
  try {
    return await transaction(ctx.client, async (session) => {
      const still = await ctx.db.collection("staff").findOneAndUpdate(
        {
          _id: auth.id,
          status: "active",
          authVersion: auth.authVersion,
          role: auth.role,
        },
        { $inc: { operationSequence: 1 } },
        { session, returnDocument: "after", projection: { role: 1 } },
      );
      if (!still || !can(still.role, "deploy")) throw new Missed();
      const claimed = await ctx.coll.installations.updateOne(
        {
          _id: t.installationId,
          "pos.rev": facts.pos.rev,
          "pos.deployLock": false,
          ...freeSlot("pos.deploy.current", ACTIVE_STATES, now, workerAt),
        },
        { $set: { "pos.deploy.current": job } },
        { session },
      );
      if (claimed.matchedCount !== 1) throw new Missed();
      const marked = await write(
        ctx,
        row,
        targetSet(i, {
          status: "building",
          requestId: job.requestId,
          error: null,
          startedAt: new Date(now),
        }),
        { session, when: { [`targets.${i}.status`]: "pending" } },
      );
      if (!marked) throw new Missed();
      await audit(
        ctx.db,
        session,
        WORKER_ACTOR,
        "pos.deploy.requested",
        "installations",
        t.installationId,
        `${row.branch.slice(0, 80)}@${sha7(row.sha)} #${job.requestId.slice(0, 8)} rollout #${row.id.slice(0, 8)}`,
      );
      return true;
    });
  } catch (error) {
    if (error instanceof Missed) return false;
    throw error;
  }
}
