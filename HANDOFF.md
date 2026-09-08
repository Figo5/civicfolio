# Civicfolio — HANDOFF

Date: 2026-09-08. Milestone: **research-only product** (brokerage integration removed). Workers: Codex (started, hit usage limit mid-pass) + GLM (completion). Coordinator: Astra.

**No commits/push yet — Astra reviews, runs the UI, and commits.**

## Final URL

**http://127.0.0.1:8787** — built frontend + API, bound to 127.0.0.1 only.

Safe restart (does not touch other launchd jobs):

```bash
launchctl kickstart -k gui/$(id -u)/local.civicfolio
```

Logs: `~/.civicfolio/server.log`. Dev mode: `npm run dev` (vite :5173 proxies /api).

## What was done this milestone

### 1. Brokerage removed (Codex + GLM completion)
- Deleted: `server/src/robinhood.ts`, `server/src/alerts.ts`, `src/pages/TradePanel.tsx`, `scripts/debug-rh-*.mjs`.
- All legacy `/api/robinhood/*` routes (every method) and `/robinhood/callback` answer a **static 410 JSON** `{ execution_enabled: false, status: 'permanently_disabled' }` — no input echo, no credential reads, no outbound broker calls, no redirects.
- Frontend: TradePanel usage removed; all `rh*` API client methods removed; settings/meta report `robinhood: removed, execution_enabled: false`.
- Research-only banner, external-processing notice, and status panel live in `src/shell.tsx` (wired into App/OnePage).
- **Provider-side grant revocation NOT verified** — documented in README; user should review connected apps in Robinhood.

### 2. Research honesty (Codex + GLM)
- `llm.ts` system prompt rewritten: research colleague voice, hypothesis + bull/bear + what-would-change-mind; **no forced calls on thin data, no "still make the call", no "quotes were just fetched" assumptions**; qualitative confidence only; no sizing by default.
- Data availability measured **before** the model runs; every source carries its own `as_of` + failure reason; a missing quote timestamp stays **unknown**. If all sources fail → `503` and the model is **never invoked**.
- Chat route: sources that fail are marked failed; search availability is measured by actually attempting the search (keyless DDG works without a daemon).
- Citations: only URLs the app itself retrieved are cited; model-typed links are never promoted. Sources labeled "retrieved references, not verification".
- Level checks: "anchor match" ≠ validated prediction — labeled as such in UI and prompt.

### 3. Thread/async correctness (Codex)
- Assistant messages persist the ticker (same thread as the user message).
- Bounded same-thread history (last 6 messages) is passed to the model — never other threads or portfolio.
- ChatPanel: in-flight responses bound to their thread; late responses never render into the wrong thread; visible errors + retry; duplicate sends blocked; provenance (`model_used` + time) displayed; legacy messages distinguishable by missing provenance.

### 4. Journal, not benchmark (Codex + GLM)
- `trackRecord.ts` rewritten: describes price change since observation; **no correct/wrong, no hit rate**; AVOID is never "profitable short"; old logs preserved (no `sources_available` ⇒ shown as "legacy").
- Frontend `TrackRecord.tsx` renamed to research journal with disclaimer; api types updated.

### 5. Tests/security (Codex + GLM)
- New `server/test/broker.test.ts`: **zero real network/model calls** — mock fetch, daemon pointed at `127.0.0.1:9`, isolated temp data dir. Covers: 410s for every method/route, hostile callback (no HTML, no reflection), no broker requests, all-sources-fail → 503 + no model call, quote-fail-but-search-works → 200 with honest availability, malformed quote payloads → no invented price, journal no hit-rate, citation validation, research guards.
- Chat LLM test no longer requires a live daemon: asserts 200-with-provenance or explicit 502 (never silent fallback).
- 410-route coverage added to `api.test.ts` (including hostile callback query).
- Smoke: isolated port + temp data dir, does not read `~/.civicfolio/env`; broker check updated to `removed`/`execution_enabled:false`.
- **Result: 41/41 tests, typecheck clean, build clean, smoke all green.**

### 6. Docs
- README rewritten as the single source of truth (runtime, URL, data sources + limits, privacy/external processing, config, test commands, explicit not-supported list).
- This HANDOFF summarizes the milestone; older session narrative below is historical.

## Known gaps / not done
- CI workflow (`.github/workflows/ci.yml`) **not added** — the repo is private and unpushed; add when publishing is approved.
- Provider-side revocation of the old Robinhood grant unverified (needs the user in the Robinhood app).
- Search reads titles/snippets only, not full articles.
- The refresh launchd job (`local.civicfolio.refresh.plist`) still runs the legacy disclosure fetcher — harmless (disclosure features are gone), but it can be unloaded if unwanted: `launchctl unload ~/Library/LaunchAgents/local.civicfolio.refresh.plist`.
- Astra: run one real UI research query before commit (per plan; no paid LLM calls were made during this milestone's automated runs).

## Changed files (this milestone)
- Deleted: `server/src/robinhood.ts`, `server/src/alerts.ts`, `src/pages/TradePanel.tsx`, `scripts/debug-rh-accounts|review|schema.mjs`
- Modified: `server/src/app.ts`, `server/src/llm.ts`, `server/src/ollamaAgent.ts`, `server/src/types.ts`, `server/src/trackRecord.ts`, `server/test/api.test.ts`, `server/test/broker.test.ts`, `scripts/smoke.mjs`, `src/api.ts`, `src/pages/OnePage.tsx`, `src/pages/TrackRecord.tsx`, `src/pages/ChatPanel.tsx`, `src/shell.tsx`, `README.md`, `HANDOFF.md`
- Added: `RESEARCH_ONLY_REQUEST.md` (the milestone spec), `server/test/broker.test.ts`

---

# Historical session log (pre-research-only milestone)

## Sessions 8–10 (advisor chat, Robinhood MCP, track record, alerts)
- Robinhood Trading MCP integrated (OAuth2+PKCE, review→place flow), advisor chat via DeepSeek, track record scoring, price alerts, position guard, earnings warning. Chat grounded on live quotes + web search; "no live data" bug fixed; unified chat/research pipeline; direct advisor voice. Commit `141b40d`.
- **All of the above brokerage work was REMOVED in this milestone per owner instruction.** Track record scoring was replaced by the descriptive journal. Chat grounding and thread correctness survive.

## Session log (archived, condensed)
- Session A/B: original build + review fixes (Origin/Host guards, idempotency, atomic persistence). 32 tests.
- Session C: SEC fundamentals, proposals engine, daily refresh launchd job.
- Session 5: owner pivot — one page, no paper trading.
- Session 6–7: black/white/green theme, Ollama research agent, DDG fallback search.
- Session 8 (Claude pivot): deleted congressional stack, Yahoo market screener + insights engine.
- Session 9: chat fixed to live-data + DeepSeek advisor; Robinhood review flow repaired against real MCP schema (string quantity, `type` param, account_number, SSE parsing).
- Session 10: track record page, price alerts, position guard, earnings warning; committed `8c44c43`.
- Session 11: unified chat = research pipeline; live market context; advisor voice; commits `6325b65`, `ba7da14`, `141b40d`.