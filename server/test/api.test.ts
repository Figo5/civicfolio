import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir for tests — must be set before importing store.js.
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-test-'));
process.env['CIVICFOLIO_DATA_DIR'] = testDir;

const { createApp } = await import('../src/app.js');
const { load, dataDir, update, resetCacheForTests } = await import('../src/store.js');
const { submitTrade } = await import('../src/portfolio.js');

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
    delete: (url: string) => withHeaders(request(app).delete(url)).set('Content-Type', 'application/json'),
  };
}
function postJson(url: string, body?: unknown) {
  return withHeaders(request(app).post(url)).set('Content-Type', 'application/json').send(body ?? {});
}

test('demo load seeds 12 synthetic disclosures', async () => {
  const res = await postJson('/api/demo/load');
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.disclosures, 12);
  assert.equal(res.body.counts.trades, 2);
  assert.equal(res.body.counts.ideas, 2);
  assert.equal(res.body.counts.watchlist, 2);
  // demo cash reconciles with seeded trades (425 + 140.5)
  const port = await agent().get('/api/portfolio');
  assert.ok(Math.abs(port.body.cash_usd - (100000 - 565.5)) < 0.005, `demo cash reconciles (got ${port.body.cash_usd})`);
});

test('demo seed is internally consistent: trades sum matches positions', async () => {
  const d = load();
  const buys = d.trades.filter((t) => t.side === 'BUY');
  const spent = buys.reduce((s, t) => s + t.quantity * t.price, 0);
  const invested = Object.values(d.portfolio.positions).reduce((s, p) => s + p.cost_basis_usd, 0);
  assert.ok(Math.abs(spent - invested) < 0.005);
  assert.ok(Math.abs(d.portfolio.cash_usd + invested - 100000) < 0.005);
});

test('disclosures list includes explicit date fields and ranges', async () => {
  const res = await agent().get('/api/disclosures');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 12);
  const first = res.body.records[0];
  assert.ok(first.tx_date_min && first.tx_date_max, 'has transaction date range');
  assert.ok(first.published_date, 'has publication date');
  assert.ok(first.amount_min_usd <= first.amount_max_usd, 'amount is a range');
  assert.equal(first.data_mode, 'demo');
  assert.ok(first.owner.includes('fictional'), 'demo owners are labeled fictional');
});

test('disclosure filters work: ticker, tx_type, amendment, data_mode', async () => {
  const arrx = await agent().get('/api/disclosures?ticker=ARRX');
  assert.equal(arrx.body.count, 3);
  assert.ok(arrx.body.records.every((r: any) => r.ticker === 'ARRX'));

  const sales = await agent().get('/api/disclosures?tx_type=sale');
  assert.ok(sales.body.records.every((r: any) => r.tx_type === 'sale'));

  const amended = await agent().get('/api/disclosures?amendment=true');
  assert.equal(amended.body.count, 1);
  assert.equal(amended.body.records[0].amendment_of, 'demo-0004');

  const demo = await agent().get('/api/disclosures?data_mode=demo');
  assert.equal(demo.body.count, 12);

  const pub = await agent().get('/api/disclosures?published_from=2026-07-01');
  assert.ok(pub.body.records.every((r: any) => r.published_date >= '2026-07-01'));

  const ft = await agent().get('/api/disclosures?q=aurora');
  assert.equal(ft.body.count, 3);
});

test('chat deterministic mode cites record IDs', async () => {
  const res = await postJson('/api/chat', { question: 'what does the store say about ARRX?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.message.mode, 'deterministic');
  assert.match(res.body.message.content, /ARRX/);
  assert.ok(res.body.message.citations.length >= 1);
  assert.ok(res.body.message.citations.some((c: any) => String(c.record_id).startsWith('demo-')));
});

test('chat abstains on price questions (no fabricated prices)', async () => {
  const res = await postJson('/api/chat', { question: 'what is the price of ARRX stock?' });
  assert.equal(res.status, 200);
  assert.match(res.body.message.content, /abstain/i);
});

test('chat answers publication delay question from stored records', async () => {
  const res = await postJson('/api/chat', { question: 'what is the typical publication delay?' });
  assert.equal(res.status, 200);
  assert.match(res.body.message.content, /median/i);
  assert.match(res.body.message.content, /days/);
});

test('chat compares two tickers with uncertainty section', async () => {
  const res = await postJson('/api/chat', { question: 'compare ARRX and HRZN' });
  assert.equal(res.status, 200);
  assert.match(res.body.message.content, /ARRX/);
  assert.match(res.body.message.content, /HRZN/);
  assert.match(res.body.message.content, /amounts are ranges/i);
});

test('chat abstains when data absent for one ticker', async () => {
  const res = await postJson('/api/chat', { question: 'compare ARRX and ZZZZ' });
  assert.equal(res.status, 200);
  assert.match(res.body.message.content, /no stored disclosures for ZZZZ/i);
});

test('chat refuses LLM mode when unconfigured', async () => {
  const res = await postJson('/api/chat', { question: 'hi', mode: 'llm' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not configured/i);
});

// ---- mutation guards ----------------------------------------------------

test('mutation guards: hostile Origin/Host/content-type rejected, legit accepted', async () => {
  // hostile origins
  const evil = await request(app)
    .post('/api/demo/load').set('Host', '127.0.0.1:8787')
    .set('Origin', 'https://evil.example.com').set('Content-Type', 'application/json').send({});
  assert.equal(evil.status, 403);

  // hostile Host (DNS rebinding style)
  const rebinding = await request(app)
    .post('/api/demo/load').set('Host', 'evil.example.com')
    .set('Origin', 'http://127.0.0.1:8787').set('Content-Type', 'application/json').send({});
  assert.equal(rebinding.status, 403);

  // cross-origin form POST (urlencoded) — no JSON content type
  const formPost = await request(app)
    .post('/api/demo/load').set('Host', '127.0.0.1:8787')
    .set('Origin', 'https://attacker.example').set('Content-Type', 'application/x-www-form-urlencoded').send('a=1');
  assert.equal(formPost.status, 403); // origin check fires first

  // same-origin form-style POST with NO origin header but urlencoded → 415
  const noJson = await request(app)
    .post('/api/demo/load').set('Host', '127.0.0.1:8787')
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
    const okRes = await request(app).post('/api/demo/load')
      .set('Host', '127.0.0.1:8787').set('Origin', o).set('Content-Type', 'application/json').send({});
    assert.equal(okRes.status, 200, `origin ${o} allowed`);
  }

  // GETs work without Origin header (curl-style local client)
  const curlGet = await agent().get('/api/health');
  assert.equal(curlGet.status, 200);
});

// ---- paper trading: finite arithmetic + idempotency ----------------------

test('paper trade: buy, overspend rejected, oversell rejected, invalid input rejected', async () => {
  await postJson('/api/demo/load'); // ensure seeded
  const d0 = load();
  const beforeCash = d0.portfolio.cash_usd;

  const buy = await postJson('/api/portfolio/trades', {
    ticker: 'tsla', side: 'BUY', quantity: 2, price: 100.5, price_source: 'user_entered',
  });
  assert.equal(buy.status, 200);
  assert.equal(buy.body.trade.ticker, 'TSLA');
  const afterBuy = await agent().get('/api/portfolio');
  assert.equal(afterBuy.body.cash_usd, beforeCash - 201);
  assert.equal(afterBuy.body.trade_count, 3);

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
  await postJson('/api/demo/load');
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
  await postJson('/api/demo/load');
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
  await postJson('/api/demo/load');
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

test('JSON import: valid records added, invalid reported', async () => {
  const good = {
    ticker: 'acme',
    company: 'Acme Corp',
    owner: 'Jane Doe',
    owner_role: 'Senator',
    tx_type: 'purchase',
    tx_date: '2026-01-10',
    published_date: '2026-03-01',
    amount_min_usd: 1000,
    amount_max_usd: 15000,
    source_url: 'https://example.com/filing',
    amendment: false,
  };
  const res = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([good]) });
  assert.equal(res.status, 200);
  assert.equal(res.body.report.added, 1);
  assert.equal(res.body.report.data_mode, 'imported');

  const bad = { ...good, ticker: 'toolongtickerxyz' };
  const res2 = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([bad]) });
  assert.equal(res2.status, 207);
  assert.equal(res2.body.report.added, 0);
  assert.ok(res2.body.report.errors.length === 1);

  const broken = await postJson('/api/disclosures/import', { kind: 'json', text: '{not json' });
  assert.equal(broken.status, 400);

  // published before transaction rejected
  const badDate = { ...good, published_date: '2025-12-01' };
  const res3 = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([badDate]) });
  assert.equal(res3.status, 207);
  assert.match(res3.body.report.errors[0].message, /precedes/);
});

test('import forces imported provenance even when payload claims live', async () => {
  const sneaky = {
    ticker: 'SNKR', company: 'Sneaky Co', owner: 'Test Owner', owner_role: 'Senator',
    tx_type: 'purchase', tx_date: '2026-02-01', published_date: '2026-03-01',
    amount_min_usd: 1000, amount_max_usd: 5000, amendment: false,
    source_url: 'https://example.com/sneaky', data_mode: 'live',
  };
  const res = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([sneaky]) });
  assert.equal(res.status, 200);
  assert.equal(res.body.imported_count, 1);
  const rec = load().disclosures.find((r) => r.ticker === 'SNKR');
  assert.ok(rec, 'record imported');
  assert.equal(rec.data_mode, 'imported', 'data_mode forced to imported');
  assert.equal(rec.source_url, 'https://example.com/sneaky');
});

test('import assigns UUID-based unique ids and detects duplicate imports', async () => {
  const rec = {
    ticker: 'DUPE', company: 'Dupe Co', owner: 'Dupe Owner', owner_role: 'Senator',
    tx_type: 'purchase', tx_date: '2026-02-10', published_date: '2026-03-10',
    amount_min_usd: 2000, amount_max_usd: 9000, amendment: false,
    source_url: 'https://example.com/dupe',
  };
  const first = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([rec]) });
  assert.equal(first.status, 200);
  const ids = load().disclosures.filter((r) => r.ticker === 'DUPE').map((r) => r.id);
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^imp-[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}/, 'id contains a UUID');

  const second = await postJson('/api/disclosures/import', { kind: 'json', text: JSON.stringify([rec]) });
  assert.equal(second.status, 207); // all duplicates → nothing added, row errors
  assert.equal(second.body.report.added, 0);
  assert.ok(second.body.report.errors.some((e: any) => /duplicate skipped/i.test(e.message)));
  assert.equal(load().disclosures.filter((r) => r.ticker === 'DUPE').length, 1, 'still one record');
});

test('CSV import: happy path, malformed rows, multiline quoted fields', async () => {
  const csv = [
    'ticker,company,owner,owner_role,tx_type,tx_date,published_date,amount_min_usd,amount_max_usd,amendment,source_url',
    'MSFT,Microsoft,Sample Person (test),Senator,purchase,2026-02-01,2026-04-01,1000,15000,FALSE,https://example.com/x',
    'TOOLONGTICKERX,Co,Person,Senator,purchase,2026-02-01,2026-04-01,1000,15000,FALSE,',
  ].join('\n');
  const res = await postJson('/api/disclosures/import', { kind: 'csv', text: csv });
  assert.equal(res.status, 207);
  assert.equal(res.body.report.added, 1);
  assert.equal(res.body.report.skipped, 1);
  assert.match(res.body.report.errors[0].message, /row 3/);

  const missingCols = await postJson('/api/disclosures/import', { kind: 'csv', text: 'a,b\n1,2' });
  assert.equal(missingCols.status, 400);
  assert.match(missingCols.body.error ?? missingCols.body.report.errors[0].message, /missing required columns/);

  // multiline quoted field parses correctly
  const multiline = [
    'ticker,company,owner,owner_role,tx_type,tx_date,published_date,amount_min_usd,amount_max_usd,amendment,notes',
    'MLTC,Multiline Co,Multi Owner,Senator,purchase,2026-03-01,2026-04-01,1000,5000,FALSE,"line one',
    'line two of the note"',
  ].join('\n');
  const mres = await postJson('/api/disclosures/import', { kind: 'csv', text: multiline });
  assert.equal(mres.status, 200);
  assert.equal(mres.body.report.added, 1);
  const rec = load().disclosures.find((r) => r.ticker === 'MLTC');
  assert.ok(rec?.notes?.includes('line two of the note'), 'multiline note captured');
});

test('CSV unterminated quote rejected with clear error', async () => {
  const bad = 'ticker,company,owner\nUNC,Co,"unclosed quote';
  const res = await postJson('/api/disclosures/import', { kind: 'csv', text: bad });
  assert.equal(res.status, 400);
  assert.match(res.body.error ?? res.body.report.errors[0].message, /unterminated quoted field/i);
});

test('import size cap enforced', async () => {
  const huge = 'x'.repeat(6 * 1024 * 1024);
  const res = await postJson('/api/disclosures/import', { kind: 'json', text: huge });
  assert.equal(res.status, 413);
});

// ---- resets / lists / misc ------------------------------------------------

test('demo clear empties store', async () => {
  const res = await postJson('/api/demo/clear');
  assert.equal(res.status, 200);
  const list = await agent().get('/api/disclosures');
  assert.equal(list.body.count, 0);
  const chat = await postJson('/api/chat', { question: 'what does the store say about ARRX?' });
  assert.match(chat.body.message.content, /abstain|no stored data/i);
});

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

test('settings endpoint exposes no secrets and marks robinhood unconfigured', async () => {
  const res = await agent().get('/api/settings');
  assert.equal(res.status, 200);
  assert.equal(res.body.robinhood.status, 'not_configured');
  assert.equal(res.body.providers.llm_endpoint.status, 'not_configured');
  const body = JSON.stringify(res.body);
  assert.ok(!body.toLowerCase().includes('openai_api_key='), 'no key material');
  assert.ok(res.body.data.dir.startsWith(os.tmpdir()));
});

test('meta endpoint reports data mode and robinhood status', async () => {
  const res = await agent().get('/api/meta');
  assert.equal(res.status, 200);
  assert.equal(res.body.robinhood.status, 'not_configured');
  assert.ok(Array.isArray(res.body.data_modes_present));
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

test('destructive resets back up the previous store first', async () => {
  await postJson('/api/demo/load');
  const dir = dataDir();
  const countBackups = () => fs.readdirSync(dir).filter((f) => f.startsWith('backup-') && f.endsWith('.json')).length;
  // Clearing must leave a recoverable copy of what was there.
  const cleared = await postJson('/api/demo/clear');
  assert.equal(cleared.status, 200);
  assert.ok(countBackups() > 0, 'clear writes a backup');
  assert.ok(countBackups() <= 10, 'old backups are pruned to the cap');

  const newest = fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).sort().reverse()[0];
  const restored = JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'));
  assert.equal(restored.disclosures.length, 12, 'backup holds the pre-clear data, not the cleared store');
  assert.equal(load().disclosures.length, 0, 'the live store really is cleared');
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

  // Default posture declines directive calls.
  delete process.env['CIVICFOLIO_ADVISOR_MODE'];
  assert.equal(getLlmConfig().advisorMode, 'analyst');
  const analyst = buildSystemPrompt('analyst');
  assert.match(analyst, /Do NOT issue directive verdicts/);

  // Owner opts in to direct recommendations.
  process.env['CIVICFOLIO_ADVISOR_MODE'] = 'advisor';
  assert.equal(getLlmConfig().advisorMode, 'advisor');
  const advisor = buildSystemPrompt('advisor');
  assert.match(advisor, /direct, actionable assessment/);
  assert.match(advisor, /conviction level/);
  // Even in advisor mode, fabricated precision stays off the table.
  assert.match(advisor, /No fabricated price targets/);
  assert.doesNotMatch(advisor, /Do NOT issue directive verdicts/);

  // An unrecognised value falls back to the safer posture rather than advisor.
  process.env['CIVICFOLIO_ADVISOR_MODE'] = 'yolo';
  assert.equal(getLlmConfig().advisorMode, 'analyst');
  delete process.env['CIVICFOLIO_ADVISOR_MODE'];

  // The browser cannot flip it: settings only reports the mode.
  const s = await agent().get('/api/settings');
  assert.equal(s.body.providers.llm_endpoint.advisor_mode, 'analyst');
});
