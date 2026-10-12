// POS deploy API (Stage 2 W3). The API only ENQUEUES and READS: the worker
// (W2) executes. The stored job shapes are the JOB CONTRACT in
// shared/deploy.js; the panel only ever sees the whitelist views of
// backend/lib/deploy-view.js. Nothing here logs or returns a token, URI or key.
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { deploySchemas } from "../../shared/schemas.js";
import {
  ACTIVE_STATES,
  ACTIVE_TASK_STATES,
  PURGE_WINDOW_MS,
  TERMINAL_STATES,
  blockedFor,
  buildRowId,
  isActiveState,
  BUILDER_CHECK_MAX_AGE_MS,
  isBranch,
  isSha,
  jobBlocks,
  taskBlocks,
  readinessOf,
  sha7,
  verifyStateOf,
} from "../../shared/deploy.js";
import {
  MAX_TARGETS,
  ROLLOUT_ACTIVE,
  ROLLOUT_CONFIRM,
  ROLLOUT_FINISHED,
  ROLLOUT_GATE,
  ROLLOUT_ROW_ID,
  TARGET_PROJECTION,
  classifyTarget,
  newRolloutTarget,
  orderTargets,
  resumeTargets,
  targetFacts,
} from "../../shared/rollout.js";
import {
  cancelFields,
  freeSlot,
  leaseless,
  newBuildRow,
  newJob,
  person,
  releasePrebuilds,
} from "../lib/deploy-job.js";
import { HttpError, ensure, staleError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { consume } from "../lib/limiter.js";
import { transaction } from "../db.js";
import { authorizeWrite } from "./records.js";
import { createGitHub } from "../lib/github.js";
import { ProviderError } from "../lib/provider-http.js";
import { createBuildCache, MANIFEST_FORMAT } from "../lib/build-cache.js";
import {
  buildInputs,
  buildKeyOf,
  canonicalNextPublic,
  inputsOkOf,
  parseBuilderJson,
} from "../lib/build-inputs.js";
import { isConflict } from "../lib/s3.js";
import {
  cleanText,
  cutoverView,
  deployView,
  jobView,
  key8,
  storedCommit,
  purgeDigest,
  rolloutDigest,
  rolloutView,
  taskView,
  verifyView,
  versionView,
  workerView,
} from "../lib/deploy-view.js";
import { fleetUsageStalled, fleetUsageView } from "../lib/usage-view.js";
import { busyError } from "./pos.js";

export { deployView };
// {a: 1} -> {"<path>.a": 1}
const prefixed = (path, fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`${path}.${key}`, value]),
  );
const conflict = (code, message, items) => {
  const error = new HttpError(409, message);
  error.apiCode = code;
  if (items) error.items = items;
  return error;
};
const failure = (error) => {
  if (error instanceof ProviderError) {
    const out = new HttpError(
      502,
      `GitHub request failed (${error.code}).`,
      true,
    );
    out.apiCode = "provider-error";
    return out;
  }
  return error;
};
// {on, reason, by, at}: reason is free text typed by the owner, so it is
// cleaned (control and bidi characters) and capped; nothing else is exposed.
const freezeView = (row) => {
  const on = row?.on === true;
  const text = cleanText(row?.reason, 200);
  return {
    on,
    reason: on ? text : "",
    by: on
      ? {
          id: String(row.by?.id ?? "").slice(0, 64),
          name: String(row.by?.name ?? "").slice(0, 120),
        }
      : null,
    at: on ? (row.at ?? null) : null,
  };
};
export function deployRoutes({ db, client, c, auth, s3, github, buildCache }) {
  const router = Router(),
    installations = db.collection("installations"),
    state = db.collection("system_state");
  const gh =
    github ??
    createGitHub({
      sourceRepo: c.POS_GITHUB_SOURCE_REPO,
      sourceToken: c.POS_GITHUB_SOURCE_TOKEN,
      // The API never talks to the builder repo: its descriptor comes from
      // the worker heartbeat (the app container has no builder token).
    });
  const cacheStore =
    buildCache === undefined
      ? c.POS_BUILD_CACHE === "on" && s3
        ? createBuildCache({ s3, vaultKey: c.VAULT_KEY })
        : null
      : buildCache;
  // Short-lived caches: nothing here is secret (names, shas, headlines).
  const memo = new LRUCache({ max: 500, ttl: 60000 });
  const compareMemo = new LRUCache({ max: 1000, ttl: 600000 });
  async function remember(key, load) {
    if (memo.has(key)) return memo.get(key);
    const pending = Promise.resolve().then(load);
    memo.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      memo.delete(key);
      throw error;
    }
  }
  router.use(auth.requireAuth);
  const iid = (req) => z.uuid().parse(req.params.id);
  const body = (schema, req) => schema.parse(req.body ?? {});

  // ---- loading and readiness -------------------------------------------------
  async function loadRow(id, session) {
    const row = await installations.findOne(
      { _id: id },
      {
        session,
        projection: { productId: 1, customerId: 1, status: 1, pos: 1 },
      },
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
  async function readiness(row, staff, session) {
    const [worker, freeze, customer] = await Promise.all([
      state.findOne({ _id: "pos-worker" }, { session }),
      state.findOne({ _id: "pos-deploy-freeze" }, { session }),
      db
        .collection("customers")
        .findOne(
          { _id: row.customerId },
          { session, projection: { status: 1 } },
        ),
    ]);
    let inputsOk = true;
    try {
      canonicalNextPublic(row.pos);
    } catch {
      inputsOk = false;
    }
    return {
      worker,
      freeze,
      view: readinessOf({
        now: Date.now(),
        installationId: row._id,
        customerId: row.customerId,
        worker,
        sources: {
          source: gh.configured().source,
          builder: worker?.builderConfigured === true,
        },
        cacheConfigured: Boolean(cacheStore),
        authenticator: Boolean(staff?.totp?.enabledAt),
        freeze,
        pos: row.pos,
        inputsOk,
        customerStatus: customer?.status,
        installationStatus: row.status,
      }),
    };
  }
  // 409 {code:"not-ready", items} when a required item of the gate blocks.
  const gate = (view, name) => {
    const items = blockedFor(view, name);
    if (items.length)
      throw conflict("not-ready", "This client is not ready yet.", items);
  };
  const typed = (value, slug) =>
    ensure(
      typeof value === "string" && value === slug,
      400,
      "Type the installation slug to confirm.",
    );

  // ---- GitHub and build cache ------------------------------------------------
  const workerRow = () => state.findOne({ _id: "pos-worker" });
  // The builder descriptor the worker last verified, from its heartbeat; null
  // when absent, not ok, or stale.
  function builderOf(worker, now = Date.now()) {
    const b = worker?.builder;
    if (!b || b.ok !== true || !isSha(b.sha)) return null;
    const checked = new Date(b.checkedAt ?? NaN).getTime();
    if (!Number.isFinite(checked) || now - checked >= BUILDER_CHECK_MAX_AGE_MS)
      return null;
    try {
      return {
        sha: b.sha,
        builder: parseBuilderJson({
          protocol: b.protocol ?? 1,
          nodeVersion: b.nodeVersion,
          cliVersion: b.cliVersion,
        }),
      };
    } catch {
      return null;
    }
  }
  // {key, inputs} or null when the builder descriptor is not usable.
  async function buildKeyFor(pos, worker) {
    try {
      const info = builderOf(worker);
      if (!info) return null;
      const inputs = buildInputs({
        pos,
        builderSha: info.sha,
        builder: info.builder,
      });
      return { key: buildKeyOf(c.VAULT_KEY, inputs), inputs };
    } catch {
      return null;
    }
  }
  // cached | will-build | unavailable | off
  async function cacheState(sha, key) {
    if (!cacheStore) return { state: "off", builtAt: null };
    if (!key) return { state: "unavailable", builtAt: null };
    try {
      const found = await remember(`cache:${sha}:${key}`, () =>
        cacheStore.lookup({ sha, buildKey: key }),
      );
      return found.state === "hit"
        ? { state: "cached", builtAt: new Date(found.manifest.builtAt) }
        : { state: "will-build", builtAt: null };
    } catch {
      return { state: "unavailable", builtAt: null };
    }
  }
  async function headOf(branch) {
    return remember(`head:${branch}`, () => gh.branchHead(branch));
  }
  // Promises are stored, so rows asking for the same pair at once share one call.
  function compareOf(base, head) {
    const key = `${base}:${head}`;
    if (!compareMemo.has(key)) {
      const pending = Promise.resolve().then(() => gh.compare(base, head));
      compareMemo.set(key, pending);
      pending.catch(() => compareMemo.delete(key));
    }
    return compareMemo.get(key);
  }
  // Builder review L3: the sha must be reachable from the branch right now.
  async function verifySha(branch, sha) {
    let head;
    try {
      head = await gh.branchHead(branch);
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not-found")
        throw conflict(
          "sha-not-on-branch",
          "That branch no longer exists. Reload the branch list.",
        );
      throw failure(error);
    }
    if (head.sha === sha) return head;
    let relation;
    try {
      relation = await gh.compare(sha, head.sha);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        ["not-found", "invalid"].includes(error.code)
      )
        throw conflict(
          "sha-not-on-branch",
          "That commit is not on the selected branch.",
        );
      throw failure(error);
    }
    // identical/ahead: sha is the head or one of its ancestors.
    if (relation.status === "ahead") return head;
    if (relation.status === "behind")
      throw conflict(
        "branch-moved",
        "The branch moved since you loaded it. Reload and try again.",
      );
    throw conflict(
      "sha-not-on-branch",
      "That commit is not on the selected branch.",
    );
  }

  // ---- state for polling -----------------------------------------------------
  router.get(
    "/installations/:id/pos/deploys",
    auth.permit("credentials"),
    async (req, res) => {
      const row = await loadRow(iid(req));
      const { worker, freeze, view } = await readiness(row, req.staff);
      const pos = row.pos;
      res.json({
        readiness: view,
        worker: workerView(worker),
        cache: { configured: Boolean(cacheStore) },
        freeze: freezeView(freeze),
        locked: pos.deployLock !== false,
        verifyState: verifyStateOf(pos.verify),
        verify: verifyView(pos.verify),
        task: taskView(pos.task),
        cutoverAt: cutoverView(pos.deploy),
        ...deployView(pos.deploy, Date.now(), worker?.at ?? null),
      });
    },
  );

  router.get("/pos/branches", auth.permit("credentials"), async (req, res) => {
    const { installation } = deploySchemas.branches.parse(req.query);
    await consume(db, `branches:${req.staff._id}`, 120, 3600000);
    const row = installation ? await loadRow(installation) : null;
    let list;
    try {
      list = await remember("branches", () => gh.branches());
    } catch (error) {
      throw failure(error);
    }
    const key = row
      ? (await buildKeyFor(row.pos, await workerRow()))?.key
      : null;
    const branches = await Promise.all(
      list.map(async (b) => ({
        name: b.name,
        sha: b.sha,
        headline: b.headline,
        date: b.date,
        // null = unknown (no installation, builder unreadable, cache off)
        cached:
          row && cacheStore && key
            ? (await cacheState(b.sha, key)).state === "cached"
            : null,
      })),
    );
    res.json({ branches, cache: { configured: Boolean(cacheStore) } });
  });

  router.get(
    "/installations/:id/pos/deploy-plan",
    auth.permit("credentials"),
    async (req, res) => {
      const { branch } = deploySchemas.plan.parse(req.query);
      await consume(db, `plan:${req.staff._id}`, 120, 3600000);
      const row = await loadRow(iid(req));
      let head, relation;
      try {
        head = await headOf(branch);
        const live = row.pos.deploy?.last?.sha;
        if (live)
          relation =
            live === head.sha
              ? { status: "identical", aheadBy: 0, behindBy: 0 }
              : await compareOf(live, head.sha);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not-found")
          throw conflict(
            "sha-not-on-branch",
            "That branch no longer exists. Reload the branch list.",
          );
        throw failure(error);
      }
      const worker = await workerRow();
      const built = await buildKeyFor(row.pos, worker);
      const cache = await cacheState(head.sha, built?.key);
      const last = row.pos.deploy?.last;
      res.json({
        branch,
        head: { sha: head.sha, headline: head.headline, date: head.date },
        live: last ? { branch: last.branch, sha: last.sha } : null,
        relation: relation
          ? {
              status: relation.status,
              // head ahead of live = the client is behind by this many
              behindBy: relation.status === "ahead" ? relation.aheadBy : 0,
              aheadBy: relation.status === "behind" ? relation.behindBy : 0,
            }
          : null,
        cache: { state: cache.state, builtAt: cache.builtAt },
        buildKey8: key8(built?.key),
        estimateMs:
          cache.state === "cached" ? 0 : workerView(worker).lastBuildMs,
        // True when the live build was made with other inputs than today's.
        settingsChanged: Boolean(
          built?.key &&
          last?.build?.buildKey &&
          last.build.buildKey !== built.key,
        ),
      });
    },
  );

  // ---- enqueue ---------------------------------------------------------------
  const heartbeatAt = async (session) =>
    (
      await state.findOne(
        { _id: "pos-worker" },
        { session, projection: { at: 1 } },
      )
    )?.at ?? null;
  async function claimDeploySlot(session, row, job, now) {
    const workerAt = await heartbeatAt(session);
    const done = await installations.updateOne(
      {
        _id: row._id,
        "pos.rev": row.pos.rev,
        "pos.deployLock": false,
        ...freeSlot("pos.deploy.current", ACTIVE_STATES, now, workerAt),
      },
      { $set: { "pos.deploy.current": job } },
      { session },
    );
    if (done.matchedCount !== 1) {
      const now2 = await installations.findOne(
        { _id: row._id },
        { session, projection: { pos: 1 } },
      );
      if (jobBlocks(now2?.pos?.deploy?.current, Date.now(), workerAt))
        throw busyError("A deploy is already running for this installation.");
      throw staleError("POS settings changed. Reload and try again.");
    }
  }
  router.post(
    "/installations/:id/pos/deploys",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(deploySchemas.enqueue, req);
      const row = await loadRow(id);
      const pos = row.pos;
      const redeploy = input.kind === "redeploy";
      if (!redeploy) typed(input.confirm, pos.slug);
      // Redeploying the PREVIOUS version changes production like a rollback.
      else if (input.of === "previous") typed(input.confirm, pos.slug);
      else ensure(input.confirm === true, 400, "Confirm the redeploy.");
      let branch = input.branch,
        sha = input.sha,
        commit = null;
      if (redeploy) {
        const version = pos.deploy?.[input.of];
        ensure(
          version && /^[0-9a-f]{40}$/.test(version.sha ?? ""),
          409,
          input.of === "last"
            ? "There is no live admin deploy to redeploy."
            : "There is no previous version to redeploy.",
        );
        ({ branch, sha } = version);
        commit = storedCommit(version.commit, sha, branch);
      }
      const early = await readiness(row, req.staff);
      gate(early.view, "deploy");
      if (jobBlocks(pos.deploy?.current, Date.now(), early.worker?.at ?? null))
        throw busyError("A deploy is already running for this installation.");
      await consume(db, `deploy:${id}`, 30, 3600000);
      // Never accept an arbitrary sha: re-resolve the branch and check it.
      if (!redeploy) {
        await verifySha(branch, sha);
        // The worker has no source token: the headline comes from here.
        try {
          commit = storedCommit(await gh.commit(sha), sha, branch);
        } catch {
          commit = null;
        }
      }
      const built = await buildKeyFor(pos, early.worker);
      const job = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const fresh = await loadRow(id, session);
        gate((await readiness(fresh, req.staff, session)).view, "deploy");
        const now = Date.now();
        const next = newJob({
          kind: input.kind,
          branch,
          sha,
          buildKey: built?.key,
          commit,
          by: person(req.staff),
          now,
        });
        await claimDeploySlot(session, fresh, next, now);
        await audit(
          db,
          session,
          req.staff,
          redeploy ? "pos.redeploy.requested" : "pos.deploy.requested",
          "installations",
          id,
          `${branch}@${sha7(sha)} #${next.requestId.slice(0, 8)}`,
          req,
        );
        return next;
      });
      res.status(201).json({ current: jobView(job) });
    },
  );

  router.post(
    "/installations/:id/pos/rollback",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(deploySchemas.rollback, req);
      const row = await loadRow(id);
      const pos = row.pos;
      typed(input.confirm, pos.slug);
      const previous = pos.deploy?.previous;
      // Instant rollback needs only the Vercel deployment id: a pre-admin
      // baseline (no sha) is fine; only the cached-build fallback is lost.
      ensure(
        pos.deploy?.last && previous?.vercelDeploymentId,
        409,
        "There is no previous version to roll back to.",
      );
      const early = await readiness(row, req.staff);
      gate(early.view, "rollback");
      if (jobBlocks(pos.deploy?.current, Date.now(), early.worker?.at ?? null))
        throw busyError("A deploy is already running for this installation.");
      await consume(db, `rollback:${id}`, 30, 3600000);
      const job = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const fresh = await loadRow(id, session);
        gate((await readiness(fresh, req.staff, session)).view, "rollback");
        const target = fresh.pos.deploy?.previous;
        ensure(
          target?.vercelDeploymentId === previous.vercelDeploymentId,
          409,
          "The previous version changed. Reload and try again.",
        );
        const now = Date.now();
        const next = newJob({
          kind: "rollback",
          branch: target.branch ?? "",
          sha: isSha(target.sha) ? target.sha : "",
          buildKey: target.build?.buildKey,
          commit: storedCommit(target.commit, target.sha, target.branch),
          by: person(req.staff),
          now,
          target: target.vercelDeploymentId,
        });
        await claimDeploySlot(session, fresh, next, now);
        await audit(
          db,
          session,
          req.staff,
          "pos.rollback.requested",
          "installations",
          id,
          `${target.branch || "pre-admin"}@${sha7(target.sha) || "-"} #${next.requestId.slice(0, 8)}`,
          req,
        );
        return next;
      });
      res.status(201).json({ current: jobView(job) });
    },
  );

  router.post(
    "/installations/:id/pos/deploys/cancel",
    auth.permit("deploy"),
    async (req, res) => {
      const id = iid(req);
      const { requestId } = body(deploySchemas.job, req);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        const job = row.pos.deploy?.current;
        ensure(job?.requestId === requestId, 404, "No such deploy.");
        // A claimed rollback has started switching production: no cancel.
        if (job.kind === "rollback" && job.lease?.owner) {
          const error = new HttpError(
            409,
            "A rollback in progress cannot be cancelled.",
          );
          error.apiCode = "not-cancellable";
          throw error;
        }
        if (job.status === "cancelling") return jobView(job);
        ensure(
          isActiveState(job.status),
          409,
          "This deploy has already finished.",
        );
        const fields = cancelFields(job, Date.now());
        if (!fields) {
          const error = new HttpError(409, "Too late to cancel.");
          error.apiCode = "too-late";
          throw error;
        }
        const set = prefixed("pos.deploy.current", fields);
        const done = await installations.updateOne(
          {
            _id: id,
            "pos.deploy.current.requestId": requestId,
            "pos.deploy.current.status": job.status,
            "pos.deploy.current.step": job.step,
          },
          { $set: set },
          { session },
        );
        if (done.matchedCount !== 1)
          throw staleError("The deploy changed. Reload and try again.");
        await audit(
          db,
          session,
          req.staff,
          "pos.deploy.cancel-requested",
          "installations",
          id,
          `${job.branch}@${sha7(job.sha)} #${requestId.slice(0, 8)}`,
          req,
        );
        return jobView((await loadRow(id, session)).pos.deploy.current);
      });
      res.json({ current: view });
    },
  );

  router.post(
    "/installations/:id/pos/deploys/dismiss",
    auth.permit("deploy"),
    async (req, res) => {
      const id = iid(req);
      const { requestId } = body(deploySchemas.job, req);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        const job = row.pos.deploy?.current;
        ensure(job?.requestId === requestId, 404, "No such deploy.");
        ensure(
          TERMINAL_STATES.includes(job.status),
          409,
          "Only a finished deploy can be dismissed.",
        );
        await installations.updateOne(
          { _id: id, "pos.deploy.current.requestId": requestId },
          { $set: { "pos.deploy.current": null } },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.deploy.dismissed",
          "installations",
          id,
          `${job.branch}@${sha7(job.sha)} #${requestId.slice(0, 8)}`,
          req,
        );
      });
      res.json({ ok: true });
    },
  );

  // ---- lock / unlock ---------------------------------------------------------
  router.post(
    "/installations/:id/pos/lock",
    auth.permit("deploy"),
    async (req, res) => {
      const id = iid(req);
      body(deploySchemas.lock, req);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        if (row.pos.deployLock !== false) return;
        await installations.updateOne(
          { _id: id, "pos.deployLock": false },
          {
            $set: {
              "pos.deployLock": true,
              "pos.lockedAt": new Date(),
              "pos.lockedBy": person(req.staff),
            },
          },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.locked",
          "installations",
          id,
          row.pos.slug,
          req,
        );
      });
      res.json({ locked: true });
    },
  );

  router.post(
    "/installations/:id/pos/unlock",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(deploySchemas.unlock, req);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        typed(input.confirm, row.pos.slug);
        gate((await readiness(row, req.staff, session)).view, "unlock");
        if (row.pos.deployLock === false) return;
        await installations.updateOne(
          { _id: id, "pos.deployLock": { $ne: false } },
          {
            $set: {
              "pos.deployLock": false,
              "pos.unlockedAt": new Date(),
              "pos.unlockedBy": person(req.staff),
              "pos.localLockConfirmedAt": input.localLocked ? new Date() : null,
            },
          },
          { session },
        );
        await audit(
          db,
          session,
          req.staff,
          "pos.unlocked",
          "installations",
          id,
          `${row.pos.slug}${input.localLocked ? " local-lock-confirmed" : ""}`,
          req,
        );
      });
      res.json({ locked: false });
    },
  );

  // ---- tasks: verify, purge --------------------------------------------------
  const newTask = (kind, staff, now, params = null) => ({
    id: randomUUID(),
    kind,
    status: "queued",
    step: "queued",
    progress: null,
    lease: leaseless(),
    attempt: 0,
    by: person(staff),
    requestedAt: new Date(now),
    finishedAt: null,
    params,
    result: null,
    error: null,
  });
  async function claimTaskSlot(session, id, task, now, extra = {}) {
    const workerAt = await heartbeatAt(session);
    const done = await installations.updateOne(
      {
        _id: id,
        ...extra,
        ...freeSlot("pos.task", ACTIVE_TASK_STATES, now, workerAt),
      },
      { $set: { "pos.task": task } },
      { session },
    );
    if (done.matchedCount !== 1)
      throw busyError("Another task is already running for this installation.");
  }
  async function enqueueTask(
    req,
    res,
    { kind, action, gateName, permission, detail },
  ) {
    const id = iid(req);
    const task = await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, permission);
      const row = await loadRow(id, session);
      gate((await readiness(row, req.staff, session)).view, gateName);
      if (kind.startsWith("purge"))
        ensure(
          row.pos.deploy?.cutoverAt,
          409,
          "Purge is available after the first verified admin deploy.",
        );
      const now = Date.now();
      const next = newTask(kind, req.staff, now);
      await claimTaskSlot(session, id, next, now);
      await audit(
        db,
        session,
        req.staff,
        action,
        "installations",
        id,
        detail(next),
        req,
      );
      return next;
    });
    res.status(201).json({ task: taskView(task) });
  }
  router.post(
    "/installations/:id/pos/verify",
    auth.permit("credentials"),
    async (req, res) => {
      body(deploySchemas.empty, req);
      await consume(db, `verify:${iid(req)}`, 12, 3600000);
      await enqueueTask(req, res, {
        kind: "verify",
        permission: "credentials",
        action: "pos.verify.requested",
        gateName: "verify",
        detail: (t) => `#${t.id.slice(0, 8)}`,
      });
    },
  );
  router.post(
    "/installations/:id/pos/purge/preview",
    auth.permit("deploy"),
    async (req, res) => {
      body(deploySchemas.empty, req);
      await enqueueTask(req, res, {
        kind: "purge-preview",
        permission: "deploy",
        action: "pos.purge.previewed",
        gateName: "purge",
        detail: (t) => `#${t.id.slice(0, 8)}`,
      });
    },
  );
  router.post(
    "/installations/:id/pos/purge",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const id = iid(req);
      const input = body(deploySchemas.purge, req);
      const task = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await loadRow(id, session);
        typed(input.confirm, row.pos.slug);
        gate((await readiness(row, req.staff, session)).view, "purge");
        ensure(
          row.pos.deploy?.cutoverAt,
          409,
          "Purge is available after the first verified admin deploy.",
        );
        const preview = row.pos.task;
        const now = Date.now();
        ensure(
          preview?.kind === "purge-preview" &&
            preview.id === input.previewTaskId &&
            preview.status === "succeeded",
          409,
          "Run a new purge preview first.",
        );
        const finished = new Date(preview.finishedAt ?? 0).getTime();
        ensure(
          now - finished <= PURGE_WINDOW_MS,
          409,
          "The purge preview is older than 30 minutes. Run it again.",
        );
        // Exactly what the owner saw: the ids come from the stored preview and
        // must hash to the digest the panel was given.
        const ids = taskView(preview).result.candidates.map((x) => x.id);
        ensure(ids.length > 0, 409, "Nothing to purge.");
        ensure(
          purgeDigest(ids) === input.digest,
          409,
          "The purge preview changed. Review it again.",
        );
        const next = newTask("purge", req.staff, now, {
          ids,
          digest: input.digest,
          previewTaskId: input.previewTaskId,
        });
        await claimTaskSlot(session, id, next, now, {
          "pos.task.id": input.previewTaskId,
        });
        await audit(
          db,
          session,
          req.staff,
          "pos.purge.requested",
          "installations",
          id,
          `${ids.length} deployments #${next.id.slice(0, 8)}`,
          req,
        );
        return next;
      });
      res.status(201).json({ task: taskView(task) });
    },
  );

  // ---- prepare build -----------------------------------------------------------
  router.post(
    "/installations/:id/pos/builds",
    auth.permit("deploy"),
    async (req, res) => {
      const id = iid(req);
      const { branch, sha } = body(deploySchemas.build, req);
      const row = await loadRow(id);
      if (!cacheStore)
        throw conflict("cache-off", "Prepare build needs the build cache.");
      const early = await readiness(row, req.staff);
      gate(early.view, "build");
      await consume(db, `build:${req.staff._id}`, 10, 3600000);
      await verifySha(branch, sha);
      const built = await buildKeyFor(row.pos, early.worker);
      if (!built) {
        const error = new HttpError(503, "The builder is not readable.", true);
        error.apiCode = "builder-unavailable";
        throw error;
      }
      const hit = await cacheState(sha, built.key);
      if (hit.state === "cached")
        return res.json({
          build: { state: "cached", sha7: sha7(sha), key8: key8(built.key) },
        });
      let commit;
      try {
        commit = await gh.commit(sha);
      } catch (error) {
        throw failure(error);
      }
      const _id = buildRowId(sha, built.key);
      const now = new Date();
      const summary = (status, extra = {}) => ({
        build: {
          state: status,
          sha7: sha7(sha),
          key8: key8(built.key),
          ...extra,
        },
      });
      const fresh = () =>
        newBuildRow({
          _id,
          sha,
          buildKey: built.key,
          inputs: built.inputs,
          branch,
          commit: storedCommit(commit, sha, branch),
          waiters: [],
          prepared: { by: person(req.staff), at: now },
          now,
        });
      const logRequest = (session) =>
        audit(
          db,
          session,
          req.staff,
          "pos.build.requested",
          "installations",
          id,
          `${branch}@${sha7(sha)} ${key8(built.key)}`,
          req,
        );
      // A row that is already queued or running is joined: mark it as
      // prepared by the owner (so cancelling a deploy that created it does not
      // cancel this request) and report it.
      async function joinExisting() {
        const existing = await state.findOne({ _id });
        if (!existing) return null;
        // A rollout's marker (P3) is taken over too, so cancelling that
        // rollout no longer cancels this build.
        if (
          (!existing.prepared || existing.prepared.rollout) &&
          !["failed", "cancelled"].includes(existing.status)
        ) {
          const marked = await transaction(client, async (session) => {
            await authorizeWrite(db, session, req.staff, "deploy");
            const done = await state.updateOne(
              {
                _id,
                $or: [
                  { prepared: null },
                  { "prepared.rollout": { $exists: true } },
                ],
              },
              { $set: { prepared: { by: person(req.staff), at: now } } },
              { session },
            );
            if (done.matchedCount === 1) await logRequest(session);
            return done.matchedCount === 1;
          });
          void marked;
        }
        return summary(existing.status, { existing: true });
      }
      const current = await state.findOne({ _id });
      if (current && !["failed", "cancelled"].includes(current.status))
        return res.json(await joinExisting());
      try {
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "deploy");
          if (current) {
            // A failed or cancelled row must not block a retry: reset it.
            const reset = await state.replaceOne(
              { _id, status: current.status },
              fresh(),
              { session },
            );
            if (reset.matchedCount !== 1)
              throw busyError("This build changed. Try again.");
          } else await state.insertOne(fresh(), { session });
          await logRequest(session);
        });
      } catch (error) {
        if (error?.code !== 11000 && error?.apiCode !== "busy") throw error;
        // Single flight: another request created or changed the row first.
        const joined = await joinExisting();
        if (!joined) throw error;
        return res.json(joined);
      }
      res.status(201).json(summary("queued"));
    },
  );

  router.post(
    "/pos/build-cache/self-test",
    auth.permit("secrets"),
    async (req, res) => {
      body(deploySchemas.empty, req);
      if (!s3 || !cacheStore) {
        const error = new HttpError(
          503,
          "Build storage is not configured.",
          true,
        );
        error.apiCode = "not-configured";
        throw error;
      }
      await consume(db, `build-selftest:${req.staff._id}`, 10, 3600000);
      const key = `builds/_selftest/${randomUUID()}`,
        probe = Buffer.from(randomUUID());
      const flags = {
        put: false,
        conditional: false,
        list: false,
        get: false,
        del: false,
      };
      try {
        await s3.putBytes(key, probe, {
          ifNoneMatch: true,
          contentType: "application/octet-stream",
        });
        flags.put = true;
        try {
          await s3.putBytes(key, probe, {
            ifNoneMatch: true,
            contentType: "application/octet-stream",
          });
        } catch (error) {
          flags.conditional = isConflict(error);
        }
        flags.list = (await s3.list(key, 3)).keys.includes(key);
        flags.get = (await s3.getBytes(key, 1024)).equals(probe);
      } catch {
        // Reported through the flags; S3 detail is never exposed.
      }
      try {
        await s3.del(key);
        flags.del = true;
      } catch {
        // Reported through the flags.
      }
      const ok = Object.values(flags).every(Boolean);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "secrets");
        await audit(
          db,
          session,
          req.staff,
          "pos.build-cache.tested",
          "system",
          "build-cache",
          ok ? "ok" : "failed",
          req,
        );
      });
      res.json({ ok, ...flags, format: MANIFEST_FORMAT });
    },
  );

  // ---- global freeze -----------------------------------------------------------
  async function setFreeze(req, res, on) {
    const { reason } = body(deploySchemas.freeze, req);
    await transaction(client, async (session) => {
      await authorizeWrite(db, session, req.staff, "deploy");
      await state.updateOne(
        { _id: "pos-deploy-freeze" },
        {
          $set: {
            on,
            reason: on ? reason : "",
            by: person(req.staff),
            at: new Date(),
          },
        },
        { upsert: true, session },
      );
      await audit(
        db,
        session,
        req.staff,
        on ? "pos.frozen" : "pos.unfrozen",
        "system",
        "pos-deploy-freeze",
        on ? "deploys frozen" : "deploys unfrozen",
        req,
      );
    });
    res.json({ frozen: on });
  }
  router.post(
    "/pos/freeze",
    auth.permit("deploy"),
    auth.requireStepUp,
    (req, res) => setFreeze(req, res, true),
  );
  router.post(
    "/pos/unfreeze",
    auth.permit("deploy"),
    auth.requireStepUp,
    (req, res) => setFreeze(req, res, false),
  );

  // ---- fleet ---------------------------------------------------------------------
  router.get("/pos/fleet", auth.permit("credentials"), async (req, res) => {
    const { customerId, light } = deploySchemas.fleet.parse(req.query);
    // Polled every 15 s by up to three views (4/min each): sized for that.
    await consume(db, `fleet:${req.staff._id}`, 1200, 3600000);
    const worker = await workerRow();
    const freeze = await state.findOne({ _id: "pos-deploy-freeze" });
    const product = await db
      .collection("products")
      .findOne({ slug: "pos" }, { projection: { _id: 1 } });
    const rows = product
      ? await installations
          .find(
            {
              productId: product._id,
              pos: { $exists: true },
              ...(customerId ? { customerId } : {}),
            },
            {
              // Explicit fields only: the stored secret boxes are never read.
              projection: {
                customerId: 1,
                status: 1,
                "pos.slug": 1,
                "pos.host": 1,
                "pos.deployLock": 1,
                "pos.deploy": 1,
                "pos.verify": 1,
                "pos.image.store": 1,
                "pos.image.publicBaseUrl": 1,
                "pos.image.cloudName": 1,
                "pos.cloudflare.workerUrl": 1,
                // Usage summary (Phase 2): never `mail` or the check lease.
                "pos.usage.watch": 1,
                "pos.usage.check.status": 1,
                "pos.usage.check.requestedAt": 1,
                "pos.usage.check.finishedAt": 1,
                "pos.usage.last.at": 1,
                "pos.usage.last.level": 1,
                "pos.usage.last.site": 1,
                "pos.usage.last.mongo.maxPct": 1,
                "pos.usage.last.cloudflare": 1,
              },
            },
          )
          .sort({ "pos.slug": 1 })
          .limit(100)
          .maxTimeMS(4000)
          .toArray()
      : [];
    const names = new Map(
      (
        await db
          .collection("customers")
          .find(
            { _id: { $in: [...new Set(rows.map((r) => r.customerId))] } },
            { projection: { name: 1 } },
          )
          .toArray()
      ).map((customer) => [customer._id, customer.name]),
    );
    // One branch head per distinct live branch; one compare per distinct pair.
    const heads = new Map();
    const branchesNeeded = [
      ...new Set(rows.map((r) => r.pos.deploy?.last?.branch).filter(Boolean)),
    ];
    await Promise.all(
      (light ? [] : branchesNeeded).map(async (branch) => {
        try {
          heads.set(branch, await headOf(branch));
        } catch (error) {
          heads.set(
            branch,
            error instanceof ProviderError && error.code === "not-found"
              ? "gone"
              : null,
          );
        }
      }),
    );
    const now = Date.now();
    const out = await Promise.all(
      rows.map(async (row) => {
        const pos = row.pos,
          last = pos.deploy?.last,
          current = pos.deploy?.current;
        const head = last ? heads.get(last.branch) : undefined;
        let relation = "none",
          behindBy = null;
        if (last && light) relation = "unknown";
        else if (last && head === "gone") relation = "branch-gone";
        else if (last && head === null) relation = "unknown";
        else if (last && head) {
          try {
            const cmp =
              last.sha === head.sha
                ? { status: "identical", aheadBy: 0 }
                : await compareOf(last.sha, head.sha);
            relation =
              cmp.status === "identical"
                ? "current"
                : cmp.status === "ahead"
                  ? "behind"
                  : cmp.status === "behind"
                    ? "ahead"
                    : "diverged";
            behindBy = relation === "behind" ? cmp.aheadBy : 0;
          } catch {
            relation = "unknown";
          }
        }
        let cached = null;
        if (relation === "behind" && cacheStore) {
          const built = await buildKeyFor(pos, worker);
          if (built)
            cached = (await cacheState(head.sha, built.key)).state === "cached";
        }
        const verified = verifyStateOf(pos.verify, now) === "ok";
        // unhealthy = the site may be down; rolled-back = the site is fine.
        const status = jobBlocks(current, now, worker?.at ?? null)
          ? "deploying"
          : current?.status === "unhealthy"
            ? "unhealthy"
            : current?.status === "rolled-back"
              ? "rolled-back"
              : current && ["failed", "expired"].includes(current.status)
                ? "failed"
                : pos.deployLock !== false
                  ? "locked"
                  : !verified
                    ? "unverified"
                    : last
                      ? "live"
                      : "not-deployed";
        const live = versionView(last, now);
        return {
          installationId: row._id,
          customerId: row.customerId,
          customerName: names.get(row.customerId) ?? "",
          slug: pos.slug,
          host: pos.host ?? "",
          installationStatus: row.status,
          state: status,
          locked: pos.deployLock !== false,
          live: live
            ? {
                branch: live.branch,
                sha7: sha7(live.sha),
                at: live.at,
                status: live.status,
                ...liveCommit(last),
              }
            : null,
          head:
            head && head !== "gone"
              ? { sha7: sha7(head.sha), headline: head.headline }
              : null,
          relation,
          behindBy,
          branchGone: relation === "branch-gone",
          cached,
          usage: fleetUsageView(pos.usage, row.status),
        };
      }),
    );
    // From the heartbeat row read above and the rows already loaded (no extra
    // query): the panel stops fast polling for usage checks while nobody
    // would run them.
    const workerOnline = workerView(worker, now).online;
    res.json({
      rows: out,
      limited: rows.length === 100,
      freeze: freezeView(freeze),
      workerOnline,
      usageStalled: fleetUsageStalled(
        rows.map((row) => row.pos.usage),
        workerOnline,
        now,
      ),
    });
  });

  // ---- rollout (P3): "deploy this commit to all clients" -----------------------
  // One system_state row (shared/rollout.js, docs/P3-ROLLOUT.md). The worker
  // drives it one client at a time through the normal deploy job; the API
  // plans, starts, cancels, resumes, dismisses and reads it.
  const rolloutRow = (session) =>
    state.findOne({ _id: ROLLOUT_ROW_ID }, { session });
  // Whose authority the worker's deploys run under (re-checked per client).
  const authOf = (staff) => ({
    id: staff._id,
    name: staff.name,
    authVersion: staff.authVersion,
    role: staff.role,
  });
  // Readiness ids that block the whole rollout, plus "build-cache" when off.
  async function rolloutGate(staff, session) {
    const [worker, freeze] = await Promise.all([
      state.findOne({ _id: "pos-worker" }, { session }),
      state.findOne({ _id: "pos-deploy-freeze" }, { session }),
    ]);
    const view = readinessOf({
      now: Date.now(),
      worker,
      sources: {
        source: gh.configured().source,
        builder: worker?.builderConfigured === true,
      },
      cacheConfigured: Boolean(cacheStore),
      authenticator: Boolean(staff?.totp?.enabledAt),
      freeze,
    });
    const items = view.items
      .filter((i) => ROLLOUT_GATE.includes(i.id) && i.state === "blocked")
      .map((i) => i.id);
    return { worker, items: cacheStore ? items : [...items, "build-cache"] };
  }
  function refuseGate(gate) {
    if (gate.items.includes("build-cache"))
      throw conflict(
        "cache-off",
        "The build cache is off: a rollout needs it.",
      );
    if (gate.items.length)
      throw conflict("not-ready", "Deploys are not ready yet.", gate.items);
  }
  // Slugs of the clients with a deploy job that still blocks.
  async function activeDeploys(session) {
    const worker = await state.findOne(
      { _id: "pos-worker" },
      { session, projection: { at: 1 } },
    );
    const rows = await installations
      .find(
        { "pos.deploy.current.status": { $in: ACTIVE_STATES } },
        { session, projection: { "pos.slug": 1, "pos.deploy.current": 1 } },
      )
      .limit(MAX_TARGETS)
      .toArray();
    const now = Date.now();
    return rows
      .filter((r) => jobBlocks(r.pos.deploy.current, now, worker?.at ?? null))
      .map((r) => r.pos.slug);
  }
  function refuseBusy(slugs) {
    if (slugs.length)
      throw conflict(
        "busy",
        `A deploy is running for ${slugs.slice(0, 3).join(", ")}. Try again when it finishes.`,
      );
  }
  const busyRollout = () => conflict("busy", "A rollout is already running.");
  // Every POS client with its verdict for `sha`, targets in rollout order,
  // plus the clients with a deploy running now.
  async function rolloutCandidates(sha, session) {
    const product = await db
      .collection("products")
      .findOne({ slug: "pos" }, { session, projection: { _id: 1 } });
    const rows = product
      ? await installations
          .find(
            { productId: product._id, pos: { $exists: true } },
            { session, projection: TARGET_PROJECTION },
          )
          .sort({ "pos.slug": 1 })
          .limit(MAX_TARGETS + 1)
          .maxTimeMS(4000)
          .toArray()
      : [];
    const customers = new Map(
      (
        await db
          .collection("customers")
          .find(
            { _id: { $in: [...new Set(rows.map((r) => r.customerId))] } },
            { session, projection: { name: 1, status: 1 } },
          )
          .toArray()
      ).map((customer) => [customer._id, customer]),
    );
    const workerAt =
      (
        await state.findOne(
          { _id: "pos-worker" },
          { session, projection: { at: 1 } },
        )
      )?.at ?? null;
    const now = Date.now();
    const targets = [],
      excluded = [],
      busy = [];
    for (const row of rows.slice(0, MAX_TARGETS)) {
      const customer = customers.get(row.customerId);
      const facts = targetFacts(row, customer, inputsOkOf(row.pos), now);
      const pos = facts.pos;
      const entry = {
        pos,
        installationId: row._id,
        slug: pos.slug,
        customerName: cleanText(customer?.name, 120),
      };
      if (jobBlocks(pos.deploy?.current, now, workerAt)) busy.push(pos.slug);
      const verdict = classifyTarget(facts, sha);
      if (verdict.kind === "target") targets.push(entry);
      else
        excluded.push({ ...entry, code: verdict.code, items: verdict.items });
    }
    return {
      targets: orderTargets(targets),
      excluded,
      busy,
      limited: rows.length > MAX_TARGETS,
    };
  }

  // The view with each waiting client's pre-build read from its build row.
  async function viewOf(row, session) {
    const ids = row
      ? [
          ...new Set(
            (row.targets ?? [])
              .filter(
                (t) => ["queued", "joined"].includes(t.prebuild) && t.buildKey,
              )
              .map((t) => buildRowId(row.sha, t.buildKey)),
          ),
        ]
      : [];
    const builds = new Map(
      ids.length
        ? (
            await state
              .find(
                { _id: { $in: ids } },
                { session, projection: { status: 1 } },
              )
              .toArray()
          ).map((b) => [b._id, b])
        : [],
    );
    return rolloutView(row, builds);
  }
  // A short audit detail: the branch is capped so "#id8" always fits in 200.
  const rolloutRef = (row) =>
    `${String(row.branch).slice(0, 80)}@${sha7(row.sha)}`;

  router.get("/pos/rollout", auth.permit("credentials"), async (req, res) => {
    const [row, worker, freeze] = await Promise.all([
      rolloutRow(),
      workerRow(),
      state.findOne({ _id: "pos-deploy-freeze" }),
    ]);
    const frozen = freezeView(freeze);
    res.json({
      rollout: await viewOf(row),
      freeze: { on: frozen.on, reason: frozen.reason },
      workerOnline: workerView(worker).online,
    });
  });

  router.get(
    "/pos/rollout/plan",
    auth.permit("credentials"),
    async (req, res) => {
      const { branch } = deploySchemas.rolloutPlan.parse(req.query);
      await consume(db, `rollout-plan:${req.staff._id}`, 120, 3600000);
      let head;
      try {
        head = await headOf(branch);
      } catch (error) {
        if (error instanceof ProviderError && error.code === "not-found")
          throw conflict(
            "sha-not-on-branch",
            "That branch no longer exists. Reload the branch list.",
          );
        throw failure(error);
      }
      const commit = await remember(`commit:${head.sha}`, () =>
        gh.commit(head.sha),
      ).catch(() => null);
      const [gate, found, row] = await Promise.all([
        rolloutGate(req.staff),
        rolloutCandidates(head.sha),
        rolloutRow(),
      ]);
      const targets = await Promise.all(
        found.targets.map(async (t) => {
          const last = t.pos.deploy?.last;
          let relation = null;
          if (isSha(last?.sha))
            try {
              // behind: the live commit is newer (the rollout moves it back);
              // diverged: the live commit is not on this branch.
              relation = (await compareOf(last.sha, head.sha)).status;
            } catch {
              relation = null;
            }
          const built = await buildKeyFor(t.pos, gate.worker);
          const cache = await cacheState(head.sha, built?.key);
          return {
            installationId: t.installationId,
            slug: t.slug,
            customerName: t.customerName,
            live: last
              ? {
                  branch: isBranch(last.branch) ? last.branch : "",
                  sha7: sha7(last.sha),
                }
              : null,
            older: relation === "behind",
            diverged: relation === "diverged",
            // Live on this very commit but it failed its health check.
            unhealthy: last?.sha === head.sha && last?.healthy === false,
            cached:
              cache.state === "cached"
                ? true
                : cache.state === "will-build"
                  ? false
                  : null,
          };
        }),
      );
      res.json({
        branch,
        head: {
          sha: head.sha,
          sha7: sha7(head.sha),
          headline: head.headline,
          authorName: cleanText(commit?.authorName, 100),
          date: head.date,
        },
        targets,
        excluded: found.excluded.map((e) => ({
          installationId: e.installationId,
          slug: e.slug,
          customerName: e.customerName,
          code: e.code,
          ...(e.items ? { items: e.items } : {}),
        })),
        blocked: gate.items,
        busy: found.busy,
        active: ROLLOUT_ACTIVE.includes(row?.status),
        limited: found.limited,
        digest: rolloutDigest(
          head.sha,
          found.targets.map((t) => t.installationId),
        ),
      });
    },
  );

  router.post(
    "/pos/rollout",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const input = body(deploySchemas.rolloutStart, req);
      ensure(
        input.confirm === ROLLOUT_CONFIRM,
        400,
        "Type deploy all to confirm.",
      );
      refuseGate(await rolloutGate(req.staff));
      if (ROLLOUT_ACTIVE.includes((await rolloutRow())?.status))
        throw busyRollout();
      refuseBusy(await activeDeploys());
      await consume(db, `rollout:${req.staff._id}`, 10, 3600000);
      await verifySha(input.branch, input.sha);
      const found = await rolloutCandidates(input.sha);
      ensure(
        !found.limited,
        409,
        "More than 100 POS clients: a rollout covers at most 100.",
      );
      if (!found.targets.length)
        throw conflict("no-targets", "No client needs this commit.");
      if (
        rolloutDigest(
          input.sha,
          found.targets.map((t) => t.installationId),
        ) !== input.digest
      )
        throw conflict(
          "targets-changed",
          "The list of clients changed. Preview again.",
        );
      let commit = null;
      try {
        commit = storedCommit(
          await gh.commit(input.sha),
          input.sha,
          input.branch,
        );
      } catch {
        commit = null;
      }
      const doc = {
        _id: ROLLOUT_ROW_ID,
        id: randomUUID(),
        status: "running",
        branch: input.branch,
        sha: input.sha,
        commit,
        by: person(req.staff),
        auth: authOf(req.staff),
        resumed: null,
        startedAt: new Date(),
        finishedAt: null,
        stopOnFailure: true,
        cancelRequested: false,
        stop: null,
        prepared: false,
        lease: leaseless(),
        targets: found.targets.map((t) =>
          newRolloutTarget(t.installationId, t.slug),
        ),
      };
      try {
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "deploy");
          refuseGate(await rolloutGate(req.staff, session));
          refuseBusy(await activeDeploys(session));
          const existing = await rolloutRow(session);
          if (ROLLOUT_ACTIVE.includes(existing?.status)) throw busyRollout();
          if (existing) {
            const done = await state.replaceOne(
              { _id: ROLLOUT_ROW_ID, id: existing.id, status: existing.status },
              doc,
              { session },
            );
            if (done.matchedCount !== 1) throw busyRollout();
            await releasePrebuilds(state, existing.id, new Date(), {
              session,
            });
          } else await state.insertOne(doc, { session });
          await audit(
            db,
            session,
            req.staff,
            "pos.rollout.started",
            "system",
            ROLLOUT_ROW_ID,
            `${rolloutRef(doc)} ${doc.targets.length} clients #${doc.id.slice(0, 8)}`,
            req,
          );
        });
      } catch (error) {
        // Two starts at once: the second insert of the one row loses.
        if (error?.code === 11000) throw busyRollout();
        throw error;
      }
      res.status(201).json({ rollout: rolloutView(doc) });
    },
  );

  router.post(
    "/pos/rollout/cancel",
    auth.permit("deploy"),
    async (req, res) => {
      const { id } = body(deploySchemas.rollout, req);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await rolloutRow(session);
        ensure(row?.id === id, 404, "No such rollout.");
        if (row.status === "cancelling") return viewOf(row, session);
        ensure(
          row.status === "running",
          409,
          "This rollout has already finished.",
        );
        const done = await state.updateOne(
          { _id: ROLLOUT_ROW_ID, id, status: "running" },
          { $set: { status: "cancelling", cancelRequested: true } },
          { session },
        );
        if (done.matchedCount !== 1)
          throw staleError("The rollout changed. Reload and try again.");
        // The client in flight: cancelled exactly like the per-client Cancel
        // (queued at once, running before upload); after upload it finishes.
        const flight = (row.targets ?? []).find(
          (t) => ["building", "deploying"].includes(t.status) && t.requestId,
        );
        const inst = flight
          ? await installations.findOne(
              { _id: flight.installationId },
              { session, projection: { "pos.deploy.current": 1 } },
            )
          : null;
        const job = inst?.pos?.deploy?.current;
        const fields =
          job?.requestId === flight?.requestId &&
          ["queued", "running"].includes(job?.status)
            ? cancelFields(job, Date.now())
            : null;
        if (fields) {
          const cancelled = await installations.updateOne(
            {
              _id: flight.installationId,
              "pos.deploy.current.requestId": job.requestId,
              "pos.deploy.current.status": job.status,
              "pos.deploy.current.step": job.step,
            },
            { $set: prefixed("pos.deploy.current", fields) },
            { session },
          );
          if (cancelled.matchedCount === 1)
            await audit(
              db,
              session,
              req.staff,
              "pos.deploy.cancel-requested",
              "installations",
              flight.installationId,
              `${rolloutRef(job)} #${job.requestId.slice(0, 8)} rollout #${id.slice(0, 8)}`,
              req,
            );
        }
        await audit(
          db,
          session,
          req.staff,
          "pos.rollout.cancel-requested",
          "system",
          ROLLOUT_ROW_ID,
          `${rolloutRef(row)} #${id.slice(0, 8)}`,
          req,
        );
        return viewOf(await rolloutRow(session), session);
      });
      res.json({ rollout: view });
    },
  );

  router.post(
    "/pos/rollout/resume",
    auth.permit("deploy"),
    auth.requireStepUp,
    async (req, res) => {
      const { id } = body(deploySchemas.rollout, req);
      const row = await rolloutRow();
      ensure(row?.id === id, 404, "No such rollout.");
      ensure(
        row.status === "stopped",
        409,
        "Only a stopped rollout can be resumed.",
      );
      refuseGate(await rolloutGate(req.staff));
      refuseBusy(await activeDeploys());
      await consume(db, `rollout:${req.staff._id}`, 10, 3600000);
      await verifySha(row.branch, row.sha);
      const view = await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        refuseGate(await rolloutGate(req.staff, session));
        const fresh = await rolloutRow(session);
        if (fresh?.id !== id || fresh.status !== "stopped")
          throw staleError("The rollout changed. Reload and try again.");
        // The client it stopped at and every client not reached get their
        // turn again; succeeded clients and deliberate skips stay.
        const targets = resumeTargets(fresh.targets);
        const done = await state.updateOne(
          { _id: ROLLOUT_ROW_ID, id, status: "stopped" },
          {
            $set: {
              status: "running",
              targets,
              stop: null,
              cancelRequested: false,
              finishedAt: null,
              prepared: false,
              resumed: { by: person(req.staff), at: new Date() },
              auth: authOf(req.staff),
            },
          },
          { session },
        );
        if (done.matchedCount !== 1)
          throw staleError("The rollout changed. Reload and try again.");
        await audit(
          db,
          session,
          req.staff,
          "pos.rollout.resumed",
          "system",
          ROLLOUT_ROW_ID,
          `${rolloutRef(fresh)} #${id.slice(0, 8)}`,
          req,
        );
        return viewOf(await rolloutRow(session), session);
      });
      res.json({ rollout: view });
    },
  );

  router.post(
    "/pos/rollout/dismiss",
    auth.permit("deploy"),
    async (req, res) => {
      const { id } = body(deploySchemas.rollout, req);
      await transaction(client, async (session) => {
        await authorizeWrite(db, session, req.staff, "deploy");
        const row = await rolloutRow(session);
        ensure(row?.id === id, 404, "No such rollout.");
        ensure(
          ROLLOUT_FINISHED.includes(row.status) || row.status === "cancelling",
          409,
          "A running rollout cannot be dismissed. Cancel it first.",
        );
        if (row.status === "cancelling") {
          // Escape hatch when the worker cannot end a cancelled rollout: only
          // once its client in flight has no deploy job still running.
          const flight = (row.targets ?? []).find(
            (t) => ["building", "deploying"].includes(t.status) && t.requestId,
          );
          const job = flight
            ? (
                await installations.findOne(
                  { _id: flight.installationId },
                  { session, projection: { "pos.deploy.current": 1 } },
                )
              )?.pos?.deploy?.current
            : null;
          if (
            job?.requestId === flight?.requestId &&
            jobBlocks(job, Date.now(), await heartbeatAt(session))
          )
            throw conflict(
              "busy",
              "A client of this rollout is still deploying. Try again when it finishes.",
            );
        }
        const gone = await state.deleteOne(
          { _id: ROLLOUT_ROW_ID, id, status: row.status },
          { session },
        );
        if (gone.deletedCount !== 1)
          throw staleError("The rollout changed. Reload and try again.");
        await releasePrebuilds(state, id, new Date(), { session });
        await audit(
          db,
          session,
          req.staff,
          "pos.rollout.dismissed",
          "system",
          ROLLOUT_ROW_ID,
          `${rolloutRef(row)} ${row.status} #${id.slice(0, 8)}`,
          req,
        );
      });
      res.json({ ok: true });
    },
  );
  return router;
}
// Headline, author name and date of the live commit, cleaned (never an e-mail).
const liveCommit = (last) => {
  const c = storedCommit(last?.commit ?? {}, last?.sha, last?.branch);
  return {
    headline: c?.headline ?? "",
    authorName: c?.authorName ?? "",
    date: c?.date ?? null,
  };
};
