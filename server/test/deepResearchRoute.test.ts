// Route-level guarantees for the Deep Research experiment.
//
// The point of these is the blast radius, not the feature: with the flag off
// the server must behave exactly as it did before, and with the flag on the
// experiment must still be unable to reach anything that trades.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-deeproute-'));
process.env['CIVICFOLIO_DATA_DIR'] = testDir;
// Hermetic: a real key must never turn these into paid calls.
delete process.env['OPENAI_API_KEY'];
delete process.env['CIVICFOLIO_DEEP_RESEARCH'];

const { createApp } = await import('../src/app.js');
const E = await import('../src/deepEvidence.js');
const { setProviderForTests } = await import('../src/provider.js');
const { caseByName } = await import('./fixtures/deepResearch.js');

import request from 'supertest';

const app = createApp();
const agent = () => ({
  get: (url: string) => request(app).get(url).set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787'),
  post: (url: string) => request(app).post(url).set('Host', '127.0.0.1:8787').set('Origin', 'http://127.0.0.1:8787'),
});

after(() => {
  delete process.env['CIVICFOLIO_DEEP_RESEARCH'];
  E.setCollectorForTests(null);
  setProviderForTests(null);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('flag off: meta reports the experiment disabled', async () => {
  delete process.env['CIVICFOLIO_DEEP_RESEARCH'];
  const res = await agent().get('/api/meta').expect(200);
  assert.equal(res.body.deep_research_experiment.enabled, false);
});

test('flag off: the route does not exist', async () => {
  delete process.env['CIVICFOLIO_DEEP_RESEARCH'];
  const res = await agent().post('/api/experiment/deep-research/AMD').send({}).expect(404);
  assert.match(res.body.error, /not enabled/);
});

test('flag off: the ordinary research route is untouched', async () => {
  delete process.env['CIVICFOLIO_DEEP_RESEARCH'];
  // No key configured, so the baseline route fails exactly as it always has:
  // a 400 about configuration, never a deep-research code path.
  const res = await agent().post('/api/research/AMD').send({}).expect(400);
  assert.match(res.body.error, /OPENAI_API_KEY/);
});

test('flag on: meta advertises it, and it is labelled read-only', async () => {
  process.env['CIVICFOLIO_DEEP_RESEARCH'] = '1';
  const res = await agent().get('/api/meta').expect(200);
  assert.equal(res.body.deep_research_experiment.enabled, true);
  assert.match(res.body.deep_research_experiment.note, /no orders/);
});

test('flag on: an unresolved instrument returns 422 with the packet, not a report', async () => {
  process.env['CIVICFOLIO_DEEP_RESEARCH'] = '1';
  const c = caseByName('ambiguous_identity');
  E.setCollectorForTests(async () => c.collected as never);
  setProviderForTests({
    model: 'stub',
    generateText: async () => ({ ok: false as const, error: 'no' }),
    generateStructured: async () => {
      throw new Error('the model must not be called for an ambiguous instrument');
    },
  });
  const res = await agent().post('/api/experiment/deep-research/AMD').send({}).expect(422);
  assert.equal(res.body.packet.identity.state, 'AMBIGUOUS');
  assert.equal(res.body.packet.identity.company, null);
});

test('flag on: an invalid ticker is rejected before any work', async () => {
  process.env['CIVICFOLIO_DEEP_RESEARCH'] = '1';
  await agent().post('/api/experiment/deep-research/not-a-ticker').send({}).expect(400);
});

test('flag on: a deep run leaves the portfolio and paper fund untouched', async () => {
  process.env['CIVICFOLIO_DEEP_RESEARCH'] = '1';
  const before = await agent().get('/api/portfolio').expect(200);
  const fundBefore = await agent().get('/api/fund').expect(200);

  const c = caseByName('ordinary_supported');
  E.setCollectorForTests(async () => c.collected as never);
  const draft = {
    situation: 'A semiconductor company.',
    supporting_case: [{ text: 'Revenue was 25785000000 in the last filed year.', evidence_ids: ['E8'] }],
    opposing_case: [], risks: [], what_changed: [], unanswered_questions: [],
  };
  setProviderForTests({
    model: 'stub',
    generateText: async () => ({ ok: false as const, error: 'no' }),
    generateStructured: async (req: { schemaName: string }) => ({
      ok: true as const,
      data: req.schemaName === 'deep_research_review' ? { corrected_report: draft, issues: [] } : draft,
      model: 'stub',
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
    }),
  });

  const res = await agent().post('/api/experiment/deep-research/AMD').send({}).expect(200);
  assert.equal(res.body.ticker, 'AMD');

  const after = await agent().get('/api/portfolio').expect(200);
  const fundAfter = await agent().get('/api/fund').expect(200);
  assert.deepEqual(after.body, before.body, 'research must not move the portfolio');
  assert.deepEqual(fundAfter.body, fundBefore.body, 'research must not touch the paper fund');

  const trades = await agent().get('/api/portfolio/trades').expect(200);
  assert.equal(trades.body.trades.length, 0, 'no trade may exist after a research run');
});

test('flag on: a repeated request is served from cache, not a second pair of calls', async () => {
  process.env['CIVICFOLIO_DEEP_RESEARCH'] = '1';
  const c = caseByName('ordinary_supported');
  E.setCollectorForTests(async () => c.collected as never);
  let calls = 0;
  const draft = {
    situation: 'A semiconductor company.',
    supporting_case: [], opposing_case: [], risks: [], what_changed: [], unanswered_questions: [],
  };
  setProviderForTests({
    model: 'stub',
    generateText: async () => ({ ok: false as const, error: 'no' }),
    generateStructured: async (req: { schemaName: string }) => {
      calls++;
      return {
        ok: true as const,
        data: req.schemaName === 'deep_research_review' ? { corrected_report: draft, issues: [] } : draft,
        model: 'stub', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      };
    },
  });
  // NVDA: a ticker the earlier tests did not populate in the cache.
  const first = await agent().post('/api/experiment/deep-research/NVDA').send({}).expect(200);
  assert.equal(first.body.cached, false);
  const afterFirst = calls;
  const second = await agent().post('/api/experiment/deep-research/NVDA').send({}).expect(200);
  assert.equal(second.body.cached, true);
  assert.equal(calls, afterFirst, 'a cached answer must cost no model call');
});
