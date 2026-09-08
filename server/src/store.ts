import type { AppData, DisclosureRecord, WatchlistItem, TrackedIdea, PaperTrade, PortfolioState, ChatMessage } from './types.js';
import { DEMO_DISCLOSURES, DEMO_WATCHLIST, DEMO_IDEAS, DEMO_TRADES } from './seedData.js';
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

export function demoData(): AppData {
  return {
    disclosures: structuredClone(DEMO_DISCLOSURES),
    watchlist: structuredClone(DEMO_WATCHLIST),
    ideas: structuredClone(DEMO_IDEAS),
    trades: structuredClone(DEMO_TRADES),
    portfolio: {
      cash_usd: Math.round((100000 - DEMO_SEED_SPEND) * 100) / 100,
      positions: { ARRX: { quantity: 10, cost_basis_usd: 425 }, CYPW: { quantity: 5, cost_basis_usd: 140.5 } },
      // Present so in-memory demo state matches what a disk round-trip returns.
      marks: {},
    },
    chat: [],
    meta: {
      seed_version: 1,
      demo_loaded_at: new Date().toISOString(),
      imports: [],
    },
  };
}

export function emptyData(): AppData {
  return {
    disclosures: [],
    watchlist: [],
    ideas: [],
    trades: [],
    portfolio: emptyPortfolio(),
    chat: [],
    meta: { seed_version: 1, demo_loaded_at: null, imports: [] },
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

export function load(): AppData {
  if (cache) return cache;
  const file = dataFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppData>;
      const base = emptyData();
      const data: AppData = {
        disclosures: Array.isArray(parsed.disclosures) ? (parsed.disclosures as DisclosureRecord[]) : base.disclosures,
        watchlist: Array.isArray(parsed.watchlist) ? (parsed.watchlist as WatchlistItem[]) : base.watchlist,
        ideas: Array.isArray(parsed.ideas) ? (parsed.ideas as TrackedIdea[]) : base.ideas,
        trades: Array.isArray(parsed.trades) ? (parsed.trades as PaperTrade[]) : base.trades,
        portfolio: sanitizePortfolio(parsed.portfolio),
        chat: Array.isArray(parsed.chat) ? (parsed.chat as ChatMessage[]) : base.chat,
        meta: parsed.meta && typeof parsed.meta === 'object' ? { ...base.meta, ...parsed.meta } : base.meta,
      };
      cache = data;
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

export function resetDemo(): AppData {
  backupBeforeReset('before-demo-load');
  const data = demoData();
  save(data);
  return data;
}

export function resetEmpty(): AppData {
  backupBeforeReset('before-clear');
  const data = emptyData();
  save(data);
  return data;
}

export function addImportToMeta(filename: string, count: number): void {
  update((draft) => {
    draft.meta.imports.push({ filename: path.basename(filename), imported_at: new Date().toISOString(), count });
    return { committed: true, value: undefined as void };
  });
}