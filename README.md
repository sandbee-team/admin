# Sandbee Admin

Launch review: [28 September 2026 deployment evidence](docs/LAUNCH-REVIEW-2026-09-28.md).


Internal multi-product operations console for **admin.sandbee.in**. Independent React + Node.js project with MongoDB, Docker and customer-owned deployment records. Existing Store, website, GST, OCR and POS projects are unchanged.

## Start here

- [Readable research and plan](docs/review.html)
- [Implementation plan](docs/PLAN.md)
- [Research with primary sources](docs/RESEARCH.md)
- [Deployment and recovery runbook](docs/DEPLOYMENT.md)
- [Security boundaries](docs/SECURITY.md)
- [Current reference design and validation](docs/REFERENCE-DESIGN.md)
- [Multi-product workflows and previous UI validation](docs/STORE-UI-UPDATE.md)
- [Initial release validation](docs/VALIDATION.md)
- [Internal API contract](docs/API.md)

## Run locally

Node 22+ and Docker Desktop (Linux containers) are required.

```sh
npm ci
npm run setup
docker compose up -d mongo mailpit
npm run bootstrap
npm run build
npm start
```

Open **http://localhost:8098**. Initial owner email/password are written to **.local/owner-access.txt**; they are never hardcoded or printed. Login also requires the email OTP from **http://localhost:8031** (local Mailpit). Use password recovery after initial access to choose your own passphrase. The seeded catalog contains the four real product offerings; no sample customers or fake activity are added.

To run the complete container stack after bootstrap: stop the locally started Node server and run `docker compose up -d --build`. Use the same URL. Local Mongo is an isolated single-member replica set on loopback port 27028; local SMTP uses 1031. This does not change any existing Store Docker services.

Frontend development: set `APP_URL=http://localhost:5198` in local `.env`, run `npm start` and `npm run dev`, then use port 5198. Restore APP_URL to 8098 before using the production build locally. Exact-origin checks intentionally reject mismatched origins.

## What works

- Internal staff only: password + email OTP, one-use expiring codes, recovery/setup, sessions, role changes and revocation.
- Customer registry and category-grouped product catalog with delivery-model filters. Each product has Overview, Installations and Settings.
- Five delivery models with shared frontend/backend policy: hosted API, installed package, prepaid service, customer deployment and SaaS. Required providers are configured per product.
- Installation records with release/source references, environment, provider links, readiness checklist and verified handover notes.
- Provider account registry with customer ownership, expiry reminders and encrypted write-only credential replacement/removal.
- Work queue, assignments, due dates and priorities.
- Real operational overview, paginated searchable tables, read-only audit history and protected team management.
- Optional Store Mongo **read-only** projection, with no passwords/keys/sessions returned.
- Recovery drill records, encrypted snapshot tools, restore into a distinct empty DB.
- Reference-led sage workspace, compact icon rail and top navigation, pastel workspace brief with Summary/Activity/Products views, actual-data lifecycle report, customer search, contextual product navigation, accessible dropdowns, self-hosted fonts and reduced-motion support.

## Explicit integration boundary

This release records and manages operations. It does **not** run POS deployment scripts, test provider credentials, charge payments, maintain a real-money wallet, provision Store customer accounts or automatically change customer infrastructure. An installation marked live is an operator assertion with required evidence. The next phase maps the provided POS code to a durable deployment worker and per-provider adapters. GST/OCR traffic never passes through this Admin API.

## Structure

```text
backend/
  app.js, server.js, config.js, db.js
  lib/          cryptography, audit, limits, snapshots, vault verification
  modules/      auth, records, team, overview, mail, seeded catalog
frontend/
  public/       Sandbee mark
  src/
    components/ shared controls and responsive shell
    hooks/      abortable data loading
    lib/        API/CSRF, formatting and navigation
    pages/      overview, entity forms/lists, governance and login
    styles/     common tokens, shell, forms, page layouts and motion rules
shared/         strict schemas, roles and lifecycle policy
scripts/        safe local setup, first owner and recovery tools
test/           API/security/recovery and browser integration tests
docs/           plan, research, security, deployment and evidence
```

## Verify

```sh
npm test
npm run build
npm run test:ui
```

Tests use temporary MongoDB replica sets and synthetic staff. Browser tests use installed Microsoft Edge; change `channel` in playwright.config.mjs or install the appropriate browser if needed. They do not send external email or call Vercel/Cloudflare.

Production configuration, off-machine backup scheduling and an actual restore drill are required before putting customer credentials into the live installation. A ZIP of source code alone cannot recover database data or encryption keys.
