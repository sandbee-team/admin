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
| D44 | **Web address while DNS is at GoDaddy (D40).** One label per installation: `SUBDOMAIN_RE`; refused: the platform names `@ www admin store gstapi ocrapi _dmarc _domainconnect app api hub` (P4 §7) and the names reserved by code/docs `ecom ocr pos notify whatsapp wa waadmin` (P4 F9); a label held by another installation (unique partial index on `pos.subdomain`; as built: on `pos.golive.address.label`, D51); a label whose authoritative DNS already answers with a record that is not this project's (catches clients still only in the local console, D14). Host `<label>.sandbee.in`, `TENANT_ID` = label, `ROOT_DOMAIN` = `sandbee.in` (`PLATFORM_APEX` constant). Admin shows the exact records (CNAME `<label>` → Vercel's rank-1 `recommendedCNAME`; `_vercel.<label>` TXT only when Vercel's `verification[]` asks); the owner enters them at GoDaddy by hand and presses **Check DNS**: the worker asks the apex's own nameservers (F4), then Vercel verify + config, then a TLS probe of the host. No GoDaddy key on the server. A `dnsProvider` seam (`manual` now; `cloudflare` after P4 with the zone token of P4 §7: `apply(records)` creates them, the check stays the same) means P4 adds one adapter and no flow change. All records DNS only. |
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

## 16. As built (session 2, 2026-10-13; session 3, 2026-10-14; sessions 4-5, 2026-10-16)

**Docs.** Plan approved unchanged; D41-D48 recorded in `docs/POS-INTEGRATION.md` (main @ 4082048).
D49/D50 stay reserved for P2's F1/F2; next free D-number D51.

**W1 — pure port (TDD, new files only; no existing file changed).**

- `shared/web-address.js`: `PLATFORM_APEX`, `PLATFORM_LABELS` (the 18 refused names of D44),
  `SUBDOMAIN_RE`, `VERCEL_CNAME_RE`, `VERCEL_CNAME_TARGET`, `ADDRESS_STATES`; `labelProblem` →
  `label-invalid` | `label-reserved`; `labelFromInput` (ui `subdomainFromInput`) → `{label, problem}`
  with the extra code `label-not-single`; `hostOf`; `webAddressRecords` (≤ 4 rows);
  `recommendedCnameOf` (also falls back when Vercel's value is not a Vercel DNS name);
  `addressStateOf` (web-address.mjs `stateOf`).
- `backend/lib/golive-env.js`: `buildEnv` (exact; a fresh `target` array per entry),
  `realtimeEnvOf`, `realtimeOffEnv`, `GOLIVE_ENV_KEYS` (21, buildEnv order); `envClientOf` maps
  `pos.image` + the vault's `mongo.uri` / `image.keys` to the go-live client shape (a selected
  store missing any value → `inputs-missing`, never written as blanks); `mintSecrets` (also mints
  `realtimePublishSecret`, 32 bytes hex like go-live's `ensureRealtime`); `mintPosAdminPassword`
  (144 random bits + a digit, passes the seeder's rule); `envFp` = first 16 hex of
  HMAC(HMAC(VAULT_KEY, `sandbee-env-fp-v1`), JSON `[key, value]`); `envFingerprints`; `envDrift`
  (one reason per key: `missing` / `type` / `targets` / `value` (plain only: the W2 adapter
  fingerprints plain values in memory and drops them; encrypted values are never read) /
  `edited` (Vercel `updatedAt` newer than admin's write); per-environment rows merged; ≤ 30);
  `missingEnvKeys` (names-only `env-keys-missing`).
- `backend/lib/realtime.js`: `workerNameOf` (code `realtime-name`: a slug longer than 50 chars
  cannot get a Worker — W4's check step reports it), `parseWorkerUrl`, `signedPublishRequest`,
  `publishVerdict` (`ok` / `realtime-tenant-refused` / `realtime-secret-mismatch` /
  `realtime-envelope` / `realtime-probe-failed`; W4 adds the new codes to §9), probe constants,
  `realtimeNeedsDeploy`, `subdomainCandidate`, `validateCloudflare` (bad field names; no block =
  realtime off), `parseRealtimeDescriptor` (allowlist below), `uploadMetadataOf` (the multipart
  `metadata`: main module, date, DO + `TENANT_ID` plain + `REALTIME_PUBLISH_SECRET` secret
  bindings; migrations as wrangler sends them: all on a new script, none at the last tag, the
  later steps after an older tag, an unknown tag refused; bad tenant/secret → `inputs-missing`).
- `backend/lib/dns-check.js`: `createDnsCheck({dns, Resolver, timeoutMs})` → `authoritative`
  (≤ 8 nameserver IPs, Resolver timeout 4 s × 2 tries), `checkRecords` (codes only, CNAME ≤ 253,
  ≤ 8 TXT rows of ≤ 1024 chars, chunks joined), `lookupLabel` (D44 "foreign record": an unknown
  answer throws `dns-unreachable`, never reads as free). go-live's `probeHealth` is not ported
  (TLS probe = W2 `safe-https`). Deviation from §11: the dns-check tests live in
  `test/stage3-lib.test.js` (W1), not `stage3-adapters`.
- Descriptor `realtime.json` v1 (pos-builder `scripts/realtime-descriptor.mjs` writes it, admin
  `parseRealtimeDescriptor` reads it): `{v: 1, main: "index.js", compatibilityDate,
  compatibilityFlags: [], durableObjects: [{name, className}], migrations: [{tag,
  newSqliteClasses}], bundleSha256, bundleBytes ≤ 1 MiB}`; `vars` are not carried (admin sets
  `TENANT_ID`).
- `tools/p5-parity.mjs` (dev PC; imports `F:\lucifer\scripts\go-live\{lib,realtime,dns-check}.mjs`
  and `ui\pure.mjs` read only).

Evidence (Windows dev PC): `node --test test/stage3-lib.test.js` → `# tests 50 # pass 50 # fail 0`.
`node tools/p5-parity.mjs` → 30/30 PASS: `buildEnv` for 3 image stores × 3 realtime modes
(untouched/off/on) × 2 tenants (17-21 keys, same keys/order/types/targets/values), `mintSecrets`,
`realtimeEnvOf`, `realtimeOffEnv`, `signedPublishRequest`, `workerNameOf`, `parseWorkerUrl`,
`webAddressRecords`, `VERCEL_CNAME_RE`, `SUBDOMAIN_RE`, `isStrongPassword`, label input (admin
also refuses `store`, `pos`, `wa` — D44). Full suite on `p5-stage3` (owner ran it on the dev PC,
2026-10-14; the agent's permission system refused it): `npm test` → tests 777, suites 151, pass 771,
fail 0, cancelled 0, skipped 6 (the Linux-only ones), todo 0 (727 of P3 + 50 new). `npm run build`
→ `✓ built in 9.08s` (the existing > 500 kB chunk warning only; no frontend file imports W1 yet).

**Spikes.**

- S2 bundle half proven on the dev PC with the exact workflow steps: pos-builder branch
  `spike-realtime` @ f92d4c3 (local commit) adds `.github/workflows/realtime.yml` (fetch job:
  sparse checkout of `workers/realtime` only, token only in that step; bundle job: no secrets,
  `npm ci --ignore-scripts` of `tools/wrangler` = wrangler 4.140.0 lockfile, `deploy --dry-run
  --outdir`, descriptor; artifact `pos-realtime-<id>` = `index.js` + `realtime.json`; spike-only
  `push` trigger with lucifer main 1d30ac6), `scripts/realtime-descriptor.mjs` and
  `tools/wrangler/`. Local result: `index.js` 6,299 bytes, sha256 `d2a7c079…0dbe31`, date
  2026-01-01, binding `CAFE_ROOM`, migration `v1`; admin's allowlist accepted it and
  `uploadMetadataOf` produced the 3 bindings + `{new_tag: v1, steps: [{new_sqlite_classes:
  [CafeRoom]}]}`. wrangler also writes `index.js.map` (sources inside) and `README.md`: neither
  is shipped; `index.js` keeps a `sourceMappingURL` comment (harmless without the map).
- **S2 bundle on GitHub done (2026-10-14):** branch `spike-realtime` @ f92d4c3 on origin; the
  `realtime` run ("pos-realtime spike", push trigger) is green and its summary reads
  `realtime-descriptor: ok bytes=6299 sha256=d2a7c079f566084a8b5228c459cf67f64d8c91059558930f102ad2e9df0dbe31
  date=2026-01-01 binding=CAFE_ROOM migrations=v1` — byte-identical to the dev PC bundle, so the
  pinned wrangler bundle is deterministic across Linux and Windows (the digest is a stable
  redeploy key for D46). Sparse checkout + `npm ci --ignore-scripts` + dry-run work on the runner
  with no Cloudflare credentials.
- **S3 done (2026-10-13, owner on the server, `~/admin`, worker container):**
  `S3 ns=2 ns-ips=2 authoritative-udp=ok(1) tcp53=ok` — the worker reaches GoDaddy's nameservers
  directly over UDP and TCP 53, so the authoritative DNS check (D44) works from production; no
  egress change needed. (Same result on the dev PC.)
- S1 and the S2 upload: done 2026-10-16 by the owner (results in "Session 4" below).

### Session 3 (2026-10-14): W4 contract + API + data model, W3 realtime bundle

The owner reordered the units: W4 and W3 now (no spike tokens needed); W2 and W5 wait for S1/S2.

**W4 (TDD: `test/stage3-api.test.js` written first, red on the routes, then green).**

- `shared/golive.js` (new): the stored contract (its comment block = §4 as built),
  `GOLIVE_STATES`, `GOLIVE_ACTIVE` (= queued/running, the busy states), `GOLIVE_ACTIONS`,
  `GOLIVE_STEPS` (11: the §3 steps + `deploy`, `finish`), `GOLIVE_RUN_STEPS` per action (start =
  check … ready; check = dns, ready; sync-env = secrets, env; realtime = realtime, env),
  `WAITING_FOR`, `GOLIVE_LIMITS`, `GOLIVE_RATE` (start 10/h, check 30/h), `goliveBlocks` (the
  task slot's queue-expiry and dead-lease rule), `goliveActionProblem` (busy | golive-state per
  action and state; a dead run counts as ended; once `liveAt` is set only sync-env/realtime
  run; cancel = queued/running/waiting), `goliveStepsFor` (check keeps the steps before `dns`),
  `goliveReadinessOf` (12 items; worker, builder, source-token, authenticator, customer-active
  and vercel-token are read from `readinessOf` so both checklists agree; new-client, mongo-uri,
  web-address, image (warn without a store), pos-admin, realtime (warn = realtime off; blocked
  for a bad account id or a slug > 50)), `GOLIVE_GATES`, `goliveBlockedFor` (a realtime warning
  blocks the `realtime` action).
- `shared/deploy.js`: `verifyStateOf` → `bootstrap` (all flags ok except `health =
  "not-deployed"`; older than 24 h → `stale`); `readinessOf` ctx `bootstrap` — only then does a
  bootstrap verify satisfy `verified` (blocked otherwise: "no production deployment yet").
- `shared/deploy-errors.js`: 32 go-live codes (§9 + W1's `label-invalid`, `label-not-single`,
  `realtime-name`, `realtime-tenant-refused`, `realtime-secret-mismatch`, `realtime-envelope` +
  W3's `realtime-bundle-refused`, `realtime-bundle-timeout`).
- `shared/schemas.js`: `goliveSchemas` (run = start|realtime {rev, branch, sha, confirm} |
  sync-env {rev, confirm}; check {rev}; deploy {rev, confirm}; cancel {requestId}); the POS setup
  subdomain refuses `PLATFORM_LABELS` (D44) instead of the old 5 names.
- `backend/lib/deploy-job.js`: `newGolive` (learned parts carried, run fields new), `goliveFree`
  (filter part), `labelHolderFilter`. `backend/lib/deploy-view.js`: `goliveView` (no lease, no
  `fp16`, `bundle8` instead of the digest, DNS names normalised, unknown codes → `internal`,
  only known warnings), `goliveBadge` (status + waitingFor; also in `posView`).
- `backend/modules/deploys.js`: the loading/readiness/enqueue helpers moved unchanged into an
  exported `deployHelpers(deps)` (+ `factsOf`, readiness `extra`), used by both route modules;
  `claimDeploySlot` and `claimTaskSlot` also require `goliveFree`.
- `backend/modules/golive.js` (new, mounted after `deployRoutes`): GET (rev, golive view,
  readiness, address preview, `allowed` per action, `deployBlocked`, busy, worker, freeze,
  verifyState/verify); POST start/sync-env/realtime (deploy + step-up + typed slug; the typed
  slug is checked before the 10/h limit; the sha is re-checked on the branch; start derives
  `host`/`tenantId`/`rootDomain` = `<label>.sandbee.in`, label, `sandbee.in`, and bumps `rev` +
  clears `verify` only when they change); POST check (credentials, 30/h, waiting only); POST
  deploy = Unlock and deploy (D47: readiness of the block as unlocked + bootstrap, gate `deploy`
  incl. not-frozen; sets the `/pos/unlock` fields without the local-lock attestation and
  `pos.deploy.current` = a normal deploy job of the go-live commit; go-live → `deploying`, step
  `deploy` running, `deployRequestId`; audits `pos.unlocked` + `pos.golive.deploy`); POST cancel
  {requestId} (queued/waiting → cancelled now; running with a live lease → `cancelRequested`; a
  dead lease → cancelled now with a new fence value). Every write = `{_id, pos.rev}` + deploy,
  task and go-live slots free, in one transaction; audits `pos.golive.started|check|deploy|cancelled`.
- `backend/modules/pos.js`: `idle()` refuses EVERY setup write (config, any secret, removal)
  while a go-live run blocks (the deploy/task rules are unchanged); PUT config refuses a
  subdomain that another installation's go-live holds on the apex (`label-taken`).
- `backend/db.js`: partial `{"pos.golive.status": 1}`; unique partial
  `{"pos.golive.address.label": 1}` (where it is a string).

Deviations from the plan (recorded as D51 in `docs/POS-INTEGRATION.md`):

1. **Label uniqueness**: not a unique index on `pos.subdomain` (§4) — existing blocks
   (imported/hand-entered, other root domains) and the test fixtures share subdomains, so that
   index would fail at boot or refuse valid data. Instead: a unique partial index on
   `pos.golive.address.label` (decides two concurrent starts; a duplicate key → 409
   `label-taken`) + the start's transactional holder query (another installation with that
   go-live label, the same host, or the same label on `sandbee.in`) + the PUT config check. D44's
   authoritative "foreign record" check (W5) still covers the local console's clients.
2. The data model's `at` is stored as `requestedAt` (the shared queue-expiry rule reads it).
3. Sync env, Update realtime Worker, Check DNS and Unlock and deploy refuse with 409
   `golive-address` when `subdomain`/`host` no longer match the go-live's address (they would
   write or check another tenant); Start re-derives the address.
4. `/pos/unlock` and the normal deploy routes never accept `bootstrap`; only Unlock and deploy.
5. `db-backup` (read-only on the client DB) is not blocked by a go-live run.

**W3 (realtime bundle).**

- `backend/worker/realtime-bundle.js` (new): `realtimeGitHubOf(c)` (builder repo + token,
  workflow `realtime.yml`, run-name prefix `pos-realtime`; `backend/lib/github.js` gained the
  `runPrefix` option, default `pos-build`), `fetchRealtimeBundle(ctx, {github, sha, dir, prior,
  onDispatched, signal, t})`: reuses `prior` {id, runId, at} (takeover; found by run-name when
  only the id is stored; a prior run whose artifact is gone is bundled once more), else
  dispatches `{run_id, sha}` (`onDispatched` before and after, so W5 can store the run); polls
  (queued > 10 min or total > 15 min → cancel + `realtime-bundle-timeout`); failed/cancelled →
  `realtime-bundle-failed` (message from the failed step's name); provenance (path, `main`,
  `workflow_dispatch`, run-name) and exactly one fresh, digest-carrying `pos-realtime-<id>`
  artifact, else `realtime-bundle-refused`; download ≤ 2 MiB (digest checked by the adapter);
  zip = exactly `index.js` (≤ 1 MiB) + `realtime.json` (≤ 16 KB); `parseRealtimeDescriptor` +
  the bundle's sha256/size, else `realtime-descriptor`. Returns the bundle in memory, deletes the
  GitHub artifact, removes every local file. Provider errors are left to W5's failure mapping
  (`github-<code>`, as in the build lane).
- `test/stage3-bundle.test.js` (new; the fake builder lives in the file, `test/fakes/builder.js`
  stays W2's): 10 tests (happy path, takeover reuse by run id and by run-name, re-bundle when the
  artifact is gone, inputs/token, failed/cancelled/slow runs, 4 provenance fields, 5 artifact
  cases, 4 zip cases, 6 descriptor cases, the adapter's workflow path/inputs/run-name). A mutation
  check (digest and branch checks removed) turns 2 of them red.
- pos-builder (local branch `realtime` @ fb6f921 off `main` @ 60ceb7b, **not pushed** — waits for
  the owner's OK): production `.github/workflows/realtime.yml` = the spike minus the `push`
  trigger and `SPIKE_SHA`, `run_id` must be a UUID, `overwrite: false`, plus a `cleanup` job
  (`always()`, the only job with `actions: write`) running `scripts/delete-artifacts.mjs` with
  `IN_KIND=realtime` (deletes `rtsrc-<run_id>` only, never `pos-realtime-<run_id>`; build.yml's
  src/raw cleanup unchanged; both kinds checked against a fake GitHub);
  `scripts/realtime-descriptor.mjs` and `tools/wrangler/` from the spike; README section.
  `build.yml` untouched.

**Contract notes for W5.** Claim `pos.golive` with `GOLIVE_ACTIVE` (copy of `claimDeploy`); run
`GOLIVE_RUN_STEPS[action]`; end in `waiting` (`waitingFor` dns|deploy) with no lease; write
`cancelled` for `cancelRequested` between steps; observe `deploying` through `deployRequestId`
and set `liveAt` once at `live`; store the bundle run from `onDispatched` (suggested
`pos.golive.realtime.run = {id, runId, at}`); `backend/worker/rollout.js` `advance()` must add
`goliveFree` to its deploy-slot claim (D41 both ways).

Evidence (Windows dev PC, 2026-10-14, branch `p5-stage3`): `node --test test/stage3-api.test.js` →
`# tests 27 # pass 27 # fail 0`; `node --test test/stage3-bundle.test.js` → `# tests 10 # pass 10
# fail 0`; `npm test` → tests 814, suites 162, pass 808, fail 0, cancelled 0, skipped 6 (the
Linux-only ones), todo 0 (777 before + 37 new); `npm run build` → `✓ built in 4.98s` (the existing
> 500 kB chunk warning only; no frontend file imports the go-live yet, so no Playwright run).
Changed files were formatted with prettier (only those files).

### Session 4 (2026-10-16): spikes S1 + S2 upload, merge of main, W2 adapters, W5 worker

**Merge.** main @ 5ca7937 (sales documents D52/D53, sign-in D54) merged into `p5-stage3` @ c1548da
(conflicts in `backend/db.js`, `docs/POS-INTEGRATION.md`, `docs/ROADMAP.md`, both sides kept);
`npm test` after the merge → tests 912, pass 906, fail 0, skipped 6.

**Spikes (owner, dev PC, 2026-10-16).** Run against the DEMO client's own Vercel and Cloudflare
accounts with new 7-day tokens (owner's choice instead of throwaway accounts, Q4 amended: the
scripts only create `p5spike` resources and never touch demo's project or Worker). The resources
(Vercel project `p5spike` with domain `p5spike.sandbee.in`, Worker `pos-realtime-p5spike`, GoDaddy
CNAME `p5spike`) stay until the S4 dress rehearsal, then the owner deletes them by hand.

S1 (Vercel, `tools/spikes/p5-vercel.mjs`):

- `POST /v11/projects` with `serverlessFunctionRegion: "bom1"` → 200; the response carries
  `serverlessFunctionRegion=bom1`, `functionDefaultRegions=[bom1]`,
  `defaultFunctionDefaultRegions=[bom1]`. `PATCH /v9/projects/{id}` (node `22.x`,
  `sourceFilesOutsideRootDirectory: true`) → 200. Admin's `inspectProject` on the result: vercel,
  project and env all ok, no problems or warnings.
- Env upsert (21 keys, 12 of them `""`) → 201 `{created, failed}`, 21 created, 0 failed: **blank
  values are accepted** (risk 6 closed; no fallback needed). Env list rows have the fields
  `configurationId, createdAt, createdBy, decrypted, id, key, lastEditedByDisplayName,
  lastEditedByPrincipal, securityIssues, target, type, updatedAt, updatedBy, value`; `target` is an
  array (2 per row), `updatedAt` a number; `value` is returned for encrypted (12) and plain (9)
  rows alike, so the adapter must whitelist `key, type, target, updatedAt` and fingerprint plain
  values in memory only (D43), never keep `value`.
- **An upsert with the same values bumps `updatedAt` on every row**; changing one key bumps only
  that row. So the env step must read the env metadata after its own upsert and record those
  `updatedAt` values as admin's write (D43 drift "edited by hand" compares against them).
- Domain: `GET` 404 → add → 200 with `apexName, createdAt, customEnvironmentId, gitBranch, name,
  projectId, redirect, redirectStatusCode, updatedAt, verified`; **`verified=true` at once and no
  `verification[]`** for a sandbee.in label (no `_vercel` TXT record needed). `GET
  /v6/domains/{d}/config` → `aValues, acceptedChallenges, cnames, configuredBy, conflicts,
  ipStatus, misconfigured, nameservers, recommendedCNAME, recommendedIPv4, serviceType`;
  `recommendedCNAME` has 2 ranked entries, rank 1 a project-specific
  `<16 hex>.vercel-dns-017.com` (matches `VERCEL_CNAME_RE`); `misconfigured=true` before the
  record, then `false` with `configuredBy=CNAME`.
- DNS (GoDaddy's own nameservers, `dns-check.js`): `lookupLabel` → `posdemo` and `p5spike` in use
  (CNAME to Vercel), a random label free; `checkRecords` → `cnameOk=true`.
- **TLS before the first deployment never comes up** (`ECONNRESET` right after the record and again
  15+ minutes later). So the `dns` step must not wait for TLS: DNS is ready when the authoritative
  CNAME matches, Vercel says `verified` and the config is not `misconfigured`; `tls` is recorded
  as `cert-pending` (a note, not a blocker) and HTTPS is proven after the first deploy (deploy
  health check + the `finish` step's inline Verify).

S2 upload (Cloudflare, `tools/spikes/p5-realtime.mjs`, bundle sha256 `d2a7c079…0dbe31`):

- `GET /accounts` needs **Account Settings: Read** (403, code 9109 without a usable grant); with
  it, `count=1`, so "the token's only account" works when no account id is stored.
- **A token whose validity starts in the future verifies as `active`** at `/user/tokens/verify` but
  every account call fails (403/9109, 401/10000). The check step must therefore prove access with
  an account call (`/accounts` or the stored account's `/workers/subdomain`), not with the verify
  call alone.
- workers.dev subdomain: existing one returned (`present=true`), nothing registered.
- Migration tag: new script → `GET /workers/services/{name}` 404 and no row in `GET
  /workers/scripts` → all migrations sent → upload 200; afterwards both report `migration_tag=v1`.
  Second upload without migrations → 200. **Re-sending the migrations at the current tag → 412,
  code 10079**: the adapter reads the tag first (as `uploadMetadataOf` assumes) and maps 10079 to
  `realtime-upload-failed`.
- Script settings: bindings `CAFE_ROOM` durable_object_namespace, `REALTIME_PUBLISH_SECRET`
  secret_text, `TENANT_ID` plain_text, compatibility date 2026-01-01. workers.dev enable → 200.
- Probes: `GET /join` → 426 only on the **4th** try (a new workers.dev name takes seconds to
  propagate; the probe must retry, as `PUBLISH_PROBE_*` already do); signed publish → 200 (`ok`);
  publish for another tenant → 404 (`realtime-probe-failed`), so tenants stay isolated.

**W2 — adapters (two parallel units, disjoint files; committed d75e88f).**

- W2a: `backend/lib/vercel.js` gains `projectByName`, `createProject` (S1's verified payload: name,
  framework, rootDirectory, region `bom1`; 409 → `project-name-taken`; not retried), `patchProject`
  (node `22.x`, `sourceFilesOutsideRootDirectory`), `upsertEnv` (`{created, failed[{key, code}]}`,
  never throws on failed rows), `envMeta(id, {fingerprint})` (rows `{key, type, target[],
  updatedAt, fp16?}`; plain values only reach the caller's fingerprint callback in memory, which
  must answer 16 hex or the call fails), `projectDomains`, `projectDomain`, `addDomain` (409 →
  `domain-taken`; already on this project → returned), `verifyDomain`, `domainConfig`,
  `setDomainRedirect`; one project whitelist (gains `serverlessFunctionRegion`).
  `backend/lib/pos-admin-seed.js`: `seedPosAdmin` (exact seed-admin.ts port; atomic upsert on
  `{role: "admin"}` so concurrent seeds leave one admin; read-back `compare`; seed-admin.ts's
  password rule 8-72 characters with a digit and a special character), `checkPosAdmin`
  (read-only), `AdminSeedError` (`admin-seed-failed` + a reason token); it creates no index on the
  client's DB. `bcryptjs` exactly 2.4.3 (D45). Stateful fetch-level Vercel fake.
- W2b: `provider-http` `form` bodies (multipart, ≤ 2 MiB, built in memory, no retry unless
  idempotent; `ProviderError.providerCodes` = numeric provider codes only); `cloudflare.js`
  `accounts`, `workersSubdomain`, `registerWorkersSubdomain` (taken → `conflict`),
  `workerMigrationTag`, `uploadWorker` (412/10079 etc. → `realtime-upload-failed`, one attempt),
  `enableWorkersDev`, `scriptSettings` (binding names/types + date only), `tokenAccess` (proves
  access with an account call); `safe-https` `postText` (3 allowed headers, ≤ 4 KB) and `probeTls`
  (`cert-pending` for connect/TLS failures). Stateful Cloudflare fake (probes included) and a
  reusable `test/fakes/dns.js`.
- Deviation from §11: the adapter tests are `test/stage3-adapters-vercel.test.js` (27) and
  `test/stage3-adapters-cf.test.js` (33). Evidence: `npm test` with W2 → tests 975, pass 969, fail
  0, skipped 6.

**W5 — the go-live worker.**

- `backend/worker/golive.js` (new): `runGolive` inside `withLease` runs `GOLIVE_RUN_STEPS[action]`
  (steps done in the current run are skipped on takeover); between steps: lease, `cancelRequested`
  (→ `cancelled`, `golive-cancelled`), `pos.rev` (→ `golive-stale`). Writes are fenced; POS-block
  writes run in one transaction with their audit and the run's `pos.rev` guard, bump the rev and
  clear `pos.verify` like the API. `failGolive`, `observeGolive` (DB-only, for `deploying` rows).
- `lease.js` `claimGolive`; a queued go-live that expires becomes `failed` / `not-picked-up`.
  `loop.js` lane `golive: 1` (not counted in `activeJobs`): `observeGolive`, then claim + run.
  `context.js` seams `cloudflareFor`, `dnsCheck`, `openClientDb`, `posAdminSeed`, `posAdminCheck`,
  `realtimeGitHub`, `realtimeProbe`, `tlsProbe`. `verify.js` exports `verifyChecks`,
  `verifyRecord`, `VERIFY_STEPS`; health `not-deployed` for a project without production;
  `pos.verify.envKeysMissing` (names only, a warning) for clients without `pos.golive.env`.
  `rollout.js` `advance()` claims with `freeSlot(deploy)` AND `goliveFree` (`target-busy`).
  `deploy-view.js` `verifyView.envKeysMissing`; `shared/deploy-errors.js` + `not-deployed`,
  `redirect-failed`. W3's fake builder moved to `test/fakes/realtime-builder.js`.
- Re-runs/takeover per step: check re-checks everything (a label that already answers is accepted
  only when it equals the stored CNAME); project = recorded id → name → create, ids saved right
  after create, patched only when different and not live, a live project → `project-live` unless
  it is this go-live's own first deploy; secrets never re-minted (`secret-unreadable` if a box
  cannot be opened); realtime reuses a stored bundle run, never uploads a NEW Worker twice (a
  pending upload whose script now has a migration tag counts as landed), uploads only when digest,
  name, tenant or URL changed, one self-heal upload on a bad publish verdict; domain read before
  add; env writes only when the intended fingerprints or Vercel's metadata differ, and an
  interrupted upsert counts as landed when every key's `updatedAt` is newer than the stored
  `pending.base` (Vercel's clock); admin skips a recorded `seeded`, and an `exists` whose password
  matches the vault counts as ours; dns read-only; ready re-verifies; finish sets only missing
  redirects.
- Stored additions to §4: `env.pending {digest, base}`, `realtime {…, tenantId, run, pending}`,
  the DNS waiting reason in `warnings` (`dns-pending`, `dns-wrong-target`, `txt-pending`,
  `dns-unreachable`), `address.tls` = the probe result (`cert-pending` is normal before the first
  deploy, S1).
- Deviations (recorded as D55): the dns step ends `waiting` with the reason in `warnings`, not in
  `error`; TLS is not a DNS condition (S1); a queued go-live expires as `failed`/`not-picked-up`;
  `observeGolive` re-queues the run at step `finish` when the deploy job is healthy, so finish runs
  under a lease (the installation is briefly busy); a re-Start after a failed finish converges to
  `live` without a second deploy; the inline Verify writes `pos.verify` and audits
  `pos.verify.completed`; the realtime self-heal triggers on any verdict but `realtime-envelope`
  (real Cloudflare answers 404 for another tenant); codes where the plan had none —
  `cloudflare-denied` (no accessible account), `cloudflare-conflict` (subdomain candidates used
  up), the bare Mongo verify flags in check, the first failing verify flag in ready/finish,
  `project-not-found`, `job-lost`; a takeover between create and save adopts by name (audited as
  `project-adopted`). Busy both ways: the API refuses deploy/task while a go-live blocks
  (`stage3-api`), and the rollout stops at `target-busy` (`stage3-worker`).
- Open for session 5 (W6 + reviews): (1) a client without a Cloudflare token but with a
  hand-entered `pos.cloudflare.workerUrl` gets the realtime env blanked and then fails Verify with
  `env-drift` — recommended: the readiness item flags it (no silent config change); (2) W6 shows
  `envKeysMissing` and the DNS waiting reasons; (3) an UPDATE of an existing Worker interrupted by a
  takeover is re-PUT (idempotent; a landed update cannot be told apart).

Evidence (Windows dev PC, 2026-10-16, branch `p5-stage3`): `node --test
test/stage3-worker.test.js` → `# tests 48 # pass 48 # fail 0` (a mutation check — the env
"upsert landed", Worker "upload landed" and "own deploy" guards disabled in turn — turns its test
red each time); `npm test` → tests 1023, suites 197, pass 1017, fail 0, cancelled 0, skipped 6 (the
Linux-only ones), todo 0; `npm run build` → `✓ built in 3.40s` (the existing > 500 kB chunk warning
only; no frontend file changed, so no Playwright run). Changed files formatted with prettier (only
those files).

### Session 5 (2026-10-16): W6 UI, open item 1, two reviews and four re-review rounds

**Open item 1 decided (D56).** A block with a hand-entered `pos.cloudflare.workerUrl` but no
Cloudflare token would get its `REALTIME_*` env blanked by the env step and then fail Verify
(`env-drift`). The readiness item `realtime` is now `blocked` for it ("add the token, or clear the
Worker URL", fix link `#cloudflare`), and `realtime` joins the Start and Sync env gates: a BLOCKED
realtime item (also a bad account id or a slug > 50, which were shown but not enforced before)
refuses the run (409 `not-ready`, items `["realtime"]`); its warning (realtime off) still passes;
`readiness.ready` = nothing blocked. Nothing is changed quietly. Session 4's open items (2) are
done in W6; (3) (an interrupted UPDATE of an existing Worker is PUT again) is accepted as is.

**W6 — UI.**

- `frontend/src/pages/installation-golive.jsx` (new): `usePoll` on GET `…/pos/golive` (2 s while
  queued/running/deploying, else 15 s); progress; web address records; first deploy panel; owner
  checks (ported from the local summary: WAF rules, R2 CORS, sign in once, reveal the password
  once — not when the login already existed or the client re-passworded it); readiness checklist
  (`words` prop: "Is this client ready to go live?" / "Ready to start"); Start (branch picker,
  default `main`, the commit fixed when the dialog opens) or "Run all steps again…" / "Start
  again…"; after go-live: Sync env… and Update realtime Worker…; "What admin set up" (project,
  address, Worker, env count, admin login; nothing is deleted). Every action shows the reason the
  server would give instead of a dead button (role first, then `allowed`, busy, `drift`,
  `deployBlocked`, `goliveBlockedFor`). Start / Sync env / Worker update and Unlock and deploy =
  typed slug + `withStepUp`; Cancel = confirm dialog; Check DNS = direct POST (owner and admin;
  also while waiting for the deploy, to refresh a verify older than 24 h).
- `components/golive/golive-progress.jsx` (new): the 11 go-live steps (a Sync env run shows its
  2), one status sentence per status / waitingFor / stalled / cancelRequested, the error with its
  title + message + action from `shared/deploy-errors.js`, non-DNS warnings (`admin-exists`,
  `redirect-failed`), cancel foot; a Check DNS run is titled "DNS check" only on its own steps.
- `components/golive/address-records.jsx` (new): Type / Name (Host) / Value (Points to) table with
  a Copy button per name and value (rows stack on phones), address state chip, the DNS waiting
  reasons (`dns-pending`, `dns-wrong-target`, `txt-pending`, `domain-unverified`,
  `dns-unreachable`) with their actions, what the last check found, last checked, Check DNS.
- `installation-workspace.jsx`: tab "Go live" when the block is missing, has a go-live, or was
  neither imported nor deployed by admin; POS setup gains the `#cloudflare` and `#admin` anchors.
- `installation-deploy.jsx`: Verify's `envKeysMissing` (names only) in the verification details;
  the env-drift hint points a go-live client to Sync env (live) or a re-run (not live yet).
- `pos-fleet.jsx` + `/pos/fleet`: "Going live" badge ("— waiting for DNS", "— ready to deploy",
  "— first deploy", "Go-live stopped"); `goliveBadge` gains `live`; the fleet projection reads only
  status / waitingFor / liveAt; the empty state names the Go live path.
- `test/ui-server.js`: owners `golive-owner-a..f` and an own `golive-admin` (the per-staff sign-in
  limit is shared by every spec that signs `deploy-admin` in — it made `rollout.spec` fail once);
  `GOLIVE_SCENARIOS` (new client, waiting DNS with TXT, failed `project-live`, live with
  `admin-exists` + `redirect-failed`, hand-entered Worker URL, imported client with
  `envKeysMissing`) seeded only by `reset?scenario=<name>` and removed by `reset?scenario=all` (the
  fleet and rollout specs never see them); control route `/pos/golive?scenario=&phase=running|
  failed|waiting-dns|waiting-deploy|live` writes the slot and the POS fields as the worker does.
- `test/ui/golive.spec.js` (new, 3 tests): Start → running → waiting DNS (copy buttons checked
  through the clipboard) → Check DNS → waiting deploy → Unlock and deploy → fleet badge → live →
  Sync env; an admin at waiting DNS and waiting deploy (no Unlock and deploy button) and on a live
  client, at 320/390/768/1440 px + axe; failure, the blocked realtime item and its fix link,
  cancel, `envKeysMissing` on the Deploy tab.

**Reviews: 2 independent read-only opus reviews of `git diff main`** (A backend security, B
contract + UI + tests; tree fingerprint `0310ee4e09e50e63` before and after both). A: no auth or
step-up bypass, no secret leak, no SSRF, no provider delete; 1 high, 4 medium, 6 low. B: 2 high,
3 medium, 9 low. Merged and fixed — every critical/high/medium and the cheap lows — each with a
test written to fail on the reviewed code (14/14 red before, green after):

| # | Finding | Fix |
| - | ------- | --- |
| H1 | A failed or other-commit realtime bundle run was carried into every later run and reused | `newGolive` drops `realtime.run` (only a takeover of the same run reuses it) |
| H2 | After an unhealthy first deploy (no previous version) no admin path could deploy again | Verify writes health `first-unhealthy` while the go-live's own production fails its health check; `verifyStateOf` reads it as `bootstrap` (`BOOTSTRAP_HEALTH`), so a re-run with a fix → ready → Unlock and deploy → live |
| H3 | Setup changed after the env/admin steps (image keys, database URI) went unnoticed: Unlock and deploy shipped the old env, a re-run skipped the admin login | `golive.env.rev`; ready, finish, Check DNS and Unlock and deploy refuse `golive-settings`; the admin step skips a recorded `seeded` only at the same rev |
| M1 | Start rewrote host/tenant/root of a hand-entered live client before `project-live` | `new-client` is blocked for a hand-entered project id unless a Verify of the last 24 h says `not-deployed` |
| M2 | Sync env / Worker update followed hand edits of project id, tenant, root domain, Worker URL | `golive.projectId`, `realtime.url`; shared `goliveDriftOf` → 409 `golive-address` / `golive-realtime`; the worker's realtime and env steps re-check (`golive-stale`) |
| M3 | A takeover adopted a pos.rev changed under a dead lease, and could run beside a deploy/task the API then allowed | `golive.rev` set at enqueue, moved by the worker's own bumps, checked at the first checkpoint; observe's finish re-queue stores the current rev (filter-guarded); a takeover claim needs the deploy and task slots inactive |
| M4 | Sync env after a failed Worker update blanked `REALTIME_*` silently | 409 `golive-realtime`; the worker throws `realtime-probe-failed` instead of writing the off triple |
| M5 | A re-Start refused the client's own generic `cname.vercel-dns.com` record | the check step also accepts the answer its dns step accepted |
| M6 | A Cancel during the step that ends in waiting/live was lost; the UI then disabled Cancel | `settle()` / `commit({when})` write the final state only while `cancelRequested` is not true; Cancel is disabled only for a running run |
| L | Admin saw Unlock and deploy; GET `allowed` ignored gates/busy/drift; `ready` false on a warning; Sync env minted an admin password; `txt-pending` without a TXT row; texts; no re-check while waiting for deploy; Verify `not-deployed` for any client | owner check first; `allowed` folds busy + gates + `drift` (in GET); `ready` = nothing blocked; mint only on Start before a seeded login; `domain-unverified`; texts; Check DNS while waiting for deploy; `not-deployed` only for a new client |

**Re-reviews (read-only opus, one per round, tree fingerprinted before and after each).**

- Round 1 (`bd67957eb74e517e`), 3 medium: after a HEALTHY first deploy a settings change went
  live without a redeploy or got stuck → `first-unhealthy` for any failing health of the go-live's
  own production; ready finishes without a deploy only when the env was not written after the
  deploy (`envWritten`, or `env.at` later than `deploy.last.at`), else it waits for Unlock and
  deploy again; finish refuses `golive-settings` when setup changed during the deploy; a
  never-deployed hand-entered project id was a dead end → allowed with a current `not-deployed`
  verify; a re-check turned a seeded login into "exists" → `admin-mismatch`.
- Round 2 (`4eb1e8eeca6ee508`), 1 high + 1 medium: a second deploy that failed and rolled back
  left `deploy.last` = #1 while `deployRequestId` named #2 → every Start ended `project-live` →
  `goliveOwnsProduction`; `admin-mismatch` also fired when the client re-passworded the login in
  the POS or the URI moved to a database with its own admin → only on a change of the STORED
  username or password.
- Round 3 (`b075ef5f9645fc8b`), 1 high + 2 medium: ownership was not bound to the go-live's
  project (a hand-edited id to a live project passed) → `goliveOwnsProduction` needs
  `pos.vercel.projectId === golive.projectId`, the project step also `project.id ===
  golive.projectId` and production = admin's recorded deploy; a new project's verify is never fully
  "ok" (env missing) → `handEnteredLive` checks health + age only; a Deploy-tab rollback stamps
  `last.at` → `envAfterDeploy` is true for `rolled-back-to`. Lows: keyed fingerprints (`pwFp`,
  `uriFp`) instead of timestamps for the admin login, `userFound` for "kept", no second seed audit.
- Round 4 (`e54e82bbaa9b0998`), 1 medium: a stale `lastAliasRequest` after a plain promote made
  the project step refuse its own project → `isProduction` (the deploy worker's rule) or
  `productionOf`. Lows: `changedInPos` drops the hand-over item; texts.
- Final narrow check (`caeebe27bc650a7a`): no critical, high or medium.

Each round's fixes have tests that are red on the code before them (round 1: 14/14, round 2: 4/4,
round 3: 2/2, round 4: 4/4, round 5: 2/2; checked by swapping the earlier sources back in).

Known (low, accepted): a concurrent POS setup save on installation B and a Start on A with the
same label can both commit (write skew; B can never Start with it — the unique index refuses — and
the DNS check catches a foreign record); a takeover can wait behind a queued deploy that a freeze
holds; `env.rev` compares the whole `pos.rev` (any setup save, even a no-op, asks for Run all steps
again); a run that dies between the end of `ready` and its waiting write ends `internal` on
takeover (Start again recovers); the `admin-exists` warning is cleared by a later run (the owner
checks read `golive.admin.state`); with `changedInPos` the "sign in once" check still names the
username (the client knows the new password).

Evidence (Windows dev PC, 2026-10-16, branch `p5-stage3`): `npm test` → tests 1048, suites 203, pass 1042, fail 0, cancelled 0,
skipped 6 (the Linux-only ones), todo 0 (1023 after session 4 + 25 new: 1 for W6's gate + 24
review-fix regressions); `npm run build` → `✓ built in 2.38s` (the existing > 500 kB chunk
warning only); `npx playwright test --reporter=line` → `57 passed (7.7m)` (54 before + the 3
go-live tests). An earlier full Playwright run failed once in `rollout.spec` ("Too many
requests" on `deploy-admin`'s email-code sign-in): fixed by giving `golive.spec` its own admin.
Changed files formatted with prettier (only those files). All of it is local on `p5-stage3`;
nothing was pushed, deployed or written to a provider.

- Open for session 6 (W7): docs `API.md` (the go-live routes and 409 codes), `SECURITY.md`
  (provider writes, keyed fingerprints, no deletes), `DEPLOYMENT.md` (image rebuild installs
  bcryptjs; no new container, volume or `.env` variable); the owner pushes pos-builder `realtime`;
  `bash scripts/test-linux.sh` on the server; merge + push + server steps; dress rehearsal S4
  (`p5spike`, throwaway Atlas DB): seeded login, empty-DB boot, Verify ok, redirect.
