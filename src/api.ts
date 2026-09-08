// Thin typed API client for the local backend.

export interface Meta {
  counts: { watchlist: number; ideas: number; trades: number; positions: number; chat_messages: number };
  data_dir: string;
  market_source: string;
  robinhood: { status: string; note: string };
}

export interface SettingsResponse {
  data_mode: string;
  providers: {
    deterministic_engine: { status: string; note: string };
    llm_endpoint: { status: string; has_key: boolean; model_when_configured?: string; base_url_when_configured?: string; note: string };
  };
  data: { dir: string; demo_loaded_at: string | null; imports: { filename: string; imported_at: string; count: number }[] };
  robinhood: { status: string; note: string };
}

export interface Fundamentals {
  ticker: string; cik: string; company_name: string; fiscal_year_end: string | null;
  revenue_usd: number | null; net_income_usd: number | null; operating_income_usd: number | null;
  assets_usd: number | null; liabilities_usd: number | null; equity_usd: number | null;
  diluted_eps: number | null; source_form: string | null; source_filed: string | null;
  source_url: string; note: string;
}


export interface ChatCitation { record_id?: string; source_url?: string | null; source_name?: string }
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: ChatCitation[];
  mode?: 'deterministic' | 'llm';
  ts: string;
}

export interface PortfolioSummary {
  cash_usd: number;
  positions: {
    ticker: string; quantity: number; cost_basis_usd: number; avg_cost: number;
    // Mark fields are null until you enter a mark price yourself.
    mark_price: number | null; marked_at: string | null;
    mark_source: 'user' | 'quote' | null; quote_source: string | null;
    market_value_usd: number | null; unrealized_pl_usd: number | null; unrealized_pl_pct: number | null;
  }[];
  invested_cost_usd: number;
  account_cost_usd: number;
  marked_positions_count: number;
  marked_value_usd: number | null;
  account_marked_usd: number | null;
  unrealized_pl_usd: number | null;
  trade_count: number;
}

export interface PaperTrade {
  id: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  price_source: 'user_entered' | 'demo';
  trade_date: string;
  created_at: string;
  note?: string;
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && typeof j.error === 'string') msg = j.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function get<T>(url: string): Promise<T> {
  return fetch(url).then((r) => handle<T>(r));
}

function post<T>(url: string, body: unknown): Promise<T> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => handle<T>(r));
}

function del<T>(url: string): Promise<T> {
  return fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }).then((r) => handle<T>(r));
}

export const api = {
  meta: () => get<Meta>('/api/meta'),
  settings: () => get<SettingsResponse>('/api/settings'),
  chat: () => get<{ mode_available: boolean; messages: ChatMessage[] }>('/api/chat'),
  clearChat: () => del<{ ok: boolean; removed: number }>('/api/chat'),
  fundamentals: (ticker: string) =>
    get<{ fundamentals: Fundamentals }>(`/api/fundamentals?ticker=${encodeURIComponent(ticker)}`),
  ask: (question: string, mode: 'deterministic' | 'llm', includePortfolio = false) =>
    post<{ message: ChatMessage }>('/api/chat', { question, mode, include_portfolio: includePortfolio }),
  portfolio: () => get<PortfolioSummary>('/api/portfolio'),
  trades: () => get<{ trades: PaperTrade[] }>('/api/portfolio/trades'),
  setMark: (ticker: string, price: number | null) =>
    post<{ portfolio: PortfolioSummary }>('/api/portfolio/marks', { ticker, price }),
  refreshQuotes: () =>
    post<{ updated: number; failed: { ticker: string; reason: string }[]; portfolio: PortfolioSummary }>(
      '/api/portfolio/marks/refresh', {}),
  submitTrade: (t: { ticker: string; side: 'BUY' | 'SELL'; quantity: number; price: number; price_source: string; trade_date: string; note?: string; client_request_id?: string }) =>
    post<{ trade: PaperTrade; portfolio: PortfolioSummary; duplicate?: boolean }>('/api/portfolio/trades', t),
  demoClear: () => post<{ ok: boolean }>('/api/demo/clear', {}),
  movers: (kind: 'most_actives' | 'day_gainers' | 'day_losers', count = 15) =>
    get<{ kind: string; count: number; movers: Mover[]; fetched_at: string; note: string }>(
      `/api/market/movers?kind=${kind}&count=${count}`),
  snapshot: (ticker: string) => get<TickerSnapshot>(`/api/market/ticker/${encodeURIComponent(ticker)}`),
  research: (ticker: string) =>
    post<{ verdict: AgentVerdict; cached: boolean }>(`/api/research/${encodeURIComponent(ticker)}`, {}),
  watchlist: () => get<{ items: { id: string; ticker: string; thesis: string }[] }>('/api/watchlist'),
  addIdea: (ticker: string, thesis: string, company?: string) => post<{ idea: { id: string } }>('/api/ideas', { ticker, thesis, company }),
  removeIdea: (id: string) => del<{ ok: boolean }>(`/api/ideas/${encodeURIComponent(id)}`),
  addWatch: (ticker: string, thesis: string, company?: string) => post<{ item: { id: string } }>('/api/watchlist', { ticker, thesis, company }),
  removeWatch: (id: string) => del<{ ok: boolean }>(`/api/watchlist/${encodeURIComponent(id)}`),
};

export const fmtUsd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const fmtDate = (iso: string): string => iso;

export interface Mover {
  ticker: string; name: string;
  price: number | null; change: number | null; change_pct: number | null;
  volume: number | null; avg_volume_3m: number | null; volume_vs_avg: number | null;
  market_cap: number | null; forward_pe: number | null;
  fifty_two_week_low: number | null; fifty_two_week_high: number | null; range_position: number | null;
  fifty_day_change_pct: number | null; two_hundred_day_change_pct: number | null;
  next_earnings: string | null; earnings_is_estimate: boolean;
  exchange: string | null; delayed_by_seconds: number | null; quote_source: string | null;
}

export interface TickerSnapshot {
  ticker: string;
  quote: { ticker: string; price: number; previous_close: number | null; currency: string; as_of: string; exchange: string | null } | null;
  history: { bars: number; recent_low: number | null; recent_high: number | null; sma20: number | null; sma50: number | null; last_close: number | null; pct_from_recent_high: number | null; pct_from_recent_low: number | null } | null;
  news: { title: string; publisher: string | null; published: string | null; url: string }[];
  sector: string | null; industry: string | null;
  fundamentals: { company_name: string; revenue_usd: number | null; net_income_usd: number | null; diluted_eps: number | null; source_form: string | null; source_filed: string | null; source_url: string } | null;
  fundamentals_unavailable: string | null;
}

export interface LevelCheck {
  field: string; stated: string; value: number | null;
  nearest_anchor: string | null; anchor_value: number | null;
  drift_pct: number | null; grounded: boolean;
}

export interface AgentVerdict {
  ticker: string;
  verdict: 'strong_buy' | 'buy' | 'hold' | 'avoid' | 'unclear';
  confidence: 'low' | 'medium' | 'high';
  summary: string;
  entry_zone: string | null; exit_target: string | null;
  stop_loss: string | null; hold_horizon: string | null;
  reasoning: string[]; risks: string[];
  sources: { title: string; url: string; snippet?: string }[];
  level_checks?: LevelCheck[];
  model: string; searches_used: number; generated_at: string;
}
