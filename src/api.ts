// Thin typed API client for the local backend.

export interface DisclosureRecord {
  id: string;
  ticker: string;
  company: string;
  owner: string;
  owner_role: string;
  tx_type: 'purchase' | 'sale' | 'exchange';
  tx_date_min: string;
  tx_date_max: string;
  published_date: string;
  amount_min_usd: number;
  amount_max_usd: number;
  amendment: boolean;
  amendment_of?: string;
  source_name: string;
  source_url: string | null;
  data_mode: 'demo' | 'imported' | 'live';
  notes?: string;
}

export interface Meta {
  data_modes_present: string[];
  counts: {
    disclosures_total: number;
    disclosures_demo: number;
    disclosures_imported: number;
    watchlist: number;
    ideas: number;
    trades: number;
    chat_messages: number;
  };
  demo_loaded_at: string | null;
  data_dir: string;
  llm_mode_available: boolean;
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
  disclosures: (params: Record<string, string>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
    return get<{ data_mode_present: string[]; count: number; records: DisclosureRecord[] }>(`/api/disclosures${qs ? '?' + qs : ''}`);
  },
  chat: () => get<{ mode_available: boolean; messages: ChatMessage[] }>('/api/chat'),
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
  importDisclosures: (text: string, kind: 'json' | 'csv') =>
    post<{ report: { ok: boolean; added: number; skipped: number; errors: { row: number; message: string }[]; data_mode: string }; imported_count: number }>(
      '/api/disclosures/import', { text, kind },
    ),
  demoLoad: () => post<{ ok: boolean; counts: Record<string, number> }>('/api/demo/load', {}),
  demoClear: () => post<{ ok: boolean }>('/api/demo/clear', {}),
  addIdea: (ticker: string, thesis: string, company?: string) => post<{ idea: { id: string } }>('/api/ideas', { ticker, thesis, company }),
  removeIdea: (id: string) => del<{ ok: boolean }>(`/api/ideas/${encodeURIComponent(id)}`),
  addWatch: (ticker: string, thesis: string, company?: string) => post<{ item: { id: string } }>('/api/watchlist', { ticker, thesis, company }),
  removeWatch: (id: string) => del<{ ok: boolean }>(`/api/watchlist/${encodeURIComponent(id)}`),
};

export const fmtUsd = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const fmtAmountRange = (min: number, max: number): string => {
  const f = (v: number) => (v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}k` : `$${v}`);
  return min === max ? f(min) : `${f(min)} – ${f(max)}`;
};

export const fmtDate = (iso: string): string => iso;