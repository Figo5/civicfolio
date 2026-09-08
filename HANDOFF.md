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

## Session 3 (GLM, 2026-09-08) — SEC fundamentals finished

The untracked, half-finished `server/src/fundamentals.ts` from session 2 is now
complete and wired in:

- **Fixed** the compile error (`Property 'facts' does not exist on type 'never'`)
  that was failing `npm run typecheck`; extracted a pure, test-exported
  `buildTickerMap()` helper.
- **API**: `GET /api/fundamentals?ticker=` — as-filed annual figures (revenue,
  net/operating income, assets, liabilities, equity, diluted EPS) from SEC
  EDGAR's official, keyless XBRL `companyfacts` API; 24h per-CIK cache; failures
  are reasons (invalid ticker, fund/ETF with no US-GAAP facts), never figures.
- **UI**: "Company Fundamentals" card on Overview with a ticker lookup, table of
  filed values, and per-result provenance (form, filed date, CIK, EDGAR link).
- **Tests**: +4 (38 total) — map parsing incl. junk, 400 missing ticker, 404
  with reason on invalid/unknown, no fabricated fundamentals object.

**Verification (actual runs this session):** `npm test` 38/38, `npm run
typecheck` clean, `npm run build` clean, `npm run smoke` all checks passed.
Live check of the running server: `GET /api/fundamentals?ticker=AAPL` returned
real FY2025 10-K figures (revenue $416.16B, filed 2025-10-31, CIK 0000320193);
missing/invalid tickers return the documented errors. Server restarted via
launchd with the new build; http://127.0.0.1:8787 serves it.

## Session 4 (GLM, 2026-09-08) — proposals, trends, auto-refresh

Reoriented per owner: the app should *propose* stocks from real disclosure data,
not just abstain. Added:

- **`GET /api/proposals`** — transparent 0–100 heuristic over the 180-day
  published window: distinct buyers × 22, +10 no disclosed sales, +8 recent
  filing (≤14d), +8 large aggregate range, +4 five-plus records. Buy-side only;
  every proposal ships reasons, counterarguments, filer names, and record-id /
  PTR-PDF citations. Non-common-stock instruments (municipal notes, funds —
  e.g. "LA Tax & Revenue Anticipation Notes" filed under GS) are filtered from
  proposals but remain in trends.
- **`GET /api/trends`** — most bought / most sold / largest filed volume / most
  active filers over the same window.
- **Proposals page** (now the landing tab): ranked table with expandable
  reasons/counterarguments, a "Paper trade →" button per row that prefills the
  portfolio BUY form, and the four trend tables.
- **Daily auto-refresh**: `~/Library/LaunchAgents/local.civicfolio.refresh.plist`
  runs `fetch-disclosures.mjs --days 90 --post` at 08:30 daily. Must use 90 days
  — the upstream returns zero rows for shorter windows (verified live) and caps
  at 100 rows regardless. Dedupe makes re-imports idempotent (verified: re-post
  left the 74-record store unchanged).

**Verification:** 40/40 tests (2 added: proposal ranking/filtering, trends
shape), typecheck clean, build clean, smoke passes, live server restarted and
serving the new build (`index-Csv4VfOk.js`, 32 live proposals over real data).

**Honest framing:** the score is a heuristic over thin, delayed, range-only
data — it is not advice, not a probability, and the page says so next to the
data. Upstream still House-only and 100-rows-per-query.

## Session 5 (GLM, 2026-09-08) — simplified to one page, paper trading removed

Owner direction: no fake trading — real suggestions only, one page, take the
idea to Robinhood. Changes:

- **Removed**: Paper Portfolio (form, positions, marks, journal, demo trades),
  Ideas/Watchlist pages, Overview, Settings page, multi-page nav. The
  portfolio/trades/ideas/watchlist API endpoints still exist but nothing in the
  UI uses them; demo seed no longer includes trades. Bundle: 195KB → 155KB.
- **One page** (`src/pages/OnePage.tsx`): Proposals table (now with delayed
  quote + day-change per row, quotes capped at top 12, missing stays "no
  quote"), expandable row → reasons / counterarguments / **SEC EDGAR filed
  financials fetched on expand** / filer names / PTR PDF links. Most
  bought/sold trends. Chat embedded at the bottom (deterministic default).
- **Proposals API now async** and enriches top proposals with quotes from the
  existing quotes module; `total_range_label` precomputed server-side.
- The bundled demo seed (12 synthetic disclosures) is unchanged and still
  loadable via `/api/demo/load` for testing; the live store holds only real
  imported filings.

**Verification:** 40/40 tests, typecheck clean, build clean (155.23KB bundle),
smoke passes, live server restarted serving `index-DfujljZO.js` with 32
proposals — UBER $73.24, AGX $431.98, MELI $1,926.18 quoted (delayed, labeled).

## Session 6 (GLM, 2026-09-08) — black/green/red theme + Ollama research agent

- **Theme**: pure black (`#050505`) with white text, green (`#22c55e`) accents,
  red/green price deltas. All navy/teal removed; score bars now monochrome.
- **Yahoo quotes were already wired** (quotes.ts) — confirmed live on proposals
  (UBER $73.43 etc., delayed/unofficial, labeled on the page).
- **Research agent** (`server/src/ollamaAgent.ts`): bounded tool-loop agent.
  Chat via the LOCAL Ollama daemon (127.0.0.1:11434, signed into Ollama Cloud,
  model `gpt-oss:120b-cloud` — pulled and verified working); falls back to
  https://ollama.com directly when OLLAMA_API_KEY is set. Web search uses
  Ollama's hosted `POST /api/web_search` (requires OLLAMA_API_KEY — the local
  daemon does NOT proxy it, verified 404). Without a key the agent runs and
  says in its risks that it could not verify current web info.
- **`POST /api/research/:ticker`**: 6h cache; attaches proposal + SEC
  fundamentals as delimited untrusted context; verdict JSON (strong_buy/buy/
  hold/avoid/unclear + confidence + reasoning + risks); sources filtered to
  URLs actually returned by search. Server loads `~/.civicfolio/env` (gitignored)
  at startup; env vars win over the file.
- **Live-verified**: UBER research run returned a coherent HOLD (medium
  confidence, 4 reasoning points, 5 risks) citing the real FY figures passed in.

**To enable web search:** create a free key at https://ollama.com/settings/keys,
put `OLLAMA_API_KEY=*** in `~/.civicfolio/env`, restart. Without it the agent
still runs (no search).

**Verification:** 42/42 tests (2 new: research endpoint guards + agent config),
typecheck/build/smoke clean, theme verified by screenshot at 1440px.

## Session 7 (GLM, 2026-09-08) — web search live, theme shipped

- **OLLAMA_API_KEY configured** in `~/.civicfolio/env` (chmod 600, gitignored).
  Direct ollama.com POST endpoints still 401 with this key (verified across
  web_search/chat/auth variants — appears to be an account-side limitation),
  so the working architecture is: **chat via local daemon, search via
  DuckDuckGo Lite fallback** (keyless, bot-walled html endpoint avoided).
- **DDG Lite parser**: protocol-relative `uddg=` redirect links decoded, titles
  + result snippets extracted (5/search). Verified against live queries —
  Yahoo/Barron's/WSJ results come through.
- **Hardened agent loop**: empty-content-after-tools handled (thinking fallback,
  tool-limit nudge, raw-text fallback verdict); parse hardened against fences/
  thinking tags/nested braces.
- **Live results:** UBER → BUY medium; AGX → **BUY high confidence** citing
  dividend launch, P/E ~39.5, 51% analyst upside target; 12 sources each.

**Verification:** 42/42 tests, typecheck/build/smoke clean, theme verified by
screenshot, agent verified on two tickers end-to-end.

## Not done (per instructions)

- No new git commit/push this session (work sessions 1–2 committed through d77a113 and pushed to the private repo; the coordinator reviews publication).
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
