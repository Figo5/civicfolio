# Development records

The historical [handoff](handoff.md), [review findings](review-findings.md),
[review criteria](review-criteria.md) and [finish request](finish-request.md)
are preserved for implementation context. They are not current setup instructions
or permission to run integrations. Use the [project README](../../README.md).

The README screenshot was captured on 2026-09-22 from the production frontend
with Playwright intercepting all API routes. All displayed companies, prices and
screen results are fictional and explicitly labeled. No backend, private store,
broker credentials, market feed or model provider was accessed for the capture.

Validation: 113 unit tests, typecheck, production build and isolated smoke checks
passed. No new brokerage functionality or provider configuration was introduced.
