// Research journal: what the app said, when, against what evidence — enriched
// with a descriptive price change since the observation.
//
// This is deliberately NOT a benchmark. Whether advice was "right" cannot be
// scored from one price point: the entry/exit never traded, the horizon is
// the model's guess, and a single current quote cannot validate a prediction.
// So the journal describes; it does not grade. No hit rate, no correct/wrong.

import type { VerdictLogEntry, ScoredVerdict } from './types.js';
import { getQuotes } from './quotes.js';

export async function scoreVerdicts(entries: VerdictLogEntry[]): Promise<ScoredVerdict[]> {
  if (entries.length === 0) return [];
  const tickers = [...new Set(entries.map((e) => e.ticker))];
  const { quotes, failed } = await getQuotes(tickers);
  const priceOf = new Map(quotes.map((q) => [q.ticker, q.price]));
  const failureOf = new Map(failed.map((f) => [f.ticker, f.reason]));

  return entries.map((e) => {
    const now = typeof priceOf.get(e.ticker) === 'number' ? priceOf.get(e.ticker) as number : null;
    const elapsed_days = Math.round((Date.now() - Date.parse(e.created_at)) / 86400000);
    const change_pct = now !== null && e.price_at_call
      ? Number((((now - e.price_at_call) / e.price_at_call) * 100).toFixed(2))
      : null;

    // Direction implied by the verdict's wording, for description only.
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (e.verdict === 'strong_buy' || e.verdict === 'buy') direction = 'bullish';
    else if (e.verdict === 'avoid') direction = 'bearish';

    return {
      ...e,
      price_now: now,
      change_pct,
      elapsed_days,
      direction,
    };
  });
}

export function summarizeScored(scored: ScoredVerdict[]) {
  // Description only: counts, and an average move across entries that carry a
  // price change. An AVOID entry shows its price change too, but the UI labels
  // it as a description of what followed the call — never "profitable short",
  // never a realized return, never a holding period promoted to a strategy.
  const withChange = scored.filter((s) => s.change_pct !== null);
  const avgChange = withChange.length > 0
    ? Number((withChange.reduce((sum, s) => sum + (s.change_pct ?? 0), 0) / withChange.length).toFixed(2))
    : null;
  const bullish = scored.filter((s) => s.direction === 'bullish');
  return {
    total: scored.length,
    measured: withChange.length,
    unmeasured: scored.length - withChange.length,
    avg_change_pct: avgChange,
    bullish_count: bullish.length,
    disclaimer: 'Descriptive only. Price change since observation reflects the whole market move over the elapsed period, not the quality of the call. No outcome scoring, no hit rate, not strategy performance.',
  };
}