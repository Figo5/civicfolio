# Desktop Claude review — reconcile before acceptance

The reviewer inspected the backend during implementation. Verify each issue against current code; these are findings, not guaranteed current defects.

1. app.ts has no Origin/Host/content-type mutation guards. Bodyless POST reset routes can be triggered by cross-origin forms. Add strict localhost Host + allowed exact Origin checks and JSON requirement for mutations; test hostile and valid requests.
2. store.ts demo portfolio cash 100000 does not subtract seeded trades costing 565.50. Seed balances must reconcile with trades.
3. portfolio.ts finite inputs may yield infinite or unsafe notional (qty * price * 100); guard derived arithmetic and practical limits. Sub-cent trades must not mint free positions.
4. Add server-enforced paper-trade idempotency (request ID, conflict on changed payload) and wire client reuse for retries. Import IDs should use UUIDs and duplicate imported records should be detected.
5. importAdapter.ts accepts data_mode live from pasted input. Force imported provenance. Validate primary source URL and disclosure/publication fields.
6. llm.ts inserts imported content in system message. Put data in clearly delimited lower-trust context, minimize sent fields, disclose external processing, validate endpoint transport (HTTPS except explicit loopback), and retain only supported record citations. No model may execute tools/orders.
7. Mutations currently modify cached data before durable save; failed writes can leave memory ahead of disk. Use clone-on-read or explicit transactional update and assign cache after successful atomic rename. Test persistence failures and restarts.
8. Vite proxy ignores configurable server port. Resolve config consistently. Full verification must include server typecheck.
9. CSV multiline quoted fields should parse correctly or be explicitly rejected with a clear error.

Address functional/security issues before final handoff. Avoid unrelated refactoring.
