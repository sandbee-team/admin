# POS integration — plan and decisions

Status: Stage 1 LIVE on admin.sandbee.in since 2026-10-09 (commit `8949777`); full-codebase review
fixes LIVE since 2026-10-10 (commit `1617d30`: 204 unit/API tests, 18 Playwright ×3 green; owner
smoke-checked accounts, files and Recovery after deploy).
Stage 2: W1 adapters, W3 API and W2 deploy worker (separate `worker` container, `backend/worker/`, retention per D22) implemented on branch `feat/pos-stage2`, not yet released; release steps in docs/DEPLOYMENT.md (see docs/POS-STAGE2-PLAN.md, POS-STAGE2-REV2.md). Stage 3 and Phases 2-3 not started. Owner: single operator.
Open owner items: enter Lucifer by hand (Step 8 of the go-live: customer → POS installation →
POS setup with the `lucifer007` profile ids, a new dedicated Vercel token, the MONGODB_URI from the
Vercel project env, accounts); `F:\lucifer\clients\` clean-up later (D14).
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

### Stage 3 — new client go-live from admin (needs POS changes; owner approves separately)

Project create/adopt, env sync (`buildEnv` parity), web address state machine + DNS check, POS
admin login creation (D3), realtime Worker, standby hosts. Port the pure go-live functions with
their tests (~250 in `npm run test:go-live`).

### Transition rules (D1, D11)

- New clients keep using the local go-live until Stage 3 ships.
- Import is one-way. After a client's first verified admin deploy, set `deployLock: true` in its
  local `clients/<slug>.json` (existing feature, `deploy.mjs:163-165`) so the local tool cannot
  upload source again. Local files are deleted only after Stage 3 is verified.
- Until Stage 2, do not share Vercel logins with clients (source is visible there).

## 9. Phase 2 — usage analytics (summary)

- Mongo usage = `(dataSize+indexSize)/512MB` from the cafe's existing `GET /api/health?stats=1`
  with `x-stats-token` (imported `healthStatsToken`); fallback `dbStats` via the client URI.
- Vercel: up/down + latency probes, paused detection (`503 DEPLOYMENT_PAUSED`); Hobby has NO
  usage API (Query API/Drains are Pro-only) — bandwidth/CPU only as an estimate later.
- Cloudflare Worker requests/day via GraphQL `workersInvocationsAdaptive` (token needs Account
  Analytics Read).
- Alerts at 75% / 90%, 3 consecutive health failures, paused, token expiry; Attention panel + email.
- Storage: one small daily point per client (M0 budget), no raw logs.

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
