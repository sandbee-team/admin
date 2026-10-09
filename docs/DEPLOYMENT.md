# Deployment, handover and recovery

## Existing EC2: independent service

1. The server checkout is `~/admin` (a git clone of github.com/sandbee-team/admin). Existing Store/GST/OCR services remain separate.
2. Run `npm ci` and `npm run setup` locally first, or prepare an `.env` securely on the server. Copy `.env.example`; set unique random VAULT_KEY (64 hexadecimal characters) and AUTH_SECRET (at least 48 random characters).
3. Set `NODE_ENV=production`, `APP_URL=https://admin.sandbee.in`, `MONGODB_URI` to an authenticated replica set/Atlas and a **separate** `MONGODB_DB=sandbee_admin`. Use only that database's required privileges. Transactions are required; a standalone mongod is rejected.
4. Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=your Gmail address`, `SMTP_PASSWORD=your App Password`, `MAIL_FROM=Sandbee Admin <the same authorized address>`. Keep values out of source control.
5. Bootstrap once from a trusted machine using the same database/environment: `node --env-file=.env scripts/bootstrap.js --email=your-owner-email`. Initial access is saved to `.local/owner-access.txt`. Transfer it privately and remove the temporary file after setting your own password. Re-running bootstrap never resets an existing owner.
6. Build and start only the production definition (the app container is read-only with a tmpfs `/tmp`, published on `127.0.0.1:8098`; `.env` is passed in through `env_file`):

   ```sh
   cd ~/admin && unset RELEASE_TAG && docker compose -f compose.production.yaml up -d --build
   ```

   The server keeps a single image, `sandbee-admin:local`; each release rebuilds and replaces it (owner decision 2026-10-09, no per-release tags). Do not combine it with development compose.yaml. On the server always pass `-f compose.production.yaml`: the development file is a separate project (`sandbee-admin-dev`). **Upgrade**: `git pull`, then the same command, then `docker image prune -f`. **Rollback**: there is no previous image, so check out the previous commit and rebuild (`cd ~/admin && unset RELEASE_TAG && git checkout <previous commit> && docker compose -f compose.production.yaml up -d --build`), then return to `main` once fixed. A rebuild takes a few minutes.

7. Point admin.sandbee.in DNS to the existing proxy server and add a separate HTTPS site block in `/opt/edge/Caddyfile` forwarding to `127.0.0.1:8098`. Set `TRUST_PROXY_HOPS=1` for exactly one trusted reverse proxy; adapt if your topology differs. Forward Host and X-Forwarded-Proto, and correctly replace/sanitize X-Forwarded-For. Do not expose port 8098 or Mongo publicly.
8. Confirm `/ready` returns 200 through the proxy; sign in with password + OTP; check customer create/edit/audit and sign out. No production deployment was performed during this build.

Optional Store bridge: set STORE_MONGODB_URI to a separate read-only credential and STORE_MONGODB_DB to your Store DB. Its privileges must be enforced by Mongo. Leaving it blank shows a disconnected state without breaking Admin.

Optional Ecom bridge: leave ECOM_SERVICE_URL and ECOM_SERVICE_KEY blank for the Store/Admin/website launch. The Ecom section shows a disconnected state. Later, configure the deployed Ecom HTTPS origin and its matching server-only service key (at least 48 characters). Owner/Admin can change subscriptions; Operations/Read-only cannot. Enabling this bridge does not deploy Ecom or enable a payment gateway.

## Client files in S3 (optional) and the vault

Client records hold encrypted account logins, authenticator keys, backup codes, POS secrets and files. Files live in your own private S3 bucket; Admin proxies every transfer (no CORS, no presigned URLs) and encrypts each file itself (AES-256-GCM, per-file data key sealed with VAULT_KEY) before upload, so S3 holds ciphertext only.

Environment variables (server `.env` only; the `FILES_S3_` prefix keeps any SDK or CLI from picking them up as ambient credentials):

| Variable                     | Meaning                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `FILES_S3_REGION`            | Bucket region; defaults to `ap-south-1`                                           |
| `FILES_S3_BUCKET`            | Bucket name, lowercase letters, digits and hyphens (names with dots are rejected) |
| `FILES_S3_ACCESS_KEY_ID`     | IAM user access key id                                                            |
| `FILES_S3_SECRET_ACCESS_KEY` | IAM user secret                                                                   |

Leave all four unset to disable files: file routes answer 503 "File storage is not configured." and the rest of Admin works. Setting some but not all (or a malformed value) stops the boot with a message that lists variable names only.

Bucket setup: ACLs disabled, Block Public Access on, **versioning on** (uploads are refused when S3 returns no version id), SSE-S3 default encryption, a policy denying non-TLS requests, and a lifecycle rule that permanently deletes noncurrent versions after 30 days, removes expired delete markers and aborts incomplete multipart uploads after 1 day. The IAM user's inline policy is limited to `files/*`: `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:DeleteObject` and prefix-limited `s3:ListBucket`; do not grant `s3:DeleteObjectVersion` or any bucket/lifecycle/policy change. After deploying, the owner presses "Test storage" (`POST /api/files/self-test`) to confirm put, versioned get, delete and listing work.

Uploads are limited to 20 MB, so the server's `requestTimeout` is 60 s (it was 15 s; `headersTimeout` stays 10 s). `keepAliveTimeout` is 125 s, above Caddy's default upstream idle time (about 2 minutes), so Caddy never reuses a connection Node has just closed (which would surface as sporadic 502s on POST/PUT). **Check the reverse proxy before enabling files.** Production uses Caddy (`/opt/edge/Caddyfile`): the admin.sandbee.in site must not set `request_body { max_size }` below 21 MB and must not set a proxy/transport timeout below 60 s.

**Enrol the owner authenticator first.** Every vault reveal, show-code, file download, delete and POS secret reveal needs step-up, and step-up needs an enrolled authenticator. Right after deploying, sign in as the owner and enrol at Account security within 15 minutes of signing in; until then those actions answer 428 and the account is protected by password and email code only. Take a `mongodump` of `sandbee_admin` to your own computer before the first deploy of this feature: the new data is additive, but older code returns the encrypted boxes in generic responses and ignores the authenticator, so roll back only briefly.

## Stage 1 release checklist

1. **Dump first.** The owner takes a `mongodump` of `sandbee_admin` to the PC (see "Recovery" below) before anything changes.
2. **Files settings.** Add `FILES_S3_REGION`, `FILES_S3_BUCKET`, `FILES_S3_ACCESS_KEY_ID` and `FILES_S3_SECRET_ACCESS_KEY` to `~/admin/.env`: all four or none. Never paste them anywhere else.
3. **Caddy.** In the `admin.sandbee.in` site block of `/opt/edge/Caddyfile`, look for `request_body { max_size ... }` (must be 21MB or more) and any `reverse_proxy` `transport http { ... timeout }` / `response_header_timeout` or similar (must be 60s or more). Caddy's defaults (nothing set) are fine. Reload Caddy only if you changed it.
4. **Build and start:** `cd ~/admin && git pull && unset RELEASE_TAG && docker compose -f compose.production.yaml up -d --build`, then `docker image prune -f`.
5. **Ready check:** `curl -fsS http://127.0.0.1:8098/ready`.
6. **Authenticator now.** The owner signs in and enrols the authenticator at `/account` immediately (reveals and downloads need step-up), stores the ten backup codes offline, then signs out and back in with the authenticator.
7. **Files:** open Files and press "Test storage".
8. **Key copies:** verify each `VAULT_KEY` copy with `verify-key` (see "Verify a key copy"). The Recovery page then shows each copy as verified.
9. **Rollback notes.** The previous release returns encrypted boxes in generic responses and ignores TOTP, so roll back only briefly and rebuild `main` as soon as possible.

Stage 1 went live on 2026-10-09 (commit `8949777`): container healthy, owner authenticator enrolled, demo imported, "Test storage" OK, all three VAULT_KEY copies verified on the server (fingerprint `0797-59de-f1b4-feb5`; the hidden prompt works in a real terminal). The admin-database dump was skipped because the database held no customer data yet.

## Reverse proxy (Caddy)

Production terminates TLS in Caddy (`/opt/edge/Caddyfile`) and proxies to Admin on a separate local port, which keeps the other live applications untouched:

```caddyfile
admin.sandbee.in {
    reverse_proxy 127.0.0.1:8098
}
```

Keep the defaults (no `request_body { max_size }` below 21 MB, no proxy transport timeout below 60 s) while client files are enabled. Use your existing certificate issuance and renewal; Caddy handles it automatically.

## Recovery: what to preserve

If the server is lost, everything is recoverable from three things: a `mongodump` of `sandbee_admin`, the original `VAULT_KEY` and `AUTH_SECRET`, and the S3 bucket. There is no admin-database backup feature; you take the dump by hand.

1. **Keep VAULT_KEY in three copies**: the server `.env`, a password manager, and an offline sealed copy (paper or QR in a safe place). **Never store a copy next to the dumps.** Every saved secret is a vault box; without this key a dump is unreadable, and nobody (including us) can recover it. Also keep `AUTH_SECRET`, SMTP credentials and the rest of `.env` somewhere safe, plus the source/release archive and your customers' provider account access.
2. **Prove each copy is right.** See "Verify a key copy" below. The Recovery page shows when each copy was last verified; re-verify after any key change.
3. **Dump the database by hand** on your own PC:

   ```sh
   mongodump --uri "<sandbee_admin connection URI>" --out <folder>
   ```

   Secrets inside the dump are sealed vault boxes (AES-256-GCM), useless without `VAULT_KEY`. Customer file **content** is not in the dump, only each file's sealed data key. The S3 bucket (versioning on) is the copy of the files.

4. The panel records evidence but cannot prove that a dump exists or restore data by itself.

## Verify a key copy

`verify-key` proves that a copy of the key is correct without ever showing, logging or storing it. The key is read from hidden input or stdin, never from an argument (`--key=` is refused). On a match it records a `recovery_checks` row and the audit event `recovery.key-verified` (kind and copy only); on a mismatch it exits 1, records no check and audits `recovery.key-mismatch`. The Recovery page shows only the key fingerprint (a one-way identifier such as `1a2b-3c4d-5e6f-7a8b`). It does not need `--maintenance` or a stopped API.

```sh
# Run from ~/admin. Server copy: the app container's own VAULT_KEY
docker compose -f compose.production.yaml exec -T app \
  node scripts/recovery.js verify-key --kind=vault --copy=server --from-env

# Password manager / offline copy, interactive (hidden prompt)
docker compose -f compose.production.yaml exec app \
  node scripts/recovery.js verify-key --kind=vault --copy=password-manager

# Same, piping the key (from a file or a password-manager CLI; do not type it into a shell history)
<your password manager command> | docker compose -f compose.production.yaml exec -T app \
  node scripts/recovery.js verify-key --kind=vault --copy=offline
```

`--from-env` is only accepted with `--copy=server`; a key passed as a plain argument or `--key=` is refused. If the app container is stopped, use `run --rm -T app` (or `run --rm app` interactively) instead of `exec`. Copies are `server`, `password-manager` and `offline`. A vault key is checked by decrypting the database's vault verifier. `--kind=backup` compares against a configured `BACKUP_KEY` (environment or `.local/backup-key.txt`), which only the legacy `scripts/recovery.js backup|restore` snapshot tool uses; if none is set it says so, and the Recovery page reads "not used".

## Restore drill: scratch machine

Do this at least every 100 days (the Recovery page turns amber after 100 days and red after 190). Never point a drill at a live database.

1. On a scratch machine start a **single-node replica set** `mongod` (Admin needs transactions): `mongod --replSet rs0 --dbpath <empty folder>` then `rs.initiate()` in `mongosh`.
2. `mongorestore --uri "mongodb://localhost:27017/?replicaSet=rs0" --nsFrom "sandbee_admin.*" --nsTo "sandbee_admin_drill.*" <dump folder>` restores into a new database.
3. Start Admin with the **same `VAULT_KEY` and `AUTH_SECRET`** and `MONGODB_URI`/`MONGODB_DB` pointing at that database. Boot passes only if the key matches the vault verifier.
4. Sign in, open a customer record and reveal one test secret.
5. Record the drill in **Recovery** (location, source revision, what you checked).

## Lost authenticator

No host Node or `.env` needed: the container gets its environment from compose `env_file`. The command requires `--maintenance`, which means the API should be stopped, so from `~/admin`:

```sh
docker compose -f compose.production.yaml stop app
docker compose -f compose.production.yaml run --rm app node scripts/recovery.js reset-totp --email=<owner email> --maintenance
docker compose -f compose.production.yaml start app
```

It clears that member's authenticator, signs them out everywhere and audits `totp.reset`; they sign in with password and email code and enrol again. It does not need `BACKUP_KEY`.

## Legacy encrypted snapshot (optional)

The older `backup`/`restore` commands of `scripts/recovery.js` still exist for small installations (bounded to 50 MB, API stopped, `--maintenance`, a separate `BACKUP_KEY`, restore into a new empty `RESTORE_DB`). The documented recovery path is the manual `mongodump` above.

## Next POS integration

Provide the current registry schema and deploy script without posting secrets to chat. Review: repository/release source, Vercel team/project mapping, Mongo customer DB boundaries, Cloudflare zones/DNS, environment generation, retry/rollback and handover. Build a separate durable worker with Mongo job leases, idempotency keys, retries with backoff, provider timeouts, step logs and reconciliation. Record deployment IDs and observed outcomes. Do not wrap the old script inside an HTTP route or claim a failed/unknown provider request succeeded.

Wallet/billing integration similarly needs an append-only ledger, verified gateway webhooks, idempotency, reconciliation and refunds before money can move. Product pricing labels in this release do not implement those financial systems.
