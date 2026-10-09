# POS integration — Stage 1 implementation plan (U1–U5)

Companion to `docs/POS-INTEGRATION.md` (decisions D1–D14). Read that first.
Status: PLAN (2026-10-09). Owner answers pending: see "Open questions" at the end.
Paths are relative to the repo root. file:line references point at the 2026-10-03 release (`0d2d1d5`).

## 0. Facts from the code that shape the design

1. Generic API would leak embedded blocks. List projects out only `secret`
   (`backend/modules/records.js:211`); detail/PUT go through `scrub`, which drops only `secret`
   (`records.js:35-42,225,292`). Once `accounts/files/pos` exist, generic GET/PUT on customers and
   installations would return the boxes → must fix in U2.
2. Generic PUT cannot wipe embedded blocks: it `$set`s exactly the strict schema keys
   (`records.js:262-279`, `shared/schemas.js:42,84`); the editor sends only `def.defaults` keys
   (`frontend/src/pages/record-editor.jsx:45-56`); no `replaceOne`. Needs a regression test.
3. Password recovery would bypass TOTP: `/auth/recover` + `/auth/verify` (purpose `recovery`)
   creates a session with email only (`auth.js:139-152,181-258`) → gate it behind TOTP.
4. `/api` gate forces `application/json` on mutations (`backend/app.js:62`) and a 32 kb JSON
   limit (`app.js:66`) → upload route needs an explicit exception.
5. `api()` always sends JSON and JSON-parses responses (`frontend/src/lib/api.js:5-27`) → add
   `upload`/`download` helpers.
6. `server.requestTimeout = 15000` (`backend/server.js:26`) covers the whole body → 20 MB uploads
   fail below ~11 Mbps upstream.
7. Editor key includes the revision (`record-editor.jsx:32`) → bumping the record revision on
   embedded changes would reset an open form → embedded entries carry their own `rev`.
8. `/overview` takes the newest `recovery_checks` row of any type (`overview.js:63-65`); Recovery
   page renders every row as a drill (`governance.jsx:494-505`) → type filters needed.
9. `scripts/recovery.js` requires BACKUP_KEY and `--maintenance` for every command (`:12-22`).
10. Audit trail is readable by every role (`overview.js:111-130`) → audit `detail` must never
    contain filenames or secrets.
11. Importable data: `F:\lucifer\clients\demo.json` (full go-live record). There is no
    `clients/lucifer.json`; lucifer exists only as deploy profiles `lucifer007` and
    `lucifer-v1-PROD` (token via `tokenEnv`) plus free-form `clients/lucifer.md` → lucifer is
    entered by hand.

## 1. Owner TOTP (D10) — U1

New `backend/lib/totp.js` (clean port of `F:\lucifer\apps\hub\lib\totp.ts`): `base32Encode/Decode`,
`generateKey()` (20 random bytes), `codeAt(key, step, {algorithm sha1|sha256|sha512, digits 6|8,
period 30|60})`, `verify(key, code, nowMs, opts)` → matched step | null (±1 step, `timingSafeEqual`),
`otpauthUri(key, account, issuer)`, `parseKeyInput(text)` (base32 key or `otpauth://` URI →
`{key, params}`).

Stored: `staff.totp = {key: box AAD "staff:<id>:totp", enabledAt, lastStep}`,
`staff.totpBackupCodes = [hmac]`, `staff.totpPending = {key: box AAD "staff:<id>:totp-pending",
expiresAt}`. Backup-code hash = `mac(subkey, "<staffId>:<CODE>")`, `subkey = mac(VAULT_KEY,
"staff-backup-codes-v1")` (so losing AUTH_SECRET still only loses sessions). 10 codes, 10 chars
from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown `XXXXX-XXXXX`.

Enrolment (`backend/modules/auth.js`, all `requireAuth`):

- `POST /auth/totp/enrol/start` — if already enabled (replace) → `requireStepUp`; else the
  session must be fresh (`session.createdAt` ≥ now−15 min) or 403 "Sign in again to set up the
  authenticator". Writes `totpPending`, returns `{secret, uri, qrSvg}` once.
- `POST /auth/totp/enrol/confirm {code}` — needs unexpired pending key + valid code. One
  transaction: set `totp` (lastStep = matched step), 10 new hashes, `$unset totpPending`,
  `$inc revision`, delete the staff member's OTHER sessions, set current session
  `stepUpUntil = now+10min`, audit `totp.enabled|totp.replaced`. Returns `{backupCodes}` once.
- `POST /auth/totp/backup-codes` (step-up) — regenerate; audit `totp.backup-codes-regenerated`.
- `POST /auth/totp/disable` (step-up) — 409 for `role === "owner"`; audit `totp.disabled`.

Roles: owner enrolment effectively mandatory (every `secrets` route needs step-up, step-up needs
TOTP; persistent banner until enrolled; login NOT blocked so bootstrap/reset still work). Other
roles may enrol; once enrolled, login requires it.

Login order: password → email OTP → TOTP.

- `/auth/verify` (`auth.js:153`) unchanged until the email code is consumed; challenge lookup
  filters `purpose: {$in: ["login","recovery"]}`.
- If `staff.totp.enabledAt`: no session; insert challenge `{purpose:"totp", staffId, authVersion,
attempts:0, expiresAt:+5min, pendingPasswordHash?}` → `200 {totpRequired:true, challengeId}`.
  Recovery parks the new scrypt hash in the challenge; applied only after TOTP passes.
- New `POST /auth/verify-totp {challengeId, code | backupCode}` (exactly one; `.strict()` + refine).
- Extract session creation (`auth.js:186-258`) into `createSession(row, action, newHash)`.
- Add `/verify-totp` to the concurrency gate (`auth.js:51`); `consume("verify-ip")` and
  `consume("totp:<staffId>", 10, 900000)`.

`checkSecondFactor(staff, input)`:

- TOTP: decrypt, `verify`, then atomic replay guard `staff.updateOne({_id, $or:[{"totp.lastStep":
{$lt: step}}, {"totp.lastStep": null}]}, {$set: {"totp.lastStep": step}})`; no match → 400
  "This code was already used — wait for the next one." `lastStep` is shared by login and
  step-up.
- Backup code: `updateOne({_id, totpBackupCodes: h}, {$pull: {totpBackupCodes: h}})`,
  `matchedCount === 1` (single use under races); audit `totp.backup-code-used`.

`publicStaff` (`auth.js:26-34`) gains `totpEnabled`; `/auth/me` (`auth.js:260`) adds
`backupCodesLeft`, `stepUpUntil`.

QR: server-side SVG via `uqr` (`renderSVG`, MIT, zero deps, exact version pinned) — pending owner
OK (open question 3). Returned once in a `no-store` response (`app.js:55`), shown as
`<img src="data:image/svg+xml;base64,…">` (CSP allows `imgSrc 'self' data:`, `app.js:29`).
Manual key shown in groups of 4.

Lost device: `scripts/recovery.js reset-totp --email=… --maintenance` → `resetTotp()` in new
`backend/lib/recovery-tasks.js`: one transaction `$unset totp, totpPending, totpBackupCodes`,
`$inc authVersion, revision`, `sessions.deleteMany`, audit `totp.reset` (actor system).

Audit actions: `session.stepped-up`, `totp.enabled|replaced|disabled|backup-codes-regenerated|
backup-code-used|reset`; `session.created` detail records the factors used.

## 2. Step-up

- `POST /auth/step-up {code | backupCode}`: `requireAuth` → 428 if TOTP not enabled →
  `checkSecondFactor` → `sessions.updateOne({_id: req.session._id}, {$set: {stepUpUntil:
now+10min}})` → audit → `{stepUpUntil}`.
- `auth.requireStepUp` (next to `permit`, `auth.js:286`): `ensure(req.session.stepUpUntil >
new Date(), 428, "Confirm with your authenticator code.")`. 428 because 401 triggers session
  expiry in `api.js:22`. Bound to the session row (logout/revoke ends it).
- Order: `requireAuth → permit(...) → requireStepUp → handler`.
- Step-up required: account reveal + show-code, delete account, remove account secret, file
  download, file delete, POS reveal, remove POS secret, remove POS block, TOTP backup-code
  regeneration / disable / replace. Not required: secret writes/replacements, upload, restore,
  import (they disclose nothing). Existing `DELETE /connections/:id/credential` unchanged.
- New permission `secrets` in `shared/policy.js:2-7`, owner only. `credentials` (owner, admin)
  covers viewing flags and write-only operations. `deploy` permission arrives in Stage 2.

## 3. Accounts vault (U2) — `backend/modules/accounts.js`, mounted at `/api`

Schemas (append to `shared/schemas.js`): `ACCOUNT_SERVICES` (gmail, vercel, atlas, cloudflare,
godaddy, r2, cloudinary, other); `ACCOUNT_SECRET_FIELDS` (password, totpKey, backupCodes);
`details {service, label text(80).min(1), login text(254), recoveryContact text(254),
notes text(1000)}` `.strict()`; `create` = details + optional secrets; `update` = details + `rev`;
`secret` = discriminated union on `field` (password 1–1024 chars; totpKey 16–512 via
`parseKeyInput`; backupCodes array 1–30 × 4–64 chars). Secrets are never trimmed; refine messages
never echo values.

Entry: `{id, rev, service, label, login, password: box|null, totpKey: box|null, totpParams,
backupCodes: box|null, backupCodesCount, backupCodesUsed: [int], recoveryContact, notes,
importKey?, createdAt, changedAt}`. AAD `account:<customerId>:<accountId>:<field>`. Cap 50 per
customer (filter `"accounts.49": {$exists: false}`).

Concurrency: per-entry `rev` guarded with `$elemMatch {id, rev}` + `$inc "accounts.$.rev"`; the
customer `revision` is NOT bumped (fact 0.7).

| Route                                        | Gate                                                            | Audit                        |
| -------------------------------------------- | --------------------------------------------------------------- | ---------------------------- |
| GET `/customers/:id/accounts`                | credentials                                                     | —                            |
| POST `/customers/:id/accounts`               | credentials                                                     | `account.created`            |
| PUT `/customers/:id/accounts/:aid`           | credentials                                                     | `account.updated`            |
| PUT `…/:aid/secret`                          | credentials                                                     | `account.secret-replaced`    |
| DELETE `…/:aid/secret {rev, field}`          | secrets + step-up                                               | `account.secret-removed`     |
| DELETE `…/:aid {rev}`                        | secrets + step-up                                               | `account.deleted`            |
| POST `…/:aid/reveal {field}`                 | secrets + step-up + `consume("reveal:<staffId>",30,3600000)`    | `account.revealed`           |
| POST `…/:aid/code`                           | secrets + step-up + `consume("totp-code:<staffId>",60,3600000)` | `account.code-shown`         |
| POST `…/:aid/backup-codes/used {rev, index}` | credentials                                                     | `account.backup-code-marked` |

- Every mutation: `transaction` + `authorizeWrite(…, permission)` (`records.js:12-28`) +
  `audit(…, req)`.
- Responses use a whitelist `accountView`: `{id, rev, service, label, login, recoveryContact,
notes, hasPassword, hasTotp, codesTotal, codesLeft, changedAt}` — never spread the entry.
- Reveal/code are POST (Origin + CSRF checks). Decrypt + audit inside the transaction; respond
  only after commit. Reveal → `{value}` or `{codes: [{index, code, used}]}`; code →
  `{code, expiresIn}` (key never revealed). Audit detail = service, label, field name only.
- Replacing backup codes resets `backupCodesUsed`.

## 4. Files in S3 (U2) — `backend/modules/files.js`, `backend/lib/s3.js`

S3 client: hand-written SigV4 (~150 lines, `fetch` + `node:crypto`) instead of
`@aws-sdk/client-s3` (5 operations needed; SDK ≈100 packages, tens of MB RSS). Tested against
AWS's documented SigV4 examples. `createS3({region, bucket, accessKeyId, secretAccessKey, fetch,
now})`:

- `put(key, buf)` → `{versionId}`; signed `x-amz-content-sha256`,
  `x-amz-server-side-encryption: AES256`, `If-None-Match: *`; missing `x-amz-version-id` = error.
- `get(key, versionId, maxBytes)`, `del(key)`, `copy(key, versionId)` → `{versionId}` (parse body:
  CopyObject can return 200 with `<Error>`), `list(prefix, 1)`.
- Virtual-hosted regional endpoint; bucket names with dots rejected. `redirect: "error"`
  (as `ecom.js:16`); timeouts 30 s put/get, 10 s others. Errors → `HttpError(503, "File storage
is unavailable.")` with internal `s3Code` (`NoSuchVersion` → 410); S3 bodies never in messages
  or logs. `createApp(deps)` takes `deps.s3`; `server.js` builds it only when configured.

Config (`backend/config.js`): `FILES_S3_REGION` (default `ap-south-1`), `FILES_S3_BUCKET`,
`FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY`. All empty → files disabled, routes 503
"File storage is not configured" (`ecom.js:9-13` pattern). Partial/invalid → boot fails, names
only (`config.js:33-35,54-73` pattern). `FILES_` prefix so no SDK/CLI picks up ambient
credentials.

Upload `POST /api/customers/:id/files` (credentials):

- `app.js` gate allows `application/octet-stream` only for `POST ^/customers/<uuid>/files$`
  (express.json ignores it → body stays a stream).
- Headers `X-File-Name` (encodeURIComponent), `X-File-Category`; no query strings.
- Checks in order: in-process slot gate (max 2 transfers, else 503; `auth.js:49-64` pattern);
  `consume("file-upload:<staffId>",60,3600000)`; `Content-Length` required (411), 1 B–20 MB (413);
  filename NFC, strip control chars and `/\:*?"<>|`, collapse whitespace, ≤150 chars; extension
  allowlist `pdf png jpg jpeg webp txt csv json zip gz docx xlsx`; category enum `agreement kyc
invoice screenshot db-backup other`.
- Stream `for await` over `req`: SHA-256 of plaintext + AES-256-GCM chunk by chunk; byte counter
  aborts at limit or length mismatch (~40 MB peak per transfer).
- Data key 32 random bytes; object = `"SBF1" | iv(12) | ciphertext | tag(16)`, AAD
  `file:<customerId>:<fileId>`; data key boxed `encrypt(hex, VAULT_KEY, "file:<cid>:<fid>")`.
- Key `files/<cid>/<fid>`; S3 PUT outside the transaction. Transaction: `$pull` entries deleted
  more than 31 days ago, `$push` metadata with filter `"files.299": {$exists: false}` (409 at cap),
  audit `file.uploaded` (detail = category, size, short id — no name). If the transaction fails after
  > S3 succeeded → best-effort `del` (version expires via lifecycle).
- Metadata `{id, name, category, size, sha256, contentType, s3Key, versionId, dataKey, uploadedBy,
uploadedById, uploadedAt, deletedAt: null, deletedBy, restoredAt, purgedAt}`.
- `server.requestTimeout` 15 s → 60 s (`server.js:26`) — pending owner OK (open question 2);
  `headersTimeout` stays 10 s; UI maps 408 to "Upload timed out — try a faster connection or a
  smaller file."

| Route                        | Gate                                                          | Behaviour                                                                                                                                                                                                       | Audit               |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| GET `/customers/:id/files`   | credentials                                                   | whitelist `{id, name, category, size, sha256, uploadedBy, uploadedAt, deletedAt, restorable}`                                                                                                                   | —                   |
| POST `…/files/:fid/download` | secrets + step-up, slot gate, `consume("file-download",60/h)` | refuse deleted (409); GET stored `versionId`; check magic; decrypt fully; verify GCM tag AND SHA-256 before sending any byte; `application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''…` | `file.downloaded`   |
| DELETE `…/files/:fid`        | secrets + step-up                                             | S3 `del` first, then transaction sets `deletedAt` (filter `deletedAt: null`); retry converges                                                                                                                   | `file.deleted`      |
| POST `…/files/:fid/restore`  | credentials                                                   | only ≤29 days after delete; `copy(key, versionId)`, store NEW versionId, clear `deletedAt`; NoSuchVersion → `purgedAt`, 410                                                                                     | `file.restored`     |
| POST `/files/self-test`      | secrets                                                       | put `files/_selftest/<uuid>`, require versionId, get by version, delete, list → `{ok, versioning, listing}`                                                                                                     | `files.self-tested` |

## 5. Installation `pos` block (U2) — `backend/modules/pos.js`

`pos = {rev, slug, subdomain, host, tenantId, rootDomain, deployLock, vercel: {projectId, orgId,
teamId, projectName, token}, mongo: {uri}, cloudflare: {accountId, workerName, workerUrl,
token} | null, image: {store: r2|cloudinary|null, publicBaseUrl, cloudName, r2AccountId, bucket,
keys}, generated: {authSecret, healthStatsToken, realtimePublishSecret}, posAdmin: {username,
password}, build: {nextPublic} (server-derived from image, never client-supplied), deploy:
{current: null, last: null, previous: null}, secretsChangedAt: {}, importedAt, importedBy}`.

`POS_SECRET_FIELDS` (in `shared/schemas.js`): `vercel.token, mongo.uri, cloudflare.token,
image.keys, generated.authSecret, generated.healthStatsToken, generated.realtimePublishSecret,
posAdmin.password`. AAD `pos:<installationId>:<field>`. `image.keys` = JSON string
`{accessKeyId, secretAccessKey}` or `{apiKey, apiSecret}` matching `image.store`.

Validation copied (not imported) from go-live (`F:\lucifer\scripts\go-live\lib.mjs:20-58`):
`SLUG_RE`, `SUBDOMAIN_RE`, `USERNAME_RE`, `MONGO_URI_WITH_DB_RE`, placeholder check
`/<[^<>\s]+>/`; POS admin password follows `isStrongPassword`.

Routes (only for installations whose product slug is `pos`):

| Route                                      | Gate                                    | Behaviour                                                                                                                                             | Audit                 |
| ------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| GET `/installations/:id/pos`               | credentials                             | config + `{secrets: {field: {set, changedAt}}}` + deploy nulls + `rev`; `{pos: null}` if absent                                                       | —                     |
| PUT `/installations/:id/pos {rev, config}` | credentials                             | `rev: 0` creates (filter `pos: {$exists: false}`, null secrets); else `$set` individual dotted config paths (never whole `pos`) with filter `pos.rev` | `pos.configured`      |
| PUT `…/pos/secret {rev, field, value}`     | credentials                             | replace one secret                                                                                                                                    | `pos.secret-replaced` |
| DELETE `…/pos/secret`                      | secrets + step-up                       | remove one secret                                                                                                                                     | `pos.secret-removed`  |
| POST `…/pos/reveal`                        | secrets + step-up + shared reveal limit | reveal one secret                                                                                                                                     | `pos.secret-revealed` |
| DELETE `…/pos {rev}`                       | secrets + step-up                       | undo a wrong import                                                                                                                                   | `pos.removed`         |

- `db.js`: unique partial index `installations {"pos.slug": 1}` (filter `pos.slug` exists);
  `audit_events {resourceId: 1, createdAt: -1}`.
- `records.js`: list projection `{secret: 0, accounts: 0, files: 0, pos: 0}`; `scrub` also deletes
  `accounts`, `files`, `pos`.

## 6. Import (U4) — `backend/modules/pos-import.js` + pure `backend/lib/pos-import.js`

- Body limit: `app.js:66` becomes a selector — `/pos/import/*` uses `express.json({limit:
"128kb"})`, everything else 32 kb.
- The browser parses `deploy.profiles.json` locally and sends ONLY the selected entry
  `{name, entry}` (other clients' tokens never leave the PC). `name` `^[A-Za-z0-9_-]{1,64}$`;
  `entry` `.strict()` `{app, orgId, projectId, scope, tokenEnv, token}`.
- Client schema: top-level `.strict()` with every known key (`_readme, slug, vercel, subdomain,
mongodbUri, admin, cafe, tables, menu, image, contact, accounts, notes, deployLock, demo,
cloudflare, standbyHosts, generated, lastRun`); imported fields validated strictly; dropped
  blocks `z.unknown()`; unknown top-level key = error.
- `POST /pos/import/preview` (secrets) → `{digest = mac(AUTH_SECRET, "pos-import-v1:" +
canonical), mapping (non-secret values), secrets: [{target, present}], accounts: [{service,
label, login, hasPassword}], dropped: [paths], warnings, existing, customerMatches}`. Mongo URI
  shown as host/db only.
- `POST /pos/import/confirm {client, profile, digest, customer: {mode: "existing", customerId} |
{mode: "new", name, email, company, phone}}` (secrets): re-parse, require matching digest; one
  transaction: `authorizeWrite("secrets")`; create customer (`schemas.customers`) or check it
  exists; POS product by slug, not retired; reuse an existing production POS installation without
  a block (unique index `db.js:57-62`) or insert a new `planned` one with `endpoint https://host`;
  set `pos` (encrypt inside the transaction with a pre-generated installationId); `$push`
  accounts skipping existing `importKey`; audit `pos.imported` (+ `record.created` for new
  records) → `{customerId, installationId}`.
- Idempotency: preview reports "already imported", confirm 409; concurrent double confirm hits the
  unique `pos.slug` index (11000 → 409, `app.js:95`). Re-import requires `DELETE …/pos`
  (step-up) first; accounts de-duplicated by `importKey`.

| Source (client file)                                              | Target                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `slug`, `subdomain`                                               | `pos.slug`, `pos.subdomain`                                            |
| `generated.host/tenantId/rootDomain`                              | `pos.host/tenantId/rootDomain`; installation `endpoint`                |
| `vercel.token`                                                    | `pos.vercel.token` (warn if the profile token differs)                 |
| `vercel.project` ∥ `generated.projectName` ∥ `slug`               | `pos.vercel.projectName`                                               |
| `generated.projectId/orgId`                                       | `pos.vercel.projectId/orgId`; ERROR if the profile disagrees           |
| `vercel.teamId` ∥ `profile.scope`                                 | `pos.vercel.teamId`                                                    |
| `mongodbUri`                                                      | `pos.mongo.uri`                                                        |
| `cloudflare.token/accountId`; `generated.realtime.workerName/url` | `pos.cloudflare.*`                                                     |
| `cloudflare.publishSecret` ∥ `generated.realtime.publishSecret`   | `pos.generated.realtimePublishSecret`                                  |
| `image.*`                                                         | non-secret → `pos.image`; key pair → `image.keys`                      |
| `generated.authSecret/healthStatsToken`                           | `pos.generated.*`                                                      |
| `admin.username/password`                                         | `pos.posAdmin.*`                                                       |
| `accounts.vercel/atlas/images`                                    | account entries (images → `image.store` as service, else `other`)      |
| `accounts.other` (≤4000 chars)                                    | account "Other logins (imported)", text stored ENCRYPTED as `password` |
| `contact.ownerName/phone`; `cafe.name`                            | new-customer defaults; `cafe.name` → company + installation name       |

- `pos.deployLock` is always set `true` on import (no admin deploy until the owner unlocks it in
  Stage 2); the local value is shown as information only (different meaning).
- Dropped and listed in the preview: `notes` (may contain passwords — copy by hand), `cafe.*`
  except name, `tables`, `menu`, `standbyHosts` (Stage 3), `profile.app`, `profile.tokenEnv`
  (warning "token held in env var — enter by hand"), `generated.{seededAt, webAddress,
previousHosting, realtime.sourceHash, …}`, `lastRun`, `demo`, `_readme`.

## 7. Recovery (U5)

- `keyFingerprint(hex)` in `backend/lib/crypto.js` = HMAC-SHA256(key,
  "sandbee-admin-key-fingerprint-v1"), first 16 hex, shown `xxxx-xxxx-xxxx-xxxx`.
- Config: `BACKUP_KEY: z.string().default("")` — never required at boot; bad format reported as
  `invalid` on the page, never fatal.
- `scripts/recovery.js` becomes a dispatcher: BACKUP_KEY resolved only for `backup`/`restore`;
  `--maintenance` required for `backup`, `restore`, `reset-totp`.
- `verify-key --kind=vault|backup --copy=server|password-manager|offline [--from-env]`: key from
  stdin (hidden prompt on TTY; `--key=` rejected). Vault → decrypt the `vault-v1` verifier
  (`backend/lib/vault.js:17-21`); backup → compare fingerprints. Match → insert
  `recovery_checks {type: "key-check", keyKind, copy, fingerprint, result: "match", createdAt}` +
  audit `recovery.key-verified` in one transaction. Exit 0 on match, 1 otherwise. Logic in
  `backend/lib/recovery-tasks.js`.
- `GET /recovery` (`overview.js:131-142`): `rows` = drills only (`type: {$ne: "key-check"}`),
  `keys: {vault: {fingerprint}, backup: {fingerprint | null, state}}`, `keyChecks` (latest per
  kind × copy), `drillStatus` (green ≤100 days, amber ≤190, else red/none). `/overview`
  `latestRecovery` gets the same type filter. No new collection.

## 8. Snapshot

New `backend/lib/secrets.js`: `secretBoxes(collection, row)` yields `[box, aad]` for connections
`secret`; staff `totp.key`, `totpPending.key`; customers `accounts[].{password, totpKey,
backupCodes}`, `files[].dataKey`; installations `pos.<POS_SECRET_FIELDS>` (skip nulls). Replaces
the checks at `snapshot.js:21-22` and `:62-63`. `BACKUP_COLLECTIONS` unchanged. S3 objects are
not in snapshots (their data keys are).

## 9. Audit

`audit(db, session, actor, action, resource, resourceId, detail = "", req)`: adds `ip:
req?.ip ?? null` and `userAgent` (control chars stripped, ≤200) only when `req` is given. U1
passes `req` at existing call sites (`records.js:243,281,335,371`, `team.js:49,95`,
`overview.js:169`, `auth.js:246,275`). `/audit` gains optional `customerId` (customer + up to 50
of its installation ids, `$in`) in U2. AuditPage shows the IP in small text.

## 10. Frontend

- `lib/api.js`: 428 → `error.status`; add `upload(path, file, headers)` (octet-stream) and
  `download(path, body)` (blob); both reuse 401 handling.
- `components/step-up.jsx`: `StepUpHost` mounted once in `main.jsx` (existing `Modal`, code or
  backup code); `withStepUp(fn)` catches 428, awaits the modal, retries once; owner without TOTP
  → link to `/account`.
- `components/reveal.jsx` (`RevealValue`): value only in local state; cleared after 30 s, on
  unmount and on `pagehide`; copy via `navigator.clipboard` with a "clipboard is not cleared"
  note; never in URLs/localStorage.
- `pages/login.jsx`: `totpRequired` → "Authenticator code" step + "Use a backup code" toggle →
  `/auth/verify-totp`.
- `pages/account-security.jsx` (`/account`): status, enrol (QR `<img>`, manual key, confirm),
  one-time backup codes with "I saved these" checkbox, regenerate, disable (non-owner).
- `pages/customer-workspace.jsx` (mirrors `product-workspace.jsx:27-86`, reuses `.product-rail`):
  Summary (`RecordEditor`), Installations, Accounts (list, create/edit, secret modals, reveal,
  show code, delete in `danger-zone`), Files (client-side size/extension checks, table, download,
  delete, restore, owner "Test storage"), Activity (`/audit?customerId`).
- `pages/installation-workspace.jsx`: default = `RecordEditor` + "Setup steps" (`checksFor()`
  Done/Pending badges); "POS setup" (POS product only): config form, secret rows (set/not set,
  Replace, Remove, Reveal), placeholder "Deploys: Stage 2". Existing Playwright headings keep
  working.
- Routing `main.jsx:90-122`: `customers/:id/:section`, `installations/:id/:section`, `account`,
  `pos-import`; owner-without-TOTP `.notice` banner. Nav `shell.jsx:23-50`: "Account security"
  (all roles), "POS import" (`can(role, "secrets")`). `governance.jsx`: Team security link, audit
  IP column.
- Styles: additions only in `styles/components.css` using tokens (`.secret-value`, `.qr-box`,
  `.backup-codes`).

## 11. Test matrix

Helpers: `test/helpers.js` (start app, request, login, `assertNoSecrets(json, plaintexts)` —
fails on any plaintext, any box signature `"iv":`/`"tag":`/`"data":`, or keys `password`,
`totpKey`, `dataKey`, `token`, `uri` with object values); `test/fake-s3.js` (in-memory versions,
delete markers, failure injection).

- `test/stage1-auth.test.js` (U1): RFC 6238 Appendix B SHA1 vectors; ±1 window ok, ±2 rejected;
  replay (same code twice fails; concurrent step-ups → 200 + 400); backup code single use incl.
  concurrent race; enrol rejected for sessions >15 min old; wrong confirm code; pending expiry;
  TOTP login returns no cookie until `/verify-totp`; recovery with TOTP leaves the password
  unchanged until TOTP passes; `/verify` rejects a TOTP challenge id; expired step-up → 428;
  owner without TOTP → 428, viewer → 403; owner cannot disable; `resetTotp` revokes sessions;
  audit rows have ip/userAgent; all existing tests still pass.
- `test/stage1-vault.test.js` (U2): role matrix 401/403 per route; accounts CRUD; `rev` 409;
  reveal audited; 31st reveal → 429; show-code equals `codeAt`; generic customer/installation PUT
  leaves `accounts/files/pos` byte-identical; deep secret scan over every GET/PUT response,
  `/overview`, `/audit`, `/options/*`, `/team`, `/auth/me`; AAD swap between records fails.
  Files: upload happy path; 413/411/415; bad extension; client abort mid-body → no object, no
  entry; S3 put fails → 503, no entry; transaction fails → orphan deleted; missing versionId →
  error; tampered ciphertext → download fails before any byte; delete → restore → purged 410;
  cap 300; third concurrent transfer → 503. POS: wrong product 400; config PUT keeps boxes;
  unique slug. Snapshot roundtrip with every new box type; wrong vault key fails `parseSnapshot`.
- `test/s3.test.js`: SigV4 vectors, versionId encoding, CopyObject 200-with-`<Error>`.
- `test/stage1-import.test.js` (U4): synthetic fixture `test/fixtures/pos-client.json`; malformed
  JSON; unknown key; placeholders; projectId mismatch; digest mismatch 400; new vs existing
  customer; email conflict 409; re-import 409; parallel confirms 201 + 409; no duplicate
  accounts; preview/confirm pass `assertNoSecrets`; `accounts.other` stored encrypted.
- `test/stage1-recovery.test.js` (U5): fingerprint stable/distinct; vault verify match/mismatch;
  key-check rows excluded from drills and `latestRecovery`; `drillStatus` thresholds; malformed
  BACKUP_KEY never crashes config.
- Playwright (new spec files; `admin.spec.js` untouched): `test/ui-server.js` seeds
  `security-owner@example.test` and injects fake S3. `security.spec.js` (enrol via manual key +
  `backend/lib/totp.js`, backup codes, logout/login with TOTP, axe on `/account`);
  `client-record.spec.js` (account create, reveal via step-up modal, auto-hide after
  `page.clock.fastForward(31000)`, upload `setInputFiles`, download `waitForEvent("download")`,
  axe + overflow at 320/390/768/1440); `import.spec.js`; `recovery.spec.js`.

## 12. Work units

Order: U1 → (U2 ∥ U3) → (U4 ∥ U5). File scopes are disjoint within each parallel pair. Each unit
verifies with `npm test`, `npm run build`, `npm run test:ui` (check `package.json` for exact names).

1. U1 Security base (first, sequential): `backend/lib/{totp,qr,recovery-tasks,secrets}.js`
   (secrets.js with staff + connection locations), `backend/lib/{audit,snapshot}.js`,
   `backend/modules/{auth,records,team,overview}.js` (audit `req` only), `shared/policy.js`,
   `package.json`/`package-lock.json` (`uqr`), `scripts/recovery.js` (dispatcher + `reset-totp`),
   `frontend/src/{lib/api.js, components/step-up.jsx, components/shell.jsx, pages/login.jsx,
pages/account-security.jsx, pages/governance.jsx, main.jsx}`, `test/{helpers.js,
stage1-auth.test.js, ui-server.js, ui/security.spec.js}`, `docs/SECURITY.md` identity section,
   `docs/API.md` auth rows.
2. U2 Client record backend: `backend/{config.js, server.js, app.js (upload gate), db.js}`,
   `backend/lib/{s3,secrets,snapshot}.js`, `backend/modules/{accounts,files,pos,records
(scrub/projection),overview (/audit filter)}.js`, `shared/schemas.js`, `test/{fake-s3.js,
s3.test.js, stage1-vault.test.js}`, API.md vault rows, SECURITY.md secrets/files,
   DEPLOYMENT.md S3 + Caddy steps.
3. U3 Client record frontend (parallel with U2 against §3–5 contracts):
   `frontend/src/pages/{customer-workspace,installation-workspace}.jsx`,
   `frontend/src/components/reveal.jsx`, `styles/components.css`, `main.jsx` routes, `api.js`
   upload/download, `test/ui/client-record.spec.js`, `ui-server.js` fake S3. Final verification
   needs U2.
4. U4 Import: `backend/app.js` (128 kb selector), `backend/lib/pos-import.js`,
   `backend/modules/pos-import.js` (mounted in `app.js`), `shared/schemas.js` (import schemas),
   `frontend/src/pages/pos-import.jsx`, `main.jsx`/`shell.jsx`/`record-list.jsx` (import link),
   `test/{stage1-import.test.js, fixtures/pos-client.json, ui/import.spec.js}`, API.md rows.
5. U5 Recovery + release: `backend/config.js` (`BACKUP_KEY`), `backend/lib/{crypto,
recovery-tasks}.js`, `backend/modules/overview.js` (recovery), `scripts/recovery.js`
   (`verify-key`), `frontend/src/pages/governance.jsx` (RecoveryPage),
   `test/{stage1-recovery.test.js, ui/recovery.spec.js}`, DEPLOYMENT.md recovery section,
   SECURITY.md keys line, `docs/VALIDATION.md`. Release: after U4, `powershell -File
scripts/package-handoff.ps1 -OutputName sandbee-admin-source-2026-10-XX.zip` and copy
   `sandbee-admin/HANDOFF-MANIFEST.json` from the zip to the repo root.

## 13. Docs and live deployment

Docs: API.md (every new route + gate); SECURITY.md (TOTP, step-up, 428, reveal limits, S3 design,
S3 content not in snapshots, rollback re-exposes boxes and drops TOTP); DEPLOYMENT.md (env vars,
Caddy, verify-key, reset-totp; fix the nginx mention — production uses Caddy).

Server steps:

> **Superseded by D18 / docs/DEPLOYMENT.md:** the server keeps one image `sandbee-admin:local`; never export `RELEASE_TAG`. The text below is historical.

1. Owner takes a `mongodump` of `sandbee_admin` to the PC (D13).
2. `~/admin/.env`: all four `FILES_S3_*` vars (or none); `BACKUP_KEY` if missing.
3. `/opt/edge/Caddyfile`: no `request_body max_size` below 21 MB and no proxy timeout below 60 s
   for admin.sandbee.in.
4. `cd ~/admin && export RELEASE_TAG=2026-10-XX-stage1 && docker compose -f
compose.production.yaml build app && docker compose -f compose.production.yaml up -d --no-build`.
5. `/ready`; log in; enrol at `/account` within 15 minutes; store backup codes offline; log out
   and back in with TOTP.
6. Files "Test storage"; import demo; enter lucifer by hand; reveal one test secret.
7. Verify each key copy: `docker compose -f compose.production.yaml exec app node
scripts/recovery.js verify-key --kind=vault --copy=password-manager` (repeat per copy).
8. Rollback: `export RELEASE_TAG=<previous> && docker compose … up -d --no-build`. Data is additive,
   but old code returns boxes in generic responses and ignores TOTP — roll back only briefly.

## 14. Edge cases and chosen handling

1. Generic routes leak embedded boxes → projection + `scrub` (§5).
2. Recovery bypasses TOTP → parked password hash applied after TOTP (§1).
3. Same TOTP code at login and step-up → shared `lastStep`; UI says "wait for next code".
4. Concurrent use of one backup/TOTP code → atomic `$pull` / conditional `$set`.
5. Revision bumps reset the open editor → per-entry `rev`.
6. 15 s timeout vs 20 MB uploads → 60 s + clear 408 message (pending owner OK).
7. `withTransaction` retries → no S3 calls inside transactions.
8. S3 ok but Mongo fails → orphan deleted + lifecycle; delete order S3 first.
9. Versioning disabled → missing versionId rejected.
10. CopyObject 200 with `<Error>` → body parsed.
11. Lifecycle purge → 410 + `purgedAt`; expired metadata pulled on upload so the 300 cap cannot fill.
12. Overwritten current version → reads always pin `versionId`.
13. Dotted bucket names, clock skew, versionId encoding → rejected / 503 / RFC 3986 encoding.
14. Filename header injection → sanitised, RFC 5987, attachment, octet-stream, `nosniff`.
15. Clipboard / bfcache retention → `pagehide` clear + warning.
16. Profiles file holds other clients' tokens → only the selected entry is sent.
17. Imported `deployLock` meaning differs → forced `true`.
18. Customer email unique (`db.js:50`), installation unique (`db.js:57-62`) → 409 or attach.
19. POS product retired/missing → 409.
20. Imported installations are `planned`; ready/live still need linked connection records
    (`records.js:104-131`) — not auto-created in Stage 1.
21. Mixed recovery row types → type filters.
22. Malformed `BACKUP_KEY` → reported, never fatal.
23. Partial S3 config → fail fast at boot (names only).
24. Audit visible to all roles → no filenames/secrets in `detail`.
25. Rollback window → documented.

## Owner answers (2026-10-09)

1. Lucifer production profile: `lucifer007` (D15).
2. 20 MB files with `requestTimeout` 60 s (D16).
3. `uqr` approved, exact version pinned (D17).
