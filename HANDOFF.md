# Civicfolio — HANDOFF

Date: 2026-09-08. Worker: GLM implementation pass (Astra coordinating).

## Final URL

**http://127.0.0.1:8787** — built frontend + API, bound to 127.0.0.1 only.

The server runs as a background terminal process (session `proc_fe3e2a79b2c7` was used during development; the final review instance was started fresh). Start command:

```bash
cd /Users/giofiore/Documents/Codex/civicfolio && npm start
# → [civicfolio] API server listening on http://127.0.0.1:8787
#   data dir: ~/.civicfolio (or CIVICFOLIO_DATA_DIR)
```

The review store at `~/.civicfolio` currently holds only worker-generated demo data (the bundled synthetic dataset, re-loaded after the cash-reconcile seed fix). No real user-imported records were present, so the store was reseeded with clearly fictional demo data. To wipe: Settings → "Clear all data…".

## Commands and verification results (actual runs)

| Command | Result |
|---|---|
| `npm test` | 32/32 passing (supertest, isolated temp data dir) |
| `npm run typecheck` | clean (server tsc --noEmit + frontend project build config) |
| `npm run build` | clean: tsc -b + vite build → dist/ (~181KB JS, 9.2KB CSS) |
| `npm run smoke` | 32/32 checks passing against an ephemeral isolated server (own temp data dir, random port, cleaned up afterwards) |

Test/smoke coverage added or expanded this round: Origin/Host/content-type mutation guards (hostile + legit), idempotent trade replay + conflict, sub-cent/overflow/notional-cap arithmetic guards, persist-failure rollback, restart persistence, forced-imported provenance, UUID import ids, duplicate import detection, CSV multiline quoted fields, CSV unterminated-quote rejection.

Smoke tests run against **isolated temporary data** by default (`scripts/smoke.mjs` spawns its own server on a random port with `CIVICFOLIO_DATA_DIR` in a temp dir and deletes it afterwards) — they never touch `~/.civicfolio`.

## Implemented features

- **Overview** — portfolio stat + allocation bar (cost basis), tracked ideas and watchlist with add-forms, recent-disclosures table, working navigation everywhere.
- **Disclosures** — feed with filters (ticker, owner, tx type, data mode, amendment, published-date range, free text); detail view with explicit transaction date (range) vs publication date (+ computed lag), amount RANGE, owner/role, amendment-of links, per-record provenance and limitations. 12 bundled synthetic records, owners labeled "(fictional)".
- **Import adapter** — pasted JSON/CSV (5MB / 5000 rows), server-side validation with per-row rejection reasons, UUID record ids, duplicate detection vs store and within batch, source URL validated http(s), `data_mode` forced to `imported` (payloads claiming `live` are overridden).
- **Research chat** — deterministic rule-based engine (explicitly not an LLM): ticker activity, publication-lag stats, portfolio concentration (cost basis), comparisons with uncertainty/counterarguments, abstention on prices/absent data; citations are record IDs with source links where present. Optional LLM mode via server env only.
- **Paper portfolio** — BUY/SELL with user-entered or demo-labeled prices; cash/positions/journal persist; validation rejects overspend/oversell/invalid/sub-cent/overflow/notional-cap; idempotent submission via `client_request_id`.
- **Settings** — provider/config status without secrets; Robinhood explicitly not configured; demo load/clear with typed confirmation.
- **Security** — 127.0.0.1 bind; loopback Host + exact Origin allow-list + JSON content-type required for mutations; no CORS; finite-number validation; 1MB body / 5MB import caps; 413/415/400 error mapping; no secrets to frontend; LLM data isolated as untrusted delimited block with minimized fields.

## Review findings → resolutions

1. **Origin/Host/content-type guards** — DONE. Middleware on mutations: loopback Host regex, exact Origin allow-list (own port + Vite dev), JSON content-type required. Tests: hostile origin 403, rebinding Host 403, form POST 403/415, bodyless POST 415, all four allowed origins 200, GET with any Origin 200. Smoke covers all three rejections.
2. **Demo cash reconcile** — fixed earlier and preserved: seed cash = 100000 − 565.50; test asserts trades sum == invested and cash + invested == 100000; smoke re-checks.
3. **Finite arithmetic** — DONE. Quantity/price caps, overflow-to-infinity notional rejected, notional must round to ≥ $0.01 (sub-cent rejected, no free positions), $100M practical cap. Tests cover each.
4. **Idempotency** — DONE. Server-enforced `client_request_id`: identical replay returns original trade with `duplicate: true` (no double execution), changed payload → 400. Client sends UUID per submission and surfaces duplicate notice. Import ids now UUID-based; duplicate imports detected/skipped. Tests + smoke with real keys.
5. **Import provenance** — DONE. `data_mode` not accepted from input; forced `imported`. URL validated http(s). Publication ≥ transaction enforced. Tests: sneaky `data_mode:"live"` lands as `imported`.
6. **LLM lower-trust context** — DONE. Data moved from system message into a user-turn `<untrusted_local_data>` block with escaping; minimized projection (disclosures only — ideas/watchlist/trades/portfolio never sent); system prompt forbids executing tools/orders and states external-processing disclosure; HTTPS-only except explicit loopback; citations filtered to record IDs present in the sent context.
7. **Atomic persistence** — DONE. `store.update()` clones state, mutates the clone, writes tmp+rename durably, and only then swaps the cache; failed writes leave memory == disk. `save()` writes first, caches second. Tests: simulated persist failure rolls back; restart reload from disk.
8. **Vite port drift** — DONE. `vite.config.ts` resolves `CIVICFOLIO_PORT` the same way as the server. `npm run typecheck` covers server+frontend.
9. **CSV multiline** — DONE. Full RFC4180-style quoted-field parser (newlines inside quotes); unterminated quote → clear 400 error. Tests for both.

## Data sources & configuration

- Demo dataset: bundled, synthetic, fictional owners (`server/src/seedData.ts`), documented in README.
- Real data: user import only (schema in README). House disclosures search noted with statutory-use restrictions (https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch) — no live connector shipped.
- LLM: OpenAI-compatible env config (`.env.example` documents); disabled by default.
- Robinhood: not configured; official Agentic MCP path documented as future connector (https://robinhood.com/us/en/support/articles/agentic-trading-overview/).

## Remaining gaps / notes for coordinator

- **Robinhood:** not configured, honestly labeled. Official Agentic MCP would need OAuth + eligibility verified with user approval before any "connected" state is shown. No scraping/fake states implemented.
- **Live disclosures:** no public endpoint verified for terms; import adapter is the data path. `data_mode: 'live'` is reserved.
- **Review store:** seeded with synthetic demo data only (worker-generated). If a real import lands later, do not run demo reset — it replaces the whole store.
- Chat history is append-only; clears only via demo reset/clear.
- No CI configuration in-repo (tests/typecheck/build/smoke run locally); coordinator reviews publication separately.
- Security scope is single-user localhost: no auth (fine on 127.0.0.1), JSON file store, no rate limiting beyond body caps.

## Not done (per instructions)

- No git commit/push (repo still untracked; coordinator handles publication).
- No external deployment, no purchases, no credential discovery, no fees.

## Takeover pass (Claude, 2026-09-08)

Independent re-verification, then one defect fixed.

**Verified from a clean run:** `npm test` 32/32, `npm run typecheck` clean, `npm run build` clean, `npm run smoke` all checks passing. The earlier DNS-rebinding finding is genuinely closed — the loopback Host check now runs above the mutation gate in `server/src/app.ts`, so it covers read routes too.

**Fixed — DELETE was unreachable from the UI (latent 415):** `src/api.ts` `del()` sent no `Content-Type`, but the mutation guard requires `application/json` on every non-GET method. Every idea/watchlist deletion would have returned 415. It stayed hidden because `Overview.tsx` had dead-coded both handlers (`void removeIdea; void removeWatch;`) and the backend test helper hardcodes the header on DELETE — so the server suite passed while the real client was broken. Added the header, removed the dead code, and wired Remove buttons into both lists. Confirmed against the running server: DELETE without the header → 415, with it → 404 on a nonexistent id.

This also closes the "DELETE endpoints have no UI" gap listed above.

**Still open:** no git commit (repo has zero commits, everything untracked); chat history clears only via demo reset; no CI. Robinhood and live disclosures remain intentionally unconfigured.

## Session 2 (Claude, 2026-09-08) — real data, marks, always-on

**Mark prices.** Positions now take a price you type in, and the app derives
market value and unrealized gain/loss from it. Unmarked positions stay `null`
rather than defaulting to cost basis, so nothing implies a value you did not
set. `POST /api/portfolio/marks`; `null` clears. Never a quote — no market data
source exists in this app.

**Reset backups.** `demo/load` and `demo/clear` copy the store aside first
(`~/.civicfolio/backup-<ts>-<reason>.json`, 10 most recent kept). Best-effort:
a backup failure never blocks the reset.

**Real disclosure data.** `scripts/fetch-disclosures.mjs` pulls congressional
trades and converts them to the import schema, optionally posting through the
normal validated endpoint. 74 real records are loaded; the demo dataset was
cleared (backup written first). Provenance: lambdafin.com parses House Clerk
PTRs, and every row keeps `ptrLink` — the official House PDF — as `source_url`,
surfaced as a clickable link in the record detail view.

Rows that cannot be represented honestly are skipped, never guessed: no ticker,
unclassifiable type, or a truncated amount range like `"$100,001 -"`. A 90-day
pull gave 75 importable of 100; the server's dedupe then caught 1 duplicate.

**Why not the official bulk file:** `2025FD.zip` is a filing index only (2,918
rows, 515 PTRs) with no tickers or amounts. 8 of 8 sampled PTR PDFs had zero
extractable text — they are scans. Ticker-level data from the primary source
would require OCR. The site's statutory use notice is quoted in the README.

**Always-on.** `~/Library/LaunchAgents/local.civicfolio.plist` starts the server
at login with `KeepAlive`. Verified: killed the process, it came back in ~5s
with data intact.

**Verification:** 34/34 tests, typecheck, build, and smoke all pass. Pushed to
the private repo github.com/Figo5/civicfolio.

**Gaps:** Hermes could not be used for implementation this session — it is
pinned to `gpt-5.6-luna` through a Codex subscription that returns HTTP 429
(usage limit reached), with no fallback API keys configured. The upstream trade
API caps responses at 100 rows regardless of `--days`, so historical backfill
beyond that needs pagination or a different source. Senate filings are not
covered by the current feed. Chat history still clears only via reset.
