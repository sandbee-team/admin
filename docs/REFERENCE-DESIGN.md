# Admin reference design — 28 September 2026

The supplied screenshot is the current visual reference, superseding the earlier Store-matching direction for Admin. The public website and Store are outside this change.

## Reading the reference

The important features are a pale sage canvas, narrow icon rail, outlined pill navigation across the top, generous space between compact cards, light numeric typography, a horizontal multicolour data strip and a tall pastel detail panel. Banking labels and invented credit metrics are not appropriate to Sandbee's operations.

## Adaptation

- Retain the original Sandbee mark and locally served IBM Plex fonts, adding the light weight for report figures.
- Default to the icon rail, preserving an expanded navigation preference and a keyboard-accessible mobile drawer.
- Add top-level navigation pills with clear active states.
- Dashboard uses actual installation counts, lifecycle proportions, active product/customer counts, work queue and audit events from the existing API.
- A closeable workspace brief provides Summary, Activity and Products views. It reopens from the dashboard and preserves role restrictions.
- Customer search opens the existing registry with its query applied. Installation scope selection changes the actual chart denominator, and the label explains it.
- Carry sage surfaces, rounded controls and consistent typography through catalog, forms, product settings, tables and login.
- Preserve backend authorization and multi-product delivery policies. No payment, revenue, health, trend or credit data is fabricated.

## Validation plan

Production build, browser workflow regression, responsive checks at 320/390/768/1440, Axe, reference-oriented screenshots, and a local Docker SMTP login. Check the new search, scope filter, detail tabs, close/reopen controls and collapsed navigation explicitly.

## Verified locally

- Production build and Docker image build passed.
- 31 backend tests passed, including authentication, permissions, rate limits, recovery and all five delivery models.
- Six browser scenarios passed: dashboard interactions, login, end-to-end operations, responsive/accessibility checks, read-only restrictions and product-specific workflows.
- Twelve main routes checked at 320, 390, 768 and 1440 pixels without horizontal page overflow. Axe reported no violations on the tested desktop routes; this is not a full accessibility certification.
- Local Docker login with Mailpit email OTP, product catalog and logout passed with no browser page errors.
- Desktop and mobile captures were visually reviewed. Populated dashboard screenshots use a browser-only synthetic API response; no sample customer or installation records were inserted into the local workspace.

Preview: http://localhost:8098. Screenshots are generated under `test-results/`; the source handoff excludes local credentials, environment files, database volumes and browser artifacts. This update has not been deployed to production.
