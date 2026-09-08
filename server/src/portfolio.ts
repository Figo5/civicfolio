import type { AppData, PaperTrade, PortfolioState, TrackedIdea, WatchlistItem } from './types.js';
import { isFiniteNumber, normalizeTicker, cleanText, isIsoDate, isIsoDateTime } from './validate.js';
import { randomUUID } from 'node:crypto';

// Paper portfolio engine. Paper only — no brokerage execution path exists.

export const STARTING_CASH = 100000;

// Practical limits guarding derived arithmetic (qty * price etc.). These are
// sanity caps against absurd/hostile inputs, not policy about strategy size.
export const MAX_NOTIONAL_USD = 100_000_000; // $100M per order
export const MAX_QUANTITY = 1_000_000_000;
export const MAX_PRICE_USD = 10_000_000; // $10M per share

export interface TradeResult {
  ok: boolean;
  error?: string;
  trade?: PaperTrade;
  portfolio?: PortfolioState;
  duplicate?: boolean; // true when this is a replayed identical idempotent request
}

const PRICE_SOURCE_VALUES = new Set(['user_entered', 'demo']);

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function submitTrade(data: AppData, input: unknown): TradeResult {
  const body = (input ?? {}) as Record<string, unknown>;

  const clientRequestId = typeof body.client_request_id === 'string' && body.client_request_id.trim() !== ''
    ? body.client_request_id.trim().slice(0, 100)
    : undefined;

  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return { ok: false, error: 'ticker must be 1-10 letters A-Z' };

  const side = typeof body.side === 'string' ? body.side.toUpperCase() : '';
  if (side !== 'BUY' && side !== 'SELL') return { ok: false, error: 'side must be BUY or SELL' };

  const qty = body.quantity;
  if (!isFiniteNumber(qty) || (qty as number) <= 0) return { ok: false, error: 'quantity must be a positive finite number' };
  if ((qty as number) > MAX_QUANTITY) return { ok: false, error: `quantity exceeds practical limit (${MAX_QUANTITY})` };

  const price = body.price;
  if (!isFiniteNumber(price) || (price as number) <= 0) return { ok: false, error: 'price must be a positive finite number' };
  if ((price as number) > MAX_PRICE_USD) return { ok: false, error: `price exceeds practical limit (${MAX_PRICE_USD})` };

  const priceSource = typeof body.price_source === 'string' && PRICE_SOURCE_VALUES.has(body.price_source)
    ? (body.price_source as PaperTrade['price_source'])
    : 'user_entered';

  const tradeDate = isIsoDate(body.trade_date) ? body.trade_date : new Date().toISOString().slice(0, 10);
  const createdAt = isIsoDateTime(body.created_at) ? body.created_at : new Date().toISOString();

  const note = cleanText(body.note, 300) || undefined;

  // --- idempotency: replayed request with the same key ---------------------
  // Same key + same payload → return the original trade without re-executing.
  // Same key + different payload → reject as a conflict.
  if (clientRequestId) {
    const prior = data.trades.find((t) => t.client_request_id === clientRequestId);
    if (prior) {
      const same = prior.ticker === ticker && prior.side === side
        && prior.quantity === qty && prior.price === price
        && prior.price_source === priceSource && prior.trade_date === tradeDate;
      if (same) return { ok: true, duplicate: true, trade: prior, portfolio: data.portfolio };
      return { ok: false, error: `client_request_id ${clientRequestId} was already used with a different payload` };
    }
  }

  // --- derived arithmetic must stay finite and non-trivial ------------------
  const rawNotional = (qty as number) * (price as number);
  if (!Number.isFinite(rawNotional)) {
    return { ok: false, error: 'order notional is not a finite number (quantity × price overflow)' };
  }
  const notional = Math.round(rawNotional * 100) / 100;
  if (notional <= 0) {
    return { ok: false, error: 'order notional rounds to zero — sub-cent orders are not accepted' };
  }
  if (notional > MAX_NOTIONAL_USD) {
    return { ok: false, error: `order notional exceeds practical limit ($${MAX_NOTIONAL_USD.toLocaleString('en-US')})` };
  }

  const positions = data.portfolio.positions;
  const pos = positions[ticker] ?? { quantity: 0, cost_basis_usd: 0 };

  if (side === 'BUY') {
    if (notional > data.portfolio.cash_usd + 1e-9) {
      return { ok: false, error: `insufficient cash: need $${notional.toFixed(2)}, available $${data.portfolio.cash_usd.toFixed(2)}` };
    }
    const trade: PaperTrade = {
      id: `trade-${randomUUID()}`,
      ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
      ticker, side: 'BUY', quantity: qty as number, price: price as number,
      price_source: priceSource, trade_date: tradeDate, created_at: createdAt, note,
    };
    data.trades.push(trade);
    positions[ticker] = {
      quantity: pos.quantity + (qty as number),
      cost_basis_usd: Math.round((pos.cost_basis_usd + notional) * 100) / 100,
    };
    data.portfolio.cash_usd = Math.round((data.portfolio.cash_usd - notional) * 100) / 100;
    return { ok: true, trade, portfolio: data.portfolio };
  }

  // SELL
  if ((qty as number) > pos.quantity + 1e-9) {
    return { ok: false, error: `cannot sell ${qty} ${ticker}: only ${pos.quantity} held` };
  }
  const trade: PaperTrade = {
    id: `trade-${randomUUID()}`,
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
    ticker, side: 'SELL', quantity: qty as number, price: price as number,
    price_source: priceSource, trade_date: tradeDate, created_at: createdAt, note,
  };
  data.trades.push(trade);
  const avgCost = pos.quantity > 0 ? pos.cost_basis_usd / pos.quantity : 0;
  const newQty = pos.quantity - (qty as number);
  const newBasis = Math.max(0, Math.round((pos.cost_basis_usd - avgCost * (qty as number)) * 100) / 100);
  if (newQty <= 1e-9) delete positions[ticker];
  else positions[ticker] = { quantity: newQty, cost_basis_usd: newBasis };
  data.portfolio.cash_usd = Math.round((data.portfolio.cash_usd + notional) * 100) / 100;
  return { ok: true, trade, portfolio: data.portfolio };
}

export function addIdea(data: AppData, input: unknown): { ok: boolean; error?: string; idea?: TrackedIdea } {
  const body = (input ?? {}) as Record<string, unknown>;
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return { ok: false, error: 'ticker must be 1-10 letters A-Z' };
  const thesis = cleanText(body.thesis, 500);
  if (!thesis) return { ok: false, error: 'thesis is required' };
  const status = body.status === 'archived' || body.status === 'watching' ? body.status : 'researching';
  const idea: TrackedIdea = {
    id: `idea-${randomUUID()}`,
    ticker, company: cleanText(body.company, 200) || ticker, thesis,
    status: status as TrackedIdea['status'], created_at: new Date().toISOString(),
  };
  data.ideas.push(idea);
  return { ok: true, idea };
}

export function addWatchlistItem(data: AppData, input: unknown): { ok: boolean; error?: string; item?: WatchlistItem } {
  const body = (input ?? {}) as Record<string, unknown>;
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return { ok: false, error: 'ticker must be 1-10 letters A-Z' };
  const thesis = cleanText(body.thesis, 500);
  if (!thesis) return { ok: false, error: 'thesis is required' };
  const item: WatchlistItem = {
    id: `watch-${randomUUID()}`,
    ticker, company: cleanText(body.company, 200) || ticker, thesis,
    added_at: new Date().toISOString(),
  };
  data.watchlist.push(item);
  return { ok: true, item };
}

export function removeIdea(data: AppData, id: string): boolean {
  const before = data.ideas.length;
  data.ideas = data.ideas.filter((i) => i.id !== id);
  return data.ideas.length < before;
}

export function removeWatchlistItem(data: AppData, id: string): boolean {
  const before = data.watchlist.length;
  data.watchlist = data.watchlist.filter((w) => w.id !== id);
  return data.watchlist.length < before;
}

/**
 * Record a user-entered mark price for a held ticker so the UI can show
 * unrealized gain/loss. This is NOT market data — the app has no quote source.
 * Passing null/0 clears the mark.
 */
export function setMark(data: AppData, input: unknown): { ok: boolean; error?: string; portfolio?: PortfolioState } {
  const body = (input ?? {}) as Record<string, unknown>;
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return { ok: false, error: 'ticker must be 1-10 letters A-Z' };
  if (!data.portfolio.positions[ticker]) {
    return { ok: false, error: `no open position in ${ticker}; marks apply to held positions only` };
  }
  if (!data.portfolio.marks) data.portfolio.marks = {};

  // null / absent clears the mark rather than storing a meaningless zero.
  if (body.price === null || body.price === undefined || body.price === '') {
    delete data.portfolio.marks[ticker];
    return { ok: true, portfolio: data.portfolio };
  }

  const price = body.price;
  if (!isFiniteNumber(price) || (price as number) <= 0) {
    return { ok: false, error: 'mark price must be a positive finite number' };
  }
  if ((price as number) > MAX_PRICE_USD) {
    return { ok: false, error: `mark price exceeds practical limit (${MAX_PRICE_USD})` };
  }
  const isQuote = body.source === 'quote';
  data.portfolio.marks[ticker] = {
    price: price as number,
    marked_at: new Date().toISOString(),
    source: isQuote ? 'quote' : 'user',
    ...(isQuote && typeof body.quote_source === 'string' ? { quote_source: body.quote_source.slice(0, 40) } : {}),
  };
  return { ok: true, portfolio: data.portfolio };
}

export function portfolioSummary(data: AppData) {
  const marks = data.portfolio.marks ?? {};
  const positions = Object.entries(data.portfolio.positions).map(([ticker, p]) => {
    const avgCost = p.quantity > 0 ? Math.round((p.cost_basis_usd / p.quantity) * 100) / 100 : 0;
    const mark = marks[ticker];
    // Value only where the user actually supplied a mark. No mark -> nulls, so
    // the UI shows cost basis instead of inventing a number.
    const marketValue = mark ? round2(mark.price * p.quantity) : null;
    return {
      ticker,
      quantity: p.quantity,
      cost_basis_usd: p.cost_basis_usd,
      avg_cost: avgCost,
      mark_price: mark ? mark.price : null,
      marked_at: mark ? mark.marked_at : null,
      mark_source: mark ? (mark.source ?? 'user') : null,
      quote_source: mark?.quote_source ?? null,
      market_value_usd: marketValue,
      unrealized_pl_usd: marketValue === null ? null : round2(marketValue - p.cost_basis_usd),
      unrealized_pl_pct: marketValue === null || p.cost_basis_usd === 0
        ? null
        : Math.round(((marketValue - p.cost_basis_usd) / p.cost_basis_usd) * 1000) / 10,
    };
  });
  const totalCost = positions.reduce((s, p) => s + p.cost_basis_usd, 0);
  const marked = positions.filter((p) => p.market_value_usd !== null);
  // Marked value counts marked positions at their mark and the rest at cost, so
  // the total is never a mix of real and imagined numbers without saying so.
  const markedValue = positions.reduce((s, p) => s + (p.market_value_usd ?? p.cost_basis_usd), 0);
  return {
    cash_usd: data.portfolio.cash_usd,
    positions,
    invested_cost_usd: round2(totalCost),
    account_cost_usd: round2(totalCost + data.portfolio.cash_usd),
    marked_positions_count: marked.length,
    marked_value_usd: marked.length ? round2(markedValue) : null,
    account_marked_usd: marked.length ? round2(markedValue + data.portfolio.cash_usd) : null,
    unrealized_pl_usd: marked.length ? round2(markedValue - totalCost) : null,
    trade_count: data.trades.length,
  };
}