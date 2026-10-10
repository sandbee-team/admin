// POS usage checks API (docs/PHASE2-PLAN.md rev 2, §8). The API only READS
// the stored result and ENQUEUES checks; the worker (backend/worker) runs them
// and writes `pos.usage.check` progress, `last` and `mail`. One check slot per
// installation (`pos.usage.check`), filled only while no check is queued or
// running. Nothing here reads a secret box or returns provider text.
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { usageSchemas } from "../../shared/schemas.js";
import {
  ACTIVE_CHECK_STATES,
  HOBBY_LIMITS,
  MONGO_LIMIT_BYTES,
  WORKER_FREE_REQUESTS,
} from "../../shared/usage.js";
import { DEAD_LEASE_MS, WORKER_ONLINE_MS } from "../../shared/deploy.js";
import { HttpError, ensure } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import { busyError, notReadyError } from "./pos.js";
import {
  PROGRESS_MS,
  checkView,
  lastView,
  queuedTooLong,
} from "../lib/usage-view.js";

const BUSY = "A check is already queued or running for this client.";
// Nothing is silently queued while nobody would run it (§8): 503, with the
// same `not-ready` code and item as the deploy gates.
const workerOffline = () => {
  const error = notReadyError(["worker"]);
  error.status = 503;
  error.expose = true;
  error.message =
    "The background worker is offline, so no check can run. Try again when it is back online.";
  return error;
};
const noWatched = () => {
  const error = new HttpError(409, "No clients are on the watch list.");
  error.apiCode = "no-watched";
  return error;
};
const ALL_BUSY = "Every watched client already has a check queued or running.";
// The watch list "Check watched clients" works on: POS installations that are
// watched and not retired (a retired client keeps its flag but is skipped; a
// single "Check now" may still check it).
const WATCHED = {
  "pos.usage.watch": true,
  pos: { $exists: true },
  status: { $ne: "retired" },
};
// The slot is free when empty, finished, or running on a lease that has been
// dead for DEAD_LEASE_MS (the worker died mid-check). A queued check is never
// free here: the worker must be online to get this far, and it expires stale
// queued checks itself.
const freeSlot = (now) => ({
  $or: [
    { "pos.usage.check": null },
    { "pos.usage.check.status": { $nin: ACTIVE_CHECK_STATES } },
    {
      "pos.usage.check.status": "running",
      "pos.usage.check.lease.until": { $lt: new Date(now - DEAD_LEASE_MS) },
    },
  ],
});
// The same rule on a loaded row (cheap refusal before the hourly allowance).
const slotBusy = (check, now) =>
  Boolean(check) &&
  ACTIVE_CHECK_STATES.includes(check.status) &&
  !(
    check.status === "running" &&
    check.lease?.until instanceof Date &&
    check.lease.until.getTime() < now - DEAD_LEASE_MS
  );
const newCheck = (staff, now) => ({
  id: randomUUID(),
  status: "queued",
  batchId: null,
  requestedAt: new Date(now),
  by: { id: staff._id, name: staff.name },
  lease: { owner: null, until: null, fence: 0 },
  attempt: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
});
// Explicit non-secret fields only: the stored secret boxes are never read.
const PROJECTION = {
  productId: 1,
  "pos.slug": 1,
  "pos.host": 1,
  "pos.usage.watch": 1,
  "pos.usage.check": 1,
  "pos.usage.last": 1,
};

export function usageRoutes({ db, client, auth, cache }) {
  const router = Router(),
    installations = db.collection("installations"),
    state = db.collection("system_state");
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  // Loads the installation and requires the POS product and its settings.
  async function load(id, session) {
    const row = await installations.findOne(
      { _id: id },
      { session, projection: PROJECTION },
    );
    ensure(row, 404, "Installation not found.");
    const product = await db
      .collection("products")
      .findOne({ _id: row.productId }, { session, projection: { slug: 1 } });
    ensure(
      product?.slug === "pos",
      400,
      "POS settings are only available for POS installations.",
    );
    ensure(row.pos, 404, "POS settings have not been set up.");
    return row;
  }
  async function workerOnline() {
    const worker = await state.findOne(
      { _id: "pos-worker" },
      { projection: { at: 1 } },
    );
    const beat = new Date(worker?.at ?? NaN).getTime();
    return Date.now() - beat < WORKER_ONLINE_MS;
  }
  // The overview counts watched clients: keep it from serving a stale summary.
  const changed = () => cache?.clear?.();

  router.get(
    "/installations/:id/pos/usage",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      const [row, online] = await Promise.all([load(id), workerOnline()]);
      const usage = row.pos.usage;
      // Stalled = nobody will run this check: the worker is offline, or it has
      // been queued for over 10 minutes (server clock) while no check is
      // running anywhere. A running one means a batch is still working
      // through the queue, one at a time (served by the check-status index).
      const stalled =
        !online ||
        (queuedTooLong(usage?.check) &&
          !(await installations.findOne(
            {
              $or: [
                { "pos.usage.check.status": "running" },
                // finished a moment ago: the next one is claimed on the next poll
                {
                  "pos.usage.check.status": {
                    $in: ["done", "failed", "expired"],
                  },
                  "pos.usage.check.finishedAt": {
                    $gt: new Date(Date.now() - PROGRESS_MS),
                  },
                },
              ],
            },
            { projection: { _id: 1 } },
          )));
      res.json({
        watch: usage?.watch === true,
        hasHost: typeof row.pos.host === "string" && row.pos.host.length > 0,
        check: checkView(usage?.check),
        last: lastView(usage?.last),
        hobby: HOBBY_LIMITS,
        limits: {
          mongoBytes: MONGO_LIMIT_BYTES,
          workerRequests: WORKER_FREE_REQUESTS,
        },
        workerOnline: online,
        stalled,
      });
    },
  );

  router.put(
    "/installations/:id/pos/usage/watch",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      const { watch } = usageSchemas.watch.parse(req.body);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const row = await load(id, session);
        // pos.rev is not touched: the POS setup form never goes stale.
        const done = await installations.updateOne(
          { _id: id, pos: { $exists: true } },
          { $set: { "pos.usage.watch": watch } },
          { session },
        );
        ensure(
          done.matchedCount === 1,
          404,
          "POS settings have not been set up.",
        );
        // Only a real change is an event worth a row.
        if (done.modifiedCount === 1)
          await audit(
            db,
            session,
            req.staff,
            watch ? "pos.usage.watched" : "pos.usage.unwatched",
            "installations",
            id,
            row.pos.slug,
            req,
          );
      });
      changed();
      res.json({ watch });
    },
  );

  router.post(
    "/installations/:id/pos/usage/check",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      usageSchemas.check.parse(req.body ?? {});
      // Cheap refusals first: they must not use up the hourly allowance.
      const [pre, online] = await Promise.all([load(id), workerOnline()]);
      if (!online) throw workerOffline();
      if (slotBusy(pre.pos.usage?.check, Date.now())) throw busyError(BUSY);
      await consume(db, `usage-check:${id}`, 10, 3600000);
      const check = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        // Re-read under the transaction: a POS block removed since the
        // pre-check answers 404 here, not a misleading 409 busy.
        await load(id, session);
        const now = Date.now();
        const next = newCheck(req.staff, now);
        const done = await installations.updateOne(
          { _id: id, pos: { $exists: true }, ...freeSlot(now) },
          { $set: { "pos.usage.check": next } },
          { session },
        );
        if (done.matchedCount !== 1) throw busyError(BUSY);
        await audit(
          db,
          session,
          req.staff,
          "pos.usage.check-requested",
          "installations",
          id,
          pre.pos.slug,
          req,
        );
        return next;
      });
      changed();
      res.status(202).json({ check: checkView(check) });
    },
  );

  router.post(
    "/pos/usage/check",
    auth.permit("credentials"),
    async (req, res) => {
      usageSchemas.batch.parse(req.body ?? {});
      // Cheap refusals first, in this order: they must not use up the hourly
      // allowance (worker offline, empty watch list, every slot taken).
      if (!(await workerOnline())) throw workerOffline();
      if (!(await installations.countDocuments(WATCHED))) throw noWatched();
      const idle = await installations.countDocuments({
        ...WATCHED,
        ...freeSlot(Date.now()),
      });
      if (!idle) throw busyError(ALL_BUSY);
      await consume(db, `usage-batch:${req.staff._id}`, 6, 3600000);
      const result = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        // The authoritative count and update, under the transaction.
        const watched = await installations.countDocuments(WATCHED, {
          session,
        });
        if (!watched) throw noWatched();
        const now = Date.now(),
          batchId = randomUUID();
        const done = await installations.updateMany(
          { ...WATCHED, ...freeSlot(now) },
          {
            $set: {
              "pos.usage.check": {
                ...newCheck(req.staff, now),
                id: batchId,
                batchId,
              },
            },
          },
          { session },
        );
        const queued = done.modifiedCount,
          skipped = watched - queued;
        // Lost every slot to a concurrent request since the pre-check: abort
        // (no audit row) with the same answer the pre-check would give now.
        if (!queued) throw busyError(ALL_BUSY);
        await audit(
          db,
          session,
          req.staff,
          "pos.usage.batch-requested",
          "system",
          "pos-usage",
          `${queued} queued, ${skipped} skipped`,
          req,
        );
        return { batchId, queued, skipped };
      });
      changed();
      res.status(202).json(result);
    },
  );
  return router;
}
