# P3 — "Deploy this commit to all clients" (rollout)

Status: APPROVED by the owner 2026-10-12 (questions 1-4: the recommended defaults). Implemented on
branch `p3-rollout`, merged to main @ e44649c and LIVE since 2026-10-12; §12 records what was built.
Binding: `docs/ROADMAP.md` house method, `docs/POS-INTEGRATION.md` D1-D38 (esp. D4, D11, D22-D28,
D38), approved design `docs/POS-STAGE2-REV2.md` §3.5. No POS repo change, no new npm dependency, no
new collection, container, volume or `.env` variable. Branch `p3-rollout`.

## 1. What exists (verified in code; reviewed by three read-only agents, spot-checked)

- **Enqueue** (`backend/modules/deploys.js:521-595`, `POST …/pos/deploys`): permit `deploy` →
  `requireStepUp` (session-wide, 10 min) → strict zod → typed slug → `readiness()` + `gate("deploy")`
  → busy check → `consume deploy:<id>` 30/h → `verifySha()` (branch head + GitHub compare; 409
  `branch-moved` / `sha-not-on-branch`) → `gh.commit()` → `buildKeyFor()` → one transaction
  (`authorizeWrite` → re-read → gate → `newJob()` → `claimDeploySlot()` with `freeSlot()`,
  `pos.rev`, `pos.deployLock:false` → audit). `newJob`, `claimDeploySlot`, `verifySha`, `readiness`
  are closure-private; `freeSlot`/`person`/`stepsFor`/`leaseless` are module-private.
- **The worker has no source token** (compose blanks it): `branch`, `sha` and `commit` must come
  from the API. It can compute a build key itself (`buildInputs` + `buildKeyOf` from its heartbeat's
  builder info, `backend/lib/build-inputs.js:116,131`) and look up the S3 cache (`ctx.cache.lookup`).
- **Lanes** (`backend/worker/loop.js:32`): deploy 1 (global: one deploy at a time across all
  clients, oldest `requestedAt` first), build 2, task 1, usage 1; tick every 3 s; `drain()` for tests.
  A singleton `system_state` row with a fenced lease already exists as a pattern (`pos-retention`,
  `retention.js:339-376`, `lease.js:48-116`).
- **Job outcome** (`backend/worker/deploy.js`): success → `last.requestId = rid`, `current = null`;
  failed / cancelled (also by freeze: `error.code:"frozen"`) / rolled-back / unhealthy / expired →
  `current` keeps the job with that status. Unhealthy without rollback ALSO writes `last` with the
  new rid → `current` must be checked first. A dismiss or a new enqueue can erase `current`.
- **Freeze**: the worker leaves queued deploys queued and cancels running ones before upload
  (`frozen`); the build lane ignores freeze.
- **Build rows** (`pos-build:<sha>:<buildKey>`): a row with no waiters and no `prepared` is
  cancelled by the build lane; `prepared` keeps it alive (`build.js:553-564`). Insert/join/reset
  logic exists twice (worker `ensureRow` `deploy.js:335-388`, API prepare-build `deploys.js:1041-1062`).
- **Fleet** (`GET /pos/fleet`, `deploys.js:1236-1415`): ≤ 100 rows sorted by slug; no rollout UI,
  no "rollout" anywhere in code. UI patterns: `usePoll`, `Modal`, `withStepUp`, `describeError`,
  typed confirm `Field`, reason `span` + `aria-describedby`, `table-wrap` region
  (`purge-panel.jsx`, `deploy-actions.jsx`). `test/ui-server.js` runs the REAL backend; specs move
  state through control endpoints on :8109 (scenarios n 1-29 used; owners `deploy-owner-a..w`).

## 2. Decisions (proposed D39)

1. **Who drives it: the worker.** A new rollout step in `tick()` (before the deploy-lane claim)
   advances the `pos-rollout` row and enqueues ONE normal deploy job at a time (same `newJob`
   shape, `kind:"deploy"`, `by` = the starter). The API only starts/cancels/resumes/dismisses and
   reads (house rule "API enqueues, worker executes"). No timers in the API, no side effects on GET.
2. **Targets are fixed at start**: POS installations with `pos.deployLock === false`, verify state
   `ok` (< 24 h), customer not paused/archived, installation not retired, Vercel token + ids + host +
   image/realtime inputs ok, and `last.sha ≠ sha` (never deployed counts as different). Order: slug
   `demo` first (canary), then the rest by slug A→Z. Max 100 (fleet cap; more → 409).
3. **Preview → start with a digest** (purge pattern): `GET /pos/rollout/plan?branch=` returns the
   head commit, ordered targets, excluded clients with a reason, and `digest` = SHA-256 of
   `sha|id1,id2,…` (ordered). Start recomputes; any difference → 409 `targets-changed`.
4. **Gates**: start = `deploy` + step-up + `confirm: "deploy all"` (exact) + admin readiness
   (`worker`, `builder`, `source-token`, `authenticator`, `not-frozen`) + **build cache on**
   (409 `cache-off`: without S3 a pre-built artifact lives 2 h, too short for a long rollout) + no
   rollout running (409 `busy`) + **no deploy job active on any POS client** (409 `busy`, names the
   slug). 10/h per staff.
5. **Builds first**: on its first pass the driver computes every target's build key, skips cache
   hits and inserts/joins one build row per distinct key, canary first, marked
   `prepared:{by, at, rollout:<id>}` (an existing `prepared` is never overwritten). The build lane
   runs them 2 at a time. The canary's deploy job is enqueued at once and joins its row as a
   waiter, so the canary is never delayed.
6. **Deploy one at a time; stop at the first failure.** At a target's turn the driver re-checks it:
   - **skipped, continue**: locked, customer paused/archived, installation retired, POS block gone,
     already on the commit (`already-live`) — deliberate owner states, not failures;
   - **stop**: any other readiness problem (`target-not-ready` + readiness ids, e.g. verify older
     than 24 h), another job active on that client (`target-busy`), the starter lost the right to
     deploy (`not-authorized`: staff not active, role or `authVersion` changed — the same conditions
     as `authorizeWrite`), freeze on (`frozen`);
   - outcome of its job: `last.requestId = rid` and `current` not ours → **succeeded**; ours with
     status failed / rolled-back / unhealthy / expired → **failed** (code = the job's `error.code`,
     else the status-derived known code); cancelled → **skipped** (`cancelled` or `frozen`) and the
     rollout stops (or ends cancelled when the owner cancelled it); neither → **failed `job-lost`**
     (the job was dismissed/replaced before the driver saw it).
   On a stop: the rest become `skipped` (`rollout-stopped`), status `stopped`, `stop:{slug, code}`.
   Pre-builds keep running (a Resume reuses them).
7. **Owner actions** (fleet page): **Cancel** (`deploy`, no step-up: it only reduces risk) — the
   API, in one transaction, flags the rollout `cancelling` and cancels the in-flight job exactly
   like the per-client Cancel (queued → cancelled; before upload → cancelling; after upload it
   finishes — "too late" is normal). The driver then ends `cancelled`, marks the rest `skipped`
   (`cancelled`) and releases its pre-builds (queued rows without waiters → cancelled; running rows →
   `prepared:null`, the build lane cancels them). **Resume** (`deploy` + step-up, only when
   `stopped`): re-checks the sha is still on the branch and the start gates, resets every
   non-succeeded target to `pending`, re-runs the pre-build pass, `resumed:{by, at}`; the driver
   then retries the client it stopped at. **Dismiss** (`deploy`, only when finished): deletes the
   row (D4: nothing kept; the audit trail stays).
8. **Freeze stops it**: the driver never enqueues while frozen; a queued rollout job is cancelled
   by the driver (`frozen`), a running one is stopped by the existing worker freeze check before
   upload; the rollout ends `stopped` (`frozen`). Resume is refused while frozen.
9. **Manual work during a rollout is not blocked**: a manual deploy on a pending client makes the
   rollout stop at that client (`target-busy`); dismissing the rollout's own job → `job-lost`.
10. **Audit**: API `pos.rollout.started` / `.resumed` / `.cancel-requested` / `.dismissed`
    (resource `system`, id `pos-rollout`, detail `branch@sha7 N clients #id8`); per client the
    worker writes `pos.deploy.requested` (resource `installations`, actor "Deploy worker", detail
    `branch@sha7 #rid8 rollout #id8`); the existing job outcome audits are unchanged; the driver
    writes `pos.rollout.finished` (`completed|stopped|cancelled: X ok, Y failed, Z skipped #id8`).
    No new email (existing deploy emails unchanged).

## 3. Data model — `system_state` `_id:"pos-rollout"` (one row, D4)

```
{ _id:"pos-rollout", id (uuid), status: running|cancelling|stopped|cancelled|completed,
  branch, sha (40-hex), commit {sha, branch, headline<=120, authorName, date} | null,
  by {id, name}, auth {id, name, authVersion, role}  // server only: re-authorization
  resumed {by {id,name}, at} | null, startedAt, finishedAt, stopOnFailure: true,
  cancelRequested, stop {slug, code} | null, prepared (pre-build pass done),
  lease {owner, until, fence},
  targets[<=100]: { installationId, slug, status: pending|building|deploying|succeeded|failed|skipped,
    requestId | null, buildKey | null (server only), prebuild: cached|queued|joined|unavailable|null,
    error {code, items?} | null, startedAt, finishedAt } }
```
§3.5's `error8` is stored as `error.code` only (a code from `shared/deploy-errors.js`; `items` =
readiness ids for `target-not-ready`); never provider text. Status mapping while a client's job
runs: steps queued…fetch → `building`, upload…finalize → `deploying` (written only on change).
≈ 250 B per target → ≤ 25 KB. No index (lookups by `_id`); `system_state` is already in the
snapshot set. Constants in `shared/deploy.js`'s header comment get the row too.

## 4. API (`backend/modules/deploys.js`, inside `deployRoutes`, next to freeze/fleet)

| Route | Gate | Notes |
| --- | --- | --- |
| GET `/pos/rollout` | credentials | `{rollout: view \| null}`. View (`rolloutView`, `backend/lib/deploy-view.js`): `{id, status, branch, sha7, commit{headline, authorName, date}, by{name}, resumed, startedAt, finishedAt, cancelRequested, stop{slug, code}, counts{total, pending, active, succeeded, failed, skipped}, targets[{installationId, slug, status, build: cached\|building\|ready\|failed\|null, error{code, items}, startedAt, finishedAt}]}`; `build` from one `$in` read of the pre-build rows. Never lease, auth, requestId, buildKey |
| GET `/pos/rollout/plan?branch=` | credentials, 120/h per staff | `{branch, head{sha, sha7, headline, authorName, date}, targets[{installationId, slug, customerName, live{branch, sha7}\|null, older (live is newer than this commit), cached}], excluded[{installationId, slug, customerName, code, items?}], blocked[admin readiness ids], busy[slugs], active (a rollout is running/cancelling), limited, digest}` |
| POST `/pos/rollout` | deploy + step-up | `{branch, sha, digest, confirm:"deploy all"}` strict. Order: step-up → zod → typed phrase 400 → admin gates / cache 409 → rollout busy 409 → any active deploy 409 `busy` → `consume rollout:<staff>` 10/h → `verifySha` → targets + digest (409 `targets-changed`, 409 `no-targets`) → `gh.commit` → transaction: `authorizeWrite` → conditional upsert (no row, or status stopped/cancelled/completed) → audit. 201 `{rollout}` |
| POST `/pos/rollout/cancel` | deploy | `{id}`; running → cancelling + in-flight job cancel (shared helper extracted from the per-client cancel route, same filters); idempotent while cancelling; 409 when finished |
| POST `/pos/rollout/resume` | deploy + step-up | `{id}`; only `stopped`; `verifySha`, admin gates, freeze, cache; shares the 10/h; 200 `{rollout}` |
| POST `/pos/rollout/dismiss` | deploy | `{id}`; only stopped/cancelled/completed; deletes the row |

New API codes: `targets-changed`, `no-targets` (409). Reused: `busy`, `not-ready` (+items),
`cache-off`, `branch-moved`, `sha-not-on-branch`, `provider-error`, `stale`. Schemas in
`shared/schemas.js` (`deploySchemas.rollout*`, `.strict()`). Small extraction (no behaviour change):
`newJob`, `stepsFor`, `leaseless`, `person`, `freeSlot` and one `newBuildRow()` move to a new
`backend/lib/deploy-job.js` used by the API, the worker's `ensureRow` and the rollout driver (the
build-row shape then exists once instead of three times).

## 5. Worker — `backend/worker/rollout.js` (new) + one call in `loop.js` `tick()`

`rolloutStep(ctx)` → 1 when it changed something (keeps `drain()` going), else 0; errors are caught
and logged as `rollout-step-failed` + code, never failing the tick. Per pass: `findOne` the row;
nothing unless `running|cancelling`; claim with a fenced lease (`$inc lease.fence`, 60 s; takeover
after expiry, like `pos-retention`); every write filters on `{id, lease.owner, lease.fence}` and the
status it read (a concurrent cancel makes the write miss; the next pass re-reads). Then, in order:
1. pre-build pass (once per start/resume, §2.5; builder info from the heartbeat, no fresh GitHub read;
   builder not ok → `prebuild:"unavailable"`, the deploy jobs build on their own);
2. in-flight target → map its job (§2.6) and write the change;
3. none in flight: cancelling → end `cancelled`; frozen → end `stopped`/`frozen`; else next pending
   target → checks (§2.6) → one transaction: re-read installation + staff check → `claimDeploySlot`
   filters (`freeSlot`, `pos.rev`, `deployLock:false`) → target `building` + `requestId` (fenced) →
   audit; a missed slot claim retries on the next pass (re-read), a blocking job stops;
4. no pending left → `completed` + `finishedAt` + `pos.rollout.finished`.
Cost while running: 1-3 Mongo ops per 3 s; idle: one `findOne` per tick.

## 6. UI — `frontend/src/components/deploy/rollout-panel.jsx` (new) on `pos-fleet.jsx`

Panel `section.panel.rollout-panel` "Deploy a commit to all clients", after the freeze notice,
before the summary/table; own `usePoll("/pos/rollout", {activeMs: 3000, idleMs: 30000})`; fleet rows
give customer names. Owner = `can(user.role, "deploy")`; admin sees everything read-only.
- **Idle**: `BranchPicker` (global `/pos/branches`) → plan: commit (branch@sha7, headline, author,
  age); "N clients will get this commit — demo first, then A–Z. Stops at the first failure."; ordered
  table (#, client, slug, live now, build cached / will build, "older than live" warning); "Not
  included (M)" with reasons (`describeError` titles / readiness titles); `blocked`/`busy` lines.
  "Deploy to N clients…" disabled with a visible reason (not owner, not ready, frozen, busy, none,
  rollout active).
- **Modal** (purge pattern, snapshot of `{branch, sha, digest, count}` on open): what happens
  per client, stop rule, "env vars on Vercel are not changed", `Type deploy all to confirm`,
  `withStepUp` → POST; 409 `targets-changed` / `branch-moved` → message + plan reload.
- **Running/cancelling**: "Deploying main@abc1234 to N clients — X of N done"; table: order,
  client, status badge (Waiting / Building / Deploying / Live / Failed / Skipped) + build sub-text
  for waiting clients + "Open →" (client Deploy tab); Cancel rollout (confirm modal; text says a
  client already uploading finishes). Worker offline → "Waiting for the worker".
- **Stopped**: `error-why` alert "Stopped at <slug>: <title>. <plain message>. What to do: …",
  Resume (confirm modal + step-up; disabled while frozen with the reason) and Dismiss.
- **Completed / cancelled**: counts line + Dismiss. Status line `role="status" aria-live="polite"`
  always mounted; focus to the panel heading when the acting button disappears; tokens only; no
  overflow at 320/390/768/1440 (tables scroll in their own region).
Styles: a few `.rollout-*` rules in `frontend/src/styles/components.css`.

## 7. Error codes (`shared/deploy-errors.js`, used by the worker and the panel)

New: `rollout-stopped`, `already-live`, `target-not-ready`, `target-busy`, `job-lost`,
`not-authorized` (plain message ≤ 160, "what to do"). Reused: `locked`, `customer-inactive`,
`not-found`, `cancelled`, `frozen`, `not-picked-up`, every job failure code.

## 8. Tests (failing first)

- `test/p3-rollout-lib.test.js` (pure): target selection + exclusion codes, canary + A-Z order,
  digest (order-sensitive), job-outcome mapping incl. the unhealthy-with-`last` case and job-lost,
  view whitelist (no lease/auth/requestId/buildKey), counts.
- `test/p3-rollout-api.test.js` (`startApp` + fake GitHub/S3): plan (targets, exclusions, busy,
  blocked, older warning, cached); start gates in order (admin 403, 428, phrase 400, frozen /
  worker / builder 409 `not-ready`, cache off 409, busy rollout 409, active deploy 409, digest
  409, no targets 409, branch moved 409, 429); one row + audit; cancel (queued job → cancelled,
  pre-upload → cancelling, post-upload untouched), resume (only stopped, step-up, resets, re-verify),
  dismiss (only finished); concurrent starts → one 201 + one 409.
- `test/p3-rollout-worker.test.js` (own `makeEnv/makeWorker`, the Phase 2 pattern; fakes GitHub,
  S3 cache, Vercel, CLI): happy path 3 clients (demo first; one shared build key built once; cache
  hit skipped; deploys strictly one at a time; `completed`); stop on failed build / rolled-back /
  unhealthy / expired (rest `skipped`); skip locked / inactive / already-live and continue;
  stop on stale verify, busy client, revoked starter (`authVersion`), dismissed job; freeze (queued
  job cancelled, running job stops before upload); cancel (pre-builds released); resume retries the
  stopped client; worker killed mid-rollout → second worker takes the lease over and finishes once
  (no duplicate enqueue); no secrets in the row (`assertNoSecrets`).
- `test/ui-server.js`: scenario `demo` (n 30, ready), owners `x`/`y`, control
  `POST /pos/rollout?status=&target=&tstatus=&code=` that moves the row like the worker; fix any
  existing fleet count the new row changes.
- `test/ui/rollout.spec.js`: plan (demo first, exclusions), modal (typed phrase + step-up, exact
  request body), running progress, stop → Resume / Dismiss, cancel, admin read-only, frozen reason;
  axe + overflow at 320/390/768/1440.

## 9. Work units

| Unit | Files | Evidence |
| ---- | ----- | -------- |
| U1 shared + lib | `shared/rollout.js` (new: constants, `selectTargets`, `orderTargets`, `rolloutDigest`, `targetOutcome`, `rolloutCounts`), `backend/lib/deploy-job.js` (new, moved helpers), `shared/deploy-errors.js`, `shared/schemas.js`, `shared/deploy.js` (header comment), `backend/lib/deploy-view.js` (`rolloutView`), `backend/modules/deploys.js` + `backend/worker/deploy.js` (imports only), `test/p3-rollout-lib.test.js` | failing → green; existing suites green |
| U2 API | `backend/modules/deploys.js` (routes, cancel helper), `test/p3-rollout-api.test.js` | failing → green |
| U3 worker | `backend/worker/rollout.js` (new), `backend/worker/loop.js`, `test/p3-rollout-worker.test.js` | failing → green |
| U4 UI | `frontend/src/components/deploy/rollout-panel.jsx` (new), `frontend/src/pages/pos-fleet.jsx`, `frontend/src/styles/components.css` | `npm run build` |
| U5 UI tests | `test/ui-server.js`, `test/ui/rollout.spec.js` (new), fleet-count fixes in existing specs if needed | Playwright green |

U1 first; then U2 ∥ U3 ∥ U4 (disjoint files); U5 last. Then verbatim `npm test`, `npm run build`,
`npx playwright test --reporter=line`; 2 independent read-only opus reviews on a fingerprinted
tree, fix every critical/high/medium, re-review; docs: `docs/API.md` (rollout section + `pos-rollout`
row), `docs/SECURITY.md` (short rollout bullet: authority, gates, re-authorization), `docs/DEPLOYMENT.md`
(P3 release checklist); `bash scripts/test-linux.sh` on the server; merge, push, server steps.

## 10. Risks

1. **F1 multiplies**: admin deploys send no `regions`, so every client in a rollout runs its
   functions in its project's default Function Region. Check demo (`x-vercel-id`) and set each
   project's region before rolling out to more clients (P2 runbook Q1).
2. A rollout runs for a long time under the starter's step-up at start: bounded by the per-client
   re-authorization, freeze, Cancel and the step-up gate on Resume.
3. Verify must be < 24 h at each client's turn; a long rollout can stop at `target-not-ready` →
   Verify, then Resume.
4. A broken commit builds for every target before the canary fails (see Q2).
5. The builder head moving mid-rollout changes later build keys → those clients build again (correct,
   slower).
6. Worker offline → the rollout simply waits (panel says so); nothing is lost.
7. Today only demo deploys from admin, so the first real rollout has one target; the multi-client
   path is proven by tests until P2 (Lucifer) is done.

## 11. Owner questions (recommended defaults in bold)

1. Canary = the client with slug `demo` (fixed in code); if demo is not a target, the first client
   A→Z simply goes first. **Yes.**
2. Builds: queue every target's build at start (approved §3.5, fastest) — or build the others only
   after the canary is live (a broken commit then costs one build, not N)? **Queue all at start.**
3. Resume = retry the client it stopped at, then continue (step-up, no typing); to leave a client
   out, Lock it — locked clients are skipped. **Yes.**
4. Mid-run rule: locked / customer paused-archived / retired / already on the commit → skipped and
   continue; anything else (verify older than 24 h, missing settings, another deploy running, its job
   dismissed, starter's access changed, freeze) → stop. **Yes.**

## 12. As built (2026-10-12)

- Units U1-U5 with TDD: the U1 lib test, the U3 worker test (14/14 failing because nothing drove the
  row) and every review-fix test were run red first; the U2 API tests were written before the routes
  (they would have answered 404). U4/U5 (panel, test-server controls, Playwright spec) were written
  after the API contract.
- Small extraction, no behaviour change: `backend/lib/deploy-job.js` (`newJob`, `newBuildRow`,
  `freeSlot`, `cancelFields`, `releasePrebuilds`, ...) is shared by the API, the worker's build step
  and the rollout driver.
- Differences from §2-§6, all from the two independent read-only opus reviews (tree fingerprint
  unchanged before/after each round) and their re-review:
  - The pre-build pass makes no S3 call (it could block the worker loop for minutes with many
    clients): every waiting client's key gets a build row; the build lane adopts a cached build
    before dispatching. Known limit: during an S3 outage the lane cannot see a hit and dispatches a
    GitHub build (GitHub minutes only; this was already the deploy job's behaviour).
  - A deploy that goes live but fails its health check without a rollback now records
    `last.healthy:false` (rollback records its own verdict), so such a version is never read as a
    success or as "already live": the rollout stops there, and Resume or a new plan deploys it again.
  - A client locked or paused while its job waited is refused in preflight and is now skipped (the
    rollout continues), as for a client locked before its turn.
  - The worker re-checks the starter's authority inside the enqueue transaction too (a conditional
    write on the staff record, like `authorizeWrite`).
  - Resume resets only the client it stopped at and the clients not reached; succeeded clients and
    deliberate skips stay, so the stopped client really goes first.
  - Dismiss also clears a `cancelling` rollout once its client in flight has no deploy job running
    (escape hatch if the worker cannot end it); Dismiss and a replacing start release the rollout's
    pre-builds; an owner's Prepare build takes a rollout's marker over. Resume keeps pre-builds.
  - The plan tells "newer commit live" (`older`), "live commit not on this branch" (`diverged`) and
    "live but unhealthy" (`unhealthy`) apart; the confirm dialog repeats the counts.
  - GET `/pos/rollout` also returns the freeze state and whether the worker is online.
  - The idle panel loads the branch list only after "Choose a commit…" (the branch list is a 120/h
    budget shared with the Deploy tab).
  - `loop.drain()` (tests and drills only) needs one more idle pass before it returns, because a job
    can finish right after the rollout step looked at it; a killed worker renews no rollout lease.
- Cosmetic limits accepted: a cached client's pre-build shows "Building" until the build lane adopts
  it; a dismissed `health-unknown` job reads as `health-failed`.
