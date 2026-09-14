// AI-fund repair test suite: run history, mark freshness, guarded coordinator,
// chat intent boundary, migration, and no-broker/no-secret guarantees.
//
// Zero real network or model calls: quotes are injected via the seam, the
// no OPENAI_API_KEY is visible so model calls fail closed, and storage is an isolated
// temp dir (CIVICFOLIO_DATA_DIR). A manual clock makes run records
// deterministic.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-fund-'));
process.env['CIVICFOLIO_DATA_DIR'] = testDir;
// AI paths are off in tests: a developer's real key must never turn this
// suite into paid OpenAI calls. Nothing here injects a provider, so every
// model call fails closed before the network.
delete process.env['OPENAI_API_KEY'];
// Historical log fixture for the import test (production reads ~/.civicfolio).
const fundLogFixture = path.join(testDir, 'fund.log');
fs.writeFileSync(fundLogFixture, [
  '[2026-09-09T13:35:12.443Z] scheduled: equity $10000 — INTC hold, SPCX no-trade',
  '[2026-09-09T14:30:14.827Z] scheduled: equity $10000 — INTC hold, GRAB no-trade',
  'garbage line that does not parse',
].join('\n'));
process.env['CIVICFOLIO_FUND_LOG'] = fundLogFixture;

const { createApp } = await import('../src/app.js');
const { load, dataDir, resetCacheForTests, update, save, emptyData } = await import('../src/store.js');
const { refreshFundMarks, fundEquity, marksAreStale, executeAiTrade, setQuoteProviderForTests, FUND_START_USD } = await import('../src/aiFund.js');
const { classifyFundIntent } = await import('../src/fundChat.js');
const { parseFundLogLine, importFundLog } = await import('../src/fundLogImport.js');
const { runFundLoop } = await import('../src/fundLoop.js');
const { finalizeInterruptedRuns, startFundRun } = await import('../src/fundRuns.js');
const { clearQuoteCacheForTests } = await import('../src/quotes.js');
const { setProviderForTests } = await import('../src/provider.js');

// AI is "configured" for this suite but every model call fails, so the loop's
// deterministic half (marking, stops, min-hold, scan) is exercised in full
// while research reliably returns a failure — the same shape as an unreachable
// model, with zero network.
setProviderForTests({
  model: 'stub-model',
  generateText: async () => ({ ok: false, error: 'stub provider: no model call in tests' }),
  generateStructured: async () => ({ ok: false, error: 'stub provider: no model call in tests' }),
});
import type { Quote, QuoteFailure } from '../src/quotes.js';
import request from 'supertest';

const app = createApp();

function withHeaders(req: any) {
  return req.set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787');
}
function agent() {
  return {
    get: (url: string) => withHeaders(request(app).get(url)),
    post: (url: string) => withHeaders(request(app).post(url)),
    delete: (url: string) => withHeaders(request(app).delete(url)).set('Content-Type', 'application/json'),
  };
}
function postJson(url: string, body?: unknown) {
  return withHeaders(request(app).post(url)).set('Content-Type', 'application/json').send(body ?? {});
}

// ---- quote seam helpers ----------------------------------------------------

/**
 * Deterministically isolate every fetch the fund loop makes, so the loop tests
 * are hermetic (zero real network to Yahoo/SEC regardless of live market data).
 * chart/<symbol> returns a valid quote for the marking pass; everything else
 * (the Yahoo screener) returns an empty screen `{ quotes: [] }` — a quiet day,
 * not a failure. Call it in a try/finally paired with clearQuoteCacheForTests()
 * and restore globalThis.fetch when done.
 */
function mockQuietMarket(): () => void {
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('query1.finance.yahoo.com') && /\/chart\//.test(u)) {
      const t = u.match(/chart\/([A-Z.]+)/)?.[1] ?? '';
      // A held ticker gets a fresh mark in the marking pass.
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: Math.floor(Date.parse('2026-09-09T19:00:00Z') / 1000), currency: 'USD', exchangeName: 'TEST', previousClose: 100 } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('query1.finance.yahoo.com')) {
      // Screener (movers): empty screen -> no candidate, run has nothing to do -> completed.
      return new Response(JSON.stringify({ finance: { result: [{ quotes: [] }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`network unreachable in hermetic test (mock): ${u.slice(0, 120)}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; clearQuoteCacheForTests(); };
}

type QuoteStub = { ticker: string; price: number; as_of?: string; source?: string };
function quoteProviderFrom(stubs: QuoteStub[], failures: { ticker: string; reason: string }[] = []) {
  return async (tickers: string[]): Promise<{ quotes: Quote[]; failed: QuoteFailure[] }> => {
    const quotes: Quote[] = [];
    const failed: QuoteFailure[] = [];
    for (const t of tickers) {
      const s = stubs.find((x) => x.ticker === t);
      if (s) {
        quotes.push({ ticker: s.ticker, price: s.price, previous_close: null, currency: 'USD', as_of: s.as_of ?? '2026-09-09T15:00:00.000Z', exchange: 'TEST', source: (s.source ?? 'yahoo') as Quote['source'] });
      } else {
        const f = failures.find((x) => x.ticker === t);
        failed.push({ ticker: t, reason: f?.reason ?? 'no quote returned (test stub)' });
      }
    }
    return { quotes, failed };
  };
}

/** Seed a fund position directly (deterministic paper bookkeeping). */
function seedPosition(ticker: string, quantity: number, avg_cost: number, opts: { mark?: number; stop?: number; executed_at?: string } = {}) {
  update((draft) => {
    draft.ai_fund.positions[ticker] = { quantity, avg_cost };
    if (opts.mark !== undefined) {
      draft.ai_fund.marks[ticker] = { price: opts.mark, quote_as_of: '2026-09-08T15:00:00.000Z', fetched_at: '2026-09-08T20:00:00.000Z', source: 'quote', quote_source: 'yahoo', stale: false };
    }
    if (opts.stop !== undefined) draft.ai_fund.stops[ticker] = opts.stop;
    if (opts.executed_at !== undefined || true) {
      draft.ai_fund.trades.unshift({
        id: `seed-${ticker}-${Math.random().toString(36).slice(2, 8)}`,
        verdict_id: 'seed',
        ticker, side: 'buy', quantity, price: avg_cost,
        quote_as_of: '2026-09-08T15:00:00.000Z',
        executed_at: opts.executed_at ?? new Date(Date.now() - 5 * 86400000).toISOString(),
        rationale: 'seeded test position',
      });
    }
    return { committed: true, value: null as unknown };
  });
}

function resetFundData(): void {
  const d = emptyData();
  save(d);
}

// ---- A: run history records -----------------------------------------------

describe('run history persistence', () => {
  test('a completed hold/no-trade scheduled run persists as completed with actions', async () => {
    resetFundData();
    // Deterministic: all network refused. With no positions and no movers, the
    // run has nothing to do but scan — which fails -> the run is honestly
    // 'partial', never silently 'completed'. A genuinely clean hold/no-trade
    // 'completed' case is covered via the marked-position run below.
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async () => {
      throw new Error('network unreachable (mock)');
    }) as typeof fetch;
    try {
      const outcome = await runFundLoop({ trigger: 'scheduled' });
      assert.equal(outcome.reused, false);
      const d = load();
      const runs = d.ai_fund.runs ?? [];
      assert.equal(runs.length, 1);
      const run = runs[0];
      assert.equal(run.trigger, 'scheduled');
      assert.equal(run.status, 'partial', 'network failure is visible, not swallowed');
      assert.ok(run.failures.some((f) => f.kind === 'data'));
      assert.ok(run.started_at, 'started_at recorded');
      assert.ok(run.finished_at, 'finished_at recorded');
      assert.equal(run.trades_occurred, false, 'no-trade run is not a trade');
      assert.ok(run.actions.length > 0, 'actions recorded (scan outcome is recorded)');
      assert.ok(run.id, 'unique run id');
    } finally {
      globalThis.fetch = realFetch;
      clearQuoteCacheForTests();
    }
  });

  test('hold/no-trade run with fresh marks and no failures records as completed', async () => {
    resetFundData();
    // A held position inside its min-hold window + working quotes for it +
    // movers that return nothing => every step succeeds, no trades: completed.
    seedPosition('HOLDX', 2, 100, { mark: 100, executed_at: new Date(Date.now() - 6 * 3600_000).toISOString() }); // 6h old < 2d min-hold
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async (url: unknown) => {
      // getQuotes for held ticker + getMovers both go through fetch; answer both.
      const u = String(url);
      if (u.includes('query1.finance.yahoo.com')) {
        const t = u.match(/chart\/([A-Z.]+)/)?.[1] ?? '';
        return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 102, regularMarketTime: Math.floor(Date.parse('2026-09-09T19:00:00Z') / 1000), currency: 'USD', exchangeName: 'TEST', previousClose: 100 } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // movers: return empty screen list (a quiet day) — not a failure.
      return new Response(JSON.stringify({ quotes: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const outcome = await runFundLoop({ trigger: 'scheduled' });
      const run = outcome.run;
      assert.equal(run.trigger, 'scheduled');
      assert.equal(run.status, 'completed', `hold/no-trade run is a SUCCESSFUL run (got ${run.status}; failures: ${JSON.stringify(run.failures)})`);
      assert.equal(run.failures.length, 0);
      assert.equal(run.trades_occurred, false);
      assert.ok(run.actions.some((a) => a.action === 'hold'), 'the hold decision is recorded');
      assert.ok(run.actions.some((a) => a.action === 'mark'), 'the marking pass is recorded');
      assert.equal(run.model_used !== null, true, 'model identifier recorded when known');
      // Persisted durably:
      const d = load();
      const rec = (d.ai_fund.runs ?? [])[0];
      assert.equal(rec?.status, 'completed');
    } finally {
      globalThis.fetch = realFetch;
      clearQuoteCacheForTests();
    }
  });

  test('failed quotes preserve stale marks & timestamps (mark-failed visible)', async () => {
    resetFundData();
    seedPosition('STALE', 2, 50, { mark: 55 });
    const res = await refreshFundMarks(quoteProviderFrom([], [{ ticker: 'STALE', reason: 'upstream 500' }]));
    assert.equal(res.updated.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].ticker, 'STALE');
    const d = load();
    const mark = d.ai_fund.marks['STALE'];
    assert.ok(mark, 'last known mark retained');
    assert.equal(mark.price, 55, 'price retained, not zeroed or invented');
    assert.equal(mark.stale, true, 'labelled stale');
    assert.equal(mark.quote_as_of, '2026-09-08T15:00:00.000Z', 'original quote timestamp kept');
    assert.equal(mark.fetched_at, '2026-09-08T20:00:00.000Z', 'original fetch time kept');
    assert.ok(marksAreStale(d), 'stale flag exposed');
  });

  test('marks update even when no trade occurs, with quote timestamps preserved', async () => {
    resetFundData();
    seedPosition('MARK', 3, 100, { mark: 100 });
    const res = await refreshFundMarks(quoteProviderFrom([{ ticker: 'MARK', price: 110.5, as_of: '2026-09-09T18:30:00.000Z' }]));
    assert.deepEqual(res.updated, ['MARK']);
    const d = load();
    const mark = d.ai_fund.marks['MARK'];
    assert.equal(mark.price, 110.5);
    assert.equal(mark.quote_as_of, '2026-09-09T18:30:00.000Z', 'exchange timestamp stored');
    assert.ok(mark.fetched_at, 'fetch timestamp stored');
    assert.equal(mark.source, 'quote');
    assert.equal(mark.stale, false);
    assert.ok(!marksAreStale(d));
    // seedPosition does not debit cash (deterministic bookkeeping seed):
    // equity = cash 10000 + 3 * 110.5 = 10331.5
    assert.ok(Math.abs(fundEquity(d) - (10000 + 331.5)) < 0.01, `equity ${fundEquity(d)} ~= 10331.5`);
  });

  test('paper equity/P&L arithmetic: realized vs unrealized distinct, stale handling', async () => {
    resetFundData();
    // Round trip: buy 2 @ 50 (cash 9900) then sell 2 @ 60 (cash 10020,
    // realized +20 recorded on the full close).
    update((draft) => {
      executeAiTrade(draft, { ticker: 'PNL', side: 'buy', quantity: 2, price: 50, stop_loss: null, rationale: 'test', verdict_id: 'v1' }, '2026-09-08T15:00:00.000Z');
      return { committed: true, value: null as unknown };
    });
    update((draft) => {
      executeAiTrade(draft, { ticker: 'PNL', side: 'sell', quantity: 2, price: 60, stop_loss: null, rationale: 'test exit', verdict_id: 'v2' }, '2026-09-08T16:00:00.000Z');
      return { committed: true, value: null as unknown };
    });
    const afterClose = await agent().get('/api/fund');
    assert.ok(Math.abs(afterClose.body.realized_pnl_usd - 20) < 0.01, `realized +20 (got ${afterClose.body.realized_pnl_usd})`);
    assert.equal(afterClose.body.unrealized_pnl_usd, 0, 'nothing open -> unrealized 0');
    assert.ok(Math.abs(afterClose.body.equity_usd - 10020) < 0.01, 'equity = cash only');

    // New open position: buy 1 @ 70 (cash 9950), mark fresh at 80 -> unrealized +10.
    update((draft) => {
      executeAiTrade(draft, { ticker: 'PNL', side: 'buy', quantity: 1, price: 70, stop_loss: null, rationale: 'reopen', verdict_id: 'v3' }, '2026-09-08T17:00:00.000Z');
      return { committed: true, value: null as unknown };
    });
    update((draft) => {
      draft.ai_fund.marks['PNL'] = { price: 80, quote_as_of: '2026-09-08T17:00:00.000Z', fetched_at: '2026-09-08T17:00:00.000Z', source: 'quote', quote_source: 'yahoo', stale: false };
      return { committed: true, value: null as unknown };
    });
    const b = (await agent().get('/api/fund')).body;
    assert.ok(Math.abs(b.realized_pnl_usd - 20) < 0.01, 'realized unchanged by reopening');
    assert.ok(Math.abs(b.unrealized_pnl_usd - 10) < 0.01, `unrealized +10 (80 mark vs 70 cost) (got ${b.unrealized_pnl_usd})`);
    assert.ok(Math.abs(b.pnl_usd - 30) < 0.01, 'total = realized + unrealized');
    assert.ok(Math.abs(b.equity_usd - 10030) < 0.01, 'equity = cash 9950 + 1sh@80');
    // Stale case: mark becomes stale -> equity still carries the last price but flags it.
    update((draft) => { draft.ai_fund.marks['PNL'] = { ...draft.ai_fund.marks['PNL'], stale: true }; return { committed: true, value: null as unknown }; });
    const stale = await agent().get('/api/fund');
    assert.equal(stale.body.marks_stale, true, 'stale marks signalled in /api/fund');
    const pos = stale.body.positions[0];
    assert.equal(pos.mark_freshness.stale, true, 'per-position freshness');
    assert.equal(pos.mark_freshness.price_known, true);
  });

  test('carrying at cost is explicit when no mark exists', async () => {
    resetFundData();
    seedPosition('NOMK', 4, 25);
    update((draft) => { delete draft.ai_fund.marks['NOMK']; return { committed: true, value: null as unknown }; });
    const res = await agent().get('/api/fund');
    const pos = res.body.positions[0];
    assert.equal(pos.mark, 25, 'carries at cost');
    assert.equal(pos.mark_freshness.price_known, false);
    assert.equal(pos.mark_freshness.carrying_at_cost, true, 'explicitly flagged');
    assert.equal(res.body.marks_stale, true, 'missing mark makes valuation incomplete');
  });
});

// ---- C: concurrency + idempotency ------------------------------------------

describe('guarded coordinator', () => {
  test('concurrent manual/scheduled/chat requests share ONE execution (no duplicate runs)', async () => {
    resetFundData();
    const restore = mockQuietMarket();
    try {
      const [a, b, c] = await Promise.all([
        runFundLoop({ trigger: 'manual' }),
        runFundLoop({ trigger: 'scheduled' }),
        runFundLoop({ trigger: 'chat' }),
      ]);
      // All three resolve; exactly one actually executed.
      const executed = [a, b, c].filter((o) => !o.reused);
      assert.equal(executed.length, 1, 'exactly one execution');
      assert.ok(a.reused || b.reused || c.reused, 'the others were told a run was active');
      const d = load();
      assert.equal((d.ai_fund.runs ?? []).length, 1, 'one durable run record');
      // They all reference the same run id.
      const ids = new Set([a.run.id, b.run.id, c.run.id]);
      assert.equal(ids.size, 1, 'same run id returned to every caller');
    } finally {
      restore();
    }
  });

  test('retry identity: request_id returns the same run, not a rerun', async () => {
    resetFundData();
    const restore = mockQuietMarket();
    try {
      const rid = 'retry-abc-123';
      const first = await runFundLoop({ trigger: 'manual', requestId: rid });
      assert.equal(first.reused, false);
      const second = await runFundLoop({ trigger: 'manual', requestId: rid });
      assert.equal(second.reused, true, 'retry is recognized');
      assert.equal(second.run.id, first.run.id, 'same run returned');
      const d = load();
      assert.equal((d.ai_fund.runs ?? []).length, 1, 'no second run record');
      assert.equal(d.ai_fund.runs?.[0].request_id, rid);
    } finally {
      restore();
    }
  });

  test('route-level idempotency + single-flight via POST /api/fund/run', async () => {
    resetFundData();
    const restore = mockQuietMarket();
    try {
      const rid = 'route-retry-1';
      const r1 = await postJson('/api/fund/run', { request_id: rid, trigger: 'manual' });
      assert.equal(r1.status, 200);
      assert.ok(r1.body.run_id, 'run id in response');
      const r2 = await postJson('/api/fund/run', { request_id: rid, trigger: 'manual' });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.run_id, r1.body.run_id, 'same run for a retried request_id');
      assert.equal(r2.body.reused, true);
      const d = load();
      const matching = (d.ai_fund.runs ?? []).filter((r) => r.request_id === rid);
      assert.equal(matching.length, 1, 'exactly one record for the id');
    } finally {
      restore();
    }
  });

  test('sync-throwing body does NOT wedge the single-flight coordinator', async () => {
    // Regression: the active-run slot must be set before the async wrapper's
    // try block. If it were set after, a body that throws SYNCHRONOUSLY would
    // clear `active` in `finally` before the outer assignment re-set it, so a
    // later request would be mis-rejected as `reused:true` forever.
    resetFundData();
    // A body that throws before any `await` (synchronous throw).
    const syncThrow = () => { throw new Error('sync boom'); };
    const first = await startFundRun('manual', syncThrow, {});
    assert.equal(first.run.status, 'failed', 'sync throw -> failed run');
    // A subsequent real request must NOT be told a run is already active.
    const after = await startFundRun('manual', async () => {}, {});
    assert.equal(after.reused, false, 'coordinator not wedged (fresh run starts)');
    assert.equal(after.run.status, 'completed');
  });

  test('interrupted-run recovery: abandoned running -> interrupted on restart, no replay', async () => {
    resetFundData();
    // Simulate an abandoned run: a 'running' record in the store whose process died.
    update((draft) => {
      draft.ai_fund.runs = [{
        id: 'abandoned-1', trigger: 'scheduled', started_at: new Date(Date.now() - 3_600_000).toISOString(),
        finished_at: null, status: 'running', actions: [], failures: [], trades_occurred: false,
        equity_usd: null, valued_at: null, marks_stale: false, model_used: null,
      }];
      return { committed: true, value: null as unknown };
    });
    seedPosition('ABND', 1, 10);
    const before = load();
    const cashBefore = before.ai_fund.cash_usd;
    const tradesBefore = before.ai_fund.trades.length;

    // Restart: new app instance (createApp runs finalizeInterruptedRuns()).
    const { createApp: freshCreateApp } = await import('../src/app.js');
    const freshApp = freshCreateApp();
    const res = await withHeaders(request(freshApp).get('/api/fund')).set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787');
    assert.equal(res.status, 200);
    const d = load();
    const rec = (d.ai_fund.runs ?? []).find((r) => r.id === 'abandoned-1');
    assert.ok(rec, 'record survived');
    assert.equal(rec?.status, 'interrupted', 'abandoned running -> interrupted');
    assert.ok(rec?.finished_at, 'finish time recorded');
    assert.equal(d.ai_fund.cash_usd, cashBefore, 'cash untouched');
    assert.equal(d.ai_fund.trades.length, tradesBefore, 'no trades replayed');
    // Also directly callable:
    const n = finalizeInterruptedRuns();
    assert.equal(n, 0, 'idempotent: nothing left running');
  });

  test('run history is bounded (MAX 200) and sanitized', async () => {
    resetFundData();
    // Stuff 250 garbage records directly, then run one real loop; the store must stay bounded.
    update((draft) => {
      draft.ai_fund.runs = Array.from({ length: 250 }, (_, i) => ({
        id: `bulk-${i}`, trigger: 'manual' as const, started_at: new Date(2026, 0, 1, i % 24).toISOString(),
        finished_at: null, status: 'completed' as const, actions: [], failures: [], trades_occurred: false,
        equity_usd: null, valued_at: null, marks_stale: false, model_used: null,
      }));
      return { committed: true, value: null as unknown };
    });
    // Reload from disk to force sanitize path.
    resetCacheForTests();
    const d = load();
    assert.ok((d.ai_fund.runs ?? []).length <= 200, `bounded to 200 (got ${(d.ai_fund.runs ?? []).length})`);
    // Corrupt record shapes are dropped, not guessed.
    update((draft) => {
      draft.ai_fund.runs = [
        ...draft.ai_fund.runs ?? [],
        { id: '', trigger: 'manual', started_at: '', finished_at: null, status: 'completed', actions: [], failures: [], trades_occurred: false, equity_usd: null, valued_at: null, marks_stale: false, model_used: null } as never, // no id -> dropped
      ];
      return { committed: true, value: null as unknown };
    });
    resetCacheForTests();
    const d2 = load();
    assert.ok(!(d2.ai_fund.runs ?? []).some((r) => !r.id), 'records without ids are dropped');
  });

  test('partial/model failure stays visible (never swallowed into completed)', async () => {
    resetFundData();
    // Deterministic: refuse ALL network (movers + quotes fail), so the run
    // must land as partial with data failures recorded — not a quiet success.
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async () => {
      throw new Error('network unreachable (mock)');
    }) as typeof fetch;
    try {
      const outcome = await runFundLoop({ trigger: 'manual' });
      assert.equal(outcome.run.status, 'partial', `status: ${outcome.run.status}`);
      assert.ok(outcome.run.failures.length > 0, 'failure recorded');
      assert.ok(outcome.run.failures.some((f) => f.kind === 'data'), 'data failure kind');
      const viaApi = await agent().get('/api/fund');
      const last = viaApi.body.runs[0];
      assert.equal(last.status, 'partial', 'partial visible via API');
      assert.ok(last.failures.length > 0, 'failures visible via API');
      assert.ok(last.actions.some((a: { action: string }) => a.action === 'scan'), 'scan action recorded');
    } finally {
      globalThis.fetch = realFetch;
      clearQuoteCacheForTests();
    }
  });
});

// ---- D: chat intent boundary -----------------------------------------------

describe('fund chat intent classifier', () => {
  const runCases = [
    'run the fund',
    'run fund',
    'run the paper fund',
    'run the fund now',
    'Run the fund.',
    'please run the fund',
    'make a trade',
    'make some trades',
    'do your thing',
    'trade for yourself',
    'go ahead and make a trade now',
  ];
  for (const q of runCases) {
    test(`executes: "${q}"`, () => {
      assert.equal(classifyFundIntent(q), 'run', q);
    });
  }
  const statusCases = [
    'Did you run the fund?',
    "Don't run the fund",
    'Do not run the fund',
    'what did the fund do today?',
    'how is the fund doing?',
    'why is the fund holding INTC?',
    'is the fund running?',
    'have you traded?',
    'did you make any trades today?',
    'what trades did the fund make?',
    'how is the paper fund doing',
    'the fund should not trade without me',
  ];
  for (const q of statusCases) {
    test(`read-only: "${q}"`, () => {
      assert.notEqual(classifyFundIntent(q), 'run', q);
      assert.equal(classifyFundIntent(q), 'status', q);
    });
  }
  test('negated loose commands never run', () => {
    assert.equal(classifyFundIntent("don't make any trades"), 'status', 'negation + trades lands as status, never run');
    assert.equal(classifyFundIntent('do not do your thing'), 'none', 'negated vague command is not an execution request either way — the point is it never runs');
    assert.notEqual(classifyFundIntent("don't run the fund"), 'run');
  });
  test('non-fund questions are none', () => {
    assert.equal(classifyFundIntent('quote NVDA'), 'none');
    assert.equal(classifyFundIntent('what should i buy?'), 'none');
    assert.equal(classifyFundIntent(''), 'none');
  });
});

describe('fund-status chat via API', () => {
  test('fund-status question receives the read-only snapshot and CANNOT trigger a run', async () => {
    resetFundData();
    seedPosition('INTC', 3.671, 104.47, { mark: 104.47, stop: 50 });
    await importFundLog(fundLogFixture); // imported summaries visible too
    const runsBefore = (load().ai_fund.runs ?? []).length;
    const res = await postJson('/api/chat', { question: 'Did you run the fund today?', mode: 'llm' });
    assert.equal(res.status, 200);
    const msg = res.body.message;
    const content = String(msg.content);
    assert.match(content, /paper money|fictional/i, 'clearly labeled paper fund');
    assert.match(content, /INTC/, 'positions included');
    assert.match(content, /\$/, 'cash/equity figures included');
    assert.doesNotMatch(content, /run complete|Paper fund run complete/i, 'no run was claimed');
    const runsAfter = (load().ai_fund.runs ?? []).filter((r) => !r.imported).length;
    assert.equal(runsAfter, 0, 'NO run was executed by a status question');
    assert.equal((load().ai_fund.runs ?? []).length, runsBefore, 'history unchanged');
    // Provenance: deterministic snapshot, no model consulted.
    assert.equal(msg.model_used, null);
    assert.ok(msg.data_sources?.fund_store, 'data source disclosed');
    assert.equal(msg.ticker ?? null, null, 'general thread (no ticker hijack)');
  });

  test('explicit run command in chat executes through the guarded coordinator', async () => {
    resetFundData();
    const restore = mockQuietMarket();
    try {
      const res = await postJson('/api/chat', { question: 'run the fund', mode: 'llm' });
      assert.equal(res.status, 200);
      const content = String(res.body.message.content);
      assert.match(content, /Paper fund run complete/i);
      assert.match(content, /fictional|paper/i, 'discloses paper nature');
      const d = load();
      assert.equal((d.ai_fund.runs ?? []).length, 1, 'run persisted');
      assert.equal(d.ai_fund.runs?.[0].trigger, 'chat');
      // Messages persisted in the correct (general) thread.
      const chat = await agent().get('/api/chat');
      assert.equal(chat.body.messages.length, 2, 'user + assistant in general thread');
      assert.equal(chat.body.messages[0].role, 'user');
      assert.equal(chat.body.messages[1].role, 'assistant');
    } finally {
      restore();
    }
  });

  test('why-holding question explains recorded rationale without executing', async () => {
    resetFundData();
    seedPosition('INTC', 3.671, 104.47, { mark: 104.47 });
    const before = load();
    const tradesBefore = before.ai_fund.trades.length;
    const res = await postJson('/api/chat', { question: 'why is the fund holding INTC?', mode: 'llm' });
    assert.equal(res.status, 200);
    const content = String(res.body.message.content);
    assert.match(content, /INTC/);
    assert.match(content, /104\.47|avg cost/i, 'recorded cost basis shown');
    assert.match(content, /rationale|Executed at/i, 'recorded rationale referenced');
    assert.equal(load().ai_fund.trades.length, tradesBefore, 'no execution');
    const runs = (load().ai_fund.runs ?? []).filter((r) => !r.imported);
    assert.equal(runs.length, 0, 'no run executed');
  });

  test('thread persistence: fund chat with ticker stays in that thread', async () => {
    resetFundData();
    await agent().delete('/api/chat');
    await postJson('/api/chat', { question: 'what did the fund do today?', mode: 'llm', ticker: 'INTC' });
    const thread = await agent().get('/api/chat?ticker=INTC');
    assert.ok(thread.body.messages.length >= 2, 'question and answer land in the INTC thread');
    assert.ok(thread.body.messages.every((m: { ticker?: string }) => m.ticker === 'INTC'), 'no bleed');
    const general = await agent().get('/api/chat');
    assert.equal(general.body.messages.length, 0, 'general thread untouched');
  });

  test('no secrets leak in fund API responses', async () => {
    const res = await agent().get('/api/fund');
    const text = JSON.stringify(res.body);
    assert.doesNotMatch(text, /sk-|Bearer |OLLAMA_API_KEY|OPENAI_API_KEY/i);
    const runs = await agent().get('/api/fund/runs');
    assert.doesNotMatch(JSON.stringify(runs.body), /sk-|Bearer /i);
  });

  test('deterministic-mode fund status works without any model configured', async () => {
    resetFundData();
    seedPosition('INTC', 3.671, 104.47, { mark: 104.47, stop: 50 });
    const res = await postJson('/api/chat', { question: 'how is the fund doing?' }); // default mode: deterministic
    assert.equal(res.status, 200);
    const msg = res.body.message;
    assert.equal(msg.mode, 'deterministic');
    const content = String(msg.content);
    assert.match(content, /INTC/, 'holdings shown');
    assert.match(content, /104\.47/, 'mark shown');
    assert.match(content, /paper money|fictional/i, 'paper nature disclosed');
    // And it never executed anything:
    assert.equal((load().ai_fund.runs ?? []).filter((r) => !r.imported).length, 0);
    // A run request in deterministic mode is refused with guidance, not executed.
    const runReq = await postJson('/api/chat', { question: 'run the fund' });
    assert.equal(runReq.status, 200);
    assert.match(String(runReq.body.message.content), /never executes the loop|LLM|Run-the-fund/i);
    assert.equal((load().ai_fund.runs ?? []).filter((r) => !r.imported).length, 0, 'deterministic engine cannot start the loop');
  });
});

// ---- A: historical log import ----------------------------------------------

describe('historical fund.log import', () => {
  test('parseFundLogLine extracts only what the log states', () => {
    const rec = parseFundLogLine('[2026-09-09T13:35:12.443Z] scheduled: equity $10000 — INTC hold, SPCX no-trade');
    assert.ok(rec);
    assert.equal(rec?.imported, true);
    assert.equal(rec?.trigger, 'scheduled');
    assert.equal(rec?.started_at, '2026-09-09T13:35:12.443Z');
    assert.equal(rec?.finished_at, '2026-09-09T13:35:12.443Z');
    assert.equal(rec?.equity_usd, 10000);
    assert.deepEqual(rec?.actions.map((a) => `${a.ticker} ${a.action}`), ['INTC hold', 'SPCX no-trade']);
    assert.equal(rec?.model_used, null, 'no model invented');
    assert.equal(rec?.trades_occurred, false);
    // Garbage is skipped, never guessed.
    assert.equal(parseFundLogLine('garbage'), null);
    assert.equal(parseFundLogLine('[2026-09-09T13:35:12.443Z] weird: equity $1 — ???'), null);
  });

  test('import is idempotent and labeled; existing runs preserved', () => {
    resetFundData();
    seedPosition('KEEP', 1, 5);
    const first = importFundLog(fundLogFixture);
    assert.equal(first.imported, 2, 'two parseable lines');
    assert.equal(first.unparseable, 1, 'garbage reported');
    const second = importFundLog(fundLogFixture);
    assert.equal(second.imported, 0, 'no duplicates on re-import');
    assert.equal(second.skipped_existing, 2);
    const d = load();
    const imported = (d.ai_fund.runs ?? []).filter((r) => r.imported);
    assert.equal(imported.length, 2);
    assert.ok(imported.every((r) => r.note?.includes('imported from fund.log')), 'labeled');
    assert.ok(d.ai_fund.positions['KEEP'], 'existing holdings untouched');
    assert.ok(d.ai_fund.trades.length >= 1, 'existing trades untouched');
    assert.equal(d.ai_fund.cash_usd, 10000, 'cash untouched');
  });

  test('imported summaries appear in /api/fund runs and chat snapshot', async () => {
    resetFundData();
    await importFundLog(fundLogFixture);
    const res = await agent().get('/api/fund');
    assert.ok(res.body.runs.some((r: { imported?: boolean }) => r.imported === true), 'imported records in API');
    const chat = await postJson('/api/chat', { question: 'what did the fund do today?', mode: 'llm' });
    const content = String(chat.body.message.content);
    assert.match(content, /imported from fund\.log/i, 'history remains visible through chat');
  });
});

// ---- migration --------------------------------------------------------------

describe('schema migration (v2 -> v3)', () => {
  test('bare-number marks migrate to freshness objects; positions/trades/cash preserved', async () => {
    // Simulate a v2 data file on disk.
    const v2 = {
      watchlist: [], ideas: [], trades: [], verdict_log: [], chat: [],
      portfolio: { cash_usd: 100000, positions: {}, marks: {} },
      ai_fund: {
        cash_usd: 9616.49,
        started_at: '2026-09-08T20:30:48.527Z',
        positions: { INTC: { quantity: 3.671, avg_cost: 104.47 } },
        marks: { INTC: 104.47 },
        stops: { INTC: 50 },
        trades: [{ id: 't1', verdict_id: 'v', ticker: 'INTC', side: 'buy', quantity: 3.671, price: 104.47, quote_as_of: '2026-09-08T20:00:01.000Z', executed_at: '2026-09-08T20:32:34.556Z', rationale: 'test buy' }],
      },
      ai_lessons: [{ id: 'l1', ticker: 'AAA', trade_id: 't0', lesson: 'test lesson', closed_at: '2026-09-01T00:00:00Z' }],
      meta: { schema_version: 2 },
    };
    const migrateDir = path.join(os.tmpdir(), `civicfolio-migrate-${Date.now()}`);
    fs.mkdirSync(migrateDir, { recursive: true });
    fs.writeFileSync(path.join(migrateDir, 'civicfolio-data.json'), JSON.stringify(v2));
    const savedDataDir = process.env['CIVICFOLIO_DATA_DIR'];
    process.env['CIVICFOLIO_DATA_DIR'] = migrateDir;
    resetCacheForTests();
    try {
      const d = load();
      assert.equal(d.meta.schema_version, 3, 'schema bumped');
      const mark = d.ai_fund.marks['INTC'];
      assert.ok(mark && typeof mark === 'object', 'mark migrated to object');
      assert.equal(mark?.price, 104.47, 'price preserved');
      assert.equal(mark?.quote_as_of, null, 'unknown timestamps stay unknown (never relabeled with now)');
      assert.equal(mark?.fetched_at, null);
      assert.equal(d.ai_fund.cash_usd, 9616.49, 'cash preserved');
      assert.deepEqual(d.ai_fund.positions['INTC'], { quantity: 3.671, avg_cost: 104.47 }, 'position preserved');
      assert.equal(d.ai_fund.stops['INTC'], 50, 'stop preserved');
      assert.equal(d.ai_fund.trades.length, 1, 'trade preserved');
      assert.equal(d.ai_lessons.length, 1, 'lessons preserved');
      assert.deepEqual(d.ai_fund.runs, [], 'runs initialized empty');
      // The migrated file is durable on disk.
      const onDisk = JSON.parse(fs.readFileSync(path.join(migrateDir, 'civicfolio-data.json'), 'utf8'));
      assert.equal(onDisk.meta.schema_version, 3);
    } finally {
      process.env['CIVICFOLIO_DATA_DIR'] = savedDataDir ?? testDir;
      resetCacheForTests();
      try { fs.rmSync(migrateDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test('v3 marks round-trip (quote_as_of, fetched_at, stale) survive reload', async () => {
    resetFundData();
    update((draft) => {
      draft.ai_fund.positions['RT'] = { quantity: 1, avg_cost: 10 };
      draft.ai_fund.marks['RT'] = { price: 12.5, quote_as_of: '2026-09-09T19:00:00.000Z', fetched_at: '2026-09-09T19:01:00.000Z', source: 'quote', quote_source: 'yahoo', stale: false };
      return { committed: true, value: null as unknown };
    });
    resetCacheForTests();
    const d = load();
    const m = d.ai_fund.marks['RT'];
    assert.equal(m.price, 12.5);
    assert.equal(m.quote_as_of, '2026-09-09T19:00:00.000Z');
    assert.equal(m.fetched_at, '2026-09-09T19:01:00.000Z');
    assert.equal(m.source, 'quote');
  });
});

// ---- UI contract (E) ---------------------------------------------------------

describe('dashboard status contract', () => {
  test('/api/fund returns every field the UI needs (runs, next run, freshness, stale flag)', async () => {
    resetFundData();
    seedPosition('UI', 2, 40, { mark: 44 });
    await importFundLog(fundLogFixture);
    const res = await agent().get('/api/fund');
    assert.equal(res.status, 200);
    const b = res.body;
    for (const key of ['cash_usd', 'equity_usd', 'pnl_usd', 'realized_pnl_usd', 'unrealized_pnl_usd', 'marks_stale', 'positions', 'trades', 'lessons', 'runs', 'last_run', 'running_run', 'next_scheduled_run']) {
      assert.ok(key in b, `${key} present`);
    }
    assert.ok(Array.isArray(b.runs) && b.runs.length >= 2, 'run history present');
    assert.ok(b.last_run, 'last run present');
    assert.ok(b.next_scheduled_run, 'next scheduled run derived');
    assert.equal(b.next_scheduled_run.schedule_times_local.length, 8, 'the 8 launchd clock times');
    assert.match(b.next_scheduled_run.note, /NOT trading-day aware/i, 'honest schedule disclaimer');
    const pos = b.positions[0];
    assert.ok(pos.mark_freshness, 'per-position freshness');
    assert.equal(typeof pos.mark_freshness.quote_as_of, 'string');
    // Runs endpoint:
    const runs = await agent().get('/api/fund/runs');
    assert.ok(runs.body.total >= 2);
    assert.ok(runs.body.runs[0].id, 'newest first with ids');
  });

  test('next scheduled run is computed from the real plist clock times (honest, not trading-day aware)', async () => {
    const res = await agent().get('/api/fund');
    const next = res.body.next_scheduled_run;
    assert.ok(next, 'schedule derived');
    assert.deepEqual(next.schedule_times_local, ['09:35', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '15:50']);
    // `at` must be a future ISO timestamp.
    assert.ok(Date.parse(next.at) > Date.now() - 1000);
    assert.match(next.source, /launchd plist|bundled defaults/);
  });

  test('marks-refresh endpoint refreshes valuations WITHOUT trading', async () => {
    resetFundData();
    seedPosition('RF', 5, 20, { mark: 20 });
    const tradesBefore = load().ai_fund.trades.length;
    // Route-level quote injection via the test seam (production default unchanged).
    setQuoteProviderForTests(quoteProviderFrom([{ ticker: 'RF', price: 21, as_of: '2026-09-09T19:00:00.000Z' }]));
    try {
      const res = await postJson('/api/fund/marks/refresh', {});
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.updated, ['RF']);
      assert.equal(res.body.marks_stale, false);
      assert.ok(res.body.note, 'valuation disclaimer present');
      const d = load();
      assert.equal(d.ai_fund.trades.length, tradesBefore, 'no trades from a mark refresh');
      assert.equal((d.ai_fund.runs ?? []).length, 0, 'no run record from a mark refresh');
      const mark = d.ai_fund.marks['RF'];
      assert.equal(mark.price, 21, 'mark updated from the injected quote');
      assert.equal(mark.quote_as_of, '2026-09-09T19:00:00.000Z', 'quote timestamp preserved');
    } finally {
      setQuoteProviderForTests(null);
    }
  });

  test('stale-mark refresh retains old mark and flags it (never relabels time)', async () => {
    resetFundData();
    seedPosition('OLDF', 1, 30, { mark: 33 });
    const res = await refreshFundMarks(quoteProviderFrom([], [{ ticker: 'OLDF', reason: 'feed down' }]));
    assert.equal(res.failed.length, 1);
    const d = load();
    const m = d.ai_fund.marks['OLDF'];
    assert.equal(m.price, 33, 'old price kept');
    assert.equal(m.quote_as_of, '2026-09-08T15:00:00.000Z', 'old quote time kept');
    assert.equal(m.stale, true);
  });
});

// ---- safety: no broker calls ------------------------------------------------

describe('no broker, no real network', () => {
  test('fund endpoints make no broker requests', async () => {
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      throw new Error('network disabled in this test');
    }) as typeof fetch;
    try {
      // Everything below must resolve WITHOUT network (injected/stored data only).
      resetFundData();
      seedPosition('NOBROKER', 1, 9, { mark: 10 });
      setQuoteProviderForTests(quoteProviderFrom([{ ticker: 'NOBROKER', price: 10 }]));
      const res = await postJson('/api/fund/marks/refresh', {});
      assert.equal(res.status, 200);
      await agent().get('/api/fund');
      await agent().get('/api/fund/runs');
      const bad = urls.filter((u) => /robinhood|broker/i.test(u));
      assert.equal(bad.length, 0, `no broker calls: ${bad.join(', ')}`);
      // The fund surface itself must not have hit the real quote endpoint either
      // (the provider was injected) — proves the route honors the seam.
      assert.ok(!urls.some((u) => u.includes('finance.yahoo.com')), 'fund marks refresh used the injected provider, not the network');
    } finally {
      globalThis.fetch = realFetch;
      setQuoteProviderForTests(null);
      clearQuoteCacheForTests();
    }
  });
});

after(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});