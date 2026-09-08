// Shared types for Civicfolio server + client.
// Data provenance is a first-class concept: every record carries a data_mode.

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

/** What a data source actually returned for one request — shown to model and user. */
export interface DataSourceStatus {
  available: boolean;
  /** The source's own timestamp, when it has one. Null means UNKNOWN, not "fetched now". */
  as_of: string | null;
  note: string;
}

export interface ChatMessage {
  // Which stock this message belongs to. Threads are keyed by ticker so a
  // conversation about NVDA never bleeds into one about AMD. Set on BOTH the
  // user message and the assistant reply so they land in the same thread.
  ticker?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: ChatCitation[];
  mode?: 'deterministic' | 'llm';
  ts: string;
  // Provenance of the answer. Legacy messages predate these fields: their
  // absence itself marks them as unverified (shown by timestamp/provenance,
  // never deleted).
  model_used?: string | null;
  data_sources?: Record<string, DataSourceStatus>;
}

/** A recommendation as it stood when made, so it can be revisited later. */
export interface VerdictLogEntry {
  id: string;
  ticker: string;
  verdict: string;
  confidence: string;
  // The price at the moment of the call — without it, "was this right?" is
  // unanswerable after the fact.
  price_at_call: number | null;
  entry_zone: string | null;
  exit_target: string | null;
  stop_loss: string | null;
  hold_horizon: string | null;
  grounded_levels: number;
  unsupported_levels: number;
  model: string;
  created_at: string;
  // Evidence state at call time: were sources up, and what did they say?
  sources_available?: boolean;
  data_notes?: string;
}

export interface ScoredVerdict extends VerdictLogEntry {
  price_now: number | null;
  change_pct: number | null;
  elapsed_days: number;
  // Direction the verdict implied, for description only. NOT a scored outcome:
  // calling a call "right" from one price point is not a benchmark.
  direction: 'bullish' | 'bearish' | 'neutral';
}

export interface AppData {
  verdict_log: VerdictLogEntry[];
  watchlist: WatchlistItem[];
  ideas: TrackedIdea[];
  trades: PaperTrade[];
  portfolio: PortfolioState;
  chat: ChatMessage[];
  ai_fund: AiFundState;
  ai_lessons: AiLesson[];
  meta: {
    schema_version: number;
  };
}

/** The AI's fake-money fund. Paper only — no broker exists anywhere in this app. */
export interface AiFundState {
  cash_usd: number;
  started_at: string;
  positions: Record<string, { quantity: number; avg_cost: number }>;
  // ticker -> latest known price (from the delayed feed) for marking equity
  marks: Record<string, number>;
  // ticker -> active stop from the trade thesis
  stops: Record<string, number>;
  trades: AiTrade[];
}

export interface AiTrade {
  id: string;
  verdict_id: string; // links to the research entry that caused the trade
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number; // real delayed quote at execution time, never model-typed
  quote_as_of: string;
  executed_at: string;
  rationale: string;
  // Set on closes: the round-trip result that feeds the reflection loop.
  realized_pnl_usd?: number;
  pnl_pct?: number;
}

/** What the fund learned from a closed trade; injected into future research. */
export interface AiLesson {
  id: string;
  ticker: string;
  trade_id: string;
  lesson: string; // one sentence, written by the reflection pass
  closed_at: string;
}