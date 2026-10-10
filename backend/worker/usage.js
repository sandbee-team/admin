// Phase 2 usage checks (docs/PHASE2-PLAN.md rev 2). Runs ONLY what the owner
// queued in `pos.usage.check` (the API enqueues; nothing is scheduled), one
// installation at a time on the `usage` lane: site + storage (the cafe's health
// stats, else dbStats through the stored URI), Cloudflare Worker requests and
// token expiry. Only the current result is stored, in `pos.usage.last`, as fixed
// codes and bounded numbers: never a secret, a URL or provider text. When the
// last check of a "Check watched clients" batch ends, one summary email lists
// the alerts not emailed in the last 24 hours.
import { ProviderError } from "../lib/provider-http.js";
import { ClientMongoError } from "../lib/client-mongo.js";
import { probeSite } from "../lib/pos-health.js";
import { workerRequests } from "../lib/cloudflare.js";
import { cleanText } from "../lib/deploy-view.js";
import { clearLimit, consume } from "../lib/limiter.js";
import {
  ACTIVE_CHECK_STATES,
  ALERT_TITLES,
  MAX_CHECK_ATTEMPTS,
  MONGO_LIMIT_BYTES,
  SITE_ATTEMPTS,
  WORKER_FREE_REQUESTS,
  dueMail,
  evaluateAlerts,
  pctText,
  utcDay,
} from "../../shared/usage.js";
import { isUsageCode } from "../../shared/usage-codes.js";
import { LeaseLost, createSlot, queueStale, withLease } from "./lease.js";
import { openSecret } from "./verify.js";

const DAY_MS = 86400000;
const MARKER_MS = 7 * DAY_MS; // once-per-batch email marker (TTL rate counter)
const ACCOUNT_RE = /^[a-f0-9]{32}$/;
const SLUG_RE = /^[a-z0-9-]{1,63}$/;
const code = (value) => (isUsageCode(value) ? value : "internal");
const fraction4 = (value) => Math.round(value * 10000) / 10000;
// A value that may travel in a request header: printable ASCII, no spaces.
const HEADER_SAFE = /^[!-~]{16,4096}$/;
const NO_RETRY = new Set(["bad-host", "blocked"]); // setup problems, not outages
const UNAVAILABLE = {
  code: "stats-unavailable",
  bootstrap: false,
  clusters: [],
};
// Provider retries wait through the check's signal (the budget stays a budget).
const sleepFor = (ctx, signal) => (ms) => ctx.sleep(ms, signal);

// ---- queue --------------------------------------------------------------------
// Boot sweep, run BEFORE this process's first heartbeat (like expireStaleQueued):
// checks that were queued while the worker was offline for 10+ minutes expire.
// -> {expired, batches}: the boot mails those batches after its first heartbeat.
export async function expireStaleChecks(ctx) {
  if (!(await queueStale(ctx))) return { expired: 0, batches: [] };
  const batches = await ctx.coll.installations.distinct(
    "pos.usage.check.batchId",
    { "pos.usage.check.status": "queued" },
  );
  const done = await ctx.coll.installations.updateMany(
    { "pos.usage.check.status": "queued" },
    {
      $set: {
        "pos.usage.check.status": "expired",
        "pos.usage.check.finishedAt": new Date(ctx.now()),
        "pos.usage.check.error": { code: "not-picked-up" },
      },
    },
  );
  return { expired: done.modifiedCount, batches: batches.filter(Boolean) };
}
// The oldest queued check, or a running one whose lease expired (takeover).
export async function claimUsage(ctx) {
  const { installations } = ctx.coll;
  const rows = await installations
    .find(
      { "pos.usage.check.status": { $in: ACTIVE_CHECK_STATES } },
      { projection: { "pos.usage.check": 1 } },
    )
    .sort({ "pos.usage.check.requestedAt": 1 })
    .limit(50)
    .toArray();
  const now = new Date(ctx.now());
  for (const row of rows) {
    const check = row.pos?.usage?.check;
    if (!check?.id) continue;
    const queued = check.status === "queued";
    if (!queued && !(new Date(check.lease?.until ?? 0) < now)) continue;
    const base = { _id: row._id, "pos.usage.check.id": check.id };
    const got = (
      await installations.findOneAndUpdate(
        queued
          ? { ...base, "pos.usage.check.status": "queued" }
          : {
              ...base,
              "pos.usage.check.status": "running",
              "pos.usage.check.lease.until": { $lt: now },
            },
        {
          $set: {
            "pos.usage.check.status": "running",
            "pos.usage.check.lease.owner": ctx.workerId,
            "pos.usage.check.lease.until": new Date(ctx.now() + ctx.t.leaseMs),
            ...(queued ? { "pos.usage.check.startedAt": now } : {}),
          },
          $inc: {
            "pos.usage.check.lease.fence": 1,
            "pos.usage.check.attempt": 1,
          },
        },
        { returnDocument: "after", projection: { "pos.usage.check": 1 } },
      )
    )?.pos?.usage?.check;
    if (!got) continue;
    return {
      slot: createSlot(ctx, {
        coll: installations,
        match: { _id: row._id },
        path: "pos.usage.check",
        idField: "id",
        idValue: check.id,
        owner: ctx.workerId,
        fence: got.lease.fence,
      }),
      doc: got,
      takeover: !queued,
      installationId: row._id,
      tooManyAttempts: got.attempt > MAX_CHECK_ATTEMPTS,
    };
  }
  return null;
}

// ---- measuring (no writes) ------------------------------------------------------
// A stored secret: {value} | {value: null} when none | {value: null, unreadable}.
function secretOf(ctx, id, pos, field) {
  try {
    return { value: openSecret(ctx, id, pos, field) };
  } catch {
    return { value: null, unreadable: true };
  }
}
const cfCode = (error) => {
  if (!(error instanceof ProviderError)) return "cf-failed";
  return (
    {
      denied: "cf-denied",
      forbidden: "cf-denied",
      unauthorized: "cf-unauthorized",
      invalid: "cf-not-set",
      "rate-limited": "cf-rate-limited",
      unavailable: "cf-unavailable",
      "bad-response": "cf-bad-response",
    }[error.code] ?? "cf-failed"
  );
};
// The health stats token goes only to the web address it was saved for
// (pos.statsHost, written by the secrets writes and the import) and only as a
// header-safe value; otherwise stats are asked without it. -> {value, problem}
function statsTokenFor(ctx, id, pos) {
  const secret = secretOf(ctx, id, pos, "generated.healthStatsToken");
  if (secret.unreadable) return { value: null, problem: "secret-unreadable" };
  if (!secret.value) return { value: null, problem: null };
  if (pos.statsHost !== pos.host)
    return { value: null, problem: "stats-host-changed" };
  if (!HEADER_SAFE.test(secret.value))
    return { value: null, problem: "stats-token-invalid" };
  return { value: secret.value, problem: null };
}
// Up to SITE_ATTEMPTS plain probes (the site state and latency never include
// the cafe's dbStats work), then, only if the site answered, one stats request.
async function siteAndStats(ctx, pos, statsToken, signal) {
  const target = {
    host: pos.host,
    tenantId: pos.tenantId ?? "",
    get: ctx.usageGet,
    signal,
  };
  let probes = 0;
  let site;
  for (;;) {
    probes++;
    site = await probeSite(target);
    if (
      site.state !== "down" ||
      NO_RETRY.has(site.code) ||
      probes >= SITE_ATTEMPTS ||
      signal?.aborted
    )
      break;
    await ctx.sleep(ctx.t.usageRetryMs, signal);
    if (signal?.aborted) break;
  }
  const stats =
    site.state === "up" && !signal?.aborted
      ? (await probeSite({ ...target, stats: true, statsToken })).stats
      : UNAVAILABLE;
  return { ...site, probes, stats };
}
async function storageOf(ctx, id, pos, stats) {
  const statsCode = code(stats?.code);
  if (statsCode === "ok") {
    const clusters = stats.clusters;
    const pcts = clusters.filter((c) => c.state === "ok").map((c) => c.usedPct);
    return {
      source: "health",
      code: "ok",
      statsCode,
      clusters,
      maxPct: pcts.length ? Math.max(...pcts) : null,
    };
  }
  const none = (mongoCode) => ({
    source: null,
    code: mongoCode,
    statsCode,
    clusters: [],
    maxPct: null,
  });
  const uri = secretOf(ctx, id, pos, "mongo.uri");
  if (uri.unreadable) return none("secret-unreadable");
  if (!uri.value) return none("mongo-not-set");
  try {
    const { dataSize, indexSize } = await ctx.mongoStats(uri.value);
    const bytes = dataSize + indexSize;
    const usedPct = fraction4(bytes / MONGO_LIMIT_BYTES);
    return {
      source: "direct",
      code: "ok",
      statsCode,
      clusters: [
        {
          name: "core",
          role: "core",
          label: null,
          active: false,
          paused: false,
          state: "ok",
          usedPct,
          bytes,
        },
      ],
      maxPct: usedPct,
    };
  } catch (error) {
    return none(
      error instanceof ClientMongoError
        ? code(`mongo-${error.code}`)
        : "mongo-stats-failed",
    );
  }
}
async function cloudflareOf(ctx, pos, cfToken, signal) {
  const empty = (cfCodeValue) => ({
    code: cfCodeValue,
    day: null,
    requests: null,
    errors: null,
    pct: null,
    yesterday: null,
  });
  if (cfToken.unreadable) return empty("secret-unreadable");
  const accountId = pos.cloudflare?.accountId;
  if (!cfToken.value || !ACCOUNT_RE.test(accountId ?? ""))
    return empty("cf-not-set");
  const now = ctx.now();
  try {
    const r = await workerRequests(cfToken.value, accountId, {
      now,
      fetch: ctx.cloudflareFetch,
      signal,
      sleep: sleepFor(ctx, signal),
    });
    return {
      code: "ok",
      day: utcDay(now),
      requests: r.today.requests,
      errors: r.today.errors,
      pct: fraction4(r.today.requests / WORKER_FREE_REQUESTS),
      yesterday: { day: utcDay(now - DAY_MS), requests: r.yesterday.requests },
    };
  } catch (error) {
    return empty(cfCode(error));
  }
}
async function credentialsOf(ctx, pos, vercelToken, cfToken, signal) {
  const vercel = await (async () => {
    if (vercelToken.unreadable)
      return { code: "secret-unreadable", expiresAt: null };
    if (!vercelToken.value) return { code: "token-not-set", expiresAt: null };
    try {
      const info = await ctx
        .vercelFor({
          token: vercelToken.value,
          teamId: "",
          sleep: sleepFor(ctx, signal),
        })
        .tokenInfo({ signal });
      return { code: "ok", expiresAt: info.expiresAt };
    } catch (error) {
      const c = error instanceof ProviderError ? error.code : "";
      return {
        code:
          c === "unauthorized"
            ? "token-invalid"
            : c === "forbidden" || c === "not-found"
              ? "expiry-unknown"
              : "token-check-failed",
        expiresAt: null,
      };
    }
  })();
  const cloudflare = await (async () => {
    if (cfToken.unreadable)
      return { code: "secret-unreadable", expiresAt: null };
    if (!cfToken.value) return { code: "token-not-set", expiresAt: null };
    const accountId = pos.cloudflare?.accountId;
    const account = ACCOUNT_RE.test(accountId ?? "") ? accountId : "";
    try {
      const s = await ctx.cloudflareStatus(cfToken.value, account, {
        fetch: ctx.cloudflareFetch,
        signal,
        sleep: sleepFor(ctx, signal),
      });
      if (s.ok) return { code: "ok", expiresAt: s.expiresOn };
      // The user form refused it and there is no account id for the account
      // form: an account-owned token is not invalid, its state is unknown.
      if (!s.status && !account)
        return { code: "expiry-unknown", expiresAt: null };
      return { code: "token-invalid", expiresAt: s.expiresOn };
    } catch {
      return { code: "token-check-failed", expiresAt: null };
    }
  })();
  return { vercel, cloudflare };
}
// One check of one installation, without writing anything. -> the `last`
// document (minus alerts/level/at/durationMs), or null when the POS block is gone.
export async function measure(ctx, installationId, signal) {
  const row = await ctx.coll.installations.findOne(
    { _id: installationId },
    { projection: { pos: 1 } },
  );
  const pos = row?.pos;
  if (!pos) return null;
  // Only a deploy/rollback the worker is running can touch production (a
  // queued one cannot hide a real outage).
  const deployActive = ["running", "cancelling"].includes(
    pos.deploy?.current?.status,
  );
  if (typeof pos.host !== "string" || !pos.host)
    return {
      site: {
        state: "unknown",
        code: "no-host",
        httpStatus: 0,
        latencyMs: null,
        probes: 0,
        deployActive,
      },
      mongo: {
        source: null,
        code: "no-host",
        statsCode: "no-host",
        clusters: [],
        maxPct: null,
      },
      cloudflare: {
        code: "no-host",
        day: null,
        requests: null,
        errors: null,
        pct: null,
        yesterday: null,
      },
      credentials: {
        vercel: { code: "no-host", expiresAt: null },
        cloudflare: { code: "no-host", expiresAt: null },
      },
    };
  const token = statsTokenFor(ctx, installationId, pos);
  const probe = await siteAndStats(ctx, pos, token.value, signal);
  let stats = probe.stats;
  // Refused because we did not send the token: say why it was not sent.
  if (token.problem && ["stats-not-set", "stats-denied"].includes(stats?.code))
    stats = { ...stats, code: token.problem };
  const cfToken = secretOf(ctx, installationId, pos, "cloudflare.token");
  const vercelToken = secretOf(ctx, installationId, pos, "vercel.token");
  return {
    site: {
      state: probe.state,
      code: code(probe.code),
      httpStatus: probe.httpStatus,
      latencyMs: probe.latencyMs,
      probes: probe.probes,
      deployActive,
    },
    // Out of budget: no further client calls (the result is discarded).
    mongo: signal?.aborted
      ? {
          source: null,
          code: "aborted",
          statsCode: code(stats?.code),
          clusters: [],
          maxPct: null,
        }
      : await storageOf(ctx, installationId, pos, stats),
    cloudflare: await cloudflareOf(ctx, pos, cfToken, signal),
    credentials: await credentialsOf(ctx, pos, vercelToken, cfToken, signal),
  };
}

// ---- running a claimed check -----------------------------------------------------
export async function runUsageCheck(ctx, claim) {
  const batchId = claim.doc.batchId ?? null;
  const finish = (fields) =>
    claim.slot.set({ finishedAt: new Date(ctx.now()), ...fields });
  if (claim.tooManyAttempts) {
    await finish({ status: "failed", error: { code: "worker-stopped" } }).catch(
      () => undefined,
    );
    await mailBatchSummary(ctx, batchId).catch(() => undefined);
    return;
  }
  const started = ctx.now();
  await withLease(
    ctx,
    claim,
    async (signal) => {
      const budget = AbortSignal.any([
        signal,
        AbortSignal.timeout(ctx.t.usageBudgetMs),
      ]);
      const measured = await measure(ctx, claim.installationId, budget);
      if (!measured) throw new LeaseLost(); // the POS block was removed
      if (signal.aborted) throw signal.reason ?? new LeaseLost();
      // Out of time: a half-measured result would read as failures, so the
      // previous result stays and the check is marked failed.
      if (budget.aborted)
        throw Object.assign(new Error("budget"), { code: "check-timeout" });
      const now = ctx.now();
      const { alerts, level } = evaluateAlerts(measured, now);
      const done = await claim.slot.coll.updateOne(claim.slot.filterOf(), {
        $set: {
          "pos.usage.last": {
            ...measured,
            alerts,
            level,
            at: new Date(now),
            durationMs: Math.max(0, now - started),
          },
          "pos.usage.check.status": "done",
          "pos.usage.check.finishedAt": new Date(now),
          "pos.usage.check.error": null,
        },
      });
      if (done.matchedCount !== 1) throw new LeaseLost();
      ctx.log("usage-check", { level, ms: Math.max(0, now - started) });
    },
    async (error) => {
      ctx.log("usage-failed", { code: code(error?.code) });
      await finish({
        status: "failed",
        error: {
          code: error?.code === "check-timeout" ? "check-timeout" : "internal",
        },
      });
    },
  );
  await mailBatchSummary(ctx, batchId).catch((error) =>
    ctx.log("usage-mail-failed", {
      code: String(error?.code ?? "error").slice(0, 40),
    }),
  );
}

// ---- the batch summary email ---------------------------------------------------
const istTime = (ms) =>
  `${new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  })} IST`;
async function ownerEmails(ctx) {
  const owners = await ctx.db
    .collection("staff")
    .find({ role: "owner", status: "active" }, { projection: { email: 1 } })
    .toArray();
  return owners.map((owner) => owner.email).filter(Boolean);
}
// When no check of the batch is queued or running any more: one email with
// every alert that is due (dueMail) from the checks of this batch that
// finished (a failed or expired check keeps an OLDER result, never mailed as
// current), then the mail memory. A per-batch marker (a TTL rate counter)
// keeps two overlapping workers from both sending.
export async function mailBatchSummary(ctx, batchId) {
  if (!batchId || !ctx.notify) return false;
  const { installations } = ctx.coll;
  const open = await installations.countDocuments({
    "pos.usage.check.batchId": batchId,
    "pos.usage.check.status": { $in: ACTIVE_CHECK_STATES },
  });
  if (open) return false;
  const rows = await installations
    .find(
      { "pos.usage.check.batchId": batchId, "pos.usage.check.status": "done" },
      {
        projection: {
          customerId: 1,
          "pos.slug": 1,
          "pos.usage.last.alerts": 1,
          "pos.usage.mail": 1,
        },
      },
    )
    .limit(500)
    .toArray();
  const now = ctx.now();
  const items = rows
    .map((row) => ({
      row,
      due: dueMail(row.pos?.usage?.mail, row.pos?.usage?.last?.alerts, now),
    }))
    .filter((item) => item.due.length);
  if (!items.length) return false;
  const owners = await ownerEmails(ctx);
  if (!owners.length) return false;
  const marker = `usage-mail:${batchId}`;
  try {
    await consume(ctx.db, marker, 1, MARKER_MS);
  } catch {
    return false; // another worker already mails this batch
  }
  let sent = 0;
  try {
    const missed = await installations.countDocuments({
      "pos.usage.check.batchId": batchId,
      "pos.usage.check.status": { $in: ["failed", "expired"] },
    });
    const customers = await ctx.db
      .collection("customers")
      .find(
        { _id: { $in: items.map((item) => item.row.customerId) } },
        { projection: { name: 1 } },
      )
      .toArray();
    const names = new Map(customers.map((c) => [c._id, cleanText(c.name, 80)]));
    const base = String(ctx.c.APP_URL ?? "").replace(/\/+$/, "");
    const lines = { critical: [], warning: [] };
    for (const { row, due } of items) {
      const slug = SLUG_RE.test(row.pos?.slug ?? "") ? row.pos.slug : "?";
      const who = `${names.get(row.customerId) || "Client"} (${slug})`;
      for (const { type, level } of due) {
        const alert = row.pos.usage.last.alerts[type];
        lines[level].push(
          `- ${who}: ${ALERT_TITLES[type]} — ${cleanText(alert.detail, 120)}`,
        );
      }
      // The client's link goes under its most severe section.
      if (base)
        lines[
          due.some((d) => d.level === "critical") ? "critical" : "warning"
        ].push(`  ${base}/installations/${row._id}/usage`);
    }
    const critical = items.filter((i) =>
      i.due.some((d) => d.level === "critical"),
    );
    const warning = items.length - critical.length;
    const text = [
      `Usage check finished at ${istTime(now)}: ${rows.length} client${rows.length === 1 ? "" : "s"} checked` +
        (missed ? `, ${missed} could not be checked.` : "."),
      "",
      ...(lines.critical.length ? ["CRITICAL", ...lines.critical, ""] : []),
      ...(lines.warning.length ? ["WARNING", ...lines.warning, ""] : []),
      ...(base ? [`POS clients: ${base}/pos-clients`, ""] : []),
      "Only alerts not already emailed in the last 24 hours are listed.",
    ].join("\n");
    const subject = `Sandbee usage check: ${critical.length} critical, ${warning} warning`;
    for (const email of owners)
      try {
        await ctx.notify(email, { subject, text });
        sent++;
      } catch {
        // best effort
      }
  } catch (error) {
    // Composing failed after the marker was taken: free it for a retry.
    await clearLimit(ctx.db, marker, MARKER_MS).catch(() => undefined);
    throw error;
  }
  if (!sent) {
    // Nothing went out: free the marker so a later call may retry.
    await clearLimit(ctx.db, marker, MARKER_MS).catch(() => undefined);
    ctx.log("usage-mail-failed", { n: items.length });
    return false;
  }
  for (const { row, due } of items)
    // Guarded: never recreate a POS block that was removed meanwhile.
    await installations.updateOne(
      {
        _id: row._id,
        "pos.rev": { $exists: true },
        "pos.usage.check.batchId": batchId,
      },
      {
        $set: Object.fromEntries(
          due.map(({ type, level }) => [
            `pos.usage.mail.${type}`,
            { at: new Date(now), level },
          ]),
        ),
      },
    );
  ctx.log("usage-mail", { n: items.length, sent });
  return true;
}

// ---- self-check: node backend/worker.js --self-check --usage=<id> [--mail-test]
export async function usageSelfCheck(
  ctx,
  { installationId, mailTest = false, print = (line) => console.info(line) },
) {
  let ok = true;
  const out = (state, name, detail = "") => {
    if (state === "fail") ok = false;
    print(`${state} ${name}${detail ? ` ${detail}` : ""}`);
  };
  let measured;
  try {
    measured = await measure(
      ctx,
      installationId,
      AbortSignal.timeout(ctx.t.usageBudgetMs),
    );
  } catch (error) {
    out(
      "fail",
      "installation",
      String(error?.code ?? "error")
        .replace(/[^a-z0-9-]/gi, "")
        .slice(0, 40),
    );
    return { ok };
  }
  if (!measured) {
    out("fail", "installation", "not-found");
    return { ok };
  }
  const { site, mongo, cloudflare, credentials } = measured;
  out(
    site.state === "up" ? "ok" : "fail",
    "site",
    `${site.state} ${site.code} ${site.latencyMs ?? "-"}ms probes=${site.probes}`,
  );
  out(
    mongo.code === "ok" ? "ok" : "fail",
    "storage",
    mongo.code === "ok"
      ? `${mongo.source} ${mongo.clusters
          .map(
            (c) =>
              `${c.name}=${c.state === "ok" ? pctText(c.usedPct) : "error"}`,
          )
          .join(
            " ",
          )}${mongo.statsCode === "ok" ? "" : ` stats=${mongo.statsCode}`}`
      : `${mongo.code} stats=${mongo.statsCode}`,
  );
  out(
    cloudflare.code === "ok"
      ? "ok"
      : cloudflare.code === "cf-not-set"
        ? "skip"
        : "fail",
    "cloudflare",
    cloudflare.code === "ok"
      ? `today=${cloudflare.requests} yesterday=${cloudflare.yesterday.requests}`
      : cloudflare.code,
  );
  for (const [name, token] of [
    ["vercel-token", credentials.vercel],
    ["cloudflare-token", credentials.cloudflare],
  ])
    out(
      token.code === "ok"
        ? "ok"
        : token.code === "token-not-set"
          ? "skip"
          : "fail",
      name,
      token.code !== "ok"
        ? token.code
        : token.expiresAt === null
          ? "no-expiry"
          : `expires-in=${Math.ceil((token.expiresAt - ctx.now()) / DAY_MS)}d`,
    );
  if (mailTest) {
    let sent = 0;
    if (ctx.notify)
      for (const email of await ownerEmails(ctx))
        try {
          await ctx.notify(email, {
            subject: "Sandbee usage check: test email",
            text: "This is a test email from the admin worker's self-check. No client data is included.",
          });
          sent++;
        } catch {
          // reported below
        }
    out(sent ? "ok" : "fail", "mail-test", `sent=${sent}`);
  }
  return { ok };
}
