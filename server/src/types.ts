// Shared types for Civicfolio server + client.
// Data provenance is a first-class concept: every record carries a data_mode.

export type DataMode = 'demo' | 'imported' | 'live';

export interface DisclosureRecord {
  id: string; // stable record id, e.g. "demo-0001" or import-assigned
  ticker: string;
  company: string;
  owner: string; // fictional person name for demo; verbatim for imported
  owner_role: string; // e.g. "Senator", "Spouse", "Child"
  tx_type: 'purchase' | 'sale' | 'exchange';
  tx_date_min: string; // ISO date — transaction date (range start)
  tx_date_max: string; // ISO date — transaction date (range end)
  published_date: string; // ISO date — when the filing became public
  amount_min_usd: number; // amount is a RANGE, never an exact value
  amount_max_usd: number;
  amendment: boolean;
  amendment_of?: string; // id of original record this amends
  source_name: string; // e.g. "Synthetic demo dataset", "User import (CSV)"
  source_url: string | null; // primary source link (null for synthetic)
  data_mode: DataMode;
  notes?: string;
}

export interface WatchlistItem {
  id: string;
  ticker: string;
  company: string;
  thesis: string;
  added_at: string; // ISO datetime
}

export interface TrackedIdea {
  id: string;
  ticker: string;
  company: string;
  thesis: string;
  status: 'watching' | 'researching' | 'archived';
  created_at: string;
}

export interface PaperTrade {
  id: string;
  client_request_id?: string; // server-enforced idempotency key (UUID from client)
  ticker: string;
  side: 'BUY' | 'SELL';
  quantity: number; // validated finite, > 0
  price: number; // user-entered or demo-labeled; stored as given
  price_source: 'user_entered' | 'demo';
  trade_date: string; // ISO date
  created_at: string; // ISO datetime
  note?: string;
}

// A price YOU typed in for a position you hold, so the app can show unrealized
// gain/loss. Never a quote: no market data source exists in this app.
export interface MarkPrice {
  price: number; // finite, > 0
  marked_at: string; // ISO datetime the value was recorded
  // 'user' = you typed it. 'quote' = pulled from a market data source, which
  // is delayed and unofficial. Kept distinct so the UI never conflates them.
  source?: 'user' | 'quote';
  quote_source?: string; // e.g. "yahoo"; only set when source === 'quote'
}

export interface PortfolioState {
  cash_usd: number;
  positions: Record<string, { quantity: number; cost_basis_usd: number }>;
  // ticker -> user-entered mark. Absent means "no mark set"; the UI then shows
  // cost basis only rather than inventing a value.
  marks?: Record<string, MarkPrice>;
}

export interface ChatCitation {
  record_id?: string;
  source_url?: string | null;
  source_name?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: ChatCitation[];
  mode?: 'deterministic' | 'llm';
  ts: string;
}

export interface ImportReport {
  ok: boolean;
  added: number;
  skipped: number;
  errors: { row: number; message: string }[];
  data_mode: DataMode;
}

export interface AppData {
  disclosures: DisclosureRecord[];
  watchlist: WatchlistItem[];
  ideas: TrackedIdea[];
  trades: PaperTrade[];
  portfolio: PortfolioState;
  chat: ChatMessage[];
  meta: {
    seed_version: number;
    demo_loaded_at: string | null;
    imports: { filename: string; imported_at: string; count: number }[];
  };
}