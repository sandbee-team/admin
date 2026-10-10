// Phase 2 (U1): shared usage rules, the usage code table and the adapters the
// usage check calls (site probe with stats, direct dbStats, Cloudflare
// GraphQL, token expiry). No network: every provider is a fake.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  ACTIVE_CHECK_STATES,
  ALERT_TYPES,
  CHECK_STATES,
  CRIT_PCT,
  HOBBY_LIMITS,
  MAIL_EVERY_MS,
  MONGO_LIMIT_BYTES,
  SITE_ATTEMPTS,
  WARN_PCT,
  WORKER_FREE_REQUESTS,
  credentialLevel,
  dueMail,
  evaluateAlerts,
  levelOf,
  maxLevel,
  pctText,
  utcDay,
  utcDayStart,
} from "../shared/usage.js";
import {
  USAGE_CODES,
  describeUsageCode,
  isUsageCode,
  knownUsageCode,
} from "../shared/usage-codes.js";
import { getText, SafeHttpsError } from "../backend/lib/safe-https.js";
import {
  isPaused,
  parseStats,
  probeHealth,
  probeSite,
} from "../backend/lib/pos-health.js";
import {
  ClientMongoError,
  clientDbStats,
} from "../backend/lib/client-mongo.js";
import {
  tokenStatus,
  verifyToken,
  workerRequests,
} from "../backend/lib/cloudflare.js";
import { createVercel } from "../backend/lib/vercel.js";
import { ProviderError } from "../backend/lib/provider-http.js";
import { createFakeHealth } from "./fakes/health.js";
import { createFakeVercel } from "./fakes/vercel.js";
import { ACCOUNT_ID, createFakeCloudflare } from "./fakes/cloudflare.js";
import { assertNoSecrets } from "./helpers.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 11, 10, 30, 0);
const HOST = "demo.example.com";
const STATS_TOKEN = "stats-token-plaintext-0123456789";
const CF_TOKEN = "cf-token-plaintext-abcdefghijklmnop";
const VC_TOKEN = "vc-token-plaintext-abcdefghijklmnop";
const okBody = (extra = {}) => ({
  ok: true,
  db: "up",
  tenant: "demo",
  ts: NOW,
  ...extra,
});
const cluster = (name, bytes, extra = {}) => ({
  name,
  role: "core",
  state: "ok",
  usedPct: Math.round((bytes / MONGO_LIMIT_BYTES) * 10000) / 10000,
  dataSize: Math.round(bytes * 0.8),
  indexSize: bytes - Math.round(bytes * 0.8),
  ...extra,
});

describe("shared/usage limits and helpers", () => {
  it("pins the free-tier limits and rules of the approved plan (rev 2)", () => {
    assert.equal(MONGO_LIMIT_BYTES, 512 * 1024 * 1024);
    assert.equal(WORKER_FREE_REQUESTS, 100000);
    assert.equal(WARN_PCT, 0.75);
    assert.equal(CRIT_PCT, 0.9);
    assert.equal(SITE_ATTEMPTS, 3);
    assert.equal(MAIL_EVERY_MS, DAY);
    assert.deepEqual(CHECK_STATES, [
      "queued",
      "running",
      "done",
      "failed",
      "expired",
    ]);
    assert.deepEqual(ACTIVE_CHECK_STATES, ["queued", "running"]);
    assert.deepEqual(ALERT_TYPES, [
      "storage",
      "workers",
      "site-down",
      "site-paused",
      "credential",
    ]);
    assert.ok(HOBBY_LIMITS.length >= 4);
    for (const item of HOBBY_LIMITS) {
      assert.equal(typeof item.label, "string");
      assert.equal(typeof item.value, "string");
    }
  });
  it("levels, percent text and UTC days", () => {
    assert.equal(levelOf(null), "ok");
    assert.equal(levelOf(0.7499), "ok");
    assert.equal(levelOf(0.75), "warning");
    assert.equal(levelOf(0.8999), "warning");
    assert.equal(levelOf(0.9), "critical");
    assert.equal(levelOf(1.2), "critical");
    assert.equal(maxLevel(["ok", "warning", "ok"]), "warning");
    assert.equal(maxLevel(["warning", "critical"]), "critical");
    assert.equal(maxLevel([]), "ok");
    assert.equal(pctText(0.91234), "91.2%");
    assert.equal(pctText(0), "0%");
    assert.equal(utcDay(NOW), "2026-10-11");
    assert.equal(utcDay(Date.UTC(2026, 9, 11, 23, 59, 59)), "2026-10-11");
    assert.equal(utcDayStart(NOW), Date.UTC(2026, 9, 11));
  });
});

describe("credentialLevel", () => {
  it("is critical for invalid, expired or <= 3 days and warning for <= 14 days", () => {
    assert.equal(credentialLevel({ code: "token-invalid" }, NOW), "critical");
    assert.equal(
      credentialLevel({ code: "ok", expiresAt: NOW - 1000 }, NOW),
      "critical",
    );
    assert.equal(
      credentialLevel({ code: "ok", expiresAt: NOW + 3 * DAY }, NOW),
      "critical",
    );
    assert.equal(
      credentialLevel({ code: "ok", expiresAt: NOW + 3 * DAY + 1000 }, NOW),
      "warning",
    );
    assert.equal(
      credentialLevel({ code: "ok", expiresAt: NOW + 14 * DAY }, NOW),
      "warning",
    );
    assert.equal(
      credentialLevel({ code: "ok", expiresAt: NOW + 15 * DAY }, NOW),
      null,
    );
    assert.equal(credentialLevel({ code: "ok", expiresAt: null }, NOW), null);
    assert.equal(credentialLevel({ code: "expiry-unknown" }, NOW), null);
    assert.equal(credentialLevel({ code: "token-not-set" }, NOW), null);
    assert.equal(credentialLevel(null, NOW), null);
  });
});

describe("evaluateAlerts (one check, current state only)", () => {
  const result = (over = {}) => ({
    site: { state: "up", code: "ok", deployActive: false },
    mongo: {
      clusters: [{ name: "core", state: "ok", usedPct: 0.4 }],
    },
    cloudflare: { code: "ok", day: utcDay(NOW), requests: 1000 },
    credentials: {
      vercel: { code: "ok", expiresAt: null },
      cloudflare: { code: "ok", expiresAt: null },
    },
    ...over,
  });
  it("is ok for a healthy client", () => {
    assert.deepEqual(evaluateAlerts(result(), NOW), {
      alerts: {},
      level: "ok",
    });
  });
  it("storage: 75 % warning / 90 % critical on the fullest ok cluster", () => {
    const warn = evaluateAlerts(
      result({
        mongo: {
          clusters: [
            { name: "core", state: "ok", usedPct: 0.3 },
            { name: "ledger-a", state: "ok", usedPct: 0.8, bytes: 429496730 },
            { name: "ledger-b", state: "error", usedPct: null },
          ],
        },
      }),
      NOW,
    );
    assert.equal(warn.alerts.storage.level, "warning");
    assert.equal(warn.alerts.storage.value, 0.8);
    assert.match(warn.alerts.storage.detail, /ledger-a/);
    assert.match(warn.alerts.storage.detail, /80%/);
    assert.match(warn.alerts.storage.detail, /410 MB/);
    assert.equal(warn.level, "warning");
    const crit = evaluateAlerts(
      result({
        mongo: { clusters: [{ name: "core", state: "ok", usedPct: 0.9 }] },
      }),
      NOW,
    );
    assert.equal(crit.alerts.storage.level, "critical");
    assert.equal(crit.level, "critical");
    assert.deepEqual(
      evaluateAlerts(result({ mongo: { clusters: [] } }), NOW).alerts,
      {},
    );
    assert.deepEqual(evaluateAlerts(result({ mongo: null }), NOW).alerts, {});
  });
  it("Worker requests: only today's UTC count counts", () => {
    const today = evaluateAlerts(
      result({ cloudflare: { code: "ok", day: utcDay(NOW), requests: 76000 } }),
      NOW,
    );
    assert.equal(today.alerts.workers.level, "warning");
    assert.match(today.alerts.workers.detail, /76,000/);
    const old = evaluateAlerts(
      result({
        cloudflare: { code: "ok", day: utcDay(NOW - DAY), requests: 95000 },
      }),
      NOW,
    );
    assert.equal(old.alerts.workers, undefined);
    const crit = evaluateAlerts(
      result({ cloudflare: { code: "ok", day: utcDay(NOW), requests: 90000 } }),
      NOW,
    );
    assert.equal(crit.alerts.workers.level, "critical");
    const denied = evaluateAlerts(
      result({ cloudflare: { code: "cf-denied", day: null, requests: null } }),
      NOW,
    );
    assert.equal(denied.alerts.workers, undefined);
  });
  it("site: down (after the check's 3 probes) and paused are critical; not during a deploy", () => {
    const down = evaluateAlerts(
      result({
        site: {
          state: "down",
          code: "timeout",
          probes: 3,
          deployActive: false,
        },
      }),
      NOW,
    );
    assert.equal(down.alerts["site-down"].level, "critical");
    assert.match(down.alerts["site-down"].detail, /3/);
    const deploying = evaluateAlerts(
      result({
        site: { state: "down", code: "timeout", probes: 3, deployActive: true },
      }),
      NOW,
    );
    assert.equal(deploying.alerts["site-down"], undefined);
    // a bad or blocked host is probed once: a setup problem, not an outage
    const once = evaluateAlerts(
      result({ site: { state: "down", code: "blocked", probes: 1 } }),
      NOW,
    );
    assert.equal(once.alerts["site-down"], undefined);
    const paused = evaluateAlerts(
      result({
        site: { state: "paused", code: "paused", deployActive: false },
      }),
      NOW,
    );
    assert.equal(paused.alerts["site-paused"].level, "critical");
    assert.equal(paused.alerts["site-down"], undefined);
    const noHost = evaluateAlerts(
      result({ site: { state: "unknown", code: "no-host" } }),
      NOW,
    );
    assert.deepEqual(noHost.alerts, {});
  });
  it("credential takes the worse token and names both services", () => {
    const r = evaluateAlerts(
      result({
        credentials: {
          vercel: { code: "ok", expiresAt: NOW + 10 * DAY },
          cloudflare: { code: "token-invalid", expiresAt: null },
        },
      }),
      NOW,
    );
    assert.equal(r.alerts.credential.level, "critical");
    assert.match(r.alerts.credential.detail, /Cloudflare token is invalid/);
    assert.match(r.alerts.credential.detail, /Vercel token expires in 10 days/);
  });
  it("orders alert types and keeps details short", () => {
    const r = evaluateAlerts(
      result({
        site: { state: "paused", code: "paused" },
        mongo: { clusters: [{ name: "core", state: "ok", usedPct: 0.95 }] },
        cloudflare: { code: "ok", day: utcDay(NOW), requests: 99000 },
      }),
      NOW,
    );
    assert.deepEqual(Object.keys(r.alerts), [
      "storage",
      "workers",
      "site-paused",
    ]);
    for (const alert of Object.values(r.alerts))
      assert.ok(alert.detail.length <= 120);
  });
});

describe("dueMail (24 h per client per type, one escalation)", () => {
  const warn = { storage: { level: "warning", value: 0.8, detail: "x" } };
  const crit = { storage: { level: "critical", value: 0.93, detail: "x" } };
  it("is due when never sent or sent 24 h ago", () => {
    assert.deepEqual(dueMail(undefined, warn, NOW), [
      { type: "storage", level: "warning" },
    ]);
    const mail = { storage: { at: new Date(NOW), level: "warning" } };
    assert.deepEqual(dueMail(mail, warn, NOW + 3600000), []);
    assert.deepEqual(dueMail(mail, warn, NOW + MAIL_EVERY_MS), [
      { type: "storage", level: "warning" },
    ]);
  });
  it("allows one warning -> critical escalation inside 24 h", () => {
    const mail = { storage: { at: new Date(NOW), level: "warning" } };
    assert.deepEqual(dueMail(mail, crit, NOW + 7200000), [
      { type: "storage", level: "critical" },
    ]);
    const escalated = {
      storage: { at: new Date(NOW + 7200000), level: "critical" },
    };
    assert.deepEqual(dueMail(escalated, crit, NOW + 8000000), []);
    assert.deepEqual(dueMail(escalated, warn, NOW + 8000000), []);
  });
  it("ignores unknown types and garbage mail state", () => {
    assert.deepEqual(
      dueMail({ storage: { at: "nonsense", level: "x" } }, warn, NOW),
      [{ type: "storage", level: "warning" }],
    );
    assert.deepEqual(
      dueMail(undefined, { bogus: { level: "critical" } }, NOW),
      [],
    );
    assert.deepEqual(dueMail(undefined, {}, NOW), []);
    // a mail time in the future (clock skew) does not suppress mail
    assert.deepEqual(
      dueMail(
        { storage: { at: new Date(NOW + DAY), level: "warning" } },
        warn,
        NOW,
      ),
      [{ type: "storage", level: "warning" }],
    );
    assert.deepEqual(dueMail(undefined, null, NOW), []);
  });
});

describe("shared/usage-codes", () => {
  it("every code is well formed with a short message", () => {
    for (const [code, entry] of Object.entries(USAGE_CODES)) {
      assert.match(code, /^[a-z0-9-]{1,40}$/);
      assert.ok(entry.title && entry.plainMessage && entry.action, code);
      assert.ok(entry.plainMessage.length <= 160, code);
    }
  });
  it("covers every code the adapters and the worker emit", () => {
    for (const code of [
      "ok",
      "paused",
      "http-error",
      "db-down",
      "bad-body",
      "tenant-mismatch",
      "timeout",
      "no-response",
      "blocked",
      "bad-host",
      "too-large",
      "aborted",
      "stats-denied",
      "stats-error",
      "stats-not-set",
      "stats-bad-body",
      "stats-unavailable",
      "mongo-not-set",
      "mongo-invalid",
      "mongo-not-atlas",
      "mongo-auth-failed",
      "mongo-unreachable",
      "mongo-stats-failed",
      "cf-not-set",
      "cf-denied",
      "cf-unauthorized",
      "cf-rate-limited",
      "cf-unavailable",
      "cf-bad-response",
      "cf-failed",
      "token-not-set",
      "token-invalid",
      "expiry-unknown",
      "token-check-failed",
      "no-host",
      "secret-unreadable",
      "stats-host-changed",
      "stats-token-invalid",
      "not-picked-up",
      "worker-stopped",
      "internal",
    ])
      assert.equal(isUsageCode(code), true, code);
  });
  it("describes unknown codes as internal and refuses free text", () => {
    assert.equal(describeUsageCode("nope"), USAGE_CODES.internal);
    assert.equal(knownUsageCode("paused"), "paused");
    assert.throws(() => knownUsageCode("Some free text"), /Unknown usage code/);
    assert.equal(isUsageCode("constructor"), false);
    assert.equal(describeUsageCode("constructor"), USAGE_CODES.internal);
    assert.equal(describeUsageCode("toString"), USAGE_CODES.internal);
  });
});

describe("safe-https getText query option", () => {
  const seen = [];
  const send = async (options) => {
    seen.push(options.path);
    return { status: 200, headers: {}, text: "{}" };
  };
  it("appends an allowlisted query and keeps the default path unchanged", async () => {
    await getText(HOST, "/api/health", { send });
    await getText(HOST, "/api/health", { send, query: { stats: "1" } });
    await getText(HOST, "/api/health", {
      send,
      query: { a: "x", b: "Y.1_-" },
    });
    assert.deepEqual(seen, [
      "/api/health",
      "/api/health?stats=1",
      "/api/health?a=x&b=Y.1_-",
    ]);
  });
  it("an already-aborted signal sends nothing", async () => {
    await assert.rejects(
      getText(HOST, "/api/health", {
        signal: AbortSignal.abort(),
        lookup: () => {
          throw new Error("no lookup may happen");
        },
      }),
      (error) => error instanceof SafeHttpsError && error.code === "aborted",
    );
  });
  it("refuses anything outside the allowlist as bad-path", async () => {
    for (const query of [
      {},
      [],
      "stats=1",
      { stats: 1 },
      { Stats: "1" },
      { stats: "1&x=2" },
      { stats: "" },
      { stats: "a b" },
      { "x-y": "1" },
      { a: "1", b: "1", c: "1", d: "1", e: "1" },
      { stats: "x".repeat(41) },
    ])
      await assert.rejects(
        getText(HOST, "/api/health", { send, query }),
        (error) => error instanceof SafeHttpsError && error.code === "bad-path",
        JSON.stringify(query),
      );
  });
});

describe("probeSite", () => {
  let t = 0;
  const now = () => t;
  const timed = (fake, ms) => ({
    get: async (...args) => {
      t += ms;
      return fake.get(...args);
    },
  });
  it("is up with latency and sends no stats request by default", async () => {
    const fake = createFakeHealth({
      health: [{ status: 200, body: okBody() }],
    });
    const r = await probeSite({
      host: HOST,
      tenantId: "demo",
      get: timed(fake, 240).get,
      now,
    });
    assert.deepEqual(r, {
      state: "up",
      code: "ok",
      httpStatus: 200,
      latencyMs: 240,
    });
    assert.equal(fake.calls[0].options.query, undefined);
    assert.equal(fake.calls[0].options.headers["x-stats-token"], undefined);
  });
  it("asks for stats with the token only when told to", async () => {
    const fake = createFakeHealth({
      health: [{ status: 200, body: okBody() }],
      stats: [
        {
          status: 200,
          body: okBody({ clusters: [cluster("core", 100 * 1024 * 1024)] }),
        },
      ],
    });
    const r = await probeSite({
      host: HOST,
      tenantId: "demo",
      get: fake.get,
      stats: true,
      statsToken: STATS_TOKEN,
      now,
    });
    assert.equal(r.state, "up");
    assert.equal(r.stats.code, "ok");
    assert.equal(r.stats.clusters[0].name, "core");
    assert.deepEqual(fake.calls[0].options.query, { stats: "1" });
    assert.equal(fake.calls[0].options.headers["x-stats-token"], STATS_TOKEN);
    assertNoSecrets(r, [STATS_TOKEN], "probe result");
  });
  it("without a token asks for stats without the header; denied reads as not set", async () => {
    const fake = createFakeHealth({
      stats: [{ status: 200, body: okBody({ stats: "denied" }) }],
    });
    const r = await probeSite({
      host: HOST,
      tenantId: "demo",
      get: fake.get,
      stats: true,
      statsToken: null,
      now,
    });
    assert.equal(fake.calls[0].options.headers["x-stats-token"], undefined);
    assert.equal(r.state, "up");
    assert.equal(r.stats.code, "stats-not-set");
    const withToken = createFakeHealth({
      stats: [{ status: 200, body: okBody({ stats: "denied" }) }],
    });
    const denied = await probeSite({
      host: HOST,
      tenantId: "demo",
      get: withToken.get,
      stats: true,
      statsToken: STATS_TOKEN,
      now,
    });
    assert.equal(denied.stats.code, "stats-denied");
  });
  it("detects a paused deployment by header or by body", async () => {
    for (const reply of [
      {
        status: 503,
        headers: { "x-vercel-error": "DEPLOYMENT_PAUSED" },
        text: "<html>paused</html>",
      },
      {
        status: 503,
        headers: { "content-type": "text/plain" },
        text: "503: SERVICE_UNAVAILABLE\nCode: DEPLOYMENT_PAUSED\nID: bom1::abc",
      },
    ]) {
      const fake = createFakeHealth({ health: [reply] });
      const r = await probeSite({
        host: HOST,
        tenantId: "demo",
        get: fake.get,
        now,
      });
      assert.equal(r.state, "paused");
      assert.equal(r.code, "paused");
      assert.equal(r.httpStatus, 503);
    }
    assert.equal(
      isPaused(500, { "x-vercel-error": "DEPLOYMENT_PAUSED" }),
      false,
    );
    assert.equal(isPaused(503, {}, "Service Unavailable"), false);
    assert.equal(
      isPaused(503, { "x-vercel-error": ["X", "DEPLOYMENT_PAUSED"] }, ""),
      true,
    );
  });
  it("maps failures to fixed codes and never echoes the body", async () => {
    const cases = [
      [{ status: 503, body: { ok: false, db: "down" } }, "db-down", 503],
      [{ status: 500, text: "secret stack trace" }, "http-error", 500],
      [{ status: 200, text: "not json" }, "bad-body", 200],
      [
        { status: 200, body: okBody({ tenant: "other" }) },
        "tenant-mismatch",
        200,
      ],
    ];
    for (const [reply, code, httpStatus] of cases) {
      const fake = createFakeHealth({ health: [reply] });
      const r = await probeSite({
        host: HOST,
        tenantId: "demo",
        get: fake.get,
        now,
      });
      assert.equal(r.state, "down", code);
      assert.equal(r.code, code);
      assert.equal(r.httpStatus, httpStatus);
      assert.equal(JSON.stringify(r).includes("secret"), false);
    }
    for (const [errorCode, code] of [
      ["timeout", "timeout"],
      ["blocked", "blocked"],
      ["too-large", "too-large"],
      ["network", "no-response"],
      ["aborted", "aborted"],
      ["ECONNRESET", "no-response"],
    ]) {
      const fake = createFakeHealth({
        health: [Object.assign(new Error("x"), { code: errorCode })],
      });
      const r = await probeSite({
        host: HOST,
        tenantId: "demo",
        get: fake.get,
        now,
      });
      assert.deepEqual(r, {
        state: "down",
        code,
        httpStatus: 0,
        latencyMs: null,
      });
    }
    const bad = await probeSite({ host: "127.0.0.1", tenantId: "demo", now });
    assert.equal(bad.code, "bad-host");
  });
  it("stats are not parsed from a failed health answer", async () => {
    const fake = createFakeHealth({
      stats: [{ status: 503, body: { ok: false, db: "down" } }],
    });
    const r = await probeSite({
      host: HOST,
      tenantId: "demo",
      get: fake.get,
      stats: true,
      statsToken: STATS_TOKEN,
      now,
    });
    assert.equal(r.state, "down");
    assert.equal(r.stats.code, "stats-unavailable");
  });
  it("leaves probeHealth (deploy verdict) unchanged", async () => {
    const fake = createFakeHealth({
      health: [{ status: 200, body: okBody() }],
    });
    assert.deepEqual(
      await probeHealth({ host: HOST, tenantId: "demo", get: fake.get }),
      { ok: true, reason: "ok" },
    );
    assert.equal(fake.calls[0].path, "/api/health");
    assert.equal(fake.calls[0].options.query, undefined);
  });
});

describe("parseStats", () => {
  it("reads denied, error and malformed bodies as codes", () => {
    assert.deepEqual(parseStats(okBody({ stats: "denied" })), {
      code: "stats-denied",
      bootstrap: false,
      clusters: [],
    });
    assert.equal(parseStats(okBody({ stats: "error" })).code, "stats-error");
    assert.equal(parseStats(okBody()).code, "stats-bad-body");
    assert.equal(parseStats(null).code, "stats-bad-body");
    assert.equal(parseStats(okBody({ clusters: "x" })).code, "stats-bad-body");
    assert.equal(parseStats(okBody({ clusters: [] })).code, "stats-bad-body");
  });
  it("reads core, ledgers and standbys and recomputes the fraction from bytes", () => {
    const r = parseStats(
      okBody({
        bootstrap: false,
        clusters: [
          cluster("core", 50 * 1024 * 1024, { tag: "C" }),
          cluster("ledger-a", 400 * 1024 * 1024, {
            role: "ledger",
            tag: "A",
            active: true,
            usedPct: 0.01, // ignored: bytes are authoritative
          }),
          cluster("standby-1", 1024, { role: "standby", paused: true }),
          { name: "ledger-b", role: "ledger", state: "error", tag: "A2" },
        ],
      }),
    );
    assert.equal(r.code, "ok");
    assert.equal(r.bootstrap, false);
    assert.equal(r.clusters.length, 4);
    const ledger = r.clusters[1];
    assert.equal(ledger.role, "ledger");
    assert.equal(ledger.active, true);
    assert.equal(ledger.label, "A");
    assert.equal(ledger.bytes, 400 * 1024 * 1024);
    assert.equal(ledger.usedPct, 0.7813);
    assert.equal(r.clusters[2].paused, true);
    assert.deepEqual(r.clusters[3], {
      name: "ledger-b",
      role: "ledger",
      label: "A2",
      active: false,
      paused: false,
      state: "error",
      usedPct: null,
      bytes: null,
    });
  });
  it("drops rows with bad names, roles, duplicates or absurd numbers and caps at 12", () => {
    const rows = [
      cluster("core", 1000),
      cluster("core", 2000),
      cluster("Bad Name", 1000),
      cluster("x".repeat(41), 1000),
      cluster("$where", 1000),
      cluster("a.b", 1000),
      cluster("ok-role", 1000, { role: "primary" }),
      {
        name: "huge",
        role: "ledger",
        state: "ok",
        dataSize: 2e12,
        indexSize: 1,
      },
      { name: "neg", role: "ledger", state: "ok", dataSize: -1, indexSize: 1 },
      { name: "pct-only", role: "ledger", state: "ok", usedPct: 0.5 },
      { name: "pct-bad", role: "ledger", state: "ok", usedPct: 7 },
      ...Array.from({ length: 20 }, (_, i) => cluster(`l${i}`, 1000 + i)),
    ];
    const r = parseStats(okBody({ clusters: rows, bootstrap: true }));
    assert.equal(r.bootstrap, true);
    const names = r.clusters.map((c) => c.name);
    assert.equal(names[0], "core");
    assert.equal(names.filter((n) => n === "core").length, 1);
    for (const bad of ["Bad Name", "$where", "a.b", "ok-role"])
      assert.equal(names.includes(bad), false, bad);
    assert.ok(r.clusters.length <= 12);
    const huge = r.clusters.find((c) => c.name === "huge");
    assert.equal(huge.state, "error");
    assert.equal(huge.bytes, null);
    const neg = r.clusters.find((c) => c.name === "neg");
    assert.equal(neg.state, "error");
    const pctOnly = r.clusters.find((c) => c.name === "pct-only");
    assert.equal(pctOnly.usedPct, 0.5);
    assert.equal(pctOnly.bytes, null);
    const pctBad = r.clusters.find((c) => c.name === "pct-bad");
    assert.equal(pctBad.state, "error");
  });
});

describe("clientDbStats", () => {
  let repl;
  before(async () => {
    repl = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" },
    });
  });
  after(async () => repl?.stop());
  it("returns dataSize and indexSize of the URI's database and closes", async () => {
    const uri = repl.getUri("usageclient");
    const { MongoClient } = await import("mongodb");
    const seed = new MongoClient(uri);
    await seed.connect();
    await seed
      .db()
      .collection("orders")
      .insertMany(
        Array.from({ length: 50 }, (_, i) => ({ i, pad: "x".repeat(200) })),
      );
    await seed.close();
    const stats = await clientDbStats(uri, { allowHost: () => true });
    assert.ok(stats.dataSize > 10000);
    assert.ok(stats.indexSize > 0);
    assert.deepEqual(Object.keys(stats).sort(), ["dataSize", "indexSize"]);
  });
  it("refuses non-Atlas hosts and maps failures to codes without the URI", async () => {
    await assert.rejects(
      clientDbStats("mongodb://user:pw@127.0.0.1:1/db"),
      (e) => e instanceof ClientMongoError && e.code === "not-atlas",
    );
    await assert.rejects(
      clientDbStats("nope"),
      (e) => e instanceof ClientMongoError && e.code === "invalid",
    );
    class Throwing {
      async connect() {}
      db() {
        return {
          command: async () => {
            throw Object.assign(new Error("mongodb+srv://u:secretpw@x"), {
              code: 2,
            });
          },
        };
      }
      async close() {
        this.closed = true;
      }
    }
    await assert.rejects(
      clientDbStats("mongodb+srv://u:secretpw@c0.abcde.mongodb.net/db", {
        Client: Throwing,
      }),
      (e) =>
        e instanceof ClientMongoError &&
        e.code === "stats-failed" &&
        !e.message.includes("secretpw"),
    );
    class Garbage extends Throwing {
      db() {
        return { command: async () => ({ dataSize: "x", indexSize: 1 }) };
      }
    }
    await assert.rejects(
      clientDbStats("mongodb+srv://u:pw@c0.abcde.mongodb.net/db", {
        Client: Garbage,
      }),
      (e) => e.code === "stats-failed",
    );
  });
});

describe("Cloudflare token status and Worker requests", () => {
  it("tokenStatus adds status and expiry; verifyToken stays {ok, form}", async () => {
    const cf = createFakeCloudflare({
      verify: { status: "active", expires_on: "2026-12-31T00:00:00Z" },
    });
    assert.deepEqual(await tokenStatus(CF_TOKEN, "", { fetch: cf.fetch }), {
      ok: true,
      form: "user",
      status: "active",
      expiresOn: Date.UTC(2026, 11, 31),
    });
    assert.deepEqual(await verifyToken(CF_TOKEN, "", { fetch: cf.fetch }), {
      ok: true,
      form: "user",
    });
    const account = createFakeCloudflare({
      verify: null,
      accountVerify: { status: "active" },
    });
    assert.deepEqual(
      await tokenStatus(CF_TOKEN, ACCOUNT_ID, { fetch: account.fetch }),
      { ok: true, form: "account", status: "active", expiresOn: null },
    );
    const expired = createFakeCloudflare({
      verify: { status: "expired", expires_on: "2026-10-01T00:00:00Z" },
    });
    assert.deepEqual(
      await tokenStatus(CF_TOKEN, "", { fetch: expired.fetch }),
      {
        ok: false,
        form: null,
        status: "expired",
        expiresOn: Date.UTC(2026, 9, 1),
      },
    );
    const bad = createFakeCloudflare({
      verify: { status: "active", expires_on: "garbage" },
    });
    assert.equal(
      (await tokenStatus(CF_TOKEN, "", { fetch: bad.fetch })).expiresOn,
      null,
    );
  });
  it("queries today and yesterday (UTC) for the whole account with variables", async () => {
    const cf = createFakeCloudflare({
      today: [1200, 3],
      yesterday: [98000, 10],
    });
    const r = await workerRequests(CF_TOKEN, ACCOUNT_ID, {
      now: NOW,
      fetch: cf.fetch,
    });
    assert.deepEqual(r, {
      today: { requests: 1200, errors: 3 },
      yesterday: { requests: 98000, errors: 10 },
    });
    const call = cf.calls.find((c) => c.path === "/client/v4/graphql");
    assert.equal(call.method, "POST");
    assert.deepEqual(call.variables, {
      account: ACCOUNT_ID,
      todayFrom: "2026-10-11T00:00:00Z",
      todayTo: "2026-10-11T10:30:00Z",
      yesterdayFrom: "2026-10-10T00:00:00Z",
      yesterdayTo: "2026-10-10T23:59:59Z",
    });
    assert.equal(call.query.includes(ACCOUNT_ID), false);
    assert.match(call.query, /workersInvocationsAdaptive/);
  });
  it("sums several rows and reads no rows as zero", async () => {
    const cf = createFakeCloudflare({
      todayRows: [
        { sum: { requests: 5, errors: 1 } },
        { sum: { requests: 7, errors: 0 } },
      ],
      yesterdayRows: [],
    });
    assert.deepEqual(
      await workerRequests(CF_TOKEN, ACCOUNT_ID, { now: NOW, fetch: cf.fetch }),
      {
        today: { requests: 12, errors: 1 },
        yesterday: { requests: 0, errors: 0 },
      },
    );
  });
  it("maps GraphQL authz errors to denied and anything odd to bad-response", async () => {
    const denied = createFakeCloudflare({
      graphql: {
        data: null,
        errors: [
          {
            message: "not authorized for that account",
            extensions: { code: "authz" },
          },
        ],
      },
    });
    await assert.rejects(
      workerRequests(CF_TOKEN, ACCOUNT_ID, { now: NOW, fetch: denied.fetch }),
      (e) => e instanceof ProviderError && e.code === "denied",
    );
    const empty = createFakeCloudflare({
      graphql: { data: { viewer: { accounts: [] } } },
    });
    await assert.rejects(
      workerRequests(CF_TOKEN, ACCOUNT_ID, { now: NOW, fetch: empty.fetch }),
      (e) => e instanceof ProviderError && e.code === "denied",
      "a token that cannot see the account",
    );
    for (const graphql of [
      { data: null, errors: [{ message: "boom" }] },
      { data: { viewer: { accounts: [{}, {}] } } },
      { data: { viewer: { accounts: [{ today: "x", yesterday: [] }] } } },
      {
        data: {
          viewer: {
            accounts: [{ today: [{ sum: { requests: -1 } }], yesterday: [] }],
          },
        },
      },
    ]) {
      const cf = createFakeCloudflare({ graphql });
      await assert.rejects(
        workerRequests(CF_TOKEN, ACCOUNT_ID, { now: NOW, fetch: cf.fetch }),
        (e) => e instanceof ProviderError && e.code === "bad-response",
        JSON.stringify(graphql),
      );
    }
  });
  it("refuses a malformed account id before any request; errors carry no token", async () => {
    const cf = createFakeCloudflare({});
    await assert.rejects(
      workerRequests(CF_TOKEN, "not-an-account", { now: NOW, fetch: cf.fetch }),
      (e) => e instanceof ProviderError && e.code === "invalid",
    );
    assert.equal(cf.calls.length, 0);
    const failing = createFakeCloudflare({ graphqlStatus: 403 });
    await assert.rejects(
      workerRequests(CF_TOKEN, ACCOUNT_ID, {
        now: NOW,
        fetch: failing.fetch,
        sleep: async () => {},
      }),
      (e) =>
        e instanceof ProviderError &&
        e.code === "forbidden" &&
        !JSON.stringify({ ...e, message: e.message }).includes(CF_TOKEN),
    );
  });
});

describe("Vercel tokenInfo", () => {
  it("reads expiresAt from tokens/current without a team id", async () => {
    const fake = createFakeVercel({ teamId: "team_abc" });
    fake.state.token = { id: "tok_1", name: "admin", expiresAt: NOW + 5 * DAY };
    const vercel = createVercel({
      token: VC_TOKEN,
      teamId: "team_abc",
      fetch: fake.fetch,
    });
    assert.deepEqual(await vercel.tokenInfo(), { expiresAt: NOW + 5 * DAY });
    const call = fake.calls.find((c) => c.path === "/v5/user/tokens/current");
    assert.deepEqual(call.query, {});
  });
  it("is null for a token without expiry and fails cleanly otherwise", async () => {
    const fake = createFakeVercel();
    fake.state.token = { id: "tok_1", name: "admin" };
    const vercel = createVercel({ token: VC_TOKEN, fetch: fake.fetch });
    assert.deepEqual(await vercel.tokenInfo(), { expiresAt: null });
    fake.state.token = null;
    await assert.rejects(
      vercel.tokenInfo(),
      (e) => e instanceof ProviderError && e.code === "bad-response",
    );
    const denied = createFakeVercel();
    denied.rule(
      (method, path) => path === "/v5/user/tokens/current",
      () =>
        new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );
    await assert.rejects(
      createVercel({ token: VC_TOKEN, fetch: denied.fetch }).tokenInfo(),
      (e) => e instanceof ProviderError && e.code === "forbidden",
    );
  });
});
