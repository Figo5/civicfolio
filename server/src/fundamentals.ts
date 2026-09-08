// Company fundamentals from SEC EDGAR's XBRL API.
//
// Official, free, keyless, and explicitly open to programmatic access — the SEC
// asks only for a declaring User-Agent and a modest request rate, both honored
// below. This is filed data straight from the source, not a scrape.
//
// Deliberately NOT used: Yahoo's quoteSummary fundamentals endpoint. It sits
// behind a crumb token Yahoo added to gate access; working around that would be
// circumventing an access control rather than using a public API.
//
// Caveat that matters for interpretation: XBRL facts are as-filed. Annual
// figures can be months stale, restatements appear as new rows, and different
// filers tag the same concept differently — hence the tag priority lists.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.js';

const SEC_UA = 'Civicfolio/0.1 (personal research tool; contact via local install)';
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts';
const CACHE_MS = 24 * 60 * 60 * 1000; // filings change daily at most
const TIMEOUT_MS = 20000;

export interface Fundamentals {
  ticker: string;
  cik: string;
  company_name: string;
  fiscal_year_end: string | null;
  revenue_usd: number | null;
  net_income_usd: number | null;
  operating_income_usd: number | null;
  assets_usd: number | null;
  liabilities_usd: number | null;
  equity_usd: number | null;
  diluted_eps: number | null;
  // Where each figure came from, so a claim can be traced to a filing.
  source_form: string | null;
  source_filed: string | null;
  source_url: string;
  note: string;
}

function cacheDir(): string {
  return path.join(dataDir(), 'cache');
}

function readCache<T>(name: string): T | null {
  try {
    const file = path.join(cacheDir(), name);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_MS) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeCache(name: string, value: unknown): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), name), JSON.stringify(value), 'utf8');
  } catch { /* cache is an optimization, never a requirement */ }
}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_UA, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type TickerMap = Record<string, { cik: string; title: string }>;

/** Pure helper (exported for tests): build the ticker→CIK map from SEC's company_tickers.json shape. */
export function buildTickerMap(raw: unknown): TickerMap {
  const map: TickerMap = {};
  if (!raw || typeof raw !== 'object') return map;
  for (const entry of Object.values(raw as Record<string, { ticker?: string; cik_str?: number; title?: string }>)) {
    if (!entry?.ticker || typeof entry.cik_str !== 'number') continue;
    map[entry.ticker.toUpperCase()] = { cik: String(entry.cik_str).padStart(10, '0'), title: entry.title ?? entry.ticker };
  }
  return map;
}

async function tickerMap(): Promise<TickerMap | null> {
  const cached = readCache<TickerMap>('sec-tickers.json');
  if (cached) return cached;
  const raw = await getJson(TICKER_MAP_URL);
  if (!raw || typeof raw !== 'object') return null;
  const map = buildTickerMap(raw);
  if (Object.keys(map).length === 0) return null;
  writeCache('sec-tickers.json', map);
  return map;
}

interface XbrlRow { end?: string; val?: number; form?: string; filed?: string; fp?: string; fy?: number }

// Filers tag the same idea with different concept names; try them in order.
const TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingIncome: ['OperatingIncomeLoss'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
} as const;

/** Latest annual (10-K / FY) value across a tag priority list. */
function latestAnnual(gaap: Record<string, { units?: Record<string, XbrlRow[]> }>, tags: readonly string[]):
  { value: number; row: XbrlRow } | null {
  for (const tag of tags) {
    const units = gaap[tag]?.units;
    if (!units) continue;
    const rows = units['USD'] ?? units['USD/shares'] ?? Object.values(units)[0];
    if (!Array.isArray(rows)) continue;
    const annual = rows.filter((r) => r.form === '10-K' && typeof r.val === 'number' && r.end);
    if (annual.length === 0) continue;
    annual.sort((a, b) => String(a.end).localeCompare(String(b.end)));
    const row = annual[annual.length - 1];
    return { value: row.val as number, row };
  }
  return null;
}

export async function getFundamentals(ticker: string): Promise<Fundamentals | { ticker: string; reason: string }> {
  const symbol = String(ticker ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,10}$/.test(symbol)) return { ticker: symbol.slice(0, 20), reason: 'not a valid ticker' };

  const map = await tickerMap();
  if (!map) return { ticker: symbol, reason: 'SEC ticker directory unavailable' };
  const entry = map[symbol];
  // Foreign issuers, funds and ETFs have no US-GAAP company facts.
  if (!entry) return { ticker: symbol, reason: 'no SEC filer found for this ticker (foreign issuer, fund, or ETF)' };

  const cacheName = `sec-facts-${entry.cik}.json`;
  type CompanyFacts = { facts?: Record<string, Record<string, { units?: Record<string, XbrlRow[]> }>> };
  const cached = readCache<CompanyFacts>(cacheName);
  let facts: CompanyFacts | null = cached;
  if (!facts) {
    const fetched = (await getJson(`${FACTS_URL}/CIK${entry.cik}.json`)) as CompanyFacts | null;
    if (!fetched || !fetched.facts) return { ticker: symbol, reason: 'SEC company facts unavailable' };
    facts = fetched;
    writeCache(cacheName, facts);
  }

  const gaap = facts.facts?.['us-gaap'];
  if (!gaap) return { ticker: symbol, reason: 'no US-GAAP facts filed for this company' };

  const rev = latestAnnual(gaap, TAGS.revenue);
  const ni = latestAnnual(gaap, TAGS.netIncome);
  const oi = latestAnnual(gaap, TAGS.operatingIncome);
  const assets = latestAnnual(gaap, TAGS.assets);
  const liabs = latestAnnual(gaap, TAGS.liabilities);
  const eq = latestAnnual(gaap, TAGS.equity);
  const eps = latestAnnual(gaap, TAGS.eps);
  const anchor = rev ?? ni ?? assets;

  return {
    ticker: symbol,
    cik: entry.cik,
    company_name: entry.title,
    fiscal_year_end: anchor?.row.end ?? null,
    revenue_usd: rev?.value ?? null,
    net_income_usd: ni?.value ?? null,
    operating_income_usd: oi?.value ?? null,
    assets_usd: assets?.value ?? null,
    liabilities_usd: liabs?.value ?? null,
    equity_usd: eq?.value ?? null,
    diluted_eps: eps?.value ?? null,
    source_form: anchor?.row.form ?? null,
    source_filed: anchor?.row.filed ?? null,
    source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=10-K`,
    note: 'As-filed annual figures from SEC EDGAR XBRL. Latest 10-K may be months old; restatements appear as later filings.',
  };
}

export async function getFundamentalsBatch(tickers: string[]): Promise<{
  fundamentals: Fundamentals[];
  failed: { ticker: string; reason: string }[];
}> {
  const clean = [...new Set(tickers.map((t) => String(t ?? '').trim().toUpperCase()).filter(Boolean))].slice(0, 12);
  const fundamentals: Fundamentals[] = [];
  const failed: { ticker: string; reason: string }[] = [];
  // Sequential: the SEC asks callers to keep request rates modest.
  for (const t of clean) {
    const r = await getFundamentals(t);
    if ('cik' in r) fundamentals.push(r);
    else failed.push(r);
  }
  return { fundamentals, failed };
}
