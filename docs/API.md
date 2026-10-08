# Internal Admin API

This same-origin API is for the internal console, not customer integrations. All routes are under `/api`. Successful responses are JSON. Errors are `{error, requestId}`. Never authenticate Admin with a Store/customer API key.

Browser mutation requirements: exact APP_URL Origin, application/json, HTTP-only session cookie and X-CSRF-Token from `/auth/me` or `/auth/verify`. Login/recovery/OTP verification have no session yet and require Origin/JSON plus strict rate limiting.

| Route | Purpose | Permission |
|---|---|---|
| POST /auth/login | Password check, send email OTP, return challengeId | Public entry, staff only |
| POST /auth/recover | Request setup/reset code for an approved staff email | Generic response |
| POST /auth/verify | Consume OTP; set password for recovery; create session | One-use valid challenge |
| GET /auth/me | Current staff identity and CSRF | Staff session |
| POST /auth/logout | End current session | Staff session |
| POST /auth/revoke-sessions | Revoke all own sessions | Staff session |
| GET /overview | Real record counts, queue, lifecycle and recent activity | Read |
| GET /{kind} | Paginated customer/product/installation/connection/task list | Read |
| GET /{kind}/:id | Redacted record detail | Read |
| POST /{kind} | Create record | Operate / catalog / credentials |
| PUT /{kind}/:id | Full schema update plus expected revision | Operate / catalog / credentials |
| PUT /connections/:id/credential | Encrypt/replace secret plus expected revision | Credentials |
| DELETE /connections/:id/credential | Remove stored copy plus expected revision | Credentials |
| GET /options/:kind | Search bounded relationship options | Read |
| GET /team | Redacted staff directory | Read |
| POST /team | Authorize invited email, name and role | Owner |
| PATCH /team/:id | Role/status change; revoke sessions | Owner; excludes owner record |
| GET /audit | Read-only paginated events | Read |
| GET /store | Optional read-only platform projection | Read |
| GET, POST /recovery | Read/add restore drill evidence | Owner |

List parameters: page (1–10000, 30 records/page), search (max 100 chars), status, customerId, productId (installation filter), model (product delivery-model filter). Sort is updatedAt then ID descending. Option lists cap at 100 and accept search/customerId. No unbounded export route exists. Search regex is escaped and timed; high-volume text search should move to an indexed search strategy if customer registry size demands it.

The shared `schemas.js` is the source of truth for payloads. Unknown body properties are rejected. Unique identity conflicts and stale revisions return 409. Wrong permissions return 403; invalid/expired sessions 401; validation 400; limits 429; database/mail outages 503 or a sanitized 500. Request IDs support incident correlation without logging payload secrets.

Allowed installation transitions: planned → ready/retired; ready → planned/live/retired; live → paused/retired; paused → live/retired. Retired is terminal. New installations always start planned. Ready/live states validate the product-specific preparation checklist, required providers and source/version where required. Live requires every check for that delivery model and verification evidence; hosted models additionally require an endpoint. Local packages do not require a public endpoint. Product identifiers are immutable, and delivery model/provider requirements cannot change while non-retired installations exist. See STORE-UI-UPDATE.md for the model matrix. This is not an execution state machine for automated deployment.
