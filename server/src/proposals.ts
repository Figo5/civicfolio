// Stock proposal engine — scores STORED DISCLOSURE DATA into watchable ideas.
//
// This is a transparent heuristic screener over records you imported, not an
// advisory service and not an LLM. The signal is thin and delayed by law
// (weeks between transaction and publication, amounts are ranges), so every
// proposal ships with its reasons, the counterargument, and explicit caveats.
// No prices, targets, or probability scores are invented.

import type { AppData, DisclosureRecord } from './types.js';
import { getQuotes } from './quotes.js';

export interface Proposal {
  ticker: string;
  company: string;
  score: number; // transparent 0-100 heuristic, not a probability
  buys: number;
  sells: number;
  buy_owners: string[];
  sell_owners: string[];
  total_min_usd: number;
  total_max_usd: number;
  total_range_label: string;
  latest_tx: string;
  latest_published: string;
  days_since_published: number;
  reasons: string[];
  counterpoints: string[];
  record_ids: string[];
  source_urls: (string | null)[];
  data_modes: string[];
  // Delayed/unofficial quote when one resolves; absent stays absent.
  quote: { price: number; previous_close: number | null; as_of: string; source: string } | null;
}

// Cap per-owner influence: one person trading 5 times counts once per side.
function ownersOf(records: DisclosureRecord[], side: 'purchase' | 'sale'): string[] {
  return [...new Set(records.filter((r) => r.tx_type === side).map((r) => r.owner))];
}

function latestCompanyOf(rs: DisclosureRecord[]): string {
  return [...rs].sort((a, b) => b.published_date.localeCompare(a.published_date))[0]?.company ?? '';
}

export async function buildProposals(data: AppData, now = new Date()): Promise<{
  generated_at: string;
  window_days: number;
  proposals: Proposal[];
  notes: string[];
}> {
  const windowDays = 180;
  const cutoff = new Date(now.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  const recent = data.disclosures.filter((r) => r.published_date >= cutoff);

  // Group by ticker.
  const byTicker = new Map<string, DisclosureRecord[]>();
  for (const r of recent) {
    const list = byTicker.get(r.ticker);
    if (list) list.push(r);
    else byTicker.set(r.ticker, [r]);
  }

  const proposals: Proposal[] = [];
  // Instrument-name filter: the upstream feed labels municipal notes, funds and
  // similar non-common-stock instruments under ticker-like symbols. Those are
  // not stock ideas, so they stay in trends but are not proposed.
  const NOT_COMMON_STOCK = /\bnotes?\b|\bbonds?\b|anticipation|fund\b|etf\b|treasur|\bdebenture/i;
  for (const [ticker, rs] of byTicker) {
    const buys = rs.filter((r) => r.tx_type === 'purchase');
    const sells = rs.filter((r) => r.tx_type === 'sale');
    const buyOwners = ownersOf(rs, 'purchase');
    const sellOwners = ownersOf(rs, 'sale');
    if (buyOwners.length === 0) continue; // proposals are buy-side only
    if (NOT_COMMON_STOCK.test(buys[0]?.company ?? latestCompanyOf(rs))) continue;

    const totalMin = rs.reduce((s, r) => s + r.amount_min_usd, 0);
    const totalMax = rs.reduce((s, r) => s + r.amount_max_usd, 0);
    const latest = [...rs].sort((a, b) => b.published_date.localeCompare(a.published_date))[0];
    const daysSince = Math.floor((now.getTime() - Date.parse(latest.published_date + 'T00:00:00Z')) / 86400000);

    const reasons: string[] = [];
    const counterpoints: string[] = [];

    // Distinct buyers is the strongest signal (one person's repeat trades is noise).
    reasons.push(`${buyOwners.length} distinct filer${buyOwners.length > 1 ? 's' : ''} bought in the last ${windowDays} days`);
    if (buyOwners.length >= 3) reasons.push('cluster of independent filers — strongest pattern this data can show');
    if (sells.length === 0 && buys.length > 0) reasons.push('no disclosed sales in the window');

    if (totalMax >= 250_000) reasons.push(`aggregate filed range up to $${Math.round(totalMax / 1000)}k`);
    if (daysSince <= 14) reasons.push(`published ${daysSince === 0 ? 'today' : `${daysSince}d ago`} — recent filing`);

    if (sellOwners.length > 0) counterpoints.push(`${sellOwners.length} filer${sellOwners.length > 1 ? 's' : ''} also sold`);
    counterpoints.push('amounts are filed ranges, not exact values');
    counterpoints.push('filings lag trades by weeks — the signal is stale by construction');
    if (rs.length < 3) counterpoints.push('very small sample');
    if (latest.data_mode === 'demo') counterpoints.push('includes synthetic demo records — fictional owners');

    // Transparent score: distinct buyers dominate; sells and recency nudge.
    const score = Math.min(100,
      buyOwners.length * 22
      + (sells.length === 0 ? 10 : 0)
      + (daysSince <= 14 ? 8 : 0)
      + (totalMax >= 250_000 ? 8 : 0)
      + (rs.length >= 5 ? 4 : 0)
    );

    proposals.push({
      ticker,
      company: latest.company,
      score,
      buys: buys.length,
      sells: sells.length,
      buy_owners: buyOwners,
      sell_owners: sellOwners,
      total_min_usd: totalMin,
      total_max_usd: totalMax,
      total_range_label: totalMin === totalMax
        ? `$${Math.round(totalMin / 1e3)}k`
        : `$${Math.round(totalMin / 1e3)}k–$${totalMax >= 1e6 ? `${(totalMax / 1e6).toFixed(1)}M` : `${Math.round(totalMax / 1e3)}k`}`,
      latest_tx: latest.tx_date_max,
      latest_published: latest.published_date,
      days_since_published: daysSince,
      reasons,
      counterpoints,
      record_ids: rs.map((r) => r.id),
      source_urls: rs.map((r) => r.source_url),
      data_modes: [...new Set(rs.map((r) => r.data_mode))],
      quote: null, // filled below, after the loop
    });
  }

  proposals.sort((a, b) => b.score - a.score || b.total_max_usd - a.total_max_usd);

  // Best-effort delayed quotes for the top proposals (cap 12 to stay polite to
  // the upstream). A missing quote stays null — never a fabricated price.
  const withQuotes = await getQuotes(proposals.slice(0, 12).map((p) => p.ticker));
  const byTickerQuote = new Map(withQuotes.quotes.map((q) => [q.ticker, q]));
  for (const p of proposals) {
    const q = byTickerQuote.get(p.ticker);
    if (q) p.quote = { price: q.price, previous_close: q.previous_close, as_of: q.as_of, source: q.source };
  }

  const notes = [
    `Built from ${recent.length} disclosure record(s) published in the last ${windowDays} days in your local store.`,
    'Disclosures are delayed, amounts are ranges, and reported trades are not complete holdings. Absence of a filing is not absence of activity.',
    'This is a heuristic over public filings, not investment advice — and it cannot see price, valuation, or fundamentals relative to price.',
  ];

  return { generated_at: now.toISOString(), window_days: windowDays, proposals, notes };
}

export interface Trends {
  generated_at: string;
  window_days: number;
  most_bought: { ticker: string; company: string; buyers: number; trades: number; total_max_usd: number }[];
  most_sold: { ticker: string; company: string; sellers: number; trades: number; total_max_usd: number }[];
  by_volume: { ticker: string; company: string; trades: number; total_max_usd: number }[];
  top_filers: { owner: string; trades: number; tickers: number }[];
}

export function buildTrends(data: AppData, now = new Date()): Trends {
  const windowDays = 180;
  const cutoff = new Date(now.getTime() - windowDays * 86400000).toISOString().slice(0, 10);
  const recent = data.disclosures.filter((r) => r.published_date >= cutoff);

  const group = (keyFn: (r: DisclosureRecord) => string) => {
    const m = new Map<string, DisclosureRecord[]>();
    for (const r of recent) {
      const k = keyFn(r);
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    return m;
  };

  const byTicker = group((r) => r.ticker);
  const shape = (rs: DisclosureRecord[]) => {
    const latest = [...rs].sort((a, b) => b.published_date.localeCompare(a.published_date))[0];
    return {
      ticker: latest.ticker,
      company: latest.company,
      trades: rs.length,
      total_max_usd: rs.reduce((s, r) => s + r.amount_max_usd, 0),
    };
  };

  const most_bought = [...byTicker.entries()]
    .map(([_, rs]) => ({ ...shape(rs), buyers: ownersOf(rs, 'purchase').length }))
    .filter((x) => x.buyers > 0)
    .sort((a, b) => b.buyers - a.buyers || b.total_max_usd - a.total_max_usd)
    .slice(0, 8);

  const most_sold = [...byTicker.entries()]
    .map(([_, rs]) => ({ ...shape(rs), sellers: ownersOf(rs, 'sale').length }))
    .filter((x) => x.sellers > 0)
    .sort((a, b) => b.sellers - a.sellers || b.total_max_usd - a.total_max_usd)
    .slice(0, 8);

  const by_volume = [...byTicker.entries()]
    .map(([_, rs]) => shape(rs))
    .sort((a, b) => b.total_max_usd - a.total_max_usd)
    .slice(0, 8);

  const byOwner = group((r) => r.owner);
  const top_filers = [...byOwner.entries()]
    .map(([owner, rs]) => ({ owner, trades: rs.length, tickers: new Set(rs.map((r) => r.ticker)).size }))
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 6);

  return { generated_at: now.toISOString(), window_days: windowDays, most_bought, most_sold, by_volume, top_filers };
}