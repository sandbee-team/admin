# Deployment, handover and recovery

## Existing EC2: independent service

1. Copy source to a new directory, e.g. `/opt/sandbee-admin`. Existing Store/GST/OCR services remain separate.
2. Run `npm ci` and `npm run setup` locally first, or prepare an `.env` securely on the server. Copy `.env.example`; set unique random VAULT_KEY (64 hexadecimal characters) and AUTH_SECRET (at least 48 random characters).
3. Set `NODE_ENV=production`, `APP_URL=https://admin.sandbee.in`, `MONGODB_URI` to an authenticated replica set/Atlas and a **separate** `MONGODB_DB=sandbee_admin`. Use only that database's required privileges. Transactions are required; a standalone mongod is rejected.
4. Gmail: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=your Gmail address`, `SMTP_PASSWORD=your App Password`, `MAIL_FROM=Sandbee Admin <the same authorized address>`. Keep values out of source control.
5. Bootstrap once from a trusted machine using the same database/environment: `node --env-file=.env scripts/bootstrap.js --email=your-owner-email`. Initial access is saved to `.local/owner-access.txt`. Transfer it privately and remove the temporary file after setting your own password. Re-running bootstrap never resets an existing owner.
6. Start only the production definition: `docker compose -f compose.production.yaml up -d --build`. Do not combine it with development compose.yaml.
7. Point admin.sandbee.in DNS to the existing proxy server and add a separate HTTPS virtual host forwarding to `127.0.0.1:8098`. Set `TRUST_PROXY_HOPS=1` for exactly one trusted reverse proxy; adapt if your topology differs. Forward Host and X-Forwarded-Proto, and correctly replace/sanitize X-Forwarded-For. Do not expose port 8098 or Mongo publicly.
8. Confirm `/ready` returns 200 through the proxy; sign in with password + OTP; check customer create/edit/audit and sign out. No production deployment was performed during this build.

Optional Store bridge: set STORE_MONGODB_URI to a separate read-only credential and STORE_MONGODB_DB to your Store DB. Its privileges must be enforced by Mongo. Leaving it blank shows a disconnected state without breaking Admin.

Optional Ecom bridge: leave ECOM_SERVICE_URL and ECOM_SERVICE_KEY blank for the Store/Admin/website launch. The Ecom section shows a disconnected state. Later, configure the deployed Ecom HTTPS origin and its matching server-only service key (at least 48 characters). Owner/Admin can change subscriptions; Operations/Read-only cannot. Enabling this bridge does not deploy Ecom or enable a payment gateway.

## Example Nginx location within your TLS server

```nginx
location / {
    proxy_pass http://127.0.0.1:8098;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 32k;
    proxy_read_timeout 20s;
}
```

Use your existing certificate issuance/renewal process. Do not copy an HTTP-only example into production. A separate local port keeps the other live applications untouched.

## PC/server loss: what to preserve

- Source archive/repository and lockfile, including each customer's deployed release.
- Encrypted database snapshots stored **off-machine** with retention, or configured provider snapshots/PITR where available.
- `.env` in a secure secret store, especially the original VAULT_KEY and SMTP credentials.
- `.local/backup-key.txt` or BACKUP_KEY in a different protected recovery location from snapshots.
- Customer account recovery access, provider IDs, domain ownership and exact deployment configuration.

Do not keep your only snapshot and only key beside the application on the same PC. The panel can record recovery evidence but cannot prove that an external backup exists or restore customer POS data by itself.

## Small-installation encrypted backup

The bundled export is bounded to 50 MB of source documents. For larger data/audit histories use tested native/provider database backups. This tool is **not** an online consistent backup: stop all API instances to avoid writes while exporting.

```sh
# Stop ALL Admin replicas. Leave Mongo running.
docker compose -f compose.production.yaml stop app
# On a trusted Node machine with secure .env and backup key:
node --env-file=.env scripts/recovery.js backup --maintenance
```

The snapshot excludes sessions, challenges and rate counters. Encryption authenticates the whole snapshot. Keep the original vault key for provider credentials and a separate backup key for the archive. Copy the resulting `.enc` off-server, record its checksum and retention location, then restart Admin. Do not print either key in command logs.

## Restore drill: new empty database only

Set RESTORE_DB in your shell/environment to a **different** empty database such as `sandbee_admin_restore_20260927`. Use the same Mongo cluster or an isolated replica set. Never point a drill at a live Store database.

```sh
# RESTORE_DB must be set in environment, not passed as source MONGODB_DB.
node --env-file=.env scripts/recovery.js restore /secure/path/admin-snapshot.enc --maintenance
```

The script validates format, encryption and every stored credential, rejects nonempty destinations, restores all records transactionally and leaves browser sessions out. It increments restored auth versions. No existing database is dropped or overwritten.

Verify collection counts and owner login against the restored DB. Confirm credential decryption through a controlled server-side test and inspect a customer/installation record. Record source revision, backup location and checks in Recovery. Only then change production MONGODB_DB to the recovered DB and restart. The source deployment's APP_URL/cookie behavior still applies.

## Next POS integration

Provide the current registry schema and deploy script without posting secrets to chat. Review: repository/release source, Vercel team/project mapping, Mongo customer DB boundaries, Cloudflare zones/DNS, environment generation, retry/rollback and handover. Build a separate durable worker with Mongo job leases, idempotency keys, retries with backoff, provider timeouts, step logs and reconciliation. Record deployment IDs and observed outcomes. Do not wrap the old script inside an HTTP route or claim a failed/unknown provider request succeeded.

Wallet/billing integration similarly needs an append-only ledger, verified gateway webhooks, idempotency, reconciliation and refunds before money can move. Product pricing labels in this release do not implement those financial systems.
