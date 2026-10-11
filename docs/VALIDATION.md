# Validation evidence — 27 September 2026

## Passed

- `npm test`: **25 tests passed**, no failures. Temporary Mongo replica set; actual API/session/transaction behavior.
- `npm run build`: Vite production bundle passed. Main JS about 286.6 KB / 88 KB gzip; CSS about 26.2 KB / 6.6 KB gzip. Fonts self-hosted, Latin subsets.
- `npm run test:ui`: **4 browser suites passed** on Microsoft Edge. Real React/API/Mongo flows in an isolated test database, synthetic SMTP adapter.
- Browser workflow: password + OTP; create customer; create provider connection; store encrypted credential; create installation; reject incomplete readiness; create/update task; authorize a staff email; verify read-only restrictions.
- Axe WCAG 2 A/AA and 2.1 AA: login and 12 console routes scanned, no reported violations in covered states.
- Console layout: `/`, customers, products, installations, connections, tasks, team, audit, Store, recovery, new customer and new installation at **320, 390, 768 and 1440px**. No horizontal document overflow. Data tables scroll within their containers.
- Docker image builds; local app, Mongo replica set and Mailpit run. App `/ready` and container health pass.
- Docker-backed real local SMTP smoke: initial owner password, OTP delivered to Mailpit, browser verification, four-product catalog, logout; zero browser page errors. No external email sent.
- CLI encrypted snapshot created during stopped-API maintenance. Restored into a **separate empty** `sandbee_admin_restore_drill_20260927` database: 1 staff, 4 products, 0 sessions; auth version increment verified. Cryptographic credential roundtrip/tamper/wrong-key tests separately passed with synthetic data.

Screenshots and detailed local test output are in ignored `test-results/` and `playwright-report/`; they are not part of the source handoff. The handoff script verifies every included file's SHA-256 against its ZIP contents and writes a ZIP checksum.

## Findings fixed during review

1. Optional empty URLs invoked URL parsing inside a schema refinement and returned 500. Refinement now handles invalid/empty input safely; regression test covers it.
2. Relationship pickers contained more than one control inside an implicit label. Explicit control IDs and hint associations now make form labels unambiguous.
3. A visually hidden table heading escaped the overflow container on small viewports. Positioning the table wrapper keeps its accessible heading inside the table scroll region.
4. Changed vault ENV keys could silently lead to mixed-key credential data. Persistent authenticated key verification now blocks an incorrect key at startup.
5. Non-ASCII CSRF input with the same character count could trigger a timing comparison length exception. Byte lengths are checked before constant-time comparison.
6. Optional Store DB connection was initially awaited during startup. It now connects lazily so an optional Store outage does not prevent Admin itself from starting.
7. Windows npm PowerShell wrapper dropped forwarded maintenance flags. Recovery/bootstrap documentation uses direct Node commands with explicit flags.

## Recovery (key copies)

Automated: key fingerprint properties, `verify-key` match/mismatch/format/`--key=` rejection through the real CLI with stdin piped, backup-kind states, a malformed BACKUP_KEY never stopping boot, drill-status thresholds at 100/101/190/191 days, drills and key checks kept apart in `/recovery` and `/overview`, no key material in responses, owner-only access, and a browser check of the Recovery page. Not automated: the interactive hidden-prompt path (needs a real terminal) and an actual restore drill, which the owner performs on a scratch machine per docs/DEPLOYMENT.md.

## Scope limits

These checks do not establish unlimited capacity, absence of all bugs, a production penetration test, provider API correctness, actual cloud backup scheduling or payment accounting correctness. Vercel/Cloudflare deployment execution, POS registry migration, Store write APIs, Messaging wallet settlement and automated external backup scheduling are not included in this phase. Existing projects and production databases were not modified. Deployment at admin.sandbee.in requires the documented production environment, DNS/HTTPS and off-machine recovery setup.

## Phase 2 — on-demand usage checks (11 October 2026)

- `npm test`: **661 tests, 655 passed, 0 failed**, 6 Linux-only tests skipped on Windows. New suites: `phase2-lib` (rules, code table, site probe + stats parser, query allowlist, direct dbStats, Cloudflare GraphQL + token status, Vercel token expiry), `phase2-worker` (queue, lease/fence, one-at-a-time, 3-probe rule, fallbacks, credentials, batch email de-duplication, review fixes), `phase2-api` (role matrix, whitelisted views, watch/check/batch routes, refusal order, fleet and overview fields), `phase2-bind` (stats token bound to its host, migration).
- `npm run build`: passed.
- `npx playwright test --reporter=line`: **40 passed** (37 existing + 3 new: POS clients usage columns, watch list and batch with request-count proof of fast/idle refresh; Usage tab meters, notices, Check now, worker offline; dashboard usage and build-cache retention items). Axe WCAG 2 A/AA and 2.1 AA on the new screens; no overflow at 320, 390, 768 and 1440px.
- Reviews: three independent read-only reviews (worker + adapters; API + UI; end-to-end contract and owner rules) found no critical or high issue. Mediums fixed with tests: stats token bound to the host it was saved for (D37), plain retries with one separate stats request, mail-memory write guarded against recreating a removed POS block, batch email listing only finished checks, fleet refresh budget. Two re-review rounds and a focused pass confirmed every fix; remaining lows fixed (server-side stall flag, abort-aware waits, `check-timeout`, boot email after the first heartbeat, once-per-batch marker freed when nothing was sent, accessibility of the sticky column and notices). The source tree was fingerprinted before and after every read-only review.
- Environment: the development PC's C: drive was full (1.5 GB free). 188 leftover in-memory MongoDB test databases (about 39 GB, mostly from test servers that Playwright stops hard) were removed, and the worker test files now delete their temporary work directories.
- Needs the live check at release (`--self-check --usage`): the Cloudflare GraphQL query against a real account, Vercel `tokens/current` on a real client token. The paused (`DEPLOYMENT_PAUSED`) answer is covered by fixtures only.
- Live release (11 October 2026, main @ 4604b24): `bash scripts/test-linux.sh` on the server: 661 tests, 660 passed, 0 failed, 1 skipped. App and worker healthy after `up -d --build`. `--self-check --usage` on the demo client: `ok site up`, `ok storage health core=0.4%`, `ok cloudflare today=2 yesterday=18` (the GraphQL query is verified on a real account), `ok vercel-token no-expiry`, `ok cloudflare-token no-expiry`, `ok mail-test sent=1`. The owner verified the watch list, Check watched clients, the Usage tab and the dashboard in the browser.
