// Historical fund.log import — explicitly labeled summaries, never full
// fabricated records.
//
// The pre-repair scheduler wrote one line per run to ~/.civicfolio/fund.log:
//   [2026-09-09T13:35:12.443Z] scheduled: equity $10000 — INTC hold, SPCX no-trade
// Those runs predate durable run history, so we import ONLY what the log line
// literally states (timestamp, equity, ticker+action tokens) into
// `ai_fund.runs` as {imported:true} summary records. No model ids, no per-run
// details beyond the tokens, no invented timestamps. The import is
// idempotent: each parsed line maps to a deterministic id (hash of the whole
// line), and already-present ids are skipped. Failing/skipped lines are
// reported, never guessed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AppData, AiFundRun } from './types.js';
import { MAX_AI_FUND_RUNS } from './types.js';
import { update, load } from './store.js';

const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+(\w+):\s+equity\s+\$([\d,]+(?:\.\d+)?)\s*[—–-]\s*(.+)$/;

/** Deterministic id for a log line (stable across re-imports). */
function importedRunId(line: string): string {
  return 'imported-' + createHash('sha256').update(line).digest('hex').slice(0, 16);
}

/** Parse one fund.log line into an imported run record, or null when unparseable. */
export function parseFundLogLine(line: string): AiFundRun | null {
  const m = LOG_LINE_RE.exec(line.trim());
  if (!m) return null;
  const ts = m[1];
  const trigger = m[2] === 'scheduled' ? 'scheduled' : m[2] === 'manual' ? 'manual' : null;
  if (!trigger) return null;
  const equity = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(equity)) return null;
  // Token list only: "INTC hold", "GRAB no-trade" -> per-ticker actions as stated.
  const actions: AiFundRun['actions'] = [];
  for (const token of m[4].split(',')) {
    const t = token.trim();
    const tm = /^([A-Z.-]{1,10})\s+(hold|no-trade|skip|buy|sell|stop-sell|exit-sell)$/i.exec(t);
    if (!tm) continue; // unknown token shape: skip it, never invent a detail
    actions.push({ ticker: tm[1].toUpperCase(), action: tm[2].toLowerCase(), detail: 'as logged by the pre-history scheduler (summary only)' });
  }
  return {
    id: importedRunId(line),
    trigger,
    started_at: ts,
    finished_at: ts,
    status: 'completed',
    actions,
    failures: [],
    trades_occurred: false, // log carries no trade info; hold/no-trade only
    equity_usd: equity,
    valued_at: ts,
    marks_stale: false,
    model_used: null, // unknown from the log — never invented
    imported: true,
    note: `imported from fund.log: ${line.trim().slice(0, 300)}`,
  };
}

export interface ImportResult {
  imported: number;
  skipped_existing: number;
  unparseable: number;
}

/**
 * Import historical fund.log summaries into ai_fund.runs, once. Idempotent
 * (deterministic per-line ids); preserves everything else in the store.
 * Bounded to the newest 200 runs combined with real history.
 */
export function importFundLog(logPath?: string): ImportResult {
  const file = logPath ?? (typeof process.env.CIVICFOLIO_FUND_LOG === 'string' && process.env.CIVICFOLIO_FUND_LOG
    ? process.env.CIVICFOLIO_FUND_LOG
    : path.join(os.homedir(), '.civicfolio', 'fund.log'));
  let text: string;
  try {
    if (!fs.existsSync(file)) return { imported: 0, skipped_existing: 0, unparseable: 0 };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { imported: 0, skipped_existing: 0, unparseable: 0 };
  }

  const parsed: AiFundRun[] = [];
  let unparseable = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const rec = parseFundLogLine(line);
    if (rec) parsed.push(rec); else unparseable += 1;
  }

  let imported = 0;
  let skipped = 0;
  update((draft) => {
    const existing = new Set((draft.ai_fund.runs ?? []).map((r) => r.id));
    const fresh = parsed.filter((r) => {
      if (existing.has(r.id)) { skipped += 1; return false; }
      existing.add(r.id);
      imported += 1;
      return true;
    });
    if (fresh.length === 0) return { committed: false, value: null as unknown };
    // Merge with existing real history: imported summaries first (oldest),
    // real records last. Bounded to MAX_AI_FUND_RUNS.
    draft.ai_fund.runs = [...(draft.ai_fund.runs ?? []), ...fresh].slice(-MAX_AI_FUND_RUNS);
    return { committed: true, value: null as unknown };
  });
  return { imported, skipped_existing: skipped, unparseable };
}

/** Convenience: run once at startup if history is empty and a log exists.
 *  Skipped when an isolated test data dir is configured without an explicit
 *  log override — tests must never read the machine's real fund.log. */
export function importFundLogOnceIfEmpty(): ImportResult {
  const d = load();
  if ((d.ai_fund.runs ?? []).length > 0) return { imported: 0, skipped_existing: 0, unparseable: 0 };
  const testIsolated = Boolean(process.env.CIVICFOLIO_DATA_DIR);
  const explicitLog = Boolean(process.env.CIVICFOLIO_FUND_LOG);
  if (testIsolated && !explicitLog) return { imported: 0, skipped_existing: 0, unparseable: 0 };
  return importFundLog();
}