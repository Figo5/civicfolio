# Civicfolio — HANDOFF

## Current runtime

Civicfolio is a localhost-only research and paper-fund application at `http://127.0.0.1:8787`. Brokerage execution remains permanently disabled; legacy `/api/robinhood/*` routes return static `410` responses.

The only active LLM provider is OpenAI:

- Official `openai` Node SDK, Responses API
- `server/src/provider.ts` owns provider-specific request syntax, SDK client reuse, timeout/retry policy, structured-output requests, and sanitized error mapping
- `OPENAI_API_KEY` is required for AI research, generated chat, and model-generated fund reflections
- `OPENAI_MODEL` is optional; default `gpt-4o-mini`
- The client is pinned to `https://api.openai.com/v1`; endpoint overrides are ignored
- Keys remain server-side and are never returned by settings, metadata, or error responses

The provider boundary exposes text generation and schema-constrained generation only. Civicfolio had no streaming transport or embeddings pipeline, so neither was added. Model-driven tool execution is not active: DuckDuckGo search, market retrieval, source filtering, and all actions stay in application code.

## Preserved behavior

- Existing general-chat system prompt and advisor/analyst posture
- Bounded same-thread conversation history
- Untrusted-data fencing, source availability, citations, Markdown response text, and model provenance
- Keyless DuckDuckGo fallback search
- Research verdict schema plus application-side type/range/level validation; malformed output fails closed
- Paper-fund deterministic status/explanation paths and guarded explicit run intent
- Existing store at `~/.civicfolio`; no migration or reset of user data

## Setup and operation

```bash
cd ~/Documents/Codex/civicfolio
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY; optionally change OPENAI_MODEL
npm start
```

Development mode:

```bash
npm run dev
```

The existing launchd service still starts the app from this repository. After changing `~/.civicfolio/env` or the repository `.env`, restart only Civicfolio:

```bash
launchctl kickstart -k gui/$(id -u)/local.civicfolio
```

Logs:

```text
~/.civicfolio/server.log
~/.civicfolio/server.err.log
```

## Verification

Coordinator-run on the migration diff:

- `npm test`: **108/108 pass**
- `npm run typecheck`: pass
- `npm run build`: pass
- `npm run smoke`: pass
- `npm audit --audit-level=high`: zero vulnerabilities
- Chat and structured research paths use mocked/injected OpenAI clients in tests; no paid API calls occur
- Full tracked-tree scan confirms no active legacy provider source, URL, environment variable, model, dependency, startup, or README path remains

## Operational limitations

- AI paths fail clearly until `OPENAI_API_KEY` is configured; deterministic/local features remain available
- OpenAI usage is metered. Civicfolio performs one model call per normal generated answer or research verdict and no model-discovery probe
- Search uses titles/snippets rather than full article bodies
- Market sources remain unofficial/delayed and may fail independently; source status and timestamps remain visible
- The paper-fund scheduler is clock-based, not trading-calendar-aware, and remains unchanged
- Provider-side revocation of the removed brokerage grant was never verified; review connected apps separately if still relevant

Older milestone details remain available in Git history; this file is the current operational source of truth.

## Experimental branch: Deep Research

Branch `experiment/verified-research`. **Not merged. Off by default. Read-only.**
`main` and the running service configuration are unchanged.

A TradingAgents-inspired workflow: resolve instrument identity, build a verified
evidence packet, then one researcher call and one reviewer call, with the
application making the final decision about what is supported. Full write-up,
including the reviewed upstream commit and the baseline comparison, is in
`docs/DEEP_RESEARCH_EXPERIMENT.md`.

Enable with `CIVICFOLIO_DEEP_RESEARCH=1` in server env; unset to disable. With
the flag off the route returns 404, `/api/meta` reports it disabled, and the UI
does not render the entry point.

```
npm test          # 152/152
npm run typecheck # pass
npm run build     # pass
npm run smoke     # pass
npm run eval:deep # baseline vs experiment, frozen evidence, no network
```

Ordinary chat, the baseline research route, and all paper-fund behaviour are
unchanged; tests assert that a deep run leaves the portfolio, trade list and
fund byte-identical, and that neither experiment module imports any trading or
store module.

Live API usage during this work: **2 OpenAI requests** (one AMD run, SDK retries
disabled for the count). No paid search and no brokerage calls.
