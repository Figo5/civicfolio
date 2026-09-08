// Track record: score past verdicts against what the market actually did.
//
// Each logged verdict carries the price at call time. Enriching it with the
// CURRENT price and time-elapsed turns the log into an answerable question:
// "was the advice any good?" Directional hit/miss is computed, never judged —
// a HOLD has no direction and shows as un-scored rather than guessed.

import type { VerdictLogEntry, ScoredVerdict } from './types.js';
import { getQuotes } from './quotes.js';

export async function scoreVerdicts(entries: VerdictLogEntry[]): Promise<ScoredVerdict[]> {
  if (entries.length === 0) return [];
  const tickers = [...new Set(entries.map((e) => e.ticker))];
  const { quotes } = await getQuotes(tickers);
  const priceOf = new Map(quotes.map((q) => [q.ticker, q.price]));

  return entries.map((e) => {
    const now = typeof priceOf.get(e.ticker) === 'number' ? priceOf.get(e.ticker) as number : null;
    const elapsed_days = Math.round((Date.now() - Date.parse(e.created_at)) / 86400000);
    const change_pct = now !== null && e.price_at_call
      ? Number((((now - e.price_at_call) / e.price_at_call) * 100).toFixed(2))
      : null;

    // Direction implied by the verdict. HOLD/UNCLEAR are not scored — calling
    // them right or wrong would be inventing a claim the model did not make.
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (e.verdict === 'strong_buy' || e.verdict === 'buy') direction = 'bullish';
    else if (e.verdict === 'avoid') direction = 'bearish';

    const outcome = change_pct === null || direction === 'neutral'
      ? 'un_scored'
      : direction === 'bullish'
        ? (change_pct > 0.5 ? 'correct' : change_pct < -0.5 ? 'wrong' : 'flat')
        : (change_pct < -0.5 ? 'correct' : change_pct > 0.5 ? 'wrong' : 'flat');

    return {
      ...e,
      price_now: now,
      change_pct,
      elapsed_days,
      direction,
      outcome,
    };
  });
}

export function summarizeScored(scored: ScoredVerdict[]) {
  const scoredOnly = scored.filter((s) => s.outcome !== 'un_scored');
  const correct = scoredOnly.filter((s) => s.outcome === 'correct').length;
  const avgChange = scoredOnly.length > 0
    ? Number((scoredOnly.reduce((sum, s) => sum + (s.change_pct ?? 0), 0) / scoredOnly.length).toFixed(2))
    : null;
  const bullish = scoredOnly.filter((s) => s.direction === 'bullish');
  return {
    total: scored.length,
    scored: scoredOnly.length,
    correct,
    wrong: scoredOnly.filter((s) => s.outcome === 'wrong').length,
    hit_rate: scoredOnly.length > 0 ? Math.round((correct / scoredOnly.length) * 100) : null,
    avg_change_pct: avgChange,
    bullish_count: bullish.length,
  };
}