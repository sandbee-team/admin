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

## Stage 2 release checklist (deploys from admin)

Stage 2 adds a second container, `worker`, to `compose.production.yaml` (same image, no ports). It executes the deploy jobs the API enqueues: builds through the private pos-builder repository on GitHub Actions, the S3 build cache, prebuilt deploys into the **customer's own** Vercel account with the customer's token, health checks with automatic rollback, verify and purge tasks, and the daily build retention sweep. It decrypts customer tokens, so it runs read-only with one small volume and drops every capability.

1. **Dump first.** `mongodump` of `sandbee_admin` to your PC (see "Recovery"). Stage 2 data is additive (`installations.pos.deploy/task/verify` and the `pos-*` `system_state` rows).
2. **`.env` additions** (server `.env` only, never anywhere else):

   | Variable                   | Meaning                                                                                                                                                |
   | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `POS_GITHUB_SOURCE_TOKEN`  | Fine-grained token: only the lucifer repository, Contents read. Used by the **app** (branch list); compose blanks it for the worker.                   |
   | `POS_GITHUB_BUILDER_TOKEN` | Fine-grained token: only pos-builder, Actions read and write plus Contents read. Used by the **worker**; compose blanks it for the app.                |
   | `POS_GITHUB_SOURCE_REPO`   | Optional, default `KartikDesai07/lucifer`                                                                                                              |
   | `POS_GITHUB_BUILDER_REPO`  | Optional, default `KartikDesai07/pos-builder`                                                                                                          |
   | `POS_BUILD_CACHE`          | Optional `on` or `off`; default `on` when the `FILES_S3_*` variables are set. Off: every deploy builds again and the GitHub artifact is the only copy. |

   Also once: the IAM policy gains `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on `builds/*` and `s3:ListBucket` for the `builds/*` prefix, and the bucket lifecycle rule for `builds/` expires objects after **10 days** (noncurrent versions after 1 day). The worker keeps the live build of every installation by copying it onto itself (copy-forward) when it is older than 5 days, and copies the previous build forward once, when it is replaced; every other build expires. The pos-builder secret `LUCIFER_READ_TOKEN` is a third, separate token.

3. **Build and start both services:** `cd ~/admin && git pull && unset RELEASE_TAG && docker compose -f compose.production.yaml up -d --build`, then `docker image prune -f`. Compose builds the same image twice (the `app` and `worker` entries both have `build: .`; the second build is all cache hits and takes seconds), including the pinned Vercel CLI under `/opt/vercel-cli`, and starts `app` and `worker`. **A malformed `POS_GITHUB_*` token or repository name stops the container from booting** (the error lists variable names only), so run `docker compose -f compose.production.yaml ps` right after `up` and check that both services stay up; fix `.env` and run `up -d` again if one restarts.
4. **Volume check:** `docker volume inspect sandbee-admin_pos-work` must exist, and `docker compose -f compose.production.yaml exec worker sh -c 'touch /work/.w && rm /work/.w && id -un'` must succeed (it prints `root`: the worker runs as root inside the container with only the SETUID, SETGID and KILL capabilities, so that it can start the Vercel CLI as the unprivileged uid 10001; the image creates `/work` owned by `root`, which a fresh named volume inherits). **If a `pos-work` volume was created by an earlier build of this stage (owned by `node`), remove it first:** `docker compose -f compose.production.yaml down worker && docker volume rm sandbee-admin_pos-work`. `docker compose -f compose.production.yaml ps` shows both services healthy (the worker's health check is `node backend/worker.js --health`: its heartbeat file under `/work` is younger than 60 s). Why the CLI runs as another uid: it is third-party code that receives the customer's token, and the worker's own environment (VAULT_KEY, database URI, mail and S3 keys) must not be readable by it; `/proc/<pid>/environ` is readable only by the same uid. Per-job directories: the worker creates `/work/jobs/<id>` (root, 0755), the deploy payload `root/` is root-owned and read-only for the CLI, and only `cli/` (HOME, TMPDIR, XDG_*; mode 1777 so no `chown` is needed) is writable by it; it is deleted with the job.
5. **Self-check** (proves the CLI runs under the read-only root with HOME and XDG on `/work`; prints ok/fail lines only):

   ```sh
   docker compose -f compose.production.yaml exec worker node backend/worker.js --self-check
   docker compose -f compose.production.yaml exec worker node backend/worker.js --self-check --installation=<demo installation id>
   ```

   The installation id is the UUID in the panel URL of the client's installation page (`/installations/<id>/...`). The self-check also runs a probe as the CLI's uid that must be refused (`EACCES`) when reading `/proc/1/environ` and the worker's `/proc/<pid>/environ` (`ok cli-isolation`). The second form decrypts the demo's Vercel token, runs `vercel whoami` with the token only in the child's environment, and proves the token is absent from the child's `/proc/<pid>/cmdline` and from every file under `/work` afterwards.

6. **First demo deploy.** In the panel, for the demo client: Verify, Unlock (owner), then Deploy `main`. The first deploy **builds** (a GitHub Actions run; the output is sealed into S3). Then press **Redeploy**: it must say **cached** and start no GitHub run. While it uploads, sample memory with `docker stats --no-stream` and adjust the worker's `mem_limit` (it starts at 256m).
7. **Kill-and-resume drill.** Start another deploy and, while it is building, `docker compose -f compose.production.yaml kill -s SIGKILL worker`, then `docker compose -f compose.production.yaml up -d worker`. When the 60-second lease runs out the new worker takes the job over, continues the same GitHub run (no second dispatch) and finishes. A kill during the upload finds the deployment through its `sandbeeRequest` meta instead of uploading twice.
8. **Rollback.** Use "Roll back" on the Previous card. On a Hobby Vercel account only the immediately previous deployment can be switched; when Vercel refuses (402) the worker redeploys the previous commit from the build cache.
9. **Release rollback of the whole stage:** `git checkout <previous commit> && docker compose -f compose.production.yaml up -d --build --remove-orphans` (removes the orphaned `worker`). Stage 2 data stays in the database and is ignored by older code. **Before the next release, return to the branch tip:** `git checkout main && git pull`, then the usual `up -d --build`.

Operating notes: the owner's freeze switch stops all deploys (running ones stop before the upload; rollbacks, verify and purge still run). One deploy runs at a time, builds run two at a time, tasks one at a time. `docker compose -f compose.production.yaml logs worker` shows event names, 8-character ids and error codes only: never tokens, URIs or provider text.

### Restoring a client database backup

Download the file from the customer's Files (step-up needed; it comes back already decrypted, as `<slug>-db-<time>.jsonl.gz`). Restore it into a **scratch** MongoDB, never the client's live database:

```sh
RESTORE_MONGODB_URI="mongodb://127.0.0.1:27017" node scripts/pos-db-restore.js --file demo-db-20261010-1200.jsonl.gz --db demo_restore
```

Windows PowerShell (environment variables are set on their own line, not as a prefix):

```powershell
$env:RESTORE_MONGODB_URI = "mongodb://127.0.0.1:27017"
node scripts/pos-db-restore.js --file demo-db-20261010-1200.jsonl.gz --db demo_restore
Remove-Item Env:RESTORE_MONGODB_URI
```

The URI is read from the environment only. The script refuses an Atlas host (unless `--allow-atlas`), refuses a target database that already holds collections (unless `--force`), and verifies the document counts against the backup's trailer. Backups over 20 MB compressed are refused at creation: use `mongodump` locally for those.

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
