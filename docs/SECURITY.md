# Security boundaries

## Identity and permissions

Admin staff have their own collection, password hashes, OTP challenges and sessions. There is no public signup. The CLI creates a single initial owner. Owner invitation adds an authorized email; the invited person completes email verification and sets a password through the first-access/recovery screen. Staff records are not Store identities.

Scrypt uses N=32768, r=8, p=1 and per-password random salt. Passwords are 14–128 characters. Login verifies password before email OTP. Six-digit email codes are HMAC-protected, expire after 10 minutes, allow at most five tries and are consumed transactionally. Recovery relies on mailbox control and revokes old sessions. Email OTP is not phishing-resistant authentication; workforce OIDC/passkeys should be added before exposing high-impact automated deployment execution.

Sessions use random 256-bit tokens stored only as hashes, expire in eight hours, and are limited to five per account. Production cookies use __Host-, Secure, HttpOnly and SameSite=Strict. Every browser mutation checks exact Origin, JSON content type and a session CSRF token. Role/status/authVersion are read from Mongo for each request; mutation transactions recheck authorization against the staff record. Owner cannot be demoted/disabled by API. Read-only staff cannot mutate data; Operations cannot alter catalog, credentials or staff.

## Secrets and audit

Provider credentials use AES-256-GCM with a random IV and record-bound authenticated context. VAULT_KEY is required in the server environment, never sent to browsers, and never included in snapshots. Startup verifies the key against a persistent encrypted verifier. Never casually regenerate this key: old credentials would be lost. A coordinated key-rotation migration is future work; credential replacement is available now.

No API returns plaintext or encrypted credential material. Even Admin/Owner can only replace/remove a stored credential. A future provider worker must be a narrow server-side consumer with explicit permissions, redacted logs and allowlisted provider endpoints. Notes/source URLs must not contain secrets. There are no outbound fetches to user-entered URLs, avoiding a generic SSRF proxy.

Accepted operational mutations and audit events share a Mongo transaction. Audit events contain action, actor, record ID, timestamp and a small fixed description; no provider secret, OTP, password, Mongo URI or request body. Application audit is append-only through API, not cryptographically immutable against a DB administrator. Protect and back up DB access separately.

## Availability and load

JSON requests are bounded at 32 KB. Lists are paginated at 30 items; option pickers are capped at 100 with search. Field lengths, lifecycle values, identifiers and extra properties are validated with shared strict schemas. Connection pools are capped; common summary data uses a local LRU with five-second TTL and invalidation on local writes. Authorization never uses this cache. Another replica may show a summary up to five seconds old.

Mongo fixed-window rate counters are shared across replicas. API: 400/IP/minute. Login: 20/IP and 6/email/15 minutes. Recovery: 10/IP and 3/email/15 minutes. Verification: 40/IP/15 minutes, plus five attempts/challenge. A process admits up to eight concurrent authentication requests. Window boundaries can allow short bursts; put an edge/WAF limit in front of the admin origin. TRUST_PROXY_HOPS must exactly match the trusted reverse-proxy topology; never enable arbitrary proxy trust.

No unlimited-traffic or zero-bug guarantee. This is a staff control plane, not an API traffic gateway. Monitor latency, pool wait time, DB capacity, audit growth and 429/5xx rates. Keep an explicit audit retention/export policy as usage grows. All admin write replicas must pause during the small-installation snapshot tool.

## Store bridge

STORE_MONGODB_URI is optional and must use a Mongo read-only account in production. Only counts and recent workspace ID/name/creation date are selected. The connection is never used to mutate Store. Direct reads intentionally do not return sessions, tokens, licenses or password hashes. Schema coupling is documented; replace it with a versioned internal Store API before enabling admin write actions.

## Deployment defaults

Local Compose has unauthenticated Mongo on loopback and a private Docker network only; never deploy this development stack publicly. Production Compose uses your authenticated external Mongo replica set/Atlas, HTTPS reverse proxy, secure SMTP, non-root runtime, read-only filesystem and dropped capabilities. Restrict admin access by network/Cloudflare Access where practical. Update dependencies and test backups regularly.
