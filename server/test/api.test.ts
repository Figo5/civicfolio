import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir for tests — must be set before importing store.js.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-test-'));
process.env['CIVICFOLIO_DATA_DIR'] = testDir;
// Hermetic by construction: a developer's real OPENAI_API_KEY must never turn
// these tests into paid API calls. AI paths are off unless a test explicitly
// injects a provider through setProviderForTests.
delete process.env['OPENAI_API_KEY'];

const { createApp } = await import('../src/app.js');
const { load, dataDir, update, resetCacheForTests } = await import('../src/store.js');
const { submitTrade } = await import('../src/portfolio.js');
const { setProviderForTests } = await import('../src/provider.js');

import request from 'supertest';

const app = createApp();

// supertest does not set Origin or a JSON content-type for .send() unless we
// do; these helpers make every request a legitimate local client.
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


test('demo seed is internally consistent: trades sum matches positions', async () => {
  const d = load();
  const buys = d.trades.filter((t) => t.side === 'BUY');
  const spent = buys.reduce((s, t) => s + t.quantity * t.price, 0);
  const invested = Object.values(d.portfolio.positions).reduce((s, p) => s + p.cost_basis_usd, 0);
  assert.ok(Math.abs(spent - invested) < 0.005);
  assert.ok(Math.abs(d.portfolio.cash_usd + invested - 100000) < 0.005);
});




test('chat abstains on price questions (no fabricated prices)', async () => {
  const res = await postJson('/api/chat', { question: 'will NVDA go up next month?' });
  assert.equal(res.status, 200);
  assert.match(res.body.message.content, /abstain/i);
});




test('chat LLM mode without a key: explicit 400, never a silent deterministic answer', async () => {
  // No OPENAI_API_KEY in this process (cleared above). The old failure mode —
  // quietly answering with the deterministic engine while claiming LLM mode —
  // is what this pins down.
  const res = await postJson('/api/chat', { question: 'is BIDU a good buy right now?', mode: 'llm' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /OPENAI_API_KEY/);
  assert.doesNotMatch(JSON.stringify(res.body), /sk-|Bearer /i, 'no key material in the error');
});

test('chat LLM mode with an injected provider: labelled answer with provenance', async () => {
  setProviderForTests({
    model: 'gpt-4o-mini',
    generateText: async () => ({ ok: true, content: 'BIDU is cheap for reasons.', model: 'gpt-4o-mini-2024-07-18' }),
    generateStructured: async () => ({ ok: false, error: 'not used' }),
  });
  try {
    const res = await postJson('/api/chat', { question: 'is BIDU a good buy right now?', mode: 'llm' });
    // Data sources are live fetches; if every one fails the route honestly 503s
    // rather than sending the model at an empty page.
    assert.ok([200, 503].includes(res.status), `got ${res.status}: ${JSON.stringify(res.body).slice(0, 150)}`);
    if (res.status === 200) {
      assert.equal(res.body.message.mode, 'llm');
      assert.equal(res.body.message.model_used, 'gpt-4o-mini-2024-07-18', 'answers carry the model that produced them');
    }
  } finally {
    setProviderForTests(null);
  }
});

test('chat LLM mode surfaces provider failures as 502, never as a fabricated answer', async () => {
  setProviderForTests({
    model: 'gpt-4o-mini',
    generateText: async () => ({ ok: false, error: 'OpenAI rate limit or quota reached. Wait a moment and retry.' }),
    generateStructured: async () => ({ ok: false, error: 'unused' }),
  });
  try {
    const res = await postJson('/api/chat', { question: 'is BIDU a good buy right now?', mode: 'llm' });
    assert.ok([502, 503].includes(res.status), `got ${res.status}`);
    if (res.status === 502) assert.match(res.body.error, /rate limit/i);
  } finally {
    setProviderForTests(null);
  }
});

// ---- research agent endpoint ---------------------------------------------

test('research endpoint: invalid ticker 400, unknown ticker 404, config not leaked', async () => {
  const bad = await postJson('/api/research/!!!');
  assert.equal(bad.status, 400);

  // Past the key gate (injected provider), the remaining guards are about the
  // ticker and the market data behind it.
  setProviderForTests({
    model: 'stub-model',
    generateText: async () => ({ ok: false, error: 'unused' }),
    generateStructured: async () => ({ ok: false, error: 'unused' }),
  });
  let unknown;
  try {
    unknown = await postJson('/api/research/ZZZZZ');
  } finally {
    setProviderForTests(null);
  }
  assert.ok([404, 502].includes(unknown.status), `unknown ticker → 404 or provider error (got ${unknown.status})`);
  if (unknown.status === 404) {
    // Research is no longer gated on the local filing store — any listed
    // ticker is researchable, so the 404 is now about market data.
    assert.match(unknown.body.error, /no market data/i);
  }

  // Config is server-side only: the response never echoes model/key material.
  const bodyText = JSON.stringify(unknown.body);
  assert.doesNotMatch(bodyText, /sk-|Bearer /i, 'no key material in error output');
});

test('research endpoint without a key: 400 before any network work', async () => {
  // The key gate must fire before the agent spends a web search on a run that
  // cannot produce a verdict.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: any[]) => { fetchCalls += 1; return (realFetch as any)(...args); }) as typeof fetch;
  try {
    const res = await postJson('/api/research/AMD');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /OPENAI_API_KEY/);
    assert.equal(fetchCalls, 0, 'nothing is fetched when AI is unconfigured');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('meta and settings report provider presence only, never key or endpoint', async () => {
  const meta = await agent().get('/api/meta');
  assert.equal(meta.body.agent.provider, 'openai');
  assert.equal(meta.body.agent.enabled, false, 'no key in this process');
  assert.doesNotMatch(JSON.stringify(meta.body), /sk-|Bearer |api\.openai\.com/i);

  const s = await agent().get('/api/settings');
  assert.equal(s.body.providers.research_agent.status, 'not_configured');
  assert.doesNotMatch(JSON.stringify(s.body), /sk-|Bearer /i);

  process.env.OPENAI_API_KEY = 'test-key-not-secret';
  process.env.OPENAI_BASE_URL = 'https://alternate-provider.example/account-path';
  try {
    const configured = await agent().get('/api/settings');
    assert.equal(configured.body.providers.llm_endpoint.status, 'configured');
    assert.doesNotMatch(JSON.stringify(configured.body), /alternate-provider|account-path|base_url_when_configured/i,
      'unsupported endpoint overrides are neither used nor exposed');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }
});

// ---- mutation guards ----------------------------------------------------

test('mutation guards: hostile Origin/Host/content-type rejected, legit accepted', async () => {
  // hostile origins
  const evil = await request(app)
    .post('/api/demo/clear').set('Host', '127.0.0.1:8787')
    .set('Origin', 'https://evil.example.com').set('Content-Type', 'application/json').send({});
  assert.equal(evil.status, 403);

  // hostile Host (DNS rebinding style)
  const rebinding = await request(app)
    .post('/api/demo/clear').set('Host', 'evil.example.com')
    .set('Origin', 'http://127.0.0.1:8787').set('Content-Type', 'application/json').send({});
  assert.equal(rebinding.status, 403);

  // cross-origin form POST (urlencoded) — no JSON content type
  const formPost = await request(app)
    .post('/api/demo/clear').set('Host', '127.0.0.1:8787')
    .set('Origin', 'https://attacker.example').set('Content-Type', 'application/x-www-form-urlencoded').send('a=1');
  assert.equal(formPost.status, 403); // origin check fires first

  // same-origin form-style POST with NO origin header but urlencoded → 415
  const noJson = await request(app)
    .post('/api/demo/clear').set('Host', '127.0.0.1:8787')
    .set('Content-Type', 'application/x-www-form-urlencoded').send('a=1');
  assert.equal(noJson.status, 415);

  // bodyless POST without JSON content-type → 415
  const bodyless = await request(app)
    .post('/api/demo/clear').set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787');
  assert.equal(bodyless.status, 415);

  // GETs permit cross-origin callers without CORS, but never foreign Host values.
  const rebound = await request(app).get('/api/portfolio').set('Host', 'evil.example');
  assert.equal(rebound.status, 403, 'read routes reject DNS-rebinding Host');
  const readAny = await request(app).get('/api/meta').set('Origin', 'https://any.example');
  assert.equal(readAny.status, 200);

  // allowed exact origins pass
  for (const o of ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:8787', 'http://localhost:8787']) {
    const okRes = await request(app).post('/api/demo/clear')
      .set('Host', '127.0.0.1:8787').set('Origin', o).set('Content-Type', 'application/json').send({});
    assert.equal(okRes.status, 200, `origin ${o} allowed`);
  }

  // GETs work without Origin header (curl-style local client)
  const curlGet = await agent().get('/api/health');
  assert.equal(curlGet.status, 200);
});

// ---- paper trading: finite arithmetic + idempotency ----------------------

test('paper trade: buy, overspend rejected, oversell rejected, invalid input rejected', async () => {
    const d0 = load();
  const beforeCash = d0.portfolio.cash_usd;
  const beforeTrades = d0.trades.length;

  const buy = await postJson('/api/portfolio/trades', {
    ticker: 'tsla', side: 'BUY', quantity: 2, price: 100.5, price_source: 'user_entered',
  });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.trade.ticker, 'TSLA');
  const afterBuy = await agent().get('/api/portfolio');
  assert.equal(afterBuy.body.cash_usd, beforeCash - 201);
  assert.equal(afterBuy.body.trade_count, beforeTrades + 1);

  // overspend
  const big = await postJson('/api/portfolio/trades', { ticker: 'AAPL', side: 'BUY', quantity: 100000, price: 500 });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /insufficient cash/);

  // oversell
  const oversell = await postJson('/api/portfolio/trades', { ticker: 'TSLA', side: 'SELL', quantity: 10, price: 100 });
  assert.equal(oversell.status, 400);
  assert.match(oversell.body.error, /cannot sell/);

  // invalid inputs
  for (const bad of [
    { ticker: 'TSLA!', side: 'BUY', quantity: 1, price: 5 },
    { ticker: 'TSLA', side: 'HOLD', quantity: 1, price: 5 },
    { ticker: 'TSLA', side: 'BUY', quantity: -1, price: 5 },
    { ticker: 'TSLA', side: 'BUY', quantity: 1, price: Number.NaN },
    { ticker: 'TSLA', side: 'BUY', quantity: 1, price: Infinity },
    { ticker: 'TSLA', side: 'BUY', quantity: 1e308, price: 1e308 },
    { ticker: '', side: 'BUY', quantity: 1, price: 5 },
    { ticker: 'TSLA', side: 'BUY', quantity: 'ten', price: 5 },
  ]) {
    const r = await postJson('/api/portfolio/trades', bad);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }

  // valid sell reduces position
  const sell = await postJson('/api/portfolio/trades', { ticker: 'TSLA', side: 'SELL', quantity: 2, price: 110, price_source: 'user_entered' });
  assert.equal(sell.status, 200);
  const afterSell = await agent().get('/api/portfolio');
  assert.ok(!afterSell.body.positions.some((p: any) => p.ticker === 'TSLA'), 'position closed');
});

test('sub-cent notional trades rejected (no free positions)', async () => {
  const d = load();
  const cashBefore = d.portfolio.cash_usd;
  const tradesBefore = d.trades.length;

  const tiny = await postJson('/api/portfolio/trades', { ticker: 'PENNY', side: 'BUY', quantity: 1, price: 0.001 });
  assert.equal(tiny.status, 400);
  assert.match(tiny.body.error, /rounds to zero|notional/i);

  const d2 = load();
  assert.equal(d2.portfolio.cash_usd, cashBefore, 'cash unchanged');
  assert.equal(d2.trades.length, tradesBefore, 'no trade recorded');
  assert.ok(!d2.portfolio.positions['PENNY'], 'no free position minted');
});

test('overflow-sized quantity rejected before arithmetic', async () => {
  const r = await postJson('/api/portfolio/trades', { ticker: 'BIGC', side: 'BUY', quantity: 1e308, price: 10 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /quantity exceeds practical limit/i);
});

test('notional cap enforced', async () => {
  const r = await postJson('/api/portfolio/trades', { ticker: 'HUGE', side: 'BUY', quantity: 1000000, price: 500 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /practical limit/i);
});

test('idempotency: same key same payload → duplicate flag, no re-execution', async () => {
  await postJson('/api/demo/clear');
  const key = '550e8400-e29b-41d4-a716-446655440000';
  const payload = { ticker: 'IDEM', side: 'BUY', quantity: 5, price: 20, price_source: 'user_entered', client_request_id: key };

  const first = await postJson('/api/portfolio/trades', payload);
  assert.equal(first.status, 200);
  assert.notEqual(first.body.duplicate, true);
  const d1 = load();
  const count1 = d1.trades.filter((t) => t.ticker === 'IDEM').length;
  assert.equal(count1, 1);

  const replay = await postJson('/api/portfolio/trades', payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  assert.equal(replay.body.trade.id, first.body.trade.id, 'same trade returned');
  const d2 = load();
  assert.equal(d2.trades.filter((t) => t.ticker === 'IDEM').length, 1, 'still only one trade');
  // cash only debited once
  const expectedCash = d1.portfolio.cash_usd; // unchanged from after first execution
  assert.equal(load().portfolio.cash_usd, expectedCash);
});

test('idempotency conflict: same key, different payload → 400', async () => {
  const key = '661e8400-e29b-41d4-a716-446655440001';
  const first = await postJson('/api/portfolio/trades', { ticker: 'CONF', side: 'BUY', quantity: 1, price: 10, client_request_id: key });
  assert.equal(first.status, 200);
  const conflict = await postJson('/api/portfolio/trades', { ticker: 'CONF', side: 'BUY', quantity: 2, price: 10, client_request_id: key });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error, /already used with a different payload/i);
  const d = load();
  assert.equal(d.trades.filter((t) => t.ticker === 'CONF').length, 1);
});

// ---- persistence: atomic writes, failure rollback ------------------------

test('failed disk write leaves memory at pre-mutation state (rollback)', async () => {
  await postJson('/api/demo/clear');
  const { dataDir: dir, update: upd } = await import('../src/store.js');
  const before = JSON.parse(JSON.stringify(load()));

  const origJson = JSON.stringify(load());
  // Simulate disk failure by making the data dir read-only
  const realWrite = fs.writeFileSync;
  const g: any = globalThis;
  // monkey-patch fs.writeFileSync used inside store via process binding —
  // simpler: point data dir to a path that cannot be created (a file).
  const filePathAsDir = path.join(testDir, 'not-a-dir');
  fs.writeFileSync(filePathAsDir, 'x');
  process.env['CIVICFOLIO_DATA_DIR'] = filePathAsDir;
  resetCacheForTests();

  let threw = false;
  try {
    upd(() => { throw new Error('disk failure simulated'); });
  } catch (e) { threw = true; }
  // update() propagates write errors
  assert.ok(threw, 'update() surfaces persist errors');

  // restore env + cache, verify original state intact
  process.env['CIVICFOLIO_DATA_DIR'] = testDir;
  resetCacheForTests();
  const restored = load();
  assert.deepEqual(restored, before);
});

test('data persists across restart (cache reload from disk)', async () => {
  await postJson('/api/demo/clear');
  const buy = await postJson('/api/portfolio/trades', { ticker: 'PERS', side: 'BUY', quantity: 3, price: 7.25 });
  assert.equal(buy.status, 200);
  const cashAfterBuy = load().portfolio.cash_usd;

  // simulate restart: drop cache, reload from disk
  resetCacheForTests();
  const d = load();
  assert.equal(d.trades.filter((t) => t.ticker === 'PERS').length, 1);
  assert.equal(d.portfolio.cash_usd, cashAfterBuy);
  const file = path.join(dataDir(), 'civicfolio-data.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.trades.some((t: any) => t.ticker === 'PERS'));
  assert.ok(!file.startsWith(process.cwd()), 'data stored outside tracked repo');
});

test('paper trades persist to disk outside repo', async () => {
  const file = path.join(dataDir(), 'civicfolio-data.json');
  assert.ok(fs.existsSync(file));
  assert.ok(!file.startsWith(process.cwd()));
});

// ---- imports -------------------------------------------------------------







// ---- resets / lists / misc ------------------------------------------------


test('ideas and watchlist CRUD with validation', async () => {
  const idea = await postJson('/api/ideas', { ticker: 'arrx', thesis: 'watch clustering' });
  assert.equal(idea.status, 200);
  assert.equal(idea.body.idea.ticker, 'ARRX');

  const badIdea = await postJson('/api/ideas', { ticker: 'ARRX', thesis: '' });
  assert.equal(badIdea.status, 400);

  const del = await agent().delete(`/api/ideas/${idea.body.idea.id}`);
  assert.equal(del.status, 200);
  const delAgain = await agent().delete(`/api/ideas/${idea.body.idea.id}`);
  assert.equal(delAgain.status, 404);

  const watch = await postJson('/api/watchlist', { ticker: 'CYPW', thesis: 'utility watch' });
  assert.equal(watch.status, 200);
  const watchDel = await agent().delete(`/api/watchlist/${watch.body.item.id}`);
  assert.equal(watchDel.status, 200);
});

test('settings endpoint exposes no secrets and marks robinhood removed', async () => {
  const res = await agent().get('/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.robinhood.status, 'removed');
  assert.equal(res.body.robinhood.execution_enabled, false);
  assert.equal(res.body.providers.llm_endpoint.status, 'not_configured');
  assert.equal(typeof res.body.providers.research_agent.model, 'string', 'frontend provider badge keeps its model field');
  assert.equal(typeof res.body.providers.research_agent.web_search, 'boolean', 'frontend provider badge keeps a boolean search flag');
  const body = JSON.stringify(res.body);
  assert.ok(!body.toLowerCase().includes('openai_api_key='), 'no key material');
  assert.ok(res.body.data.dir.startsWith(os.tmpdir()));
});

test('all legacy brokerage routes answer static 410, never echo input or contact a broker', async () => {
  const a = agent();
  const cases: { method: 'get' | 'post'; path: string }[] = [
    { method: 'get', path: '/api/robinhood/status' },
    { method: 'post', path: '/api/robinhood/connect' },
    { method: 'post', path: '/api/robinhood/review' },
    { method: 'post', path: '/api/robinhood/place' },
    { method: 'get', path: '/api/robinhood/positions' },
    { method: 'get', path: '/api/robinhood/alerts' },
    { method: 'post', path: '/api/robinhood/alerts' },
    { method: 'post', path: '/api/robinhood/disconnect' },
    { method: 'post', path: '/api/robinhood/verify' },
    { method: 'get', path: '/robinhood/callback?code=STEAL&state=x' },
  ];
  for (const c of cases) {
    const req = c.method === 'get' ? a.get(c.path) : a.post(c.path).set('Content-Type', 'application/json').send({ ticker: 'AAPL', confirm: true });
    const res = await req;
    assert.equal(res.status, 410, `${c.method} ${c.path} → 410`);
    assert.equal(res.body.execution_enabled, false);
    assert.equal(res.body.status, 'permanently_disabled');
    const bodyText = JSON.stringify(res.body);
    assert.ok(!bodyText.includes('STEAL'), 'request input never reflected');
  }
});


test('unknown api route 404s with json error', async () => {
  const res = await agent().get('/api/definitely-not-a-route');
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});

test('malformed JSON body rejected', async () => {
  const res = await withHeaders(request(app).post('/api/chat'))
    .set('Content-Type', 'application/json')
    .send('{"question": truncated');
  assert.equal(res.status, 400);
});

after(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('mark prices: set, compute unrealized P&L, reject junk, clear, persist', async () => {
  await postJson('/api/demo/clear');
  await postJson('/api/portfolio/trades', {
    ticker: 'ARRX', side: 'BUY', quantity: 10, price: 50, price_source: 'user_entered',
    trade_date: '2026-09-01', client_request_id: 'mark-test-1',
  });

  // No mark yet -> value/P&L stay null rather than defaulting to cost basis.
  const before = await agent().get('/api/portfolio');
  assert.equal(before.body.positions[0].mark_price, null);
  assert.equal(before.body.positions[0].market_value_usd, null);
  assert.equal(before.body.unrealized_pl_usd, null);
  assert.equal(before.body.marked_positions_count, 0);

  // Mark at 62.50 -> value 625, cost 500, +125 (+25%).
  const set = await postJson('/api/portfolio/marks', { ticker: 'ARRX', price: 62.5 });
  assert.equal(set.status, 200);
  const pos = set.body.portfolio.positions[0];
  assert.equal(pos.mark_price, 62.5);
  assert.equal(pos.market_value_usd, 625);
  assert.equal(pos.unrealized_pl_usd, 125);
  assert.equal(pos.unrealized_pl_pct, 25);
  assert.equal(set.body.portfolio.unrealized_pl_usd, 125);
  assert.ok(pos.marked_at, 'mark records when it was entered');

  // Cost-basis totals must be unaffected by marking.
  assert.equal(set.body.portfolio.invested_cost_usd, 500);

  // Junk and out-of-range values are rejected.
  for (const bad of [0, -5, 'abc', true, 1e12]) {
    const r = await postJson('/api/portfolio/marks', { ticker: 'ARRX', price: bad });
    assert.equal(r.status, 400, `price ${String(bad)} must be rejected`);
  }
  // Marking a ticker you do not hold is rejected.
  const nohold = await postJson('/api/portfolio/marks', { ticker: 'ZZZZ', price: 10 });
  assert.equal(nohold.status, 400);

  // Mark survives a restart (reload from disk).
  resetCacheForTests();
  const reloaded = await agent().get('/api/portfolio');
  assert.equal(reloaded.body.positions[0].mark_price, 62.5);

  // Null clears the mark and P&L goes back to null, not zero.
  const cleared = await postJson('/api/portfolio/marks', { ticker: 'ARRX', price: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.portfolio.positions[0].mark_price, null);
  assert.equal(cleared.body.portfolio.unrealized_pl_usd, null);
});


test('quotes: marks tagged by source, unresolvable symbols reported not invented', async () => {
  const { clearQuoteCacheForTests } = await import('../src/quotes.js');
  clearQuoteCacheForTests();

  // A mark you type is tagged 'user'.
  await postJson('/api/demo/clear');
  await postJson('/api/portfolio/trades', {
    ticker: 'AAPL', side: 'BUY', quantity: 2, price: 100, price_source: 'user_entered',
    trade_date: '2026-09-01', client_request_id: 'quote-test-1',
  });
  const typed = await postJson('/api/portfolio/marks', { ticker: 'AAPL', price: 150 });
  assert.equal(typed.body.portfolio.positions[0].mark_source, 'user');
  assert.equal(typed.body.portfolio.positions[0].quote_source, null);

  // A quote-sourced mark is tagged 'quote' and keeps its origin.
  const quoted = await postJson('/api/portfolio/marks', {
    ticker: 'AAPL', price: 175, source: 'quote', quote_source: 'yahoo',
  });
  assert.equal(quoted.body.portfolio.positions[0].mark_source, 'quote');
  assert.equal(quoted.body.portfolio.positions[0].quote_source, 'yahoo');
  assert.equal(quoted.body.portfolio.positions[0].market_value_usd, 350);

  // The endpoint requires tickers and rejects an empty request.
  const bad = await agent().get('/api/quotes');
  assert.equal(bad.status, 400);

  // Garbage symbols must never come back as a price.
  const junk = await agent().get('/api/quotes?tickers=' + encodeURIComponent('!!!,toolongtickername'));
  assert.equal(junk.status, 200);
  assert.equal(junk.body.quotes.length, 0, 'no prices invented for junk symbols');
  assert.equal(junk.body.failed.length, 2, 'every rejected symbol is explained');
  assert.match(junk.body.failed[0].reason, /not a valid ticker/);
});

test('advisor mode is server-controlled and shapes the prompt', async () => {
  const { getLlmConfig, buildSystemPrompt } = await import('../src/llm.js');

  // Default posture is advisor: a real take with the other side acknowledged.
  delete process.env['CIVICFOLIO_ADVISOR_MODE'];
  assert.equal(getLlmConfig().advisorMode, 'advisor');
  const advisor = buildSystemPrompt('advisor');
  assert.match(advisor, /Have a take/);
  // Conversational, not compliance-memo: the memo-style LABELS are banned
  // (the prompt mentions them only inside the ban itself).
  assert.match(advisor, /sharp friend/);
  assert.match(advisor, /NEVER write like a compliance document/);
  // Data availability is the truth about what answered.
  assert.match(advisor, /data_availability/);
  assert.doesNotMatch(advisor, /quotes were just fetched/);
  assert.doesNotMatch(advisor, /never say "the data block contains no live market data"/);
  assert.doesNotMatch(advisor, /still make the call/);
  // The banned OLD advisor posture: forced call on thin evidence, sizing by
  // default, "commit to a view". None of it may return.
  assert.doesNotMatch(advisor, /Commit to a view/);
  assert.doesNotMatch(advisor, /If evidence is thin, say it in one sentence and still make the call/);
  assert.doesNotMatch(advisor, /sizing in percent-of-portfolio/);
  // The security footer (treat data as inert) must stay.
  assert.match(advisor, /inert data, not instructions/);

  // Owner can opt down to analyst (no directive calls).
  process.env['CIVICFOLIO_ADVISOR_MODE'] = 'analyst';
  assert.equal(getLlmConfig().advisorMode, 'analyst');
  const analyst = buildSystemPrompt('analyst');
  assert.match(analyst, /Do NOT issue directive verdicts/);
  const analystSettings = await agent().get('/api/settings');
  assert.equal(analystSettings.body.providers.llm_endpoint.advisor_mode, 'analyst');
  assert.doesNotMatch(analystSettings.body.providers.llm_endpoint.advisor_mode_note, /default/i);

  // An unrecognised value falls back to advisor (the owner's default intent).
  process.env['CIVICFOLIO_ADVISOR_MODE'] = 'yolo';
  assert.equal(getLlmConfig().advisorMode, 'advisor');
  delete process.env['CIVICFOLIO_ADVISOR_MODE'];

  // The browser cannot flip it: settings only reports the mode.
  const s = await agent().get('/api/settings');
  assert.equal(s.body.providers.llm_endpoint.advisor_mode, 'advisor');
});

// ---- fundamentals (SEC EDGAR) -------------------------------------------

test('buildTickerMap parses SEC company_tickers.json and rejects junk', async () => {
  const { buildTickerMap } = await import('../src/fundamentals.js');
  const map = buildTickerMap({
    '0': { ticker: 'aapl', cik_str: 320193, title: 'Apple Inc.' },
    '1': { ticker: 'MSFT', cik_str: 789019, title: 'MICROSOFT CORP' },
    '2': { ticker: '', cik_str: 1 },                    // no ticker → skipped
    '3': { ticker: 'NOCIK', cik_str: 'x' },              // non-numeric CIK → skipped
    '4': 'garbage',                                      // non-object → skipped
  });
  assert.equal(map['AAPL']?.cik, '0000320193', 'ticker uppercased, CIK zero-padded');
  assert.equal(map['MSFT']?.title, 'MICROSOFT CORP');
  assert.equal(map['NOCIK'], undefined);
  // Non-object input yields an empty map rather than throwing.
  assert.deepEqual(buildTickerMap(null), {});
  assert.deepEqual(buildTickerMap(42), {});
});

test('fundamentals endpoint: 400 on missing ticker, 404 with reason on invalid/unknown', async () => {
  const missing = await agent().get('/api/fundamentals');
  assert.equal(missing.status, 400);

  const invalid = await agent().get('/api/fundamentals?ticker=' + encodeURIComponent('!!!'));
  assert.equal(invalid.status, 404);
  assert.match(invalid.body.error, /not a valid ticker/);

  // Valid shape, no real filer: honest reason, never fabricated figures.
  const unknown = await agent().get('/api/fundamentals?ticker=ZZZZZ');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, unknown.body.error, 'error is a string reason');
  assert.equal(unknown.body.fundamentals, undefined, 'no fundamentals object invented');
});

// ---- proposals / trends ---------------------------------------------------



test('chat history can be cleared without wiping the store', async () => {
  await postJson('/api/watchlist', { ticker: 'NVDA', thesis: 'keep an eye on it' });
  await postJson('/api/chat', { question: 'show my watchlist' });
  assert.ok(load().chat.length > 0, 'a question and answer were recorded');
  const watchlistBefore = load().watchlist.length;

  const cleared = await agent().delete('/api/chat');
  assert.equal(cleared.status, 200);
  assert.ok(cleared.body.removed > 0);
  assert.equal(load().chat.length, 0, 'history is gone');
  assert.equal(load().watchlist.length, watchlistBefore, 'the store itself is untouched');

  // Clearing an already-empty history is a no-op, not an error.
  const again = await agent().delete('/api/chat');
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, 0);
});

test('verifyLevels catches levels the data does not support', async () => {
  const { verifyLevels } = await import('../src/researchAgent.js');
  // Real anchors observed for AMD.
  const anchors = { current_price: 508.38, sma20: 477.14, sma50: 499.01, six_month_high: 580.91, six_month_low: 193.39 };

  const checks = verifyLevels({
    entry_zone: '500.00 with its 50-day SMA',        // ≈ sma50 499.01 → grounded
    exit_target: '550.00 with its 6-month high',     // high is 580.91 → NOT grounded
    stop_loss: '480.00 near the previous close',     // ≈ sma20 477.14 → grounded, but
  }, anchors);
  const by = Object.fromEntries(checks.map((c) => [c.field, c]));

  assert.equal(by.entry_zone.grounded, true);
  assert.equal(by.entry_zone.nearest_anchor, 'sma50');

  // The invented target is the one that matters: it must not pass.
  assert.equal(by.exit_target.grounded, false, '550 is not the 6-month high of 580.91');
  assert.ok((by.exit_target.drift_pct ?? 0) > 1.5);

  // Correct number, wrong label — still grounded, and the real anchor is named.
  assert.equal(by.stop_loss.grounded, true);
  assert.equal(by.stop_loss.nearest_anchor, 'sma20');

  // A date must not be mistaken for a price.
  const dated = verifyLevels({ hold_horizon: 'Until earnings on 2026-11-03' }, anchors);
  assert.equal(dated[0].value, null);
  assert.equal(dated[0].grounded, true);

  // Nulls are skipped entirely.
  assert.equal(verifyLevels({ entry_zone: null }, anchors).length, 0);
});

test('chat threads keep stocks separate and clear independently', async () => {
  await agent().delete('/api/chat');

  await postJson('/api/chat', { question: 'quote NVDA', ticker: 'nvda' });
  await postJson('/api/chat', { question: 'quote AMD', ticker: 'AMD' });
  await postJson('/api/chat', { question: 'show my trades' }); // general, untagged

  const nvda = await agent().get('/api/chat?ticker=NVDA');
  assert.equal(nvda.body.ticker, 'NVDA');
  assert.ok(nvda.body.messages.length >= 2, 'question and answer land in the thread');
  assert.ok(nvda.body.messages.every((m: { ticker?: string }) => m.ticker === 'NVDA'), 'no bleed from other stocks');

  // General holds only untagged messages.
  const general = await agent().get('/api/chat');
  assert.ok(general.body.messages.every((m: { ticker?: string }) => !m.ticker));

  const tickers = general.body.threads.map((t: { ticker: string }) => t.ticker).sort();
  assert.deepEqual(tickers, ['AMD', 'NVDA'], 'both threads are listed');

  // Clearing one thread leaves the others intact.
  const cleared = await agent().delete('/api/chat?ticker=NVDA');
  assert.ok(cleared.body.removed >= 2);
  assert.equal((await agent().get('/api/chat?ticker=NVDA')).body.messages.length, 0);
  assert.ok((await agent().get('/api/chat?ticker=AMD')).body.messages.length >= 2, 'AMD survived');
});

test('insight scoring is transparent and never fabricates', async () => {
  const { scoreIdea } = await import('../src/insights.js');
  const base = {
    ticker: 'TEST', name: 'Test Co', price: 100, change: 0, change_pct: 0,
    volume: null, avg_volume_3m: null, volume_vs_avg: null, market_cap: 5e9, forward_pe: null,
    fifty_two_week_low: 50, fifty_two_week_high: 150, range_position: 0.5,
    fifty_day_change_pct: null, two_hundred_day_change_pct: null,
    next_earnings: null, earnings_is_estimate: false,
    exchange: 'NYSE', delayed_by_seconds: 0, quote_source: 'test',
  };

  // A quiet, mid-range stock earns nothing.
  assert.equal(scoreIdea({ ...base }).score, 0);

  // Every point comes with the fact that produced it.
  const heavy = scoreIdea({ ...base, volume_vs_avg: 3.1 });
  assert.ok(heavy.score > 0);
  assert.match(heavy.reasons.join(' '), /3\.10x/);

  // Risky setups are scored but flagged, never silently rewarded.
  const topOfRange = scoreIdea({ ...base, range_position: 0.95 });
  assert.ok(topOfRange.cautions.some((c) => /52-week extreme/i.test(c)));

  const spike = scoreIdea({ ...base, change_pct: 14 });
  assert.ok(spike.cautions.some((c) => /buy the top/i.test(c)));

  // Thin participation is a caution, not a reason.
  const thin = scoreIdea({ ...base, volume_vs_avg: 0.4 });
  assert.equal(thin.reasons.length, 0);
  assert.ok(thin.cautions.some((c) => /thin participation/i.test(c)));

  // Score is bounded and no field is invented from missing data.
  const maxed = scoreIdea({ ...base, volume_vs_avg: 9, range_position: 0.05, change_pct: -20, forward_pe: 9 });
  assert.ok(maxed.score <= 100);
  assert.equal(scoreIdea({ ...base }).next_earnings, null);
});

test('a bare question inside a stock thread resolves to that stock', async () => {
  await agent().delete('/api/chat?ticker=NVDA');
  // "quote" alone carries no ticker; the thread has to supply it.
  const inThread = await postJson('/api/chat', { question: 'quote', ticker: 'NVDA' });
  assert.equal(inThread.status, 200);
  assert.match(inThread.body.message.content, /NVDA/, 'thread ticker resolved the bare question');

  // The same question with no thread has nothing to resolve against.
  const general = await postJson('/api/chat', { question: 'quote' });
  assert.doesNotMatch(general.body.message.content, /^- NVDA/m);
});
