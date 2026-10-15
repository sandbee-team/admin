# POS integration — plan and decisions

Status: Stage 1 LIVE on admin.sandbee.in since 2026-10-09 (commit `8949777`); full-codebase review
fixes LIVE since 2026-10-10 (commit `1617d30`: 204 unit/API tests, 18 Playwright ×3 green; owner
smoke-checked accounts, files and Recovery after deploy).
Stage 2 (2026-10-10): W0 builder (pos-builder main @ 60ceb7b), W1 adapters + sealed build cache, W3 API, W2 deploy worker (separate `worker` container; Vercel CLI as uid 10001), W4 client DB backup and W5 guided Deploy UI + POS clients page implemented, reviewed (4 independent reviews; all critical/high/medium fixed) and verified (539 unit/API tests with 5 Linux-only skipped on Windows, 35 Playwright ×3 green); **LIVE on the server since 2026-10-10 (main @ 08241e5)**. Release evidence: full suite on Linux in a container on the server 542/543 pass, 0 fail; app + worker healthy; worker `--self-check` all ok on the real server incl. `cli-isolation` (uid 10001 cannot read the worker's /proc environ) and, with the demo installation, `token-honoured`, `token-not-in-cmdline`, `token-not-on-disk`; first real demo deploy built on GitHub, sealed into S3, uploaded prebuilt, promoted and health-checked; a Redeploy succeeded. Bugs found only by the live run and fixed with tests: extraction errors swallowed (partial trees), self-check dir modes, Node.js 24.x project setting blocking verify (now a warning; runtime guaranteed by the build), and go-live confirmation waiting on `lastAliasRequest` (absent after promote — now production target / PROMOTED) plus "unhealthy" without a health result (now `health-unknown`). Release steps: docs/DEPLOYMENT.md (see docs/POS-STAGE2-PLAN.md, POS-STAGE2-REV2.md). Stage 3 and Phase 3 not started. Owner: single operator.
Phase 2 (2026-10-11): on-demand usage checks (D31-D37, `docs/PHASE2-PLAN.md` rev 2 + §18 as built) — watch list + "Check watched clients" / "Check now", one check at a time on the worker's `usage` lane, only the current result stored (`pos.usage.last`); site up/down/latency/paused, storage per cluster vs 512 MB (cafe health stats, else direct dbStats of the core cluster), Cloudflare Worker requests today/yesterday, token expiry; Usage tab, POS clients columns, Attention items and one summary email per batch (24 h de-duplication). Implemented with TDD in units U1-U4, 3 independent read-only reviews + 2 re-review rounds + a focused pass (all critical/high/medium fixed, stats token bound to its host = D37), verified on Windows (`npm test` 0 fail, 6 Linux-only skipped; `npm run build`; Playwright 40/40). **LIVE on the server since 2026-10-11 (main @ 4604b24).** Release evidence: Linux suite on the server 661 tests, 660 pass, 0 fail, 1 skipped; app + worker healthy; boot migration bound the demo stats token to its host; live `--self-check --usage` on demo: site up (1 probe), storage from the health stats (core 0.4 %), Cloudflare Worker requests today/yesterday read through GraphQL (the no-dimension aggregate query works on a real account), Vercel and Cloudflare token expiry read (no expiry), test email delivered; the owner checked Watch, Check watched clients, the Usage tab and the dashboard in the UI.
P1 (2026-10-12): "Old source deployments" panel on the Deploy tab (D38, `docs/P1-PURGE-PANEL.md`) — preview → typed slug + step-up → remove exactly the previewed ids, progress and result, all states of the shared task slot; task view adds the kept count and a purge's progress (counts only); the Playwright test server keeps its in-memory Mongo data in its own folder and removes dead runs' folders at the next start (no more ≈200 MB `mongo-mem-*` per run). TDD, 2 independent read-only opus reviews + 2 re-review rounds (no critical/high/medium; every low fixed), verified on Windows (`npm test` 664 tests, 658 pass, 0 fail, 6 Linux-only skipped; `npm run build`; Playwright 44/44). **LIVE on the server since 2026-10-12 (main @ 861487b).** Release evidence: Linux suite on the server (release branch, `scripts/test-linux.sh`) 664 tests, 663 pass, 0 fail, 1 skipped; app + worker healthy, `/ready` ok, the served bundle contains the panel; the owner ran the purge for demo (preview → remove) and confirmed the result in admin and in demo's Vercel dashboard (counts not recorded here).
P3 (2026-10-12): "Deploy this commit to all clients" (D39, `docs/P3-ROLLOUT.md`) — "Deploy a commit to all clients" panel on the POS clients page: choose a branch → plan (demo first, then A–Z, clients left out and why, newer/diverged/unhealthy warnings) → typed `deploy all` + step-up; one `system_state` row `pos-rollout`; the worker pre-builds every client's build and deploys one client at a time through the normal deploy job, stopping at the first failure (Cancel / Resume / Dismiss); deploys and rollbacks record `last.healthy`. TDD, 2 independent read-only opus reviews + 1 re-review round (first round 6 medium and ~20 low, all fixed; re-review lows only, all fixed; tree fingerprint unchanged around every round), verified on Windows (`npm test` 727 tests, 721 pass, 0 fail, 6 Linux-only skipped; `npm run build`; Playwright 48/48). **LIVE on the server since 2026-10-12 (main @ e44649c).** Release evidence: Linux suite on the server (release branch, `scripts/test-linux.sh`) 727 tests, 726 pass, 0 fail, 1 skipped; app + worker healthy, `/ready` ok, the served bundle contains the panel, worker log without `rollout-step-failed`. No rollout run yet (optional: today only demo deploys from admin).
P4 (2026-10-12): platform DNS → Cloudflare (D9) reviewed and written up as an owner runbook (`docs/P4-DNS-CLOUDFLARE.md`); no code needed. Inventory (GoDaddy registrar and DNS, zone export confirmed): `@`, `admin`, `store`, `gstapi`, `ocrapi` A → 13.206.131.1 (Elastic IP; Caddy, automatic Let's Encrypt), `www` CNAME → apex, `posdemo` CNAME → Vercel (demo POS), `_dmarc` TXT, GoDaddy's `_domainconnect`; no MX/SPF/DKIM/CAA, DNSSEC off; admin's code emails are sent by Gmail as the Gmail address, so sandbee.in's DNS takes no part in them. **The move itself is deferred by the owner to the end of the roadmap (D40): DNS stays at GoDaddy, nothing was changed.**
P5 (2026-10-12): Stage 3 — new client go-live from admin — session 1 done: read-only review (4 subagents: POS go-live core, POS realtime/standby/admin login, admin backend, admin worker/tests/UI) and the file-precise plan `docs/P5-STAGE3-PLAN.md`. Proposed D41-D48: a `pos.golive` slot + worker lane; provider writes only for projects without a production deployment (incl. Function Region bom1); an exact `buildEnv` port with keyed fingerprints; the web address checked against the apex's own nameservers while the records are entered by hand at GoDaddy, with a Cloudflare adapter seam for after P4; the POS admin login seeded like `seed-admin.ts`; the realtime Worker bundled by a new pos-builder workflow and uploaded over the Cloudflare REST API; bootstrap verify + "Unlock and deploy"; standby hosts as P5b. **No POS change in the recommended design** (PC1/PC2 conditional). **Approved by the owner 2026-10-13 (D41-D48; Q1 bcryptjs, Q2 pos-builder `realtime.yml`, Q3 standby = P5b, Q4 spike accounts + temporary `p5spike` record allowed, Q5 existing screens).** Session 2 (2026-10-13, branch `p5-stage3`): **W1 pure port done** — `shared/web-address.js`, `backend/lib/golive-env.js`, `backend/lib/realtime.js`, `backend/lib/dns-check.js` (new files only), `test/stage3-lib.test.js` 50/50 pass, `tools/p5-parity.mjs` 30/30 PASS against the go-live tool itself (buildEnv for every image store × realtime mode × tenant shape); full suite green on the dev PC (`npm test` 777 tests, 771 pass, 0 fail, 6 Linux-only skipped; `npm run build` ok). Spike S2's bundle half proven locally (pos-builder `spike-realtime` @ f92d4c3: `realtime.yml`, descriptor script, wrangler 4.140.0 lockfile; 6,299-byte bundle accepted by admin's allowlist); S3 done on the server: the worker container reaches GoDaddy's nameservers directly (`ns=2 ns-ips=2 authoritative-udp=ok(1) tcp53=ok`). S2 bundle on GitHub (2026-10-14): the `realtime` workflow run on `spike-realtime` is green and its bundle is byte-identical to the dev PC one (6,299 bytes, same sha256). Session 3 (2026-10-14; the owner reordered W4/W3 first, W2/W5 wait for the spike tokens): **W4 contract + API + data model done** — `shared/golive.js` (states, steps, actions, busy rule, per-action state rules, readiness, gates), bootstrap verify in `shared/deploy.js`, 32 go-live error codes, `goliveSchemas`, the go-live routes (`backend/modules/golive.js`: GET, Start/Sync env/Update realtime Worker, Check DNS, Unlock and deploy, Cancel), busy both ways, the label guard (D51), `goliveView`/`goliveBadge`, two indexes; `deploys.js` helpers shared through `deployHelpers`. **W3 done** — `backend/worker/realtime-bundle.js` (dispatch/takeover, provenance, artifact, zip, descriptor allowlist + digest) with a fake-builder test; pos-builder production `realtime.yml` (`workflow_dispatch` only, cleanup of `rtsrc-<id>`) on the LOCAL branch `realtime` @ fb6f921, not pushed (owner OK needed). Tests: `test/stage3-api.test.js` 27/27, `test/stage3-bundle.test.js` 10/10. Waiting for the owner: the spike tokens, S1 + GoDaddy record `p5spike`, S2 upload, the pos-builder push. Details: the plan's §16.
Phase 2 owner note: the demo Cloudflare token can already read analytics; when Lucifer is entered, its Cloudflare token needs **Account Analytics: Read** for the Workers numbers (otherwise the Usage tab shows a notice).
Open owner items: (1) set `deployLock: true` in the local `F:\lucifer\clients\demo.json` now that demo deploys from admin (transition rule — the local console must not upload source again); (2) done 2026-10-12: demo's old source deployments purged from the Deploy tab (rerun "Preview old deployments" after any future local-console upload); (3) enter Lucifer by hand (customer → POS installation → POS setup with the `lucifer007` profile ids, a new dedicated Vercel token, the MONGODB_URI from the Vercel project env, accounts) — ROADMAP P2, deferred by the owner 2026-10-12 to the end; runbook draft `docs/P2-LUCIFER-ON-ADMIN.md` (F1: admin's prebuilt deploys send no `regions`, so functions run in the project's default Function Region instead of `bom1` from `apps/cafe/vercel.json` — check demo with the `x-vercel-id` header; F2: `lucifer007` has no client file, so the local `deployLock` cannot apply); (4) delete the throwaway spike Vercel account and the `SPIKE_VERCEL_TOKEN` secret if not done; `F:\lucifer\clients\` clean-up later (D14); (5) P3: before a rollout reaches more clients than demo, set each client's Vercel Function Region by hand (F1) and run Verify for every client (a rollout stops at a client whose verify is older than 24 h); the first real rollout is optional until Lucifer is on admin; (6) weekly "Check watched clients"; quarterly restore drill and key-copy checks (Recovery page); (7) P4 DNS move, deferred to the end (D40): when it resumes, repeat the runbook's step 0 (zone export, TLS loop: client records may have been added) and do step 0.4 (Cloudflare 2FA on, every API token's zone scope — an "All zones" token would also reach sandbee.in) before step 1; optional any time: `MAIL_FROM` in the server `.env` = the Gmail address that Gmail already sends as. (8) P5 Stage 3: plan approved 2026-10-13 (D41-D48); keep the spike Vercel account, `SPIKE_VERCEL_TOKEN` and `SPIKE_CF_TOKEN` until P5 is live (item (4) waits); remove the temporary GoDaddy record `p5spike` and the spike project/Worker after the dress rehearsal (S4). (9) P5: review and push pos-builder branch `realtime` (production `realtime.yml`) to `main` when OK. Next free D-number: D52 (D49/D50 reserved for the P2 runbook's F1/F2).
Started 2026-10-09. Update the Decisions table whenever the owner changes a rule.

Stage 1 evidence (2026-10-09): `npm test` 186/186 pass; `npm run build` ok; Playwright 15/15 pass
on 3 consecutive full runs. Three independent read-only security reviews (U1, U2, whole stage):
no critical/high findings; every medium/low finding fixed with a test. Import dry-run against the
real `demo.json` (structure only): all 8 POS secrets mapped, 3 accounts, expected dropped list.
Release archive `handoff/sandbee-admin-source-2026-10-09-stage1.zip` (121 files, manifest verified).
Deploy steps: `docs/DEPLOYMENT.md` → "Stage 1 release checklist".

Goal: manage every POS client (F:\lucifer "POS Software") from admin.sandbee.in —
client record, accounts and 2FA, files, deploys of a chosen branch, live deploy state —
then usage analytics (Phase 2) and T&C e-signature (Phase 3).

## 1. Decisions (owner, 2026-10-09)

| #   | Decision                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | admin.sandbee.in is the ONLY place client data lives. `F:\lucifer\apps\hub` is not used (left untouched). The local go-live console stays as the fallback until admin is proven.                                            |
| D2  | Use the existing Customers + Installations menus. One client = one customer record + its POS installation; everything shows on one page.                                                                                    |
| D3  | POS "seed" from admin = only the POS admin login (username/password, handed to the client once). Menu, tables and settings are done by hand inside the client's POS panel. Seeding lands in Stage 3 (needs a POS change).   |
| D4  | No deploy history, no deploy logs stored anywhere. Keep only last deploy (branch, time, status…) and the previous one (for rollback) inside the client record. Audit events stay (owner rule: every deploy action audited). |
| D5  | Store client portal logins with passwords, 2FA setup keys and 2FA backup codes. Admin must be hardened accordingly.                                                                                                         |
| D6  | S3 (own AWS bucket) holds client FILES only. No automatic backups, no logs in S3. Client DB backup runs only when the owner presses a button.                                                                               |
| D7  | Client source code must never reach a client: deploys are PREBUILT (compiled output only). Clients never get GitHub access; repos stay private.                                                                             |
| D8  | Vercel Hobby commercial-use risk accepted.                                                                                                                                                                                  |
| D9  | Platform DNS move to Cloudflare: later (after Phase 2).                                                                                                                                                                     |
| D10 | Owner login gets authenticator-app 2FA (TOTP) on admin.sandbee.in. No changes to the POS app.                                                                                                                               |
| D11 | NO changes to anything that works today (POS repo, local go-live, client deployments) until admin is fully verified. POS changes come later and are tested separately.                                                      |
| D12 | Development folder: this repo (`sandbee-admin`, origin github.com/sandbee-team/admin).                                                                                                                                      |
| D13 | No admin-DB backup feature. The owner takes Atlas dumps to the local PC by hand (§6.3).                                                                                                                                     |
| D14 | `F:\lucifer\clients\` stays exactly as it is until admin is live and in use; the owner changes it then.                                                                                                                     |
| D15 | Lucifer's production deploy profile is `lucifer007` (entered by hand; no `clients/lucifer.json`).                                                                                                                           |
| D16 | File uploads up to 20 MB; API `requestTimeout` raised 15 s → 60 s (`headersTimeout` stays 10 s).                                                                                                                            |
| D17 | Add `uqr` (exact version pinned) for the authenticator QR code. S3 bucket created in ap-south-1 (name goes only in the server `.env`).                                                                                      |
| D18 | Server keeps ONE image (`sandbee-admin:local`), rebuilt in place on each release; no per-release tags, no staging build. Rollback = check out the previous commit and rebuild.                                              |
| D19 | (2026-10-10) S3 also holds a build cache under `builds/` (amends D6). Only the admin worker writes it; GitHub holds no AWS credentials. Design: `docs/POS-STAGE2-REV2.md`. |
| D20 | Build objects are ciphertext (SBB1); data key sealed with VAULT_KEY in a MAC-protected manifest; every reuse integrity-checked; failure → quarantine + one rebuild. |
| D21 | A build is identified by `(sha, buildKey)`; `buildKey` = HMAC over every build-time input. One build for all clients waits on a separate owner-approved POS change. |
| D22 | Manifests are build metadata, not deploy history (D4). **Retention (owner): the LIVE build of every installation is kept always; the PREVIOUS build is kept 10 days after it was replaced; every other build expires after 10 days** (lifecycle `builds/` 10 days + copy-forward of live builds; previous copied forward once when it becomes previous). |
| D23 | Single-flight builds via transient `system_state` `pos-build:*` rows; build lane 2, deploy lane 1. |
| D24 | Redeploy = same commit with current settings. Rollback = Vercel instant rollback (Hobby: previous only — spike: two-step rollback returns 402), fallback = redeploy the previous commit from the cache. |
| D25 | The deploy root always contains an empty `apps/cafe`; admin never edits client project settings (spike run #2: `productionFeasibleWithoutProjectChange: TRUE`); deployments found by `--meta sandbeeRequest`; CLI failures stored as category codes only. |
| D26 | Readiness computed once on the server gates UI and API; fleet view shows behind-by-N; "deploy to all" rollout: demo first, then A-Z, stop at the first failure (owner). |
| D27 | Builder token `pos-builder-actions` gains Contents: read on pos-builder only. |
| D28 | (owner, 2026-10-10) In-app client DB backup cap 20 MB compressed; automatic rollback when the post-deploy health check fails; pos-builder run/log retention 7 days; deploy, rollback, purge and "prepare build" are owner-only (`deploy` permission). |
| D29 | Spike evidence (run #2): prebuilt output in the client's Vercel exposes no source — files API counts ts/tsx/map/apps-hub/packages-shared-src/scripts all 0. |
| D30 | (recorded in `docs/POS-STAGE2-REV2.md` §7) Builder sanitises output before packaging: deletes all `*.map` and `.env.example`; any other `.env*`, any app-path secret pattern, or any non-allowlisted node_modules secret pattern fails the build. |
| D31 | (owner, 2026-10-11, Phase 2 — `docs/PHASE2-PLAN.md` rev 2) Usage checks run **on demand only**: the owner keeps a per-client **watch list** and triggers "Check watched clients" (POS clients page) or "Check now" (one client). Each trigger queues one check per client; the worker runs them **one at a time** on its own `usage` lane (concurrency 1). No schedule, no background watching. |
| D32 | Only the **current** result per client is stored (`installations.pos.usage.last`, overwritten by every check). No history, no daily points, no new collection, no "full in ~N days" projection (owner: "only current"). |
| D33 | Storage = `(dataSize+indexSize)/512 MiB` per cluster (core + ledgers + standbys) from the cafe's `GET /api/health?stats=1` with `x-stats-token`; fallback `dbStats` through `pos.mongo.uri` = core cluster only, labelled as such. No Atlas Admin API. |
| D34 | Vercel: up/down, latency and paused (503 `DEPLOYMENT_PAUSED`) from our own probe only; no bandwidth/CPU/invocation numbers (no Hobby usage API) — reference limits only. Cloudflare: account-wide Worker requests today (UTC) and yesterday via GraphQL `workersInvocationsAdaptive`; needs Account Analytics:Read on the client token (notice, not alert, without it). |
| D35 | Levels per check: storage and Worker requests 75 % warning / 90 % critical; site down = 3 consecutive failed probes inside one check (not raised during a deploy/rollback); paused critical at once; token invalid/expired/≤ 3 days critical, ≤ 14 days warning. Shown in the Attention panel; build-cache retention failure added to it. |
| D36 | (owner) One summary email when a "Check watched clients" batch finishes, only if a client is warning/critical, de-duplicated per client per alert type per 24 h (one warning→critical escalation allowed); a single "Check now" sends no email. Owner/admin (`credentials`) may watch and trigger. |
| D37 | (review fix, 2026-10-11) The health stats token is sent only to `pos.statsHost`, the web address it was saved for. Only the secrets writes (secret PUT/DELETE, the import) and a one-time boot migration set it; a host change through the config form never moves it, so a `credentials` user cannot redirect a secret to another host. |
| D38 | (owner, 2026-10-12, P1 — `docs/P1-PURGE-PANEL.md`) The purge runs from the Deploy tab's "Old source deployments" panel only through the existing routes: preview → typed slug + step-up → remove exactly the previewed ids (≤ 200 per run; preview again for the rest). The 30-minute window is shown from the browser clock; the server stays the authority (a refused removal offers a new preview). The task view adds the preview's kept count and a purge's progress (counts only). Admin-role staff see the panel read-only. |
| D39 | (owner, 2026-10-12, P3 — `docs/P3-ROLLOUT.md`) "Deploy this commit to all clients": one `system_state` row `pos-rollout` (current/last only; Dismiss deletes it). Targets fixed at start = unlocked, verified (< 24 h), active POS clients whose healthy live commit differs; slug `demo` first (canary), then A–Z, ≤ 100; the previewed list is bound to the start by a digest. Gates: `deploy` + step-up + typing `deploy all`, build cache on, no rollout and no client deploy running. All pre-builds are queued at start (build lane 2); the WORKER then deploys one client at a time through the normal deploy job and stops at the first failed / rolled-back / unhealthy / expired job, not-ready or busy client, freeze, or loss of the starter's authority (re-checked before every client); locked / paused / retired / already-live clients are skipped. Resume (step-up) retries the stopped client first; Cancel (no step-up) cancels the client in flight before its upload; deploy records `last.healthy` so an unhealthy live version never counts as done. |
| D40 | (owner, 2026-10-12, P4 — `docs/P4-DNS-CLOUDFLARE.md`) **Platform DNS stays at GoDaddy until the end of the roadmap** (timing of D9). When it moves: an identical copy of the GoDaddy zone in the owner's existing Cloudflare account, records entered by hand, every record **DNS only** (grey) so Caddy and Vercel keep issuing their own certificates, TTL Auto, DNSSEC off, `_dmarc` copied exactly, GoDaddy's `_domainconnect` not copied, GoDaddy records left intact as the rollback; proxying is a separate later decision. The DNS token for Stage 3 is account-owned, Zone → DNS → Edit on sandbee.in only, IP-filtered to the Elastic IP, kept only in the server `.env` and the password manager, and created only once the zone is on Cloudflare; until then Stage 3 cannot change DNS through Cloudflare and client records are entered by hand at GoDaddy. |
| D41 | (owner, 2026-10-13, P5 Stage 3 — `docs/P5-STAGE3-PLAN.md`, approved unchanged) **Go-live job**: one embedded slot `installations.pos.golive` (current state only, D4) on its own worker lane `golive: 1`, shaped like a deploy job (requestId, status, step, steps[], lease + fence, attempt, cancelRequested, error). A run does every automatic step it can and ENDS in `waiting` when the owner must act (DNS at GoDaddy, unlock-and-deploy); nothing holds a lease while waiting. Every step is idempotent (check before create, save after learn). While a go-live run is queued/running the installation is busy for deploys, tasks and POS setup writes, and vice versa. |
| D42 | **Provider writes (amends D25).** Admin creates or adopts a Vercel project ONLY in a go-live and ONLY when the project has no production deployment (a live project is an existing client: import/P2 path). At creation it sets `BUILD_SETTINGS` and Function Region `bom1`; it writes the env (D43), the project domain `<label>.sandbee.in` and the 308 redirects of the project's `*.vercel.app` names. After go-live the project settings are never changed again; env only through the owner's "Sync env". Admin never deletes a project, Worker, domain or env var (go-live's fresh start is not ported). |
| D43 | **Env = exact `buildEnv` port**: same keys, order, values, types (`encrypted`/`plain`), targets (`production`, `preview`), blanks for the unused image store, realtime triple (blank when realtime is off); upsert only. Admin stores per key only name, type, targets, a keyed 16-hex fingerprint (HMAC under a key derived from VAULT_KEY, label `sandbee-env-fp-v1`) and Vercel's `updatedAt` at write time; Vercel env values are never read back. `authSecret`, `healthStatsToken`, `realtimePublishSecret` and (if empty) `posAdmin.password` are minted by the worker once, only when missing, never re-minted; minting the stats token sets `statsHost` to the go-live host (D37 gains this writer). Imported/hand-entered clients get a names-only parity warning in Verify (`env-keys-missing`); admin does not write their env in P5. |
| D44 | **Web address while DNS is at GoDaddy (D40).** One label per installation (`SUBDOMAIN_RE`); refused: the platform names `@ www admin store gstapi ocrapi _dmarc _domainconnect app api hub`, the names reserved by code/docs `ecom ocr pos notify whatsapp wa waadmin`, a label held by another installation (unique partial index; as built: D51), and a label whose authoritative DNS already answers with a record that is not this project's. Host `<label>.sandbee.in`, `TENANT_ID` = label, `ROOT_DOMAIN` = `sandbee.in`. Admin shows the exact records (CNAME → Vercel's rank-1 `recommendedCNAME`; TXT only when Vercel's `verification[]` asks); the owner enters them at GoDaddy by hand and presses Check DNS (apex's own nameservers → Vercel verify + config → TLS probe). No GoDaddy key on the server; a `dnsProvider` seam (`manual` now, `cloudflare` after P4). All records DNS only. |
| D45 | **POS admin login (amends D3: no POS change).** The worker seeds it exactly as `apps/cafe/scripts/seed-admin.ts` does, only when the client's core DB has no `role: "admin"` staff; never changes or replaces an existing admin (`admin-exists`); new dependency `bcryptjs` exact 2.4.3 (the POS's own library), cost 12; a read-back `compare` proves the stored hash matches the vault password. The password is minted by admin if the owner did not set one and handed to the client once through the existing reveal (owner, step-up, audited). Menu, tables and settings stay manual (D3). |
| D46 | **Realtime Worker without wrangler on the server.** A new pos-builder workflow `realtime.yml` (build.yml untouched) bundles `workers/realtime` at the go-live commit with the pinned wrangler (`deploy --dry-run`, no Cloudflare credentials) and uploads `index.js` + a descriptor. The admin worker downloads it (builder token, digest-checked), accepts only an allowlisted descriptor (one DO binding, `new_sqlite_classes` migrations only, `YYYY-MM-DD` date, ≤ 1 MB), uploads it over the Cloudflare REST API with `TENANT_ID` and the publish secret, enables workers.dev and probes 426 + a signed publish. Name `pos-realtime-<slug>`; redeploy only when bundle SHA-256, name, tenant or URL changed. Compiled Worker code in the client's own Cloudflare account, as today (D7 unchanged). |
| D47 | **First deploy.** `verifyStateOf` gains `bootstrap` (every flag ok except `health = "not-deployed"`, written only when the project has no production deployment). Unlock accepts `bootstrap` only for an installation whose go-live waits for its first deploy; rollout (D39) and every other gate still need `ok`. The owner's single action **Unlock and deploy** (`deploy` + step-up + typed slug) unlocks and enqueues the normal deploy job of the go-live commit in one transaction; the go-live is `live` only after that job is healthy, an inline Verify is `ok` and the redirects are applied (a redirect failure is a warning). |
| D48 | **Scope.** Standby hosts are a separate item P5b after P5. Imported clients' env stays manual (D43). The local go-live is not changed (D11); a client gone live from admin never gets a `clients/<slug>.json` (D14). D49/D50 are reserved for P2's proposals F1/F2 (recorded when P2 resumes). |
| D51 | (agent, 2026-10-14, P5 W4 as built — `docs/P5-STAGE3-PLAN.md` §16 session 3; amends D44's index) **Go-live label uniqueness and contract details.** One go-live label per installation is backed by a unique partial index on `pos.golive.address.label` (not on `pos.subdomain`: imported/hand-entered blocks on other root domains may share a subdomain) plus a transactional holder check at Start (another installation's go-live label, the same host, or the same label on `sandbee.in`) and the same check on a POS setup save; a duplicate key answers 409 `label-taken`. While a go-live run is queued/running EVERY POS setup write (config, any secret, removal) is busy, deploy and task claims require the go-live slot free, and a go-live start requires the deploy and task slots free. Only Unlock and deploy accepts a `bootstrap` verify (`/pos/unlock` and the normal deploy routes do not). Sync env, Update realtime Worker, Check DNS and Unlock and deploy require the block's subdomain/host to still match the go-live address (409 `golive-address`); Start re-derives it. The run's request time is stored as `requestedAt`. Cancel ends a queued or waiting run at once, asks a running one to stop between steps, and fences off a dead lease. |
| D52 | (owner, 2026-10-14, sales documents — `docs/SALES-DOCS-PLAN.md`, approved with every recommended default) **Quotation, agreement and tax invoice PDFs from admin**, all three from one deal of a customer. Permissions: new `sales` (owner, admin: deals, issue, download, e-mail) and `billing` (owner + step-up: company profile, bank/UPI, numbering, texts, logo/signature, a client's own quotation/invoice terms, cancelling). Data in six new collections (`sales_settings`, `sales_assets`, `sales_counters`, `sales_profiles`, `sales_deals`, `sales_documents`), nothing added to `customers`; all six are in the encrypted snapshot as optional collections (older snapshots still restore). Money in integer paise, half-up to the paisa per step, GST per line, optional round-off line (on by default); CGST + SGST when the place of supply is the company's state, else IGST; India only. Issued documents are immutable (frozen snapshot + PDF SHA-256): a quotation/agreement revision keeps its number as v2, v3…; a tax invoice is never re-issued (cancel + next number; credit notes are a later item). Numbers `<prefix><yy-yy>/<0001>` per type and Indian financial year (IST), gapless, an invoice number ≤ 16 characters (Rule 46). A client's text override is its own copy. PDFs from an in-repo writer (no new dependency; Helvetica/WinAnsi, `Rs.` instead of `₹`, Latin text only), archived as sealed customer files; e-mail through the existing SMTP transport, on request only. v1: one invoice per deal; no milestone invoices, credit notes, e-invoice IRN (only above ₹5 crore turnover) or export. |
| D53 | (owner, 2026-10-15, sales documents revision 2 — `docs/SALES-DOCS-PLAN.md` §15; amends D52) **Seller without GST registration, new document design, standard texts.** Sales settings gain `gst.registered` (default off; rows saved before read as off): off = no GST on any document (an unregistered person may not collect tax, CGST Act s.32), the invoice is titled "Invoice", no seller GSTIN, SAC, rates or place of supply, and `{{tax.note}}` says GST is not charged; only legal name, email and phone are required (an agreement also needs `company.jurisdiction`, the city of its courts and arbitration seat); address, state, PIN, PAN, website and bank/UPI are optional and printed only when filled. On = D52's Rule 46 behaviour (plus email and phone). An agreement or invoice is refused (409 `gst-mode-changed`) while the deal's latest quotation/agreement was issued in the other mode. New default texts (quotation terms, a 16-section Service Agreement, invoice terms); a stored text or client copy equal to D52's default is read as the new default. New PDF design with an accent colour (`design.accent`, default the panel green `#355E45`), snapshot format 2; format-1 documents (issued under D52) render with the frozen D52 renderer (`backend/lib/sales-pdf-v1.js`), byte-identical. Owner: have a lawyer review the agreement and the stamp duty; register for GST once turnover crosses the threshold (Rs. 20 lakh a year for services) and switch it on. |
| D54 | (owner, 2026-10-15, admin sign-in; `docs/SECURITY.md`) **The authenticator replaces the email code at sign-in.** Staff with an enrolled authenticator sign in with password → authenticator code (or backup code); no email code is sent (`/auth/login` answers `totpRequired`). Staff without an authenticator keep password → email code, and recovery stays email code → authenticator (if enrolled) → new password. Because a password alone now reaches the authenticator step: a throttled notice (≤ 1 per 6 h) on a failed authenticator step after a password-only sign-in, audit detail `login (password)`, pre-session failures in their own bucket per staff member and IP (10/15 min) so in-session step-up cannot be blocked, wrong codes from every path still feed the 24 h lock, backup codes still work during the lock, the attempt slot is reserved before the code is checked and a code cannot be claimed once the lock is set. Password and secret fields gain a show/hide toggle (default hidden; copy/cut of secrets stays blocked; spellcheck and writing assistants off). |

Box memory measured 2026-10-09: 3834 MB total, 2383 MB available, 2 GB swap; all containers
together ≈ 680 MB (largest: sandbee-platform-demo 388 MB; admin 48 MB of 512 MB).

## 2. Current POS flow (read-only review, F:\lucifer)

- Local console `npm run go-live:ui` → `scripts/go-live/ui.mjs` on 127.0.0.1:4848, no login,
  loopback Host/Origin gate only (`ui-server.mjs:64-75`). Jobs are child processes
  (`ui-jobs.mjs:76-102`), one at a time, log in RAM only.
- Go-live pipeline `run.mjs:187-408`: lock → validate → seed Atlas (`seed-client.ts` via tsx) →
  Vercel project create/adopt (REST) → deploy profile → web address + DNS check → mint
  authSecret/healthStatsToken → Cloudflare realtime Worker (wrangler via npx) → env upsert
  (~20 vars, `lib.mjs:346-383`) → deploy → health (12×5s, `lib.mjs:403-408`) → 308 redirects.
- Deploy = `npx vercel deploy --prod --scope --token` from the REPO ROOT (`scripts/deploy.mjs:206-239`).
  Uploads the working tree; Vercel builds remotely; no branch/SHA/deployment id recorded; no rollback.
- `.vercelignore` excludes only secrets/docs/marketing → every client's Vercel account currently
  receives cafe source + apps/hub + scripts/ + workers/ + apps/desktop source. Vercel lets account
  members view/download deployment source (Source tab, `GET /v6/deployments/{id}/files`,
  `/v8/.../files/{fileId}`). Known leak; fixed by D7 going forward (not changed now, D11).
- Data: `clients/<slug>.json` (owner fields + `generated.*` + `lastRun`), `deploy.profiles.json`,
  `clients/_platform.json`. Plaintext secrets. `clients/_cloudflare.json` is an orphan holding a live
  token (no code reads it). `clients/lucifer.md` is free-form notes with plaintext passwords.

## 3. Constraints

- Box: EC2 3.7 GB RAM, 6 apps. Admin API container: read_only, tmpfs /tmp, 512m, pids 150, no git.
- Admin DB: Atlas M0 (512 MB, NO Atlas backups, 100 ops/s). Keep documents small; no logs.
- API request timeout is 60 s (set in `backend/lib/http-timeouts.js` for 20 MB uploads; keep-alive 125 s behind Caddy) → long work runs in a
  separate worker (as docs/DEPLOYMENT.md already prescribes).
- Follow house conventions: `xRoutes(context)`, `requireAuth`, `permit`, zod `.strict()`,
  `transaction` + `authorizeWrite` + revision + `audit`, `useResource`/`Resource`/`Modal`/`Badge`,
  tokens.css, no new libraries unless justified.
- Secrets never in responses, logs, error messages, URLs or argv.

## 4. Architecture

```
Browser ─► Caddy ─► admin API (existing)            ─ decrypts ONLY for owner reveals (step-up)
                       │ writes job intent into the installation record
                       ▼
                MongoDB sandbee_admin (M0)
                       ▲ claim (lease) + progress
                admin-worker (new compose service, same image, mem_limit ~256m, volume /work)
                  ├ GitHub API  → branch list, dispatch build, download artifact
                  ├ Vercel CLI  → `vercel deploy --prebuilt` (token via env, never argv)
                  ├ Vercel REST → readyState, promote/rollback, purge old deployments
                  ├ client Mongo (button-only DB backup, Stage 2)
                  └ S3          → client files / DB backup objects
GitHub (private): KartikDesai07/lucifer (source, untouched)
                  KartikDesai07/pos-builder (NEW private repo, holds the build workflow only)
```

Why a separate builder repo: `workflow_dispatch` needs the workflow on the default branch;
putting it in the lucifer repo would change `main` (D11). The builder checks out lucifer at an
exact SHA with a read-only token, so the lucifer repo is never modified.

## 5. Data model (no new top-level collections except where stated)

### customers (existing) — the client record

Existing fields unchanged (`status: lead|active|paused|archived` covers lead → customer).
New embedded blocks, managed only by the new module (never by generic records PUT):

- `accounts[]`: `{ id, service (gmail|vercel|atlas|cloudflare|godaddy|r2|cloudinary|other), label,
login, password: box, totpKey: box|null, backupCodes: box|null, backupCodesUsed: [index],
recoveryContact, notes, changedAt }`
- `files[]` (metadata only, cap 300): `{ id, name, category (agreement|kyc|invoice|screenshot|
db-backup|other), size, sha256, s3Key, dataKey: box, uploadedBy, uploadedAt, deletedAt|null }`

### installations (existing) — the POS setup of that client

New embedded `pos` block (managed only by the new module):

- identity: `slug, subdomain, host, tenantId, rootDomain, deployLock`
- `vercel: { projectId, orgId, teamId, projectName, token: box }`
- `mongo: { uri: box }`, `cloudflare: { accountId, token: box } | null`
- `image: { store: r2|cloudinary, publicBaseUrl|cloudName, keys: box }`
- `generated: { authSecret: box, healthStatsToken: box, realtimePublishSecret: box|null }` (imported)
- `posAdmin: { username, password: box }` (D3)
- `build: { nextPublic: { NEXT_PUBLIC_R2_PUBLIC_BASE_URL | NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME } }`
- `deploy.current: null | { status, step, branch, sha, by, startedAt, runId, vercelDeploymentId,
leaseOwner, leaseUntil, error }`
- `deploy.last` and `deploy.previous`: `{ branch, sha, at, status, by, vercelDeploymentId, url,
durationMs, error }` (D4 — this is the whole "history")

Implementation check (U2): confirm `backend/modules/records.js` PUT preserves fields outside the
zod schema (`$set` vs replace). If it replaces, exclude `accounts/files/pos` explicitly.

### staff (existing) — owner 2FA (D10)

`totp: { key: box, enabledAt, lastStep }`, `totpBackupCodes: [HMAC hashes]`, plus session
`stepUpUntil`.

### Vault contexts (AAD) — existing `encrypt/decrypt` (`backend/lib/crypto.js:45-73`)

`pos:<installationId>:<field>` · `account:<customerId>:<accountId>:<field>` ·
`file:<customerId>:<fileId>` · `staff:<staffId>:totp` · existing `connection:<id>` unchanged.

Snapshot: any new secret location must be added to the decrypt checks in
`backend/lib/snapshot.js:21,62`.

## 6. Security design

### 6.1 Access

- Owner login: password → email OTP → TOTP (authenticator). 10 one-time TOTP backup codes shown once
  at enrolment (print, keep offline). Lost phone: backup code, or server-side
  `scripts/recovery.js reset-totp --email=<owner email> --maintenance`, run in the container (needs server access; audited; see docs/DEPLOYMENT.md).
- Step-up = fresh TOTP code, valid 10 minutes, required for: reveal password / 2FA key / backup
  code, "show current 2FA code", download file, client DB backup, admin backup download, delete.
- Revealed values are returned once, shown 30s in the UI, never cached; list/detail responses
  carry only flags (`hasPassword`, `hasTotp`, `codesLeft`).
- Reveal rate limit (e.g. 30/hour/staff) via existing `consume()`.
- "Show code" computes the current TOTP server-side; the key itself is not revealed.
- Audit gains `ip` and `userAgent` (additive change to `backend/lib/audit.js`).
- Optional (owner choice): Caddy IP allowlist or Cloudflare Access in front of admin.sandbee.in.

### 6.2 Key recovery (server loss must be recoverable without weakening encryption)

- Server loss does not lose data (it is in Atlas). What is lost is `.env`: VAULT_KEY, AUTH_SECRET
  (sessions only) and the rest of the settings.
- The three-copy rule is for VAULT_KEY: server, password manager, offline sealed (printed hex + QR).
  Never in the same file as any dump. Keep AUTH_SECRET safe too. BACKUP_KEY matters only for the
  legacy snapshot tool (optional; admin backups are manual mongodumps).
- Key fingerprint (non-secret HMAC prefix) shown on the Recovery page to match copies.
- `scripts/recovery.js verify-key`: proves a candidate key decrypts the existing `vault-v1`
  verifier (`backend/lib/vault.js`). Key is never pasted into the web UI. Each copy's
  verification date is recorded on the Recovery page.
- Restore drill (quarterly): scratch machine + scratch DB restored from the dump + same VAULT_KEY and
  AUTH_SECRET; NEVER the live Atlas DB, and no production S3 or SMTP settings → admin boots
  (verifier passes) → reveal one test secret → record drill. Recovery page shows green/amber/red.

### 6.3 Admin DB backup (D13)

No feature. The owner runs `mongodump` of `sandbee_admin` to the local PC by hand. The dump
holds only vault boxes for secrets, so it is useless without VAULT_KEY — keep the key copies
apart from the dumps. Atlas M0 has no backups of its own; the owner's dumps are the only copy.

### 6.4 Files in S3 (D6)

- New private bucket in ap-south-1: ACLs disabled, Block Public Access on, versioning on,
  SSE-S3 default encryption, bucket policy denying non-TLS requests.
- Object keys are opaque: `files/<customerId>/<fileId>` (no filenames in S3).
- Browser → admin API → S3 (server-side proxy): no CORS, no presigned URLs.
- Admin IAM user (inline policy, `files/*` only): `s3:PutObject`, `s3:GetObject`,
  `s3:GetObjectVersion`, `s3:DeleteObject`, `s3:ListBucket`
  (prefix-limited). NOT granted: `s3:DeleteObjectVersion`, bucket/lifecycle/policy changes.
  With versioning, a delete only adds a delete marker; the data stays as a noncurrent version.
- Lifecycle: permanently delete noncurrent versions 30 days after they become noncurrent;
  remove expired delete markers; abort incomplete multipart uploads after 1 day.
  → A deleted file can be restored for 29 days; a stolen admin key cannot destroy data at once.
- Delete = `DeleteObject` + `deletedAt` in Mongo. Restore (≤29 days) = `CopyObject` from the
  stored `versionId` to the same key. Store `versionId` from every PutObject response.
- Each file encrypted by us before upload: random 256-bit data key, AES-256-GCM; data key boxed
  with VAULT_KEY (AAD `file:<customerId>:<fileId>`). S3 holds ciphertext only. Max 20 MB.
- Upload route has its own body limit (outside `express.json({limit:"32kb"})`).
- Config (names TBD in U2): region, bucket, access key id, secret — in the server `.env` only.

## 7. Deploy pipeline (D4, D7)

1. UI: Deploy → branch list (GitHub, cached 60s: name, last commit, age) → production → type slug.
2. API (transaction + audit `pos.deploy.requested`): guards — `deploy` permission, no active
   `deploy.current` with a live lease (409), `pos.deployLock`, customer not paused/archived,
   global freeze flag off. Resolves branch → exact SHA now. Writes `deploy.current{status:queued}`.
3. Worker claims (lease 60s, heartbeat 15s; expired lease → `interrupted`, then resume or fail).
4. Steps (status written to `deploy.current.step`):
   - `preflight` — decrypt token, `GET /v2/user`, project visible.
   - `build` — dispatch `pos-builder` workflow (inputs: request_id, sha, nextPublic, orgId,
     projectId); find run by run-name = request_id; wait for completion.
     Builder: checkout lucifer@sha (read-only token) → `npm ci` → hand-written
     `.vercel/project.json` → `vercel build --prod` with NEXT_PUBLIC_* only → delete `*.map`,
     fail on TS source paths or secret patterns → upload artifact (retention 1 day).
   - `upload` — download artifact to /work, `vercel deploy --prebuilt --prod --archive=tgz`
     (VERCEL_TOKEN/VERCEL_ORG_ID/VERCEL_PROJECT_ID via env), then delete the artifact.
   - `vercel` — poll `GET /v13/deployments/{id}` to READY/ERROR; if production alias was not
     assigned (after a rollback, auto-assign is off) → `POST /v10/projects/{id}/promote/{deploymentId}`.
   - `health` — `https://host/api/health` 12×5s; verdict = 200 + `ok` + `db:"up"` + tenant match.
   - `finalize` — `previous ← last`, `last ← result`, `current ← null`, audit
     `pos.deploy.succeeded|failed`.
5. Live status = `deploy.current` polled by the UI (`useResource`, 2s). No logs stored (D4):
   the failed step + short error is kept in `deploy.last.error`; the full build log is the
   GitHub Actions run (private; link shown in UI; set repo log retention short).
6. A failed build never touches production (Vercel aliases only READY deployments).
7. Rollback: `POST /v1/projects/{id}/rollback/{previous.vercelDeploymentId}` (Hobby: previous
   production only), or redeploy any branch/SHA. Audit `pos.rollback.requested`.
8. After a client's first verified prebuilt deploy: owner button "Remove old source deployments"
   (deletes deployments created before cutover except current/previous; audit).

Spikes before building the pipeline (Stage 2, in the builder repo only):

- S1 `vercel build` runs on Actions without the client's token (hand-written project.json + NEXT_PUBLIC env).
- S2 a prebuilt deployment's Source tab / files API shows compiled output only (throwaway Hobby account).
- S3 `.vercel/output` contains no `.map`, TS source or secrets; server bundle readability noted.
- S4 exact fine-grained PAT permissions (lucifer: Contents read; pos-builder: Actions read/write);
  Vercel CLI honours token from env; CLI runs with HOME on /work in a read-only container.

## 8. Stages and work units

### Stage 1 — admin only (no external build, no POS change)

- U0 owner prep: key copies; S3 bucket + IAM user per §6.4 (box memory: done, see §1).
  `clients/` clean-up (lucifer.md passwords, `_cloudflare.json` token) deferred by D14.
- U1 security base: owner TOTP + backup codes + step-up; audit ip/userAgent; reveal rate limit.
- U2 client record: `accounts[]` vault (+ show code), `files[]` with S3, `pos` block on the
  installation (config + encrypted secrets), Customer page and Installation page (setup CHECKS
  as "pending steps").
- U3 import: upload `clients/<slug>.json` + its deploy profile → zod parse → masked preview →
  confirm → one transaction (customer, installation.pos, accounts, audit `pos.imported`).
  VAULT_KEY never leaves the server. `lucifer.md` content entered by hand in the Accounts tab.
- U4 recovery: fingerprint, `verify-key`, Recovery page fields (key copies verified, last drill).
  Acceptance: demo + lucifer imported; every secret write-only in API responses; reveal only with
  step-up and audited; restore drill passes on a fresh VM; tests green.

### Stage 2 — deploys from admin

Spikes S1-S4 → `pos-builder` repo → worker service → deploy/rollback/live status → credential
verify job → client DB backup button (streams client DB → encrypted object in that client's Files)
→ "remove old source deployments".
Acceptance: demo deployed from admin by branch; failure path leaves production untouched;
worker killed mid-deploy recovers; rollback works; no source in the client's Vercel.

### Stage 3 — new client go-live from admin (P5; the approved design needs no POS change, D41-D48)

Project create/adopt, env sync (`buildEnv` parity), web address state machine + DNS check, POS
admin login creation (D3), realtime Worker, standby hosts. Port the pure go-live functions with
their tests (~250 in `npm run test:go-live`).

### Transition rules (D1, D11)

- New clients keep using the local go-live until Stage 3 ships.
- Import is one-way. After a client's first verified admin deploy, set `deployLock: true` in its
  local `clients/<slug>.json` (existing feature, `deploy.mjs:163-165`) so the local tool cannot
  upload source again. Local files are deleted only after Stage 3 is verified.
- Until Stage 2, do not share Vercel logins with clients (source is visible there).

## 9. Phase 2 — usage checks (summary; full plan `docs/PHASE2-PLAN.md` rev 2, D31-D36)

- On demand only: watch list per client + "Check watched clients" / "Check now"; the worker runs
  one check at a time (`usage` lane) and stores only the latest result in `pos.usage.last`.
- Mongo usage = `(dataSize+indexSize)/512 MiB` per cluster from the cafe's `GET /api/health?stats=1`
  with `x-stats-token` (imported `healthStatsToken`); fallback `dbStats` via the client URI (core only).
- Vercel: up/down (3 probes), latency, paused (`503 DEPLOYMENT_PAUSED`); Hobby has NO usage API
  (Query API/Drains are Pro-only), so bandwidth/CPU are not shown.
- Cloudflare Worker requests today/yesterday via GraphQL `workersInvocationsAdaptive` (token needs
  Account Analytics Read); Vercel/Cloudflare token expiry.
- Levels 75 % / 90 %, site down, paused, token expiry; Attention panel + one summary email per batch
  (24 h de-duplication); build-cache retention failure in the Attention panel.

## 10. Phase 3 — T&C e-signature (summary)

- Immutable `terms` versions (short "key terms" + full text, SHA-256); expiring link (token digest
  only); public router outside the `/api` staff gate (see `backend/app.js`); email OTP; unticked
  checkbox + typed name + drawn signature; PDF (pdf-lib) stored as an encrypted client File;
  copy emailed; audit; installation CHECK ticked.
- Legal notes (lawyer must review the final text): a "client cannot file a case" clause is void
  (Contract Act s.28) — use arbitration (seat = owner's city), exclusive jurisdiction, liability cap,
  no consequential loss, 30-day pre-suit notice. Refunds tiered (setup fee non-refundable once work
  starts; refund only for non-delivery). Add IP clause (software is the operator's; no copying or
  reverse engineering), third-party/free-tier disclaimer, client owns accounts, DPDP processor
  clause, suspension on non-payment, 30-day data export, commercial-purpose declaration. Keep the
  SHA-256 of every signed PDF for a BSA 2023 s.63 certificate.

## 11. Risks

1. Admin holds every client's keys incl. 2FA keys → layered defences in §6; email + TOTP + step-up.
2. Admin DB backups depend on the owner's manual dumps (D13).
3. Vercel Hobby commercial-use terms (accepted, D8).
4. Box memory: worker adds ~150-250 MB (estimate); 2.38 GB was available on 2026-10-09.
5. GitHub Actions free plan: 2,000 min/month, 500 MB artifact storage — per-client builds
   (~5 min each); delete artifacts after use.
6. Server bundles in `.vercel/output` are compiled but readable; only compiled output is exposed.
7. Mixing local and admin deploys for one client — prevented by the deployLock transition rule.
8. `backend/lib/snapshot.js` requires an exact collection set — embedded blocks avoid
   adding collections in Stage 1.
9. Docs drift: `docs/DEPLOYMENT.md` mentioned Nginx; production uses Caddy (`/opt/edge/Caddyfile`). RESOLVED in Stage 1.
