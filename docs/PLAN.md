# Sandbee Admin — implementation plan

27 September 2026 · internal console at admin.sandbee.in · separate project

## Objective and boundaries

Manage customers and multiple product delivery models from any authorized computer. Keep customer Store identities separate from privileged staff identities. Preserve customer ownership of POS Vercel, MongoDB and Cloudflare accounts. This release manages records, credentials, readiness, tasks and recovery; it does not execute the existing POS deploy script or charge customers. Those adapters follow after the owner supplies and reviews the current POS code.

## Review findings

- Existing Store: React/Express/MongoDB, users/workspaces/usage_events, hosted GST and local OCR SDK. Workspace membership is customer authorization, not internal staff authorization. Never grant staff by setting a customer role.
- Existing POS directory documentation describes customer runtimes and a separate owner hub. Only its structure/documentation was inspected; local credential profiles and production secrets were not read or imported. A migration must explicitly map its registry, secret format, releases and deployment states.
- Marketing website remains separate. Store continues to own product activation, licensing, keys and operational usage. Admin can optionally read a small allowlisted Store projection with a read-only Mongo account. It must not directly mutate Store documents in this phase.

## Architecture decisions

React + Vite frontend; Node.js 22+ / Express API; MongoDB replica set for atomic record + audit writes; local bounded LRU for non-authoritative summaries; MongoDB atomic rate counters across processes. No Redis. One deployable Docker image, independent Mongo/SMTP services locally. Future provider workers remain outside HTTP requests and outside customer product request paths.

Collections: staff, sessions, challenges, rate_limits, products, customers, installations, connections, tasks, audit_events, recovery_checks. Unique normalized emails/slugs, TTL auth records, indexed status/time/customer references. Product schemas and permission policy are shared. Soft lifecycle transitions instead of destructive deletes. Revision checks reject stale writes. All mutations validate strict schemas.

## Delivery sequence

1. Research + local review + this plan and readable HTML report.
2. Auth: owner bootstrap, password plus email OTP login, recovery/setup, internal roles, session revocation, server-side authorization, CSRF and rate limits.
3. Customer registry, extensible product catalog, installation detail/checklists and provider ownership records; encrypted write-only credential storage.
4. Useful overview, tasks, audit, team access, Store read-only overview and recovery page. No fictional revenue/traffic.
5. Docker, environment example, recovery/backup tools, deployment/runbooks.
6. Integration tests, browser workflows, responsive/accessibility review, build and handoff evidence.

All six steps are implemented for this release. See VALIDATION.md for exact test scope and results. Production rollout and product execution/payment adapters remain separate follow-up phases.

## Accepted roles

Owner: all internal records, staff access, credentials, export. Admin: operational records and credentials; no owner/team escalation. Operations: customer/installations/tasks; provider metadata read, no credentials. Read-only: read operational records. Only Owner changes staff roles/status; bootstrap owner cannot be disabled/demoted by API. Role changes invalidate sessions immediately. No public signup.

## Recovery model

Mongo is not a backup. Recoverability requires a separately stored source archive/repository, database backup, vault encryption key and SMTP/deployment environment. Provide an encrypted application snapshot and restore into a NEW empty database, with a tested drill. This is a small-installation recovery tool with a maintenance/write-freeze requirement, not an online point-in-time backup. Production should add Atlas/provider snapshots, off-server encrypted retention and restore drills. Local exports on the same PC do not solve PC loss.

## Acceptance

- New empty DB boots safely; no public admin enrollment or default password.
- Unauthorized and read-only writes rejected, role revocation immediate, OTP one-use/expiry/attempt limits enforced.
- Customer/product/installation/task data survives restart; stale updates return conflict.
- Credentials encrypted at rest, never returned by list APIs/logged; incorrect keys fail.
- Live installation status requires evidence and readiness checks; no claim that a provider was contacted.
- Every accepted operational change has an audit event in the same transaction.
- Build, integration tests, actual browser workflows and recovery roundtrip pass.
- Mobile layout, labelled fields, keyboard focus, honest empty states and reduced motion.

## Later adapters (explicitly not simulated)

POS registry migration and versioned deployment worker; Vercel/Cloudflare delegated access; automated external backups; Store write APIs; signed service heartbeats; payment gateway and append-only money ledger; Messaging wallet settlement; workforce OIDC/passkeys. Provider deployment permissions and payment actions will be integrated individually with tests and rollout controls.
