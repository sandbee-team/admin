# Phase 2 plan: per-customer usage checks and alerts — revision 2

Status: DRAFT rev 2 for owner approval (2026-10-11). Base: `main` @ `71e3745`. Binding: D1-D30 in
`docs/POS-INTEGRATION.md`. Rev 1 (scheduled monitoring with daily history) was approved and then
replaced by the owner the same day:

> Only the clients I select (add to the watch list) are checked, not all. Checks run only when I
> trigger them, one by one like a queue — no continuous daily watching (server load). When I
> trigger, I want only the current status of each client.

Goal: when the owner triggers it, check each selected POS client once and show its **current**
state: (1) MongoDB storage vs the 512 MB M0 limit per cluster; (2) Vercel site up/down, latency and
paused state — honestly, without invented usage numbers; (3) Cloudflare Worker requests today vs the
100k free limit; (4) credential expiry. Results go to the installation page, the POS clients page
and the dashboard Attention panel, plus one summary email per batch. Build-cache retention failures
(an existing daily job) are added to the Attention panel.

## 0. Findings that shape the design (verified in code/docs)

1. **Cafe health endpoint** (`F:\lucifer\apps\cafe\app\api\health\route.ts`, read only):
   - `GET /api/health` → 200 `{ok:true, db:"up", tenant, ts}`; DB down → 503 `{ok:false, db:"down"}`.
   - `?stats=1` with header `x-stats-token` (SHA-256 + `timingSafeEqual`, `apps/cafe/lib/heartbeat.ts:228-236`).
     A wrong/missing token is **not** a 401: it is 200 `{…, stats:"denied"}`. A failed heartbeat build is
     200 `{…, stats:"error"}`. If `HEALTH_STATS_TOKEN` is unset on the client, stats are open.
   - Success adds `clusters[]` = `{name, tag?, role: core|ledger|standby, active?, state: ok|error,
     usedPct (0-1, 4 dp), dataSize, indexSize, paused?}` and `bootstrap:true` when only the core cluster
     exists. **A client can have 1 core + N ledgers + M standbys, each its own M0** (`heartbeat.ts:137-165`).
   - `usedPct = (dataSize + indexSize) / 512 MiB` (`registry-io.ts:28-37`, `ledger-scale-plan.ts:39`) —
     the measure Atlas enforces (write error 8000 "over your space quota"). The cafe connects with
     `mongoose.connect(MONGODB_URI)` and no `dbName` (`apps/cafe/lib/db.ts:49`), so the URI's database is
     the cafe's database.
2. **Admin today**: `probeHealth` (`backend/lib/pos-health.js:52`) calls `/api/health` with no query;
   `getText` (`backend/lib/safe-https.js:141-147`) rejects any `?` in the path → a narrow `query`
   option is needed. Headers already pass through. Nothing calls `?stats=1` yet.
3. **Secrets**: `generated.healthStatsToken`, `cloudflare.token`, `vercel.token`, `mongo.uri` are vault
   boxes (`POS_SECRET_FIELDS`, `shared/schemas.js:227`); the worker opens them with
   `openSecret(ctx, id, pos, field)` (`backend/worker/verify.js:27`, AAD `pos:<id>:<field>`).
   `pos.cloudflare.{accountId, workerName}` are plain config (`schemas.js:300-303`).
4. **Fallback `dbStats`** through `pos.mongo.uri` (`openClientDb`, `backend/lib/client-mongo.js:29`, Atlas
   hosts only) reaches **the core cluster only**: ledger URIs live in the cafe's registry, not in admin.
5. **Worker**: lanes `{deploy:1, build:2, task:1}` (`backend/worker/loop.js:96`), polled every 3 s;
   one job slot per installation (`pos.task`) claimed with a fenced lease (`lease.js`); all adapters are
   seams in `buildContext({overrides})` (`backend/worker/context.js:87`). The API refuses to queue
   work when the worker heartbeat is stale (`db-backup.js`, `notReadyError(["worker"])`).
6. **Mail**: `notifier(c)` sends plain text and throws on failure (`backend/modules/mail.js`); retention
   emails every active owner (`retention.js:139-150`). No alert de-duplication exists anywhere.
7. **Attention panel**: `/overview` returns counts only (`backend/modules/overview.js:84-130`); items are
   built in `frontend/src/pages/overview.jsx:270` (`posAttention`), two severities (normal/urgent).
8. **Leak surfaces**: the generic records API strips `pos` (`records.js:37 scrub`); `posView`
   (`pos.js:75`) and the fleet projection (`deploys.js:1254`) are whitelists → new fields under
   `pos.usage` are invisible until a view adds them on purpose.
9. **Cloudflare** (developers.cloudflare.com, 2026): GraphQL `viewer.accounts(filter:{accountTag})
   .workersInvocationsAdaptive(filter:{datetime_geq, datetime_leq}) { sum { requests errors } }`;
   GraphQL limit 300 queries / 5 min; token permission **Account Analytics: Read**. Workers Free =
   **100,000 requests/day for the whole account, reset 00:00 UTC** (05:30 IST). Go-live created client
   tokens with Workers Scripts:Edit + Account Settings:Read only (`F:\lucifer\scripts\go-live\realtime.mjs:34`)
   → the owner must add Account Analytics:Read (editing a token's permissions keeps its value).
   `verifyToken` (`backend/lib/cloudflare.js`) already calls `tokens/verify`, whose result has `expires_on`.
10. **Vercel**: a paused project answers **503 `DEPLOYMENT_PAUSED`** (code in the `x-vercel-error`
    header — header unverified, so the body is matched too). **No usage API on Hobby** (Query API is
    Pro/Enterprise; Drains Pro). `GET /v5/user/tokens/current` → `token.expiresAt` (ms; absent = never
    expires). Hobby includes per month: 100 GB fast data transfer, 1M edge requests, 1M function
    invocations, 4 h active CPU (vercel.com/docs/pricing, 2026-09).
11. **Atlas Admin API metrics for M0**: not used (unverified, not needed — item 1 gives exact numbers).

Unverified provider details get a live check at release with `--self-check --usage` (§5.4).
`x-vercel-error` can only be fixture-tested (we cannot pause a real client site); the body match
covers it either way.

## 1. Decisions (proposed; recorded as D31-D36 after approval)

| #   | Decision |
| --- | -------- |
| D31 | **On demand only.** Nothing runs on a schedule and nothing is watched in the background. The owner keeps a **watch list** (a per-client switch) and triggers either "Check watched clients" (POS clients page) or "Check now" (one client's Usage tab, works for any POS client). Each trigger queues one check per client; the worker runs them **one at a time** on a new `usage` lane (concurrency 1), so a check never delays a backup/verify/deploy. Idle cost: zero outbound calls. |
| D32 | **Only the current result is stored**: `installations.pos.usage.last`, overwritten by every check. No history, no daily points, no new collection, no charts over time (D4 spirit). |
| D33 | Storage = `(dataSize+indexSize)/512 MiB` per cluster from the cafe's `/api/health?stats=1` (`x-stats-token`); fallback `dbStats` via `pos.mongo.uri` = core cluster only, labelled as such. No Atlas Admin API. |
| D34 | Vercel: up/down, latency and paused come from our own probe only. **No bandwidth/CPU/invocation numbers are shown** (no Hobby usage API); the tab shows the Hobby limits as reference text and points the owner to the client's Vercel dashboard. |
| D35 | Cloudflare: account-wide Worker requests for today (UTC, so far) and yesterday's total. Needs Account Analytics:Read; without it the tab shows a notice, not an alert. |
| D36 | Levels from each check: storage 75 % warning / 90 % critical; Worker requests today 75 % / 90 %; site down = **3 consecutive failed probes inside one check** (5 s apart); paused at once; credential invalid/expired/≤ 3 days critical, ≤ 14 days warning. Shown in the Attention panel with the check time. **One summary email when a "Check watched" batch finishes**, only if something is warning/critical, de-duplicated per client per type per 24 h (one warning→critical escalation allowed); a single "Check now" sends no email (Q1). Build-cache retention failure (existing daily job) → Attention item. |

## 2. One check, and what it costs

A check of one client, in order (hard budget 60 s, lease 90 s renewed every 15 s):

| Step | Request | Cost to the client's free tier |
| --- | --- | --- |
| Site + storage | `GET https://<pos.host>/api/health?stats=1` with `x-stats-token`; if it fails, up to 2 more plain probes 5 s apart | 1-3 function invocations; one `ping` + one `dbStats` per cluster |
| Storage fallback | `dbStats` via `pos.mongo.uri` (core only) — only if stats were unavailable (no token, denied, error, site down) | 1 connection + 1 command |
| Cloudflare | `POST api.cloudflare.com/client/v4/graphql` (today + yesterday in one query) — only if token + account id are set | 0 Worker requests; 1 GraphQL query |
| Credentials | Vercel `GET /v5/user/tokens/current`; Cloudflare `tokens/verify` | 2 API calls |

≈ 3-15 s per client, so a batch of 20 watched clients takes ≈ 1-5 minutes. Worker memory is
unchanged (same process). Admin M0: one partial-index claim query per worker poll while idle, and
2-3 small writes per check.

## 3. Data model — `installations.pos.usage` (≈ 1-2 KB, bounded)

```js
usage: {
  watch: true,                       // the owner's list (API-written)
  check: {                           // one queue slot per client (same shape as pos.task)
    id, status: "queued|running|done|failed|expired", batchId,  // batchId null for "Check now"
    requestedAt, by: { id, name }, lease: { owner, until, fence }, attempt,
    startedAt, finishedAt, error: { code } | null,
  },
  last: {                            // the ONLY stored result, overwritten by every check
    at, durationMs,
    site: { state: "up|down|paused", code, httpStatus, latencyMs, probes, deployActive },
    mongo: { source: "health|direct|null", code,
             clusters: [{ name, role, tag, active, paused, state, usedPct, bytes }], maxPct }, // ≤ 12 rows
    cloudflare: { code, day, requests, errors, pct, yesterday: { day, requests } },
    credentials: { vercel: { code, expiresAt }, cloudflare: { code, expiresAt } },
    alerts: { storage|workers|site-down|site-paused|credential: { level, value, detail } },
    level: "ok|warning|critical",
  },
  mail: { <type>: { at, level } },   // email de-duplication memory only
}
```

- Writers: the API writes `watch` and enqueues `check` (only when no check is queued/running for
  that client); the worker writes `check` (fenced on `lease.{owner,fence}`), `last` and `mail`.
  `pos.rev` is never touched, so the POS setup form is never marked stale.
- Every `code` is from `shared/usage-codes.js`; cluster names must match `^[a-z0-9][a-z0-9_-]{0,39}$`
  (else the row is dropped); numbers bounded; `detail` ≤ 120 chars via `cleanText`.
- Index (`backend/db.js` `indexes()`): partial `installations {"pos.usage.check.status": 1}`
  (pattern of `pos.task.status`).
- Removing the POS block (`DELETE /installations/:id/pos`) removes `usage` with it.

## 4. Levels, Attention and email

| Type | Level from the latest check |
| --- | --- |
| `storage` | max `usedPct` over ok clusters ≥ 0.75 warning, ≥ 0.90 critical |
| `workers` | today's account requests ≥ 75 % / ≥ 90 % of 100,000 |
| `site-down` | 3 failed probes in a row (critical); while a deploy/rollback is active the result is shown but not raised |
| `site-paused` | 503 + `DEPLOYMENT_PAUSED` (critical) |
| `credential` | Vercel/Cloudflare token invalid or expired, or ≤ 3 days (critical); ≤ 14 days (warning) |
| `retention` (platform) | existing `pos-worker.retention.failed|missing > 0`, or no sweep for 48 h while the worker is online — Attention only (retention.js already emails) |

- **Notices, never alerts** (Usage tab only): `stats-denied`, `stats-not-set`, `cf-denied` (token lacks
  Account Analytics:Read), `cf-not-set`, `expiry-unknown`.
- **Evaluation** is a pure function `evaluateAlerts(previous, last, now)` → `{alerts, level, due}` in
  `shared/usage.js` (unit-tested). `due` = types whose email is due: none sent for that client/type
  in 24 h, or the last one was `warning` and it is now `critical`.
- **Attention panel**: counts of watched clients whose latest result is critical (urgent) or warning,
  with "checked N ago"; links to `/pos-clients`.
- **Email (Q1)**: when the last check of a batch finishes, the worker sends ONE plain-text email to
  active owners listing each due alert (customer name ≤ 80 chars, slug, alert, value e.g. "core 91 % of
  512 MB (466 MB)", link `${APP_URL}/installations/<id>/usage`), then writes `mail.<type>`. Nothing due
  → no email. SMTP failure never fails a check. Never a secret, URI, token, header or provider text.

## 5. Worker

### 5.1 `backend/worker/usage.js` (new)

- `claimUsage(ctx)`: `findOneAndUpdate` on `installations` where `pos.usage.check.status` is
  `queued` (requested ≤ 30 min ago) or `running` with `lease.until < now` (attempt ≤ 3), sort by
  `requestedAt`; sets `status: running`, lease owner/until, `$inc lease.fence`, `$inc attempt`.
  Queued checks older than 30 min become `expired` (`not-picked-up`); attempt > 3 → `failed`.
- `runUsageCheck(ctx, claim)` under `withLease` (`lease.js:471`) with `createSlot` on path
  `pos.usage.check` (`lease.js:48`; a ≤ 20-line fenced helper if its id contract does not fit):
  1. load the POS block (no host → `last.site.code = "no-host"`, nothing else probed);
  2. site + stats probe (`probeSite`), up to 3 attempts 5 s apart while it fails;
  3. fallback `dbStats` if stats are unavailable;
  4. Cloudflare `workerRequests` if token + account id are set;
  5. credentials: Vercel `tokenInfo`, Cloudflare `tokenStatus`;
  6. `evaluateAlerts` → one fenced `$set` of `pos.usage.last` + `check.status = done`;
  7. if this was the last open check of its batch → summary email (best effort) → `mail.*`.
  A failing probe is a code in `last`, never a failed check. Secrets are decrypted per probe and dropped.
- Logs: `ctx.log("usage", {code, n})` — codes and counts only (`makeLog` already strips values).

### 5.2 `backend/worker/loop.js`

`LANES` gains `usage: 1`; `tick()` after the task block: `while (free("usage"))` → `claimUsage` →
`start("usage", runUsageCheck(ctx, claim))`. `running()`, `drain()` and `stop()` are lane-generic.

### 5.3 `backend/worker/context.js`

`DEFAULT_TIMING` + `usageLeaseMs: 90000`, `usageBudgetMs: 60000`, `usageRetryMs: 5000`. New seams:
`usageGet` (default `getText`), `cloudflareFetch`, `mongoStats(uri)` (default `clientDbStats`);
`vercelFor` exists.

### 5.4 `backend/worker.js --self-check --usage=<installationId> [--mail-test]`

Runs one check, **no DB writes, no email**, prints `ok|fail|skip <probe> <code>` and numbers only.
`--mail-test` sends one fixed test email (no client data) to active owners.

## 6. Adapters (`backend/lib`)

- `safe-https.js` `getText`: option `query` — ≤ 4 pairs, keys `^[a-z]{1,20}$`, values
  `^[A-Za-z0-9._-]{1,40}$`, joined with `URLSearchParams`; anything else → `bad-path`. Default unchanged.
- `pos-health.js`: `probeSite({host, tenantId, get, stats, statsToken, timeoutMs, signal, now})` →
  `{state, code, httpStatus, latencyMs, stats?}`; `healthVerdict`/`probeHealth` unchanged (deploys
  identical); paused = 503 and (`x-vercel-error` or body contains `DEPLOYMENT_PAUSED`);
  `parseStats(body)` → `{code, bootstrap, clusters}` (≤ 12 rows, sizes ≤ 1e12, fraction recomputed
  from bytes). `x-stats-token` only with a token, only to the validated `pos.host` (guarded lookup,
  no redirects, 64 KB, 10 s).
- `client-mongo.js`: `clientDbStats(uri, opts)` → `{dataSize, indexSize}`, client always closed;
  codes = `ClientMongoError` + `stats-failed`.
- `cloudflare.js`: `tokenStatus()` → `{ok, form, status, expiresOn}` (`verifyToken` keeps returning
  `{ok, form}` for its callers); `workerRequests(token, accountId, {now, fetch, signal})` → `{today,
  yesterday}` via POST `/graphql` (`provider-http`, `idempotent: true`, constant query text, inputs only as
  variables, `accountId` must match `ACCOUNT_RE`; GraphQL authz error → `denied`, else `bad-response`).
- `vercel.js`: `tokenInfo()` → `{expiresAt: ms|null}` via `GET /v5/user/tokens/current` (no team id).

## 7. Shared modules

- `shared/usage.js` (new, pure): `MONGO_LIMIT_BYTES`, `WORKER_FREE_REQUESTS`, `WARN_PCT`, `CRIT_PCT`,
  `SITE_ATTEMPTS = 3`, expiry 14/3 days, `MAIL_EVERY_MS`, `CHECK_QUEUED_MAX_MS = 30 min`, `ALERT_TYPES`,
  `CHECK_STATES`, `levelOf()`, `credentialLevel()`, `evaluateAlerts()`, `pctText()`, `utcDay()`,
  `HOBBY_LIMITS` (reference text).
- `shared/usage-codes.js` (new, `shared/deploy-errors.js` style): `add(code, area, title, message ≤ 160,
  action)`, `describeUsageCode`, `knownUsageCode` (throws on unknown).
- `shared/schemas.js`: `usageSchemas = { watch: {watch: boolean}.strict(), check: {}.strict(), batch: {}.strict() }`.

## 8. API (`credentials` permission, like Verify: owner + admin)

New `backend/modules/usage.js` → `usageRoutes(context)` (`router.use(auth.requireAuth)`), mounted
in `backend/app.js` before `recordRoutes`; views in new `backend/lib/usage-view.js` (whitelists, same
helpers as `deploy-view.js`).

| Route | Purpose |
| --- | --- |
| `GET /installations/:id/pos/usage` | `{watch, check: checkView, last: lastView \| null, hobby, workerOnline}`; 400 unless product is pos |
| `PUT /installations/:id/pos/usage/watch` | `{watch}` → add/remove from the watch list; transaction + `authorizeWrite` + audit `pos.usage.watched` / `pos.usage.unwatched` |
| `POST /installations/:id/pos/usage/check` | "Check now" for one client (watched or not); 409 `busy` if already queued/running; `consume("usage-check:<id>", 10, 1h)`; audit `pos.usage.check-requested` |
| `POST /pos/usage/check` | "Check watched clients": one transaction queues every watched client without an active check, shared `batchId`; returns `{queued, skipped}`; `consume("usage-batch:<staff>", 6, 1h)`; audit `pos.usage.batch-requested` (count only) |

- Both check routes: 503 `not-ready` when the worker heartbeat is stale (nothing silently queued);
  `assertNoSecrets` on every response.
- `GET /pos/fleet` (`deploys.js:1235`): projection adds `pos.usage.{watch,check.status,
  check.requestedAt,last.at,last.level,last.site,last.mongo.maxPct,last.cloudflare.pct}`; row gains
  `usage: {watch, check, level, site, latencyMs, storagePct, workersPct, checkedAt}`. No extra queries.
- `GET /overview`: `usage: {watched, critical, warning, lastCheckAt}` (one aggregate; newest check among watched clients) and
  `retention: {failed, missing, at}` from the `pos-worker` row it already reads.
- `docs/API.md`: new section "POS usage checks (Phase 2)".

## 9. UI (design system only; no chart library, no charts over time)

- `frontend/src/pages/pos-fleet.jsx`: new **Watch** column (checkbox → `PUT …/watch`), **Site**
  (badge + ms), **DB** (max %), **Workers** (% today), **Checked** (time ago / Queued / Checking…);
  toolbar button **Check watched clients (N)** with progress "Checking 3 of 12"; faster polling only
  while checks are queued/running; `row-urgent` also when `usage.level === "critical"`.
- `frontend/src/pages/installation-workspace.jsx`: tab `["usage", "Usage", Activity]` for POS +
  `credentials`.
- New `frontend/src/pages/installation-usage.jsx` (`usePoll`, fast only while the check is
  queued/running): Watch switch, **Check now**, check status, then the latest result:
  Site (Up/Down/Paused, latency, probes); Database (one meter per cluster: MB of 512 MB, %, marks at
  75/90, role/tag/active, source note); Cloudflare Workers (today vs 100,000 meter, "resets 05:30 IST",
  yesterday's total, permission notice); Credentials (expires in N days / no expiry / invalid);
  Vercel (Hobby) honest box; Alerts of this check.
- New `frontend/src/components/usage/{meter.jsx, format.js}`: CSS meter (`role="meter"`,
  `aria-valuenow`, text value always visible), tokens only; `format.js` → `mb()`, `pct()`, `ms()`.
- `frontend/src/pages/overview.jsx`: `usageAttention(usage, retention)` after `posAttention`.
- New `frontend/src/styles/usage.css` (imported in `styles.css`), incl. 900/600 px rules.

## 10. Security

- Secrets: decrypted only in the worker, only for the probe that needs them; never in `pos.usage`,
  logs, emails, audit, errors or API responses. `x-stats-token` only to `pos.host` over the guarded
  HTTPS path.
- Untrusted input: stats, GraphQL and Vercel bodies are parsed into bounded fields; provider text
  never reaches storage (codes only; `ProviderError` rules unchanged).
- SSRF: no new hosts — `pos.host` (already probed by Stage 2) and the fixed provider bases.
- Abuse/load: checks only on explicit owner/admin action, rate-limited, one at a time, refused while
  the worker is offline.
- No new npm dependencies.

## 11. Tests (TDD: each unit starts with failing tests)

- **`test/phase2-lib.test.js`** (U1): `getText` query allowlist; `probeSite` up/down/paused (header
  and body)/db-down/tenant-mismatch/timeout/latency/stats with and without token; `parseStats`
  (denied, error, bootstrap, ledgers, garbage, caps); `evaluateAlerts` (thresholds, 3-probe rule,
  credentials, 24 h dedupe, escalation); `workerRequests` (variables, authz → `denied`, no token in
  errors); `tokenStatus`; `tokenInfo`; `clientDbStats` on the in-memory replica set; code table.
- **`test/phase2-worker.test.js`** (U2, injected clock and fakes): nothing runs without a queued
  check; one-at-a-time order; 3 attempts 5 s apart then `down`; deploy active → not raised; stats via
  token; denied → direct fallback; Cloudflare and credentials; lease lost → no write lands; takeover;
  expiry of old queued checks; batch end → exactly one email, dedupe on a second batch, escalation;
  single "Check now" → no email; SMTP failure → check still `done`; `--self-check --usage` writes
  nothing; no secret in DB rows, logs or emails.
- **`test/phase2-api.test.js`** (U3): role matrix (viewer/operations 403); non-POS 400; watch
  toggle + audit; check now 202/409/429/503; batch queues only watched and idle clients with one
  `batchId`; views whitelisted; fleet usage fields; overview counts; `assertNoSecrets` everywhere.
- **`test/ui/usage.spec.js`** (U4): seeded scenarios (healthy, storage 91 %, paused, Cloudflare
  denied, queued); watch checkbox, Check watched, Check now, Usage tab values, urgent row, Attention
  items; axe; no overflow at 320/390/768/1440.
- Existing suites stay green (`npm test`, `npm run build`, `npx playwright test --reporter=line`),
  then `bash scripts/test-linux.sh` on the server (0 fail).

## 12. Work units (disjoint files)

| Unit | Files | After |
| --- | --- | --- |
| **U1** shared + adapters | `shared/usage.js`, `shared/usage-codes.js`, `backend/lib/{safe-https,pos-health,client-mongo,cloudflare,vercel}.js`, `test/fakes/{health,vercel}.js`, new `test/fakes/cloudflare.js`, `test/phase2-lib.test.js` | — |
| **U2** worker | `backend/worker/usage.js`, `backend/worker/{loop,context}.js`, `backend/worker.js`, `backend/db.js`, `test/phase2-worker.test.js` | U1 |
| **U3** API | `backend/modules/usage.js`, `backend/lib/usage-view.js`, `backend/app.js`, `backend/modules/{deploys,overview}.js`, `shared/schemas.js`, `test/phase2-api.test.js`, `docs/API.md` | U1 (parallel with U2) |
| **U4** UI | `frontend/src/pages/{installation-usage,installation-workspace,pos-fleet,overview}.jsx`, `frontend/src/components/usage/*`, `frontend/src/styles/{usage.css,styles.css}`, `test/ui-server.js`, `test/ui/usage.spec.js` | U3 |
| **U5** review + docs | independent read-only opus reviews (worker + adapters; API + UI) on a fingerprinted tree → fix all critical/high/medium → re-review; `docs/{POS-INTEGRATION,SECURITY,DEPLOYMENT,VALIDATION}.md` | U2-U4 |

## 13. Release (owner runs, one step at a time)

1. `mongodump` of `sandbee_admin` (D13).
2. In each client's Cloudflare dashboard: edit the imported token → add **Account Analytics: Read**
   (demo first). Token value is unchanged; nothing to re-enter in admin.
3. `bash scripts/test-linux.sh` on the server → 0 fail.
4. `cd ~/admin && git pull && docker compose -f compose.production.yaml up -d --build`; `ps` → both healthy.
5. `docker compose -f compose.production.yaml exec worker node backend/worker.js --self-check --usage=<demo id> --mail-test`.
6. UI: POS clients → tick Watch for demo → Check watched clients → result within ~15 s; Usage tab.
7. Rollback: `git checkout 71e3745 && docker compose -f compose.production.yaml up -d --build`
   (additive data: `pos.usage` is ignored by the old code).

## 14. Edge cases and chosen handling

1. No `healthStatsToken` → stats asked without the header; if denied → direct `dbStats` (core only) + notice.
2. Stats `denied` (token rotated on the client) → direct fallback + notice.
3. Site down → stats unavailable → direct fallback still measures storage.
4. Deploy/rollback in progress during a check → site result shown, no site-down level.
5. Worker offline when triggering → 503 "Worker offline", nothing queued; worker dies mid-check →
   lease takeover; queued > 30 min → expired.
6. Trigger while a client's check is queued/running → that client is skipped (`skipped` count).
7. Watch list empty → "Check watched" disabled with a hint.
8. Cloudflare account id missing → `cf-not-set`; no analytics permission → `cf-denied`; 429 → retried by `provider-http`, then `cf-rate-limited`.
9. Vercel token type that cannot read `tokens/current` (403) → `expiry-unknown` notice.
10. SMTP down → no email; results still on screen.
11. A client removed from the watch list mid-batch → its queued check still runs (it was asked for).

## 15. Risks

1. **Nothing is checked unless you trigger it** (your choice): a token can expire or a site can be
   paused unseen between checks — run "Check watched clients" regularly (e.g. weekly).
2. Cloudflare dataset shape (no-dimension aggregate) verified only live → self-check at step 5; fix is a query constant.
3. Paused header unverified → body match too; fixture tests.
4. Hobby usage stays invisible by design (D34).
5. Fallback `dbStats` measures one database (the cafe's), same scope as the cafe's own stats.

## 16. Not in scope (Phase 2)

Scheduled/background monitoring; history, trends and "full in ~N days" (needs history — see Q2);
Vercel bandwidth/CPU estimates; Atlas Admin API; GitHub PAT expiry; Cloudinary `imageUsage`;
alert acknowledge/snooze; per-client thresholds; POS changes (D11).

## 17. Questions for the owner (recommended default first)

1. **Email**: one summary email when a "Check watched clients" batch finishes, only if any client is
   warning/critical, de-duplicated per client per type per 24 h (your brief). **Default: yes.** Or no
   email at all (results only on screen)?
2. **"Full in ~N days"**: without history this cannot be computed. Optionally keep just the
   **previous check's storage size** per cluster (one number each, overwritten) to show "+12 MB since
   the last check (6 days ago) → full in ~N days". **Default: no — only current status, as you said.**

Owner answers (2026-10-11): Q1 yes (summary email), Q2 no (current status only). Approved.

## 18. As built (after the independent reviews, 2026-10-11)

Where the code differs from the text above, the code (and docs/API.md) is authoritative:

1. **Site probe:** up to 3 PLAIN probes 5 s apart (site state and latency never include the cafe's
   dbStats work), then — only when the site answered — ONE separate `?stats=1` request. An up site
   costs 2 requests, a down one 3. `bad-host`/`blocked` are not retried and never raise `site-down`
   (setup problems, not outages); `site-down` needs `probes >= 3`. A queued deploy does not
   suppress it (only a running/cancelling one does).
2. **Stats token bound to its host (D37):** sent only when `pos.statsHost === pos.host` and the
   value is header-safe; `pos.statsHost` is written only by the secret PUT/DELETE and the import (and
   once by the boot migration `bindLegacyStatsHosts`). New codes `stats-host-changed`,
   `stats-token-invalid`, `secret-unreadable`.
3. **Queue:** no 30-minute age expiry (`CHECK_QUEUED_MAX_MS` dropped): a queued check expires only at
   worker boot after the heartbeat was stale for 10+ minutes (the Stage 2 task rule), so a long batch
   is never cut short; the API never frees a queued slot and frees a running one after a 15-minute
   dead lease. The usage lane uses the shared 60 s lease (`usageLeaseMs` not built) and is not
   counted in `activeJobs` (the deploy free-disk check).
4. **Email:** only checks of the batch that finished (`done`) are listed; failed/expired members are
   counted as "could not be checked" (their older result is never mailed as current); the boot
   expiry also triggers the summary (after the worker's first heartbeat); a once-per-batch marker (a
   TTL rate counter) prevents a double send and is freed again when nothing could be sent; the
   mail-memory write never recreates a removed POS block.
5. **Shapes:** cluster `label` (not `tag`), `mongo.statsCode`, site state `unknown` (no host);
   `evaluateAlerts(last, now)` + `dueMail(mail, alerts, now)`; overview `lastCheckAt`; fleet
   `workerOnline`, `usageStalled` and `usage.batchable`; Usage GET `stalled`; log events
   `usage-check`, `usage-failed`, `usage-mail`, `usage-mail-failed`.
6. **API/UI:** batch refusals (worker offline, nobody watched, all busy) happen before the hourly
   allowance; retired installations are not batched or counted; "stalled" is decided by the server
   (worker offline, or a check queued > 10 minutes while none is running and none finished in the
   last minute); the fleet refreshes 10 s after each answer while checks run and not stalled, the
   Usage tab every 5 s; progress text "Checking: N left".
7. **Time budget:** a check that exceeds its 60 s budget fails as `check-timeout` and keeps the
   previous result (a half-measured result would read as failures); provider retry waits are
   abort-aware.
