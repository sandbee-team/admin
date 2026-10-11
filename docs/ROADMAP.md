# Roadmap — what is left, in priority order

Decided 2026-10-11 after Phase 2 went live (main @ 48cd770). One item per session, in this
order, unless the owner changes it. Every item follows the house method (below). At the end of
each session update this file (status + date + commit) and `docs/POS-INTEGRATION.md`, and hand the
owner the prompt for the next item.

| #  | Item | Why this position | Status |
| -- | ---- | ----------------- | ------ |
| P1 | **"Old source deployments" panel** on the Deploy tab (purge preview → confirm → execute; the API, worker and their tests already exist, only the UI is missing) + test-server clean-up of leaked in-memory Mongo dirs | Closes the known source leak (D7) in demo now and in Lucifer after its first admin deploy; smallest item | next |
| P2 | **Lucifer on admin** (owner work, guided): enter Lucifer by hand (D15), Cloudflare token with Account Analytics:Read, Verify → Unlock → first admin deploy → P1 purge → stop the local go-live for Lucifer | The real client; proves the whole pipeline on a second account before more automation | after P1 |
| P3 | **"Deploy this commit to all clients"** rollout (`docs/POS-STAGE2-REV2.md` §3.5, D26): `system_state` `pos-rollout`, demo first then A-Z, stop on the first failure, Resume/Cancel/Dismiss, `deploy` + step-up + typing `deploy all` | Pays off from two clients on; design already approved | after P2 |
| P4 | **D9 platform DNS → Cloudflare** (runbook, record inventory, TTL plan, mail records, Caddy/TLS check, rollback) | Unblocked by Phase 2; Stage 3 can then automate DNS through the Cloudflare API | after P3 |
| P5 | **Stage 3 — new client go-live from admin** (project create/adopt, env sync with `buildEnv` parity, web address + DNS check, POS admin login D3, realtime Worker, standby hosts; port go-live's pure functions with their tests) | Needed before client #3 is onboarded through admin; needs POS changes → separate owner approval (D11); plan + spikes first, then several sessions | after P4 |
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
