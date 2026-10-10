# Stage 2 plan — revision 2 (delta to POS-STAGE2-PLAN.md)

Status: PLAN (2026-10-10). Supersedes the overlapping parts of `docs/POS-STAGE2-PLAN.md`
(revision 1). Paths are relative to the admin repo unless they start with `pos-builder/`
(`d:\sandbee.in\pos-builder`, branch `spike`) or `F:\lucifer`. D4, D7, D11, D18 unchanged.
Nothing here modifies lucifer or any client's Vercel project.

Owner direction (2026-10-10): build once, store the build in S3 with a JSON manifest; build again
only when the branch head commit differs; deploy from S3 with the client's Vercel token. Plus a
client-centric, guided deploy UI like the local go-live console (client → branch → deploy/redeploy).

## 1. Changes vs revision 1

| § | Change | Files |
|---|---|---|
| 0 | Finding 10 (S2 run #1): a prebuilt deploy succeeds only with an EMPTY `apps/cafe` directory in the deploy root; the worker always creates it, so the project Root Directory is never changed (`pos-builder/spike/s2.mjs:405-407`). The deployment URL is not reliably on stdout → always find the deployment by `meta.sandbeeRequest` via REST (`s2.mjs:215-226`); the same lookup serves takeover reconcile. The same extracted output was deployed 3× (`s2.mjs:443-450`) → reusing a cached build is valid. | — |
| 0 | Finding 11: `backend/lib/s3.js` buffers whole bodies (`put` :197-217, `get`/`readBody` :100-116, 218-228) and `list` returns keys only (:254-268) → build objects need streaming variants. | — |
| 0 | Finding 12: moved line refs — `installation-workspace.jsx` tabs :35-40, Deploys placeholder :306-316, `deployLock` checkbox :488-501. | — |
| 1 | S1 and S2 passed. Open: S2 run #2 must show `foundByMeta:true`; sentinel inlining result. §2.1 works for either outcome. | `pos-builder/spike/*` |
| 2 | `build.yml`: run-name `pos-build <buildId>`. `package.mjs` (:43-47) adds `builderSha` (`GITHUB_SHA`), `runId`, `runAttempt`, scan counts from `scan-output.mjs --report` (findings :92-101). New `builder.json` `{protocol, nodeVersion, cliVersion}`; a validate step asserts it matches `process.version` and the installed CLI. **No AWS credentials ever go to GitHub.** | `pos-builder/.github/workflows/build.yml`, `scripts/package.mjs`, `scripts/validate-inputs.mjs`, `builder.json` |
| 3 | Config `POS_BUILD_CACHE` = `on`/`off` (default `on` when `FILES_S3_*` is set; pattern `backend/config.js:89-106`). Builder token gains **Contents: read on pos-builder** (builder head SHA + `builder.json`). Adapters: `github.js` + `builderHead()`, `builderFile(sha)`, `compare()`; `vercel.js` + `findDeploymentByMeta`; `s3.js` + `putFile`, `getToFile`, `copySelf`, `list` with `Size`/`LastModified`. | `backend/config.js`, `backend/lib/{github,vercel,s3}.js` |
| 4 | Lanes: `deploy` (1), new `build` (2), `task` (1). Build jobs are transient `system_state` rows (§2.6). Heartbeat `pos-worker` adds `builder{sha,nodeVersion,cliVersion,ok,checkedAt}` (every 5 min) and `lastBuildMs`. CLI errors stored as a category code from a fixed fragment table (`s2.mjs:171-184`) — no stderr text kept. | `backend/worker/{loop,build,fetch-build,retention}.js` |
| 5 | State machine `queued → preflight → resolve → build (skipped on cache hit) → fetch → upload → vercel → health → finalize`; UI shows 5 steps: Resolve · Build/cached · Upload · Go live · Health. Finalize also writes `last.build`, `last.commit`. | `backend/worker/deploy.js` |
| 6 | New: Redeploy, Prepare build, rollback fallback, build-retention sweep, build-cache self-test. | `backend/worker/*`, `backend/modules/deploys.js` |
| 7 | Deploys tab → guided Deploy tab (§3); new "POS clients" fleet page; POS columns on the customer's Installations tab. | §3.4 |
| 8 | Security rows: build-cache poisoning (blocked by GCM + manifest MAC under VAULT_KEY); GitHub holds no AWS credentials. | `docs/SECURITY.md` |
| 9 | In-memory S3 fake (versioning, `If-None-Match`, list, copy), `test/stage2-build-cache.test.js`, worker cases: hit, miss, single-flight, quarantine, 412, S3-off. | `test/fakes/s3.js` |

## 2. S3 build cache

### 2.1 What is cached
A cache entry is the scanned prebuilt output of one lucifer commit built with one exact set of
build-time inputs, looked up by `(sha, buildKey)`.
- Sentinel outcome A (only `NEXT_PUBLIC_*` inlined): inputs = the three `NEXT_PUBLIC_*` values (`""` when unset).
- Outcome B (plain keys like `TENANT_ID`, `ROOT_DOMAIN`, `HOSTING_TIER` also inlined, e.g. edge middleware): those keys go into `build_env` (S1 allowlist) and into `buildKey`; preflight drift check compares them with the project's plain env.
- Outcome C (a secret inlined): stop and escalate to the owner.
In A and B values differ per client, so today each client has its own `buildKey`: the cache gives
instant redeploys, rollback fallbacks and retries, not one build for all.

Future path (separate owner-approved POS change; not now, D11): read the three public values at
runtime (runtime config endpoint or server-rendered values; generic `images.remotePatterns` for
`*.r2.dev` or a custom loader; runtime `/m` CSP instead of reading `NEXT_PUBLIC_R2_PUBLIC_BASE_URL`
in `next.config.ts`). Then `buildKey`'s env part is empty and one build per commit serves every
client — no admin code change needed.

### 2.2 buildKey
`buildKey = HMAC-SHA256(kBuild, canonicalJSON(inputs))` (64 hex), `kBuild = HMAC(VAULT_KEY,
"sandbee-build-key-v1")`. Inputs: `v:1`; `settings` (fixed project settings sent to the builder);
`env` (every build-input key name + raw value, allowlisted public/non-secret only); `builder`
`{sha, workflow:"build.yml", nodeVersion, cliVersion}` from `builder.json` at that SHA. Keyed HMAC so
S3 key names cannot confirm guesses about a client's values. Lives in `backend/lib/build-inputs.js`
(app + worker), reusing `nextPublic` (`pos.js:18-23`) and the realtime derivation. The worker's CLI
version must EQUAL `builder.json.cliVersion` (blocking readiness item otherwise).

### 2.3 Key layout
| Key | Content |
|---|---|
| `builds/<sha40>/<buildKey>.json` | Manifest = commit point, written with `If-None-Match: *` |
| `builds/<sha40>/<buildKey>/<storeId>.tgz.enc` | Ciphertext; `storeId` random UUID so writers never collide |
| `builds/_selftest/<uuid>` | Self-test probe |
Conditional writes: first finished write wins, later ones get 412; in a versioned bucket a write also
succeeds when the current version is a delete marker
(https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html). A losing writer
leaves an orphan that lifecycle removes. Existence is checked with ListObjectsV2 on prefix
`builds/<sha>/<buildKey>` (a missing key without matching ListBucket answers 403, not 404 —
https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

### 2.4 Object format and encryption
Client-file layout (`files.js:24-25`) with magic `SBB1`: `SBB1 | iv(12) | AES-256-GCM ciphertext |
tag(16)`; random 256-bit data key per object; GCM AAD `build:<sha>:<buildKey>`; data key sealed with
`encrypt(hex, VAULT_KEY, "build:<sha>:<buildKey>")` (`crypto.js:52-66`) and stored IN THE MANIFEST
(no new collection; `secrets.js` and snapshot unchanged). Why encrypt compiled output: (1) integrity —
a stolen IAM key with `builds/*` write must not be able to plant a build the worker deploys; GCM under
a VAULT_KEY-sealed key plus the manifest MAC makes forgery impossible without VAULT_KEY; (2) server
bundles are readable compiled code; keep D6's "ciphertext only" posture.

### 2.5 Manifest (plaintext JSON, MAC-protected)
| Group | Fields |
|---|---|
| Identity | `format:"sandbee-build/1"`, `sha`, `buildKey`, `keyFp` (`keyFingerprint`, `crypto.js:19-23`) |
| Source | `branch` (at build time), `commit{message (first line ≤120), authorName (no email), date}` |
| Inputs | `settings`; `env:[{name,set,hmac16}]` (names + keyed value hashes, never values); `builder{sha,workflow,nodeVersion,cliVersion}` |
| Run | `run{id,attempt,conclusion}` (URL derived, not stored) |
| Output | `builtAt`, `storedAt`; `output{bytes,sha256 (plaintext tgz),files,dirs,symlinks}`; `object{key,bytes,sha256 (ciphertext)}` |
| Checks | `scan{findings:0,maps,tsOutsideNodeModules,forbiddenPaths,secretHits,envFiles,symlinkEscapes}`; `tar{entries,bad:0}` |
| Sealing | `dataKey` (vault box); `mac = HMAC(kManifest, canonical(everything except mac))` |
D4: a manifest records what was BUILT; it never names an installation, slug, customer, staff
member, Vercel id or deploy outcome. Deploy state stays only in `deploy.current/last/previous` + audit.

### 2.6 Flow and single flight
Build rows: one transient `system_state` row per build, `_id: "pos-build:<sha>:<buildKey>"` (unique
`_id` = the lock); fields `status` (`queued|dispatching|building|collecting|storing|ready|failed|cancelled`),
non-secret `inputs`, `branch`, `commit`, lease/fence fields (rev-1 §4), `runId`, `runUrl`,
`artifactId`, `attempt`, `waiters[]` (≤20 job ids), `error`, `finishedAt`. Partial index on
`{kind,status}` in `backend/db.js:47-82`. Deleted at `ready` (S3 on); failed rows deleted after 24 h.
Deploy job `resolve`: compute `buildKey` (job inputs + builder head from heartbeat) → S3 list; hit →
`fetch`; miss → `insertOne` build row (`queued`); on E11000 `$addToSet waiters` and wait (single flight).
Build lane: claim queued or expired-lease rows → dispatch, poll run (takeover resumes from `runId`)
→ download artifact (digest, zip reader `s2.mjs:101-143`, `validateTar` `:146-167`, moved to
`backend/worker/artifact.js`) → check builder manifest clean, `sha` and `builderSha` match (if
`builderSha` differs, store under the recomputed key) → seal and store: stream tgz → cipher →
ciphertext sha256 → `/work/builds/<id>/obj.enc` → `putFile(objectKey, If-None-Match)` → PUT manifest
with `If-None-Match` (412 → verify and adopt the existing manifest) → delete GitHub artifact → delete row.
Cancel: a cancelled deploy leaves `waiters`; the GitHub run is cancelled only if no waiter/prepare
request remains. Fetch: reuse a verified local `/work/builds/<id>/output.tgz` from the last hour,
else `getToFile` + streaming decrypt. Upload: extract, write `.vercel/project.json` with real ids,
`mkdir apps/cafe`, run the CLI, `findDeploymentByMeta`.

### 2.7 Integrity on every reuse (else quarantine)
Manifest MAC valid and `keyFp` matches; `format`/`sha`/`buildKey` match the path; `scan.findings==0`,
`tar.bad==0`; ciphertext size + sha256 match; GCM tag verifies at `final()`; plaintext sha256
matches; `validateTar` re-run; worker re-runs the NAME-based scan rules on the tar listing (`.map`,
`.ts` outside `node_modules`, forbidden dirs, `.env*`, `CLAUDE.md`). Decrypt to `.part`, rename only
after all checks. Quarantine = DeleteObject on the manifest (delete marker only), audit
`pos.build.integrity-failed` (system, sha7 + key8), best-effort email, rebuild ONCE. A `keyFp`
mismatch (sealed under an earlier VAULT_KEY) is a plain miss, no alarm.

### 2.8 Retention
> **Superseded by D22** (docs/POS-INTEGRATION.md): the lifecycle rule below uses **10 days**, not 60, and referenced builds are copied forward after **5 days** (live build) / once when it becomes previous, not after 30 / 7 days. The worker (`backend/worker/retention.js`) implements D22; the JSON and the copy-forward numbers in this section are historical.

Lifecycle rule (owner adds in the S3 console):
```json
{ "ID": "builds-cache", "Status": "Enabled", "Filter": { "Prefix": "builds/" },
  "Expiration": { "Days": 60 },
  "NoncurrentVersionExpiration": { "NoncurrentDays": 1 },
  "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } }
```
In a versioned bucket `Expiration` adds a delete marker; noncurrent days count from the successor's
creation; the age clock is last-modified and replacing the object resets it
(https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html); overlapping
noncurrent rules → the shorter wins
(https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-conflicts.html); filters cannot
exclude. So referenced builds are kept by COPY-FORWARD: `deploy.last.build` /
`deploy.previous.build` = `{buildKey, objectKey, touchedAt, source: cache|fresh|artifact}`; a daily
`retention` task copies manifest + object onto themselves when `touchedAt` > 30 days (finalize does
it when > 7 days). Self-copy needs `MetadataDirective: REPLACE`
(https://docs.aws.amazon.com/AmazonS3/latest/API/SOAPCopyObject.html), re-send content-type + SSE
header; CopyObject needs GetObject on source and PutObject on destination, ≤5 GB per call
(https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html).

### 2.9 IAM — replace the admin user's inline policy
```json
{ "Version": "2012-10-17",
  "Statement": [
    { "Sid": "FilesObjects", "Effect": "Allow",
      "Action": ["s3:PutObject","s3:GetObject","s3:GetObjectVersion","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/files/*" },
    { "Sid": "BuildObjects", "Effect": "Allow",
      "Action": ["s3:PutObject","s3:GetObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::<BUCKET>/builds/*" },
    { "Sid": "ListOwnPrefixes", "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": ["files/*", "builds/*"] } } } ] }
```
No GetObjectVersion for builds (current version + crypto); DeleteObject only for quarantine/orphans
(adds delete markers only); never DeleteObjectVersion or bucket/lifecycle changes; `If-None-Match`
needs only PutObject.

### 2.10 Memory and disk
Stream in 64 KB chunks; the tgz is never held in RAM. `putFile` uses `node:https` with explicit
`Content-Length` and `x-amz-content-sha256` = precomputed ciphertext hash (signed payload,
https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html). `getToFile` streams to
disk capped at `manifest.object.bytes`. Peak `/work` per build ≈ 70 MB (9.5 MB zip, 39.6 MB tree).
Keep the 2 GB free-space check; `mem_limit` unchanged.

### 2.11 Failure modes
| Case | Handling |
|---|---|
| S3 down during lookup | Miss; job notes "cache unavailable" |
| S3 PUT fails after a build | Deploy continues from the local tgz; warning "Build not cached"; artifact kept until its 1-day expiry |
| Crash mid-store | Lease takeover; artifact still exists (deleted only after the manifest PUT); redo with a new `storeId`; orphan expires |
| Manifest 412 | Another writer won: verify and use its manifest |
| Integrity failure | Quarantine + one rebuild |
| CLI/builder version drift | Part of `buildKey` → miss; worker/builder CLI mismatch blocks deploys |
| Lifecycle rule missing | Cache grows; docs checklist item (self-test cannot see lifecycle) |

### 2.12 S3 not configured / `POS_BUILD_CACHE=off`
Build row ends `ready` with `artifactId`; `fetch` downloads the GitHub artifact; sweep deletes
artifacts after 2 h; "Redeploy" shows "will build"; rollback = Vercel instant rollback only;
readiness item amber "Build cache off".

## 3. Guided UI

### 3.1 Mapping from the local go-live console
| Local console | Admin |
|---|---|
| Status card rows (`ui/index.html:228-245`) | Readiness checklist + Live card |
| `lockStateOf` (`ui/pure.mjs:21-26`) | `deployLock` + `cutoverAt` |
| `runStateOf` "interrupted" (`:62-68`) | `current` with expired lease ("worker restarted — resuming") |
| `realtimeStateOf` (`:38-48`) | Info row "Realtime URL baked into build: on/off" |
| `showProblems` banner (`ui/app.js:410-414`) | Checklist with "fix" links |
| Confirm texts (`app.js:489-498`) | Deploy modal "what will happen" |
| `statusFor` one-at-a-time (`ui/activity.js:42-55`) | 409 `busy` + disabled buttons with a reason |
| Dashboard KPIs/table (`ui/shell.js:53-85`) | Fleet page |
Web address/DNS states stay in Stage 3.

### 3.2 Deploy tab (`frontend/src/pages/installation-deploy.jsx` + `frontend/src/components/deploy/*.jsx`)
Polled from GET `…/pos/deploys` via `use-poll.js` (2 s while a job is active, 15 s idle).
| Component | Data | Behaviour |
|---|---|---|
| `readiness-checklist` | server-computed `readiness[]` | Groups "Admin setup" / "This client"; each item: state chip, one-line reason, fix link or action |
| `branch-picker` | GET `/pos/branches?installation=:id` → name, sha7, headline, age, `cached` per branch (one S3 list per head, ≤30, LRU 60 s) | Selecting loads `deploy-plan`: ahead/behind vs live, "Build ready (cached, built 2 h ago)" or "Will build (~N min)" (from `lastBuildMs`), "settings changed since live build" |
| `deploy-actions` | plan + `last` + `previous` | Deploy (typed slug + step-up), Redeploy (live commit, current settings; confirm + step-up), Roll back (typed slug + step-up), Prepare build (no production change). Modal lists project, branch@sha7, headline, cached/will build, "env vars on Vercel are not changed" |
| `deploy-progress` | `current.steps` | 5 steps with elapsed time and sub-text ("Using cached build", "GitHub build 2:13 — run ↗", "Waiting for a build already running"); Cancel before upload |
| `version-card` ×2 | `last`, `previous` (branch, sha7 → private commit, headline, when, who, status, `build.cached`) | "Roll back to this" on Previous |
| `deploy-error` | `current.error{step,code,message ≤160}`, `runUrl` (7 days) | Failed step, honest text, "Open GitHub run ↗", Dismiss; refused instant rollback → "Redeploy previous commit (cached)" |
Remove the rev-1 placeholder (`installation-workspace.jsx:306-316`), add the tab (:35-40), the
`deployLock` checkbox (:488-501) becomes a lock badge.

### 3.3 Readiness (`readinessOf()` in `shared/deploy.js`, one function for UI and API)
R = required; the API returns 409 `{code:"not-ready", items:[ids]}` from the same function.
| Group | Items |
|---|---|
| Admin setup | R worker online (heartbeat < 90 s) · R builder ok (token, `builder.json`, CLI versions equal) · R source token (branches load) · build cache (amber; "Test build storage") · R your authenticator enrolled (fix `/account`) · R deploys not frozen (owner: Unfreeze) |
| This client | R Vercel token set · R project + org ids · R last verify: token, project settings, env drift, Mongo reachable, health — with age; "Verify now" · R host set · image store + realtime inputs consistent · R deploy unlocked (owner: Unlock) · R customer active + installation not retired |
Fix links: `/installations/:id/pos#vercel`, `#secrets`, `#host`, `/customers/:cid`, `/account`.
Outside-admin fixes show text (Vercel env drift: "use the local console's Update on Vercel until Stage 3").

### 3.4 Routes and pages
| Route | Gate | Notes |
|---|---|---|
| GET `…/pos/deploys` | credentials | + `readiness`, `worker`, `cache{configured}`, `last/previous.build` (key8 only) |
| GET `…/pos/deploy-plan?branch=` | credentials, consume | branch → sha (source token); compare vs `last.sha` (https://docs.github.com/en/rest/commits/commits#compare-two-commits); cache state |
| POST `…/pos/deploys {kind: deploy\|redeploy, branch, sha, confirm}` | deploy + step-up (+ slug for deploy) | 409 `branch-moved`, `not-ready`, `busy` |
| POST `…/pos/builds {branch, sha}` | deploy, 10/h | Prepare build; audit `pos.build.requested` |
| POST `/pos/build-cache/self-test` | secrets | put/list/get/delete under `builds/_selftest/` |
| GET `/pos/fleet[?customerId=]` | credentials, ≤100 rows | Per POS installation: customer, slug, host, live branch@sha7 + when, branch head, `behindBy` (one compare per distinct pair, LRU), state (live/failed/deploying/locked/unverified), cached-build flag; "branch gone" and "diverged" shown |
Pages: `frontend/src/pages/pos-fleet.jsx` (nav "POS clients" under OPERATIONS, `shell.jsx:35-43`;
route in `main.jsx:115-151`); `customer-workspace.jsx:74-139` merges `/pos/fleet?customerId=` into
the Installations table (Live, Behind, "Deploy →"); generic records API still drops `pos`; Overview
stays Mongo-only (`overview.js:75-85`).

### 3.5 "Deploy this commit to all clients" (follow-up release)
One `system_state` row `pos-rollout` (current/last rollout only, D4): `{id, branch, sha, by,
startedAt, targets[{installationId, slug, status pending|building|deploying|succeeded|failed|skipped,
error8}], stopOnFailure:true, cancelRequested}`. Targets = unlocked, verified, active installations
with `last.sha ≠ sha`; canary (demo) first, then by slug. Build rows for every target (build lane, 2
at a time) → deploy one at a time → stop on failed/rolled-back/unhealthy (rest `skipped`); owner
Resume / Cancel / Dismiss. Gate: deploy + step-up + typing `deploy all`. Deliberately differs from
the local console, which continues past failures (`F:\lucifer\scripts\go-live\ui-server.mjs:299-327`).
After the future POS change: 1 build + N uploads.

## 4. Work units
| Unit | Scope | Phase |
|---|---|---|
| W0 builder | `build.yml`, `builder.json`, `validate-inputs.mjs`, `package.mjs`/`scan-output.mjs` changes; reuse `common.mjs`, `build.mjs --inputs` (:78-83), `write-project-json.mjs` | after S2 run #2 |
| W1 adapters | rev-1 scope + `backend/lib/{build-inputs,build-cache}.js` (key, manifest/MAC, SBB1 streaming seal/open) + `s3.js` streaming; tests `test/fakes/s3.js`, `test/stage2-build-cache.test.js` | A |
| W3 API | rev-1 scope + deploy-plan, builds, self-test, fleet, readiness gate, `shared/deploy.js` `readinessOf` | A |
| W5 UI | `installation-deploy.jsx`, `components/deploy/*`, `pos-fleet.jsx`, `customer-workspace.jsx`, `shell.jsx`, `main.jsx`, `use-poll.js`, `components.css`, `test/ui/deploys.spec.js` (cached vs will-build, prepare build, fleet) | A |
| W2 worker | rev-1 scope + `worker/{build,fetch-build,retention}.js`, build lane, build rows, meta lookup, empty `apps/cafe`, CLI category codes, heartbeat builder info; tests: hit, miss, single-flight, takeover mid-store, 412 adopt, quarantine + rebuild, S3 off, copy-forward | B |
| W4 backup | unchanged | B |
| W7 rollout | separate release after Stage 2 acceptance | C |
Live-deploy additions: before release the owner updates the IAM policy (§2.9), adds the lifecycle
rule (§2.8) and gives the builder token Contents: read on pos-builder; after deploy "Test build
storage"; on demo the first deploy builds and a Redeploy must report "cached" with no GitHub build.

## 5. Decisions to record (proposed)
| # | Decision |
|---|---|
| D19 | S3 also holds a build cache under `builds/` (amends D6). Only the admin worker writes it; GitHub holds no AWS credentials. |
| D20 | Build objects are ciphertext (SBB1); the data key is sealed with VAULT_KEY in a MAC-protected manifest; every reuse is integrity-checked; a failure is quarantined and rebuilt once. |
| D21 | `(sha, buildKey)` identifies a build; `buildKey` = HMAC over every build-time input. One build for all clients waits on a separate owner-approved POS change (D11). |
| D22 | Manifests are build metadata, not deploy history (D4). Retention 60 days; live/previous builds kept by copy-forward. |
| D23 | Single-flight builds via transient `system_state` `pos-build:*` rows; build lane 2, deploy lane 1. |
| D24 | Redeploy = same commit with current settings. Rollback = Vercel instant rollback, fallback redeploy of the previous commit from cache. |
| D25 | The deploy root always contains an empty `apps/cafe`; admin never edits client project settings; the deployment is found by `--meta sandbeeRequest`; CLI failures stored as category codes only. |
| D26 | Readiness is computed once on the server and gates UI and API. Fleet view shows behind-by-N. Future rollout is sequential and stops at the first failure. |
| D27 | The builder token gains Contents: read on pos-builder only. |

## 6. Owner questions
1. Build retention 60 days (+ live/previous kept) — or 30 / 90?
2. Rollout canary: demo first, then alphabetical, stop at first failure — or a custom order?
3. Prepare build owner-only (`deploy` permission) since it spends GitHub Actions minutes? (assumed yes)
Revision-1 questions 1-4 (20 MB backup cap, automatic rollback, 7-day run retention, `deploy`
owner-only) are still open.

## 7. Spike run #3 — output sanitising rules for the production builder (owner-reviewed 2026-10-10)
Run #3 "S3 finding locations" (paths only):
- `functions/middleware.func/index.js.map` [app] — a real source map of the edge middleware (would expose middleware source).
- `apps/cafe/.env.example` copied into `functions/_error.func/`, `functions/_not-found.func/`, `functions/api/areas/[id].func/` [app] — the committed example file (placeholder Mongo URI, matchLen 32), not a secret, but it exposes config key names.
- mongodb-credentials-uri hits in `node_modules/mongoose/lib/{connection,mongoose}.js` [nm] — library doc examples.
- private-key-block hits in `node_modules/mongodb/lib/client-side-encryption/crypto_callbacks.js` [nm] — library parsing code.
- github_pat_ / ghp_ / AKIA: 0.
Production builder rules (`scripts/scan-output.mjs` + `package.mjs`, run before packaging, then the scan runs again and must be clean):
1. Delete every `*.map` under `.vercel/output` (app and node_modules); re-scan must report 0 maps.
2. Delete every `.env.example`/`.env.sample` file; ANY other `.env*` file (e.g. `.env`, `.env.local`, `.env.production*`) is a hard FAIL (never deleted silently).
3. Secret patterns: `github_pat_`, `ghp_`, `AKIA…`, any private-key block or credentialed Mongo URI in an `app` path → FAIL. In `node_modules`, allow only the reviewed (package, rule) pairs: (mongoose, mongodb-credentials-uri), (mongodb, mongodb-credentials-uri), (mongodb, private-key-block); any other node_modules hit → FAIL until reviewed and added to the allowlist in the builder repo (allowlist changes are reviewed like code).
4. The manifest records counts before and after sanitising plus the allowlisted hits (package + rule only).
| D30 | Builder sanitises output before packaging: deletes all `*.map` and `.env.example`; any other `.env*`, any app-path secret pattern, or any non-allowlisted node_modules secret pattern fails the build. Allowlist: (mongoose|mongodb, mongodb-credentials-uri), (mongodb, private-key-block). |
