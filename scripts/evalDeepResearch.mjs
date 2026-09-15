// Controlled comparison: baseline research agent vs the Deep Research experiment.
//
//   npm run eval:deep            # mocked, deterministic, no network, no cost
//   npm run eval:deep -- --live  # one live ticker through both paths (paid)
//
// What this can and cannot establish
// ----------------------------------
// The mocked mode runs both paths over BYTE-IDENTICAL frozen evidence with a
// scripted model. It therefore measures PLUMBING AND INVARIANTS: whether the
// entity is right, whether cited numbers exist in the evidence, whether stale
// and undated items are handled, whether future information leaks past a
// cutoff. It says NOTHING about whether the reviewed report is better written
// or more insightful — a scripted model has no quality to measure.
//
// The live mode is illustrative only. One ticker is an anecdote, not a
// statistically meaningful result, and there is no LLM-generated quality score
// here on purpose: letting a model grade its own workflow would be the least
// trustworthy number in the report.
//
// Where evidence coverage differs between the two paths, that is reported
// separately, so an improvement is not credited to "the extra reviewer" when it
// actually came from the packet having more in it.

import { parseArgs } from 'node:util';

process.env.CIVICFOLIO_DEEP_RESEARCH ??= '1';

const E = await import('../server/src/deepEvidence.ts');
const D = await import('../server/src/deepResearch.ts');
const { runResearchAgent, setSearchForTests, verifyLevels } = await import('../server/src/researchAgent.ts');
const { setProviderForTests, resetProviderForTests } = await import('../server/src/provider.ts');
const { CASES } = await import('../server/test/fixtures/deepResearch.ts');

const { values } = parseArgs({
  options: { live: { type: 'boolean', default: false }, ticker: { type: 'string', default: 'AMD' } },
  allowPositionals: true,
});

// ---- scripted model -------------------------------------------------------
//
// One deliberately flawed draft, reused for both paths so the comparison is
// about what each path DOES with a flawed draft, not about draft variation.
// The flaws are the ones the experiment claims to catch.

const FLAWED = {
  situation: 'The company is executing well and the setup looks constructive.',
  supporting_case: [
    { text: 'Revenue was 25785000000 in the last filed year.', evidence_ids: ['E8'] },
    { text: 'A fair value of 400.00 per share is achievable this year.', evidence_ids: ['E1'] },
  ],
  opposing_case: [{ text: 'The stock trades below its 6-month high.', evidence_ids: ['E5'] }],
  risks: [{ text: 'Execution could slip.', evidence_ids: [] }],
  what_changed: [{ text: 'Recent headlines point to stronger demand.', evidence_ids: ['E1'] }],
  unanswered_questions: ['Segment margins are not available.'],
};

// The baseline's verdict schema, carrying the same invented level.
const BASELINE_VERDICT = {
  verdict: 'buy',
  confidence: 'high',
  summary: 'Executing well; constructive setup.',
  entry_zone: 'near 400.00',
  exit_target: '520.00',
  stop_loss: '88.10, just under the 6-month low',
  hold_horizon: 'about six months',
  reasoning: ['Revenue was 25785000000 in the last filed year.', 'A fair value of 400.00 per share is achievable.'],
  risks: ['Execution could slip.'],
};

function scripted(payloads) {
  const queue = [...payloads];
  return {
    model: 'scripted-eval',
    generateText: async () => ({ ok: false, error: 'not used' }),
    generateStructured: async () => {
      const next = queue.shift() ?? payloads[payloads.length - 1];
      return { ok: true, data: next, model: 'scripted-eval', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 240 } };
    },
  };
}

// ---- metrics --------------------------------------------------------------

function numbersIn(text) {
  return [...String(text).matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && Math.abs(n) >= 10 && !(Number.isInteger(n) && n >= 1900 && n <= 2100));
}

function scoreExperiment(result) {
  const r = result.report;
  const claims = [...r.supporting_case, ...r.opposing_case, ...r.risks, ...r.what_changed];
  const supported = E.packetNumbers(result.packet);
  const close = (n) => supported.some((p) => (p === 0 ? n === 0 : Math.abs((n - p) / p) <= 0.005));
  const stated = claims.flatMap((c) => numbersIn(c.text));
  return {
    entity_ok: result.validation.entity_problems.length === 0,
    claims: claims.length,
    cited_claims: claims.filter((c) => c.evidence_ids.length > 0).length,
    numeric_claims: stated.length,
    unsupported_numbers: stated.filter((n) => !close(n)).length,
    unresolved_gaps: r.unanswered_questions.length,
    evidence_items: result.packet.items.length,
    limitations_disclosed: result.limitations.length,
    tokens_in: result.usage.reduce((a, u) => a + (u.input_tokens ?? 0), 0),
    tokens_out: result.usage.reduce((a, u) => a + (u.output_tokens ?? 0), 0),
    model_calls: result.usage.length,
    latency_ms: result.usage.reduce((a, u) => a + u.latency_ms, 0),
  };
}

function scoreBaseline(verdict, packet, levelChecks) {
  // Same yardstick, applied to whatever the baseline actually shows a user.
  const claims = [...verdict.reasoning, ...verdict.risks];
  const supported = E.packetNumbers(packet);
  const close = (n) => supported.some((p) => (p === 0 ? n === 0 : Math.abs((n - p) / p) <= 0.005));
  const stated = [...claims, verdict.entry_zone ?? '', verdict.exit_target ?? '', verdict.stop_loss ?? '']
    .flatMap((t) => numbersIn(t));
  return {
    entity_ok: true, // the baseline never resolves an entity, so it cannot fail this check — see note
    claims: claims.length,
    cited_claims: 0, // the baseline has no per-claim citations at all
    numeric_claims: stated.length,
    unsupported_numbers: stated.filter((n) => !close(n)).length,
    unresolved_gaps: 0, // no "unanswered questions" field exists
    evidence_items: packet.items.length,
    limitations_disclosed: (levelChecks ?? []).filter((c) => !c.grounded).length,
    tokens_in: 1200, tokens_out: 240, model_calls: 1, latency_ms: 0,
  };
}

// ---- mocked comparison ----------------------------------------------------

async function mocked() {
  const rows = [];
  for (const c of CASES) {
    E.setCollectorForTests(async () => c.collected);
    const packet = await E.buildEvidencePacket(c.ticker, { cutoff: c.cutoff ?? null });

    // --- experiment: researcher returns the flawed draft; reviewer returns it
    // unchanged, so any improvement is attributable to APPLICATION validation,
    // not to a reviewer we scripted to be clever.
    setProviderForTests(scripted([FLAWED, { corrected_report: FLAWED, issues: [] }]));
    const exp = await D.runDeepResearch(c.ticker, { cutoff: c.cutoff ?? null });

    // --- baseline: same evidence, rendered the way the baseline renders it.
    setProviderForTests(scripted([BASELINE_VERDICT]));
    setSearchForTests(async () => []);
    const base = await runResearchAgent({
      ticker: c.ticker,
      company: packet.identity.company ?? c.ticker,
      market_summary: packet.items.filter((i) => i.kind === 'quote').map((i) => i.claim).join('\n'),
      levels_summary: packet.items.filter((i) => i.kind === 'levels').map((i) => i.claim).join('\n'),
      news_summary: packet.items.filter((i) => i.kind === 'news').map((i) => i.claim).join('\n'),
      fundamentals_summary: packet.items.filter((i) => i.kind === 'fundamentals').map((i) => i.claim).join('\n'),
    });

    let baseScore = null;
    if (base.ok) {
      const checks = verifyLevels(
        { entry_zone: base.verdict.entry_zone, exit_target: base.verdict.exit_target, stop_loss: base.verdict.stop_loss },
        Object.fromEntries(packet.items.filter((i) => i.kind === 'levels' && i.value !== null).map((i) => [i.claim, i.value])),
      );
      baseScore = scoreBaseline(base.verdict, packet, checks);
    }

    rows.push({
      case: c.name,
      probe: c.probe,
      identity: packet.identity.state,
      pit_enforced: c.cutoff ? packet.point_in_time.enforced : null,
      experiment: exp.ok ? scoreExperiment(exp.result) : { refused: exp.error },
      baseline: base.ok ? baseScore : { refused: base.error },
    });
  }
  E.setCollectorForTests(null);
  setProviderForTests(null);
  setSearchForTests(null);
  return rows;
}

// ---- live (paid, one ticker) ---------------------------------------------

async function live(ticker) {
  resetProviderForTests();
  const out = await D.runDeepResearch(ticker);
  if (!out.ok) return { ticker, refused: out.error, identity: out.packet?.identity ?? null };
  return {
    ticker,
    identity: out.result.packet.identity.state,
    company: out.result.packet.identity.company,
    metrics: scoreExperiment(out.result),
    validation_ok: out.result.validation.ok,
    review_issues: out.result.review_issues.length,
    cost: out.result.cost,
  };
}

// ---- report ---------------------------------------------------------------

function line(label, a, b) {
  const f = (v) => (v === null || v === undefined ? '—' : String(v));
  return `  ${label.padEnd(24)} baseline ${f(b).padEnd(10)} experiment ${f(a)}`;
}

const rows = await mocked();
console.log('=== Deep Research evaluation (mocked, frozen evidence, no network) ===\n');
console.log('Both paths see byte-identical evidence and the SAME flawed draft.');
console.log('This measures plumbing and invariants, not model quality.\n');

let coverageNote = false;
for (const r of rows) {
  console.log(`--- ${r.case}  [identity ${r.identity}${r.pit_enforced === null ? '' : `, point-in-time enforced: ${r.pit_enforced}`}]`);
  console.log(`    probe: ${r.probe}`);
  if (r.experiment.refused || r.baseline.refused) {
    console.log(`    experiment: ${r.experiment.refused ? `REFUSED — ${r.experiment.refused}` : 'answered'}`);
    console.log(`    baseline:   ${r.baseline.refused ? `REFUSED — ${r.baseline.refused}` : 'answered'}`);
    console.log('');
    continue;
  }
  if (r.experiment.evidence_items !== r.baseline.evidence_items) coverageNote = true;
  console.log(line('entity correct', r.experiment.entity_ok, r.baseline.entity_ok));
  console.log(line('claims shown', r.experiment.claims, r.baseline.claims));
  console.log(line('claims with citations', r.experiment.cited_claims, r.baseline.cited_claims));
  console.log(line('unsupported numbers', r.experiment.unsupported_numbers, r.baseline.unsupported_numbers));
  console.log(line('gaps named', r.experiment.unresolved_gaps, r.baseline.unresolved_gaps));
  console.log(line('limitations disclosed', r.experiment.limitations_disclosed, r.baseline.limitations_disclosed));
  console.log(line('model calls', r.experiment.model_calls, r.baseline.model_calls));
  console.log(line('tokens (in/out)', `${r.experiment.tokens_in}/${r.experiment.tokens_out}`, `${r.baseline.tokens_in}/${r.baseline.tokens_out}`));
  console.log('');
}

const answered = rows.filter((r) => !r.experiment.refused && !r.baseline.refused);
const sum = (f) => answered.reduce((a, r) => a + f(r), 0);
console.log('=== totals over answered cases ===');
console.log(line('unsupported numbers', sum((r) => r.experiment.unsupported_numbers), sum((r) => r.baseline.unsupported_numbers)));
console.log(line('claims with citations', sum((r) => r.experiment.cited_claims), sum((r) => r.baseline.cited_claims)));
console.log(line('model calls', sum((r) => r.experiment.model_calls), sum((r) => r.baseline.model_calls)));
console.log(line('tokens in', sum((r) => r.experiment.tokens_in), sum((r) => r.baseline.tokens_in)));
console.log(`\nRefusals — experiment: ${rows.filter((r) => r.experiment.refused).length}, baseline: ${rows.filter((r) => r.baseline.refused).length}`);
console.log('A refusal on the ambiguous-identity case is the correct answer, not a failure.');
console.log('FAIRNESS NOTE: this harness calls the baseline AGENT directly. The baseline ROUTE');
console.log('has its own no-market-data guard (404 before the model runs), so on the');
console.log('provider_failure case the shipped baseline would also refuse. Do not read that');
console.log('row as the baseline answering with no data in production.');
console.log('The baseline also verifies levels (verifyLevels) and shows ungrounded ones; it');
console.log('reports them rather than removing them, which is why its "limitations disclosed"');
console.log('is non-zero while its unsupported-number count stays high.');
if (coverageNote) {
  console.log('\nNOTE: evidence coverage differed between paths on at least one case;');
  console.log('that difference is not attributable to the reviewer.');
}
console.log('\nThe experiment costs roughly 2x the model calls of the baseline.');
console.log('Mocked results establish invariants only. They are NOT evidence of better model quality.');

if (values.live) {
  console.log('\n=== live run (PAID, one ticker, illustrative only) ===');
  const r = await live(values.ticker.toUpperCase());
  console.log(JSON.stringify(r, null, 2));
  console.log('\nOne ticker is an anecdote. This is not a statistically meaningful comparison.');
}
