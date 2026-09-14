// Unit tests with zero real network or model calls: every fetch-observable
// surface runs behind mockFetch, AI paths are unconfigured so no model is
// consulted at all. Isolated temp data dir per suite.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-isolated-'));
process.env['CIVICFOLIO_DATA_DIR'] = testDir;
// AI paths are off in tests: a developer's real key must never turn this
// suite into paid OpenAI calls. Nothing here injects a provider, so every
// model call fails closed before the network.
delete process.env['OPENAI_API_KEY'];

const { createApp } = await import('../src/app.js');
const { clearQuoteCacheForTests } = await import('../src/quotes.js');
const { setProviderForTests } = await import('../src/provider.js');
const { clearMarketCacheForTests } = await import('../src/market.js');
const { scoreVerdicts, summarizeScored } = await import('../src/trackRecord.js');
import request from 'supertest';

const app = createApp();

function withHeaders(req: any) {
  return req.set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787');
}
function postJson(url: string, body?: unknown) {
  return withHeaders(request(app).post(url)).set('Content-Type', 'application/json').send(body ?? {});
}

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];
let realFetch: typeof globalThis.fetch | null = null;

function installMock(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown } | 'refuse'): void {
  realFetch = globalThis.fetch;
  calls = [];
  (globalThis as unknown as { fetch: typeof fetch })['fetch'] = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    if (r === 'refuse') throw new Error('network unreachable (mock)');
    // String bodies are raw payloads (e.g. the DDG HTML page): pass them
    // through unmodified — JSON.stringify would escape the quotes and the
    // HTML parser would then legitimately find nothing.
    if (typeof r.body === 'string') {
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function restoreFetch(): void {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
}

function assertNoBrokerCalls(): void {
  const bad = calls.filter((c) => /robinhood\.com|agent\.robinhood\.com/i.test(c.url));
  assert.equal(bad.length, 0, `broker requests were made: ${bad.map((b) => b.url).join(', ')}`);
}

describe('disabled brokerage endpoints', () => {
  after(() => { restoreFetch(); });

  test('every /api/robinhood route returns static 410 JSON for every method, never echoing input', async () => {
    installMock(() => ({ status: 200, body: { hacked: true } }));
    const routes: [string, 'get' | 'post' | 'delete'][] = [
      ['/api/robinhood/status', 'get'],
      ['/api/robinhood/positions?secret=abc', 'get'],
      ['/api/robinhood/connect', 'post'],
      ['/api/robinhood/disconnect', 'post'],
      ['/api/robinhood/verify', 'post'],
      ['/api/robinhood/place', 'post'],
      ['/api/robinhood/alerts', 'post'],
      ['/api/robinhood/anything-else', 'delete'],
    ];
    for (const [route, method] of routes) {
      const req = method === 'get'
        ? withHeaders(request(app).get(route))
        : method === 'delete'
          ? withHeaders(request(app).delete(route)).set('Content-Type', 'application/json')
          : postJson(route, { ticker: 'EVIL', confirm: true, code: 'leak-me', authorization_url: 'https://evil.example' });
      const res = await req;
      assert.equal(res.status, 410, `${method.toUpperCase()} ${route} -> 410`);
      assert.equal(res.body.execution_enabled, false, `${route} reports execution disabled`);
      assert.equal(res.body.status, 'permanently_disabled');
      const text = JSON.stringify(res.body);
      assert.ok(!text.includes('EVIL') && !text.includes('leak-me') && !text.includes('evil.example'),
        `${route} must not reflect request input`);
      assert.ok(!('authorization_url' in res.body) && !('connected' in res.body), `${route} must not carry broker state`);
    }
    assertNoBrokerCalls();
    // Hostile OAuth callback: HTML with reflected code must never come back.
    const cb = await withHeaders(request(app).get('/robinhood/callback?code=SECRET&state=X&error=y'));
    assert.equal(cb.status, 410);
    assert.match(String(cb.headers['content-type']), /application\/json/, 'static JSON, not HTML');
    assert.ok(!cb.text.includes('SECRET') && !cb.text.includes('<html'), 'no reflected input, no HTML');
    assertNoBrokerCalls();
  });

  test('GET on broker routes works without any credential file present', async () => {
    installMock(() => 'refuse');
    const res = await withHeaders(request(app).get('/api/robinhood/status'));
    assert.equal(res.status, 410);
    assert.equal(res.body.execution_enabled, false);
    assertNoBrokerCalls();
  });
});

describe('data availability honesty', () => {
  test('all sources failing -> 503, model never invoked, no fabricated answer', async () => {
    installMock(() => 'refuse'); // every upstream fails
    // AI is configured (so the route is not short-circuited by the key gate),
    // and the provider records whether it was ever consulted.
    let modelCalls = 0;
    setProviderForTests({
      model: 'stub-model',
      generateText: async () => { modelCalls += 1; return { ok: true, content: 'fabricated', model: 'stub-model' }; },
      generateStructured: async () => { modelCalls += 1; return { ok: false, error: 'unused' }; },
    });
    try {
      const res = await postJson('/api/chat', { question: 'is NVDA a good buy?', mode: 'llm', ticker: 'NVDA' });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /All data sources failed/);
      assert.match(res.body.error, /Nothing was sent to the model/);
      assert.equal(modelCalls, 0, 'the model is never invoked over an empty page');
    } finally {
      setProviderForTests(null);
    }
  });

  test('quote failing but search answering -> chat still works, availability marks the quote failed', async () => {
    installMock((url) => {
      if (url.includes('query1.finance.yahoo.com')) return 'refuse';
      if (url.includes('lite.duckduckgo.com')) {
        // Real DDG Lite shape: protocol-relative uddg= redirect links.
        return { status: 200, body: '<html><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews&rut=abc">Example headline</a></td></tr><tr><td class="result-snippet">A snippet about the stock.</td></tr></html>' };
      }
      return { status: 200, body: {} };
    });
    setProviderForTests({
      model: 'stub-model',
      generateText: async () => ({ ok: true, content: 'Nothing dramatic in the TSLA headlines.', model: 'stub-model' }),
      generateStructured: async () => ({ ok: false, error: 'unused' }),
    });
    try {
      const res = await postJson('/api/chat', { question: 'any news on TSLA?', mode: 'llm', ticker: 'TSLA' });
      assert.equal(res.status, 200);
      assert.equal(res.body.message.ticker, 'TSLA', 'assistant message persists into the ticker thread');
      assert.equal(res.body.message.model_used, 'stub-model', 'model provenance recorded');
      assert.equal(res.body.message.data_sources.quote.available, false, 'failed quote is honestly reported');
      assert.equal(res.body.message.data_sources.quote.as_of, null, 'no fake timestamp for a failed quote');
      assert.equal(res.body.message.data_sources.web_search.available, true, 'keyless DuckDuckGo search still works');
    } finally {
      setProviderForTests(null);
    }
  });

  test('quote parse failure (malformed JSON shape) yields no fabricated price', async () => {
    clearQuoteCacheForTests();
    installMock(() => ({ status: 200, body: { chart: { result: [] } } })); // no meta
    const res = await withHeaders(request(app).get('/api/quotes?tickers=AAA'));
    assert.equal(res.status, 200);
    assert.equal(res.body.quotes.length, 0, 'no price invented from a malformed payload');
    assert.equal(res.body.failed.length, 1);
    assert.match(res.body.failed[0].reason, /no price returned/);
    const text = JSON.stringify(res.body);
    assert.doesNotMatch(text, /"price":\s*0[^.]/, 'no zero price invented');
  });
});

describe('research journal (no fake hit rate)', () => {
  test('scoreVerdicts describes price change; summarize reports no outcome scoring', async () => {
    const entries = [
      {
        id: 'vl-1', ticker: 'AAAA', verdict: 'buy', confidence: 'medium',
        price_at_call: 100, entry_zone: null, exit_target: null, stop_loss: null,
        hold_horizon: null, grounded_levels: 1, unsupported_levels: 0,
        model: 'test-model', created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      },
      {
        id: 'vl-2', ticker: 'BBBB', verdict: 'avoid', confidence: 'low',
        price_at_call: 50, entry_zone: null, exit_target: null, stop_loss: null,
        hold_horizon: null, grounded_levels: 0, unsupported_levels: 1,
        model: 'test-model', created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      },
      {
        id: 'vl-3', ticker: 'CCCC', verdict: 'hold', confidence: 'low',
        price_at_call: null, entry_zone: null, exit_target: null, stop_loss: null,
        hold_horizon: null, grounded_levels: 0, unsupported_levels: 0,
        model: 'test-model', created_at: new Date().toISOString(),
      },
    ];
    // No quotes resolvable in the mock-free path: fetch is restored here, but
    // AAAA/BBBB/CCCC are not real tickers and the daemon host is unreachable,
    // so price_now stays null and everything is unmeasured.
    const scored = await scoreVerdicts(entries as never[]);
    assert.equal(scored.length, 3);
    for (const s of scored) {
      assert.ok(!('outcome' in s), 'no outcome field: the journal does not grade calls');
      assert.ok(!('hit_rate' in (summarizeScored(scored) as Record<string, unknown>)), 'no hit rate anywhere');
      assert.equal(s.price_now, null, 'unmeasured stays null — never guessed');
    }
    const summary = summarizeScored(scored);
    assert.equal(summary.measured, 0);
    assert.equal(summary.unmeasured, 3);
    assert.equal(summary.avg_change_pct, null);
    assert.match(summary.disclaimer, /not strategy performance/);
  });
});

describe('citation validation', () => {
  test('retainSupportedCitations keeps only real record IDs; arbitrary links are not promoted', async () => {
    const { retainSupportedCitations } = await import('../src/llm.js');
    const content = 'See [rec-1] and [rec-2] and [fake-id] and [https://model-invented.example/link].';
    const out = retainSupportedCitations(content, ['rec-1', 'rec-2']) ?? [];
    assert.deepEqual(out.map((c) => c.record_id), ['rec-1', 'rec-2']);
    assert.ok(out.every((c) => c.source_url === null), 'record citations carry no model-chosen URL');
  });
});

describe('research endpoint guards', () => {
  test('invalid ticker 400; hostile input never forwarded to a broker', async () => {
    installMock(() => 'refuse');
    setProviderForTests({
      model: 'stub-model',
      generateText: async () => ({ ok: false, error: 'unused' }),
      generateStructured: async () => ({ ok: false, error: 'unused' }),
    });
    try {
      const bad = await postJson('/api/research/!!!');
      assert.equal(bad.status, 400);
      const unknown = await postJson('/api/research/ZZZZZ');
      assert.ok([404, 502].includes(unknown.status), `got ${unknown.status}`);
      const bodyText = JSON.stringify(unknown.body);
      assert.doesNotMatch(bodyText, /sk-|Bearer /i, 'no key material in error output');
      assertNoBrokerCalls();
    } finally {
      setProviderForTests(null);
    }
  });
});

after(() => {
  restoreFetch();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
});