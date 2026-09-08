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
import type { AppData, AiTrade, AiLesson } from './types.js';
import { getQuotes } from './quotes.js';

export const FUND_START_USD = 10_000;
export const MAX_POSITION_PCT = 0.2; // single name <= 20% of fund equity
export const MAX_OPEN_POSITIONS = 6;
export const RISK_PER_TRADE = 0.02; // risk 2% of equity between entry and stop

/** Current equity = cash + marked positions. */
export function fundEquity(d: AppData): number {
  let mv = 0;
  for (const [ticker, pos] of Object.entries(d.ai_fund.positions)) {
    const mark = d.ai_fund.marks[ticker];
    if (typeof mark === 'number') mv += mark * pos.quantity;
    else mv += pos.avg_cost * pos.quantity; // no mark yet: carry at cost
  }
  return d.ai_fund.cash_usd + mv;
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
    fund.marks[plan.ticker] = plan.price;
    if (plan.stop_loss !== null) fund.stops[plan.ticker] = plan.stop_loss;
  } else {
    const existing = fund.positions[plan.ticker];
    if (!existing) throw new Error(`sell without position: ${plan.ticker}`);
    const proceeds = plan.price * plan.quantity;
    const costBasis = existing.avg_cost * plan.quantity;
    const pnl = proceeds - costBasis;
    fund.cash_usd += proceeds;
    existing.quantity -= plan.quantity;
    if (existing.quantity <= 1e-9) {
      delete fund.positions[plan.ticker];
      delete fund.marks[plan.ticker];
      delete fund.stops[plan.ticker];
      // Closed round-trip: ask the model to extract a lesson for next time.
      trade.realized_pnl_usd = Number(pnl.toFixed(2));
      trade.pnl_pct = Number((((plan.price - existing.avg_cost) / existing.avg_cost) * 100).toFixed(2));
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