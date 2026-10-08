# Research and decisions

Reviewed 27 September 2026. Primary vendor/security sources; below are Sandbee design inferences, not claims of feature parity.

| Source | Finding and application |
|---|---|
| [AWS SaaS architecture](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/control-plane-vs.-application-plane.html) | Separate shared operations and tenant applications. Admin records and provisioning must not sit in the POS request path. |
| [Microsoft control planes](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/control-planes) and [approaches](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/control-planes) | Treat management as a product with authorization and lifecycle workflows; future long-running deployment execution needs a durable worker, retries and reconciliation. |
| [Stripe team roles](https://stripe.com/blog/new-roles-and-permissions-in-the-dashboard) | Scope staff access by job. Sandbee uses four internal roles with server-enforced permissions, separate from customer membership. |
| [Vercel REST API](https://vercel.com/docs/rest-api) and [integration permissions](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference) | Persist customer team/project identifiers and explicit ownership. Future adapters use delegated scoped access, not a single personal token shared across every customer. Record releases and observed provider deployment IDs before enabling retries. |
| [Cloudflare account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) and [permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) | Durable account-owned integrations and resource-specific permissions support continuity. Store only required tokens; record customer zone/account IDs and expiry. No global API key collection. |
| [Mongo backup](https://www.mongodb.com/docs/atlas/backup/cloud-backup/overview/) and [tools](https://www.mongodb.com/docs/v8.0/tutorial/backup-and-restore-tools/) | Backup capabilities vary with cluster configuration. Explicitly separate persistent storage, backup, recovery key and tested restore; don't imply a low-tier cluster automatically has backup. |
| [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) | Deny by default, check every request, test authorization. Hidden UI buttons do not secure APIs. |
| [OWASP sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Host-only secure HTTP-only cookies, explicit expiry, rotation, server revocation. Never reuse Store customer sessions for admin. |
| [OWASP secrets](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) | Keep encryption keys outside the DB/backup, minimize disclosure and audit changes. A DB backup without the encryption key cannot recover credentials. |

## Failure scenarios and response

- PC lost: deploy source on another machine, restore off-machine snapshot into a new DB, restore encryption key separately, bootstrap/recover owner and verify counts. A local-only backup is insufficient.
- Provider token revoked: mark connection as requiring attention; future worker must fail closed without retry storms. Metadata today is operator recorded, not a health probe.
- Double click / two operators: unique indexes and optimistic revisions; installation lifecycle changes are conditional and audited.
- DB outage: fail closed; no in-memory authentication fallback. Health readiness checks Mongo.
- Mail outage: login OTP delivery reports generic failure and no session is created. Keep controlled CLI owner recovery available.
- Backup interrupted: authenticated encryption detects partial/corrupt snapshots; restore rejects nonempty destination.
- Staff leaves: disable account, revoke sessions immediately, rotate any credentials they knew. Audit history remains.
- Traffic spike: bounded JSON bodies/pagination/pools, Mongo shared rate limits, bounded process LRU; validate capacity on the real EC2. No unlimited-load guarantee.
- Money mismatch: avoid inventing payment state from deployment state. Wallet/accounting integration is a separate future phase.

## Interface direction

Updated 28 September: match the existing Sandbee Store identity with white/gray surfaces, blue active states, compact navigation and clear table density. See STORE-UI-UPDATE.md for implementation details. IBM Plex Sans/Mono self-hosted. Overview shows real record counts, lifecycle distribution and pending work. Detail forms explain customer ownership. No fabricated live metrics, auto-deploy buttons or promotional dashboards.
