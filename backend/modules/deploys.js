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
  CANCELLABLE_STEPS,
  DEAD_LEASE_MS,
  JOB_STEPS,
  PURGE_WINDOW_MS,
  QUEUED_EXPIRY_MS,
  TERMINAL_STATES,
  blockedFor,
  buildRowId,
  isActiveState,
  jobBlocks,
  readinessOf,
  sha7,
  verifyStateOf,
} from "../../shared/deploy.js";
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
  parseBuilderJson,
} from "../lib/build-inputs.js";
import { isConflict } from "../lib/s3.js";
import {
  cutoverView,
  deployView,
  jobView,
  key8,
  purgeDigest,
  taskView,
  verifyView,
  versionView,
  workerView,
} from "../lib/deploy-view.js";
import { busyError } from "./pos.js";

export { deployView };
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
const person = (staff) => ({ id: staff._id, name: staff.name });
const stepsFor = (kind) =>
  JOB_STEPS[kind === "rollback" ? "rollback" : "deploy"].map((name) => ({
    name,
    state: "pending",
    startedAt: null,
    endedAt: null,
    note: "",
  }));
const leaseless = () => ({ owner: null, until: null, fence: 0 });
// A slot is free when empty, finished, expired while queued, or its lease has
// been dead for DEAD_LEASE_MS (mirrors jobBlocks in shared/deploy.js).
const freeSlot = (path, active, now) => ({
  $or: [
    { [path]: null },
    { [`${path}.status`]: { $nin: active } },
    {
      [`${path}.status`]: "queued",
      [`${path}.requestedAt`]: { $lt: new Date(now - QUEUED_EXPIRY_MS) },
    },
    {
      [`${path}.status`]: { $in: active.filter((s) => s !== "queued") },
      [`${path}.lease.until`]: { $lt: new Date(now - DEAD_LEASE_MS) },
    },
  ],
});

export function deployRoutes({ db, client, c, auth, s3, github, buildCache }) {
  const router = Router(),
    installations = db.collection("installations"),
    state = db.collection("system_state");
  const gh =
    github ??
    createGitHub({
      sourceRepo: c.POS_GITHUB_SOURCE_REPO,
      sourceToken: c.POS_GITHUB_SOURCE_TOKEN,
      builderRepo: c.POS_GITHUB_BUILDER_REPO,
      builderToken: c.POS_GITHUB_BUILDER_TOKEN,
      workflow: c.POS_BUILDER_WORKFLOW,
      ref: c.POS_BUILDER_REF,
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
        sources: gh.configured(),
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
  async function builderInfo() {
    return remember("builder", async () => {
      const head = await gh.builderHead();
      return {
        sha: head.sha,
        builder: parseBuilderJson(await gh.builderFile(head.sha)),
      };
    });
  }
  // {key, inputs} or null when the builder descriptor cannot be read yet.
  async function buildKeyFor(pos) {
    try {
      const info = await builderInfo();
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
        freeze: {
          on: freeze?.on === true,
          reason: freeze?.on ? String(freeze.reason ?? "").slice(0, 200) : "",
          at: freeze?.on ? (freeze.at ?? null) : null,
        },
        locked: pos.deployLock !== false,
        verifyState: verifyStateOf(pos.verify),
        verify: verifyView(pos.verify),
        task: taskView(pos.task),
        cutoverAt: cutoverView(pos.deploy),
        ...deployView(pos.deploy),
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
    const key = row ? (await buildKeyFor(row.pos))?.key : null;
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
      const built = await buildKeyFor(row.pos);
      const cache = await cacheState(head.sha, built?.key);
      const worker = await state.findOne({ _id: "pos-worker" });
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
  async function claimDeploySlot(session, row, job, now) {
    const done = await installations.updateOne(
      {
        _id: row._id,
        "pos.rev": row.pos.rev,
        "pos.deployLock": false,
        ...freeSlot("pos.deploy.current", ACTIVE_STATES, now),
      },
      { $set: { "pos.deploy.current": job } },
      { session },
    );
    if (done.matchedCount !== 1) {
      const now2 = await installations.findOne(
        { _id: row._id },
        { session, projection: { pos: 1 } },
      );
      if (jobBlocks(now2?.pos?.deploy?.current))
        throw busyError("A deploy is already running for this installation.");
      throw staleError("POS settings changed. Reload and try again.");
    }
  }
  const newJob = ({ kind, branch, sha, buildKey, staff, now, target }) => ({
    kind,
    requestId: randomUUID(),
    branch,
    sha,
    buildKey: buildKey ?? null,
    by: person(staff),
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
      let branch = input.branch,
        sha = input.sha;
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
      }
      const early = await readiness(row, req.staff);
      gate(early.view, "deploy");
      if (jobBlocks(pos.deploy?.current))
        throw busyError("A deploy is already running for this installation.");
      await consume(db, `deploy:${id}`, 30, 3600000);
      // Never accept an arbitrary sha: re-resolve the branch and check it.
      if (!redeploy) await verifySha(branch, sha);
      const built = await buildKeyFor(pos);
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
          staff: req.staff,
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
      ensure(
        pos.deploy?.last &&
          previous?.vercelDeploymentId &&
          /^[0-9a-f]{40}$/.test(previous.sha ?? ""),
        409,
        "There is no previous version to roll back to.",
      );
      gate((await readiness(row, req.staff)).view, "rollback");
      if (jobBlocks(pos.deploy?.current))
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
          branch: target.branch,
          sha: target.sha,
          buildKey: target.build?.buildKey,
          staff: req.staff,
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
          `${target.branch}@${sha7(target.sha)} #${next.requestId.slice(0, 8)}`,
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
        if (job.status === "cancelling") return jobView(job);
        ensure(
          isActiveState(job.status),
          409,
          "This deploy has already finished.",
        );
        let set;
        if (job.status === "queued")
          set = {
            "pos.deploy.current.status": "cancelled",
            "pos.deploy.current.cancelRequested": true,
            "pos.deploy.current.finishedAt": new Date(),
          };
        else {
          if (!CANCELLABLE_STEPS.includes(job.step)) {
            const error = new HttpError(409, "Too late to cancel.");
            error.apiCode = "too-late";
            throw error;
          }
          set = {
            "pos.deploy.current.status": "cancelling",
            "pos.deploy.current.cancelRequested": true,
          };
        }
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
          { _id: id, "pos.deployLock": true },
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
    const done = await installations.updateOne(
      {
        _id: id,
        ...extra,
        ...freeSlot("pos.task", ACTIVE_TASK_STATES, now),
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
      gate((await readiness(row, req.staff)).view, "build");
      await consume(db, `build:${req.staff._id}`, 10, 3600000);
      await verifySha(branch, sha);
      const built = await buildKeyFor(row.pos);
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
      try {
        await transaction(client, async (session) => {
          await authorizeWrite(db, session, req.staff, "deploy");
          await state.insertOne(
            {
              _id,
              kind: "build",
              status: "queued",
              sha,
              buildKey: built.key,
              inputs: built.inputs,
              branch,
              commit: {
                sha,
                branch,
                headline: commit.headline,
                authorName: commit.authorName,
                date: commit.date,
              },
              lease: leaseless(),
              attempt: 0,
              runId: null,
              runUrl: null,
              artifactId: null,
              waiters: [],
              prepared: { by: person(req.staff), at: now },
              error: null,
              createdAt: now,
              finishedAt: null,
            },
            { session },
          );
          await audit(
            db,
            session,
            req.staff,
            "pos.build.requested",
            "installations",
            id,
            `${branch}@${sha7(sha)} ${key8(built.key)}`,
            req,
          );
        });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        // Single flight: this build is already queued or running.
        const existing = await state.findOne({ _id });
        return res.json({
          build: {
            state: existing?.status ?? "queued",
            sha7: sha7(sha),
            key8: key8(built.key),
            existing: true,
          },
        });
      }
      res.status(201).json({
        build: { state: "queued", sha7: sha7(sha), key8: key8(built.key) },
      });
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
    const { customerId } = deploySchemas.fleet.parse(req.query);
    await consume(db, `fleet:${req.staff._id}`, 240, 3600000);
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
      branchesNeeded.map(async (branch) => {
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
        if (last && head === "gone") relation = "branch-gone";
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
          const built = await buildKeyFor(pos);
          if (built)
            cached = (await cacheState(head.sha, built.key)).state === "cached";
        }
        const verified = verifyStateOf(pos.verify, now) === "ok";
        const bad = ["failed", "unhealthy", "rolled-back", "expired"];
        const status = jobBlocks(current, now)
          ? "deploying"
          : current && bad.includes(current.status)
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
        };
      }),
    );
    res.json({ rows: out, limited: rows.length === 100 });
  });
  return router;
}
