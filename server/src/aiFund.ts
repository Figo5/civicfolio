// The AI fund: the agent trades FAKE money on its own research, and every
// closed trade feeds a reflection loop that makes future research sharper.
//
// Hard rules:
// - Paper only. There is no broker connection anywhere in this app; the fund
//   is a JSON object. Nothing here can touch real money.
// - Trades execute ONLY at real (delayed) quotes fetched at decision time —
//   never at a price the model typed.
// - Position sizing is deterministic arithmetic (risk-based), not a model
//   output, so a hallucinated "bet 80%" cannot happen.
// - The model decides WHAT and WHEN; the code decides HOW MUCH and enforces
//   the guardrails (single-name cap, cash floor, one position per ticker).

import { randomUUID } from 'node:crypto';
import type { AppData, AiTrade, AiLesson, AiFundMark } from './types.js';
import { getQuotes } from './quotes.js';
import type { Quote } from './quotes.js';
import { systemClock, type Clock } from './clock.js';
import { load, update } from './store.js';

export const FUND_START_USD = 10_000;
export const MAX_POSITION_PCT = 0.2; // single name <= 20% of fund equity
export const MAX_OPEN_POSITIONS = 6;
export const RISK_PER_TRADE = 0.02; // risk 2% of equity between entry and stop
export const MIN_HOLD_DAYS = 2; // thesis-exits blocked within 2 days of entry (stops always allowed)
export const REBUY_COOLDOWN_DAYS = 3; // no re-buying a ticker within 3 days of selling it

/** Days since an ISO timestamp (fractional). */
export function daysSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400000;
}

/** Last time the fund sold `ticker` (for the re-entry cooldown), or null. */
export function lastSellOf(d: AppData, ticker: string): string | null {
  for (const t of d.ai_fund.trades) {
    if (t.side === 'sell' && t.ticker === ticker) return t.executed_at;
  }
  return null;
}

/** The effective mark for a position: its known price, or cost when nothing is known. */
export function effectiveMark(d: AppData, ticker: string): { price: number; mark: AiFundMark | null; carrying_at_cost: boolean } {
  const pos = d.ai_fund.positions[ticker];
  if (!pos) return { price: 0, mark: null, carrying_at_cost: false };
  const mark = d.ai_fund.marks[ticker] ?? null;
  if (mark && typeof mark.price === 'number') return { price: mark.price, mark, carrying_at_cost: false };
  return { price: pos.avg_cost, mark: null, carrying_at_cost: true };
}

/** Current equity = cash + marked positions. Unmarked positions carry at cost. */
export function fundEquity(d: AppData): number {
  let mv = 0;
  for (const [ticker, pos] of Object.entries(d.ai_fund.positions)) {
    const mark = d.ai_fund.marks[ticker];
    if (mark && typeof mark.price === 'number') mv += mark.price * pos.quantity;
    else mv += pos.avg_cost * pos.quantity; // no mark yet: carry at cost
  }
  return d.ai_fund.cash_usd + mv;
}

/** True when any held position lacks a confirmed mark (stale or none at all). */
export function marksAreStale(d: AppData): boolean {
  for (const ticker of Object.keys(d.ai_fund.positions)) {
    const mark = d.ai_fund.marks[ticker];
    if (!mark || mark.stale === true) return true;
  }
  return false;
}

export interface MarkRefreshResult {
  updated: string[]; // tickers whose marks were confirmed fresh
  failed: { ticker: string; reason: string }[]; // quotes unavailable: marks retained, labelled stale
  fetched_at: string;
}

// Test seam for route-level tests: when set, refreshFundMarks() uses this
// provider instead of the real network getQuotes. Production behavior is
// unchanged (null default). Explicit function-injection remains available via
// the parameter below — this global is only for HTTP-route tests where the
// provider cannot be passed through the route.
let quoteProviderOverride: typeof getQuotes | null = null;
export function setQuoteProviderForTests(p: typeof getQuotes | null): void {
  quoteProviderOverride = p;
}

/**
 * Mark every held position to market WITHOUT trading. Each quote is stored
 * with its exchange timestamp (as_of) and this app's fetch timestamp — an old
 * price is never relabelled with the current time. A failed quote RETAINS the
 * last known mark, labelled stale. The quote provider is injectable so tests
 * never touch the network (production default: getQuotes).
 */
export async function refreshFundMarks(
  quoteProvider: typeof getQuotes | null = null,
  clock: Clock = systemClock,
): Promise<MarkRefreshResult> {
  const provider = quoteProvider ?? quoteProviderOverride ?? getQuotes;
  const d = load();
  const tickers = Object.keys(d.ai_fund.positions);
  const fetched_at = new Date(clock()).toISOString();
  if (tickers.length === 0) return { updated: [], failed: [], fetched_at };

  const { quotes, failed } = await provider(tickers).catch(() => ({ quotes: [] as Quote[], failed: tickers.map((t) => ({ ticker: t, reason: 'quote request failed' })) }));
  const byTicker = new Map(quotes.map((q) => [q.ticker, q]));

  update((draft) => {
    for (const ticker of tickers) {
      const q = byTicker.get(ticker);
      const pos = draft.ai_fund.positions[ticker];
      if (!pos) continue;
      if (q && typeof q.price === 'number' && Number.isFinite(q.price) && q.price > 0) {
        draft.ai_fund.marks[ticker] = {
          price: q.price,
          quote_as_of: q.as_of,
          fetched_at,
          source: 'quote',
          quote_source: q.source,
          stale: false,
        };
      } else {
        // Quote unavailable: retain the last known mark, label it stale.
        const prev = draft.ai_fund.marks[ticker];
        if (prev) draft.ai_fund.marks[ticker] = { ...prev, stale: true };
        // No prior mark at all: nothing to retain — equity keeps carrying at
        // cost, which the API surfaces explicitly.
      }
    }
    return { committed: true, value: null as unknown };
  });

  const updated = tickers.filter((t) => byTicker.has(t));
  const failedOut = [...failed.filter((f) => tickers.includes(f.ticker))];
  for (const t of tickers) {
    if (!byTicker.has(t) && !failedOut.some((f) => f.ticker === t)) {
      failedOut.push({ ticker: t, reason: 'no quote returned' });
    }
  }
  return { updated, failed: failedOut, fetched_at };
}

/** Read-only valuation summary for one holding, with freshness. */
export function positionView(d: AppData, ticker: string): {
  ticker: string; quantity: number; avg_cost: number;
  mark: number; mark_freshness: {
    price_known: boolean;
    carrying_at_cost: boolean;
    stale: boolean;
    quote_as_of: string | null;
    fetched_at: string | null;
    quote_source: string | null;
  };
  value_usd: number; pnl_usd: number; stop: number | null;
} {
  const pos = d.ai_fund.positions[ticker];
  const { price, mark, carrying_at_cost } = effectiveMark(d, ticker);
  const mv = price * pos.quantity;
  return {
    ticker,
    quantity: pos.quantity,
    avg_cost: pos.avg_cost,
    mark: price,
    mark_freshness: {
      price_known: !!mark,
      carrying_at_cost,
      stale: mark?.stale === true,
      quote_as_of: mark?.quote_as_of ?? null,
      fetched_at: mark?.fetched_at ?? null,
      quote_source: mark?.quote_source ?? null,
    },
    value_usd: Number(mv.toFixed(2)),
    pnl_usd: Number((mv - pos.avg_cost * pos.quantity).toFixed(2)),
    stop: d.ai_fund.stops[ticker] ?? null,
  };
}

export interface PlannedTrade {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  stop_loss: number | null;
  rationale: string;
  verdict_id: string;
}

/**
 * Turn a research verdict into a planned trade with deterministic sizing.
 * Returns null when the verdict does not justify a trade or a guardrail
 * blocks it — the reason string says which.
 */
export function planTradeFromVerdict(d: AppData, args: {
  ticker: string;
  verdict: string;
  confidence: string;
  price: number;
  entry: number | null;
  stop: number | null;
  rationale: string;
  verdict_id: string;
  lessons: AiLesson[];
}): { ok: true; plan: PlannedTrade } | { ok: false; reason: string } {
  const { ticker, verdict, confidence, price, stop, rationale, verdict_id } = args;
  const fund = d.ai_fund;
  const equity = fundEquity(d);
  const held = fund.positions[ticker];

  if (verdict === 'avoid' || verdict === 'unclear' || verdict === 'hold') {
    if (held && (verdict === 'avoid')) {
      return { ok: true, plan: { ticker, side: 'sell', quantity: held.quantity, price, stop_loss: null, rationale, verdict_id } };
    }
    return { ok: false, reason: `verdict ${verdict} does not open a position` };
  }
  if (verdict !== 'buy' && verdict !== 'strong_buy') {
    return { ok: false, reason: `unknown verdict ${verdict}` };
  }
  if (Object.keys(fund.positions).length >= MAX_OPEN_POSITIONS && !held) {
    return { ok: false, reason: `max ${MAX_OPEN_POSITIONS} open positions reached` };
  }
  if (confidence === 'low') {
    return { ok: false, reason: 'confidence too low to trade' };
  }

  // Stop distance drives size: risk 2% of equity between price and stop.
  const stopDist = stop !== null && stop > 0 && stop < price ? price - stop : price * 0.08; // default 8% mental stop
  if (stopDist <= 0) return { ok: false, reason: 'bad stop distance' };
  const riskBudget = equity * RISK_PER_TRADE;
  let qty = Math.floor((riskBudget / stopDist) * 1000) / 1000;

  // Single-name cap: 20% of equity at current price.
  const maxQty = Math.floor(((equity * MAX_POSITION_PCT) / price) * 1000) / 1000;
  qty = Math.min(qty, maxQty);

  // Cash floor: keep 10% cash.
  const maxSpendable = fund.cash_usd - equity * 0.1;
  if (maxSpendable <= 0) return { ok: false, reason: 'cash floor reached' };
  qty = Math.min(qty, Math.floor((maxSpendable / price) * 1000) / 1000);

  if (qty * price < equity * 0.005) return { ok: false, reason: 'planned position below minimum size' };

  return {
    ok: true,
    plan: { ticker, side: 'buy', quantity: qty, price, stop_loss: stop, rationale, verdict_id },
  };
}

/** Execute a planned trade against the fake fund at a real fetched quote. */
export function executeAiTrade(d: AppData, plan: PlannedTrade, quoteAsOf: string): AiTrade {
  const fund = d.ai_fund;
  const cost = plan.price * plan.quantity;
  const trade: AiTrade = {
    id: randomUUID(),
    verdict_id: plan.verdict_id,
    ticker: plan.ticker,
    side: plan.side,
    quantity: plan.quantity,
    price: plan.price,
    quote_as_of: quoteAsOf,
    executed_at: new Date().toISOString(),
    rationale: plan.rationale,
  };

  if (plan.side === 'buy') {
    fund.cash_usd -= cost;
    const existing = fund.positions[plan.ticker];
    if (existing) {
      const newQty = existing.quantity + plan.quantity;
      fund.positions[plan.ticker] = { quantity: newQty, avg_cost: (existing.avg_cost * existing.quantity + cost) / newQty };
    } else {
      fund.positions[plan.ticker] = { quantity: plan.quantity, avg_cost: plan.price };
    }
    fund.marks[plan.ticker] = { price: plan.price, quote_as_of: quoteAsOf, fetched_at: trade.executed_at, source: 'trade', stale: false };
    if (plan.stop_loss !== null) fund.stops[plan.ticker] = plan.stop_loss;
  } else {
    const existing = fund.positions[plan.ticker];
    if (!existing) throw new Error(`sell without position: ${plan.ticker}`);
    const proceeds = plan.price * plan.quantity;
    const costBasis = existing.avg_cost * plan.quantity;
    const pnl = proceeds - costBasis;
    const pnlPct = ((plan.price - existing.avg_cost) / existing.avg_cost) * 100;
    fund.cash_usd += proceeds;
    existing.quantity -= plan.quantity;
    if (existing.quantity <= 1e-9) {
      delete fund.positions[plan.ticker];
      delete fund.marks[plan.ticker];
      delete fund.stops[plan.ticker];
      // Closed round-trip: ask the model to extract a lesson for next time.
      trade.realized_pnl_usd = Number(pnl.toFixed(2));
      trade.pnl_pct = Number(pnlPct.toFixed(2));
    }
  }
  fund.trades.unshift(trade);
  fund.trades = fund.trades.slice(0, 500);
  return trade;
}

/** Lessons the reflection loop has written, newest first, injected into prompts. */
export function lessonsBlock(lessons: AiLesson[]): string {
  if (lessons.length === 0) return '';
  return 'Lessons from this fund\'s own closed trades (most recent first):\n' +
    lessons.slice(0, 8).map((l) => `- [${l.ticker} ${l.closed_at.slice(0, 10)}] ${l.lesson}`).join('\n');
}