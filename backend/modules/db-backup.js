// Client database backup API (owner button, D6 + D28). The API only ENQUEUES
// and READS; the worker (backend/worker/db-backup.js) does the work. One
// `pos.task` slot per installation, so only one backup (or other task) runs at
// a time. Nothing here returns a URI, a document or a key.
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_TASK_STATES,
  DEAD_LEASE_MS,
  QUEUED_EXPIRY_MS,
  WORKER_ONLINE_MS,
  taskBlocks,
  workerStale,
} from "../../shared/deploy.js";
import { HttpError, ensure } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import { busyError, notReadyError } from "./pos.js";

const clean = (value, max) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, max);
const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const date = (value) => {
  const d = new Date(value ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d;
};
// Counts only: never a collection name, a document or a value.
export const backupView = (task) =>
  task?.kind === "db-backup"
    ? {
        id: clean(task.id, 64),
        status: clean(task.status, 20),
        step: clean(task.step, 20),
        by: { id: clean(task.by?.id, 64), name: clean(task.by?.name, 120) },
        requestedAt: date(task.requestedAt),
        finishedAt: date(task.finishedAt),
        progress: task.progress
          ? {
              collections: int(task.progress.collections),
              documents: int(task.progress.documents),
              bytes: int(task.progress.bytes),
            }
          : null,
        result: task.result
          ? {
              collections: int(task.result.collections),
              documents: int(task.result.documents),
              bytes: int(task.result.bytes),
            }
          : null,
        error: task.error
          ? {
              code: /^[a-z0-9-]{1,40}$/.test(task.error.code ?? "")
                ? task.error.code
                : "failed",
              message: clean(task.error.message, 160),
            }
          : null,
      }
    : null;
export function dbBackupRoutes({ db, client, auth, s3 }) {
  const router = Router(),
    installations = db.collection("installations");
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  async function load(id, session) {
    const row = await installations.findOne(
      { _id: id },
      { session, projection: { productId: 1, status: 1, pos: 1 } },
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
  router.get(
    "/installations/:id/pos/db-backup",
    auth.permit("credentials"),
    async (req, res) => {
      const row = await load(iid(req));
      res.json({ configured: Boolean(s3), task: backupView(row.pos.task) });
    },
  );
  router.post(
    "/installations/:id/pos/db-backup",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      if (!s3) {
        const error = new HttpError(
          503,
          "File storage is not configured.",
          true,
        );
        error.apiCode = "not-configured";
        throw error;
      }
      // Cheap refusals first: they must not use up the hourly allowance.
      const [pre, worker] = await Promise.all([
        load(id),
        db.collection("system_state").findOne({ _id: "pos-worker" }),
      ]);
      ensure(pre.pos.mongo?.uri, 409, "No client database URI is stored.");
      if (taskBlocks(pre.pos.task, Date.now(), worker?.at ?? null))
        throw busyError(
          "Another task is already running for this installation.",
        );
      const beat = new Date(worker?.at ?? NaN).getTime();
      if (!(Date.now() - beat < WORKER_ONLINE_MS))
        throw notReadyError(["worker"]);
      await consume(db, `db-backup:${id}`, 6, 3600000);
      const task = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await load(id, session);
        ensure(row.pos.mongo?.uri, 409, "No client database URI is stored.");
        const now = Date.now();
        const next = {
          id: randomUUID(),
          kind: "db-backup",
          status: "queued",
          step: "queued",
          progress: null,
          lease: { owner: null, until: null, fence: 0 },
          attempt: 0,
          by: { id: req.staff._id, name: req.staff.name },
          requestedAt: new Date(now),
          finishedAt: null,
          params: null,
          result: null,
          error: null,
        };
        // Free when empty, finished, expired while queued, or its lease has been dead a while.
        const done = await installations.updateOne(
          {
            _id: id,
            $or: [
              { "pos.task": null },
              { "pos.task.status": { $nin: ACTIVE_TASK_STATES } },
              ...(workerStale(worker?.at ?? null, now)
                ? [
                    {
                      "pos.task.status": "queued",
                      "pos.task.requestedAt": {
                        $lt: new Date(now - QUEUED_EXPIRY_MS),
                      },
                    },
                  ]
                : []),
              {
                "pos.task.status": "running",
                "pos.task.lease.until": { $lt: new Date(now - DEAD_LEASE_MS) },
              },
            ],
          },
          { $set: { "pos.task": next } },
          { session },
        );
        if (done.matchedCount !== 1)
          throw busyError(
            "Another task is already running for this installation.",
          );
        await audit(
          db,
          session,
          req.staff,
          "pos.db-backup.requested",
          "installations",
          id,
          `#${next.id.slice(0, 8)}`,
          req,
        );
        return next;
      });
      res.status(201).json({ task: backupView(task) });
    },
  );
  return router;
}
