// Go-live API of a NEW client (P5 Stage 3, D41-D47). Like deploys.js it only
// ENQUEUES and READS: the go-live worker lane executes. The stored shape is
// the contract in shared/golive.js; the panel only ever sees goliveView
// (backend/lib/deploy-view.js). Nothing here logs or returns a token, URI,
// key or provider text.
import { Router } from "express";
import { z } from "zod";
import { goliveSchemas } from "../../shared/schemas.js";
import {
  ACTIVE_STATES,
  ACTIVE_TASK_STATES,
  blockedFor,
  jobBlocks,
  readinessOf,
  sha7,
  taskBlocks,
  verifyStateOf,
} from "../../shared/deploy.js";
import {
  GOLIVE_RATE,
  goliveActionProblem,
  goliveBlockedFor,
  goliveBlocks,
  goliveReadinessOf,
} from "../../shared/golive.js";
import {
  PLATFORM_APEX,
  hostOf,
  labelProblem,
} from "../../shared/web-address.js";
import {
  freeSlot,
  goliveFree,
  labelHolderFilter,
  leaseless,
  newGolive,
  newJob,
  person,
} from "../lib/deploy-job.js";
import {
  goliveView,
  jobView,
  storedCommit,
  verifyView,
  workerView,
} from "../lib/deploy-view.js";
import { ensure, staleError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import { busyError, labelTakenError, notReadyError } from "./pos.js";
import { conflict, deployHelpers, freezeView } from "./deploys.js";

const HOUR = 3600000;
const stale = () => staleError("POS settings changed. Reload and try again.");
const STATE_MESSAGES = {
  start: "A go-live cannot start now: it is deploying or already live.",
  check: "Check DNS is only possible while the go-live waits for DNS.",
  "sync-env": "Sync env is only possible once the client is live.",
  realtime: "The realtime Worker can be updated once the client is live.",
  deploy: "Unlock and deploy is only possible while the go-live waits for it.",
  cancel: "This go-live run cannot be cancelled now.",
};
// 409 busy | golive-state for an action that cannot run now.
function refuse(golive, action, now, workerAt) {
  const problem = goliveActionProblem(golive, action, now, workerAt);
  if (problem === "busy")
    throw busyError("A go-live run is already active for this installation.");
  if (problem) throw conflict("golive-state", STATE_MESSAGES[action]);
}
const gateGolive = (view, action) => {
  const items = goliveBlockedFor(view, action);
  if (items.length) throw notReadyError(items);
};
// A run that follows the go-live's address needs the block to still name it.
const sameAddress = (pos) =>
  Boolean(pos.golive?.address?.label) &&
  pos.subdomain === pos.golive.address.label &&
  pos.host === pos.golive.address.host;
const addressChanged = () =>
  conflict(
    "golive-address",
    "The web address changed since the go-live started. Press Start again.",
  );
// Deploy job and task slots free, and no go-live run still holding the block.
const allFree = (now, workerAt) => ({
  $and: [
    freeSlot("pos.deploy.current", ACTIVE_STATES, now, workerAt),
    freeSlot("pos.task", ACTIVE_TASK_STATES, now, workerAt),
    goliveFree(now, workerAt),
  ],
});
const busyOf = (pos, now, workerAt) =>
  goliveBlocks(pos.golive, now, workerAt)
    ? "A go-live run is already active for this installation."
    : jobBlocks(pos.deploy?.current, now, workerAt)
      ? "A deploy is running for this installation."
      : taskBlocks(pos.task, now, workerAt)
        ? "A task is running for this installation."
        : null;
const isDuplicate = (error) =>
  error?.code === 11000 ||
  error?.errorResponse?.code === 11000 ||
  /E11000/.test(String(error?.message ?? ""));

export function goliveRoutes(deps) {
  const { db, client, auth } = deps;
  const router = Router(),
    installations = db.collection("installations");
  const {
    gh,
    loadRow,
    factsOf,
    gate,
    typed,
    buildKeyFor,
    verifySha,
    heartbeatAt,
  } = deployHelpers(deps);
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  const body = (schema, req) => schema.parse(req.body ?? {});
  const checkRev = (pos, rev) => {
    if (pos.rev !== rev) throw stale();
  };
  // Readiness of Unlock and deploy: the block as it will be once unlocked,
  // with a bootstrap verify accepted (D47). Gate "deploy" of shared/deploy.js.
  const unlockedView = (facts) =>
    readinessOf({
      ...facts.ctx,
      pos: { ...facts.ctx.pos, deployLock: false },
      bootstrap: true,
    });

  // ---- state for polling -----------------------------------------------------
  router.get(
    "/installations/:id/pos/golive",
    auth.permit("credentials"),
    async (req, res) => {
      const row = await loadRow(iid(req));
      const facts = await factsOf(row, req.staff);
      const pos = row.pos;
      const now = Date.now();
      const workerAt = facts.worker?.at ?? null;
      const readiness = goliveReadinessOf(facts.ctx);
      const can = (action) =>
        goliveActionProblem(pos.golive, action, now, workerAt) === null;
      const deployBlocked = can("deploy")
        ? blockedFor(unlockedView(facts), "deploy")
        : [];
      const label = pos.subdomain || "";
      res.json({
        rev: pos.rev,
        slug: pos.slug,
        golive: goliveView(pos.golive, now, workerAt),
        readiness,
        address: {
          label,
          host: label ? hostOf(label) : "",
          problem: label ? labelProblem(label) : null,
        },
        allowed: {
          start:
            can("start") && goliveBlockedFor(readiness, "start").length === 0,
          check: can("check"),
          "sync-env":
            can("sync-env") &&
            goliveBlockedFor(readiness, "sync-env").length === 0,
          realtime:
            can("realtime") &&
            goliveBlockedFor(readiness, "realtime").length === 0,
          deploy: can("deploy") && deployBlocked.length === 0,
          cancel: can("cancel"),
        },
        deployBlocked,
        busy: Boolean(busyOf(pos, now, workerAt)),
        worker: workerView(facts.worker, now),
        freeze: freezeView(facts.freeze),
        verifyState: verifyStateOf(pos.verify, now),
        verify: verifyView(pos.verify),
      });
    },
  );

  // ---- start / resume, Sync env, Update realtime Worker ------------------------
  router.post(
    "/installations/:id/pos/golive",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(goliveSchemas.run, req);
      const { action } = input;
      const row = await loadRow(id);
      typed(input.confirm, row.pos.slug);
      await consume(db, `golive:${id}`, GOLIVE_RATE.start, HOUR);
      checkRev(row.pos, input.rev);
      const early = await factsOf(row, req.staff);
      const workerAt = early.worker?.at ?? null;
      refuse(row.pos.golive, action, Date.now(), workerAt);
      gateGolive(goliveReadinessOf(early.ctx), action);
      const busy = busyOf(row.pos, Date.now(), workerAt);
      if (busy) throw busyError(busy);
      // Sync env and a Worker update write the go-live's own address.
      if (action !== "start" && !sameAddress(row.pos)) throw addressChanged();
      // Never accept an arbitrary commit: it must be on the branch right now.
      if (input.sha) await verifySha(input.branch, input.sha);
      let next;
      try {
        next = await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "deploy");
          const fresh = await loadRow(id, session);
          const pos = fresh.pos;
          checkRev(pos, input.rev);
          const facts = await factsOf(fresh, req.staff, session);
          const now = Date.now();
          const wAt = facts.worker?.at ?? null;
          refuse(pos.golive, action, now, wAt);
          gateGolive(goliveReadinessOf(facts.ctx), action);
          const set = {};
          let label = pos.golive?.address?.label,
            host = pos.golive?.address?.host,
            bump = false;
          if (action === "start") {
            // The address is derived here from the label (D44).
            label = pos.subdomain;
            host = hostOf(label);
            const holder = await installations.findOne(
              labelHolderFilter(id, label, host),
              { session, projection: { _id: 1 } },
            );
            if (holder) throw labelTakenError();
            if (
              pos.host !== host ||
              pos.tenantId !== label ||
              pos.rootDomain !== PLATFORM_APEX
            ) {
              set["pos.host"] = host;
              set["pos.tenantId"] = label;
              set["pos.rootDomain"] = PLATFORM_APEX;
              // What verify checks changed: the last verify no longer counts.
              set["pos.verify"] = null;
              bump = true;
            }
          } else if (!sameAddress(pos)) throw addressChanged();
          const golive = newGolive({
            action,
            branch: input.branch,
            sha: input.sha,
            by: person(req.staff),
            now,
            prior: pos.golive ?? null,
            label,
            host,
          });
          set["pos.golive"] = golive;
          const done = await installations.updateOne(
            { _id: id, "pos.rev": input.rev, ...allFree(now, wAt) },
            { $set: set, ...(bump ? { $inc: { "pos.rev": 1 } } : {}) },
            { session },
          );
          if (done.matchedCount !== 1) {
            const again = await loadRow(id, session);
            const reason = busyOf(again.pos, Date.now(), wAt);
            if (reason) throw busyError(reason);
            throw stale();
          }
          await audit(
            db,
            session,
            req.staff,
            "pos.golive.started",
            "installations",
            id,
            `${action} ${golive.branch || "-"}@${sha7(golive.sha) || "-"} #${golive.requestId.slice(0, 8)}`,
            req,
          );
          return golive;
        });
      } catch (error) {
        // Two starts with the same label at once: the unique index decides.
        if (isDuplicate(error)) throw labelTakenError();
        throw error;
      }
      res
        .status(201)
        .json({ golive: goliveView(next, Date.now(), await heartbeatAt()) });
    },
  );

  // ---- Check DNS ---------------------------------------------------------------
  router.post(
    "/installations/:id/pos/golive/check",
    auth.permit("credentials"),
    async (req, res) => {
      const id = iid(req);
      const input = body(goliveSchemas.check, req);
      const row = await loadRow(id);
      await consume(db, `golive-check:${id}`, GOLIVE_RATE.check, HOUR);
      const early = await factsOf(row, req.staff);
      refuse(row.pos.golive, "check", Date.now(), early.worker?.at ?? null);
      checkRev(row.pos, input.rev);
      if (!sameAddress(row.pos)) throw addressChanged();
      gateGolive(goliveReadinessOf(early.ctx), "check");
      const next = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "credentials");
        const fresh = await loadRow(id, session);
        const pos = fresh.pos;
        const facts = await factsOf(fresh, req.staff, session);
        const now = Date.now();
        const wAt = facts.worker?.at ?? null;
        refuse(pos.golive, "check", now, wAt);
        checkRev(pos, input.rev);
        if (!sameAddress(pos)) throw addressChanged();
        gateGolive(goliveReadinessOf(facts.ctx), "check");
        const golive = newGolive({
          action: "check",
          by: person(req.staff),
          now,
          prior: pos.golive,
          label: pos.golive.address.label,
          host: pos.golive.address.host,
        });
        const done = await installations.updateOne(
          {
            _id: id,
            "pos.rev": input.rev,
            "pos.golive.requestId": pos.golive.requestId,
            ...allFree(now, wAt),
          },
          { $set: { "pos.golive": golive } },
          { session },
        );
        if (done.matchedCount !== 1) throw stale();
        await audit(
          db,
          session,
          req.staff,
          "pos.golive.check",
          "installations",
          id,
          `#${golive.requestId.slice(0, 8)}`,
          req,
        );
        return golive;
      });
      res
        .status(201)
        .json({ golive: goliveView(next, Date.now(), await heartbeatAt()) });
    },
  );

  // ---- Unlock and deploy (D47) ---------------------------------------------------
  router.post(
    "/installations/:id/pos/golive/deploy",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(goliveSchemas.deploy, req);
      const row = await loadRow(id);
      typed(input.confirm, row.pos.slug);
      checkRev(row.pos, input.rev);
      const early = await factsOf(row, req.staff);
      const workerAt = early.worker?.at ?? null;
      refuse(row.pos.golive, "deploy", Date.now(), workerAt);
      if (!sameAddress(row.pos)) throw addressChanged();
      gate(unlockedView(early), "deploy");
      if (jobBlocks(row.pos.deploy?.current, Date.now(), workerAt))
        throw busyError("A deploy is already running for this installation.");
      await consume(db, `deploy:${id}`, 30, HOUR);
      const g = row.pos.golive;
      await verifySha(g.branch, g.sha);
      // The worker has no source token: the headline comes from here.
      let commit;
      try {
        commit = storedCommit(await gh.commit(g.sha), g.sha, g.branch);
      } catch {
        commit = null;
      }
      const built = await buildKeyFor(
        { ...row.pos, deployLock: false },
        early.worker,
      );
      const out = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const fresh = await loadRow(id, session);
        const pos = fresh.pos;
        checkRev(pos, input.rev);
        const facts = await factsOf(fresh, req.staff, session);
        const now = Date.now();
        const wAt = facts.worker?.at ?? null;
        refuse(pos.golive, "deploy", now, wAt);
        ensure(
          pos.golive.requestId === g.requestId,
          409,
          "Reload and try again.",
        );
        if (!sameAddress(pos)) throw addressChanged();
        gate(unlockedView(facts), "deploy");
        const job = newJob({
          kind: "deploy",
          branch: g.branch,
          sha: g.sha,
          buildKey: built?.key,
          commit,
          by: person(req.staff),
          now,
        });
        const steps = (pos.golive.steps ?? []).map((step) =>
          step?.name === "deploy"
            ? { ...step, state: "running", startedAt: new Date(now) }
            : step,
        );
        const golive = {
          status: "deploying",
          waitingFor: null,
          step: "deploy",
          steps,
          deployRequestId: job.requestId,
        };
        const done = await installations.updateOne(
          {
            _id: id,
            "pos.rev": input.rev,
            "pos.golive.requestId": g.requestId,
            "pos.golive.status": "waiting",
            "pos.golive.waitingFor": "deploy",
            ...allFree(now, wAt),
          },
          {
            $set: {
              // The same fields as /pos/unlock (no local file to attest).
              "pos.deployLock": false,
              "pos.unlockedAt": new Date(now),
              "pos.unlockedBy": person(req.staff),
              "pos.localLockConfirmedAt": null,
              "pos.deploy.current": job,
              ...Object.fromEntries(
                Object.entries(golive).map(([k, v]) => [`pos.golive.${k}`, v]),
              ),
            },
          },
          { session },
        );
        if (done.matchedCount !== 1) {
          const again = await loadRow(id, session);
          const reason = busyOf(again.pos, Date.now(), wAt);
          if (reason) throw busyError(reason);
          throw stale();
        }
        await audit(
          db,
          session,
          req.staff,
          "pos.unlocked",
          "installations",
          id,
          `${pos.slug} golive`,
          req,
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.golive.deploy",
          "installations",
          id,
          `${g.branch}@${sha7(g.sha)} #${job.requestId.slice(0, 8)}`,
          req,
        );
        return { job, golive: { ...pos.golive, ...golive } };
      });
      const at = await heartbeatAt();
      res.status(201).json({
        golive: goliveView(out.golive, Date.now(), at),
        current: jobView(out.job, Date.now(), at),
      });
    },
  );

  // ---- cancel --------------------------------------------------------------------
  router.post(
    "/installations/:id/pos/golive/cancel",
    auth.permit("deploy"),
    async (req, res) => {
      const id = iid(req);
      const { requestId } = body(goliveSchemas.cancel, req);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        const g = row.pos.golive;
        ensure(g?.requestId === requestId, 404, "No such go-live run.");
        const now = Date.now();
        const workerAt = await heartbeatAt(session);
        if (!["queued", "running", "waiting"].includes(g.status))
          throw conflict("golive-state", STATE_MESSAGES.cancel);
        if (g.status === "running" && g.cancelRequested)
          return goliveView(g, now, workerAt);
        // A running run with a live lease stops between steps (the worker
        // writes "cancelled"); anything else ends now, and a dead lease is
        // fenced off by a new fence value.
        const live = g.status === "running" && goliveBlocks(g, now, workerAt);
        const fields = live
          ? { cancelRequested: true }
          : {
              status: "cancelled",
              cancelRequested: true,
              waitingFor: null,
              endedAt: new Date(now),
              lease: { ...leaseless(), fence: (g.lease?.fence ?? 0) + 1 },
            };
        const done = await installations.updateOne(
          {
            _id: id,
            "pos.golive.requestId": requestId,
            "pos.golive.status": g.status,
          },
          {
            $set: Object.fromEntries(
              Object.entries(fields).map(([k, v]) => [`pos.golive.${k}`, v]),
            ),
          },
          { session },
        );
        if (done.matchedCount !== 1)
          throw staleError("The go-live changed. Reload and try again.");
        await audit(
          db,
          session,
          req.staff,
          "pos.golive.cancelled",
          "installations",
          id,
          `${g.action} #${requestId.slice(0, 8)}`,
          req,
        );
        return goliveView(
          (await loadRow(id, session)).pos.golive,
          now,
          workerAt,
        );
      });
      res.json({ golive: view });
    },
  );
  return router;
}
