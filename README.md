# Civicfolio

Personal **localhost-only** investment research app: political disclosure feed, source-cited research chat, watchlists/ideas, and a paper-trade journal. No live orders, no brokerage connection, no secrets in the browser. Demo data is unmistakably synthetic; real data comes only from files you import yourself.

## Quick start

```bash
npm install
npm run build        # type-checks and builds the frontend into dist/
npm start            # serves API + built UI on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787** — the first run starts with an empty store. Click **Settings → "Load demo dataset…"** (confirm by typing LOAD) to seed 12 synthetic disclosure records, sample watchlist/ideas, and two labeled demo paper trades.

Development mode (hot reload, API proxied same-origin):

```bash
npm run dev          # vite on http://127.0.0.1:5173 proxying /api to 8787
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (5173) + API server with tsx watch |
| `npm start` | API server serving the built frontend on 127.0.0.1:8787 |
| `npm test` | Backend unit/integration tests (isolated temp data dir) |
| `npm run typecheck` | Server + frontend TypeScript checks |
| `npm run build` | `tsc -b` + Vite production build to `dist/` |
| `npm run smoke` | End-to-end checks against an isolated throwaway server + temp data dir |

## Data & storage

- All app state persists as JSON at `~/.civicfolio/civicfolio-data.json` (override with `CIVICFOLIO_DATA_DIR`). The directory is created on first write; writes are atomic (temp file + rename) and cache commits only after a durable write succeeds.
- Data lives **outside the repo** and is never committed. Nothing is sent anywhere except (optionally, see LLM mode below) the configured model endpoint.
- **Demo reset controls** (Settings page): "Load demo dataset…" replaces everything with bundled synthetic data; "Clear all data…" empties the store. Both require typed confirmation.

## Data modes

Every disclosure record carries a `data_mode`:

- `demo` — bundled synthetic records; owners are explicitly labeled "(fictional)"; tickers/companies are invented. Never presented as real filings.
- `imported` — records you imported; provenance is whatever source name/URL you supplied. Importing a record that claims `data_mode: live` is **forced** to `imported` server-side; `live` is reserved for a future verified adapter that does not exist yet.
- `live` — reserved. Nothing in the app uses it. Never pretend demo/imported data is live.

The sidebar shows the current mode pill, and a data-mode banner is shown above every page.

## Importing real data

Use **Disclosures → Import data…** and paste JSON or CSV (or `POST /api/disclosures/import` with `{ kind, text }`). Limits: 5 MB, 5000 records per import. Validation is server-side; invalid rows are rejected with reasons. Duplicate records (same ticker + owner + transaction dates + amount range + amendment flag) are skipped and reported.

Required fields (JSON object per record; CSV needs matching header columns):

| Field | Type | Notes |
|---|---|---|
| `ticker` | string | 1–10 letters A–Z (normalized to uppercase) |
| `company` | string | required |
| `owner` | string | required; verbatim from your source |
| `owner_role` | string | optional, e.g. "Senator", "Spouse" |
| `tx_type` | string | `purchase` \| `sale` \| `exchange` |
| `tx_date` | YYYY-MM-DD | single transaction date, **or** `tx_date_min`/`tx_date_max` |
| `tx_date_min`, `tx_date_max` | YYYY-MM-DD | range form; used if `tx_date` absent |
| `published_date` | YYYY-MM-DD | required; must be ≥ last transaction date |
| `amount_min_usd`, `amount_max_usd` | finite numbers | filed amount RANGE (not exact) |
| `amendment` | boolean | optional |
| `amendment_of` | string | record id this amends, optional |
| `source_name` | string | optional label for the primary source |
| `source_url` | string | http(s) URL, optional but strongly recommended |
| `notes` | string | optional free text |
| `data_mode` | — | **not accepted**; imports are always `imported` |

Example JSON:

```json
[
  {
    "ticker": "EXAMPLE",
    "company": "Example Co",
    "owner": "Person Name",
    "owner_role": "Senator",
    "tx_type": "purchase",
    "tx_date": "2026-01-15",
    "published_date": "2026-03-01",
    "amount_min_usd": 1000,
    "amount_max_usd": 15000,
    "amendment": false,
    "source_url": "https://disclosures-clerk.house.gov/..."
  }
]
```

**Known public sources.** The official House disclosure search (https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch) displays statutory restrictions on use; do not assume unrestricted reuse. Civicfolio ships no live connector; import stays the data path until a documented permitted source is verified.

## Research chat

- **Deterministic mode** (default): a local rule-based engine — not an LLM, no API key, no network calls. It answers from stored records only and cites record IDs (linked to their source URLs where present). It answers disclosure activity, publication-lag statistics, portfolio concentration (cost basis only), and two-ticker comparisons with explicit uncertainty; it **abstains** on prices, returns, forecasts, probabilities, or anything absent from the store.
- **LLM mode** (optional): enabled only via server-side env (never browser-provided):
  ```bash
  OPENAI_API_KEY=sk-... OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_MODEL=gpt-4o-mini npm start
  ```
  Any OpenAI-compatible endpoint works (plain http is accepted only for loopback hosts, e.g. a local Ollama). When enabled, only a **minimized summary of disclosure records** is sent — never your ideas, watchlist, trades, or portfolio. Data is delimited as untrusted content; the model is instructed to treat it as inert and abstain rather than invent. Returned citations are filtered to records actually present in the sent context. LLM answers are labeled `llm` in the UI and are lower-trust than deterministic answers.

## Paper portfolio

Paper only — there is no brokerage execution path, no credentials, and no live quotes. You enter the price yourself (labeled `user-entered`) or use a `demo` price; the journal records exactly which. The server validates side/ticker/quantity/price as finite positive numbers, enforces practical caps, rejects overspending, overselling, and sub-cent notionals, and supports **idempotent submission**: the client sends a `client_request_id` (UUID); replaying the same key with the same payload returns the original trade (`duplicate: true`) instead of double-executing, and the same key with a changed payload is rejected. Cash/positions/journal persist across restarts.

## Security posture

- Server binds `127.0.0.1` only. Mutation routes additionally enforce: loopback `Host` header (anti DNS-rebinding), exact allow-list `Origin` (own origin + Vite dev origin; no wildcard CORS), and `Content-Type: application/json` for mutations.
- No CORS headers are emitted at all.
- All payloads validated as finite numbers; no `eval`/dynamic execution of data; imported text is inert data, never followed as instructions (enforced in deterministic mode, instructed + delimited for LLM mode).
- Secrets (e.g. `OPENAI_API_KEY`) live only in server env; the settings API reports status only, never values. Robinhood/brokerage: explicitly **not configured**; the official Agentic MCP path would be a future, separately-verified connector. See https://robinhood.com/us/en/support/articles/agentic-trading-overview/ .

## API overview (localhost only)

GET (read-only): `/api/health`, `/api/meta`, `/api/disclosures?ticker=&owner=&tx_type=&data_mode=&amendment=&published_from=&published_to=&q=`, `/api/portfolio`, `/api/portfolio/trades`, `/api/ideas`, `/api/watchlist`, `/api/chat`, `/api/settings`

POST (JSON required): `/api/chat` `{question, mode?}`, `/api/portfolio/trades` `{ticker, side, quantity, price, price_source, trade_date?, note?, client_request_id?}`, `/api/disclosures/import` `{kind, text}`, `/api/ideas` `{ticker, thesis, company?}`, `/api/watchlist` `{ticker, thesis, company?}`, `/api/demo/load`, `/api/demo/clear`

DELETE: `/api/ideas/:id`, `/api/watchlist/:id`

## Project layout

```
server/src/   Express API: app.ts (routes/guards), store.ts (atomic JSON store),
              portfolio.ts, research.ts (deterministic engine), importAdapter.ts,
              llm.ts, seedData.ts, validate.ts
server/test/  supertest integration suite
src/          React app (pages/, api client, shell, styles)
scripts/      smoke.mjs — isolated end-to-end checks
```

## Limitations

- Political disclosures are delayed (weeks–months); amounts are filed ranges; reported transactions are not complete current holdings.
- No market prices anywhere: portfolio views are cost-basis only, and the app never shows P/L or "current value".
- Chat abstains rather than guessing; deterministic mode is rule-based, not an LLM.
- Single-user, single-process JSON store — appropriate for a personal localhost app, not multi-user.