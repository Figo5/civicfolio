// Live market quotes.
//
// Source: Yahoo Finance's public chart endpoint. No API key, no account, no
// fees. It is an undocumented public endpoint, not a contracted feed — it can
// change or rate-limit without notice, so every failure is surfaced as "no
// quote" rather than smoothed over with a stale or invented number.
//
// Delayed/unofficial data. Never presented as a real-time trading feed.

const ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT_MS = 8000;
const CACHE_MS = 60_000; // one minute; avoids hammering on every page render
const MAX_TICKERS = 50;

export interface Quote {
  ticker: string;
  price: number;
  previous_close: number | null;
  currency: string;
  // Exchange timestamp for the price, not the time we fetched it.
  as_of: string;
  exchange: string | null;
  source: 'yahoo';
}

export interface QuoteFailure {
  ticker: string;
  reason: string;
}

const cache = new Map<string, { at: number; quote: Quote }>();

function parse(ticker: string, body: unknown): Quote | null {
  const meta = (body as { chart?: { result?: { meta?: Record<string, unknown> }[] } })
    ?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;

  // previousClose is often absent on this endpoint; chartPreviousClose is the
  // documented fallback. Missing stays null rather than defaulting to price,
  // which would silently render every change as 0.00%.
  const prevRaw = typeof meta.previousClose === 'number' ? meta.previousClose : meta.chartPreviousClose;
  const prev = typeof prevRaw === 'number' && Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : null;

  const ts = typeof meta.regularMarketTime === 'number' ? meta.regularMarketTime : null;
  return {
    ticker,
    price,
    previous_close: prev,
    currency: typeof meta.currency === 'string' ? meta.currency : 'USD',
    as_of: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
    exchange: typeof meta.exchangeName === 'string' ? meta.exchangeName : null,
    source: 'yahoo',
  };
}

async function fetchOne(ticker: string): Promise<Quote | QuoteFailure> {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.quote;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(ticker)}?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return { ticker, reason: `upstream returned ${res.status}` };
    const quote = parse(ticker, await res.json());
    // A delisted or renamed symbol (e.g. BRCM -> AVGO) resolves to no price.
    if (!quote) return { ticker, reason: 'no price returned (delisted, renamed, or unknown symbol)' };
    cache.set(ticker, { at: Date.now(), quote });
    return quote;
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ticker, reason: aborted ? 'quote request timed out' : `quote request failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch quotes for up to MAX_TICKERS symbols. Never throws: symbols that
 * cannot be resolved come back in `failed` so the caller can show "no quote"
 * instead of a fabricated price.
 */
export async function getQuotes(tickers: string[]): Promise<{ quotes: Quote[]; failed: QuoteFailure[] }> {
  const seen = [...new Set(tickers.map((t) => String(t ?? '').trim().toUpperCase()).filter(Boolean))];
  const valid: string[] = [];
  const failed: QuoteFailure[] = [];
  for (const t of seen) {
    // Report malformed symbols instead of dropping them, so an all-invalid
    // request explains itself rather than returning a silent empty result.
    if (/^[A-Z]{1,10}$/.test(t)) valid.push(t);
    else failed.push({ ticker: t.slice(0, 20), reason: 'not a valid ticker (1-10 letters A-Z)' });
  }

  const results = await Promise.all(valid.slice(0, MAX_TICKERS).map(fetchOne));
  const quotes: Quote[] = [];
  for (const r of results) {
    if ('price' in r) quotes.push(r);
    else failed.push(r);
  }
  return { quotes, failed };
}

export function clearQuoteCacheForTests(): void {
  cache.clear();
}
