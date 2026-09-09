// Fund-aware chat: a STRICT intent boundary + a READ-ONLY status snapshot.
//
// The old broad regex (/\brun (the )?fund\b|make (a |some )?trades?\b|.../)
// fired on questions like "Did you run the fund?" and even "Don't run the
// fund" — a status question could execute paper trades. Execution now requires
// an affirmative imperative; questions get a bounded snapshot of the stored
// record and never touch the loop.

import type { AppData, AiFundRun } from './types.js';
import { FUND_START_USD, fundEquity } from './aiFund.js';

export type FundIntent = 'run' | 'status' | 'none';

// Execution: affirmative imperative ONLY. Interrogatives and negations must
// never reach the loop.
const RUN_RE = /^\s*(?:hey\s+|please\s+)?run\s+(?:the\s+)?(?:paper\s+|ai\s+)?fund(?:\s+now)?\s*[.!]?\s*$/i;
// Affirmative verb + object, bounded: "make a trade", "do your thing",
// "trade for yourself" — but NOT "did you trade", "have you traded",
// "don't make trades", "what trades did you make".
const RUN_LOOSE_RE = /^\s*(?:please\s+)?(?:(?:go ahead and|go)\s+)?(?:(?:make|do|execute|place)\s+(?:a |some |any )?(?:paper\s+)?trades?|(?:do)\s+your\s+(?:thing|trades)|trade\s+for\s+yourself)\s*(?:now|today)?\s*[.!]?\s*$/i;

/** Classify a chat message against the fund. Strict: questions never run. */
export function classifyFundIntent(rawQuestion: string): FundIntent {
  const q = rawQuestion.trim();
  if (!q) return 'none';
  // Negation anywhere -> never an execution request.
  if (/\b(do not|don'?t|no need|never mind|stop|without)\b/i.test(q)) {
    // "don't run the fund" style: fall through to status check only.
    if (/\bfund\b/i.test(q) || /\b(run|trades?|trad(e|ed|ing))\b/i.test(q)) return 'status';
    return 'none';
  }
  if (RUN_RE.test(q) || RUN_LOOSE_RE.test(q)) return 'run';
  // Interrogatives about the fund are status questions, never execution.
  if (/\b(did|have|has|is|are|was|were|what|why|when|how|which)\b[\s\S]{0,40}\bfund\b/i.test(q)) return 'status';
  // Past-tense trade questions ("have you traded?", "did you make any trades
  // today?") are status: asking about activity can never START activity.
  if (/\b(did|have|has)\b[\s\S]{0,40}\b(trades?|trad(e|ed|ing))\b/i.test(q)) return 'status';
  if (/\bfund\b/i.test(q) || /\bpaper (fund|money)\b/i.test(q)) return 'status';
  return 'none';
}

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TRIGGER_LABEL: Record<AiFundRun['trigger'], string> = {
  scheduled: 'scheduler',
  manual: 'Run-the-fund button',
  chat: 'chat command',
};

function describeRun(r: AiFundRun): string {
  const when = r.finished_at ?? r.started_at;
  const bits = [`[${when.slice(0, 16).replace('T', ' ')} UTC] ${r.status} (${TRIGGER_LABEL[r.trigger] ?? r.trigger})`];
  if (r.imported === true) bits.push(`imported from fund.log: ${r.note ?? ''}`);
  if (r.actions.length > 0) {
    bits.push(r.actions.slice(0, 6).map((a) => `${a.ticker === '-' ? 'scan' : a.ticker}: ${a.action} — ${a.detail}`.slice(0, 120)).join('\n  '));
    if (r.actions.length > 6) bits.push(`  … and ${r.actions.length - 6} more`);
  } else if (r.imported !== true) {
    bits.push('no ticker actions recorded');
  }
  if (r.failures.length > 0) {
    bits.push(`failures: ${r.failures.slice(0, 3).map((f) => f.note.slice(0, 100)).join(' | ')}`);
  }
  if (r.marks_stale) bits.push('some marks stale/unavailable at finish');
  if (r.model_used) bits.push(`model: ${r.model_used}`);
  return bits.join('\n  ');
}

/**
 * Bounded read-only snapshot for fund-status questions. Everything traces to
 * the stored record; nothing is invented, and a "run" is only claimed when a
 * record exists. Never executes anything.
 */
export function fundStatusAnswer(d: AppData): string {
  const fund = d.ai_fund;
  const runs = fund.runs ?? [];
  const lines: string[] = [];

  lines.push(`Civicfolio AI fund — fictional paper money, started with ${usd(FUND_START_USD)}. No broker exists in this app; nothing here touches real money.`);

  const markedEquity = fundEquity(d);
  const anyStale = Object.keys(fund.positions).some((t) => {
    const m = fund.marks[t];
    return !m || m.stale === true;
  });
  lines.push(`Cash ${usd(fund.cash_usd)}; equity (paper estimate) ${usd(markedEquity)}${anyStale ? ' — some positions are valued at cost or with stale marks, so treat the total as an estimate' : ''}.`);

  const held = Object.entries(fund.positions);
  if (held.length === 0) {
    lines.push('Open positions: none.');
  } else {
    lines.push('Open positions (paper):');
    for (const [ticker, pos] of held) {
      const mark = fund.marks[ticker];
      if (mark && typeof mark.price === 'number') {
        const fresh = mark.stale === true ? 'STALE mark' : 'mark';
        const asOf = mark.quote_as_of ? `quote as of ${mark.quote_as_of.slice(0, 16).replace('T', ' ')}` : 'quote time unknown';
        lines.push(`- ${ticker}: ${pos.quantity} sh @ avg cost ${usd(pos.avg_cost)}, last mark ${usd(mark.price)} (${asOf}${mark.quote_source ? `, ${mark.quote_source}` : ''}${mark.stale === true ? ', stale' : ''}, marked at ${mark.fetched_at?.slice(0, 16).replace('T', ' ') ?? 'unknown'})`);
      } else {
        lines.push(`- ${ticker}: ${pos.quantity} sh @ avg cost ${usd(pos.avg_cost)} — NO MARK available, valued at cost; P/L unknown until a quote arrives`);
      }
    }
  }

  const realTrades = fund.trades.filter((t) => t.side && t.executed_at);
  if (realTrades.length > 0) {
    lines.push('Recent paper trades (delayed-quote executions, not real orders):');
    for (const t of realTrades.slice(0, 5)) {
      const pnl = typeof t.realized_pnl_usd === 'number' ? `, realized ${usd(t.realized_pnl_usd)}` : '';
      lines.push(`- ${t.executed_at.slice(0, 16).replace('T', ' ')} UTC: ${t.side.toUpperCase()} ${t.quantity} ${t.ticker} @ ${usd(t.price)}${pnl}`);
    }
  } else {
    lines.push('No paper trades recorded yet.');
  }

  const completed = runs.filter((r) => r.status !== 'running');
  const running = runs.find((r) => r.status === 'running');
  if (running) {
    lines.push(`A run is executing right now (started ${running.started_at.slice(0, 16).replace('T', ' ')} UTC, ${TRIGGER_LABEL[running.trigger] ?? running.trigger}); it will be recorded when it finishes.`);
  }
  if (completed.length > 0) {
    const last = completed[completed.length - 1];
    lines.push(`Last run: ${describeRun(last)}`);
    const older = completed.slice(-4, -1).reverse();
    if (older.length > 0) {
      lines.push('Earlier runs:');
      for (const r of older) lines.push('  ' + describeRun(r).split('\n')[0]);
    }
  } else {
    lines.push('No fund runs recorded yet — nothing has been claimed or executed.');
  }

  if (d.ai_lessons.length > 0) {
    lines.push('Recorded lessons (model-generated hypotheses from closed paper trades, NOT facts):');
    for (const l of d.ai_lessons.slice(0, 3)) lines.push(`- [${l.ticker}] ${l.lesson}`);
  }

  lines.push('These are delayed-quote paper estimates, not real execution returns.');
  return lines.join('\n');
}

/** "Why is the fund holding X?" — recorded rationale + constraints, read-only. */
export function fundExplainAnswer(d: AppData, ticker: string): string | null {
  const pos = d.ai_fund.positions[ticker];
  if (!pos) return null;
  const buys = d.ai_fund.trades.filter((t) => t.ticker === ticker && t.side === 'buy');
  const lines: string[] = [];
  lines.push(`The paper fund holds ${pos.quantity} ${ticker} @ avg cost ${usd(pos.avg_cost)} (fictional money).`);
  const buy = buys[0];
  if (buy) {
    lines.push(`Recorded rationale from the ${buy.executed_at.slice(0, 10)} buy (a model research verdict the code then sized deterministically):`);
    lines.push(`  "${buy.rationale}"`);
    lines.push(`Executed at the real delayed quote of ${usd(buy.price)} (as of ${buy.quote_as_of}) — never a model-typed price.`);
  }
  const stop = d.ai_fund.stops[ticker];
  if (stop) lines.push(`Constraints in force: deterministic sizing (max 20%/name, 2% risk/trade), a stop at ${usd(stop)}, min-hold 2 days for thesis exits.`);
  return lines.join('\n');
}

/** Persist a fund-related user/assistant pair in the correct chat thread. */
export function persistFundChat(
  question: string,
  answer: string,
  thread: string | undefined,
  opts: { mode?: 'deterministic' | 'llm'; model?: string | null } = {},
): void {
  void import('./store.js').then(({ update }) => {
    const ts = new Date().toISOString();
    const userMsg = { role: 'user' as const, content: question, ts, ...(thread ? { ticker: thread } : {}) };
    const msg = {
      role: 'assistant' as const,
      content: answer,
      mode: opts.mode ?? ('deterministic' as const),
      ts,
      ...(thread ? { ticker: thread } : {}),
      model_used: opts.model ?? null,
    };
    update((draft) => { draft.chat.push(userMsg, msg); return { committed: true, value: undefined as void }; });
  });
}

/** Avoid treating the word "AI" as a ticker in fund questions. */
export function stripFundNoiseTickers(tickers: string[]): string[] {
  return tickers.filter((t) => t !== 'AI');
}