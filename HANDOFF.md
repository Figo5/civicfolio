# Civicfolio — HANDOFF

## 2026-09-09 — Operational baseline / independent audit (HARDENED, commits `0491048`,`fca95ea`,`2c0b5a9`)

Verification of the AI-fund repair (below), via live app + browser, isolated failure suites, and CI.

**Coordinator:** deepseek-v4-flash (ollama-cloud). **Independent reviewers:** glm-5.3-flash (ollama-cloud) ×2.

### Live state verified (HEAD `2c0b5a9` = origin; clean tree; app restarted on it)
- Dashboard (browser DOM, not bundle strings): equity **$10,004.09**, cash **$9,616.49**, realized $0 / unrealized +$4.09, INTC 3.671 @ mark **$105.59** with freshness "quote 09-09 18:30 · yahoo"; "last run completed 09-09 18:30 (scheduled)"; next run 03:30 PM with honest clock-based disclaimer; run history (1 native + 5 imported). API↔UI values match exactly.
- **Chat read-only**, all 4 questions ("what did the fund do today?", "did you run the fund?", "don't run the fund.", "why is the fund holding INTC?"): deterministic snapshots (`model_used=null`, no external model), recorded evidence only (INTC cost + the actual 2026-09-08 buy rationale), **run IDs byte-identical before/after** — no chat-triggered execution. Thread persistence correct (all in general thread, no bleed).
- **Naturally observed scheduled run** (18:30Z/14:30 ET) `c6486c0d`: `scheduled`/`completed`, mark refreshed → equity $10,004.09, INTC hold (min-hold), GRAB no-trade, no real trades. Matches fund.log and dashboard.
- **Imported vs native distinguishable**: native = UUID; imported = `imported-*` ids + `imported:true`, no fabricated detail.

### Verification found + fixed
- **Coordinator sync-throw wedge (fixed in `2c0b5a9`)**: `startFundRun` set `active` after the async IIFE launched; a body that threw synchronously cleared `active` in `finally` before the outer assignment re-set it ⇒ every later request mis-returned `reused:true`. Fixed (set `active` first, removed dead outer assignment + `ActiveRun.promise`). Added regression test: sync-throw → `failed`, then a real run starts fresh. **95/95 tests pass** (was 94). Independently APPROVED (`2c0b5a9`); the regression test was empirically verified to fail on the pre-fix code (wedge symptom) and pass on the fix.
- **CI comment honesty**: previously claimed the whole suite is hermetic; pre-existing `api.test.ts` makes ~19 failure-tolerant live fetches. Comment corrected; CI itself runs test/typecheck/build hermetic for the repair suite.

### CI
Added `.github/workflows/ci.yml` (Node 22, `npm ci` + lockfile, install→test→typecheck→build, no secrets/`~/.civicfolio`/scheduler). **Verified successes on pushed SHAs**: `fca95ea` (run 34390446084) and `2c0b5a9` (run 34391569882), both 25–31s.

### Checks (coordinator-run)
- `npm test` **95/95** (41 pre-existing + 53 repair + 1 regression); `npm run typecheck` clean; `npm run build` clean; `npm run smoke` all pass (repair baseline, before hardening).
- Live store migrated v2→v3 intact: INTC 3.671 @ 104.47, 1 buy, cash 9616.49, equity intact. Run history preserved; scheduler plist untouched (8 clock times, not trading-day aware).

### Pending / limitations
- `api.test.ts` still makes failure-tolerant live provider fetches (pre-existing; not part of CI's hermetic claim). A fully network-isolated runner would fail it (503). Fix separately if wanted.
- `persistFundChat`/`stripFundNoiseTickers` exports, always-true `|| true` in a test seed, and unwired `RunFundOptions.quoteProvider` are latent nits only (reviewer-listed; no behavior impact).
- No market-calendar awareness in the scheduler by design.

### Next-day acceptance checklist
1. Open `http://127.0.0.1:8787` → AiFund card shows equity, INTC mark w/ real quote time, run history.
2. Ask chat "what did the fund do today?" → read-only snapshot; run IDs unchanged after.
3. Watch one scheduled run; confirm its id/trigger/status/valuation agree between dashboard, `/api/fund`, and fund.log.
4. If equity/pos looks stale >1 scheduled run: check `marks_stale` in `/api/fund`.

---

## 2026-09-09 — AI paper-fund repair (commit `21939e7`)

**Coordinator:** deepseek-v4-flash (ollama-cloud) — routed intentionally. **Impl:** glm-5.3-flash (ollama-cloud). **Independent review:** glm-5.3-flash.

URL: **http://127.0.0.1:8787** · Restart: `launchctl kickstart -k gui/$(id -u)/local.civicfolio` · Logs: `~/.civicfolio/server.log`.

### Root causes
1. **No persistent run record** — `runFundLoop` had no coordinator/history; lastRun was component-local, so scheduled runs were invisible in the UI.
2. **Stale marks** — `ai_fund.marks` updated only on buy; holding passes never re-quoted, so `/api/fund` returned stale equity/P&L.
3. **Broad regex triggered executions** — a `run the fund` regex in chat could fire on "Did you run the fund?" / "Don't run the fund", and chat had no fund snapshot.

### What changed / files
- **New** `server/src/fundRuns.ts` — guarded coordinator (single-flight + `request_id` idempotency); persists run as `running` before long ops, finalizes via try/finally to completed/partial/failed; `finalizeInterruptedRuns` marks abandoned `running`→`interrupted` on restart, no replay; bounded ≤200 runs.
- **New** `server/src/fundChat.ts` — strict intent classifier (run vs status/why); read-only `fundStatusAnswer` snapshot; `fundExplainAnswer`.
- **New** `server/src/fundLogImport.ts` — imports `~/.civicfolio/fund.log` as `imported:true` summary records (only what the log states).
- **New** `server/src/clock.ts` — injectable clock seam.
- **New** `server/test/fundRepair.test.ts` — 53 tests.
- **Modified** `store.ts` (schema v2→v3 migration, mark objects), `types.ts` (`AiFundMark`/`AiFundRun`), `aiFund.ts` (`refreshFundMarks` separate from trading, `effectiveMark`/`marksAreStale`, realized/unrealized distinct), `fundLoop.ts` (delegates to coordinator, marking pass), `app.ts` (`/api/fund` + `marks_stale`+`runs`+`last_run`+`running_run`+`next_scheduled_run`; `POST /api/fund/marks/refresh` valuation-only; chat intent wired; "AI" excluded from ticker extraction), `market.ts` (`getMoversStrict`), `research.ts` (deterministic fund-status answers), `scripts/run-fund.mjs` (sends `trigger` + `request_id`), `src/api.ts` + `src/pages/AiFund.tsx` (run-list/status/next-run/freshness/Refresh-marks, visibility-gated polling).

### Tests / results (all run by coordinator, not just worker)
- `npm test` **94/94 pass** (41 existing + 53 new). `npm run typecheck` clean. `npm run build` clean. `npm run smoke` all pass. No CI configured in repo (private) — cannot report CI for the exact SHA.
- **Initial impl had a test-hermeticity defect** (loop tests hit real Yahoo/SEC without a fetch mock). Fixed in test alone (mockQuietMarket) — reviewer's only blocker; product code was deploy-ready. 94/94 still pass after fix.
- Migration verified against a **copy of the live v2 store**: marks `104.47`→`{price:104.47, quote_as_of:null, fetched_at:null, source:'trade'}` (price kept, timestamps honestly null), INTC 3.671 + 1 trade + cash 9616.49 + equity $10k all preserved.

### Live verification (post-deploy)
- Service restarted via launchd kickstart; `/api/fund` now serves new fields; **on-disk live store migrated v2→v3** with data intact.
- Historical import ran: 5 `fund.log` days marked `imported:true` (e.g. 17:30Z "INTC hold, GRAB no-trade", equity $10k) — honest summaries, not reconstructed.
- **Natural scheduled run caught during task**: 18:30Z (14:30 ET) run recorded `completed`, INTC **mark refreshed** (equity $10,000→$10,004.09, proving staleness fixed), INTC `hold` (min-hold 0.9d), GRAB `no-trade`. No real trades.
- Chat verified live: "what did the fund do today?"/"did you run the fund"/"don't run the fund"/"why is the fund holding INTC?" → all **read-only** snapshots, runs stayed at 5 (no execution); explicit "run the fund" executes (tested hermetically).

### Data preservation
All pre-existing fund data intact: INTC 3.671 @ 104.47, stop 50, cash $9616.49, 1 historical buy trade, lessons none, chat empty (post-deploy status queries added 2 general-thread messages). Backup at `~/.civicfolio/civicfolio-data.json.pre-repair-20260909-132808`.

### Scheduler status
`local.civicfolio.fund` **untouched** — 8 daily CLOCK times (09:35,10:30,11:30,12:30,13:30,14:30,15:30,15:50 ET). It fires on weekends and market holidays — **NOT trading-day aware**. This is surfaced honestly in the API (`next_scheduled_run.note`) and UI, not mislabeled as a trading calendar. No duplicate scheduler created. Brokerage stays disabled.

### Remaining limitations
- Marks lack a freshness timestamp for the pre-migration mark (quote time unknown) — honest, shown in UI.
- The scheduler is clock-based (not trading-day aware) by design; converting to a market-calendar would be a separate, larger change.
- No CI workflow exists to report.
- `runFundLoop`'s `quoteProvider` option is declared but wired only via the module test seam (documented in code); tests use the fetch mock instead.

---

## 2026-09-08 — research-only milestone (below)

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