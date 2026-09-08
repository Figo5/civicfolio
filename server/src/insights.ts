// Daily insight screen: pick what is worth a closer look, then hand only the
// shortlist to the AI.
//
// The screen itself is a transparent, arithmetic score over observable market
// facts — no model involved and no hidden weighting. It exists because AI
// research is slow (a minute or more per ticker on a local model), so running
// it across every mover would take half an hour. The screen narrows the field;
// the AI reasons about what survives.
//
// The score is a SORTING heuristic, not a prediction and not a probability.
// Every component is shown so a ranking can be argued with.

import { getMovers, type Mover } from './market.js';

export interface ScoredIdea {
  ticker: string;
  name: string;
  price: number | null;
  change_pct: number | null;
  score: number;
  reasons: string[];
  cautions: string[];
  next_earnings: string | null;
  earnings_in_days: number | null;
  range_position: number | null;
  volume_vs_avg: number | null;
}

function daysTo(iso: string | null): number | null {
  if (!iso) return null;
  const d = Math.round((Date.parse(iso) - Date.now()) / 86400000);
  return Number.isNaN(d) ? null : d;
}

/**
 * Score a mover on observable facts only. Each rule states the fact it fires
 * on, so the reasons list doubles as the explanation of the number.
 */
export function scoreIdea(m: Mover): ScoredIdea {
  const reasons: string[] = [];
  const cautions: string[] = [];
  let score = 0;

  const vol = m.volume_vs_avg;
  if (typeof vol === 'number') {
    if (vol >= 2) { score += 25; reasons.push(`Volume ${vol.toFixed(2)}x its 3-month average — heavy participation`); }
    else if (vol >= 1.3) { score += 15; reasons.push(`Volume ${vol.toFixed(2)}x average — busier than usual`); }
    else if (vol < 0.7) { cautions.push(`Volume only ${vol.toFixed(2)}x average — the move is on thin participation`); }
  }

  const pos = m.range_position;
  if (typeof pos === 'number') {
    if (pos <= 0.15) { score += 20; reasons.push(`Near the bottom of its 52-week range (${Math.round(pos * 100)}%)`); }
    else if (pos >= 0.9) { score += 10; reasons.push(`Pressing the top of its 52-week range (${Math.round(pos * 100)}%)`); cautions.push('Buying at a 52-week extreme carries more downside if momentum breaks'); }
  }

  const chg = m.change_pct;
  if (typeof chg === 'number') {
    if (chg <= -8) { score += 15; reasons.push(`Down ${chg.toFixed(1)}% today — a sharp dislocation`); cautions.push('A sharp drop usually has a cause; find it before treating this as a discount'); }
    else if (chg >= 8) { score += 8; reasons.push(`Up ${chg.toFixed(1)}% today`); cautions.push('Chasing a large single-day gain is how you buy the top'); }
  }

  const earn = daysTo(m.next_earnings);
  if (earn !== null && earn >= 0) {
    if (earn <= 7) { score += 18; reasons.push(`Earnings in ${earn} day(s)${m.earnings_is_estimate ? ' (estimated date)' : ''} — a dated catalyst`); cautions.push('Earnings cut both ways; a position into the print is a coin flip on guidance'); }
    else if (earn <= 21) { score += 10; reasons.push(`Earnings in ${earn} days${m.earnings_is_estimate ? ' (estimated)' : ''}`); }
  }

  // A trend confirmation, deliberately small: it says where price has been,
  // never where it is going.
  const above50 = m.fifty_day_change_pct;
  if (typeof above50 === 'number' && above50 > 0) { score += 6; reasons.push('Trading above its 50-day average'); }

  const pe = m.forward_pe;
  if (typeof pe === 'number') {
    if (pe > 0 && pe < 15) { score += 8; reasons.push(`Forward P/E ${pe.toFixed(1)}`); }
    else if (pe > 80) cautions.push(`Forward P/E ${pe.toFixed(1)} leaves little room for disappointment`);
  }

  if (typeof m.market_cap === 'number' && m.market_cap < 3e8) {
    cautions.push('Micro-cap: thin liquidity and wider spreads');
  }

  return {
    ticker: m.ticker,
    name: m.name,
    price: m.price,
    change_pct: chg,
    score: Math.min(100, score),
    reasons,
    cautions,
    next_earnings: m.next_earnings,
    earnings_in_days: earn,
    range_position: pos,
    volume_vs_avg: vol,
  };
}

export interface InsightBoard {
  generated_at: string;
  best_buys: ScoredIdea[];
  watch: ScoredIdea[];
  earnings_soon: ScoredIdea[];
  universe_size: number;
  notes: string[];
}

/**
 * Build the board from today's movers. Pure screening — no AI, no network
 * beyond the mover feeds, so it returns in about a second.
 */
export async function buildInsights(): Promise<InsightBoard> {
  const [actives, gainers, losers] = await Promise.all([
    getMovers('most_actives', 25).catch(() => [] as Mover[]),
    getMovers('day_gainers', 25).catch(() => [] as Mover[]),
    getMovers('day_losers', 25).catch(() => [] as Mover[]),
  ]);

  const seen = new Map<string, Mover>();
  for (const m of [...actives, ...gainers, ...losers]) if (!seen.has(m.ticker)) seen.set(m.ticker, m);

  const scored = [...seen.values()].map(scoreIdea).sort((a, b) => b.score - a.score);

  const earningsSoon = scored
    .filter((s) => s.earnings_in_days !== null && s.earnings_in_days >= 0 && s.earnings_in_days <= 14)
    .slice(0, 6);

  return {
    generated_at: new Date().toISOString(),
    // "Best" here means highest-scoring on the rules above, nothing more.
    best_buys: scored.filter((s) => s.score >= 30).slice(0, 5),
    watch: scored.filter((s) => s.score >= 15 && s.score < 30).slice(0, 6),
    earnings_soon: earningsSoon,
    universe_size: seen.size,
    notes: [
      `Screened ${seen.size} of today's most active, rising and falling stocks.`,
      'Ranking is arithmetic over observable facts — volume against average, position in the 52-week range, size of today\'s move, earnings proximity, trend and forward P/E. Each score shows the rules that fired.',
      'This is a shortlist to research, not a recommendation. Nothing here predicts a price, and a high score mostly means "unusual today".',
    ],
  };
}
