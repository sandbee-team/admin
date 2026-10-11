# P1 — "Old source deployments" panel (+ test-server Mongo clean-up)

Status: APPROVED by the owner 2026-10-12 (questions 1-3: yes; the 32 old `mongo-mem-*` folders were deleted by the owner). Implemented on branch `p1-purge-panel`; §9 records what was built.
Binding: `docs/ROADMAP.md` house method, `docs/POS-INTEGRATION.md` D1-D37, `docs/POS-STAGE2-PLAN.md` §6/§8.

## 1. What exists (verified in code)

- API (`backend/modules/deploys.js:920-998`): `POST …/pos/purge/preview` (`deploy`, body `{}`, gate
  `purge`, 409 without `cutoverAt`, one task slot `pos.task`, 409 `busy` if any task is active) and
  `POST …/pos/purge` (`deploy` + step-up 428 + typed slug 400; 409 unless the slot still holds that
  preview, `succeeded`, ≤ 30 min old (`PURGE_WINDOW_MS`), non-empty, digest equal). The ids come from
  the stored preview, never from the browser.
- Worker (`backend/worker/purge.js`): `classify()` **always keeps**: the project's live production
  deployment (as Vercel reports it), admin's Live (`last`) and Previous (`previous`) deployments,
  **every prebuilt deployment** (everything admin uploaded), everything created **at or after the
  cutover**, and any deployment without a creation date. It reads the **newest 500** deployments of
  the project. The preview stores ≤ 200 candidates + `total` + `keep` (count). Execute re-lists,
  re-checks every id (no longer a candidate → `skipped`), deletes one at a time 500 ms apart
  (already gone = deleted), result `{deleted, skipped, failed}`; any failure → status `failed`,
  code `delete-failed`; audit `pos.purge.completed` (counts only).
- State for the UI: `GET …/pos/deploys` already returns `task` (`taskView`), `cutoverAt`,
  `readiness`, `worker`; the Deploy tab polls it every 2 s while a task is active (`isActive`).
- Error codes `no-cutover`, `digest-mismatch`, `delete-failed` are already in `shared/deploy-errors.js`.
- Tests: `test/stage2-api.test.js:1610-1717`, `test/stage2-worker.test.js:1712+` cover the routes and
  the worker. **No UI exists.**

### Gaps found (each gets a failing node:test first)

| # | Gap | Fix |
| - | --- | --- |
| G1 | `taskView` drops `result.keep`, so the panel cannot say how many are kept | add `keep: int(result.keep)` to the purge-preview view (count only) |
| G2 | `taskView` drops `progress`; a 200-item purge runs ≥ 2 min with no progress | add `progress: {done, total}` (ints) **for kind `purge` only** |
| G3 | `test/ui-server.js` `/pos/task` can only write a `db-backup` task | extend with `kind`, preview/purge results, age (test infra) |

No worker change is needed.

## 2. Decision (proposed D38)

D38 — Purge panel on the Deploy tab: preview → typed slug + step-up → execute, using only the
existing routes; ≤ 200 per run (preview again for the rest); the 30-minute window is shown from the
browser clock and the server stays the authority (a 409 offers a new preview); the task view adds the
kept count and purge progress (counts only).

## 3. UI — `frontend/src/components/deploy/purge-panel.jsx` (new) + page wiring

Placed on `installation-deploy.jsx` after "Client database backup", before "Freeze all deploys".
The page passes `data` (its existing poll), `owner`, `slug`, `blocked = blockedFor(readiness,"purge")`
and `onRefresh = poll.refresh`. No new poll, no new route.

Panel `section.panel.purge-panel` "Old source deployments" — subtitle: "Source uploads made in this
client's Vercel account before admin took over. Admin deploys compiled output only (D7)."

States (one `role="status" aria-live="polite"` line; errors `role="alert"`):
1. **No cutover** (`data.cutoverAt` null): "Available after the first verified admin deploy." No buttons.
2. **Idle**: "Preview old deployments" (secondary). Disabled with a visible reason (`aria-describedby`):
   not owner → "Only the owner can remove old deployments."; gate → "Not ready: <titles>.";
   another task active → "Another task is running for this client."
3. **Preview running** (`task.kind==="purge-preview"`, queued/running): "Listing deployments… waiting
   for the worker." / "…".
4. **Preview ready** (succeeded): summary "N old deployments found (K kept)."; if `total > 200`:
   "Showing 200 of N; this run removes these 200, then preview again."; always-kept note (the list in
   §1, with the cutover date); a scrollable table (`.table-wrap`, `tabindex=0`, `role=region`,
   labelled, max-height) — Deployment (id, first 12 chars), Created (`dateTime`), State, Target
   (empty → "preview"). Valid-until line ("Use this preview before 14:32"). Buttons: "Remove N old
   deployments…" (danger) + "Preview again". When **0 found**: "Nothing to remove." + "Preview again".
   When **older than 30 min** (re-rendered by a timer at the expiry moment): "This preview is older
   than 30 minutes." + "Preview again" only.
5. **Confirm modal** `PurgeModal`: snapshot `{previewTaskId, digest, count}` taken on open; text: what
   goes (count, created before <cutover>), that it cannot be undone, live site unchanged, what is
   always kept; `Field` "Type <slug> to confirm"; submit disabled until it matches; `withStepUp` →
   `POST …/purge {previewTaskId, digest, confirm}`. Any non-cancelled error closes the modal and shows
   the server message in the panel (`not-ready` → "Needs: <titles>"), then refreshes — the panel then
   offers "Preview again".
6. **Purge running**: "Removing old deployments… D of T done." (G2), queued → "waiting for the worker".
7. **Purge finished**: succeeded → "Removed X old deployments (Y skipped because they changed since the
   preview)." + "Preview again" to check for more; failed → `describeError(task.error)` title, plain
   message, "What to do", plus counts when present; `expired` → "The worker did not pick this up in
   time. Try again."

Non-owners (admin role) see the same state read-only (the GET already returns it to them).
Styling: existing classes (`panel`, `panel-title`, `deploy-action`, `error-why`, `table-wrap`) + a
few `.purge-*` rules in `frontend/src/styles/components.css` using `tokens.css` variables only.
No new library. No overflow at 320/390/768/1440 (the table scrolls inside its own box).

## 4. Test-server chore — `test/mongo-home.js` (new) + `test/ui-server.js`

Cause: Playwright stops `node test/ui-server.js` hard on Windows, so `repl.stop()` never runs and
the library's own `mongo-mem-*` temp dir stays (≈ 200 MB per run; 32 such folders now in `%TEMP%`).

Fix: the server owns its folder. `prepareMongoHome(base = %TEMP%/sandbee-ui-mongo)`:
- removes every `run-<pid>-<random>` folder in `base` **whose pid is no longer alive**
  (`process.kill(pid, 0)`); a locked folder (EBUSY) is skipped and retried next start;
- creates and returns `base/run-<pid>-<random>` (`mkdtemp`) → `MongoMemoryReplSet.create({…, instanceOpts:
  [{ dbPath }]})` (supported in mongodb-memory-server 11.2.0: with a `dbPath` no `mongo-mem-*` dir is
  created);
- a graceful stop (in practice only a manual Ctrl-C; Playwright kills hard on every OS) also removes
  it: `repl.stop({ doCleanup: true, force: true })`;
- if the folder cannot be prepared (a file in the way, no permission) the server starts as before with
  the library's own temp folder — the clean-up never blocks a test run.
Never touches anything outside `base`, so other processes' `mongo-mem-*` dirs (node:test runs) are safe.

## 5. Tests

- `test/stage2-api.test.js` (G1/G2, failing first): preview view carries `keep` as an int (object/garbage
  → 0); a `purge` task view carries `progress {done,total}` only (extra keys dropped), other kinds no
  `progress`.
- `test/ui-infra.test.js` (new, failing first): `prepareMongoHome` removes dead-pid run folders, keeps a
  live-pid folder (own pid), never touches a sibling `mongo-mem-x` outside `base`, survives an
  unremovable folder, returns a fresh empty dir.
- `test/ui-server.js`: new scenarios `purge` (n 26, ready + cutover), `purgebig` (n 27, ready + cutover),
  `purgenocut` (n 28, ready, no `last` → no cutover), `purgelocked` (n 29, cutover but locked); deploy owners `u`, `v`, `w`; `/pos/task`
  gains `kind=purge-preview|purge`, `candidates`, `total`, `keep`, `ageMin`, `deleted/skipped/failed`,
  `code`, and keeps the slot's id when the kind matches (the worker finishing the task the panel queued).
  Existing `db-backup` default unchanged.
- `test/ui/purge.spec.js` (new): (1) happy path: Preview → queued → control finishes preview (3) → table,
  kept note, valid-until → Remove → typed slug + step-up → request body is exactly
  `{previewTaskId, digest, confirm}` → running with progress → finished counts; axe on panel and modal;
  (2) 200-of-340 list, overflow at 320/390/768/1440 + axe; (3) expired preview shows only "Preview
  again"; a preview that expires server-side after the page loaded → 409 message + "Preview again";
  failed purge shows the `delete-failed` text from the shared table + counts; (4) no cutover / locked
  (`Not ready: Deploy lock.`) / another task running / admin read-only reasons.
- Existing READY scenarios already have a cutover, so every existing Deploy-tab axe/overflow check
  also covers the idle panel.

## 6. Work units (sequential; U1 and U3a have disjoint files and may run in parallel)

| Unit | Files | Evidence |
| ---- | ----- | -------- |
| U1 API view | `backend/lib/deploy-view.js`, `test/stage2-api.test.js`, `docs/API.md` (task row) | failing → green node:test |
| U2 Panel | `frontend/src/components/deploy/purge-panel.jsx` (new), `frontend/src/pages/installation-deploy.jsx`, `frontend/src/styles/components.css` | `npm run build` |
| U3a Chore | `test/mongo-home.js` (new), `test/ui-infra.test.js` (new), `test/ui-server.js` (boot/stop only) | failing → green node:test; no new `mongo-mem-*` after a Playwright run |
| U3b Spec | `test/ui-server.js` (scenarios, owners, `/pos/task`), `test/ui/purge.spec.js` (new) | Playwright green |

Then `npm test`, `npm run build`, `npx playwright test --reporter=line` (verbatim), 2 independent
read-only opus reviews (tree fingerprinted), fixes + re-review, `bash scripts/test-linux.sh` on the
server, merge/push, server steps, docs (POS-INTEGRATION status + D38, ROADMAP P1 done).

## 7. Risks

- Browser clock far ahead of the server makes a fresh preview look expired; the server is the
  authority and the owner can preview again (NTP-synced PCs: negligible).
- Projects with > 500 deployments: older ones are seen only after newer candidates are removed —
  the panel says "preview again until nothing is found".
- The task slot is shared: "Verify now" or a DB backup replaces a ready preview; the panel then just
  shows "Preview old deployments" again (server refuses a stale execute anyway).
- Purge runs even while a deploy is running (API allows it); safe because the new deployment is
  prebuilt and after the cutover, and every id is re-checked against the keep set.

## 8. Owner questions (recommended defaults in bold)

1. G1/G2: add the kept count and purge progress to the task view (counts only)? **Yes.**
2. Admin-role staff see the preview list read-only (no buttons)? **Yes** (the API already shows it).
3. Delete the 32 old `%TEMP%\mongo-mem-*` folders now (≈ 6.8 GB measured, all stale), only after checking no
   `mongod`/test server is running? **Yes, once.**

## 9. As built (2026-10-12)

- Units U1-U3b done with TDD where it applies: the U1 view test and the U3a `prepareMongoHome` tests were
  written first and failed for the right reason (`keep` undefined; module missing); the U3a test also
  caught a same-millisecond folder-name collision (now `mkdtemp`). The Playwright spec was written after
  the panel.
- Two independent read-only opus reviews (tree fingerprint `af5dfd2977dde2ae` unchanged before/after):
  no critical/high/medium. Low findings fixed: the status line stays in the accessibility tree (hidden
  while empty) so its first message is announced; panel/modal wording matches `runPurge()` exactly
  (list re-checked when the removal starts; "skipped" = no longer on the list; newest 500); Preview stays
  busy until the new task is on screen (no false "busy" on a quick second click); an open confirm dialog
  disables itself when the 30 minutes pass; failed tasks read "Removal failed. <plain message>"
  (the shared table's task titles are bare codes); "Verify now" shows a reason while another task holds
  the slot; focus moves to the panel heading after the dialog closes; the expired note is no longer an
  alert; long slugs wrap in confirm labels; the server's boot falls back to the library temp folder;
  `stop()` always exits; the fixture's purge slots match the worker (finished progress, `not-picked-up`,
  requester and params kept); spec adds the client-side expiry, zero found, failed preview, expired
  task, skipped count and a panel-level overflow check.

