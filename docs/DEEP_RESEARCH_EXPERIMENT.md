# Deep Research — experimental

**Status: experiment. Off by default. Read-only. Not merged to `main`.**

Branch: `experiment/verified-research`.

## The question being tested

Does a verified evidence packet plus one researcher and one reviewer produce
more useful, better-supported research than the existing `/api/research/:ticker`
path, at an acceptable cost?

This is **not** a profitability test, an autonomous trader, or a replacement for
the production research path. It answers a research question and returns a
report. It places no orders, modifies no portfolio, writes no paper-fund
decision, and schedules nothing.

## Enable, run, disable

```bash
# enable (server env only)
export CIVICFOLIO_DEEP_RESEARCH=1
npm start

# disable: unset it, or set it to anything that is not 1/true/on
unset CIVICFOLIO_DEEP_RESEARCH
```

With the flag off the route returns 404, `/api/meta` reports
`deep_research_experiment.enabled: false`, and the UI never renders the entry
point. With it on, a second button — "Deep Research (exp.)" — appears next to
the existing "Research with AI" button in the ticker detail view. Nothing else
in the dashboard changes.

Offline evaluation, no network and no cost:

```bash
npm run eval:deep
npm run eval:deep -- --live --ticker AMD   # one paid run, illustrative only
```

Dollar cost is reported only when a documented price is configured:

```bash
export CIVICFOLIO_USD_PER_MTOK_IN=0.15    # from the current published price list
export CIVICFOLIO_USD_PER_MTOK_OUT=0.60
```

Without those, token usage is still reported and the dollar figure is
explicitly `unknown` rather than guessed from a rate that may be stale.

## What it does

```
resolve identity → collect and validate evidence → researcher drafts →
reviewer corrects against the same packet → application validates → render
```

Exactly two synthesis requests. The reviewer returns a corrected structured
report *plus* its issues, so there is no third "final writer" call and no
debate loop.

### Identity first

`resolveIdentity` compares the SEC filer name (via CIK) against the market
feed's name for the same ticker. Agreement resolves; disagreement is `AMBIGUOUS`
and **stops the run before any model call**. A single source resolves but is
recorded as uncorroborated. An ambiguous ticker never silently becomes another
company.

### The evidence packet

Every item carries `id`, claim/value, unit, source, URL, and three separate
times:

- `published_at` — when the claim became available
- `period_end` — the period or event the claim is *about*
- `retrieved_at` — when this app fetched it

Collapsing those is how a stale article becomes "current evidence", so they are
never merged. An unknown quote timestamp stays unknown instead of being stamped
with "now". Undated news is marked unusable as current evidence.

The packet also validates what a provider response cannot tell you: that the
balance sheet balances, that filing currency and quote currency are comparable,
and that the price history is long enough for the averages derived from it.
Missing data is listed as missing — never as zero.

### Point-in-time

A `cutoff` excludes evidence published after it. Quotes, SMAs and 52-week ranges
come from endpoints with no as-of parameter, so `point_in_time.enforced` is
`false` whenever undatable items remain, and the limitation says plainly that
the run **is not a historical backtest**.

### The application has the last word

`validateReport` — not the reviewer — decides what is displayed:

- citation ids must exist in the packet
- claims citing nothing are dropped
- numbers must appear in the packet; a claim built entirely on unsupported
  figures is removed, and a partly-unsupported claim is kept and marked
- a report naming a company other than the resolved one is flagged

Two model calls agreeing is **not** independent corroboration — they read the
same evidence — and the output says so.

Numbers appearing in news headlines and web snippets are deliberately **not**
counted as packet support. That text is untrusted third-party content; treating
a figure inside it as verified would let anyone who can get a number into a
headline launder it into a validated figure. (This was found by the
prompt-injection fixture, which initially passed a planted `$400 target`
through validation.)

## TradingAgents patterns adopted

Upstream reviewed: [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)
at commit **`be952b8eccb49720509af544c6675233bc1f10d0`** (2026-09-07, the v0.4.2
merge), Apache-2.0.

**TradingAgents-inspired, not an integration.** No upstream code is used, no
Python or LangGraph is involved, and no dependency was added. Because no code
was copied, no license notice is required; the reference is recorded here for
attribution of the ideas.

Three patterns were adapted into CivicFolio's existing TypeScript architecture:

| Upstream pattern | What was adapted here |
|---|---|
| Company identity resolved deterministically from the ticker *before* any agent runs | `resolveIdentity` runs first and can abort the workflow; ambiguity is terminal |
| Agents ground exact price/indicator claims in one verified snapshot rather than re-fetching mid-analysis | One frozen `EvidencePacket` is built once and handed identically to both stages |
| Explicit look-ahead / point-in-time filtering | `cutoff` filtering plus an honest `enforced: false` when it cannot be established |

Deliberately **not** adopted: the bull/bear/trader/risk/portfolio-manager chain,
the LangGraph checkpoint database, the decision-log memory that reflects on
realised returns, and anything that produces a trading action.

## Baseline comparison

`npm run eval:deep` runs the unchanged baseline agent and the experiment over
byte-identical frozen evidence, with the **same deliberately flawed draft** fed
to both. Over the seven answerable fixture cases:

| | baseline | experiment |
|---|---|---|
| unsupported numbers reaching output | 25 | 0 |
| claims carrying citations | 0 | 16 |
| model calls | 6 | 12 |
| input tokens | 7,200 | 14,400 |
| refusals | 0 | 2 |

Both refusals are correct answers: the ambiguous-identity case and the
no-data case.

**What this does and does not show.** The model is scripted, so this measures
plumbing and invariants — entity correctness, citation support, stale/undated
handling, cutoff leakage — and says **nothing** about whether the reviewed prose
is better. The cost is real and roughly 2x.

Two fairness caveats are printed by the harness itself: it calls the baseline
*agent* directly, while the shipped baseline *route* has its own no-market-data
guard that would also refuse; and the baseline does verify price levels
(`verifyLevels`) and surfaces ungrounded ones — it reports them rather than
removing them, which is why its unsupported-number count stays high while its
"limitations disclosed" is non-zero.

No LLM-generated quality score is used anywhere, on purpose.

## Live run (one ticker, AMD, illustrative)

Exactly **2 OpenAI requests**, SDK retries disabled so the count is exact.
Identity resolved OK (SEC and market feed agreed). 21 evidence items, nothing
missing. The reviewer raised 3 issues (one high-severity unsupported number, one
stale-evidence, one missing-context).

The application then rejected figures the model had stated that the packet did
not contain, removing 5 claims. That is the workflow doing the job it exists
for — on a live run, not a fixture.

It also exposed a real defect in the validator: the model wrote
"34.64 billion USD" where the packet holds `34640000000`, and the bare-number
comparison flagged a *correct* restatement as invented. Number matching is now
scale-aware (`statedNumbers` applies thousand/million/billion/trillion), with
tests pinning that a correct restatement passes, a wrong one in billions is
still caught, and a scaled small number is no longer skipped by the bare-number
floor. That fix was made after the live run and is covered by mocked tests only.

One ticker is an anecdote, not a measurement of quality.

## Verification

```
npm test          # 152/152 (108 pre-existing + 44 new)
npm run typecheck # pass
npm run build     # pass
npm run smoke     # pass
npm audit --audit-level=high   # 0 vulnerabilities
npm run eval:deep # deterministic, no network
```

Tests prove, among other things, that with the flag off the route 404s and the
ordinary research route is unchanged; that a deep run leaves the portfolio, the
trade list and the paper fund byte-identical; and that neither experiment module
imports `portfolio`, `aiFund`, `fundLoop`, `fundRuns`, `fundChat` or `store` —
an import is how it would ever gain the ability to trade, so the absence of one
is the invariant worth pinning.

All automated tests are hermetic: the collector and the provider are injected,
`OPENAI_API_KEY` is deleted in the test setup, and no test makes a paid call.

## Limitations

1. Two model calls over one packet. Their agreement is not corroboration.
2. Mocked results establish invariants, not model quality. A live comparison is
   illustrative and not statistically conclusive.
3. Identity rests on two name sources. A ticker absent from SEC data resolves on
   the market feed alone and is marked uncorroborated.
4. Point-in-time cannot be fully enforced with the current data sources, so no
   run here is a backtest.
5. News is headline-only; article bodies are not retrieved.
6. `searches_used` counts evidence items of news/web kind, not distinct search
   queries — the packet is built from the app's existing providers, and the
   experiment adds no new search backend.
7. The evaluation fixture set is small and hand-built. It probes named failure
   modes; it is not a benchmark.
