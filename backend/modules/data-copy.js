// "Copy data from the demo" API (D58). The API only stores the old database's
// connection string (encrypted, AAD pos:<id>:copy.source), ENQUEUES and READS;
// the worker (backend/worker/data-copy.js) does the work in the installation's
// one `pos.task` slot. Nothing here returns a URI, a document or a value.
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_TASK_STATES,
  WORKER_ONLINE_MS,
  taskBlocks,
} from "../../shared/deploy.js";
import { goliveBlocks } from "../../shared/golive.js";
import { freeSlot, goliveFree } from "../lib/deploy-job.js";
import {
  COPY_BLOCKERS,
  COPY_GROUPS,
  COPY_NEEDS,
  COPY_NOTES,
  copyParamsSchema,
  sortGroups,
} from "../../shared/data-copy.js";
import { HttpError, ensure } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { atlasHost, hostsOf } from "../lib/client-mongo.js";
import { decrypt, encrypt } from "../lib/crypto.js";
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
const BUSY = "Another task or a go-live run is active for this installation.";
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;
const DB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const counts = (value, keys) =>
  value && typeof value === "object"
    ? Object.fromEntries(
        keys.filter((k) => k in value).map((k) => [k, int(value[k])]),
      )
    : null;
const dbOf = (uri) =>
  /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^/?]+)/.exec(uri)?.[1] ?? null;
const placeOf = (uri) => `${hostsOf(uri).sort().join(",")}/${dbOf(uri)}`;
const resultView = (r) =>
  r && typeof r === "object"
    ? {
        mode: r.mode === "copy" ? "copy" : "check",
        from: clean(r.from, 10),
        groups: counts(r.groups, COPY_GROUPS) ?? {},
        copied: counts(r.copied, COPY_GROUPS),
        kept: int(r.kept),
        blocked: counts(r.blocked, COPY_BLOCKERS),
        notes: Array.isArray(r.notes)
          ? r.notes.filter((n) => COPY_NOTES.includes(n))
          : [],
        needs: Array.isArray(r.needs)
          ? r.needs.filter((n) => COPY_NEEDS.includes(n))
          : [],
        older: int(r.older),
        open: int(r.open),
        oldOpen: int(r.oldOpen),
        undated: int(r.undated),
        removed: int(r.removed),
        documents: int(r.documents),
        others: Array.isArray(r.others)
          ? r.others
              .filter((o) => NAME_RE.test(o?.name ?? ""))
              .slice(0, 20)
              .map((o) => ({ name: o.name, count: int(o.count) }))
          : [],
      }
    : null;
// Counts only: never a document or a value.
export const copyView = (task) =>
  task?.kind === "data-copy"
    ? {
        id: clean(task.id, 64),
        status: clean(task.status, 20),
        step: clean(task.step, 20),
        by: { id: clean(task.by?.id, 64), name: clean(task.by?.name, 120) },
        requestedAt: date(task.requestedAt),
        finishedAt: date(task.finishedAt),
        params: {
          mode: task.params?.mode === "copy" ? "copy" : "check",
          from: clean(task.params?.from, 10),
          groups: Array.isArray(task.params?.groups)
            ? sortGroups(task.params.groups)
            : [],
          sourceAt: date(task.params?.sourceAt),
        },
        progress: task.progress
          ? { documents: int(task.progress.documents) }
          : null,
        result: resultView(task.result),
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
const sourceView = (copy) =>
  copy?.source
    ? {
        hosts: (copy.info?.hosts ?? [])
          .filter((h) => HOST_RE.test(h))
          .slice(0, 5),
        db: DB_RE.test(copy.info?.db ?? "") ? copy.info.db : null,
        savedAt: date(copy.info?.savedAt),
      }
    : null;
const lastView = (last) =>
  last
    ? {
        at: date(last.at),
        from: clean(last.from, 10),
        documents: int(last.documents),
      }
    : null;
const conflict = (message, code) => {
  const error = new HttpError(409, message, true);
  error.apiCode = code;
  return error;
};
const sourceSchema = z
  .object({
    uri: z
      .string()
      .trim()
      .min(1, "Paste the connection string.")
      .max(4096)
      .refine(
        (uri) => DB_RE.test(dbOf(uri) ?? ""),
        "Use a mongodb+srv:// string that names the database (…mongodb.net/dbname).",
      )
      .refine((uri) => {
        const hosts = hostsOf(uri);
        return hosts.length > 0 && hosts.every((h) => atlasHost(h));
      }, "Use the Atlas connection string (a host ending in .mongodb.net)."),
  })
  .strict();

export function dataCopyRoutes({ db, client, auth, c }) {
  const router = Router(),
    installations = db.collection("installations");
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  const base = "/installations/:id/pos/data-copy";
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
  const copyRunning = (pos) =>
    pos.task?.kind === "data-copy" &&
    ACTIVE_TASK_STATES.includes(pos.task.status);

  router.get(base, auth.permit("credentials"), async (req, res) => {
    const row = await load(iid(req));
    res.json({
      target: Boolean(row.pos.mongo?.uri),
      source: sourceView(row.pos.copy),
      last: lastView(row.pos.copy?.last),
      task: copyView(row.pos.task),
    });
  });

  router.put(
    `${base}/source`,
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const { uri } = sourceSchema.parse(req.body ?? {});
      const source = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await load(id, session);
        if (copyRunning(row.pos))
          throw busyError("A copy is running for this client.");
        const box = row.pos.mongo?.uri;
        if (box) {
          let own = null;
          try {
            own = decrypt(box, c.VAULT_KEY, `pos:${id}:mongo.uri`);
          } catch {
            own = null; // an unreadable box is reported by POS setup
          }
          if (own && placeOf(own) === placeOf(uri))
            throw conflict(
              "This is this client's own database. Paste the demo's connection string.",
              "same-db",
            );
        }
        const info = {
          hosts: hostsOf(uri),
          db: dbOf(uri),
          savedAt: new Date(),
          by: { id: req.staff._id, name: req.staff.name },
        };
        await installations.updateOne(
          { _id: id },
          {
            $set: {
              "pos.copy.source": encrypt(
                uri,
                c.VAULT_KEY,
                `pos:${id}:copy.source`,
              ),
              "pos.copy.info": info,
            },
          },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.data-copy.source-saved",
          "installations",
          id,
          `${info.hosts[0]}/${info.db}`,
          req,
        );
        return sourceView({ source: true, info });
      });
      res.json({ source });
    },
  );

  router.delete(
    `${base}/source`,
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      z.object({})
        .strict()
        .parse(req.body ?? {});
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await load(id, session);
        if (copyRunning(row.pos))
          throw busyError("A copy is running for this client.");
        await installations.updateOne(
          { _id: id },
          { $unset: { "pos.copy.source": "", "pos.copy.info": "" } },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.data-copy.source-removed",
          "installations",
          id,
          "",
          req,
        );
      });
      res.json({ source: null });
    },
  );

  async function enqueue(req, res, mode) {
    const id = iid(req);
    const params = copyParamsSchema.parse(req.body ?? {});
    // Cheap refusals first: they must not use up the hourly allowance.
    const [pre, worker] = await Promise.all([
      load(id),
      db.collection("system_state").findOne({ _id: "pos-worker" }),
    ]);
    if (!pre.pos.mongo?.uri)
      throw conflict("This client has no database URI yet.", "no-target");
    if (!pre.pos.copy?.source)
      throw conflict(
        "Paste the old database connection string first.",
        "no-source",
      );
    const workerAt = worker?.at ?? null;
    // A go-live run seeds the client's admin login: never both at once (D41).
    if (
      taskBlocks(pre.pos.task, Date.now(), workerAt) ||
      goliveBlocks(pre.pos.golive, Date.now(), workerAt)
    )
      throw busyError(BUSY);
    const beat = new Date(workerAt ?? NaN).getTime();
    if (!(Date.now() - beat < WORKER_ONLINE_MS))
      throw notReadyError(["worker"]);
    await consume(db, `data-copy:${id}`, 30, 3600000);
    const task = await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "deploy");
      const row = await load(id, session);
      ensure(
        row.pos.copy?.source,
        409,
        "Paste the old database connection string first.",
      );
      const now = Date.now();
      const next = {
        id: randomUUID(),
        kind: "data-copy",
        status: "queued",
        step: "queued",
        progress: null,
        lease: { owner: null, until: null, fence: 0 },
        attempt: 0,
        by: { id: req.staff._id, name: req.staff.name },
        requestedAt: new Date(now),
        finishedAt: null,
        params: {
          mode,
          from: params.from,
          groups: sortGroups(params.groups),
          // Which saved old database this run reads (the panel matches it).
          sourceAt: date(row.pos.copy.info?.savedAt),
        },
        result: null,
        error: null,
      };
      const done = await installations.updateOne(
        {
          _id: id,
          $and: [
            freeSlot("pos.task", ACTIVE_TASK_STATES, now, workerAt),
            goliveFree(now, workerAt),
          ],
        },
        { $set: { "pos.task": next } },
        { session },
      );
      if (done.matchedCount !== 1) throw busyError(BUSY);
      await audit(
        db,
        session,
        req.staff,
        "pos.data-copy.requested",
        "installations",
        id,
        `${mode} from ${params.from} #${next.id.slice(0, 8)}`,
        req,
      );
      return next;
    });
    res.status(201).json({ task: copyView(task) });
  }
  // Check only reads both databases; Copy writes and needs a fresh step-up.
  router.post(`${base}/check`, auth.permit("deploy"), (req, res) =>
    enqueue(req, res, "check"),
  );
  router.post(base, auth.permit("deploy"), auth.requireStepUp, (req, res) =>
    enqueue(req, res, "copy"),
  );
  return router;
}
