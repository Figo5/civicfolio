// Durable run history + the single guarded coordinator for the AI fund.
//
// Every pass of the fund loop — scheduled, manual button, or explicit chat —
// goes through startFundRun() here. Exactly one run executes at a time;
// concurrent callers get the live run's id/status back (never a queued
// invisible duplicate), retries carrying the same request_id get the same
// run, and a crash/restart leaves 'running' records finalized as
// 'interrupted' WITHOUT replaying any trades.
//
// Run records are bounded (MAX_AI_FUND_RUNS) and sanitized by the store.

import { randomUUID } from 'node:crypto';
import type { AppData, AiFundRun, AiFundRunAction } from './types.js';
import { MAX_AI_FUND_RUNS } from './types.js';
import { load, update } from './store.js';
import { systemClock, type Clock } from './clock.js';
import { fundEquity, marksAreStale } from './aiFund.js';

// ---- abandoned-run recovery ------------------------------------------------

/** Called once at startup/route creation: abandoned 'running' -> 'interrupted'. */
export function finalizeInterruptedRuns(clock: Clock = systemClock): number {
  const d = load();
  const now = new Date(clock()).toISOString();
  const running = (d.ai_fund.runs ?? []).filter((r) => r.status === 'running');
  if (running.length === 0) return 0;
  update((draft) => {
    for (const r of draft.ai_fund.runs ?? []) {
      if (r.status === 'running') {
        // Never replay: the record is closed as-is, with no invented detail.
        r.status = 'interrupted';
        r.finished_at = now;
        r.note = 'interrupted: server restarted or the process ended before this run finished; no trades were replayed';
      }
    }
    return { committed: true, value: null as unknown };
  });
  return running.length;
}

// ---- single-flight coordinator ---------------------------------------------

interface ActiveRun {
  run: AiFundRun;
  promise: Promise<{ run: AiFundRun; error?: string }>;
}
let active: ActiveRun | null = null;

/** The currently executing run, if any (for /api/fund status fields). */
export function activeRun(): AiFundRun | null {
  return active ? { ...active.run } : null;
}

/** A completed run previously returned for this request_id, if still in history. */
export function findRunByRequestId(requestId: string): AiFundRun | null {
  const runs = load().ai_fund.runs ?? [];
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].request_id === requestId) return { ...runs[i] };
  }
  return null;
}

export interface RunOutcome {
  reused: boolean; // true = an existing run was returned (already running or same request_id)
  run: AiFundRun;
  error?: string;
}

/**
 * Start a guarded fund run. `body` performs the actual loop work and returns
 * its actions + failure notes + the model id that answered (null when none
 * ran). If a run is already executing, its id/status is returned with
 * reused:true — no second execution is started. A retried request_id returns
 * that run's record instead of rerunning (idempotent client retries).
 */
export function startFundRun(
  trigger: AiFundRun['trigger'],
  body: (ctx: {
    addActions: (a: AiFundRunAction[]) => void;
    addFailures: (f: { kind: string; note: string }[]) => void;
    setModel: (m: string | null) => void;
    recordTrades: (n: number) => void;
  }) => Promise<void>,
  opts: { requestId?: string; clock?: Clock } = {},
): Promise<RunOutcome> {
  const clock = opts.clock ?? systemClock;

  // Client idempotency: same request_id -> same run, no rerun.
  if (opts.requestId) {
    const prior = findRunByRequestId(opts.requestId);
    if (prior && prior.status !== 'running') return Promise.resolve({ reused: true, run: prior });
  }

  // Single flight: a second caller while busy gets the live run, never a
  // duplicate queued execution.
  if (active) return Promise.resolve({ reused: true, run: { ...active.run } });

  const startedIso = new Date(clock()).toISOString();
  const id = randomUUID();
  const created: AiFundRun = {
    id,
    ...(opts.requestId ? { request_id: opts.requestId } : {}),
    trigger,
    started_at: startedIso,
    finished_at: null,
    status: 'running',
    actions: [],
    failures: [],
    trades_occurred: false,
    equity_usd: null,
    valued_at: null,
    marks_stale: false,
    model_used: null,
  };
  // Persist 'running' BEFORE any long operation.
  update((draft) => {
    draft.ai_fund.runs = [...(draft.ai_fund.runs ?? []), created];
    draft.ai_fund.runs = draft.ai_fund.runs.slice(-MAX_AI_FUND_RUNS);
    return { committed: true, value: null as unknown };
  });

  const mutable: AiFundRun = { ...created, actions: [], failures: [] };
  const promise = (async (): Promise<{ run: AiFundRun; error?: string }> => {
    let bodyError: string | undefined;
    try {
      await body({
        addActions: (a) => { mutable.actions.push(...a); },
        addFailures: (f) => { mutable.failures.push(...f); },
        setModel: (m) => { mutable.model_used = m; },
        recordTrades: (n) => { mutable.trades_occurred = mutable.trades_occurred || n > 0; },
      });
    } catch (err) {
      bodyError = err instanceof Error ? err.message : String(err);
      mutable.failures.push({ kind: 'other', note: bodyError.slice(0, 500) });
    } finally {
      // Finalize through the guarded path: EVERY exit (throw, return, early
      // bail) lands here. The record never survives as 'running'.
      const finishedIso = new Date(clock()).toISOString();
      mutable.finished_at = finishedIso;
      if (!bodyError && mutable.failures.length === 0) mutable.status = 'completed';
      else if (!bodyError) mutable.status = 'partial'; // data/model failure visible, never swallowed
      else mutable.status = 'failed';
      mutable.equity_usd = Number(fundEquity(load()).toFixed(2));
      mutable.valued_at = finishedIso;
      mutable.marks_stale = marksAreStale(load());
      update((draft) => {
        const runs = draft.ai_fund.runs ?? [];
        const idx = runs.findIndex((r) => r.id === id);
        if (idx >= 0) runs[idx] = { ...mutable, actions: [...mutable.actions], failures: [...mutable.failures] };
        else runs.push({ ...mutable, actions: [...mutable.actions], failures: [...mutable.failures] });
        draft.ai_fund.runs = runs.slice(-MAX_AI_FUND_RUNS);
        return { committed: true, value: null as unknown };
      });
      active = null;
    }
    return { run: { ...mutable, actions: [...mutable.actions], failures: [...mutable.failures] }, error: bodyError };
  })();

  active = { run: mutable, promise };
  return promise.then((r) => ({ reused: false, run: r.run, error: r.error }));
}