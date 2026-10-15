// The go-live worker of a NEW POS client (P5 Stage 3, D41-D47; plan §3, §6).
// One run executes the steps of its action (shared/golive.js
// GOLIVE_RUN_STEPS) under the lease of installations.pos.golive and ENDS in
// `waiting` (the owner adds the DNS records, or presses Unlock and deploy),
// `live`, `failed` or `cancelled`; nothing holds a lease while waiting. The
// first deploy is the normal deploy job (Unlock and deploy enqueues it); the
// loop observes it here (`observeGolive`) and queues the `finish` step.
//
// Every step is idempotent: it checks before it creates and saves what it
// learned right after learning it, so a killed worker's successor continues
// without a second project, domain, Worker upload, admin login or env write.
// Every write is fenced on the lease; writes to the POS block are also
// guarded by the run's pos.rev (a stale rev ends the run: golive-stale), and
// config writes bump it and clear pos.verify as the API does. Stored notes,
// errors and audit details carry ids, step names and codes only: no token,
// URI, key, password, env value or provider text.
import { createHash } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { audit } from "../lib/audit.js";
import { encrypt } from "../lib/crypto.js";
import { BUILD_SETTINGS } from "../lib/build-inputs.js";
import { key8 } from "../lib/deploy-view.js";
import { ProviderError } from "../lib/provider-http.js";
import { AdminSeedError } from "../lib/pos-admin-seed.js";
import {
  buildEnv,
  envClientOf,
  envDrift,
  envFingerprints,
  envFp,
  mintPosAdminPassword,
  mintSecrets,
  realtimeEnvOf,
  realtimeOffEnv,
} from "../lib/golive-env.js";
import {
  JOIN_PROBE_STATUS,
  PROBE_ATTEMPTS,
  PROBE_INTERVAL_MS,
  PUBLISH_DEFINITIVE_STATUSES,
  PUBLISH_PROBE_ATTEMPTS,
  PUBLISH_PROBE_INTERVAL_MS,
  publishVerdict,
  realtimeNeedsDeploy,
  signedPublishRequest,
  subdomainCandidate,
  uploadMetadataOf,
  validateCloudflare,
  workerNameOf,
} from "../lib/realtime.js";
import { transaction } from "../db.js";
import {
  ACTIVE_STATES,
  MAX_ATTEMPTS,
  verifyStateOf,
} from "../../shared/deploy.js";
import {
  describeCode,
  isKnownCode,
  providerFlag,
} from "../../shared/deploy-errors.js";
import {
  GOLIVE_LIMITS,
  GOLIVE_RUN_STEPS,
  GOLIVE_STEPS,
} from "../../shared/golive.js";
import {
  PLATFORM_APEX,
  addressStateOf,
  labelProblem,
  webAddressRecords,
} from "../../shared/web-address.js";
import { dirs } from "./fetch-build.js";
import {
  JobFail,
  LeaseLost,
  ensureLive,
  failMessage,
  wait,
  withLease,
} from "./lease.js";
import { fetchRealtimeBundle } from "./realtime-bundle.js";
import {
  VERIFY_STEPS,
  WORKER_ACTOR,
  loadTarget,
  openSecret,
  productionOf,
  verifyChecks,
  verifyRecord,
} from "./verify.js";

const VERCEL_APP = ".vercel.app";
// Vercel adapter codes that are already go-live codes (shared/deploy-errors.js).
const GOLIVE_PROVIDER_CODES = new Set([
  "project-name-taken",
  "domain-taken",
  "env-upsert-failed",
]);
const known = (code) => (isKnownCode(String(code)) ? String(code) : "internal");
const clip = (text, max = GOLIVE_LIMITS.note) =>
  String(text ?? "").slice(0, max);
const bare = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/\.+$/, "");
const aadOf = (installationId, field) => `pos:${installationId}:${field}`;
const changedKey = (field) => field.replace(".", "_");
// A step failure with a fixed message from the code table (never provider text).
const stop = (code, step, status = "failed") => {
  const safe = known(code);
  return new JobFail(safe, describeCode(safe).plainMessage, { step, status });
};

// ---- the running go-live ---------------------------------------------------------
export class GoliveRun {
  constructor(ctx, claim, signal) {
    this.ctx = ctx;
    this.claim = claim;
    this.slot = claim.slot;
    this.id = claim.installationId;
    this.g = claim.doc;
    this.signal = signal;
    // The POS revision this run writes against (read at its first checkpoint).
    this.rev = null;
    this.target = null;
    this.pos = null;
    this.vercel = null;
    // {url, secret} once this run proved the Worker; false = realtime off.
    this.realtime = null;
  }
  get id8() {
    return String(this.g.requestId ?? "").slice(0, 8);
  }
  now() {
    return new Date(this.ctx.now());
  }
  idx(name) {
    return (this.g.steps ?? []).findIndex((s) => s?.name === name);
  }
  isDone(name) {
    const state = this.g.steps?.[this.idx(name)]?.state;
    return state === "done" || state === "skipped";
  }
  // Mirrors a fenced $set (paths relative to pos.golive) into the local copy.
  mirror(fields) {
    for (const [key, value] of Object.entries(fields)) {
      const parts = key.split(".");
      let target = this.g;
      for (const part of parts.slice(0, -1)) {
        if (target[part] === null || typeof target[part] !== "object")
          target[part] = {};
        target = target[part];
      }
      target[parts.at(-1)] = value;
    }
  }
  async patch(fields) {
    await this.slot.mustSet(fields);
    this.mirror(fields);
  }
  stepFields(name, fields) {
    const i = this.idx(name);
    if (i < 0) return {};
    return Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        `steps.${i}.${key}`,
        value,
      ]),
    );
  }
  async begin(name, note = "") {
    await this.patch({
      step: name,
      ...this.stepFields(name, {
        state: "running",
        startedAt: this.now(),
        endedAt: null,
        note: clip(note),
      }),
    });
  }
  async end(name, state = "done", note) {
    await this.patch(
      this.stepFields(name, {
        state,
        endedAt: this.now(),
        ...(note === undefined ? {} : { note: clip(note) }),
      }),
    );
  }
  async warn(code) {
    const list = Array.isArray(this.g.warnings) ? this.g.warnings : [];
    if (list.includes(code) || list.length >= GOLIVE_LIMITS.warnings) return;
    await this.patch({ warnings: [...list, known(code)] });
  }
  // A write that also touches the POS block, with its audit rows, in one
  // transaction: fenced, guarded by this run's pos.rev, bumping it for config.
  async commit({
    pos = {},
    golive = {},
    bump = false,
    clearVerify = false,
    audits = [],
  }) {
    const { ctx } = this;
    const set = { ...this.slot.prefixed(golive), ...pos };
    if (clearVerify) set["pos.verify"] = null;
    const update = { $set: set, ...(bump ? { $inc: { "pos.rev": 1 } } : {}) };
    const ok = await transaction(ctx.client, async (session) => {
      const done = await ctx.coll.installations.updateOne(
        { ...this.slot.filterOf(), "pos.rev": this.rev },
        update,
        { session },
      );
      if (done.matchedCount !== 1) return false;
      for (const [action, detail] of audits)
        await audit(
          ctx.db,
          session,
          WORKER_ACTOR,
          action,
          "installations",
          this.id,
          detail,
        );
      return true;
    });
    if (!ok) await this.missed();
    if (bump) this.rev += 1;
    this.mirror(golive);
  }
  // Why a guarded write missed: the lease is gone, or the settings changed.
  async missed() {
    const row = await this.ctx.coll.installations.findOne(
      { _id: this.id },
      { projection: { "pos.golive": 1 } },
    );
    if (!this.slot.mine(row?.pos?.golive)) throw new LeaseLost();
    throw stop("golive-stale", this.g.step);
  }
  // Between steps: lease still ours, no cancel asked, settings unchanged.
  async checkpoint() {
    ensureLive(this.signal);
    const row = await this.ctx.coll.installations.findOne(
      { _id: this.id },
      { projection: { "pos.rev": 1, "pos.golive": 1 } },
    );
    const current = row?.pos?.golive;
    if (!this.slot.mine(current)) throw new LeaseLost();
    this.g = current;
    if (current.cancelRequested)
      throw stop("golive-cancelled", null, "cancelled");
    if (this.rev === null) this.rev = row.pos.rev;
    else if (row.pos.rev !== this.rev) throw stop("golive-stale", null);
  }
  // A fresh POS block and the Vercel adapter (the token is decrypted in this
  // process only).
  async load() {
    const target = await loadTarget(this.ctx, this.id, { needToken: false });
    const token = openSecret(this.ctx, this.id, target.pos, "vercel.token");
    if (!token) throw stop("inputs-missing", this.g.step);
    this.target = { ...target, token };
    this.pos = target.pos;
    this.vercel = this.ctx.vercelFor({ token, teamId: target.teamId });
    return this.target;
  }
  secret(field) {
    return openSecret(this.ctx, this.id, this.pos, field);
  }
  box(field, value) {
    return encrypt(value, this.ctx.c.VAULT_KEY, aadOf(this.id, field));
  }
  // The go-live's own first deploy is what production serves (a re-run
  // after it went live must not refuse its own project).
  ownDeployLive() {
    const last = this.pos?.deploy?.last;
    return Boolean(
      this.g.deployRequestId && last?.requestId === this.g.deployRequestId,
    );
  }
  // The run ends here and gives its lease up (the fence value stays).
  leaseOff() {
    return { "lease.owner": null, "lease.until": null, heartbeatAt: null };
  }
  async waitFor(waitingFor, stepName, note) {
    await this.patch({
      status: "waiting",
      waitingFor,
      step: stepName,
      endedAt: this.now(),
      ...this.leaseOff(),
      ...(note === undefined
        ? {}
        : this.stepFields(stepName, { state: "pending", note: clip(note) })),
    });
  }
}

// ---- steps -------------------------------------------------------------------------
// check: inputs complete, Vercel user, Mongo ping, Cloudflare access, label
// rules and the authoritative "no foreign record" lookup (D44).
async function checkStep(run) {
  const { ctx, signal } = run;
  await run.begin("check");
  const { pos } = await run.load();
  const { label, host } = run.g.address ?? {};
  const problem = labelProblem(label);
  if (problem) throw stop(problem, "check");
  if (
    !pos.slug ||
    pos.subdomain !== label ||
    pos.host !== host ||
    pos.tenantId !== label ||
    pos.rootDomain !== PLATFORM_APEX
  )
    throw stop("inputs-missing", "check");
  // The POS admin password is optional here: the secrets step mints it.
  const uri = run.secret("mongo.uri");
  if (!uri || !pos.posAdmin?.username) throw stop("inputs-missing", "check");
  try {
    envClientOf(pos, { mongoUri: uri, imageKeys: run.secret("image.keys") });
  } catch {
    throw stop("inputs-missing", "check");
  }
  const cfToken = pos.cloudflare ? run.secret("cloudflare.token") : null;
  if (cfToken) {
    if (
      validateCloudflare({
        token: cfToken,
        accountId: pos.cloudflare.accountId ?? "",
      }).length
    )
      throw stop("inputs-missing", "check");
    try {
      workerNameOf(pos.slug);
    } catch {
      throw stop("realtime-name", "check");
    }
  }
  await run.vercel.user({ signal });
  const mongo = await ctx.pingMongo(uri);
  if (mongo !== "ok") throw stop(mongo, "check");
  if (cfToken) {
    // A token that verifies "active" can still reach no account (spike S2):
    // access is proven with an account call.
    const access = await ctx
      .cloudflareFor(cfToken)
      .tokenAccess(pos.cloudflare.accountId ?? "", { signal });
    if (!access.ok)
      throw stop(`cloudflare-${providerFlag(access.code)}`, "check");
    if (!pos.cloudflare.accountId && access.accountIds.length !== 1)
      throw stop(
        access.accountIds.length ? "cf-account-ambiguous" : "cloudflare-denied",
        "check",
      );
  }
  let seen;
  try {
    seen = await ctx.dnsCheck.lookupLabel({ apex: PLATFORM_APEX, host });
  } catch {
    // An unknown answer is never read as "free".
    throw stop("dns-unreachable", "check");
  }
  if (seen.inUse) {
    const ours = (run.g.address?.records ?? []).find(
      (r) => r?.type === "CNAME",
    )?.value;
    if (!seen.cname || !ours || bare(seen.cname) !== bare(ours))
      throw stop("label-in-use-dns", "check");
  }
  await run.end(
    "check",
    "done",
    seen.inUse ? "Label points to this project" : "Label free",
  );
}

// project: recorded id -> by name -> create (+ settings); never a project
// that already serves production (D42), unless it is this go-live's own deploy.
async function projectStep(run) {
  const { signal } = run;
  await run.begin("project");
  const { pos } = await run.load();
  const v = run.vercel;
  const name = pos.vercel?.projectName || pos.slug;
  const recordedId = pos.vercel?.projectId || "";
  let project = null;
  let how = "recorded";
  if (recordedId) {
    try {
      project = await v.project(recordedId, { signal });
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === "not-found"))
        throw error;
    }
  }
  if (!project) {
    project = await v.projectByName(name, { signal });
    how = "adopted";
    // A recorded project this token cannot see and no project of that name:
    // a wrong token or team, not a reason to make a second project.
    if (!project && recordedId) throw stop("project-not-found", "project");
  }
  if (!project) {
    // Not retried by the adapter: a lost answer is found by name next run.
    project = await v.createProject(name, { signal });
    how = "created";
    await saveProject(run, project, "created");
  }
  if (productionOf(project) && !run.ownDeployLive())
    throw stop("project-live", "project");
  if (how === "adopted") await saveProject(run, project, "adopted");
  else await saveProject(run, project, null);
  if (
    !productionOf(project) &&
    (project.nodeVersion !== BUILD_SETTINGS.nodeVersion ||
      project.sourceFilesOutsideRootDirectory !==
        BUILD_SETTINGS.sourceFilesOutsideRootDirectory)
  )
    await v.patchProject(project.id, { signal });
  await run.end(
    "project",
    "done",
    how === "created"
      ? "Project created"
      : how === "adopted"
        ? "Existing project adopted"
        : "Recorded project",
  );
}
async function saveProject(run, project, how) {
  const now = run.pos.vercel ?? {};
  const set = {
    "pos.vercel.projectId": project.id,
    "pos.vercel.orgId": project.accountId,
    "pos.vercel.projectName": project.name,
  };
  if (
    now.projectId === project.id &&
    now.orgId === project.accountId &&
    now.projectName === project.name
  )
    return;
  await run.commit({
    pos: set,
    bump: true,
    clearVerify: true,
    audits: how
      ? [[`pos.golive.project-${how}`, `${project.id} #${run.id8}`]]
      : [],
  });
  run.pos = {
    ...run.pos,
    vercel: {
      ...run.pos.vercel,
      projectId: project.id,
      orgId: project.accountId,
      projectName: project.name,
    },
  };
}

// secrets: mint what is missing, never re-mint (D43, D45); the stats token
// binds statsHost to the go-live host (D37).
async function secretsStep(run) {
  await run.begin("secrets");
  await run.load();
  const fields = [
    "generated.authSecret",
    "generated.healthStatsToken",
    "generated.realtimePublishSecret",
  ];
  const current = Object.fromEntries(
    fields.map((f) => [f.split(".")[1], run.secret(f)]),
  );
  const minted = mintSecrets(current);
  const set = {};
  const changed = [];
  for (const field of fields) {
    const key = field.split(".")[1];
    if (current[key]) continue;
    set[`pos.${field}`] = run.box(field, minted[key]);
    changed.push(field);
  }
  if (!run.secret("posAdmin.password")) {
    set["pos.posAdmin.password"] = run.box(
      "posAdmin.password",
      mintPosAdminPassword(),
    );
    changed.push("posAdmin.password");
  }
  const at = run.now();
  for (const field of changed)
    set[`pos.secretsChangedAt.${changedKey(field)}`] = at;
  if (!current.healthStatsToken) set["pos.statsHost"] = run.g.address.host;
  if (changed.length) await run.commit({ pos: set, bump: true });
  await run.end(
    "secrets",
    "done",
    changed.length ? `${changed.length} secrets minted` : "Secrets kept",
  );
}

// realtime (D46): no token -> skipped (realtime off). Else account, workers.dev
// subdomain, bundle (W3), upload when something the Worker serves changed,
// probes (426 + signed publish), one self-heal upload.
async function realtimeStep(run) {
  const { ctx, signal } = run;
  await run.begin("realtime");
  const { pos } = await run.load();
  const token = pos.cloudflare ? run.secret("cloudflare.token") : null;
  if (!token) {
    run.realtime = false;
    await run.end("realtime", "skipped", "No Cloudflare token: realtime off");
    return;
  }
  let name;
  try {
    name = workerNameOf(pos.slug);
  } catch {
    throw stop("realtime-name", "realtime");
  }
  const tenantId = pos.tenantId;
  const secret = await publishSecret(run);
  const cf = ctx.cloudflareFor(token);
  let accountId = pos.cloudflare.accountId || "";
  if (!accountId) {
    const list = await cf.accounts({ signal });
    if (list.length !== 1)
      throw stop(
        list.length ? "cf-account-ambiguous" : "cloudflare-denied",
        "realtime",
      );
    accountId = list[0].id;
    // Save after learn.
    await run.commit({
      pos: { "pos.cloudflare.accountId": accountId },
      bump: true,
      clearVerify: true,
    });
  }
  let sub = (await cf.workersSubdomain(accountId, { signal })).subdomain;
  for (let attempt = 1; !sub; attempt++) {
    const candidate = subdomainCandidate(pos.slug, attempt);
    if (!candidate) throw stop("cloudflare-conflict", "realtime");
    try {
      sub = (
        await cf.registerWorkersSubdomain(accountId, candidate, { signal })
      ).subdomain;
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === "conflict"))
        throw error;
    }
  }
  const host = `${name}.${sub}.workers.dev`;
  const url = `https://${host}`;
  const w = { run, cf, accountId, name, url, tenantId, secret };
  const rt = run.g.realtime ?? {};
  const prior =
    rt.deployedAt && pos.cloudflare.workerName && pos.cloudflare.workerUrl
      ? {
          workerName: pos.cloudflare.workerName,
          tenantId: rt.tenantId,
          bundleSha256: rt.bundleSha256,
          url: pos.cloudflare.workerUrl,
        }
      : null;
  // The bundle of a commit is deterministic (spike S2): the same commit with
  // the same name, tenant and URL needs no bundle run and no upload.
  const upToDate =
    prior &&
    rt.sha === run.g.sha &&
    !realtimeNeedsDeploy(prior, {
      workerName: name,
      tenantId,
      bundleSha256: prior.bundleSha256,
      url,
    });
  let deployed = false;
  if (!upToDate) {
    if (await landedEarlier(w)) deployed = true;
    else deployed = await bundleAndUpload(w, prior, false);
  }
  let verdict = await probeWorker(run, host, secret, tenantId);
  // Self-heal once (go-live's ensureRealtime): a Worker serving another
  // tenant or secret is uploaded again, then probed again.
  if (verdict !== "ok" && verdict !== "realtime-envelope" && !deployed) {
    deployed = await bundleAndUpload(w, prior, true);
    verdict = await probeWorker(run, host, secret, tenantId);
  }
  if (verdict !== "ok") throw stop(verdict, "realtime");
  await run.patch({
    realtime: {
      ...(run.g.realtime ?? {}),
      verifiedAt: run.now(),
      run: null,
      pending: null,
    },
  });
  run.realtime = { url, secret };
  await run.end(
    "realtime",
    "done",
    deployed ? "Worker deployed and answering" : "Worker up to date",
  );
}
// The publish secret (the secrets step mints it; a Worker update of an older
// go-live mints it once if it is missing).
async function publishSecret(run) {
  const field = "generated.realtimePublishSecret";
  const stored = run.secret(field);
  if (stored) return stored;
  const value = mintSecrets({}).realtimePublishSecret;
  await run.commit({
    pos: {
      [`pos.${field}`]: run.box(field, value),
      [`pos.secretsChangedAt.${changedKey(field)}`]: run.now(),
    },
    bump: true,
  });
  return value;
}
// A takeover after an upload that created the Worker: the script exists at a
// migration tag now, so the earlier upload landed (no second upload).
async function landedEarlier(w) {
  const p = w.run.g.realtime?.pending;
  if (
    !p ||
    p.fromTag !== null ||
    p.sha !== w.run.g.sha ||
    p.workerName !== w.name ||
    p.url !== w.url ||
    p.tenantId !== w.tenantId
  )
    return false;
  const tag = await w.cf.workerMigrationTag(w.accountId, w.name, {
    signal: w.run.signal,
  });
  if (tag === null) return false;
  await recordDeployed(w, p.bundleSha256);
  return true;
}
// Bundle (reusing an earlier attempt's run), then upload when needed (or
// `force`). -> true when uploaded.
async function bundleAndUpload(w, prior, force) {
  const { run } = w;
  const got = await fetchBundle(run);
  if (
    !force &&
    prior &&
    !realtimeNeedsDeploy(prior, {
      workerName: w.name,
      tenantId: w.tenantId,
      bundleSha256: got.bundleSha256,
      url: w.url,
    })
  ) {
    // The same bundle at another commit: nothing to upload.
    await run.patch({
      realtime: { ...(run.g.realtime ?? {}), sha: run.g.sha, run: null },
    });
    return false;
  }
  const tag = await w.cf.workerMigrationTag(w.accountId, w.name, {
    signal: run.signal,
  });
  let metadata;
  try {
    metadata = uploadMetadataOf(got.descriptor, {
      tenantId: w.tenantId,
      publishSecret: w.secret,
      migrationTag: tag,
    });
  } catch (error) {
    throw stop(error?.code ?? "realtime-descriptor", "realtime");
  }
  // Intent first: a successor that finds the new script knows it landed.
  await run.patch({
    realtime: {
      ...(run.g.realtime ?? {}),
      pending: {
        bundleSha256: got.bundleSha256,
        sha: run.g.sha,
        workerName: w.name,
        url: w.url,
        tenantId: w.tenantId,
        fromTag: tag,
        at: run.now(),
      },
    },
  });
  await w.cf.uploadWorker(
    { accountId: w.accountId, name: w.name, bundle: got.bundle, metadata },
    { signal: run.signal },
  );
  await recordDeployed(w, got.bundleSha256);
  return true;
}
async function recordDeployed(w, bundleSha256) {
  const { run } = w;
  await w.cf.enableWorkersDev(w.accountId, w.name, { signal: run.signal });
  const cf = run.pos.cloudflare ?? {};
  const changed = cf.workerName !== w.name || cf.workerUrl !== w.url;
  await run.commit({
    pos: changed
      ? {
          "pos.cloudflare.workerName": w.name,
          "pos.cloudflare.workerUrl": w.url,
        }
      : {},
    golive: {
      realtime: {
        bundleSha256,
        sha: run.g.sha,
        tenantId: w.tenantId,
        deployedAt: run.now(),
        verifiedAt: null,
        run: null,
        pending: null,
      },
    },
    bump: changed,
    clearVerify: changed,
    audits: [
      [
        "pos.golive.realtime-deployed",
        `${w.name} ${key8(bundleSha256)} #${run.id8}`,
      ],
    ],
  });
  run.pos = {
    ...run.pos,
    cloudflare: { ...cf, workerName: w.name, workerUrl: w.url },
  };
}
async function fetchBundle(run) {
  const { ctx } = run;
  const dir = path.join(dirs(ctx.workDir).tmp, `golive-${run.g.requestId}`);
  try {
    return await fetchRealtimeBundle(ctx, {
      github: ctx.realtimeGitHub,
      sha: run.g.sha,
      dir,
      prior: run.g.realtime?.run ?? null,
      // Stored before and after the dispatch: a successor reuses the run.
      onDispatched: (r) =>
        run.patch({
          realtime: {
            ...(run.g.realtime ?? {}),
            run: { id: r.id, runId: r.runId, at: r.at },
          },
        }),
      signal: run.signal,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
// GET /join must answer 426 (a new workers.dev name needs a few tries), then
// a signed publish must answer 200. -> "ok" | a realtime code.
async function probeWorker(run, host, secret, tenantId) {
  const { ctx, signal } = run;
  let join = null;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      join = (
        await ctx.realtimeProbe.get(host, "/join", {
          signal,
          maxBytes: 1024,
          truncate: true,
        })
      ).status;
    } catch {
      join = null;
    }
    if (join === JOIN_PROBE_STATUS) break;
    if (attempt < PROBE_ATTEMPTS) await wait(ctx, PROBE_INTERVAL_MS, signal);
  }
  if (join !== JOIN_PROBE_STATUS) return "realtime-probe-failed";
  let status = null;
  for (let attempt = 1; attempt <= PUBLISH_PROBE_ATTEMPTS; attempt++) {
    const { body, headers } = signedPublishRequest(secret, tenantId, ctx.now());
    try {
      status = (
        await ctx.realtimeProbe.post(host, "/publish", body, {
          headers,
          signal,
          maxBytes: 4096,
        })
      ).status;
    } catch {
      status = null;
    }
    if (PUBLISH_DEFINITIVE_STATUSES.includes(status)) break;
    if (attempt < PUBLISH_PROBE_ATTEMPTS)
      await wait(ctx, PUBLISH_PROBE_INTERVAL_MS, signal);
  }
  return publishVerdict(status);
}

// domain: attach <label>.sandbee.in (check before create), read verification
// and config, store the records the owner enters at GoDaddy (D44).
async function domainStep(run) {
  const { signal } = run;
  await run.begin("domain");
  const { pos } = await run.load();
  const { label, host } = run.g.address;
  const projectId = pos.vercel?.projectId;
  if (!projectId) throw stop("inputs-missing", "domain");
  let domain = await run.vercel.projectDomain(projectId, host, { signal });
  const added = !domain;
  if (!domain) domain = await run.vercel.addDomain(projectId, host, { signal });
  const config = await run.vercel.domainConfig(host, { signal });
  const records = webAddressRecords({
    subdomain: label,
    apex: PLATFORM_APEX,
    recommendedCname: config.recommendedCname,
    verification: domain.verified ? [] : domain.verification,
  }).map((r) => ({
    type: r.type,
    name: r.name,
    value: clip(r.value, GOLIVE_LIMITS.txtValue),
  }));
  const configured = !config.misconfigured;
  await run.patch({
    "address.records": records,
    "address.verified": domain.verified === true,
    "address.configured": configured,
    "address.state": addressStateOf({
      verified: domain.verified === true,
      configured,
      reachable: false,
      hasTxtRow: records.some((r) => r.type === "TXT"),
      answeredAs: null,
    }),
    "address.checkedAt": run.now(),
  });
  await run.end(
    "domain",
    "done",
    added ? "Address added" : "Address on the project",
  );
}

// env (D43): buildEnv -> upsert -> metadata after the write -> parity. A
// write is skipped when Vercel already holds exactly what admin wrote last,
// and a successor proves an interrupted upsert landed through Vercel's own
// updatedAt (every upserted row is bumped, spike S1) instead of writing again.
async function envStep(run) {
  const { ctx, signal } = run;
  await run.begin("env");
  const { pos } = await run.load();
  const projectId = pos.vercel?.projectId;
  if (!projectId) throw stop("inputs-missing", "env");
  let client;
  try {
    client = envClientOf(pos, {
      mongoUri: run.secret("mongo.uri"),
      imageKeys: run.secret("image.keys"),
    });
  } catch {
    throw stop("inputs-missing", "env");
  }
  const generated = {
    authSecret: run.secret("generated.authSecret"),
    healthStatsToken: run.secret("generated.healthStatsToken"),
  };
  if (!generated.authSecret || !generated.healthStatsToken)
    throw stop("inputs-missing", "env");
  const envs = buildEnv(
    client,
    { tenantId: pos.tenantId, rootDomain: pos.rootDomain },
    generated,
    realtimeEnvFor(run, pos),
  );
  const vaultKey = ctx.c.VAULT_KEY;
  const fingerprint = (key, value) => envFp(vaultKey, key, value);
  const intended = envFingerprints(vaultKey, envs);
  // What this write intends (keyed fingerprints only), as a short digest.
  const digest = createHash("sha256")
    .update(JSON.stringify(intended.map((k) => [k.name, k.type, k.fp16])))
    .digest("hex")
    .slice(0, 32);
  const prior = run.g.env ?? null;
  const before = await run.vercel.envMeta(projectId, { fingerprint, signal });
  let keys;
  let wrote = false;
  const samePrior =
    Array.isArray(prior?.keys) &&
    prior.keys.length === intended.length &&
    intended.every(
      (k, i) =>
        prior.keys[i]?.name === k.name &&
        prior.keys[i]?.type === k.type &&
        prior.keys[i]?.fp16 === k.fp16 &&
        String(prior.keys[i]?.targets) === String(k.targets),
    );
  if (samePrior && envDrift(prior.keys, before).length === 0) {
    keys = prior.keys; // Vercel holds exactly admin's last write.
  } else if (prior?.pending?.digest === digest && landed(envs, before, prior)) {
    // An earlier attempt's upsert landed: no second write.
    keys = envFingerprints(vaultKey, envs, before);
    if (envDrift(keys, before).length) throw stop("env-parity", "env");
    wrote = true;
  } else {
    // Vercel's newest updatedAt before the write: every row of a landed
    // upsert is newer (same clock, no skew).
    const base = Math.max(
      0,
      ...before.map((m) => (Number.isFinite(m.updatedAt) ? m.updatedAt : 0)),
    );
    await run.patch({
      env: {
        at: prior?.at ?? null,
        keys: Array.isArray(prior?.keys) ? prior.keys : [],
        pending: { digest, base },
      },
    });
    const out = await run.vercel.upsertEnv(projectId, envs, { signal });
    if (out.failed.length) throw stop("env-upsert-failed", "env");
    // S1: read after the write; those updatedAt values are admin's write.
    const after = await run.vercel.envMeta(projectId, { fingerprint, signal });
    keys = envFingerprints(vaultKey, envs, after);
    if (envDrift(keys, after).length) throw stop("env-parity", "env");
    wrote = true;
  }
  await run.commit({
    golive: {
      env: {
        at: wrote ? run.now() : (prior?.at ?? run.now()),
        keys,
        pending: null,
      },
    },
    audits: wrote
      ? [["pos.golive.env-synced", `${keys.length} keys #${run.id8}`]]
      : [],
  });
  await run.end(
    "env",
    "done",
    wrote ? `${keys.length} variables written` : "Env up to date",
  );
}
// Did the interrupted upsert land? Every key present with its type, targets
// and plain value, and newer (Vercel's clock) than the newest row before it.
function landed(envs, meta, prior) {
  const base = prior?.pending?.base;
  if (!Number.isFinite(base)) return false;
  const newest = new Map();
  for (const m of meta)
    if (Number.isFinite(m.updatedAt))
      newest.set(m.key, Math.max(newest.get(m.key) ?? 0, m.updatedAt));
  return envs.every((e) => (newest.get(e.key) ?? 0) > base);
}
// The REALTIME_* triple: what this run's realtime step proved; for Sync env
// (no realtime step) the stored Worker when it was verified; else off.
function realtimeEnvFor(run, pos) {
  if (run.realtime === false) return realtimeOffEnv();
  if (run.realtime) return realtimeEnvOf(run.realtime);
  const token = pos.cloudflare ? run.secret("cloudflare.token") : null;
  const secret = run.secret("generated.realtimePublishSecret");
  return token &&
    secret &&
    pos.cloudflare?.workerUrl &&
    run.g.realtime?.verifiedAt
    ? realtimeEnvOf({ url: pos.cloudflare.workerUrl, secret })
    : realtimeOffEnv();
}

// admin (D45): seed the POS admin login only when the client DB has none; an
// admin that is ours (vault password matches) counts as seeded.
async function adminStep(run) {
  const { ctx } = run;
  await run.begin("admin");
  const { pos } = await run.load();
  if (run.g.admin?.state === "seeded") {
    await run.end("admin", "done", "Admin login created earlier");
    return;
  }
  const uri = run.secret("mongo.uri");
  const password = run.secret("posAdmin.password");
  const username = pos.posAdmin?.username;
  if (!uri || !password || !username) throw stop("inputs-missing", "admin");
  let state;
  try {
    ({ state } = await ctx.posAdminSeed({ uri, username, password }));
    if (state === "exists") {
      // An earlier attempt of this go-live may have seeded it.
      const mine = await ctx.posAdminCheck({ uri, username, password });
      if (mine.userFound && mine.passwordMatches) state = "seeded";
    }
  } catch (error) {
    if (error instanceof AdminSeedError)
      throw new JobFail(
        "admin-seed-failed",
        failMessage(
          `The POS admin login could not be created or checked (${String(error.reason).slice(0, 20)}).`,
        ),
        { step: "admin" },
      );
    throw error;
  }
  await run.commit({
    golive: { admin: { state, at: run.now() } },
    audits:
      state === "seeded" ? [["pos.golive.admin-seeded", `#${run.id8}`]] : [],
  });
  if (state === "exists") await run.warn("admin-exists");
  await run.end(
    "admin",
    "done",
    state === "seeded"
      ? "Admin login created"
      : "An admin login already exists",
  );
}

// dns: authoritative CNAME (+ TXT) -> Vercel verify -> config. TLS is not a
// condition before the first deploy (spike S1): only recorded. Not ready ->
// waiting for the owner's Check DNS.
async function dnsStep(run) {
  const { ctx, signal } = run;
  await run.begin("dns");
  const { pos } = await run.load();
  const { host } = run.g.address;
  const projectId = pos.vercel?.projectId;
  if (!projectId) throw stop("inputs-missing", "dns");
  const records = Array.isArray(run.g.address.records)
    ? run.g.address.records
    : [];
  const txtRow = records.find((r) => r?.type === "TXT") ?? null;
  const found = await ctx.dnsCheck.checkRecords({
    apex: PLATFORM_APEX,
    host,
    txt: txtRow ? { name: txtRow.name, value: txtRow.value } : null,
  });
  let verified = run.g.address.verified === true;
  if (!verified)
    verified =
      (await run.vercel.verifyDomain(projectId, host, { signal })).verified ===
      true;
  const config = await run.vercel.domainConfig(host, { signal });
  const configured = !config.misconfigured;
  const tls = await ctx.tlsProbe(host, { signal });
  const reachable = tls?.ok === true;
  const cname = found.cname ?? {};
  const reason = cname.error
    ? "dns-unreachable"
    : !cname.found
      ? "dns-pending"
      : !cname.ok
        ? "dns-wrong-target"
        : txtRow && found.txt?.ok !== true
          ? "txt-pending"
          : !verified
            ? "txt-pending"
            : !configured
              ? "dns-pending"
              : null;
  await run.patch({
    "address.cname": {
      ok: cname.ok === true,
      found: cname.found ? clip(cname.found, GOLIVE_LIMITS.found) : null,
    },
    "address.txt": txtRow
      ? {
          ok: found.txt?.ok === true,
          found: (found.txt?.found ?? [])
            .slice(0, GOLIVE_LIMITS.txtFound)
            .map((v) => clip(v, GOLIVE_LIMITS.txtValue)),
        }
      : null,
    "address.verified": verified,
    "address.configured": configured,
    "address.tls": reachable,
    "address.state": addressStateOf({
      verified,
      configured,
      reachable,
      hasTxtRow: Boolean(txtRow),
      answeredAs: null,
    }),
    "address.checkedAt": run.now(),
  });
  if (reason) {
    await run.warn(reason);
    await run.waitFor("dns", "dns", `Waiting for DNS (${reason})`);
    return "wait";
  }
  await run.end(
    "dns",
    "done",
    reachable
      ? "DNS ready, HTTPS answers"
      : "DNS ready (cert-pending until the first deploy)",
  );
}

// The inline Verify (the verify task's checks), written as pos.verify.
async function inlineVerify(run) {
  const target = await run.load();
  const checked = await verifyChecks(run.ctx, target, { signal: run.signal });
  const record = verifyRecord(checked, run.now(), run.g.by);
  await run.commit({
    pos: { "pos.verify": record },
    audits: [
      [
        "pos.verify.completed",
        VERIFY_STEPS.map((k) => `${k}=${record[k] ?? "skipped"}`).join(" "),
      ],
    ],
  });
  return record;
}
// The code of the first flag that is not ok (bootstrap: not-deployed is ok).
const FLAG_CODES = {
  vercel: (f) => `vercel-${f}`,
  project: (f) => (f === "settings" ? "project-settings" : `project-${f}`),
  env: (f) => `env-${f}`,
  mongo: (f) => f,
  cloudflare: (f) => `cloudflare-${f}`,
  health: (f) => (f === "not-deployed" ? "unhealthy" : f),
};
function flagCodeOf(verify, { bootstrap }) {
  for (const key of VERIFY_STEPS) {
    const flag = verify[key];
    if (flag === null || flag === undefined || flag === "ok") continue;
    if (bootstrap && key === "health" && flag === "not-deployed") continue;
    return known(FLAG_CODES[key](flag));
  }
  return "internal";
}

// ready: inline bootstrap Verify, then wait for Unlock and deploy.
async function readyStep(run) {
  await run.begin("ready");
  const verify = await inlineVerify(run);
  const state = verifyStateOf(verify, run.ctx.now());
  if (state !== "bootstrap" && state !== "ok")
    throw stop(flagCodeOf(verify, { bootstrap: true }), "ready");
  await run.end(
    "ready",
    "done",
    state === "ok" ? "Verified" : "Verified (no production deployment yet)",
  );
  if (state === "ok" && run.ownDeployLive()) {
    // A re-run after this go-live's first deploy already went live.
    await run.patch(
      run.stepFields("deploy", {
        state: "done",
        endedAt: run.now(),
        note: "Deployed earlier",
      }),
    );
    await finishStep(run);
    return "end";
  }
  await run.waitFor("deploy", "ready");
  return "wait";
}

// finish (D47): inline Verify must be ok (HTTPS now works), then the 308
// redirects of the project's *.vercel.app names (a failure is a warning).
async function finishStep(run) {
  const { signal } = run;
  await run.begin("finish");
  const verify = await inlineVerify(run);
  if (verifyStateOf(verify, run.ctx.now()) !== "ok")
    throw stop(flagCodeOf(verify, { bootstrap: false }), "finish");
  const { host } = run.g.address;
  const projectId = run.pos.vercel?.projectId;
  let failed = false;
  let applied = 0;
  try {
    for (const d of await run.vercel.projectDomains(projectId, { signal })) {
      if (
        !d.name.endsWith(VERCEL_APP) ||
        d.name === host ||
        d.redirect === host
      )
        continue;
      try {
        await run.vercel.setDomainRedirect(projectId, d.name, host, {
          statusCode: 308,
          signal,
        });
        applied++;
      } catch (error) {
        if (!(error instanceof ProviderError) || signal.aborted) throw error;
        failed = true;
      }
    }
  } catch (error) {
    if (!(error instanceof ProviderError) || signal.aborted) throw error;
    failed = true;
  }
  if (failed) await run.warn("redirect-failed");
  const at = run.now();
  await run.commit({
    golive: {
      status: "live",
      liveAt: run.g.liveAt ?? at,
      endedAt: at,
      waitingFor: null,
      step: "finish",
      ...run.leaseOff(),
      ...run.stepFields("finish", {
        state: "done",
        endedAt: at,
        note: clip(
          failed
            ? "Live; a redirect could not be set"
            : `Live; ${applied} redirect${applied === 1 ? "" : "s"} set`,
        ),
      }),
    },
    audits: [["pos.golive.live", `#${run.id8}`]],
  });
}

const STEPS = {
  check: checkStep,
  project: projectStep,
  secrets: secretsStep,
  realtime: realtimeStep,
  domain: domainStep,
  env: envStep,
  admin: adminStep,
  dns: dnsStep,
  ready: readyStep,
  finish: finishStep,
};
// The steps this claim runs: `finish` once the first deploy is healthy
// (observeGolive queues it), else the action's steps.
export const planOf = (g) =>
  g?.step === "finish" ? ["finish"] : (GOLIVE_RUN_STEPS[g?.action] ?? []);

// ---- the run ------------------------------------------------------------------------
export async function runGolive(ctx, claim) {
  let run = null;
  await withLease(
    ctx,
    claim,
    async (signal) => {
      run = new GoliveRun(ctx, claim, signal);
      if (claim.takeover)
        ctx.log("golive-takeover", {
          id: run.id8,
          attempt: Number(run.g.attempt) || 0,
        });
      if (claim.tooManyAttempts || run.g.attempt > MAX_ATTEMPTS)
        throw new JobFail(
          "worker-stopped",
          "The worker stopped repeatedly during this go-live.",
          { step: run.g.step },
        );
      const plan = planOf(run.g);
      if (!plan.length)
        throw new JobFail(
          "unsupported",
          "This go-live action is not available in this worker version.",
        );
      if (!run.g.startedAt) await run.patch({ startedAt: run.now() });
      for (const name of plan) {
        await run.checkpoint();
        if (run.isDone(name)) continue;
        const outcome = await STEPS[name](run);
        if (outcome === "wait" || outcome === "end") return;
      }
      if (plan.includes("finish")) return;
      // Sync env / Update realtime Worker on a live go-live: back to live.
      if (!run.g.liveAt) throw stop("internal", run.g.step);
      await run.patch({
        status: "live",
        endedAt: run.now(),
        waitingFor: null,
        ...run.leaseOff(),
      });
      ctx.log("golive-ended", { id: run.id8, status: "live" });
    },
    (error) => failGolive(ctx, claim, run, error),
  );
}

// ---- failures --------------------------------------------------------------------------
// Any error -> {status, step, code, message} with a fixed message.
export function goliveFailure(error, step) {
  if (error instanceof JobFail)
    return {
      status: error.status === "cancelled" ? "cancelled" : "failed",
      step: error.step ?? step,
      code: error.code,
      message: error.message,
    };
  if (error instanceof ProviderError) {
    const code = GOLIVE_PROVIDER_CODES.has(error.code)
      ? error.code
      : known(`${error.provider}-${providerFlag(error.code)}`);
    return {
      status: "failed",
      step,
      code,
      message: describeCode(code).plainMessage,
    };
  }
  if (error instanceof AdminSeedError)
    return {
      status: "failed",
      step,
      code: "admin-seed-failed",
      message: describeCode("admin-seed-failed").plainMessage,
    };
  // Coded errors of the pure helpers and adapters (dns-unreachable,
  // realtime-upload-failed, realtime-descriptor, inputs-missing, ...).
  const code = known(error?.code);
  return {
    status: "failed",
    step,
    code,
    message:
      code === "internal"
        ? "The worker hit an unexpected error."
        : describeCode(code).plainMessage,
  };
}
// Terminal write of a run (fenced): failed or cancelled, the running step
// marked, the lease given up; audited unless the owner cancelled it.
export async function failGolive(ctx, claim, run, error) {
  const current = (await claim.slot.read()) ?? {};
  if (!claim.slot.mine(current)) return;
  const info = goliveFailure(error, current.step);
  const cancelled = info.status === "cancelled";
  const at = new Date(ctx.now());
  const step = GOLIVE_STEPS.includes(info.step)
    ? info.step
    : GOLIVE_STEPS.includes(current.step)
      ? current.step
      : null;
  const code = known(info.code);
  const fields = {
    status: cancelled ? "cancelled" : "failed",
    error: { step, code, message: failMessage(info.message) },
    endedAt: at,
    waitingFor: null,
    "lease.owner": null,
    "lease.until": null,
    heartbeatAt: null,
  };
  const running = (current.steps ?? []).findIndex(
    (s) => s?.state === "running",
  );
  if (running >= 0) {
    fields[`steps.${running}.state`] = "failed";
    fields[`steps.${running}.endedAt`] = at;
  }
  const id8 = String(current.requestId ?? "").slice(0, 8);
  await transaction(ctx.client, async (session) => {
    if (!(await claim.slot.set(fields, { session }))) throw new LeaseLost();
    if (!cancelled)
      await audit(
        ctx.db,
        session,
        WORKER_ACTOR,
        "pos.golive.failed",
        "installations",
        claim.installationId,
        `${step ?? "-"} ${code} #${id8}`,
      );
  });
  ctx.log("golive-ended", { id: id8, status: fields.status, code });
}

// ---- the first deploy (observed, D47) -------------------------------------------------
// For every go-live in `deploying`: the deploy job Unlock and deploy enqueued
// either still runs (nothing to do), ended healthy (the go-live is queued
// for `finish`), or ended otherwise (the go-live fails with the job's code;
// a first deploy has no previous version, so a failed health check leaves it
// unhealthy without a rollback). DB only; every write is conditional on the
// go-live still deploying the same job. -> number of go-lives changed.
export async function observeGolive(ctx) {
  if (ctx.killed) return 0;
  const rows = await ctx.coll.installations
    .find(
      { "pos.golive.status": "deploying" },
      {
        projection: {
          "pos.golive": 1,
          "pos.deploy.current": 1,
          "pos.deploy.last": 1,
        },
      },
    )
    .limit(50)
    .toArray();
  let changed = 0;
  for (const row of rows)
    changed += await observeOne(ctx, row).catch((error) => {
      ctx.log("golive-observe-failed", {
        code: String(error?.code ?? error?.name ?? "error").slice(0, 40),
      });
      return 0;
    });
  return changed;
}
async function observeOne(ctx, row) {
  const g = row.pos.golive;
  const rid = g.deployRequestId;
  const current = row.pos.deploy?.current;
  const last = row.pos.deploy?.last;
  let outcome;
  if (rid && current?.requestId === rid) {
    if (ACTIVE_STATES.includes(current.status)) return 0;
    outcome = {
      ok: false,
      code: known(
        current.error?.code ??
          (current.status === "cancelled" ? "cancelled" : "internal"),
      ),
    };
  } else if (rid && last?.requestId === rid)
    outcome =
      last.healthy === true
        ? { ok: true }
        : { ok: false, code: "health-failed" };
  else outcome = { ok: false, code: "job-lost" };
  const at = new Date(ctx.now());
  const i = (g.steps ?? []).findIndex((s) => s?.name === "deploy");
  const deployStep = (fields) =>
    i < 0
      ? {}
      : Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [
            `pos.golive.steps.${i}.${k}`,
            v,
          ]),
        );
  const filter = {
    _id: row._id,
    "pos.golive.requestId": g.requestId,
    "pos.golive.status": "deploying",
    "pos.golive.deployRequestId": rid ?? null,
  };
  if (outcome.ok) {
    // The finish step runs under a fresh claim of the go-live lane.
    const done = await ctx.coll.installations.updateOne(filter, {
      $set: {
        "pos.golive.status": "queued",
        "pos.golive.step": "finish",
        "pos.golive.requestedAt": at,
        "pos.golive.attempt": 0,
        "pos.golive.lease.owner": null,
        "pos.golive.lease.until": null,
        "pos.golive.heartbeatAt": null,
        "pos.golive.cancelRequested": false,
        ...deployStep({ state: "done", endedAt: at, note: "Deployed healthy" }),
      },
    });
    return done.modifiedCount;
  }
  const code = outcome.code;
  return transaction(ctx.client, async (session) => {
    const done = await ctx.coll.installations.updateOne(
      filter,
      {
        $set: {
          "pos.golive.status": "failed",
          "pos.golive.endedAt": at,
          "pos.golive.error": {
            step: "deploy",
            code,
            message: describeCode(code).plainMessage,
          },
          ...deployStep({ state: "failed", endedAt: at }),
        },
      },
      { session },
    );
    if (done.matchedCount !== 1) return 0;
    await audit(
      ctx.db,
      session,
      WORKER_ACTOR,
      "pos.golive.failed",
      "installations",
      row._id,
      `deploy ${code} #${String(g.requestId).slice(0, 8)}`,
    );
    return 1;
  });
}
