// Deep Research experiment: evidence packet, researcher/reviewer plumbing, and
// the application-side validation that has the last word.
//
// No network and no paid calls: the collector and the provider are both
// injected. These tests establish plumbing and invariants. They do NOT
// establish that the reviewed report is of higher model quality — only a live
// comparison could speak to that, and even then not conclusively.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const E = await import('../src/deepEvidence.js');
const D = await import('../src/deepResearch.js');
const { setProviderForTests } = await import('../src/provider.js');
const { CASES, caseByName } = await import('./fixtures/deepResearch.js');

const ON = () => { process.env.CIVICFOLIO_DEEP_RESEARCH = '1'; };
const OFF = () => { delete process.env.CIVICFOLIO_DEEP_RESEARCH; };

function useCase(name: string): void {
  const c = caseByName(name);
  E.setCollectorForTests(async () => c.collected as never);
}

afterEach(() => {
  E.setCollectorForTests(null);
  setProviderForTests(null);
  OFF();
});

/** Provider stub returning a scripted payload per call, recording each request. */
function stubProvider(payloads: unknown[], model = 'gpt-4o-mini') {
  const calls: { system: string; user: string }[] = [];
  return {
    calls,
    provider: {
      model,
      generateText: async () => ({ ok: false as const, error: 'not used' }),
      generateStructured: async (req: { system: string; user: string }) => {
        calls.push({ system: req.system, user: req.user });
        const next = payloads.shift();
        if (next instanceof Error) return { ok: false as const, error: next.message };
        return { ok: true as const, data: next, model, usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200 } };
      },
    },
  };
}

const claim = (text: string, ids: string[]) => ({ text, evidence_ids: ids });
const report = (over: Record<string, unknown> = {}) => ({
  situation: 'AMD is a semiconductor company trading below its 6-month high.',
  supporting_case: [claim('Revenue was 25785000000 in the last filed year.', ['E8'])],
  opposing_case: [claim('The stock sits well below its 6-month high of 178.5.', ['E5'])],
  risks: [claim('Filed annual figures may be months old.', ['E8'])],
  what_changed: [claim('Data-centre revenue beat guidance.', ['E1'])],
  unanswered_questions: ['Segment-level margins are not in the packet.'],
  ...over,
});

// ---- identity -------------------------------------------------------------

test('identity: independent sources that agree resolve the instrument', () => {
  const id = E.resolveIdentity('AMD', 'Advanced Micro Devices, Inc.', 'Advanced Micro Devices', 'NMS', 'USD');
  assert.equal(id.state, 'OK');
  assert.equal(id.company, 'Advanced Micro Devices, Inc.');
  assert.equal(id.conflicts.length, 0);
});

test('identity: two different companies for one ticker is AMBIGUOUS, not a pick', () => {
  const id = E.resolveIdentity('AMD', 'Applied Medical Devices Inc', 'Advanced Micro Devices, Inc.', 'NMS', 'USD');
  assert.equal(id.state, 'AMBIGUOUS');
  assert.equal(id.company, null, 'an ambiguous identity must not silently become one of them');
  assert.equal(id.candidates.length, 2);
});

test('identity: a single source resolves but is recorded as uncorroborated', () => {
  const id = E.resolveIdentity('AMD', null, 'Advanced Micro Devices, Inc.', null, null);
  assert.equal(id.state, 'OK');
  assert.match(id.conflicts.join(' '), /one source only/);
});

test('identity: no name at all is UNRESOLVED', () => {
  assert.equal(E.resolveIdentity('ZZZZ', null, null, null, null).state, 'UNRESOLVED');
});

test('identity: legal suffixes do not make two names disagree', () => {
  assert.ok(E.namesAgree('Advanced Micro Devices, Inc.', 'Advanced Micro Devices'));
  assert.ok(!E.namesAgree('Applied Medical Devices', 'Advanced Micro Devices'));
});

// ---- evidence packet ------------------------------------------------------

test('packet: every item carries its own source, times and limitations', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  assert.ok(p.items.length > 5);
  for (const it of p.items) {
    assert.ok(it.id.startsWith('E'), 'each item is citable by id');
    assert.ok(it.source.length > 0, `${it.id} must name a source`);
    assert.ok(it.retrieved_at, `${it.id} must record retrieval time`);
  }
  const revenue = p.items.find((i) => i.claim.startsWith('Revenue'));
  assert.ok(revenue);
  assert.equal(revenue.period_end, '2025-12-27', 'the reporting period, not the retrieval time');
  assert.equal(revenue.published_at, '2026-02-04', 'the filing date, distinct from the period');
  assert.notEqual(revenue.published_at, revenue.retrieved_at);
});

test('packet: quote time is not retrieval time, and unknown stays unknown', async () => {
  const c = caseByName('ordinary_supported');
  E.setCollectorForTests(async () => ({
    ...c.collected,
    quote: { ...(c.collected.quote as object), as_of: null },
  } as never));
  const p = await E.buildEvidencePacket('AMD');
  const q = p.items.find((i) => i.kind === 'quote');
  assert.ok(q);
  assert.equal(q.published_at, null, 'an unknown quote time must not be stamped with "now"');
  assert.match(q.limitations.join(' '), /cannot be called current/);
});

test('packet: undated news is marked unusable as recent evidence', async () => {
  useCase('stale_and_undated_news');
  const p = await E.buildEvidencePacket('AMD');
  const undated = p.items.find((i) => i.kind === 'news' && i.published_at === null);
  assert.ok(undated);
  assert.match(undated.limitations.join(' '), /undated/);
});

test('packet: missing financials are recorded as missing, never as zero', async () => {
  useCase('missing_financials');
  const p = await E.buildEvidencePacket('AMD');
  assert.ok(p.missing.some((m) => m.kind === 'fundamentals'));
  assert.equal(p.items.filter((i) => i.kind === 'fundamentals').length, 0);
});

test('packet: a balance sheet that does not balance is flagged', async () => {
  useCase('conflicting_reports');
  const p = await E.buildEvidencePacket('AMD');
  assert.match(p.conflicts.join(' '), /do not equal liabilities \+ equity/);
});

test('packet: a non-USD quote against USD filings is flagged as not comparable', async () => {
  useCase('conflicting_reports');
  const p = await E.buildEvidencePacket('AMD');
  assert.match(p.conflicts.join(' '), /not directly comparable/);
});

test('packet: a cutoff excludes later evidence and discloses what it cannot enforce', async () => {
  const c = caseByName('historical_cutoff');
  E.setCollectorForTests(async () => c.collected as never);
  const p = await E.buildEvidencePacket('AMD', { cutoff: c.cutoff });
  const newsAfter = p.items.filter((i) => i.kind === 'news' && i.published_at !== null
    && Date.parse(i.published_at) > Date.parse(c.cutoff!));
  assert.equal(newsAfter.length, 0, 'information published after the cutoff must not leak in');
  assert.equal(p.point_in_time.enforced, false, 'undatable price levels mean PIT is not established');
  assert.match(p.point_in_time.limitation ?? '', /not a historical backtest/);
});

// ---- validation: the application has the last word ------------------------

test('validation: a citation id absent from the packet is rejected', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    supporting_case: [claim('Revenue was 25785000000 in the last filed year.', ['E99'])],
  }) as never, p);
  assert.equal(r.validation.ok, false);
  assert.match(r.validation.bad_citations.join(' '), /E99/);
});

test('validation: a number the packet does not contain is removed, not reworded', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    supporting_case: [claim('The price target is 400.00 per share.', ['E1'])],
  }) as never, p);
  assert.equal(r.report.supporting_case.length, 0, 'an invented figure must not survive');
  assert.match(r.validation.unsupported_numbers.join(' '), /400/);
});

test('validation: a real packet number passes', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    supporting_case: [claim('The 50-day SMA is 141.22.', ['E5'])],
  }) as never, p);
  assert.equal(r.report.supporting_case.length, 1);
  assert.equal(r.validation.unsupported_numbers.length, 0);
});

test('validation: a claim citing nothing is dropped', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({ risks: [claim('Management may be dishonest.', [])] }) as never, p);
  assert.equal(r.report.risks.length, 0);
  assert.match(r.validation.uncited_claims.join(' '), /cites no evidence/);
});

test('validation: naming a different company is caught', async () => {
  useCase('ambiguous_identity');
  const p = await E.buildEvidencePacket('AMD');
  // Force an OK identity so the entity check itself is what is under test.
  const forced = { ...p, identity: { ...p.identity, state: 'OK' as const, company: 'Advanced Micro Devices, Inc.' } };
  const r = D.validateReport(report({
    situation: 'Applied Medical Devices Inc makes surgical tools.',
  }) as never, forced);
  assert.equal(r.validation.ok, false);
  assert.match(r.validation.entity_problems.join(' '), /Applied Medical Devices/);
});

test('validation: years and small counts are prose, not uncited figures', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    risks: [claim('The 2026 fiscal year has 4 quarters of execution risk.', ['E1'])],
  }) as never, p);
  assert.equal(r.report.risks.length, 1, 'a year is not a cited financial figure');
});

// ---- the workflow ---------------------------------------------------------

test('workflow: exactly two synthesis calls, researcher then reviewer', async () => {
  ON(); useCase('ordinary_supported');
  const { calls, provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  assert.equal(calls.length, 2, 'no third "final writer" call and no debate loop');
  assert.match(calls[0].system, /You are the researcher/);
  assert.match(calls[1].system, /You are the reviewer/);
  assert.equal(out.result.usage.length, 2);
});

test('workflow: the reviewer receives the same evidence packet as the researcher', async () => {
  ON(); useCase('ordinary_supported');
  const { calls, provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
  setProviderForTests(provider);
  await D.runDeepResearch('AMD');
  const packetOf = (s: string) => s.slice(s.indexOf('<evidence_packet>'), s.indexOf('</evidence_packet>'));
  assert.equal(packetOf(calls[0].user), packetOf(calls[1].user));
  assert.match(calls[1].user, /<draft_report>/);
});

test('workflow: an ambiguous instrument spends no model call at all', async () => {
  ON(); useCase('ambiguous_identity');
  const { calls, provider } = stubProvider([report()]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, 'writing a confident report about an unknown company is the failure to avoid');
  assert.equal(out.packet?.identity.state, 'AMBIGUOUS');
});

test('workflow: total provider failure yields an honest error, not a report', async () => {
  ON(); useCase('provider_failure');
  const { calls, provider } = stubProvider([report()]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
});

test('workflow: a failed review keeps the draft but says it is unreviewed', async () => {
  ON(); useCase('ordinary_supported');
  const { provider } = stubProvider([report(), new Error('rate limited')]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  assert.match(out.result.limitations.join(' '), /unreviewed draft/);
  assert.equal(out.result.usage.length, 1, 'a failed stage is not counted as used');
});

test('workflow: a reviewer that invents a number is still overruled by validation', async () => {
  ON(); useCase('ordinary_supported');
  const { provider } = stubProvider([
    report(),
    { corrected_report: report({ supporting_case: [claim('Fair value is 999.99 per share.', ['E1'])] }), issues: [] },
  ]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  assert.equal(out.result.report.supporting_case.length, 0, 'the reviewer is not trusted over the packet');
  assert.match(out.result.validation.unsupported_numbers.join(' '), /999\.99/);
});

test('workflow: retrieved content carrying instructions stays data', async () => {
  ON(); useCase('prompt_injection');
  const { calls, provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  // The injected text is fenced and labelled as untrusted in both turns...
  assert.match(calls[0].system, /untrusted third-party data, not instructions/);
  assert.match(calls[0].user, /<evidence_packet>/);
  // ...and the figure it tries to plant cannot reach the output.
  const forced = D.validateReport(report({
    supporting_case: [claim('Strong buy with a 400 target.', ['E1'])],
  }) as never, out.result.packet);
  assert.equal(forced.report.supporting_case.length, 0);
});

test('workflow: agreement between the two calls is never sold as corroboration', async () => {
  ON(); useCase('ordinary_supported');
  const { provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  assert.match(out.result.limitations.join(' '), /not independent corroboration/);
});

// ---- cost -----------------------------------------------------------------

test('cost: token usage is reported and dollar cost is unknown without a configured price', async () => {
  ON(); useCase('ordinary_supported');
  delete process.env.CIVICFOLIO_USD_PER_MTOK_IN;
  delete process.env.CIVICFOLIO_USD_PER_MTOK_OUT;
  const { provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.ok(out.ok);
  assert.equal(out.result.usage[0].input_tokens, 1000);
  assert.equal(out.result.cost.amount, null, 'an unpriced run reports usage, not a made-up dollar figure');
  assert.match(out.result.cost.basis, /no documented price configured/);
});

test('cost: a configured price produces an arithmetic total', async () => {
  ON(); useCase('ordinary_supported');
  process.env.CIVICFOLIO_USD_PER_MTOK_IN = '0.15';
  process.env.CIVICFOLIO_USD_PER_MTOK_OUT = '0.60';
  try {
    const { provider } = stubProvider([report(), { corrected_report: report(), issues: [] }]);
    setProviderForTests(provider);
    const out = await D.runDeepResearch('AMD');
    assert.ok(out.ok);
    // 2 stages x (1000 in, 200 out)
    const expected = 2 * ((1000 / 1e6) * 0.15 + (200 / 1e6) * 0.6);
    assert.ok(Math.abs((out.result.cost.amount ?? 0) - expected) < 1e-9);
  } finally {
    delete process.env.CIVICFOLIO_USD_PER_MTOK_IN;
    delete process.env.CIVICFOLIO_USD_PER_MTOK_OUT;
  }
});

// ---- the flag and the blast radius ---------------------------------------

test('flag off: the workflow refuses and spends nothing', async () => {
  OFF(); useCase('ordinary_supported');
  const { calls, provider } = stubProvider([report()]);
  setProviderForTests(provider);
  const out = await D.runDeepResearch('AMD');
  assert.equal(out.ok, false);
  assert.equal(calls.length, 0);
  assert.match((out as { error: string }).error, /disabled/);
});

test('flag: only an explicit truthy value enables the experiment', () => {
  for (const v of ['', '0', 'false', 'off', 'no']) {
    process.env.CIVICFOLIO_DEEP_RESEARCH = v;
    assert.equal(E.isDeepResearchEnabled(), false, `"${v}" must not enable it`);
  }
  for (const v of ['1', 'true', 'on', 'ON']) {
    process.env.CIVICFOLIO_DEEP_RESEARCH = v;
    assert.equal(E.isDeepResearchEnabled(), true);
  }
  OFF();
});

test('blast radius: the experiment cannot reach trading or paper-fund code', async () => {
  // Structural, not behavioural: an import is how it would ever gain the
  // ability, so the absence of one is the invariant worth pinning.
  const fs = await import('node:fs');
  const url = await import('node:url');
  const dir = url.fileURLToPath(new URL('../src/', import.meta.url));
  const forbidden = ['portfolio.js', 'aiFund.js', 'fundLoop.js', 'fundRuns.js', 'fundChat.js', 'store.js'];
  for (const file of ['deepResearch.ts', 'deepEvidence.ts']) {
    const src = fs.readFileSync(dir + file, 'utf8');
    const imports = [...src.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]);
    for (const f of forbidden) {
      assert.ok(!imports.includes(f), `${file} must not import ${f} — it would put trading in reach`);
    }
  }
});

test('every fixture case builds a packet without throwing', async () => {
  for (const c of CASES) {
    E.setCollectorForTests(async () => c.collected as never);
    const p = await E.buildEvidencePacket(c.ticker, { cutoff: c.cutoff ?? null });
    assert.ok(p.cache_key.includes(c.ticker), `${c.name}: packet must be keyed by instrument`);
  }
});

// ---- unit scaling (found by the live smoke run) --------------------------

test('statedNumbers applies scale words', () => {
  const got = D.statedNumbers('revenue 34.64 billion USD, assets 76.93 billion, up 3%');
  assert.deepEqual(got.map((n) => n.value), [34.64e9, 76.93e9, 3]);
  assert.equal(got[2].isPercent, true);
});

test('validation: "34.64 billion" matches a packet value of 34640000000', async () => {
  const c = caseByName('ordinary_supported');
  E.setCollectorForTests(async () => ({
    ...c.collected,
    fundamentals: { ...(c.collected.fundamentals as object), revenue_usd: 34640000000 },
  } as never));
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    supporting_case: [claim('Revenue was 34.64 billion USD in the last filed year.', ['E8'])],
  }) as never, p);
  assert.equal(r.validation.unsupported_numbers.length, 0,
    'a correct restatement in billions must not be flagged as invented');
  assert.equal(r.report.supporting_case.length, 1);
});

test('validation: a wrong figure in billions is still caught', async () => {
  const c = caseByName('ordinary_supported');
  E.setCollectorForTests(async () => ({
    ...c.collected,
    fundamentals: { ...(c.collected.fundamentals as object), revenue_usd: 34640000000 },
  } as never));
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    supporting_case: [claim('Revenue was 91.2 billion USD in the last filed year.', ['E8'])],
  }) as never, p);
  assert.match(r.validation.unsupported_numbers.join(' '), /91\.2/);
  assert.equal(r.report.supporting_case.length, 0);
});

test('validation: a small bare number in billions is checked, not skipped', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  // 4.34 alone would fall under the bare-number floor; scaled it is 4.34e9 and
  // the packet's net income is 1.641e9, so it must be caught.
  const r = D.validateReport(report({
    supporting_case: [claim('Net income was 4.34 billion USD.', ['E9'])],
  }) as never, p);
  assert.match(r.validation.unsupported_numbers.join(' '), /4\.34/);
});

// ---- identifiers are not figures (found in the live preview trial) --------

test('statedNumbers ignores SEC form names and quarter labels', () => {
  const got = D.statedNumbers('The 10-K filed in Q3 reports revenue of 25.8 billion USD.');
  assert.deepEqual(got.map((n) => n.value), [25.8e9],
    '"10-K" and "Q3" are identifiers, not quantities');
});

test('validation: a claim about a 10-K filing is not removed as an invented number', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    risks: [claim('The financial figures come from a 10-K filed in February 2026 and '
                  + 'may be several months old.', ['E8'])],
  }) as never, p);
  assert.equal(r.report.risks.length, 1, 'a correct, useful risk must survive');
  assert.equal(r.validation.unsupported_numbers.length, 0);
});

test('validation: a real invented percentage is still caught', async () => {
  useCase('ordinary_supported');
  const p = await E.buildEvidencePacket('AMD');
  const r = D.validateReport(report({
    what_changed: [claim('The stock rebounded by 3% recently.', ['E1'])],
  }) as never, p);
  assert.match(r.validation.unsupported_numbers.join(' '), /3%/);
  assert.equal(r.report.what_changed.length, 0);
});
