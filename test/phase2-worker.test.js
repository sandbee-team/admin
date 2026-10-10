// Phase 2 (U2): the on-demand usage check in the worker, end to end against
// fakes for the POS site, Cloudflare, Vercel and the client database, on a real
// (in-memory) MongoDB replica set with a fake clock. Nothing runs unless a check
// is queued; checks run one at a time; only the current result is stored.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { indexes } from "../backend/db.js";
import { encrypt } from "../backend/lib/crypto.js";
import { createVercel } from "../backend/lib/vercel.js";
import { ClientMongoError } from "../backend/lib/client-mongo.js";
import { buildContext } from "../backend/worker/context.js";
import { createLoop, LANES } from "../backend/worker/loop.js";
import { mailBatchSummary, usageSelfCheck } from "../backend/worker/usage.js";
import { MONGO_LIMIT_BYTES, utcDay } from "../shared/usage.js";
import { isUsageCode } from "../shared/usage-codes.js";
import { createFakeHealth } from "./fakes/health.js";
import { createFakeVercel } from "./fakes/vercel.js";
import { ACCOUNT_ID, createFakeCloudflare } from "./fakes/cloudflare.js";
import { createFakeGitHub } from "./fakes/builder.js";
import { VAULT_KEY, assertNoSecrets } from "./helpers.js";

const DAY = 86400000;
const CLI_VERSION = "63.1.0";
const VC_TOKEN = "vcp_USAGETOKEN_0123456789abcdef0123456789";
const CF_TOKEN = "cf_USAGETOKEN_abcdefghijklmnopqrstuvwxyz0123";
const STATS_TOKEN = "stats_USAGETOKEN_0123456789abcdefghij";
const MONGO_URI =
  "mongodb+srv://usageuser:UsagePass9z@cluster0.abcde.mongodb.net/demo";
const SECRETS = [VC_TOKEN, CF_TOKEN, STATS_TOKEN, MONGO_URI, "UsagePass9z"];
const MB = 1024 * 1024;

const healthOk = (tenant, clusters, extra = {}) => ({
  status: 200,
  body: { ok: true, db: "up", tenant, ts: 1, clusters, ...extra },
});
const coreAt = (fraction) => [
  {
    name: "core",
    role: "core",
    tag: "C",
    state: "ok",
    dataSize: Math.round(MONGO_LIMIT_BYTES * fraction) - 1000,
    indexSize: 1000,
  },
];
const PAUSED = {
  status: 503,
  headers: { "x-vercel-error": "DEPLOYMENT_PAUSED" },
  text: "The deployment is paused",
};

let repl,
  client,
  counter = 0;
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = new MongoClient(repl.getUri());
  await client.connect();
});
const workDirs = [];
after(async () => {
  await client?.close();
  await repl?.stop();
  await Promise.all(
    workDirs.map((dir) =>
      rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

async function makeEnv() {
  const db = client.db(`u${++counter}`);
  await indexes(db);
  const startAt = Date.UTC(2026, 9, 11, 10, 30, 0);
  // The API only queues while the worker heartbeat is fresh.
  await db
    .collection("system_state")
    .insertOne({ _id: "pos-worker", at: new Date(startAt) });
  const workDir = await mkdtemp(path.join(tmpdir(), "usage-test-"));
  workDirs.push(workDir);
  const env = {
    db,
    clock: { t: startAt },
    workDir,
    sites: {}, // host -> createFakeHealth
    calls: [], // usage probe calls in order: {host, options}
    concurrent: 0,
    maxConcurrent: 0,
    cf: createFakeCloudflare({ today: [1200, 2], yesterday: [5000, 9] }),
    vercel: createFakeVercel(),
    mongo: { dataSize: 100 * MB, indexSize: 4 * MB },
    mongoError: null,
    mongoCalls: [],
    notices: [],
    failMail: false,
    logs: [],
    c: {
      VAULT_KEY,
      POS_WORK_DIR: workDir,
      POS_BUILDER_REF: "main",
      POS_BUILDER_WORKFLOW: "build.yml",
      APP_URL: "https://admin.example.test",
    },
    gh: createFakeGitHub({ cliVersion: CLI_VERSION }),
    hook: null, // optional async (host) => void inside the probe
    onMail: null, // optional async () => void while an email is sent
    sleeps: [], // every ms the worker slept
  };
  // Plain probes answer from `replies`, the ?stats=1 request from `stats`
  // (default: the same list, each queue consumed on its own).
  env.site = (slug, replies, stats = replies) => {
    env.sites[`${slug}.example.com`] = createFakeHealth({
      health: replies,
      stats,
    });
  };
  return env;
}
async function makeWorker(env, { t = {} } = {}) {
  const ctx = await buildContext({
    c: env.c,
    db: env.db,
    client,
    s3: undefined,
    cache: null,
    notify: async (email, message) => {
      if (env.onMail) await env.onMail();
      if (env.failMail) throw new Error("smtp down");
      env.notices.push({ email, ...message });
    },
    overrides: {
      github: env.gh,
      workDir: env.workDir,
      cliVersion: CLI_VERSION,
      usageGet: async (host, p, options) => {
        env.calls.push({ host, path: p, options });
        env.concurrent++;
        env.maxConcurrent = Math.max(env.maxConcurrent, env.concurrent);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (env.hook) await env.hook(host);
          const site = env.sites[host];
          if (!site) throw Object.assign(new Error("x"), { code: "network" });
          return await site.get(host, p, options);
        } finally {
          env.concurrent--;
        }
      },
      cloudflareFetch: env.cf.fetch,
      vercelFor: ({ token }) =>
        createVercel({ token, fetch: env.vercel.fetch, sleep: async () => {} }),
      mongoStats: async (uri) => {
        env.mongoCalls.push(uri);
        if (env.mongoError) throw new ClientMongoError(env.mongoError);
        return env.mongo;
      },
      sleep: async (ms) => {
        env.sleeps.push(ms);
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => env.clock.t,
      log: (event, fields) => env.logs.push({ event, ...fields }),
      t: {
        heartbeatMs: 1e9,
        pollMs: 1,
        retentionCheckMs: 1e15, // never: the fake clock is in 2026 (> 1e12 ms)
        usageRetryMs: 1,
        ...t,
      },
    },
  });
  const loop = createLoop(ctx);
  await loop.boot();
  return { ctx, loop };
}
async function seed(
  env,
  { slug = "demo", watch = true, cfAccount = true, pos = {} } = {},
) {
  const id = randomUUID();
  const customerId = randomUUID();
  await env.db.collection("customers").insertOne({
    _id: customerId,
    name: `Cafe ${slug}`,
    status: "active",
    email: `${slug}@example.test`,
  });
  await env.db.collection("staff").updateOne(
    { _id: "staff-1" },
    {
      $set: {
        email: "owner@example.test",
        name: "Owner",
        role: "owner",
        status: "active",
      },
    },
    { upsert: true },
  );
  const box = (value, field) => encrypt(value, VAULT_KEY, `pos:${id}:${field}`);
  await env.db.collection("installations").insertOne({
    _id: id,
    customerId,
    productId: "pos",
    status: "live",
    pos: {
      rev: 1,
      slug,
      host: `${slug}.example.com`,
      tenantId: slug,
      vercel: {
        projectId: "prj_1",
        orgId: "team_1",
        teamId: "team_1",
        token: box(VC_TOKEN, "vercel.token"),
      },
      mongo: { uri: box(MONGO_URI, "mongo.uri") },
      cloudflare: {
        ...(cfAccount ? { accountId: ACCOUNT_ID } : {}),
        token: box(CF_TOKEN, "cloudflare.token"),
      },
      generated: {
        healthStatsToken: box(STATS_TOKEN, "generated.healthStatsToken"),
      },
      statsHost: `${slug}.example.com`, // the token was saved for this host
      deploy: { current: null, last: null, previous: null },
      usage: { watch },
      ...pos,
    },
  });
  return id;
}
async function queue(env, id, { batchId = null, ...over } = {}) {
  await env.db.collection("installations").updateOne(
    { _id: id },
    {
      $set: {
        "pos.usage.check": {
          id: batchId ?? randomUUID(),
          status: "queued",
          batchId,
          requestedAt: new Date(env.clock.t),
          by: { id: "staff-1", name: "Owner" },
          lease: { owner: null, until: null, fence: 0 },
          attempt: 0,
          startedAt: null,
          finishedAt: null,
          error: null,
          ...over,
        },
      },
    },
  );
}
const usageOf = async (env, id) =>
  (await env.db.collection("installations").findOne({ _id: id })).pos.usage;
function assertKnownCodes(value, label = "usage") {
  (function walk(v, key) {
    if (Array.isArray(v)) return v.forEach((x) => walk(x));
    if (v && typeof v === "object")
      return Object.entries(v).forEach(([k, inner]) => walk(inner, k));
    if ((key === "code" || key === "statsCode") && v !== null)
      assert.equal(isUsageCode(v), true, `${label}: unknown code ${v}`);
  })(value);
}
function assertClean(env, value) {
  assertNoSecrets(value, SECRETS, "stored usage");
  assertNoSecrets(env.logs, SECRETS, "logs");
  assertNoSecrets(env.notices, SECRETS, "emails");
  assertKnownCodes(value);
}

describe("usage lane", () => {
  it("is a separate lane of one", () => {
    assert.equal(LANES.usage, 1);
    assert.equal(LANES.task, 1);
  });
  it("does nothing at all without a queued check", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.2))]);
    const id = await seed(env);
    const { loop } = await makeWorker(env);
    await loop.drain();
    assert.equal(env.calls.length, 0);
    assert.equal(env.cf.calls.length, 0);
    assert.equal(env.vercel.calls.length, 0);
    assert.deepEqual(await usageOf(env, id), { watch: true });
  });
});

describe("one check", () => {
  it("measures site, storage, Cloudflare and tokens and stores only the current result", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const usage = await usageOf(env, id);
    assert.equal(usage.check.status, "done");
    assert.equal(usage.check.error, null);
    const last = usage.last;
    assert.equal(last.at.getTime(), env.clock.t);
    assert.deepEqual(
      { ...last.site, latencyMs: typeof last.site.latencyMs },
      {
        state: "up",
        code: "ok",
        httpStatus: 200,
        latencyMs: "number",
        probes: 1,
        deployActive: false,
      },
    );
    assert.equal(last.mongo.source, "health");
    assert.equal(last.mongo.code, "ok");
    assert.equal(last.mongo.statsCode, "ok");
    assert.equal(last.mongo.clusters.length, 1);
    assert.equal(last.mongo.clusters[0].name, "core");
    assert.equal(last.mongo.clusters[0].label, "C");
    assert.equal(last.mongo.maxPct, 0.4);
    assert.deepEqual(last.cloudflare, {
      code: "ok",
      day: utcDay(env.clock.t),
      requests: 1200,
      errors: 2,
      pct: 0.012,
      yesterday: { day: utcDay(env.clock.t - DAY), requests: 5000 },
    });
    assert.deepEqual(last.credentials, {
      vercel: { code: "ok", expiresAt: null },
      cloudflare: { code: "ok", expiresAt: null },
    });
    assert.deepEqual(last.alerts, {});
    assert.equal(last.level, "ok");
    // one plain probe (site + latency), then one stats request with the
    // token to the client's own host
    assert.equal(env.calls.length, 2);
    const [plain, call] = env.calls;
    assert.equal(plain.options.query, undefined);
    assert.equal(plain.options.headers["x-stats-token"], undefined);
    assert.equal(call.host, "demo.example.com");
    assert.deepEqual(call.options.query, { stats: "1" });
    assert.equal(call.options.headers["x-stats-token"], STATS_TOKEN);
    assert.equal(env.mongoCalls.length, 0, "no direct fallback needed");
    assertClean(env, usage);
    // a second check overwrites: still exactly one current result
    env.site("demo", [healthOk("demo", coreAt(0.5))]);
    env.clock.t += 3600000;
    await queue(env, id);
    await loop.drain();
    const again = await usageOf(env, id);
    assert.equal(again.last.mongo.maxPct, 0.5);
    assert.equal(again.last.at.getTime(), env.clock.t);
    assert.deepEqual(Object.keys(again).sort(), ["check", "last", "watch"]);
  });
  it("runs queued checks one at a time, oldest request first", async () => {
    const env = await makeEnv();
    const ids = {};
    for (const slug of ["a", "b", "c"]) {
      env.site(slug, [healthOk(slug, coreAt(0.1))]);
      ids[slug] = await seed(env, { slug });
    }
    await queue(env, ids.b);
    env.clock.t += 1;
    await queue(env, ids.a);
    env.clock.t += 1;
    await queue(env, ids.c);
    const { loop } = await makeWorker(env);
    await loop.drain();
    // each check = one plain probe + one stats request, never interleaved
    assert.deepEqual(
      env.calls.map((c) => c.host),
      [
        "b.example.com",
        "b.example.com",
        "a.example.com",
        "a.example.com",
        "c.example.com",
        "c.example.com",
      ],
    );
    assert.equal(env.maxConcurrent, 1);
    for (const id of Object.values(ids))
      assert.equal((await usageOf(env, id)).check.status, "done");
  });
});

describe("site rules", () => {
  it("is down only after 3 failed probes", async () => {
    const env = await makeEnv();
    env.site("demo", [{ status: 500, text: "boom" }]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(env.calls.length, 3);
    assert.equal(last.site.state, "down");
    assert.equal(last.site.code, "http-error");
    assert.equal(last.site.probes, 3);
    assert.equal(last.alerts["site-down"].level, "critical");
    assert.equal(last.level, "critical");
    // the site did not answer: storage came from the direct fallback
    assert.equal(last.mongo.statsCode, "stats-unavailable");
    assert.equal(last.mongo.source, "direct");
  });
  it("recovers inside the check when a later probe answers", async () => {
    const env = await makeEnv();
    env.site("demo", [
      Object.assign(new Error("x"), { code: "timeout" }),
      healthOk("demo", coreAt(0.3)),
    ]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.site.state, "up");
    assert.equal(last.site.probes, 2);
    assert.equal(last.alerts["site-down"], undefined);
  });
  it("is paused at once (no retries) and critical", async () => {
    const env = await makeEnv();
    env.site("demo", [PAUSED]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(env.calls.length, 1);
    assert.equal(last.site.state, "paused");
    assert.equal(last.alerts["site-paused"].level, "critical");
  });
  it("does not raise site-down while a deploy is running", async () => {
    const env = await makeEnv();
    env.site("demo", [{ status: 502, text: "bad gateway" }]);
    const id = await seed(env, {
      pos: { deploy: { current: { status: "running" }, last: null } },
    });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.site.state, "down");
    assert.equal(last.site.deployActive, true);
    assert.equal(last.alerts["site-down"], undefined);
  });
  it("without a host checks nothing else", async () => {
    const env = await makeEnv();
    const id = await seed(env, { pos: { host: undefined } });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const usage = await usageOf(env, id);
    assert.equal(usage.check.status, "done");
    assert.equal(usage.last.site.code, "no-host");
    assert.equal(usage.last.site.state, "unknown");
    assert.equal(env.calls.length + env.cf.calls.length, 0);
    assert.equal(env.vercel.calls.length + env.mongoCalls.length, 0);
    assert.equal(usage.last.level, "ok");
  });
});

describe("storage", () => {
  it("reads ledgers from the health stats and raises 75 % / 90 %", async () => {
    const env = await makeEnv();
    env.site("demo", [
      healthOk("demo", [
        ...coreAt(0.2),
        {
          name: "ledger-a",
          role: "ledger",
          tag: "A",
          active: true,
          state: "ok",
          dataSize: Math.round(MONGO_LIMIT_BYTES * 0.92),
          indexSize: 0,
        },
      ]),
    ]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.mongo.clusters.length, 2);
    assert.equal(last.mongo.maxPct, 0.92);
    assert.equal(last.alerts.storage.level, "critical");
    assert.match(last.alerts.storage.detail, /ledger-a/);
  });
  it("stats denied -> direct dbStats of the core cluster, notice kept", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", undefined, { stats: "denied" })]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.deepEqual(env.mongoCalls, [MONGO_URI]);
    assert.equal(last.mongo.source, "direct");
    assert.equal(last.mongo.code, "ok");
    assert.equal(last.mongo.statsCode, "stats-denied");
    assert.equal(last.mongo.clusters.length, 1);
    assert.equal(last.mongo.clusters[0].name, "core");
    assert.equal(last.mongo.clusters[0].bytes, 104 * MB);
    assert.equal(
      last.mongo.clusters[0].usedPct,
      Math.round(((104 * MB) / MONGO_LIMIT_BYTES) * 10000) / 10000,
    );
    assertClean(env, last);
  });
  it("direct fallback failure is a code; no URI is 'not set'", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", undefined, { stats: "error" })]);
    env.mongoError = "auth-failed";
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    let { last } = await usageOf(env, id);
    assert.equal(last.mongo.source, null);
    assert.equal(last.mongo.code, "mongo-auth-failed");
    assert.equal(last.mongo.statsCode, "stats-error");
    assert.deepEqual(last.mongo.clusters, []);
    assert.equal(last.mongo.maxPct, null);
    const bare = await seed(env, { slug: "bare", pos: { mongo: undefined } });
    env.site("bare", [healthOk("bare", undefined, { stats: "error" })]);
    await queue(env, bare);
    await loop.drain();
    ({ last } = await usageOf(env, bare));
    assert.equal(last.mongo.code, "mongo-not-set");
  });
  it("an unreadable stats token is reported, not mistaken for 'not set'", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", undefined, { stats: "denied" })]);
    const id = await seed(env);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.generated.healthStatsToken": encrypt(
            STATS_TOKEN,
            VAULT_KEY,
            "pos:someone-else:generated.healthStatsToken",
          ),
        },
      },
    );
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.mongo.statsCode, "secret-unreadable");
    for (const call of env.calls)
      assert.equal(call.options.headers["x-stats-token"], undefined);
  });
});

describe("Cloudflare and credentials", () => {
  it("Worker requests at 90 % of the free limit are critical", async () => {
    const env = await makeEnv();
    env.cf.state.today = [91000, 0];
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.cloudflare.pct, 0.91);
    assert.equal(last.alerts.workers.level, "critical");
  });
  it("missing analytics permission is a notice; no account id is 'not set'", async () => {
    const env = await makeEnv();
    env.cf.state.graphql = {
      data: null,
      errors: [{ message: "not authorized", extensions: { code: "authz" } }],
    };
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    let { last } = await usageOf(env, id);
    assert.equal(last.cloudflare.code, "cf-denied");
    assert.equal(last.cloudflare.requests, null);
    assert.equal(last.alerts.workers, undefined);
    assert.equal(last.level, "ok");
    const noAccount = await seed(env, {
      slug: "na",
      pos: { cloudflare: { token: null } },
    });
    env.site("na", [healthOk("na", coreAt(0.1))]);
    await queue(env, noAccount);
    await loop.drain();
    ({ last } = await usageOf(env, noAccount));
    assert.equal(last.cloudflare.code, "cf-not-set");
    assert.equal(last.credentials.cloudflare.code, "token-not-set");
  });
  it("token expiry: Vercel in 10 days is a warning, an expired Cloudflare token critical", async () => {
    const env = await makeEnv();
    env.vercel.state.token = {
      id: "tok_1",
      name: "admin",
      expiresAt: Date.UTC(2026, 9, 21, 10, 30, 0),
    };
    env.cf.state.verify = {
      status: "expired",
      expires_on: "2026-10-01T00:00:00Z",
    };
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.deepEqual(last.credentials.vercel, {
      code: "ok",
      expiresAt: Date.UTC(2026, 9, 21, 10, 30, 0),
    });
    assert.equal(last.credentials.cloudflare.code, "token-invalid");
    assert.equal(last.alerts.credential.level, "critical");
    assert.match(
      last.alerts.credential.detail,
      /Vercel token expires in 10 days/,
    );
  });
  it("a rejected Vercel token is invalid; a 403 on token metadata is 'expiry unknown'", async () => {
    const env = await makeEnv();
    env.vercel.rule(
      (method, p) => p === "/v5/user/tokens/current",
      () =>
        new Response("{}", {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    let { last } = await usageOf(env, id);
    assert.equal(last.credentials.vercel.code, "token-invalid");
    assert.equal(last.alerts.credential.level, "critical");
    env.vercel.rule(
      (method, p) => p === "/v5/user/tokens/current",
      () =>
        new Response("{}", {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    await queue(env, id);
    await loop.drain();
    ({ last } = await usageOf(env, id));
    assert.equal(last.credentials.vercel.code, "expiry-unknown");
    assert.equal(last.alerts.credential, undefined);
  });
});

describe("batch summary email", () => {
  async function batchOf(env, ids) {
    const batchId = randomUUID();
    for (const id of ids) await queue(env, id, { batchId });
    return batchId;
  }
  it("sends ONE email when the last check of a batch ends, listing warnings and criticals", async () => {
    const env = await makeEnv();
    env.site("full", [healthOk("full", coreAt(0.8))]);
    env.site("fine", [healthOk("fine", coreAt(0.1))]);
    env.site("stop", [PAUSED]);
    const full = await seed(env, { slug: "full" });
    const fine = await seed(env, { slug: "fine" });
    const stop = await seed(env, { slug: "stop" });
    await batchOf(env, [full, fine, stop]);
    const { loop } = await makeWorker(env);
    await loop.drain();
    assert.equal(env.notices.length, 1);
    const [mail] = env.notices;
    assert.equal(mail.email, "owner@example.test");
    assert.match(mail.subject, /1 critical, 1 warning/);
    assert.match(mail.text, /Cafe full \(full\)/);
    assert.match(mail.text, /Database storage/);
    assert.match(mail.text, /Cafe stop \(stop\)/);
    assert.match(mail.text, /POS site paused by Vercel/);
    assert.equal(mail.text.includes("Cafe fine"), false);
    assert.match(
      mail.text,
      new RegExp(`https://admin\\.example\\.test/installations/${full}/usage`),
    );
    assertClean(env, await usageOf(env, full));
    // mail memory written for the mailed types only
    const memory = (await usageOf(env, full)).mail;
    assert.equal(memory.storage.level, "warning");
    assert.equal(memory.storage.at.getTime(), env.clock.t);
    assert.equal((await usageOf(env, fine)).mail, undefined);
  });
  it("de-duplicates per client per type for 24 h, but mails one escalation", async () => {
    const env = await makeEnv();
    env.site("full", [healthOk("full", coreAt(0.8))]);
    const full = await seed(env, { slug: "full" });
    const { loop } = await makeWorker(env);
    await batchOf(env, [full]);
    await loop.drain();
    assert.equal(env.notices.length, 1);
    env.clock.t += 3600000;
    await batchOf(env, [full]);
    await loop.drain();
    assert.equal(env.notices.length, 1, "same alert inside 24 h: no email");
    env.site("full", [healthOk("full", coreAt(0.93))]);
    env.clock.t += 3600000;
    await batchOf(env, [full]);
    await loop.drain();
    assert.equal(env.notices.length, 2, "warning -> critical: one email");
    assert.match(env.notices[1].subject, /1 critical, 0 warning/);
    env.clock.t += 3600000;
    await batchOf(env, [full]);
    await loop.drain();
    assert.equal(env.notices.length, 2);
    env.clock.t += DAY;
    await batchOf(env, [full]);
    await loop.drain();
    assert.equal(env.notices.length, 3, "24 h later: emailed again");
  });
  it("a single 'Check now' never emails; a batch with nothing due sends nothing", async () => {
    const env = await makeEnv();
    env.site("stop", [PAUSED]);
    env.site("fine", [healthOk("fine", coreAt(0.1))]);
    const stop = await seed(env, { slug: "stop" });
    const fine = await seed(env, { slug: "fine" });
    const { loop } = await makeWorker(env);
    await queue(env, stop);
    await loop.drain();
    assert.equal((await usageOf(env, stop)).last.level, "critical");
    await batchOf(env, [fine]);
    await loop.drain();
    assert.equal(env.notices.length, 0);
  });
  it("an SMTP failure leaves the checks done and nothing marked as mailed", async () => {
    const env = await makeEnv();
    env.site("stop", [PAUSED]);
    const stop = await seed(env, { slug: "stop" });
    const { loop } = await makeWorker(env);
    env.failMail = true;
    await batchOf(env, [stop]);
    await loop.drain();
    const usage = await usageOf(env, stop);
    assert.equal(usage.check.status, "done");
    assert.equal(usage.mail, undefined);
    env.failMail = false;
    await batchOf(env, [stop]);
    await loop.drain();
    assert.equal(env.notices.length, 1);
  });
});

describe("queue safety", () => {
  it("a check whose lease was taken over lands no write", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    await queue(env, id);
    env.hook = async () => {
      env.hook = null;
      await env.db.collection("installations").updateOne(
        { _id: id },
        {
          $set: {
            "pos.usage.check.lease.owner": "w-other",
            "pos.usage.check.lease.fence": 99,
          },
        },
      );
    };
    const { loop } = await makeWorker(env);
    await loop.drain();
    const usage = await usageOf(env, id);
    assert.equal(usage.last, undefined);
    assert.equal(usage.check.status, "running");
    assert.equal(usage.check.lease.owner, "w-other");
  });
  it("takes over a running check with an expired lease; > 3 attempts fail", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    await queue(env, id, {
      status: "running",
      attempt: 1,
      lease: { owner: "w-dead", until: new Date(env.clock.t - 1000), fence: 4 },
    });
    const { loop } = await makeWorker(env);
    await loop.drain();
    let usage = await usageOf(env, id);
    assert.equal(usage.check.status, "done");
    assert.equal(usage.check.attempt, 2);
    assert.equal(usage.check.lease.fence, 5);
    await queue(env, id, {
      status: "running",
      attempt: 3,
      lease: { owner: "w-dead", until: new Date(env.clock.t - 1000), fence: 7 },
    });
    env.calls.length = 0;
    await loop.drain();
    usage = await usageOf(env, id);
    assert.equal(usage.check.status, "failed");
    assert.deepEqual(usage.check.error, { code: "worker-stopped" });
    assert.equal(env.calls.length, 0);
  });
  it("boot expires checks queued while the worker was offline", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    await env.db
      .collection("system_state")
      .updateOne(
        { _id: "pos-worker" },
        { $set: { at: new Date(env.clock.t - 11 * 60000) } },
      );
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const usage = await usageOf(env, id);
    assert.equal(usage.check.status, "expired");
    assert.deepEqual(usage.check.error, { code: "not-picked-up" });
    assert.equal(env.calls.length, 0);
  });
  it("a long queue with a live worker is never expired", async () => {
    const env = await makeEnv();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      env.site(`s${i}`, [healthOk(`s${i}`, coreAt(0.1))]);
      ids.push(await seed(env, { slug: `s${i}` }));
      await queue(env, ids.at(-1));
    }
    const { loop } = await makeWorker(env);
    env.clock.t += 60 * 60000; // an hour of queue, worker heartbeat fresh
    await env.db
      .collection("system_state")
      .updateOne(
        { _id: "pos-worker" },
        { $set: { at: new Date(env.clock.t) } },
      );
    await loop.drain();
    for (const id of ids)
      assert.equal((await usageOf(env, id)).check.status, "done");
  });
});

describe("--self-check --usage", () => {
  it("prints codes and numbers only and writes nothing", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    const { ctx } = await makeWorker(env);
    const lines = [];
    const before = await usageOf(env, id);
    const result = await usageSelfCheck(ctx, {
      installationId: id,
      mailTest: true,
      print: (line) => lines.push(line),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(await usageOf(env, id), before);
    const text = lines.join("\n");
    assert.match(text, /^ok site up/m);
    assert.match(text, /^ok storage health core=40%/m);
    assert.match(text, /^ok cloudflare today=1200 yesterday=5000/m);
    assert.match(text, /^ok vercel-token no-expiry/m);
    assert.match(text, /^ok cloudflare-token no-expiry/m);
    assert.match(text, /^ok mail-test sent=1/m);
    assertNoSecrets(lines, SECRETS, "self-check output");
    assert.equal(env.notices.length, 1);
    assert.equal(env.notices[0].text.includes("demo"), false);
    const missing = await usageSelfCheck(ctx, {
      installationId: randomUUID(),
      print: () => {},
    });
    assert.equal(missing.ok, false);
  });
});

describe("review fixes", () => {
  const pausedDone = (env, id, batchId) =>
    env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.usage.check": {
            id: batchId,
            status: "done",
            batchId,
            requestedAt: new Date(env.clock.t),
            by: { id: "staff-1", name: "Owner" },
            lease: { owner: "w-x", until: new Date(env.clock.t), fence: 1 },
            attempt: 1,
            startedAt: new Date(env.clock.t),
            finishedAt: new Date(env.clock.t),
            error: null,
          },
          "pos.usage.last": {
            at: new Date(env.clock.t),
            site: { state: "paused", code: "paused", probes: 1 },
            alerts: {
              "site-paused": {
                level: "critical",
                value: null,
                detail: "Vercel answered 503 DEPLOYMENT_PAUSED",
              },
            },
            level: "critical",
          },
        },
      },
    );
  it("the stats token is never sent to a host it was not saved for", async () => {
    const env = await makeEnv();
    env.site(
      "demo",
      [healthOk("demo", undefined)],
      [healthOk("demo", undefined, { stats: "denied" })],
    );
    const id = await seed(env, { pos: { statsHost: "old.example.com" } });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    for (const call of env.calls)
      assert.equal(call.options.headers["x-stats-token"], undefined);
    assert.equal(last.mongo.statsCode, "stats-host-changed");
    assert.equal(last.mongo.source, "direct");
  });
  it("a token that is not header-safe is not sent (no false site-down)", async () => {
    const env = await makeEnv();
    env.site(
      "demo",
      [healthOk("demo", undefined)],
      [healthOk("demo", undefined, { stats: "denied" })],
    );
    const id = await seed(env);
    await env.db.collection("installations").updateOne(
      { _id: id },
      {
        $set: {
          "pos.generated.healthStatsToken": encrypt(
            "bad token\r\nx-injected: 1",
            VAULT_KEY,
            `pos:${id}:generated.healthStatsToken`,
          ),
        },
      },
    );
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.site.state, "up");
    assert.equal(last.mongo.statsCode, "stats-token-invalid");
    for (const call of env.calls)
      assert.equal(call.options.headers["x-stats-token"], undefined);
  });
  it("retries are plain probes 5 s apart; no stats request for a site that is down", async () => {
    const env = await makeEnv();
    env.site("demo", [{ status: 500, text: "boom" }]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env, { t: { usageRetryMs: 5000 } });
    await loop.drain();
    assert.equal(env.calls.length, 3);
    for (const call of env.calls) assert.equal(call.options.query, undefined);
    assert.equal(env.sleeps.filter((ms) => ms === 5000).length, 2);
    assert.equal(
      (await usageOf(env, id)).last.alerts["site-down"].level,
      "critical",
    );
  });
  it("a bad or blocked host is a setup problem: probed once, no site-down alert", async () => {
    const env = await makeEnv();
    const id = await seed(env, { pos: { host: "127.0.0.1" } });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.site.state, "down");
    assert.equal(last.site.code, "bad-host");
    assert.equal(last.site.probes, 1);
    assert.equal(last.alerts["site-down"], undefined);
  });
  it("a queued (not running) deploy does not hide an outage", async () => {
    const env = await makeEnv();
    env.site("demo", [{ status: 502, text: "bad gateway" }]);
    const id = await seed(env, {
      pos: { deploy: { current: { status: "queued" }, last: null } },
    });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.site.deployActive, false);
    assert.equal(last.alerts["site-down"].level, "critical");
  });
  it("an account-owned Cloudflare token without an account id has an unknown expiry, not invalid", async () => {
    const env = await makeEnv();
    env.cf.state.verify = null; // the user form answers 401
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env, { cfAccount: false });
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const { last } = await usageOf(env, id);
    assert.equal(last.credentials.cloudflare.code, "expiry-unknown");
    assert.equal(last.alerts.credential, undefined);
    assert.equal(last.cloudflare.code, "cf-not-set");
  });
  it("a usage check does not count as an active job for the deploy disk check", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.1))]);
    const id = await seed(env);
    await queue(env, id);
    const w = await makeWorker(env);
    let seen = null;
    env.hook = async () => {
      env.hook = null;
      seen = w.ctx.activeJobs ?? 0;
    };
    await w.loop.drain();
    assert.equal(seen, 0);
  });
  it("the older result of a failed batch member is never mailed as current", async () => {
    const env = await makeEnv();
    const id = await seed(env, { slug: "old" });
    const batchId = randomUUID();
    await pausedDone(env, id, batchId); // an old critical result...
    await queue(env, id, {
      batchId,
      status: "running",
      attempt: 3,
      lease: { owner: "w-dead", until: new Date(env.clock.t - 1000), fence: 2 },
    }); // ...and this batch's check is about to fail (too many attempts)
    const { loop } = await makeWorker(env);
    await loop.drain();
    assert.equal((await usageOf(env, id)).check.status, "failed");
    assert.equal(env.notices.length, 0);
  });
  it("checks expired at boot still let the batch mail what finished", async () => {
    const env = await makeEnv();
    const a = await seed(env, { slug: "stop" });
    const b = await seed(env, { slug: "late" });
    const batchId = randomUUID();
    await pausedDone(env, a, batchId);
    await queue(env, b, { batchId });
    await env.db
      .collection("system_state")
      .updateOne(
        { _id: "pos-worker" },
        { $set: { at: new Date(env.clock.t - 11 * 60000) } },
      );
    await makeWorker(env);
    assert.equal((await usageOf(env, b)).check.status, "expired");
    assert.equal(env.notices.length, 1);
    assert.match(env.notices[0].text, /Cafe stop \(stop\)/);
    assert.match(env.notices[0].text, /1 could not be checked/);
  });
  it("two overlapping senders mail a batch once", async () => {
    const env = await makeEnv();
    const a = await seed(env, { slug: "stop" });
    const batchId = randomUUID();
    await pausedDone(env, a, batchId);
    const { ctx } = await makeWorker(env);
    const sent = await Promise.all([
      mailBatchSummary(ctx, batchId),
      mailBatchSummary(ctx, batchId),
    ]);
    assert.equal(env.notices.length, 1);
    assert.deepEqual(sent.sort(), [false, true]);
  });
  it("the mail memory never recreates a POS block removed while mailing", async () => {
    const env = await makeEnv();
    const a = await seed(env, { slug: "stop" });
    const batchId = randomUUID();
    await pausedDone(env, a, batchId);
    const { ctx } = await makeWorker(env);
    env.onMail = async () => {
      env.onMail = null;
      await env.db
        .collection("installations")
        .updateOne({ _id: a }, { $unset: { pos: "" } });
    };
    assert.equal(await mailBatchSummary(ctx, batchId), true);
    const row = await env.db.collection("installations").findOne({ _id: a });
    assert.equal(row.pos, undefined);
  });
});

describe("review fixes, round 2", () => {
  it("every code literal in usage.js is in the usage code table (static scan)", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(
      new URL("../backend/worker/usage.js", import.meta.url),
      "utf8",
    );
    const found = new Set();
    for (const m of text.matchAll(/\bcode:\s*"([a-z0-9-]+)"/g)) found.add(m[1]);
    for (const m of text.matchAll(/\b(?:none|empty)\(\s*"([a-z0-9-]+)"/g))
      found.add(m[1]);
    for (const m of text.matchAll(
      /"((?:cf|token|stats|mongo|secret|expiry|check)-[a-z0-9-]+)"/g,
    ))
      found.add(m[1]);
    assert.ok(found.size >= 15, `the scan found ${found.size} codes`);
    const missing = [...found].filter((c) => !isUsageCode(c));
    assert.deepEqual(missing, []);
  });
  it("a check that runs out of time keeps the previous result and fails as check-timeout", async () => {
    const env = await makeEnv();
    env.site("demo", [healthOk("demo", coreAt(0.4))]);
    const id = await seed(env);
    await queue(env, id);
    const { loop } = await makeWorker(env);
    await loop.drain();
    const first = (await usageOf(env, id)).last;
    env.site("demo", [healthOk("demo", coreAt(0.9))]);
    env.hook = async () => new Promise((resolve) => setTimeout(resolve, 40));
    await queue(env, id);
    const slow = await makeWorker(env, { t: { usageBudgetMs: 5 } });
    await slow.loop.drain();
    const usage = await usageOf(env, id);
    assert.equal(usage.check.status, "failed");
    assert.deepEqual(usage.check.error, { code: "check-timeout" });
    assert.equal(usage.last.mongo.maxPct, first.mongo.maxPct);
    assert.equal(usage.last.at.getTime(), first.at.getTime());
    // out of budget: no direct database call was made for a result that is
    // thrown away anyway
    assert.equal(env.mongoCalls.length, 0);
  });
  it("a failure while composing the email frees the marker too", async () => {
    const env = await makeEnv();
    const a = await seed(env, { slug: "stop" });
    const batchId = randomUUID();
    await env.db.collection("installations").updateOne(
      { _id: a },
      {
        $set: {
          "pos.usage.check": {
            id: batchId,
            status: "done",
            batchId,
            requestedAt: new Date(env.clock.t),
            lease: { owner: "w-x", until: new Date(env.clock.t), fence: 1 },
            attempt: 1,
          },
          "pos.usage.last": {
            at: new Date(env.clock.t),
            alerts: {
              "site-paused": {
                level: "critical",
                value: null,
                detail: "Vercel answered 503 DEPLOYMENT_PAUSED",
              },
            },
            level: "critical",
          },
        },
      },
    );
    const { ctx } = await makeWorker(env);
    let thrown = false;
    env.db.collection = (name, ...rest) => {
      if (name === "customers" && !thrown) {
        thrown = true;
        return {
          find: () => {
            throw new Error("database hiccup");
          },
        };
      }
      return Object.getPrototypeOf(env.db).collection.call(
        env.db,
        name,
        ...rest,
      );
    };
    try {
      await assert.rejects(mailBatchSummary(ctx, batchId), /database hiccup/);
    } finally {
      delete env.db.collection;
    }
    assert.equal(env.notices.length, 0);
    assert.equal(await mailBatchSummary(ctx, batchId), true);
    assert.equal(env.notices.length, 1);
  });
  it("an email that could not be sent frees the batch marker for a retry", async () => {
    const env = await makeEnv();
    const a = await seed(env, { slug: "stop" });
    const batchId = randomUUID();
    await env.db.collection("installations").updateOne(
      { _id: a },
      {
        $set: {
          "pos.usage.check": {
            id: batchId,
            status: "done",
            batchId,
            requestedAt: new Date(env.clock.t),
            lease: { owner: "w-x", until: new Date(env.clock.t), fence: 1 },
            attempt: 1,
          },
          "pos.usage.last": {
            at: new Date(env.clock.t),
            alerts: {
              "site-paused": {
                level: "critical",
                value: null,
                detail: "Vercel answered 503 DEPLOYMENT_PAUSED",
              },
            },
            level: "critical",
          },
        },
      },
    );
    const { ctx } = await makeWorker(env);
    env.failMail = true;
    assert.equal(await mailBatchSummary(ctx, batchId), false);
    env.failMail = false;
    assert.equal(await mailBatchSummary(ctx, batchId), true);
    assert.equal(env.notices.length, 1);
    // with no active owner nothing is claimed or sent
    await env.db
      .collection("staff")
      .updateMany({}, { $set: { status: "disabled" } });
    const other = randomUUID();
    await env.db.collection("installations").updateOne(
      { _id: a },
      {
        $set: {
          "pos.usage.check.batchId": other,
          "pos.usage.mail": {},
        },
      },
    );
    assert.equal(await mailBatchSummary(ctx, other), false);
    assert.equal(env.notices.length, 1);
  });
});
