# Release review evidence

Date: 28 September 2026. Scope: Admin, Store and public website source review, local builds, deployment packaging. No production server access or live mutations.

| Project | Executed checks | Result |
| --- | --- | --- |
| Admin | 31 backend tests; 6 browser scenarios; production build | Passed |
| Store | 26 backend/integration tests; 14 browser scenarios; production build; Docker image | Passed |
| Website | ESLint; design rules; 343 exact-case imports; 186 unit tests in 39 files; TypeScript/Next build | Passed |
| Website browser | Full 117-test suite, including accessibility, responsive layouts, product menu, contact, SEO, internal links | Passed |
| Website Linux Docker | Clean dependency install, production build; 11 public route/asset checks and missing-route 404 | Passed |
| Production dependency audit | npm audit --omit=dev on all three current lockfiles | Zero reported vulnerabilities |

Browser tests include Admin staff restrictions, Store signup/OTP/recovery/team roles, scoped/global tokens, revocation, native Linux OCR sample, reports and developer downloads. Backend tests include CSRF/origin enforcement, Mongo quotas, installation limits, signed lease validation, recovery and product-specific requirements. Tests use synthetic accounts/records; local Store SMTP uses Mailpit. Real Gmail delivery was not tested with owner credentials.

## Deployment improvements made in this review

- Added a Linux production Dockerfile and loopback-only Compose service for the website, while retaining Vercel compatibility. Preserved filesystem content/font/CSS dependencies needed by Next.js routes.
- Added explicit release image tags to production Compose for all three apps, enabling previous-image rollback without rebuilding.
- Added bounded Admin Docker logs/process count and graceful shutdown settings; Store now has init and an 80-second shutdown window consistent with its in-flight shutdown deadline.
- Added a clean website ZIP mode that excludes private agent history/plans while retaining source, tests, lockfiles, assets and deployment documentation.
- Corrected stale website deployment copy: three guides are published, and both Vercel and EC2 are supported.
- Added combined domain/environment/bootstrap/proxy/rollback instructions and a credential-free live health check.

## What was reviewed

Production Compose versus development Compose, Docker build contexts and runtime files, environment validation, secret/signing-key persistence, Admin replica-set requirements, roles/session/CSRF boundaries, API-key/service-key separation, LRU/rate-limit limits, cross-product deployment contracts, public SEO/indexability, product availability claims, source portability and ZIP exclusions.

## Remaining checks on the real host

DNS, certificates, actual proxy topology and sanitized forwarded headers, EC2 memory/disk/security groups, production Mongo credentials and backups, real Gmail OTP receipt, authentic end-to-end GST responses against the matching service, existing-client coexistence, installed customer OCR package/renewal, and restore drill. Public DNS probes are observations from this environment, not proof of global DNS/service availability.

Store/Admin local tests are not proof that a legacy GST or OCR deployment already supports the new central-key protocol. Keep the migration gate in START-HERE.md. No billing-grade ledger/outbox, paid product automation or capacity guarantee is asserted. Website's policies/contact transport remain as described in the launch guide.

Automated accessibility scans are scoped checks, not an accessibility certification. npm audit covers registry advisories available at review time, not a full penetration test. The review did not change dependency versions or claim benchmarked unlimited traffic.
