// OpenAI provider boundary: config, generation, structured output, and error
// mapping. Zero real API calls — every test either asserts a pre-network
// failure or injects a fake OpenAI client through the constructor seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { getProviderConfig, getProvider, resetProviderForTests, createProviderForTests, mapProviderError } = await import('../src/provider.js');

/** Run fn with the given env overrides, restoring whatever was there before. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('provider config: documented default model, env override, key presence only', () => {
  withEnv({ OPENAI_API_KEY: undefined, OPENAI_MODEL: undefined }, () => {
    const cfg = getProviderConfig();
    assert.equal(cfg.model, 'gpt-4o-mini', 'documented default model');
    assert.equal(cfg.hasKey, false);
    assert.equal(cfg.enabled, false, 'no key → AI paths disabled');
  });

  withEnv({ OPENAI_API_KEY: '«redacted:sk-…»', OPENAI_MODEL: 'gpt-4.1-mini' }, () => {
    const cfg = getProviderConfig();
    assert.equal(cfg.model, 'gpt-4.1-mini', 'OPENAI_MODEL overrides the default');
    assert.equal(cfg.hasKey, true);
    assert.equal(cfg.enabled, true);
    // The key itself must never ride along on the config object.
    assert.doesNotMatch(JSON.stringify(cfg), /sk-test-not-real/);
  });

  // Whitespace-only key is not a key.
  withEnv({ OPENAI_API_KEY: '   ' }, () => {
    assert.equal(getProviderConfig().hasKey, false);
  });
});

test('provider ignores base URL overrides and exposes no alternate endpoint config', () => {
  withEnv({ OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://alternate-provider.example/v1' }, () => {
    const cfg = getProviderConfig();
    assert.equal(cfg.enabled, true);
    assert.equal('baseUrl' in cfg, false);
    assert.equal('transportError' in cfg, false);
  });
});

test('normal start and development commands load an optional repository .env file', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.match(pkg.scripts?.start ?? '', /--env-file-if-exists=\.env/);
  assert.match(pkg.scripts?.['dev:server'] ?? '', /--env-file-if-exists=\.env/);
});

test('missing key fails closed without touching the network', async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: unknown[]) => { fetchCalls += 1; return realFetch(...(args as Parameters<typeof fetch>)); }) as typeof fetch;
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  resetProviderForTests();
  try {
    const res = await getProvider().generateText({ system: 's', user: 'u' });
    assert.equal(res.ok, false);
    assert.match(res.ok === false ? res.error : '', /OPENAI_API_KEY/);
    assert.match(res.ok === false ? res.error : '', /\.env or ~\/\.civicfolio\/env/);
    assert.equal(fetchCalls, 0, 'no request is attempted without a key');
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    resetProviderForTests();
  }
});

/** Fake OpenAI client: records the request, returns a canned response. */
function fakeClient(reply: unknown | ((req: any) => unknown)) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      responses: {
        create: async (req: any) => {
          calls.push(req);
          const r = typeof reply === 'function' ? (reply as (q: any) => unknown)(req) : reply;
          if (r instanceof Error) throw r;
          return r;
        },
      },
    } as any,
  };
}

test('generateText sends system/user/temperature and returns the answer', async () => {
  const { calls, client } = fakeClient({ output_text: '  Looks strong.  ', model: 'gpt-4o-mini-2024-07-18', status: 'completed' });
  const p = createProviderForTests('gpt-4o-mini', client);

  const res = await p.generateText({ system: 'you are civicfolio', user: 'how is NVDA?', temperature: 0.2, maxOutputTokens: 900 });

  assert.equal(res.ok, true);
  assert.equal(res.ok === true ? res.content : '', 'Looks strong.', 'answer is trimmed');
  assert.equal(res.ok === true ? res.model : '', 'gpt-4o-mini-2024-07-18', 'the model that actually answered');

  assert.equal(calls.length, 1, 'exactly one call — no probe round-trip');
  assert.equal(calls[0].model, 'gpt-4o-mini');
  assert.equal(calls[0].instructions, 'you are civicfolio');
  assert.equal(calls[0].input, 'how is NVDA?');
  assert.equal(calls[0].temperature, 0.2);
  assert.equal(calls[0].max_output_tokens, 900);
  assert.equal(calls[0].stream, undefined, 'the app is non-streaming');

  // An empty answer is a failure, never an empty assistant message.
  const empty = createProviderForTests('m', fakeClient({ output_text: '   ' }).client);
  assert.equal((await empty.generateText({ system: 's', user: 'u' })).ok, false);
});

test('generateText rejects an incomplete response instead of returning partial text', async () => {
  const provider = createProviderForTests('m', fakeClient({
    output_text: 'This answer was cut off',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  }).client);

  const result = await provider.generateText({ system: 's', user: 'u' });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /ran out of room|limit/i);
});

test('generateStructured: json_schema request, parsed object, fail-closed on garbage', async () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
  };

  const ok = fakeClient({ output_text: '{"verdict":"buy"}', model: 'm', status: 'completed' });
  const res = await createProviderForTests('m', ok.client)
    .generateStructured({ system: 's', user: 'u', schemaName: 'research_verdict', schema });
  assert.equal(res.ok, true);
  assert.deepEqual(res.ok === true ? res.data : null, { verdict: 'buy' });
  assert.deepEqual(ok.calls[0].text.format, { type: 'json_schema', name: 'research_verdict', schema, strict: true });

  // Malformed output is discarded, never repaired into a plausible-looking
  // verdict. Each of these used to be "fixed" by the old JSON repair pass.
  for (const bad of ['{"verdict":"buy"', 'not json at all', '', '[1,2,3]', '{"verdict":"buy"}{"extra":1}']) {
    const r = await createProviderForTests('m', fakeClient({ output_text: bad }).client)
      .generateStructured({ system: 's', user: 'u', schemaName: 'v', schema });
    assert.equal(r.ok, false, `must reject: ${bad}`);
  }

  // A truncated (incomplete) response is refused rather than parsed.
  const trunc = await createProviderForTests('m', fakeClient({ output_text: '{"verdict":"bu', status: 'incomplete' }).client)
    .generateStructured({ system: 's', user: 'u', schemaName: 'v', schema });
  assert.equal(trunc.ok, false);
  assert.match(trunc.ok === false ? trunc.error : '', /ran out of room|limit/i);
});

test('error mapping is specific and never leaks key or config', async () => {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-supersecret-value-1234567890';
  try {
    const cases: [unknown, RegExp][] = [
      [Object.assign(new Error('x'), { name: 'APIConnectionTimeoutError' }), /timed out/i],
      [Object.assign(new Error('x'), { name: 'APIConnectionError' }), /network error/i],
      [Object.assign(new Error('bad key'), { status: 401 }), /rejected the API key|OPENAI_API_KEY/],
      [Object.assign(new Error('nope'), { status: 403 }), /not permitted/i],
      [Object.assign(new Error('missing'), { status: 404 }), /not available to this account/i],
      [Object.assign(new Error('slow down'), { status: 429 }), /rate limit or quota/i],
      [Object.assign(new Error('too long'), { status: 400, code: 'context_length_exceeded' }), /context window/i],
      [Object.assign(new Error('boom'), { status: 500 }), /service error \(500\)/i],
    ];
    for (const [err, want] of cases) {
      const msg = mapProviderError(err, 'gpt-4o-mini');
      assert.match(msg, want);
      assert.doesNotMatch(msg, /sk-supersecret/, 'key never appears in an error');
    }
    // The 404 names the model so the operator knows what to change.
    assert.match(mapProviderError({ status: 404 }, 'gpt-9-turbo'), /gpt-9-turbo/);

    // Upstream text that echoes the key back is scrubbed before quoting.
    const echoed = mapProviderError(
      Object.assign(new Error('Incorrect API key provided: unit-test-key-value-1234567890 in header Bearer unit-test-key-value-1234567890'), { status: 400 }),
      'm',
    );
    assert.doesNotMatch(echoed, /unit-test-key|Incorrect API key|Bearer/i);
    assert.match(echoed, /rejected the request/i);

    const promptEcho = mapProviderError(Object.assign(new Error('Prompt contained private merger notes'), { status: 400 }), 'm');
    assert.doesNotMatch(promptEcho, /private merger notes/i, 'upstream request echoes are not relayed to the browser');

    const unknown = mapProviderError(new Error('Private request body: acquire TARGET at any price'), 'm');
    assert.equal(unknown, 'AI request failed. Retry or check the server configuration.');
    assert.doesNotMatch(unknown, /TARGET|request body/i);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
  }
});

test('callLlm routes chat through the provider, preserving prompt and citations', async () => {
  const { callLlm, getLlmConfig, buildStoreContext } = await import('../src/llm.js');
  const { setProviderForTests } = await import('../src/provider.js');

  const calls: any[] = [];
  setProviderForTests({
    model: 'gpt-4o-mini',
    generateText: async (req: any) => { calls.push(req); return { ok: true, content: 'NVDA looks extended here. [rec-1]', model: 'gpt-4o-mini-2024-07-18' }; },
    generateStructured: async () => ({ ok: false, error: 'not used' }),
  });
  try {
    const ctx = buildStoreContext({
      disclosures: [{ id: 'rec-1', ticker: 'NVDA', company: 'Nvidia', owner: 'X', owner_role: 'rep', tx_type: 'buy', tx_date_min: '2026-01-01', tx_date_max: '2026-01-02', published_date: '2026-01-10', amount_min_usd: 1000, amount_max_usd: 15000, amendment: false, source_name: 's', source_url: null, data_mode: 'demo' }],
    });
    const res = await callLlm(getLlmConfig(), 'is NVDA extended?', ctx);

    assert.equal(res.ok, true, res.error);
    assert.equal(res.model, 'gpt-4o-mini-2024-07-18', 'provenance is the model that answered');
    assert.deepEqual(res.citations?.map((c) => c.record_id), ['rec-1'], 'citations still filtered to sent records');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].temperature, 0.2, 'temperature intent preserved');
    assert.match(calls[0].system, /Civicfolio/, 'system prompt preserved');
    assert.match(calls[0].user, /<untrusted_local_data>/, 'store data stays fenced as untrusted');
    assert.match(calls[0].user, /Question: is NVDA extended\?/);
  } finally {
    setProviderForTests(null);
  }
});

test('no Ollama path, URL, env var, or filename survives in server source', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(process.cwd(), 'server/src');
  const files = fs.readdirSync(dir);

  assert.equal(files.some((f) => /ollama/i.test(f)), false, 'no Ollama-named source file');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(text, /ollama/i, `${f} still references Ollama`);
    assert.doesNotMatch(text, /OPENAI_BASE_URL/, `${f} still permits alternate provider endpoints`);
    // Ollama-specific endpoints. (The app's own express route '/api/chat' is
    // unrelated and must not be matched here.)
    assert.doesNotMatch(text, /11434|ollama\.com|api\/web_search|api\/tags/i, `${f} still has an Ollama endpoint`);
  }
});
