# P5 — Stage 3: new client go-live from admin (plan)

Status: **APPROVED by the owner 2026-10-13** (plan unchanged; D41-D48 recorded in
`docs/POS-INTEGRATION.md`; answers in §15). Session 2 = spikes S1-S3 + W1 (as-built notes §16).
Session 1 = read-only review (4 subagents: POS go-live core, POS realtime/standby/admin login, admin
backend, admin worker/tests/UI) + this plan. Binding: `docs/POS-INTEGRATION.md` D1-D48 (esp. D3,
D4, D7, D9, D11, D14, D21, D25, D37, D40), `docs/ROADMAP.md` house method, `docs/P4-DNS-CLOUDFLARE.md`
§2 and §7. Paths are relative to this repo unless they start with `F:\lucifer` (POS, read only,
D11; `clients/*` and `deploy.profiles.json` were not read) or `pos-builder/`
(`d:\sandbee.in\pos-builder`, admin's own builder repo).

Goal: a NEW POS client goes live from admin — Vercel project create/adopt, env with `buildEnv`
parity, web address `<label>.sandbee.in` + DNS check (records entered by hand at GoDaddy, D40),
POS admin login (D3), Cloudflare realtime Worker, first deploy through the existing Stage 2 deploy
job — without the local go-live console and without a POS code change (recommended design).

## 1. What the review found (verified in code)

| #   | Finding | Effect on P5 |
| --- | ------- | ------------ |
| F1  | Local go-live `run.mjs:192-408`: lock → validate → seed (tsx `seed-client.ts`) → project create/adopt (`POST /v11/projects` `{name, framework:"nextjs", rootDirectory:"apps/cafe"}`, no git link) → profile → web address → `mintSecrets` → realtime (wrangler) → `buildEnv` + `POST /v10/projects/{id}/env?upsert=true` → `npx vercel deploy` from the working tree → health 12×5 s → 308 redirects. Steps check before they create and save after they learn, so a re-run continues. | Same order and idempotency rules are ported; the deploy itself is the Stage 2 job (prebuilt, D7). |
| F2  | `buildEnv` (`lib.mjs:346-383`): 18 keys + 3 realtime keys, targets `production`+`preview`, types `encrypted`/`plain` only; unselected image store sent as `""` (upsert cannot delete); `NEXTAUTH_URL`/`AUTH_URL` never set (pinned at `lib.test.mjs:260`). `mintSecrets`: `authSecret` = 32 random bytes base64, `healthStatsToken` = 32 bytes hex, minted only when missing (re-minting logs every device out). | Exact port (D43). Admin today never writes env (`backend/worker/deploy.js:601`, `verify.js:21`): P5 is the first writer. |
| F3  | Vercel endpoints used by go-live (`vercel-api.mjs:28-174`): user, project get/create/delete, domains list/get/add/verify/patch(redirect), `GET /v6/domains/{d}/config` (`recommendedCNAME` lowest rank, fallback `cname.vercel-dns.com`), env upsert. No timeouts, no retries, any 400 on verify = "pending". | Admin's `backend/lib/vercel.js:39-224` has none of the write calls; they are added on `provider-http` (timeouts, retries, fixed error codes). |
| F4  | Web address: `SUBDOMAIN_RE`, `RESERVED_SUBDOMAINS = www app api admin hub` (`lib.mjs:18,40`), records `webAddressRecords` (`lib.mjs:174-183`), state `stateOf` (`web-address.mjs:44-51`: ready / check-failed / pending-verify / pending-dns / tenant-mismatch / pending-cert). DNS check `dns-check.mjs:23-144`: `resolveNs(apex)` → `resolve4` of each NS → `new Resolver().setServers()` → CNAME must match `VERCEL_CNAME_RE` (`/(^|\.)vercel-dns(-\d+)?\.com$/i`), TXT exact. | Ported. Admin's own reserved list (`shared/schemas.js:238`) misses `store gstapi ocrapi _dmarc _domainconnect @` (P4 §7) and the F9 names. |
| F5  | Realtime: wrangler 4.140.0 via npx (`cloudflare-api.mjs:20,115-121`), cwd `workers/realtime`; REST only for `/accounts` and `/accounts/{id}/workers/subdomain`. Worker = one 324-line `src/index.ts` (no dependencies), DO `CAFE_ROOM`→`CafeRoom`, migration `v1 new_sqlite_classes` (mandatory on Free), var `TENANT_ID`, secret `REALTIME_PUBLISH_SECRET`, served on workers.dev `pos-realtime-<slug>.<sub>.workers.dev`. Health = `GET /join` → 426, then signed `POST /publish` → 200 (`realtime.mjs:94-133,222-268`). Token needs Workers Scripts:Edit + Account Settings:Read. | Admin cannot run wrangler (read-only container, no npx). Bundle comes from the builder; upload over REST (D46, spike S2). |
| F6  | POS admin login today = direct DB write by `apps/cafe/scripts/seed-admin.ts:14-54`: skip if `Staff.findOne({role:"admin"})`; else insert `{name:"Admin", username (lowercase), mobile:"0000000000", password: bcryptjs hash cost 12, role:"admin", isActive:true}` (+ mongoose `timestamps`, `__v`). Collection `staffs` (mongoose 8.24.0 pluralize, checked), core cluster (`apps/cafe/lib/cluster-registry.ts:80,98`). No HTTP route exists, on purpose ("Bootstrapping is a CLI step on purpose", POS `docs/GO-LIVE-CHECKLIST.md:403-404`). POS uses `bcryptjs` 2.4.3 (MIT, 0 deps). | Admin already holds the client's Mongo URI and opens client DBs (`backend/lib/client-mongo.js`, Atlas-only). Seeding the same way needs no POS change but a new dependency (Q1). |
| F7  | Standby host = the same cafe in ANOTHER Vercel account (own token/project `<slug>-<label>`, same DB and secrets, no web address, realtime keys blank, manual failover). | Admin's whole deploy path is keyed to `pos.vercel` (deploy, verify, rollout, purge, usage). Supporting it is a deploy-path change → separate item P5b (Q3). |
| F8  | A brand-new client can never pass Verify (`health` must be `ok`; `shared/deploy.js:307-315`), and Unlock needs `verified` (`shared/deploy.js:290-296`) → no first deploy is possible today. | Bootstrap verify (D47). |
| F9  | Jobs: no jobs collection; one deploy slot `pos.deploy.current` (steps, lease, fence) and one task slot `pos.task` (counts only, no steps; `deploy-view.js:222-268`). Lanes `{deploy:1, build:2, task:1, usage:1}` (`backend/worker/loop.js:33`). | A dedicated `pos.golive` slot + lane (D41); the first deploy is enqueued into the normal deploy slot, as `backend/worker/rollout.js` `advance()` does. |
| F10 | `provider-http.js:135-137` sends JSON bodies only; Cloudflare script upload needs `multipart/form-data`. `safe-https.js` is GET-only (`getText`/`getJson`). Zip reading exists (`backend/worker/artifact.js:45` `readZipEntries`, `:104` `extractZipEntry`). | Small additive extensions (W2). |
| F11 | Local tool couplings that are NOT ported: `clients/*.json` as database, pid lock files (`lock.mjs`), file-based rollout (`rollout.mjs`), `fresh-start` (deletes projects), `reset/seed-demo`, the loopback UI server, `--token` on argv in `scripts/deploy.mjs:210`. | Replaced by admin's vault, leases, rollout (P3) and UI. Fresh start is not ported (admin never deletes provider resources, D42). |
| F12 | Tests: `npm run test:go-live` = 242 (lib 27, run 66, dns-check 8, lock 11, deploy-lock 7, deploy-profile 5, rollout 7, realtime 38, ui-pure 40, ui 33). About 110 test the local machine (CLI, pid locks, files, loopback server, source pins on `app.js`/`index.html`/`deploy.mjs`) and cannot be ported. | Port map in §11: pure-function tests ported 1:1, flow tests re-expressed on admin fakes, the rest replaced by admin's existing lease/slot tests. |

## 2. Decisions (approved 2026-10-13; recorded as D41-D48)

| #   | Decision |
| --- | -------- |
| D41 | **Go-live job.** One embedded slot `installations.pos.golive` (current state only, D4) with its own worker lane `golive: 1`; shaped like a deploy job (requestId, status, step, steps[], lease+fence, attempt, cancelRequested, error). A run does every automatic step it can and ENDS in `waiting` when the owner must act (DNS at GoDaddy, unlock-and-deploy); nothing holds a lease while waiting. Every step is idempotent (check before create, save after learn, as F1). While a go-live run is queued/running the installation is busy for deploys, tasks and POS setup writes (and vice versa). |
| D42 | **Provider writes (amends D25).** Admin creates or adopts a Vercel project ONLY in a go-live and ONLY when the project has no production deployment (a live project is an existing client: import/P2 path). At creation it sets `BUILD_SETTINGS` (`backend/lib/build-inputs.js:11-19`) and **Function Region `bom1`** (fixes P2 finding F1 for new clients). It writes the env (D43), the project domain `<label>.sandbee.in` and the 308 redirects of the project's `*.vercel.app` names. After go-live the project settings are never changed again; env only through the owner's "Sync env". Admin never deletes a project, Worker, domain or env var (go-live's fresh start is not ported). |
| D43 | **Env = exact `buildEnv` port** (F2): same keys, order, values, types (`encrypted`/`plain`), targets (`production`,`preview`), blanks for the unused store, realtime triple (blank when realtime is off). Upsert only. Admin stores per key only name, type, targets, a keyed 16-hex fingerprint (HMAC under a key derived from VAULT_KEY, label `sandbee-env-fp-v1`) and Vercel's `updatedAt` at write time; drift = key missing, type/target changed, plain value differs, or `updatedAt` newer than admin's write (edited by hand). Vercel env values are never read back or decrypted. `authSecret`, `healthStatsToken`, `realtimePublishSecret` and (if empty) `posAdmin.password` are minted by the worker once, only when missing, never re-minted; minting the stats token sets `statsHost` to the go-live host (D37's list of writers gains "the go-live secrets step"). Imported/hand-entered clients get a names-only parity warning in Verify (`env-keys-missing`); admin does not write their env in P5. |
| D44 | **Web address while DNS is at GoDaddy (D40).** One label per installation: `SUBDOMAIN_RE`; refused: the platform names `@ www admin store gstapi ocrapi _dmarc _domainconnect app api hub` (P4 §7) and the names reserved by code/docs `ecom ocr pos notify whatsapp wa waadmin` (P4 F9); a label held by another installation (unique partial index on `pos.subdomain`); a label whose authoritative DNS already answers with a record that is not this project's (catches clients still only in the local console, D14). Host `<label>.sandbee.in`, `TENANT_ID` = label, `ROOT_DOMAIN` = `sandbee.in` (`PLATFORM_APEX` constant). Admin shows the exact records (CNAME `<label>` → Vercel's rank-1 `recommendedCNAME`; `_vercel.<label>` TXT only when Vercel's `verification[]` asks); the owner enters them at GoDaddy by hand and presses **Check DNS**: the worker asks the apex's own nameservers (F4), then Vercel verify + config, then a TLS probe of the host. No GoDaddy key on the server. A `dnsProvider` seam (`manual` now; `cloudflare` after P4 with the zone token of P4 §7: `apply(records)` creates them, the check stays the same) means P4 adds one adapter and no flow change. All records DNS only. |
| D45 | **POS admin login (amends D3's "needs a POS change"; Q1).** The worker seeds it exactly as `seed-admin.ts` does (F6): only when the client's core DB has no `role:"admin"` staff; never changes or replaces an existing admin (reported as `admin-exists`); bcryptjs (exact version 2.4.3, the POS's own library) cost 12; read-back `compare` proves the stored hash matches the vault password. The password is minted by admin if the owner did not set one and handed to the client once through the existing reveal (owner, step-up, audited). Menu, tables and settings stay manual (D3). |
| D46 | **Realtime Worker without wrangler on the server (Q2).** A NEW pos-builder workflow `realtime.yml` (build.yml untouched) checks out lucifer at the go-live commit, bundles `workers/realtime` with the pinned wrangler (`deploy --dry-run --outdir`, no Cloudflare credentials) and uploads `index.js` + `realtime.json` (compatibility date, DO bindings, migrations, main module, parsed from `wrangler.jsonc`). The admin worker downloads it (builder token, digest-checked), accepts only an allowlisted descriptor (one DO binding, `new_sqlite_classes` migrations only, date `YYYY-MM-DD`, ≤ 1 MB), uploads it over the Cloudflare REST API with `TENANT_ID` and the publish secret, enables workers.dev, and probes 426 + signed publish (ported). Name `pos-realtime-<slug>`; account = stored 32-hex id or the token's only account; workers.dev subdomain = existing, else `pos-<slug>` (+4 hex on conflict, ≤ 3 tries). Redeploy only when the bundle SHA-256, name, tenant or URL changed. The bundle is compiled worker code in the client's own Cloudflare account, as today (not POS app source; D7 unchanged). |
| D47 | **First deploy.** `verifyStateOf` gains `bootstrap`: every flag ok except `health = "not-deployed"`, which Verify writes only when the project has no production deployment. Unlock accepts `bootstrap` only for an installation whose go-live waits for its first deploy (`waitingFor: "deploy"`); rollout (D39) and every other gate still need `ok`. The owner's single action **Unlock and deploy** (`deploy` + step-up + typed slug) unlocks (same fields as `/pos/unlock`; no local-lock attestation, there is no local file) and enqueues the normal deploy job of the go-live commit in one transaction. The go-live is `live` only after that job is healthy, an inline Verify is `ok`, and the redirects are applied (a redirect failure is a warning, as in go-live). |
| D48 | **Scope.** Standby hosts are a separate item P5b after P5 (Q3). Imported clients' env stays manual (D43). The local go-live is not changed (D11); a client gone live from admin never gets a `clients/<slug>.json` (D14). |

P2's proposals (F1 Function Region, F2 local stop) keep D49 and D50 reserved; they are recorded when
P2 resumes and the owner answers its questions.

## 3. Flow (one installation)

Owner prep (outside admin, per client): client's Vercel account + token; Atlas cluster + URI
naming the database; image store (R2 or Cloudinary) + keys; client's Cloudflare account + token
(Workers Scripts:Edit, Account Settings:Read, Account Analytics:Read) — optional, realtime off
without it.

1. **Enter** (existing screens, as in P2 step 1): customer → POS installation → POS setup (slug,
   label = `subdomain`, Vercel team id if any, image store, Cloudflare account id, POS admin
   username) + secrets (Vercel token, Mongo URI, image keys, Cloudflare token; POS admin password
   optional). Project ids stay empty. The block starts locked (unchanged).
2. **Go live tab → Start** (branch picker, default `main`; typed slug + step-up). API resolves the
   commit, derives host/tenant/root domain, queues the run.
3. Worker steps (`GOLIVE_STEPS`), each recorded in `steps[]`:

| Step | Does | Ends with |
| ---- | ---- | --------- |
| `check` | inputs complete; Vercel `GET /v2/user`; Mongo ping (Atlas only); Cloudflare token verify (if set); label rules + authoritative "no foreign record" | `inputs-missing`, `label-*`, token codes |
| `project` | recorded id → by name → create (`POST /v11/projects` + `PATCH /v9/projects/{id}` for node 22.x, `sourceFilesOutsideRootDirectory`, region bom1); refuse a project with a production deployment; store `vercel.projectId/orgId/projectName` | `project-live`, `project-name-taken` |
| `secrets` | mint missing generated secrets + POS admin password (D43); set `statsHost` | — |
| `realtime` | skipped without a Cloudflare token (env triple blank); else D46 | `realtime-*` |
| `domain` | add `<label>.sandbee.in` to the project (409 → `domain-taken`); read verification + config; store records | — |
| `env` | `buildEnv` → upsert → read env metadata → parity (D43) | `env-upsert-failed`, `env-parity` |
| `admin` | seed the POS admin login (D45) | `admin-exists` (warning), `admin-seed-failed` |
| `dns` | authoritative CNAME/TXT → Vercel verify → config → TLS probe; not ready → status `waiting`, `waitingFor: "dns"` | — |
| `ready` | inline bootstrap Verify; status `waiting`, `waitingFor: "deploy"` | verify flags |

4. Owner enters the records at GoDaddy (records table with copy buttons) → **Check DNS** (queues
   a run from `dns`; repeatable, rate-limited).
5. **Unlock and deploy** → normal deploy job (build → upload → promote → health with automatic
   rollback where a previous exists). The go-live lane observes it (`deploying`); then `finish`:
   inline Verify `ok` + `*.vercel.app` 308 redirects → `live`.
6. Owner checks shown as text (ported from the go-live summary, `index.mjs:169-210`): Cloudflare
   WAF rules, R2 CORS, sign in once with the POS admin login, reveal the password once for the
   client.

Later actions on a live go-live installation: **Sync env** (runs `secrets`+`env`; Redeploy makes
it effective) and **Update realtime Worker** (branch → commit; runs `realtime` + `env`).
**Cancel** stops a queued run, a running run between steps, or a waiting one; created provider
resources stay as they are (listed in the panel).

## 4. Data model (additive; no new collection)

`installations.pos.golive` (written only by `backend/modules/golive.js` and `backend/worker/golive.js`):

```
{ status: queued|running|waiting|deploying|failed|cancelled|live,
  action: start|check|sync-env|realtime, requestId, by, at, startedAt, endedAt,
  branch, sha, step, steps: [{name, state, startedAt, endedAt, note≤120}] (≤ 12),
  waitingFor: null|dns|deploy, lease: {owner, until, fence}, attempt, cancelRequested,
  error: {step, code, message≤160}|null, warnings: [code] (≤ 8),
  address: {label, host, records: [{type, name, value}] (≤ 4), cname: {ok, found≤253},
            txt: {ok, found[≤4]}, verified, configured, tls, state, checkedAt},
  env: {at, keys: [{name, type, targets, set, fp16, updatedAt}] (≤ 30)},
  realtime: {bundleSha256, sha, deployedAt, verifiedAt},
  admin: {state: seeded|exists, at},
  deployRequestId, liveAt }
```

Other `pos` fields written by the go-live (all existing): `subdomain` (owner), `host`,
`tenantId`, `rootDomain` (API at start), `vercel.projectId/orgId/projectName`,
`cloudflare.accountId/workerName/workerUrl`, the `generated.*` and `posAdmin.password` boxes
(AAD `pos:<id>:<field>`, existing `POS_SECRET_FIELDS`, so `backend/lib/secrets.js` and snapshot
checks need no new entry), `statsHost`, `deployLock:false` + `unlockedAt/By` (Unlock and deploy).
Each config write bumps `pos.rev` (clears `pos.verify` as today). DNS records and answers are
public data. No value of a secret, no provider text, no log is stored.

Indexes (`backend/db.js:97-162`): partial `{"pos.golive.status": 1}` (claims); unique partial
`{"pos.subdomain": 1}` where `pos.subdomain` is a non-empty string (boot logs and continues if
existing data has a duplicate; the transaction guard still applies).

## 5. API (`backend/modules/golive.js`, new; mounted in `backend/app.js:102-113`)

Conventions as `deploys.js`: `z.uuid()` ids, strict zod schemas (`goliveSchemas` in
`shared/schemas.js`), `transaction` + `authorizeWrite` + `audit`, 409 `busy`/`stale`/`not-ready`
with items, worker-online gate (`WORKER_ONLINE_MS`).

| Method + path | Permission | Step-up | Purpose |
| ------------- | ---------- | ------- | ------- |
| GET `/installations/:id/pos/golive` | credentials | no | `goliveView` + go-live readiness items + worker online + freeze |
| POST `/installations/:id/pos/golive` `{rev, action, branch?, sha?, confirm}` | deploy | yes | start / resume (`start`), `sync-env`, `realtime`; typed slug; 10/h per installation |
| POST `/installations/:id/pos/golive/check` `{rev}` | credentials | no | Check DNS (run from `dns`); 30/h per installation |
| POST `/installations/:id/pos/golive/deploy` `{rev, confirm}` | deploy | yes | Unlock and deploy (D47); not while frozen |
| POST `/installations/:id/pos/golive/cancel` | deploy | no | cancel queued/running/waiting |

Also: `backend/modules/pos.js` PUT/DELETE answer 409 `busy` while a go-live run is queued/running
(`pos.js:169-183` busy check); the subdomain refine in `posConfigSchema` uses the new label rules
(`shared/schemas.js:238,284-287`). Audit actions: `pos.golive.started|check|deploy|cancelled`
(API); `pos.golive.project-created|project-adopted|realtime-deployed|env-synced|admin-seeded|live|failed`
(worker, `WORKER_ACTOR`). Details: ids, step names and codes only.

## 6. Worker

- `backend/worker/lease.js`: `claimGolive` (copy of `claimDeploy` :207-310 on `pos.golive`),
  `expireStaleQueued` (:172-204) covers it.
- `backend/worker/loop.js`: `LANES.golive = 1` (:33); a `golive` block in `tick()` after the deploy
  lane (:129-140): claim → `runGolive`; plus `observeGolive` for `deploying` rows (pattern of
  `rolloutStep`/`observe`, `rollout.js:146-186`).
- `backend/worker/golive.js` (new): `runGolive(ctx, claim)` inside `withLease` (`lease.js:471`),
  step recorder (make `JobRun` names configurable, `deploy.js:70-79`, or a small copy), the steps
  of §3, `failGolive` (pattern of `failJob`, `deploy.js:1174-1225`). Enqueue of the first deploy
  uses `newJob`/`freeSlot` (`backend/lib/deploy-job.js`) like `rollout.js` `advance()` (:378-491).
- `backend/worker/realtime-bundle.js` (new): dispatch `realtime.yml`, find the run by run-name,
  wait, download with the builder token, `readZipEntries`/`extractZipEntry`, descriptor allowlist,
  SHA-256.
- `backend/worker/verify.js`: `health = "not-deployed"` when the project has no production
  deployment (:202-217); names-only env parity warning (:100-181); export the inner checks for the
  go-live's inline Verify.
- `backend/worker/context.js` seams (:89-155): `cloudflareFor`, `dnsCheck`, `posAdminSeed`,
  `realtimeBundle`, `realtimeProbe`, `tlsProbe`; real defaults, `overrides` in tests.
- `backend/worker/deploy.js`: no change expected; a test pins the first deploy of a project with no
  previous deployment (health failure → `unhealthy`, no rollback attempt).

## 7. Adapters and ported functions

| File | Adds | Ported from |
| ---- | ---- | ----------- |
| `shared/web-address.js` (new, used by API, worker, UI) | `PLATFORM_APEX`, `PLATFORM_LABELS`, `labelProblem`, `hostOf`, `webAddressRecords`, `recommendedCnameOf`, `addressStateOf`, `VERCEL_CNAME_RE` | `lib.mjs:18,40,174-183`, `web-address.mjs:31-51`, `dns-check.mjs:21` |
| `shared/golive.js` (new) | steps, states, actions, `goliveBlocks`, readiness items, view limits | — |
| `backend/lib/golive-env.js` (new) | `buildEnv`, `mintSecrets`, `envFingerprints`, `envDrift`, `realtimeEnvOf`, `realtimeOffEnv` | `lib.mjs:346-392`, `realtime.mjs:72-92` |
| `backend/lib/realtime.js` (new) | `workerNameOf`, `parseWorkerUrl`, `signedPublishRequest`, `validateCloudflare`, `ACCOUNT_ID_RE`, descriptor allowlist | `realtime.mjs:17-19,56-113`, `cloudflare-validate.mjs` |
| `backend/lib/dns-check.js` (new) | `createDnsCheck({dns, Resolver})` → `authoritative`, `checkRecords`; bounded answers (≤ 8, ≤ 253 chars, TXT ≤ 1024) | `dns-check.mjs:23-84` |
| `backend/lib/vercel.js` | `projectByName`, `createProject`, `patchProject`, `upsertEnv`, `envMeta` (names/type/target/updatedAt only), `projectDomains`, `projectDomain`, `addDomain`, `verifyDomain`, `domainConfig`, `setDomainRedirect`; responses whitelisted, never values | `vercel-api.mjs:28-174` |
| `backend/lib/cloudflare.js` | `accounts`, `workersSubdomain`, `registerWorkersSubdomain`, `uploadWorker` (multipart), `enableWorkersDev`, `workerMigrationTag` | `cloudflare-api.mjs:54-78` + REST (S2) |
| `backend/lib/provider-http.js` | `form` body (FormData, request ≤ 2 MB); errors unchanged | — |
| `backend/lib/safe-https.js` | `postText` (fixed header allowlist, body ≤ 4 KB) for the publish probe; TLS probe = `getText(host, "/")` any status | — |
| `backend/lib/pos-admin-seed.js` (new) | `seedPosAdmin`, `checkPosAdmin` (bcryptjs) | `seed-admin.ts:14-54` |
| `pos-builder/.github/workflows/realtime.yml` + `pos-builder/scripts/realtime-descriptor.mjs` (new) | bundle + descriptor artifact, run-name `pos-realtime <id>`, retention 1 day | `workers/realtime/wrangler.jsonc` |

A one-off dev check `tools/p5-parity.mjs` imports `F:\lucifer\scripts\go-live\lib.mjs` and
`realtime.mjs` read-only and compares both `buildEnv`s on synthetic fixtures (prints PASS/FAIL and
key names only); its output is recorded in §13 when the port lands. Not part of `npm test`.

## 8. UI

- `frontend/src/pages/installation-workspace.jsx`: tab `golive` "Go live" (:45-54, :76-117),
  shown when `pos.golive` exists, or when the block was not imported and admin has not deployed it
  yet (`pos.importedAt` and `pos.deploy.last` absent). A hand-entered live client (Lucifer, D15)
  would see it, but Start stops at `project` with `project-live` (D42).
- `frontend/src/pages/installation-golive.jsx` (new): `usePoll` (`hooks/use-poll.js`) on the GET
  route; readiness checklist (`components/deploy/readiness-checklist.jsx`); Start (branch picker
  `components/deploy/branch-picker.jsx` + typed slug + `withStepUp`); progress
  `components/golive/golive-progress.jsx` (new, copy of `deploy-progress.jsx` markup and
  aria-live); `components/golive/address-records.jsx` (new: Type/Name/Value with copy buttons,
  CNAME and TXT state, last checked, "Check DNS"); Unlock and deploy modal (copy of `UnlockModal`,
  `installation-deploy.jsx:633-692`, without the local-lock box); owner checks text; Sync env /
  Update realtime Worker / Cancel.
- `frontend/src/pages/pos-fleet.jsx`: "Going live" badge for installations with an active
  go-live; empty state mentions the go-live path (:228-243).
- Error text from `shared/deploy-errors.js` via `describeError` (`components/deploy/format.js`).

## 9. Error codes (`shared/deploy-errors.js`, `add(code, step, title, message, action)`)

`inputs-missing`, `label-reserved`, `label-taken`, `label-in-use-dns`, `project-live`,
`project-name-taken`, `domain-taken`, `dns-unreachable`, `dns-pending`, `dns-wrong-target`,
`txt-pending`, `cert-pending`, `env-upsert-failed`, `env-parity`, `env-keys-missing` (verify
warning), `realtime-bundle-failed`, `realtime-descriptor`, `realtime-upload-failed`,
`realtime-probe-failed`, `cf-account-ambiguous`, `admin-exists` (warning), `admin-seed-failed`,
`golive-cancelled`, `golive-stale`. Provider codes keep the existing `vercel-*`/`cloudflare-*`
prefixes (:687-723).

## 10. POS and builder changes (each needs the owner's separate OK)

**POS repo (`F:\lucifer`): none in the recommended design.** Conditional only:

| # | Only if | Change | Why | Risk | Tests |
| - | ------- | ------ | --- | ---- | ----- |
| PC1 | Q1 = "POS route" instead of bcryptjs | `POST /api/setup/admin` in `apps/cafe`: one-time `SETUP_TOKEN` env, constant-time compare, allowed only while `staffs` has no admin, same password rule, rate limit | admin would call a POS-owned contract instead of writing the schema | a new internet-facing route in every client; contradicts the POS's "bootstrap is a CLI step" rule | POS unit tests: token missing/wrong/right, admin exists, weak password, race (unique username) |
| PC2 | spike S4 shows `/api/health` or `/login` fails on an empty DB (no settings/tables/menu) | minimal fix in the cafe (default settings) or admin seeds a minimal settings document | D3 keeps menu/tables/settings manual | small | POS test of an empty-DB boot |

**pos-builder (admin's builder repo, not POS):** BC1 = new `realtime.yml` + descriptor script
(D46). `build.yml` is not touched. Risk: low (separate workflow, read-only lucifer token it
already has, no Cloudflare secret in GitHub). Test: spike S2 on branch `spike-realtime`, then the
production workflow on `main`.

## 11. Tests (failing first; port map)

| Go-live file (count) | Admin target | Ported / re-expressed | Not ported (reason) |
| -------------------- | ------------ | --------------------- | ------------------- |
| `lib.test.mjs` (27) | `test/stage3-lib.test.js` | ≈ 22 (validation, records, `buildEnv` incl. blanks/realtime/no `NEXTAUTH_URL`, `mintSecrets` stability, `pickVercelDomain`) | 5: repo-file pins, import-cycle pin |
| `dns-check.test.mjs` (8) | `stage3-adapters` | 8 (fake `dns`/`Resolver`) | — |
| `realtime.test.mjs` (38) | `stage3-lib` + `stage3-worker` | ≈ 25 (name/URL/env/signature/validation; adopt/redeploy/secret/probe/self-heal on fakes) | ≈ 13: wrangler spawn, source pins |
| `run.test.mjs` (66) | `stage3-worker` | ≈ 30 flows (create/adopt/refuse project, address states, env, secrets stable, health) | ≈ 36: CLI, files, standby (P5b), fresh start, demo seed |
| `ui-pure.test.mjs` (40) | `stage3-lib` | ≈ 8 (address/realtime state, label input) | 32: DOM source pins |
| `ui` (33), `lock` (11), `rollout` (7), `deploy-lock` (7), `deploy-profile` (5) | — | 0 | local server, pid locks, files; admin's lease/slot/rollout tests cover the same guarantees |

New admin tests (each with `assertNoSecrets` on every response, `test/helpers.js:183-204`):
`test/stage3-adapters.test.js` (Vercel/Cloudflare HTTP fakes, multipart upload shape, dns-check,
bcryptjs seed against mongodb-memory-server, descriptor allowlist, `postText`), `test/stage3-api.test.js`
(403/428/typed slug, busy both ways, label guard incl. unique index, rate limits, views whitelist,
audit), `test/stage3-worker.test.js` (`makeEnv`/`makeWorker` of `p3-rollout-worker.test.js:59-187`:
full happy path to `waiting dns` → check → `waiting deploy` → deploy → `live`; every failure code;
kill/takeover mid-step; stale `pos.rev`; cancel; first deploy without previous; verify bootstrap),
`test/ui/golive.spec.js` (start, records copy, check, unlock-and-deploy, errors, 320-1440 px, axe)
with a `/pos/golive` control route and new TOTP owners `golive-owner-a..` in `test/ui-server.js`
(the `deploy-owner-a..z` names are used up). Fakes: `test/fakes/vercel.js` and
`test/fakes/cloudflare.js` gain routes; `test/fakes/builder.js` `createFakeVercel` gains
project/env/domain state; new `test/fakes/dns.js`.

## 12. Spikes (before the code that depends on them)

| # | Proves | Where / who | Outward-facing (owner confirms first) |
| - | ------ | ----------- | ------------------------------------- |
| S1 | Project create with `serverlessFunctionRegion: "bom1"` + PATCH node/`sourceFilesOutsideRootDirectory` passes admin's `inspectProject`; env upsert with `""` values and both types; env metadata fields (`updatedAt`, `type`, `target`); domain add/config/verify fields for a sandbee.in label; TLS on the domain before any deployment | `tools/spikes/p5-vercel.mjs` on the dev PC, token from `SPIKE_VERCEL_TOKEN` (never printed; output = status codes, field names, booleans) | project in the throwaway Vercel account; one GoDaddy record `p5spike` CNAME (removed after) |
| S2 | `realtime.yml` bundle; REST upload with DO binding + sqlite migration + plain var + secret; second upload without migration; workers.dev enable; 426 + signed publish 200 | pos-builder branch `spike-realtime` + `tools/spikes/p5-realtime.mjs`, token from `SPIKE_CF_TOKEN` | Worker in a throwaway Cloudflare account |
| S3 | The worker container can query GoDaddy's nameservers directly (UDP/TCP 53 egress) | owner runs one read-only `docker compose exec worker node -e …` line on the server | none |
| S4 | Dress rehearsal (W7): full go-live of a spike client from admin on the spike accounts with a throwaway Atlas database and label `p5spike`: admin-seeded login works, empty-DB boot (`/api/health`, `/login`), first deploy, Verify `ok`, redirects | admin release on the server, owner-guided | spike accounts + `p5spike` record |

## 13. Work units across sessions

| Session | Unit | Files (scope) | Depends |
| ------- | ---- | ------------- | ------- |
| 2 | Spikes S1, S2, S3 (owner-assisted) | `tools/spikes/*`, pos-builder `spike-realtime` | approval |
| 2 | W1 pure port + parity check | `shared/web-address.js`, `backend/lib/golive-env.js`, `backend/lib/realtime.js`, `backend/lib/dns-check.js`, `test/stage3-lib.test.js`, `tools/p5-parity.mjs` | — |
| 3 | W2 adapters (+ bcryptjs) | `backend/lib/{vercel,cloudflare,provider-http,safe-https,pos-admin-seed}.js`, `test/fakes/{vercel,cloudflare,builder,dns}.js`, `test/stage3-adapters.test.js`, `package.json`, `package-lock.json` | S1, S2 |
| 3 | W3 realtime bundle (parallel with W2: disjoint files) | pos-builder `realtime.yml` + descriptor script; `backend/worker/realtime-bundle.js` | S2 |
| 4 | W4 contract + API + data model | `shared/{golive,deploy,schemas,deploy-errors}.js`, `backend/lib/{deploy-job,deploy-view}.js`, `backend/modules/{golive,pos}.js`, `backend/app.js`, `backend/db.js`, `test/stage3-api.test.js` | W1 |
| 4 | W5 worker (after W4: shares `shared/golive.js`) | `backend/worker/{golive,lease,loop,context,verify}.js`, `test/stage3-worker.test.js` | W2-W4 |
| 5 | W6 UI | §8 files, `test/ui-server.js`, `test/ui/golive.spec.js`, styles | W4 |
| 5 | Reviews: 2 independent read-only opus reviews (fingerprinted tree), fixes, re-review; `npm test`, `npm run build`, Playwright | — | W1-W6 |
| 6 | W7 release: `bash scripts/test-linux.sh` on the server, merge, push, server steps (image rebuild installs bcryptjs; no new container, volume or `.env` variable); dress rehearsal S4; then the first real client, guided; docs `API.md`, `SECURITY.md`, `DEPLOYMENT.md` | — | all |
| later | P5b standby hosts (design note first) | — | P5 live |

## 14. Risks

1. Admin now writes into client Vercel projects and client databases → only in a go-live, only
   for a project without production (D42), env upsert only, the admin seed never touches an
   existing admin (D45), every write audited; nothing is deleted.
2. Coupling to the POS Staff schema (D45) → spike S4 + a pinned test vector; if the POS changes
   `Staff`, the read-back check fails loudly; PC1 is the fallback.
3. Realtime REST upload differs from wrangler (migration tags, bindings) → S2 before W2/W3; the
   descriptor allowlist refuses anything else; realtime off (polling) is a working fallback.
4. DNS: negative caching of the new name by the server's resolver before the record exists → the
   label check asks only the authoritative servers; the TLS probe and the deploy health check
   retry; `dns-unreachable` if port 53 egress is blocked (S3).
5. A label used only by a local-console client is invisible to admin → the authoritative "foreign
   record" refusal (D44); keep the local console's clients on their own labels until D14 clean-up.
6. Env blanks (`""`) may be refused by Vercel → S1; fallback: skip blank keys on a new project
   (nothing to overwrite) and keep the blanks rule for Sync env.
7. GitHub minutes: one small realtime run per go-live or Worker update (≈ 1 min).
8. Token reach: a client's Cloudflare token with "All accounts"/"All zones" scope could reach
   sandbee.in once P4 runs (P4 F12) → the owner checklist asks for a token scoped to the client's
   account only.
9. Go-live runs and deploys share the installation → busy rules both ways (D41) + `pos.rev` guards.

## 15. Owner questions (recommended default in bold)

**Answered 2026-10-13:** Q1 bcryptjs (seed from admin), Q2 pos-builder `realtime.yml`, Q3 standby
hosts = P5b after P5, Q4 yes (`SPIKE_VERCEL_TOKEN` and `SPIKE_CF_TOKEN` set on the dev PC; the
temporary GoDaddy record `p5spike` is allowed), Q5 existing screens.


- Q1 POS admin login: **seed it from admin like the local go-live (new dependency `bcryptjs`
  2.4.3, exact pin, the POS's own library; no POS change)**, or POS change PC1 (bootstrap route)?
- Q2 Realtime bundle: **new pos-builder workflow `realtime.yml` (build.yml untouched)**, or strip
  TypeScript types inside admin (experimental Node API; needs the source token in the worker)?
- Q3 Standby hosts: **separate item P5b right after P5** — do you run any standby today?
- Q4 Spikes: **keep the throwaway Vercel account + `SPIKE_VERCEL_TOKEN` until P5 is live** (open
  owner item "delete it" waits), create a throwaway Cloudflare account token (Workers Scripts:Edit
  + Account Settings:Read) as `SPIKE_CF_TOKEN` on the dev PC, and allow the temporary GoDaddy
  record `p5spike` for S1/S4?
- Q5 New client entry: **existing screens (Customer → Installation → POS setup, as in P2 step 1)**;
  a one-form "New client" page later (P8) if it feels slow?
