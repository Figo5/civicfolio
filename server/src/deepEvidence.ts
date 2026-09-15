// Verified evidence packet for the experimental Deep Research workflow.
//
// EXPERIMENTAL and read-only. Nothing here trades, writes to the portfolio, or
// touches the paper fund. It is only reachable when the Deep Research flag is
// enabled (see isDeepResearchEnabled).
//
// TradingAgents-inspired (see docs/DEEP_RESEARCH_EXPERIMENT.md for the reviewed
// upstream commit). Three patterns are adapted, not imported: identity is
// resolved deterministically *before* any model runs; every price/metric claim
// is grounded in one frozen snapshot rather than re-fetched mid-analysis; and
// point-in-time filtering is explicit about what it can and cannot enforce.
// No upstream code is used, and no Python/LangGraph is involved.
//
// The guiding rule: a provider returning a value is not verification. Identity,
// dates, units and internal consistency are checked here, and anything that
// cannot be established stays an explicit unknown instead of a confident label.

import { getQuotes, type Quote } from './quotes.js';
import { getPriceHistory, getTickerNews, getMovers, type PriceHistory, type Mover, type NewsItem } from './market.js';
import { getFundamentals, type Fundamentals } from './fundamentals.js';

/** The experiment is off unless explicitly switched on, in production too. */
export function isDeepResearchEnabled(): boolean {
  const v = (process.env.CIVICFOLIO_DEEP_RESEARCH ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// ---- evidence items -------------------------------------------------------

export type EvidenceKind = 'quote' | 'levels' | 'fundamentals' | 'news' | 'web';

/**
 * One citable fact.
 *
 * The three times are deliberately separate, because collapsing them is how a
 * stale article becomes "current evidence":
 *   - published_at: when the claim was published / became available
 *   - period_end:   the period or event the claim is *about*
 *   - retrieved_at: when this app fetched it (never a substitute for the others)
 */
export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  claim: string;
  /** Numeric value where the item is a figure, for validating cited numbers. */
  value: number | null;
  unit: string | null;
  source: string;
  url: string | null;
  published_at: string | null;
  period_end: string | null;
  retrieved_at: string;
  limitations: string[];
}

export interface IdentityCandidate {
  name: string;
  source: string;
}

/**
 * Who we think the ticker is, and how sure that is.
 *
 * An ambiguous identity must never silently become another company, so the
 * state is explicit and AMBIGUOUS is a terminal answer, not a default pick.
 */
export interface InstrumentIdentity {
  state: 'OK' | 'AMBIGUOUS' | 'UNRESOLVED';
  ticker: string;
  company: string | null;
  exchange: string | null;
  currency: string | null;
  candidates: IdentityCandidate[];
  conflicts: string[];
  reason: string | null;
}

export interface MissingEvidence {
  kind: string;
  reason: string;
}

export interface EvidencePacket {
  identity: InstrumentIdentity;
  /** When this packet was assembled; the basis for "current". */
  analysis_time: string;
  items: EvidenceItem[];
  missing: MissingEvidence[];
  conflicts: string[];
  point_in_time: {
    requested_cutoff: string | null;
    /** True only when every item could actually be filtered to the cutoff. */
    enforced: boolean;
    limitation: string | null;
  };
  /** Cache/identity/provider boundary this packet is valid for. */
  cache_key: string;
}

export const PACKET_VERSION = 'v1';

// ---- identity resolution --------------------------------------------------

const SUFFIXES = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|plc|ltd|ltd\.|limited|holdings|holding|group|sa|nv|ag|the|class|cl|common|stock|shares?)\b/g;

/** Comparable form of a company name: case, punctuation and legal suffixes out. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,&'"()]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Do two names refer to the same company? Containment counts; overlap does not. */
export function namesAgree(a: string, b: string): boolean {
  const x = normalizeCompanyName(a);
  const y = normalizeCompanyName(b);
  if (x === '' || y === '') return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * Resolve the instrument from independent name sources before any model runs.
 *
 * SEC (via CIK) and the market feed are independent namings of the same ticker.
 * Agreement resolves it; disagreement is a real ambiguity and is reported as
 * one. A single source alone still resolves, but carries that as a conflict
 * note so the report cannot claim corroborated identity.
 */
export function resolveIdentity(
  ticker: string,
  secName: string | null,
  marketName: string | null,
  exchange: string | null,
  currency: string | null,
): InstrumentIdentity {
  const candidates: IdentityCandidate[] = [];
  if (secName) candidates.push({ name: secName, source: 'SEC company facts (CIK)' });
  if (marketName) candidates.push({ name: marketName, source: 'market data feed' });
  const conflicts: string[] = [];

  if (candidates.length === 0) {
    return {
      state: 'UNRESOLVED', ticker, company: null, exchange, currency, candidates, conflicts,
      reason: `no company name could be resolved for ${ticker} from SEC filings or the market feed`,
    };
  }
  if (secName && marketName && !namesAgree(secName, marketName)) {
    return {
      state: 'AMBIGUOUS', ticker, company: null, exchange, currency, candidates,
      conflicts: [`SEC names ${ticker} "${secName}" but the market feed names it "${marketName}"`],
      reason: `${ticker} resolves to two different companies; refusing to pick one`,
    };
  }
  if (candidates.length === 1) {
    conflicts.push(`identity rests on one source only (${candidates[0].source}); not corroborated`);
  }
  // Prefer the SEC name: it is the filer of record for the financial figures.
  return {
    state: 'OK', ticker, company: secName ?? marketName, exchange, currency, candidates, conflicts,
    reason: null,
  };
}

// ---- packet assembly ------------------------------------------------------

interface Collected {
  quote: Quote | null;
  quoteFailure: string | null;
  history: PriceHistory | null;
  news: NewsItem[];
  sector: string | null;
  fundamentals: Fundamentals | { ticker: string; reason: string };
  mover: Mover | null;
}

/** Everything the packet is built from. Injectable so tests and the evaluation
 * harness can run against frozen fixtures with no network. */
export type Collector = (ticker: string) => Promise<Collected>;

const liveCollector: Collector = async (ticker) => {
  const [quotes, history, newsBundle, fundamentals, movers] = await Promise.all([
    getQuotes([ticker]),
    getPriceHistory(ticker),
    getTickerNews(ticker, 8),
    getFundamentals(ticker),
    getMovers('most_actives', 50).catch(() => [] as Mover[]),
  ]);
  return {
    quote: quotes.quotes[0] ?? null,
    quoteFailure: quotes.failed[0]?.reason ?? null,
    history,
    news: newsBundle.news,
    sector: newsBundle.sector,
    fundamentals,
    mover: movers.find((m) => m.ticker === ticker) ?? null,
  };
};

let collectorOverride: Collector | null = null;

/** Test/eval seam: collect from fixtures instead of the network. */
export function setCollectorForTests(fn: Collector | null): void {
  collectorOverride = fn;
}

export interface BuildOptions {
  /** ISO date; evidence published after it is excluded (see point_in_time). */
  cutoff?: string | null;
  now?: () => Date;
}

/**
 * Assemble and validate the evidence packet.
 *
 * Validation here is about the things a provider response cannot tell you: that
 * the identity holds, that a figure carries a period, that units are known, and
 * that the numbers are internally consistent. Failures become explicit
 * limitations or `missing` entries — never a silently dropped caveat.
 */
export async function buildEvidencePacket(
  tickerRaw: string,
  opts: BuildOptions = {},
): Promise<EvidencePacket> {
  const ticker = String(tickerRaw ?? '').trim().toUpperCase();
  const now = opts.now ?? (() => new Date());
  const retrieved_at = now().toISOString();
  const cutoff = opts.cutoff ?? null;

  const c = await (collectorOverride ?? liveCollector)(ticker);
  const items: EvidenceItem[] = [];
  const missing: MissingEvidence[] = [];
  const conflicts: string[] = [];
  let seq = 0;
  const add = (it: Omit<EvidenceItem, 'id' | 'retrieved_at'>): void => {
    items.push({ ...it, id: `E${++seq}`, retrieved_at });
  };

  const fund = c.fundamentals;
  const hasFund = 'cik' in fund;
  const identity = resolveIdentity(
    ticker,
    hasFund ? fund.company_name : null,
    c.mover?.name ?? null,
    c.quote?.exchange ?? null,
    c.quote?.currency ?? null,
  );
  conflicts.push(...identity.conflicts);

  // --- dated quote, with its currency and its own timestamp.
  if (c.quote) {
    // The quote's as_of is the exchange timestamp. It is NOT the retrieval time,
    // and an unknown one is never relabelled "current".
    const asOf = c.quote.as_of ?? null;
    const lims = ['delayed/unofficial public endpoint, not a contracted feed'];
    if (!asOf) lims.push('quote timestamp unknown — this price cannot be called current');
    add({
      kind: 'quote', claim: `Last price ${c.quote.price} ${c.quote.currency}`,
      value: c.quote.price, unit: c.quote.currency,
      source: `${c.quote.source} (${c.quote.exchange ?? 'exchange unknown'})`,
      url: null, published_at: asOf, period_end: asOf, limitations: lims,
    });
    if (typeof c.quote.previous_close === 'number') {
      add({
        kind: 'quote', claim: `Previous close ${c.quote.previous_close} ${c.quote.currency}`,
        value: c.quote.previous_close, unit: c.quote.currency, source: c.quote.source,
        url: null, published_at: asOf, period_end: asOf, limitations: [],
      });
    }
  } else {
    missing.push({ kind: 'quote', reason: c.quoteFailure ?? 'no quote returned' });
  }

  // --- traded levels: derived from actual closes, so they are facts about the
  // past, not predictions. Each carries the window it came from.
  if (c.history) {
    const h = c.history;
    const unit = c.quote?.currency ?? null;
    const window = `${h.bars} daily closes through ${h.last_close}`;
    const lvl = (claim: string, value: number | null) => {
      if (value === null) return;
      add({
        kind: 'levels', claim, value, unit, source: 'daily closes (6-month window)',
        url: null, published_at: null, period_end: null,
        limitations: [`derived from ${window}; a traded level, not a forecast`],
      });
    };
    lvl(`Last close ${h.last_close}`, h.last_close);
    lvl(`6-month low ${h.recent_low}`, h.recent_low);
    lvl(`6-month high ${h.recent_high}`, h.recent_high);
    lvl(`20-day SMA ${h.sma20}`, h.sma20);
    lvl(`50-day SMA ${h.sma50}`, h.sma50);
    if (h.bars < 40) {
      conflicts.push(`only ${h.bars} daily closes available; the 50-day SMA is unreliable or absent`);
    }
  } else {
    missing.push({ kind: 'price_history', reason: 'no price history available' });
  }

  if (c.mover) {
    const m = c.mover;
    const unit = c.quote?.currency ?? null;
    if (typeof m.fifty_two_week_high === 'number' && typeof m.fifty_two_week_low === 'number') {
      add({
        kind: 'levels', claim: `52-week range ${m.fifty_two_week_low}–${m.fifty_two_week_high}`,
        value: m.fifty_two_week_high, unit, source: 'market data feed', url: null,
        published_at: null, period_end: null, limitations: ['trailing 52 weeks; no intraday detail'],
      });
    }
    if (m.next_earnings) {
      add({
        kind: 'levels', claim: `Next earnings ${m.next_earnings.slice(0, 10)}${m.earnings_is_estimate ? ' (estimated date)' : ' (confirmed)'}`,
        value: null, unit: null, source: 'market data feed', url: null,
        published_at: null, period_end: m.next_earnings.slice(0, 10),
        limitations: m.earnings_is_estimate ? ['date is an estimate, not confirmed'] : [],
      });
    }
    if (typeof m.forward_pe === 'number') {
      add({
        kind: 'levels', claim: `Forward P/E ${m.forward_pe.toFixed(1)}`, value: m.forward_pe,
        unit: 'ratio', source: 'market data feed', url: null, published_at: null, period_end: null,
        limitations: ['forward estimate: depends on consensus forecasts, not reported results'],
      });
    }
  }

  // --- filed financials. These have a real reporting period and a filing date,
  // which is exactly the distinction the baseline's prose summary loses.
  if (hasFund) {
    const f = fund;
    const period = f.fiscal_year_end ?? null;
    const filed = f.source_filed ?? null;
    const lims = [`as-filed ${f.source_form ?? 'filing'}${filed ? ` filed ${filed}` : ''}; annual figures may be months old`];
    if (!filed) lims.push('filing date unknown');
    if (!period) lims.push('reporting period end unknown');
    const metric = (label: string, value: number | null, unit: string) => {
      if (value === null) return;
      add({
        kind: 'fundamentals', claim: `${label} ${value}`, value, unit,
        source: `SEC ${f.source_form ?? 'filing'} (CIK ${f.cik})`, url: f.source_url,
        published_at: filed, period_end: period, limitations: lims,
      });
    };
    metric('Revenue', f.revenue_usd, 'USD');
    metric('Net income', f.net_income_usd, 'USD');
    metric('Operating income', f.operating_income_usd, 'USD');
    metric('Total assets', f.assets_usd, 'USD');
    metric('Total liabilities', f.liabilities_usd, 'USD');
    metric('Shareholders equity', f.equity_usd, 'USD');
    metric('Diluted EPS', f.diluted_eps, 'USD/share');

    // Internal consistency: the balance sheet must actually balance. A feed can
    // return all three figures happily and still be mismatched.
    const { assets_usd: a, liabilities_usd: l, equity_usd: e } = f;
    if (typeof a === 'number' && typeof l === 'number' && typeof e === 'number' && a !== 0) {
      const drift = Math.abs((a - (l + e)) / a) * 100;
      if (drift > 2) {
        conflicts.push(`filed assets (${a}) do not equal liabilities + equity (${l + e}), off by ${drift.toFixed(1)}% — treat the balance sheet figures as unreliable`);
      }
    }
    // Currency mismatch: filings are USD; the quote may not be.
    if (c.quote && c.quote.currency && c.quote.currency.toUpperCase() !== 'USD') {
      conflicts.push(`filed figures are USD but the quote is in ${c.quote.currency}; per-share and valuation comparisons across the two are not directly comparable`);
    }
  } else {
    missing.push({ kind: 'fundamentals', reason: fund.reason });
  }

  // --- news. published_at is the claim's availability time; undated news is
  // kept but marked, never counted as recent.
  for (const n of c.news.slice(0, 8)) {
    add({
      kind: 'news', claim: n.title, value: null, unit: null,
      source: n.publisher ?? 'unknown publisher', url: n.url,
      published_at: n.published ?? null, period_end: null,
      limitations: n.published ? ['headline only; article body not retrieved']
        : ['undated: cannot be treated as recent', 'headline only; article body not retrieved'],
    });
  }
  if (c.news.length === 0) missing.push({ kind: 'news', reason: 'no recent headlines retrieved' });

  // --- point-in-time. Quotes, SMAs and 52-week ranges come from endpoints with
  // no as-of parameter, so a cutoff can be applied to dated items only. Saying
  // otherwise would make this look like a backtest, which it is not.
  let enforced = false;
  let limitation: string | null = null;
  let kept = items;
  if (cutoff) {
    const bound = Date.parse(cutoff);
    if (Number.isNaN(bound)) {
      limitation = `cutoff "${cutoff}" is not a parsable date; no point-in-time filtering was applied`;
    } else {
      kept = items.filter((it) => {
        if (it.published_at === null) return it.kind !== 'news'; // undated news is unusable at a cutoff
        const t = Date.parse(it.published_at);
        return Number.isNaN(t) ? false : t <= bound;
      });
      const undatedKept = kept.filter((it) => it.published_at === null);
      enforced = undatedKept.length === 0;
      if (!enforced) {
        limitation = `${undatedKept.length} item(s) (price levels and feed metrics) carry no publication time and could not be filtered to ${cutoff}. Point-in-time correctness is NOT established, so this run is not a historical backtest.`;
      }
    }
  }

  return {
    identity,
    analysis_time: retrieved_at,
    items: kept,
    missing,
    conflicts,
    point_in_time: { requested_cutoff: cutoff, enforced, limitation },
    cache_key: [PACKET_VERSION, ticker, identity.state, cutoff ?? 'live'].join(':'),
  };
}

/**
 * Every numeric value the packet actually *supports*, for citation checking.
 *
 * Only structured data counts. Numbers appearing in news headlines and web
 * snippets are deliberately excluded: that text is untrusted third-party
 * content, so treating a figure inside it as packet-supported would let anyone
 * who can get a number into a headline ("...a $400 target") launder it into a
 * validated figure. A headline number can still be quoted — but it has to be
 * attributed as a claim, not silently accepted as verified.
 */
const STRUCTURED: ReadonlySet<EvidenceKind> = new Set<EvidenceKind>(['quote', 'levels', 'fundamentals']);

export function packetNumbers(packet: EvidencePacket): number[] {
  const out: number[] = [];
  for (const it of packet.items) {
    if (!STRUCTURED.has(it.kind)) continue;
    if (typeof it.value === 'number' && Number.isFinite(it.value)) out.push(it.value);
    // Numbers written into the claim text (e.g. both ends of a range).
    for (const m of it.claim.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ''));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** Compact, bounded rendering of the packet for a model turn. */
export function renderPacket(packet: EvidencePacket): string {
  const lines: string[] = [];
  lines.push(`INSTRUMENT: ${packet.identity.ticker} — ${packet.identity.company ?? 'UNRESOLVED'}`
    + ` [identity ${packet.identity.state}]`
    + (packet.identity.exchange ? `, ${packet.identity.exchange}` : '')
    + (packet.identity.currency ? `, quoted in ${packet.identity.currency}` : ''));
  lines.push(`ANALYSIS TIME: ${packet.analysis_time}`);
  if (packet.point_in_time.requested_cutoff) {
    lines.push(`POINT-IN-TIME CUTOFF: ${packet.point_in_time.requested_cutoff}`
      + ` (enforced: ${packet.point_in_time.enforced ? 'yes' : 'NO'})`);
    if (packet.point_in_time.limitation) lines.push(`  ! ${packet.point_in_time.limitation}`);
  }
  lines.push('', 'EVIDENCE (cite these ids; every factual claim needs at least one):');
  for (const it of packet.items) {
    const times = [
      it.published_at ? `published ${it.published_at}` : 'published: unknown',
      it.period_end ? `period ${it.period_end}` : null,
      `retrieved ${it.retrieved_at}`,
    ].filter(Boolean).join(', ');
    lines.push(`[${it.id}] (${it.kind}) ${it.claim}${it.unit ? ` [${it.unit}]` : ''}`);
    lines.push(`      source: ${it.source}${it.url ? ` <${it.url}>` : ''}`);
    lines.push(`      ${times}`);
    if (it.limitations.length > 0) lines.push(`      limits: ${it.limitations.join('; ')}`);
  }
  if (packet.missing.length > 0) {
    lines.push('', 'MISSING (absent, not zero — do not fill these in):');
    for (const m of packet.missing) lines.push(`- ${m.kind}: ${m.reason}`);
  }
  if (packet.conflicts.length > 0) {
    lines.push('', 'CONFLICTS AND CAVEATS:');
    for (const x of packet.conflicts) lines.push(`- ${x}`);
  }
  return lines.join('\n');
}
