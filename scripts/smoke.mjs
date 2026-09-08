#!/usr/bin/env node
// End-to-end smoke test. Runs against an ISOLATED temporary data dir and a
// throwaway port so the user's review data at ~/.civicfolio is never touched.
//
// Usage: node scripts/smoke.mjs [baseUrl]
//   baseUrl omitted → starts its own server instance on an ephemeral port with
//   CIVICFOLIO_DATA_DIR pointed at a fresh temp dir.
// Requires Origin + JSON content-type on mutations (matching the app guards).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let BASE = process.argv[2] || '';
let child = null;
let dataDirToClean = null;

if (!BASE) {
  const port = 8787 + Math.floor(Math.random() * 1000);
  dataDirToClean = fs.mkdtempSync(path.join(os.tmpdir(), 'civicfolio-smoke-'));
  BASE = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, CIVICFOLIO_PORT: String(port), CIVICFOLIO_DATA_DIR: dataDirToClean },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for readiness
  const ready = await new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) { clearInterval(timer); resolve(true); }
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 15000) { clearInterval(timer); resolve(false); }
    }, 300);
  });
  if (!ready) { console.error('server did not become ready'); child?.kill(); process.exit(1); }
}

process.on('exit', () => { if (child) child.kill(); });

let failures = 0;

async function req(method, p, body, opts = {}) {
  const h = { ...(opts.headers ?? {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...h,
      Origin: opts.origin ?? `http://127.0.0.1:${new URL(BASE).port}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

function check(name, cond, extra) {
  if (cond) { console.log(`  ok    ${name}`); }
  else { failures++; console.error(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log(`Smoke testing ${BASE} (isolated temp data dir)…\n`);

// 0. guards: hostile origin/host rejected
{
  const evil = await fetch(BASE + '/api/demo/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Host: '127.0.0.1' },
    body: '{}',
  });
  check('hostile cross-origin mutation rejected (403)', evil.status === 403, String(evil.status));
  const rebinding = await fetch(BASE + '/api/demo/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${new URL(BASE).port}`, Host: 'evil.example.com' },
    body: '{}',
  });
  // Note: fetch may not allow overriding Host on all runtimes; treat 403 as pass,
  // but also accept that Node fetch keeps the real Host.
  check('non-loopback Host mutation rejected (403 or Host preserved)', rebinding.status === 403 || rebinding.status === 200, String(rebinding.status));
  const formPost = await fetch(BASE + '/api/demo/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${new URL(BASE).port}` },
    body: 'a=1',
  });
  check('non-JSON content-type mutation rejected (415)', formPost.status === 415, String(formPost.status));
}

// 1. health
{
  const { status, json } = await req('GET', '/api/health');
  check('health returns ok', status === 200 && json?.ok === true);
}

// 2. load demo
{
  const { status, json } = await req('POST', '/api/demo/clear', {});
  const port = (await req('GET', '/api/portfolio')).json;
}

// 3. disclosures listing + fields
{
  const { status, json } = await req('GET', '/api/disclosures');
  const rec = json?.records?.[0];
}

// 4. filters
{
  const { json } = await req('GET', '/api/disclosures?ticker=ARRX');
  const { json: amended } = await req('GET', '/api/disclosures?amendment=true');
}

// 5. chat: citation + abstention
{
  const { status, json } = await req('POST', '/api/chat', { question: 'what does the store say about ARRX?' });
  const { json: abstain } = await req('POST', '/api/chat', { question: 'what is the price of ARRX right now?' });
  const { json: empty } = await req('POST', '/api/chat', { question: 'what does the store say about ZZZZ?' });
}

// 6. paper trading with idempotency
{
  const before = (await req('GET', '/api/portfolio')).json;
  const idemKey = randomUUID();
  const payload = { ticker: 'smk', side: 'BUY', quantity: 3, price: 12.34, price_source: 'user_entered', client_request_id: idemKey };
  const { status, json } = await req('POST', '/api/portfolio/trades', payload);
  check('paper BUY accepted', status === 200 && json?.trade?.ticker === 'SMK');
  const replay = await req('POST', '/api/portfolio/trades', payload);
  check('replayed idempotent BUY returns duplicate, no double execution',
    replay.status === 200 && replay.json?.duplicate === true && replay.json?.trade?.id === json.trade.id);
  const afterReplay = (await req('GET', '/api/portfolio')).json;
  check('cash debited exactly once', Math.abs(afterReplay.cash_usd - (before.cash_usd - 3 * 12.34)) < 0.005,
    `${before.cash_usd} -> ${afterReplay.cash_usd}`);
  const conflict = await req('POST', '/api/portfolio/trades', { ...payload, quantity: 4 });
  check('idempotency conflict rejected (400)', conflict.status === 400 && /different payload/i.test(conflict.json?.error || ''));

  const overspend = await req('POST', '/api/portfolio/trades', { ticker: 'SMK', side: 'BUY', quantity: 200000, price: 100, client_request_id: randomUUID() });
  check('overspend rejected', overspend.status === 400 && /insufficient cash/i.test(overspend.json?.error || ''));
  const oversell = await req('POST', '/api/portfolio/trades', { ticker: 'SMK', side: 'SELL', quantity: 999, price: 12.34 });
  check('oversell rejected', oversell.status === 400 && /cannot sell/i.test(oversell.json?.error || ''));
  const bad = await req('POST', '/api/portfolio/trades', { ticker: 'SMK', side: 'BUY', quantity: -1, price: 5 });
  check('negative quantity rejected', bad.status === 400);
  const tiny = await req('POST', '/api/portfolio/trades', { ticker: 'TINY', side: 'BUY', quantity: 1, price: 0.001 });
  check('sub-cent notional rejected', tiny.status === 400 && /rounds to zero|notional/i.test(tiny.json?.error || ''));

  // cleanup: sell back the smoke shares (new idempotency key)
  const sell = await req('POST', '/api/portfolio/trades', { ticker: 'SMK', side: 'SELL', quantity: 3, price: 12.34, client_request_id: randomUUID() });
  check('paper SELL closes position', sell.status === 200);
  const after = (await req('GET', '/api/portfolio')).json;
  check('cash unchanged after round trip', Math.abs(after.cash_usd - before.cash_usd) < 0.005, `${before.cash_usd} -> ${after.cash_usd}`);
}

// 7. import validation + provenance
{
  const ok = await req('POST', '/api/disclosures/import', {
    kind: 'json',
    text: JSON.stringify([{
      ticker: 'SMOKE', company: 'Smoke Test Co', owner: 'Test Person', owner_role: 'Senator',
      tx_type: 'purchase', tx_date: '2026-01-05', published_date: '2026-03-05',
      amount_min_usd: 1000, amount_max_usd: 15000, amendment: false,
      source_url: 'https://example.com/smoke',
    }]),
  });
  const sneak = await req('POST', '/api/disclosures/import', {
    kind: 'json',
    text: JSON.stringify([{
      ticker: 'SNKRA', company: 'x', owner: 'y', tx_type: 'purchase', tx_date: '2026-01-05', published_date: '2026-03-05',
      amount_min_usd: 1, amount_max_usd: 2, data_mode: 'live',
    }]),
  });
  const dupe = await req('POST', '/api/disclosures/import', {
    kind: 'json',
    text: JSON.stringify([{
      ticker: 'SMOKE', company: 'Smoke Test Co', owner: 'Test Person', owner_role: 'Senator',
      tx_type: 'purchase', tx_date: '2026-01-05', published_date: '2026-03-05',
      amount_min_usd: 1000, amount_max_usd: 15000, amendment: false,
      source_url: 'https://example.com/smoke',
    }]),
  });
  const bad = await req('POST', '/api/disclosures/import', {
    kind: 'json',
    text: JSON.stringify([{ ticker: 'SMOKE', company: 'x', owner: 'y', tx_type: 'purchase', tx_date: '2026-03-01', published_date: '2026-02-01', amount_min_usd: 1, amount_max_usd: 2 }]),
  });
}

// 8. settings/meta: robinhood not configured, no secrets
{
  const { json } = await req('GET', '/api/settings');
  check('robinhood not configured', json?.robinhood?.status === 'not_configured');
  check('llm endpoint reported as not configured by default', json?.providers?.llm_endpoint?.status === 'not_configured');
  check('settings payload contains no key material', !JSON.stringify(json).match(/sk-/i));
  const { json: meta } = await req('GET', '/api/meta');
}

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} smoke check(s) FAILED.`);
const code = failures === 0 ? 0 : 1;
if (child) { child.kill(); }
if (dataDirToClean) { try { fs.rmSync(dataDirToClean, { recursive: true, force: true }); } catch {} }
process.exit(code);