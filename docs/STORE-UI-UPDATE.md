# Store-aligned Admin update — 28 September 2026

Sandbee Admin uses the existing Store's visual language while remaining a separate internal application. The reference project was read only. No customer-facing service or production database was changed.

## Interface

- White canvas, gray surfaces, blue actions/selection, original Sandbee bee mark and favicon.
- Self-hosted IBM Plex Sans and Mono. Compact 13px body, 12px navigation, 20px page headings and 24px metrics.
- Collapsible 184px navigation (56px collapsed), mobile drawer and contextual product navigation.
- Dashboard shows actual registry counts, lifecycle distribution, overdue work and recent audit events.
- Category-grouped product catalog with search, status and delivery-model filters. Every product has Overview, Installations and Settings.
- Shared Radix dropdowns support keyboard selection, clearing optional values and rendering inside dialogs. Login and recovery use the same design system.
- Responsive forms, contained table scrolling, visible focus, semantic status colors and reduced-motion support.

Reusable controls live in `frontend/src/components/`; styles are split by responsibility under `frontend/src/styles/`. `tokens.css` is the central palette and typography source. Product icons fall back to delivery-model icons for new catalog entries.

## Multi-product policy

`shared/product-models.js` supplies the backend validation and frontend labels/checklists. The catalog is data driven; adding a product in an existing delivery model does not require another frontend page.

| Delivery model | Preparation | Additional live requirements | Required providers |
|---|---|---|---|
| Hosted API | Ownership, configuration | Verification, handover, evidence and endpoint | Per product |
| Installed package | Ownership, source/version, configuration | Verification, handover and evidence; public endpoint optional | Per product |
| Prepaid service | Ownership, configuration | Verification, handover, evidence and endpoint | Per product |
| Customer deployment | Ownership, source/release, configuration, backup | Verification, handover, evidence and endpoint | Per product; customer-owned accounts |
| SaaS application | Ownership, configuration | Verification, handover, evidence and endpoint | Per product |

Existing POS records retain their Vercel, MongoDB and Cloudflare requirements. A different deployment can require AWS or another supported provider without inheriting POS requirements. Optional provider records still belong to the installation's customer. Revoked connections cannot satisfy readiness.

Product identifiers cannot change after creation. Delivery model and provider policy changes are rejected while any non-retired installations exist. Transactional product writes serialize installation creation against policy changes. Installation customer, product and environment remain immutable. The installation list supports an indexed product filter.

Changing the selected product on a new installation clears its previous checklist and provider links. Product settings refresh the contextual summary after saving. Roles and server-side authorization remain Owner, Admin, Operations and Read-only.

## Validation

- Backend: 31 tests passed against isolated MongoDB replica sets, including all five delivery models, an AWS-only deployment, filtering and policy-change restrictions.
- Production build passed: approximately 384 KB JavaScript / 120 KB gzip; 32 KB CSS / 7 KB gzip. Fonts are self-hosted.
- Browser: five suites cover authentication, operational CRUD, read-only permissions, product creation/filtering, product-specific forms and settings refresh.
- Responsive checks cover 12 console routes and all three product sections at 320, 390, 768 and 1440px. Axe checks cover login, console routes and product overview.
- Local Docker smoke covers real Mailpit OTP, sign-in, product catalog and sign-out. Detailed evidence and screenshots are in ignored `test-results/`.

## Deployment and scope

Use the existing [deployment runbook](DEPLOYMENT.md) for `admin.sandbee.in`. Existing local records are retained; no destructive migration is required. The source handoff excludes `.env`, owner credentials, database contents, backups and dependencies; its manifest verifies every included file.

These delivery models manage operational records and readiness. Payment settlement, customer provisioning, license enforcement and cloud deployment execution require their product adapters in a later integration phase. This update does not claim unlimited capacity or eliminate the need for production configuration and backup recovery testing.
