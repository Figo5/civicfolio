// Research agent over the OpenAI provider boundary. No network: the provider
// and the web search are both injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runResearchAgent, toVerdict, setSearchForTests } = await import('../src/researchAgent.js');
const { setProviderForTests } = await import('../src/provider.js');

const GOOD = {
  verdict: 'buy',
  confidence: 'medium',
  summary: 'Momentum is intact and the filing figures back it up.',
  entry_zone: 'near the 20-day SMA at 94.34',
  exit_target: null,
  stop_loss: '88.10, just under the 6-month low',
  hold_horizon: 'until the next earnings date',
  reasoning: ['Revenue growth is accelerating.'],
  risks: ['Concentrated customer base.'],
};

/** Provider stub: returns whatever structured payload the test wants. */
function stubProvider(data: unknown, model = 'gpt-4o-mini') {
  const calls: any[] = [];
  return {
    calls,
    provider: {
      model,
      generateText: async () => ({ ok: false as const, error: 'not used' }),
      generateStructured: async (req: any) => {
        calls.push(req);
        if (data instanceof Error) return { ok: false as const, error: data.message };
        return { ok: true as const, data, model };
      },
    },
  };
}

const ctx = { ticker: 'AMD', company: 'Advanced Micro Devices', fundamentals_summary: 'Revenue 1', levels_summary: '20-day SMA 94.34' };

test('runResearchAgent: one structured call, verdict returned, sources are the ones retrieved', async () => {
  const { calls, provider } = stubProvider(GOOD);
  setProviderForTests(provider);
  setSearchForTests(async () => [{ title: 'AMD beats', url: 'https://example.com/amd', snippet: 'beat estimates' }]);
  try {
    const res = await runResearchAgent(ctx);
    assert.equal(res.ok, true, res.ok === false ? res.error : '');
    if (res.ok !== true) return;

    assert.equal(res.verdict.verdict, 'buy');
    assert.equal(res.verdict.confidence, 'medium');
    assert.equal(res.verdict.ticker, 'AMD');
    assert.equal(res.verdict.model, 'gpt-4o-mini');
    assert.deepEqual(res.verdict.sources.map((s) => s.url), ['https://example.com/amd']);

    // Exactly one model call: no probe, no discovery, no tool loop.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].temperature, 0.2, 'temperature intent preserved');
    assert.equal(calls[0].schemaName, 'research_verdict');
    assert.equal(calls[0].schema.properties.verdict.enum.includes('strong_buy'), true);
    // Preserved prompt content: untrusted-data fencing and the anchor rule.
    assert.match(calls[0].user, /<untrusted_local_data>/);
    assert.match(calls[0].user, /https:\/\/example\.com\/amd/);
    assert.match(calls[0].system, /anchor/i);
  } finally {
    setProviderForTests(null);
    setSearchForTests(null);
  }
});

test('toVerdict fails closed on out-of-range or wrong-typed structured output', () => {
  assert.ok(toVerdict(GOOD, 'AMD', 'm', []), 'a valid payload passes');

  const bad: Record<string, unknown>[] = [
    { ...GOOD, verdict: 'moon' },              // outside the enum
    { ...GOOD, verdict: 42 },                  // wrong type
    { ...GOOD, confidence: 'certain' },        // outside the enum
    { ...GOOD, summary: '' },                  // empty summary is not an answer
    { ...GOOD, summary: 123 },
    { ...GOOD, reasoning: 'a string' },        // must be an array
    { ...GOOD, risks: [1, 2] },                // must be strings
    { ...GOOD, entry_zone: 12.5 },             // levels are text or null
  ];
  for (const b of bad) {
    assert.equal(toVerdict(b, 'AMD', 'm', []), null, `must reject: ${JSON.stringify(b).slice(0, 60)}`);
  }
  for (const b of [null, undefined, 'string', 42, []]) {
    assert.equal(toVerdict(b, 'AMD', 'm', []), null);
  }

  // Bounds: unbounded arrays and strings are clamped, not trusted as sent.
  const big = toVerdict({ ...GOOD, reasoning: Array(50).fill('x'), summary: 'y'.repeat(9000) }, 'AMD', 'm', []);
  assert.ok(big);
  assert.ok(big!.reasoning.length <= 8);
  assert.ok(big!.summary.length <= 2000);
});

test('runResearchAgent surfaces a malformed structured answer instead of inventing one', async () => {
  setProviderForTests(stubProvider({ verdict: 'moon', confidence: 'sure' }).provider);
  setSearchForTests(async () => []);
  try {
    const res = await runResearchAgent(ctx);
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.error : '', /malformed|discarded/i);
  } finally {
    setProviderForTests(null);
    setSearchForTests(null);
  }
});
