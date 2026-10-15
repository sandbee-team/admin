# Roadmap — what is left, in priority order

Decided 2026-10-11 after Phase 2 went live (main @ 48cd770). One item per session, in this
order, unless the owner changes it. Every item follows the house method (below). At the end of
each session update this file (status + date + commit) and `docs/POS-INTEGRATION.md`, and hand the
owner the prompt for the next item.

| #  | Item | Why this position | Status |
| -- | ---- | ----------------- | ------ |
| P1 | **"Old source deployments" panel** on the Deploy tab (purge preview → confirm → execute; the API, worker and their tests already exist, only the UI is missing) + test-server clean-up of leaked in-memory Mongo dirs | Closes the known source leak (D7) in demo now and in Lucifer after its first admin deploy; smallest item | **done 2026-10-12** (D38, main @ 861487b; live; demo purged) |
| P2 | **Lucifer on admin** (owner work, guided): enter Lucifer by hand (D15), Cloudflare token with Account Analytics:Read, Verify → Unlock → first admin deploy → P1 purge → stop the local go-live for Lucifer | The real client; proves the whole pipeline on a second account before more automation | **deferred by the owner 2026-10-12 to the end of the list**; review done, runbook draft `docs/P2-LUCIFER-ON-ADMIN.md` (findings F1 function region, F2 no local lock for `lucifer007`, F3 source parity; 5 open questions) |
| P3 | **"Deploy this commit to all clients"** rollout (`docs/POS-STAGE2-REV2.md` §3.5, D26): `system_state` `pos-rollout`, demo first then A-Z, stop on the first failure, Resume/Cancel/Dismiss, `deploy` + step-up + typing `deploy all` | Pays off from two clients on; design already approved | **done 2026-10-12** (D39, main @ e44649c; live; no rollout run yet) |
| P4 | **D9 platform DNS → Cloudflare** (runbook, record inventory, TTL plan, mail records, Caddy/TLS check, rollback) | Unblocked by Phase 2; Stage 3 can then automate DNS through the Cloudflare API | **review + runbook done 2026-10-12** (`docs/P4-DNS-CLOUDFLARE.md`, baseline steps 0.1-0.3 recorded); **the move itself deferred by the owner to the end of the list** (D40): DNS stays at GoDaddy, nothing changed. On resume: repeat step 0, do 0.4, then steps 1-6 |
| S1 | **Sales documents** (moved ahead of P5 session 4 by the owner, 2026-10-14): quotation (discounts per line and overall), agreement and tax invoice PDFs from one deal; company profile, numbering, GST (CGST+SGST / IGST), per-client texts; immutable versions, audit, sealed archive, optional e-mail | Urgent for the business; independent of P5, so it is released from its own branch `sales-docs` (from main @ 4082048) | **LIVE 2026-10-15** (D52, `docs/SALES-DOCS-PLAN.md` §14; main @ 99809c8; Linux suite on the server 789 / 787 pass / 0 fail / 2 skipped). **Revision 2 LIVE 2026-10-15** (D53, §15; main @ 94dab5f; Linux suite on the server 814 / 812 pass / 0 fail / 2 skipped): seller without GST registration (switch, default off), only name/email/phone required, new PDF design, standard terms and a 16-section Service Agreement; `npm test` 814 (808 pass, 0 fail, 6 Linux-only skipped), build ok, Playwright 52/52; 1 read-only opus review + re-review, every high/medium fixed. Owner: jurisdiction city in Sales settings, lawyer review of the agreement and stamp duty. Next = P5 session 4 (merge main into `p5-stage3` first; S1/S2 spikes need the owner's tokens) |
| S2 | **Simpler admin sign-in** (owner, 2026-10-15): password → authenticator for staff with an authenticator (no email code), email code kept for staff without one and for recovery; show/hide toggle on password and secret fields | Every sign-in asked for three steps | **LIVE 2026-10-15** (D54; main @ 0e9fad1; Linux suite on the server 825 / 823 pass / 0 fail / 2 skipped): `npm test` 825 (819 pass, 0 fail, 6 Linux-only skipped), build ok, Playwright 54/54; read-only opus security review (no critical/high; 3 medium + 5 low fixed) + 2 re-reviews (2 new lows fixed; known residual: a correct code inside a burst at the 20th failure can still pass, documented in SECURITY.md). Staff without an authenticator still get the email code: enrol one per member |
| P5 | **Stage 3 — new client go-live from admin** (project create/adopt, env sync with `buildEnv` parity, web address + DNS check, POS admin login D3, realtime Worker, standby hosts; port go-live's pure functions with their tests) | Needed before client #3 is onboarded through admin; needs POS changes → separate owner approval (D11); plan + spikes first, then several sessions. DNS stays at GoDaddy until P4 runs (D40): client records are entered by hand and checked by admin | **plan written 2026-10-12** (`docs/P5-STAGE3-PLAN.md`: proposed D41-D48; no POS change in the recommended design; new dependency `bcryptjs` and a new pos-builder workflow need approval; 5 owner questions); **approved 2026-10-13** (D41-D48: bcryptjs seed, pos-builder `realtime.yml`, standby = P5b); **session 2 2026-10-13** (branch `p5-stage3`): W1 pure port done (50 tests, parity 30/30; `npm test` 777/771 pass/0 fail/6 skipped, build ok), S2 bundle proven locally and on GitHub (pos-builder `spike-realtime` @ f92d4c3, identical sha256), S3 done on the server (port 53 egress ok); S1/S2-upload wait for the owner (tokens, GoDaddy record); **session 3 2026-10-14** (owner reordered): W4 contract + API + data model done (go-live routes, busy both ways, label guard D51, bootstrap verify; 27 API tests) and W3 realtime bundle done (10 tests; pos-builder production `realtime.yml` on local branch `realtime` @ fb6f921, push waits for the owner); **session 4 2026-10-16**: main merged in (c1548da), spikes S1 + S2 upload done on the demo accounts (blank env values ok, no TLS before the first deploy, migrations/412, probe retries — D55), W2 adapters (Vercel, Cloudflare, provider-http form, safe-https probes, POS admin seed with bcryptjs 2.4.3; committed d75e88f) and W5 go-live worker (48 worker tests) done; `npm test` 1023/1017 pass/0 fail/6 skipped, build ok; next = session 5: W6 UI + 2 independent reviews, fixes, Playwright |
| P6 | **D21 — one build for all clients** (separate owner-approved POS change: runtime config instead of build-time `NEXT_PUBLIC_*`) | Saves GitHub minutes and time once P3 deploys to many clients | after P5 |
| P7 | **Phase 3 — T&C e-signature** (`docs/POS-INTEGRATION.md` §10) | Waits for the lawyer-reviewed terms text; may move up as soon as the text is ready | when the text is ready |
| P8 | Optional Phase 2 add-ons: Cloudinary `imageUsage` in the Usage tab, GitHub PAT expiry reminder, alert snooze, per-client thresholds | Nice to have | any time |

Owner items outside the code (any time): `deployLock: true` in the local `F:\lucifer\clients\demo.json`;
delete the spike Vercel account and `SPIKE_VERCEL_TOKEN`; weekly "Check watched clients"; quarterly
restore drill and key-copy checks (Recovery page); `F:\lucifer\clients\` clean-up after Stage 3 (D14).

## House method (every item)

1. Review first (subagents read the code and docs, summaries back), then a file-precise plan in
   `docs/` with decisions, data model, API, worker, UI, tests, work units, risks and a SHORT list of
   genuine owner questions with recommended defaults. Wait for the owner's approval.
2. Implement in work units with TDD (failing test first), disjoint file scopes, parallel only when
   files do not overlap. Never claim done without verbatim green output: `npm test`,
   `npm run build`, `npx playwright test --reporter=line`.
3. Independent read-only adversarial reviews (opus) after the code; fix every critical/high/medium;
   re-review the fixes; fingerprint the tree around read-only reviews.
4. Before release: `bash scripts/test-linux.sh` on the server (0 fail); merge to main, push, then the
   server steps one at a time (the owner runs them and pastes the output).
5. Update `docs/POS-INTEGRATION.md` status + decisions (next free D-number) and this file.

Environment notes: the development PC's C: drive filled up once — Playwright stops its test server
hard, which leaves a `mongo-mem-*` folder (≈ 200 MB) in `%TEMP%` per run; delete old ones if free
space drops below a few GB (the Stage 2 worker refuses work with less than 2 GB free, which fails
its tests). If the agent's `git push` is blocked by the permission system, the owner pushes.
