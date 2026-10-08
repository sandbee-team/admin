# October 2 launch review

32 backend/security tests, 6 browser scenarios, Vite and Linux Docker builds pass. Production npm audit reports zero advisories. Docker /ready responds successfully and unauthenticated customer API access returns 401.

Ecom is optional for this release. Its disconnected view now renders deliberately, its form uses shared panel/form styles, missing expiry dates do not crash the editor, tenant changes reset uncontrolled fields and empty error banners are omitted. A regression test checks authentication, pagination validation and subscription mutation restrictions. Ecom is included in responsive/accessibility browser coverage.

Actual Ecom subscription activation depends on its separately deployed service and matching server-only key. Leave bridge variables blank until ready. No production deployment or real Gmail delivery was performed. See DEPLOYMENT.md and the three-project release guide for owner bootstrap, backup keys, replica-set Mongo and acceptance.
