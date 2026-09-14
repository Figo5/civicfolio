# Civicfolio

A **personal, localhost-only stock research app**. It screens the live market, runs an AI research agent that cites its sources, and keeps a journal of what it said and what the price did after. It is **research-only**: it places no orders, connects to no broker, and holds no credentials.

> **Not investment advice.** All output is a research hypothesis generated from the data described below. Confidence is qualitative. Nothing here is a recommendation to trade.

## Status: research-only (brokerage removed)

The experimental Robinhood Trading-MCP integration was **removed** at the owner's request. All legacy `/api/robinhood/*` routes answer a static `410` with `execution_enabled: false` — they never read credentials, contact a broker, or redirect into an authorization flow. Local credential files were deleted. **Provider-side grant revocation was NOT verified** — check "Connected apps" in your brokerage account if you authorized this app previously.

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY. OPENAI_MODEL is optional.
npm run build        # type-checks and builds the frontend into dist/
npm start            # serves API + built UI on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787**.

Development mode:

```bash
npm run dev          # vite on http://127.0.0.1:5173, proxies /api to 8787
```

## Always-on (macOS launch agent)

```bash
launchctl load ~/Library/LaunchAgents/local.civicfolio.plist     # enable
launchctl unload ~/Library/LaunchAgents/local.civicfolio.plist   # disable
launchctl kickstart -k gui/$(id -u)/local.civicfolio             # restart
```

Logs: `~/.civicfolio/server.log`. Data: `~/.civicfolio/` (override with `CIVICFOLIO_DATA_DIR`).

To restart the service **safely** (does not touch other jobs):

```bash
launchctl kickstart -k gui/$(id -u)/local.civicfolio
```

Do NOT `kill` by port without checking what owns it first.

## What it does

- **Today's ideas** — a deterministic screen (no AI) over the live market: volume surges, 52-week range position, earnings proximity. Every rule that fired is shown; it is a shortlist, not a recommendation.
- **Movers** — most active / gainers / losers, with per-quote delay timestamps.
- **Ticker detail** — any symbol: delayed quote, SMAs, 52-week range, headlines, SEC-filed fundamentals, and **Research with AI**.
- **Research with AI** — the OpenAI-backed agent gets live quotes + history + headlines + SEC figures + web-search results and returns a hypothesis: view, entry/target/stop levels, reasoning, risks, and the references it actually retrieved. Every stated level is re-checked against the data the app supplied ("anchor match" vs "unsupported"). Data availability per source (with timestamps) is shown next to the answer.
- **Chat** — per-ticker threads (or General) with the same research pipeline. Follow-ups carry bounded same-thread context. Responses display the model used and when.
- **Research journal** — every research result is logged with its evidence state; the journal shows what the price did since. **Descriptive only — not a benchmark, not strategy performance.**

## Data sources & honest limits

| Source | What | Limits |
|---|---|---|
| Public Yahoo endpoint | quotes, history, movers, headlines | **Delayed, unofficial**; no continuity guarantee; each quote carries its own timestamp |
| SEC EDGAR | as-filed annual figures | Months old; filing date shown |
| DuckDuckGo (keyless) | web search results | Titles + snippets only; full articles are not read |
| OpenAI (server-side API key) | research/chat | **External processing** — see below |

Quotes as-of missing ⇒ timestamp shown as **unknown**, never "now". A failed source is shown as failed; if every source fails, the model is **not invoked** and you get an explicit error instead of a hallucinated answer.

## Privacy / external processing

Although the app runs on localhost, AI research and LLM chat send your question (plus fetched market data and, inside a ticker thread, that thread's recent messages) to **OpenAI**, and — for research and chat — the raw question text to **DuckDuckGo**. No portfolio, positions, notes, or other threads are ever sent.

`OPENAI_API_KEY` is read from server env only. `npm start` and `npm run dev` load the repository `.env`; the launchd-compatible fallback `~/.civicfolio/env` is also loaded, with existing process/repository environment values taking precedence. Neither file is tracked. The key is never sent to the browser or written into responses. With no key set, AI research and LLM chat fail immediately with an explicit error — no network call is attempted — and the deterministic engine keeps working fully offline.

## Configuration

No secrets in the browser, ever. Relevant env (server-side only):

- `CIVICFOLIO_DATA_DIR` — data directory (default `~/.civicfolio`)
- `CIVICFOLIO_PORT` — default 8787
- `CIVICFOLIO_ADVISOR_MODE` — `advisor` (default) or `analyst` (no directional lean)
- `OPENAI_API_KEY` — **required for AI research and LLM chat.** Without it those paths are disabled; everything else still works.
- `OPENAI_MODEL` — optional, default `gpt-4o-mini`

## Tests

```bash
npm test        # unit tests — mocked fetch, injected LLM provider, isolated temp data dir; no real network or model calls
                # (OPENAI_API_KEY is cleared in-process, so a developer key can never cause a paid call)
npm run smoke   # boots a server on an isolated port + temp data dir; never reads ~/.civicfolio/env
npm run typecheck
npm run build
```

## What is NOT here (by design)

- No order placement, no broker connection, no credential storage
- No real-time exchange feed (delayed public data only)
- No outcome scoring / hit rates (one later price cannot validate a call)
- No automatic refresh jobs beyond the launchd service itself
- No multi-user anything — this is a single-user local tool