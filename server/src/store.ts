import type { AppData, WatchlistItem, TrackedIdea, PaperTrade, PortfolioState, ChatMessage, AiTrade, AiFundMark, AiFundRun } from './types.js';
import { MAX_AI_FUND_RUNS } from './types.js';
import { isFiniteNumber } from './validate.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Data lives OUTSIDE the repo by default: ~/.civicfolio (override with
// CIVICFOLIO_DATA_DIR). Keeps local app state out of tracked files.
export function dataDir(): string {
  const configured = process.env.CIVICFOLIO_DATA_DIR;
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(os.homedir(), '.civicfolio');
}

function dataFile(): string {
  return path.join(dataDir(), 'civicfolio-data.json');
}

export function emptyPortfolio(): PortfolioState {
  return { cash_usd: 100000, positions: {}, marks: {} };
}

// Demo cash reconciles with the seeded trades (425 + 140.5 = 565.50 spent).
export const DEMO_SEED_SPEND = 425 + 140.5;

export function emptyData(): AppData {
  return {
    watchlist: [],
    ideas: [],
    trades: [],
    verdict_log: [],
    portfolio: emptyPortfolio(),
    chat: [],
    ai_fund: emptyAiFund(),
    ai_lessons: [],
    meta: { schema_version: 3 },
  };
}

let cache: AppData | null = null;

// Test hook: drop the in-memory cache so the next load() re-reads from disk.
export function resetCacheForTests(): void {
  cache = null;
}

function sanitizePortfolio(p: unknown): PortfolioState {
  const fallback = emptyPortfolio();
  if (!p || typeof p !== 'object') return fallback;
  const obj = p as Record<string, unknown>;
  const cash = isFiniteNumber(obj.cash_usd) ? (obj.cash_usd as number) : fallback.cash_usd;
  const positions: PortfolioState['positions'] = {};
  if (obj.positions && typeof obj.positions === 'object') {
    for (const [ticker, v] of Object.entries(obj.positions as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const pv = v as Record<string, unknown>;
      const q = pv.quantity, c = pv.cost_basis_usd;
      if (isFiniteNumber(q) && (q as number) > 0 && isFiniteNumber(c) && (c as number) >= 0) {
        positions[String(ticker).toUpperCase().slice(0, 12)] = { quantity: q as number, cost_basis_usd: c as number };
      }
    }
  }
  const marks: NonNullable<PortfolioState['marks']> = {};
  if (obj.marks && typeof obj.marks === 'object') {
    for (const [ticker, v] of Object.entries(obj.marks as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const mv = v as Record<string, unknown>;
      if (isFiniteNumber(mv.price) && (mv.price as number) > 0 && typeof mv.marked_at === 'string') {
        marks[String(ticker).toUpperCase().slice(0, 12)] = {
          price: mv.price as number,
          marked_at: mv.marked_at,
          source: mv.source === 'quote' ? 'quote' : 'user',
          ...(typeof mv.quote_source === 'string' ? { quote_source: mv.quote_source } : {}),
        };
      }
    }
  }
  return { cash_usd: cash, positions, marks };
}

export function emptyAiFund(): AppData['ai_fund'] {
  return { cash_usd: 10000, started_at: new Date().toISOString(), positions: {}, marks: {}, stops: {}, trades: [], runs: [] };
}

// Schema-2 marks were bare numbers (ticker -> price) with no freshness. On
// load they migrate to mark objects carried at their recorded value with
// unknown timestamps — never relabelled with the current time.
function sanitizeMark(v: unknown): AiFundMark | null {
  if (typeof v === 'number') {
    // Legacy bare-number mark: keep the price, mark the timestamps unknown.
    return isFiniteNumber(v) && v > 0
      ? { price: v, quote_as_of: null, fetched_at: null, source: 'trade' as const }
      : null;
  }
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (!isFiniteNumber(m.price) || (m.price as number) <= 0) return null;
  const src = m.source === 'quote' || m.source === 'trade' || m.source === 'imported' ? m.source as AiFundMark['source'] : 'trade' as const;
  const mark: AiFundMark = {
    price: m.price as number,
    quote_as_of: typeof m.quote_as_of === 'string' ? m.quote_as_of : null,
    fetched_at: typeof m.fetched_at === 'string' ? m.fetched_at : null,
    source: src,
    ...(typeof m.quote_source === 'string' ? { quote_source: m.quote_source } : {}),
    ...(m.stale === true ? { stale: true } : {}),
  };
  return mark;
}

function sanitizeRuns(v: unknown): AiFundRun[] {
  if (!Array.isArray(v)) return [];
  const runs: AiFundRun[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const status = ['running', 'completed', 'partial', 'failed', 'interrupted'].includes(String(o.status))
      ? (o.status as AiFundRun['status'])
      : 'failed';
    const trigger = ['scheduled', 'manual', 'chat'].includes(String(o.trigger))
      ? (o.trigger as AiFundRun['trigger'])
      : null;
    if (!trigger) continue;
    const actions = Array.isArray(o.actions)
      ? (o.actions as unknown[]).filter((a): a is AiFundRun['actions'][number] => {
          if (!a || typeof a !== 'object') return false;
          const av = a as Record<string, unknown>;
          return typeof av.ticker === 'string' && typeof av.action === 'string' && typeof av.detail === 'string';
        }).map((a) => ({ ticker: a.ticker.slice(0, 12).toUpperCase(), action: a.action.slice(0, 40), detail: String(a.detail).slice(0, 500) }))
      : [];
    const failures = Array.isArray(o.failures)
      ? (o.failures as unknown[]).filter((f) => f && typeof f === 'object' && typeof (f as Record<string, unknown>).note === 'string')
        .map((f) => ({ kind: String((f as Record<string, unknown>).kind).slice(0, 20), note: String((f as Record<string, unknown>).note).slice(0, 500) }))
      : [];
    runs.push({
      id: typeof o.id === 'string' ? o.id.slice(0, 64) : '',
      ...(typeof o.request_id === 'string' ? { request_id: o.request_id.slice(0, 100) } : {}),
      trigger,
      started_at: typeof o.started_at === 'string' ? o.started_at : '',
      finished_at: typeof o.finished_at === 'string' ? o.finished_at : null,
      status,
      actions,
      failures,
      trades_occurred: o.trades_occurred === true,
      equity_usd: isFiniteNumber(o.equity_usd) ? (o.equity_usd as number) : null,
      valued_at: typeof o.valued_at === 'string' ? o.valued_at : null,
      marks_stale: o.marks_stale === true,
      model_used: typeof o.model_used === 'string' ? o.model_used.slice(0, 120) : null,
      ...(o.imported === true ? { imported: true } : {}),
      ...(typeof o.note === 'string' ? { note: o.note.slice(0, 500) } : {}),
    });
  }
  return runs.filter((r) => r.id).slice(-MAX_AI_FUND_RUNS);
}

// Sanitize a persisted AI fund: finite numbers only, bounded trades. Corrupt
// entries are dropped, never guessed. MIGRATION (schema 2 -> 3): bare-number
// marks become freshness-carrying mark objects and `runs` gains run history —
// positions, trades, cash, stops, and lessons are never dropped.
function sanitizeAiFund(v: unknown): AppData['ai_fund'] {
  const base = emptyAiFund();
  if (!v || typeof v !== 'object') return base;
  const obj = v as Record<string, unknown>;
  const fund: AppData['ai_fund'] = {
    cash_usd: isFiniteNumber(obj.cash_usd) && (obj.cash_usd as number) >= 0 ? (obj.cash_usd as number) : base.cash_usd,
    started_at: typeof obj.started_at === 'string' ? obj.started_at : base.started_at,
    positions: {}, marks: {}, stops: {},
    trades: Array.isArray(obj.trades) ? (obj.trades as AppData['ai_fund']['trades']).filter((t) =>
      t && typeof t === 'object' && typeof t.ticker === 'string' && isFiniteNumber(t.price)
    ).slice(0, 500) : [],
  };
  if (obj.positions && typeof obj.positions === 'object') {
    for (const [ticker, p] of Object.entries(obj.positions as Record<string, unknown>)) {
      if (!p || typeof p !== 'object') continue;
      const q = (p as Record<string, unknown>).quantity, c = (p as Record<string, unknown>).avg_cost;
      if (isFiniteNumber(q) && (q as number) > 0 && isFiniteNumber(c) && (c as number) > 0) {
        fund.positions[String(ticker).toUpperCase().slice(0, 12)] = { quantity: q as number, avg_cost: c as number };
      }
    }
  }
  const marks = obj.marks;
  if (marks && typeof marks === 'object') {
    for (const [ticker, n] of Object.entries(marks as Record<string, unknown>)) {
      const mark = sanitizeMark(n);
      if (mark) fund.marks[String(ticker).toUpperCase().slice(0, 12)] = mark;
    }
  }
  for (const key of ['stops'] as const) {
    const src = obj[key];
    if (src && typeof src === 'object') {
      for (const [ticker, n] of Object.entries(src as Record<string, unknown>)) {
        if (isFiniteNumber(n) && (n as number) > 0) fund[key][String(ticker).toUpperCase().slice(0, 12)] = n as number;
      }
    }
  }
  fund.trades = fund.trades.slice(0, 500);
  // Run history: migrated/persisted as-is (sanitized, bounded). Abandoned
  // 'running' records are NOT replayed here — the coordinator finalizes them
  // to 'interrupted' at route level (a pure sanitize must not invent times).
  fund.runs = sanitizeRuns(obj.runs);
  return fund;
}

function sanitizeLessons(v: unknown): AppData['ai_lessons'] {
  if (!Array.isArray(v)) return [];
  return v.filter((l) => l && typeof l === 'object'
    && typeof l.ticker === 'string' && typeof l.lesson === 'string' && l.lesson.length <= 500
  ).slice(0, 100);
}

export function load(): AppData {
  if (cache) return cache;
  const file = dataFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppData>;
      const base = emptyData();
      const data: AppData = {
        watchlist: Array.isArray(parsed.watchlist) ? (parsed.watchlist as WatchlistItem[]) : base.watchlist,
        ideas: Array.isArray(parsed.ideas) ? (parsed.ideas as TrackedIdea[]) : base.ideas,
        trades: Array.isArray(parsed.trades) ? (parsed.trades as PaperTrade[]) : base.trades,
        verdict_log: Array.isArray(parsed.verdict_log) ? (parsed.verdict_log as AppData['verdict_log']) : base.verdict_log,
        portfolio: sanitizePortfolio(parsed.portfolio),
        // Answers written by the retired disclosure engine describe a system
        // that no longer exists; drop them rather than show contradictions.
        chat: Array.isArray(parsed.chat)
          ? (parsed.chat as ChatMessage[]).filter((m) => !/stored disclosure activity|demo \/ \d+ imported/i.test(String(m.content ?? '')))
          : base.chat,
        ai_fund: sanitizeAiFund(parsed.ai_fund),
        ai_lessons: sanitizeLessons(parsed.ai_lessons),
        meta: parsed.meta && typeof parsed.meta === 'object' ? { ...base.meta, ...parsed.meta } : base.meta,
      };
      cache = data;
      // Migration: v2 stores predate marks-with-freshness and run history.
      // Bump and persist ONCE so the schema change is durable; existing
      // positions/trades/cash/lessons/marks are untouched (only reshaped).
      if ((data.meta?.schema_version ?? 0) < 3) {
        data.meta = { ...data.meta, schema_version: 3 };
        try {
          persistData(data);
        } catch (err) {
          console.error('[civicfolio] schema migration write failed (continuing with migrated memory):', err);
        }
      }
      return data;
    }
  } catch (err) {
    // Corrupt file: keep a backup and start clean rather than crash.
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch { /* ignore */ }
    console.error('[civicfolio] data file unreadable; starting clean.', err);
  }
  cache = emptyData();
  return cache;
}

// Durable write: tmp file + atomic rename. Cache is NOT touched here; callers
// assign the cache only after this succeeds (see update()).
function persistData(data: AppData): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function save(data: AppData): void {
  // Direct save (used by resets): write durably first, then cache.
  persistData(data);
  cache = data;
}

/**
 * Transactional mutation: clones the current state, runs `mutate` on the
 * clone, and only commits (durable write + cache swap) if the callback
 * reports committed. If the disk write fails, the in-memory state stays at
 * the pre-mutation snapshot — memory never runs ahead of disk.
 */
export function update<T>(mutate: (draft: AppData) => { committed: boolean; value: T }): T {
  const current = load();
  const draft = structuredClone(current);
  const outcome = mutate(draft);
  if (!outcome.committed) return outcome.value;
  persistData(draft);
  cache = draft;
  return outcome.value;
}

/**
 * Copy the current data file aside before a destructive reset. Resets replace
 * the whole store, so this is the only thing standing between a mis-clicked
 * confirmation and losing real imported data. Best-effort: a backup failure
 * must not block the reset the user asked for.
 * Returns the backup path, or null if there was nothing to back up.
 */
export function backupBeforeReset(reason: string): string | null {
  const file = dataFile();
  try {
    if (!fs.existsSync(file)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dataDir(), `backup-${stamp}-${reason}.json`);
    fs.copyFileSync(file, dest);
    pruneBackups();
    return dest;
  } catch (err) {
    console.error('[civicfolio] backup before reset failed (continuing):', err);
    return null;
  }
}

// Keep the 10 most recent backups; this is a personal app, not an archive.
const MAX_BACKUPS = 10;
function pruneBackups(): void {
  try {
    const dir = dataDir();
    const backups = fs.readdirSync(dir)
      .filter((f) => f.startsWith('backup-') && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const stale of backups.slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, stale));
    }
  } catch { /* pruning is best-effort */ }
}

export function resetEmpty(): AppData {
  backupBeforeReset('before-clear');
  const data = emptyData();
  save(data);
  return data;
}

