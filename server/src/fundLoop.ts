// The autonomous trading loop: research -> decide -> execute -> reflect.
//
// The model's job is judgment (what looks good, when to exit). The code's job
// is everything numeric: sizing, caps, stops, execution price. The model never
// types a price it trades at — execution always uses a freshly fetched quote.
//
// Invoked by hand (Run the fund button / "run the fund" in chat); a scheduled
// pass can call the same endpoint later.

import { randomUUID } from 'node:crypto';
import type { AppData, VerdictLogEntry } from './types.js';
import type { AgentVerdict } from './ollamaAgent.js';
import { getQuotes } from './quotes.js';
import { getMovers, getMoversStrict, getPriceHistory, getTickerNews } from './market.js';
import { getFundamentals } from './fundamentals.js';
import { runResearchAgent, getAgentConfig } from './ollamaAgent.js';
import { planTradeFromVerdict, executeAiTrade, fundEquity, lessonsBlock, daysSince, lastSellOf, refreshFundMarks, marksAreStale, MIN_HOLD_DAYS, REBUY_COOLDOWN_DAYS, type PlannedTrade } from './aiFund.js';
import { update, load } from './store.js';
import { startFundRun, activeRun, finalizeInterruptedRuns } from './fundRuns.js';
import type { AiFundRun, AiFundRunAction } from './types.js';

const MAX_OPEN_POSITIONS = 6;

interface LoopResult {
  ran_at: string;
  actions: { ticker: string; action: string; detail: string }[];
  equity_usd: number;
}

export interface RunFundOptions {
  trigger?: AiFundRun['trigger'];
  requestId?: string;
  /** Injectable quote provider (tests). Default: real getQuotes. */
  quoteProvider?: typeof getQuotes;
}

export interface RunFundOutcome {
  reused: boolean; // an existing run was returned instead of executing a new one
  result: LoopResult;
  run: AiFundRun; // the full durable record
  error?: string;
}

/**
 * One full pass of the fund, through the shared guarded coordinator. Safe to
 * call repeatedly; concurrent calls share one execution (reused:true), and the
 * pass is durably recorded from 'running' through finalize (completed /
 * partial / failed / interrupted) in ai_fund.runs.
 */
export async function runFundLoop(opts: RunFundOptions = {}): Promise<RunFundOutcome> {
  const outcome = await startFundRun(opts.trigger ?? 'manual', (ctx) => loopBody(ctx), {
    requestId: opts.requestId,
  });
  const lastAt = outcome.run.finished_at ?? outcome.run.started_at;
  return {
    reused: outcome.reused,
    result: {
      ran_at: lastAt,
      actions: outcome.run.actions,
      equity_usd: outcome.run.equity_usd ?? Number(fundEquity(load()).toFixed(2)),
    },
    run: outcome.run,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

interface LoopCtx {
  addActions: (a: AiFundRunAction[]) => void;
  addFailures: (f: { kind: string; note: string }[]) => void;
  setModel: (m: string | null) => void;
  recordTrades: (n: number) => void;
}

/** The actual research -> decide -> execute -> reflect pass. */
async function loopBody(ctx: LoopCtx): Promise<void> {
  const cfg = getAgentConfig();
  ctx.setModel(cfg.model ?? null);
  if (!cfg.enabled) {
    ctx.addFailures([{ kind: 'model', note: 'no model transport available' }]);
    throw new Error('no model transport available');
  }

  // ---- 0. Marking pass: refresh marks for held positions (no trading) -----
  const markRes = await refreshFundMarks();
  for (const f of markRes.failed) {
    ctx.addFailures([{ kind: 'data', note: `quote unavailable for ${f.ticker}: ${f.reason} (last mark retained, labelled stale)` }]);
    ctx.addActions([{ ticker: f.ticker, action: 'mark-failed', detail: `quote unavailable: ${f.reason} — previous mark retained as stale` }]);
  }
  if (markRes.updated.length > 0) {
    ctx.addActions(markRes.updated.map((t) => ({ ticker: t, action: 'mark', detail: `mark refreshed (${markRes.fetched_at})` })));
  }

  const before = load();
  const lessons = before.ai_lessons;
  let tradesThisRun = 0;

  // ---- 1. Manage open positions -------------------------------------------
  const heldTickers = Object.keys(before.ai_fund.positions);
  for (const ticker of heldTickers) {
    const { quotes } = await getQuotes([ticker]).catch(() => ({ quotes: [] as Awaited<ReturnType<typeof getQuotes>>['quotes'] }));
    const q = quotes[0];
    if (!q) { ctx.addActions([{ ticker, action: 'skip', detail: 'no quote available' }]); continue; }
    const d = load(); // fresh snapshot per position (marks were just refreshed)
    const pos = d.ai_fund.positions[ticker];
    if (!pos) continue;
    const stop = d.ai_fund.stops[ticker];

    // Hard stop: deterministic, no model involved.
    if (typeof stop === 'number' && q.price <= stop) {
      update((draft) => {
        const plan: PlannedTrade = { ticker, side: 'sell', quantity: pos.quantity, price: q.price, stop_loss: null, rationale: `stop hit at ${q.price} (stop ${stop})`, verdict_id: 'stop-loss' };
        const t = executeAiTrade(draft, plan, q.as_of);
        tradesThisRun += 1;
        return { committed: true, value: t };
      });
      ctx.addActions([{ ticker, action: 'stop-sell', detail: `sold ${pos.quantity} @ ${q.price} (stop ${stop})` }]);
      continue;
    }

    // Thesis re-check with the model: hold, or exit?
    // Min-hold guard: hourly runs re-research positions, and a single noisy
    // dip can flip a fresh thesis — block thesis-exits for MIN_HOLD_DAYS after
    // entry. The hard stop above always fires regardless.
    const entryTrade = [...d.ai_fund.trades].reverse().find((t) => t.side === 'buy' && t.ticker === ticker);
    if (entryTrade && daysSince(entryTrade.executed_at) < MIN_HOLD_DAYS) {
      ctx.addActions([{ ticker, action: 'hold', detail: `min-hold (${daysSince(entryTrade.executed_at).toFixed(1)}d old, ${MIN_HOLD_DAYS}d required)` }]);
      continue;
    }
    const verdictRes = await researchOne(ticker, lessons);
    if (!verdictRes.ok) {
      ctx.addActions([{ ticker, action: 'skip', detail: verdictRes.error }]);
      ctx.addFailures([{ kind: 'model', note: `research failed for ${ticker}: ${verdictRes.error}` }]);
      continue;
    }
    if (verdictRes.outcome.verdict === 'avoid') {
      update((draft) => {
        const plan: PlannedTrade = { ticker, side: 'sell', quantity: pos.quantity, price: q.price, stop_loss: null, rationale: verdictRes.outcome.summary.slice(0, 300), verdict_id: verdictRes.outcome.id };
        const t = executeAiTrade(draft, plan, q.as_of);
        tradesThisRun += 1;
        return { committed: true, value: t };
      });
      ctx.addActions([{ ticker, action: 'exit-sell', detail: `sold ${pos.quantity} @ ${q.price}: ${verdictRes.outcome.summary.slice(0, 120)}` }]);
    } else {
      ctx.addActions([{ ticker, action: 'hold', detail: `${verdictRes.outcome.verdict} (${verdictRes.outcome.confidence})` }]);
    }
  }

  // ---- 2. Look for one new entry ------------------------------------------
  const afterHolds = load();
  const openCount = Object.keys(afterHolds.ai_fund.positions).length;
  const candidate = await pickCandidate(afterHolds, heldTickers);
  if (candidate === null) {
    // Distinguish "market data unavailable" from "nothing worth researching":
    // getMoversStrict throws on an unreachable feed, returns [] on an empty
    // screen — a dead data source becomes a run failure, not a quiet no-op.
    try {
      const movers = await getMoversStrict('most_actives', 1);
      if (movers.length === 0) {
        ctx.addActions([{ ticker: '-', action: 'scan', detail: 'no new candidate worth researching' }]);
      }
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      ctx.addActions([{ ticker: '-', action: 'scan', detail: `movers unavailable: ${note.slice(0, 160)} — no candidate scanned` }]);
      ctx.addFailures([{ kind: 'data', note: `movers unavailable: ${note.slice(0, 300)}` }]);
    }
  } else if (openCount >= MAX_OPEN_POSITIONS) {
    ctx.addActions([{ ticker: '-', action: 'scan', detail: 'max open positions' }]);
  } else {
    const verdictRes = await researchOne(candidate, lessons);
    if (!verdictRes.ok) {
      ctx.addActions([{ ticker: candidate, action: 'skip', detail: verdictRes.error }]);
      ctx.addFailures([{ kind: 'model', note: `research failed for ${candidate}: ${verdictRes.error}` }]);
    } else {
      const v = verdictRes.outcome;
      // Re-entry cooldown: don't chase back into a name we just sold — the
      // classic whipsaw under frequent runs.
      const lastSell = lastSellOf(afterHolds, candidate);
      if (lastSell && daysSince(lastSell) < REBUY_COOLDOWN_DAYS) {
        ctx.addActions([{ ticker: candidate, action: 'no-trade', detail: `re-entry cooldown (${daysSince(lastSell).toFixed(1)}d since last sell, ${REBUY_COOLDOWN_DAYS}d required)` }]);
      } else {
      const { quotes } = await getQuotes([candidate]);
      const q = quotes[0];
      if (!q) {
        ctx.addActions([{ ticker: candidate, action: 'skip', detail: 'no quote at decision time' }]);
      } else {
        const planned = planTradeFromVerdict(afterHolds, {
          ticker: candidate,
          verdict: v.verdict,
          confidence: v.confidence,
          price: q.price,
          entry: null,
          stop: parseLevel(v.stop_loss, q.price),
          rationale: v.summary.slice(0, 300),
          verdict_id: v.id,
          lessons,
        });
        if (!planned.ok) {
          ctx.addActions([{ ticker: candidate, action: 'no-trade', detail: planned.reason }]);
        } else {
          update((draft) => {
            const t = executeAiTrade(draft, planned.plan, q.as_of);
            tradesThisRun += 1;
            return { committed: true, value: t };
          });
          ctx.addActions([{ ticker: candidate, action: 'buy', detail: `${planned.plan.quantity} @ ${q.price} (stop ${planned.plan.stop_loss ?? '—'}): ${v.summary.slice(0, 100)}` }]);
        }
      }
      }
    }
  }

  // ---- 3. Reflect on newly closed trades ----------------------------------
  const reflections = await reflectOnClosedTrades();
  ctx.addActions(reflections);

  ctx.recordTrades(tradesThisRun);
}

function parseLevel(s: string | null, fallback: number): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface ResearchOutcome {
  id: string;
  verdict: string;
  confidence: string;
  summary: string;
  stop_loss: string | null;
}

/** Research one ticker through the standard agent; logs it like any run. */
async function researchOne(ticker: string, lessons: AppData['ai_lessons']): Promise<{ ok: true; outcome: ResearchOutcome } | { ok: false; error: string }> {
  const { quotes } = await getQuotes([ticker]).catch(() => ({ quotes: [] }));
  const q = quotes[0];
  if (!q) return { ok: false, error: `no quote for ${ticker}` };
  const [history, newsBundle, fund] = await Promise.all([
    getPriceHistory(ticker).catch(() => null),
    getTickerNews(ticker, 4).catch(() => ({ news: [] as { title: string }[], sector: null, industry: null })),
    getFundamentals(ticker).catch(() => ({ reason: 'unavailable' })),
  ]);
  const result = await runResearchAgent({
    ticker,
    company: ticker,
    market_summary: `Price ${q.price} as of ${q.as_of} (delayed).`,
    levels_summary: history ? `Last close ${history.last_close}; 6mo range ${history.recent_low}-${history.recent_high}; SMA20 ${history.sma20 ?? 'n/a'}, SMA50 ${history.sma50 ?? 'n/a'}.` : 'No history.',
    news_summary: newsBundle.news.map((n) => n.title).slice(0, 4).join(' | ') || 'No headlines.',
    fundamentals_summary: 'cik' in fund ? `Filed ${fund.source_filed ?? 'unknown'}: revenue ${fund.revenue_usd ?? 'n/a'}, NI ${fund.net_income_usd ?? 'n/a'}.` : 'Unavailable.',
    disclosure_summary: lessonsBlock(lessons),
  });
  if (!result.ok) return { ok: false, error: result.error.slice(0, 200) };
  const v: AgentVerdict = result.verdict;
  const id = randomUUID();
  update((d) => {
    d.verdict_log.push({
      id,
      ticker,
      verdict: v.verdict,
      confidence: v.confidence,
      price_at_call: q.price,
      entry_zone: v.entry_zone,
      exit_target: v.exit_target,
      stop_loss: v.stop_loss,
      hold_horizon: v.hold_horizon,
      grounded_levels: ((v.level_checks ?? []) as { grounded: boolean }[]).filter((c) => c.grounded).length,
      unsupported_levels: ((v.level_checks ?? []) as { grounded: boolean }[]).filter((c) => !c.grounded).length,
      model: v.model,
      created_at: new Date().toISOString(),
      sources_available: true,
      data_notes: 'autonomous fund pass',
    });
    if (d.verdict_log.length > 500) d.verdict_log = d.verdict_log.slice(-500);
    return { committed: true, value: null };
  });
  return {
    ok: true,
    outcome: { id, verdict: v.verdict, confidence: v.confidence, summary: v.summary, stop_loss: v.stop_loss },
  };
}

/** Pick one candidate from today's most actives that we don't already hold. */
async function pickCandidate(d: AppData, held: string[]): Promise<string | null> {
  const movers = await getMovers('most_actives', 20).catch(() => []);
  const candidates = movers.map((m) => m.ticker).filter((t) => !held.includes(t));
  if (candidates.length === 0) return null;
  // Prefer a name the fund has traded before (it has context) else the
  // highest-volume unfamiliar name. Deterministic, no model needed here.
  const pastTrades = new Set(d.ai_fund.trades.map((t) => t.ticker));
  return candidates.find((t) => pastTrades.has(t)) ?? candidates[0];
}

/**
 * Reflection: for each closed round-trip without a lesson yet, ask the model
 * for ONE sentence of what to do differently next time. Stored and injected
 * into future research prompts — this is the "get smarter" loop.
 */
async function reflectOnClosedTrades(): Promise<LoopResult['actions']> {
  const actions: LoopResult['actions'] = [];
  const d = load();
  const closed = d.ai_fund.trades.filter((t) => t.side === 'sell' && typeof t.realized_pnl_usd === 'number');
  const pending = closed.filter((t) => !d.ai_lessons.some((l) => l.trade_id === t.id)).slice(0, 3);
  for (const t of pending) {
    const entryTrade = d.ai_fund.trades.find((x) => x.side === 'buy' && x.ticker === t.ticker && x.executed_at <= t.executed_at);
    const prompt = [
      'A paper-trade round trip just closed. Extract ONE short lesson (max 30 words) for future decisions.',
      `Ticker: ${t.ticker}. Held from ${entryTrade?.executed_at?.slice(0, 10) ?? 'unknown'} to ${t.executed_at.slice(0, 10)}.`,
      `Entry ${entryTrade?.price ?? '?'} -> exit ${t.price}. PnL: ${t.realized_pnl_usd} USD (${t.pnl_pct}%).`,
      `Buy rationale was: ${entryTrade?.rationale ?? 'n/a'}`,
      `Exit rationale was: ${t.rationale}`,
      'Reply with ONLY the lesson sentence. No preamble.',
    ].join('\n');
    const cfg = getAgentConfig();
    const { chatOnce } = await import('./ollamaAgent.js');
    const res = await chatOnce(cfg.model, process.env.OLLAMA_API_KEY?.trim() || '', [
      { role: 'user', content: prompt },
    ], false);
    const lesson = res.message?.content?.trim().slice(0, 300);
    if (res.error || !lesson) { actions.push({ ticker: t.ticker, action: 'reflect-failed', detail: res.error ?? 'empty reflection' }); continue; }
    update((draft) => {
      draft.ai_lessons.unshift({ id: randomUUID(), ticker: t.ticker, trade_id: t.id, lesson, closed_at: new Date().toISOString() });
      draft.ai_lessons = draft.ai_lessons.slice(0, 100);
      return { committed: true, value: null };
    });
    actions.push({ ticker: t.ticker, action: 'lesson', detail: lesson });
  }
  return actions;
}