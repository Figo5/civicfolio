// Live market data: what is moving, why, and when the next catalyst lands.
//
// Source: Yahoo Finance's public screener and chart endpoints. Keyless and
// free. Each quote reports its own `exchangeDataDelayedBy`, which we pass
// through rather than assuming everything is real time — some venues are
// delayed 15 minutes and saying otherwise would be a lie about freshness.
//
// Everything here is observed market data. Nothing is predicted, and no field
// is filled in by guessing: a value Yahoo omits stays null.

const SCREENER = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved';
const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const TIMEOUT_MS = 12000;
const CACHE_MS = 60_000;

export type MoverKind = 'most_actives' | 'day_gainers' | 'day_losers';

export interface Mover {
  ticker: string;
  name: string;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  volume: number | null;
  avg_volume_3m: number | null;
  // >1 means today is busier than a normal day; the clearest "unusual activity"
  // signal available without paying for order flow.
  volume_vs_avg: number | null;
  market_cap: number | null;
  forward_pe: number | null;
  fifty_two_week_low: number | null;
  fifty_two_week_high: number | null;
  // Where price sits in its 52-week range, 0 (at low) to 1 (at high).
  range_position: number | null;
  fifty_day_change_pct: number | null;
  two_hundred_day_change_pct: number | null;
  next_earnings: string | null;
  earnings_is_estimate: boolean;
  exchange: string | null;
  delayed_by_seconds: number | null;
  quote_source: string | null;
}

const cache = new Map<string, { at: number; data: unknown }>();

async function getJson(url: string): Promise<unknown | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(url, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function isoFromUnix(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  // Yahoo mixes seconds and milliseconds across fields.
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toMover(q: Record<string, unknown>): Mover | null {
  const ticker = str(q.symbol);
  if (!ticker) return null;
  const price = num(q.regularMarketPrice);
  const low = num(q.fiftyTwoWeekLow);
  const high = num(q.fiftyTwoWeekHigh);
  const volume = num(q.regularMarketVolume);
  const avg = num(q.averageDailyVolume3Month);

  return {
    ticker,
    name: str(q.longName) ?? str(q.shortName) ?? ticker,
    price,
    change: num(q.regularMarketChange),
    change_pct: num(q.regularMarketChangePercent),
    volume,
    avg_volume_3m: avg,
    volume_vs_avg: volume !== null && avg !== null && avg > 0 ? Math.round((volume / avg) * 100) / 100 : null,
    market_cap: num(q.marketCap),
    forward_pe: num(q.forwardPE),
    fifty_two_week_low: low,
    fifty_two_week_high: high,
    range_position:
      price !== null && low !== null && high !== null && high > low
        ? Math.round(((price - low) / (high - low)) * 100) / 100
        : null,
    fifty_day_change_pct: num(q.fiftyDayAverageChangePercent),
    two_hundred_day_change_pct: num(q.twoHundredDayAverageChangePercent),
    next_earnings: isoFromUnix(q.earningsTimestampStart) ?? isoFromUnix(q.earningsTimestamp),
    earnings_is_estimate: q.isEarningsDateEstimate === true,
    exchange: str(q.fullExchangeName) ?? str(q.exchange),
    delayed_by_seconds: num(q.exchangeDataDelayedBy),
    quote_source: str(q.quoteSourceName),
  };
}

export async function getMovers(kind: MoverKind, count = 15): Promise<Mover[]> {
  const n = Math.min(Math.max(1, Math.floor(count)), 50);
  const body = await getJson(`${SCREENER}?scrIds=${kind}&count=${n}`);
  const quotes = (body as { finance?: { result?: { quotes?: Record<string, unknown>[] }[] } })
    ?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes.map(toMover).filter((m): m is Mover => m !== null);
}

function getJsonStrict(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`screener returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * Movers with an honest failure mode: an UNREACHABLE feed throws ("no data"
 * is not the same as "no movers"), while a reachable feed with an empty
 * screen returns []. The fund loop relies on this distinction so a dead data
 * source is recorded as a run failure instead of a quiet no-op.
 */
export async function getMoversStrict(kind: MoverKind, count = 15): Promise<Mover[]> {
  const n = Math.min(Math.max(1, Math.floor(count)), 50);
  const body = await getJsonStrict(`${SCREENER}?scrIds=${kind}&count=${n}`);
  const quotes = (body as { finance?: { result?: { quotes?: Record<string, unknown>[] }[] } })
    ?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) return [];
  return quotes.map(toMover).filter((m): m is Mover => m !== null);
}

export interface PriceHistory {
  ticker: string;
  bars: number;
  // Levels derived from actual traded prices, not predictions.
  recent_low: number | null;
  recent_high: number | null;
  sma20: number | null;
  sma50: number | null;
  last_close: number | null;
  pct_from_recent_high: number | null;
  pct_from_recent_low: number | null;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return Math.round((slice.reduce((a, b) => a + b, 0) / period) * 100) / 100;
}

/** Six months of daily closes, reduced to levels an analysis can actually cite. */
export async function getPriceHistory(ticker: string): Promise<PriceHistory | null> {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(symbol)) return null;
  const body = await getJson(`${CHART}/${symbol}?range=6mo&interval=1d`);
  const result = (body as { chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] } })
    ?.chart?.result?.[0];
  const raw = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(raw)) return null;
  const closes = raw.filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  if (closes.length === 0) return null;

  const last = closes[closes.length - 1];
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ticker: symbol,
    bars: closes.length,
    recent_low: r2(lo),
    recent_high: r2(hi),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    last_close: r2(last),
    pct_from_recent_high: hi > 0 ? r2(((last - hi) / hi) * 100) : null,
    pct_from_recent_low: lo > 0 ? r2(((last - lo) / lo) * 100) : null,
  };
}

export interface NewsItem { title: string; publisher: string | null; published: string | null; url: string }

/** Recent headlines for a ticker, plus the exchange's own sector labels. */
export async function getTickerNews(ticker: string, count = 6): Promise<{ news: NewsItem[]; sector: string | null; industry: string | null }> {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(symbol)) return { news: [], sector: null, industry: null };
  const body = await getJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=${count}&quotesCount=1`,
  );
  const b = body as { news?: Record<string, unknown>[]; quotes?: Record<string, unknown>[] };
  const news = (b?.news ?? []).map((n) => ({
    title: str(n.title) ?? '',
    publisher: str(n.publisher),
    published: isoFromUnix(n.providerPublishTime),
    url: str(n.link) ?? '',
  })).filter((n) => n.title && n.url);
  const q = b?.quotes?.[0] ?? {};
  return { news, sector: str(q.sector), industry: str(q.industry) };
}

export function clearMarketCacheForTests(): void {
  cache.clear();
}
