#!/usr/bin/env node
// Fetch real congressional trade disclosures and convert them to Civicfolio's
// import format. This is a STAGING script, not a live connector: it writes a
// file you review, then you import it through the normal validated path.
//
//   node scripts/fetch-disclosures.mjs --days 90
//   node scripts/fetch-disclosures.mjs --days 90 --post   # also import it
//
// Provenance chain, stated plainly: transactions are parsed by lambdafin.com
// from House Clerk PTR filings. Every row keeps `ptrLink` — the official House
// PDF — as its source_url, so each record points back at the primary document.
// The upstream parse is a third party's work, not the Clerk's, and PTR PDFs are
// scans; treat any row as a pointer to the PDF, not as verified truth.
//
// Rows that cannot be represented honestly are SKIPPED, never guessed:
// no ticker, an unclassifiable transaction type, or a truncated amount range.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = 'https://www.lambdafin.com/api/congressional/recent';
const SERVER = process.env.CIVICFOLIO_URL || 'http://127.0.0.1:8787';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const days = Number(arg('days', '90'));
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(1);
}
const outPath = arg('out', path.join(os.homedir(), '.civicfolio', `import-${new Date().toISOString().slice(0, 10)}.json`));

// House PTR transaction types -> the three types Civicfolio stores.
// Anything not listed here is skipped rather than forced into a bucket.
const TX_TYPE = new Map([
  ['purchase', 'purchase'],
  ['sale (full)', 'sale'],
  ['sale (partial)', 'sale'],
  ['s (partial)', 'sale'],
  ['sale', 'sale'],
  ['exchange', 'exchange'],
]);

// "$1,001 - $15,000" -> [1001, 15000]. A truncated range like "$100,001 -"
// returns null: the real upper bound is unknown and inventing one would put a
// fabricated number in a financial record.
function parseAmountRange(raw) {
  if (typeof raw !== 'string') return null;
  const nums = raw.match(/\$[\d,]+/g);
  if (!nums || nums.length < 2) return null;
  const vals = nums.map((n) => Number(n.replace(/[^0-9]/g, '')));
  if (vals.length < 2 || vals.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  const [min, max] = [vals[0], vals[1]];
  return max >= min ? [min, max] : null;
}

function toRecord(t) {
  const symbol = typeof t.symbol === 'string' ? t.symbol.trim().toUpperCase() : '';
  if (!symbol) return { skip: 'no ticker (bond, fund, or private holding)' };
  if (!/^[A-Z]{1,10}$/.test(symbol)) return { skip: `ticker "${symbol}" is not 1-10 A-Z` };

  const txType = TX_TYPE.get(String(t.type ?? '').trim().toLowerCase());
  if (!txType) return { skip: `transaction type "${t.type}" cannot be classified` };

  const amounts = parseAmountRange(t.amount);
  if (!amounts) return { skip: `amount range "${t.amount}" is incomplete` };

  const txDate = t.transactionDate;
  const pubDate = t.disclosureDate;
  if (!txDate || !pubDate) return { skip: 'missing transaction or disclosure date' };
  // Civicfolio rejects a filing published before the trade it reports.
  if (pubDate < txDate) return { skip: `disclosure ${pubDate} precedes transaction ${txDate}` };

  const chamber = t.chamber === 'senate' ? 'Senator' : 'House member';
  const where = [t.party?.[0], t.state, t.district].filter(Boolean).join('-');
  // Ownership (Self/Spouse/Dependent Child/Joint) changes what a filing means,
  // so it is kept next to the role rather than dropped.
  const role = [where ? `${chamber} (${where})` : chamber, t.owner].filter(Boolean).join(' · ');

  return {
    record: {
      ticker: symbol,
      company: (t.assetDescription || symbol).slice(0, 200),
      owner: String(t.representative ?? 'Unknown filer').slice(0, 200),
      owner_role: role.slice(0, 100),
      tx_type: txType,
      tx_date: txDate,
      published_date: pubDate,
      amount_min_usd: amounts[0],
      amount_max_usd: amounts[1],
      amendment: false,
      source_name: 'House Clerk PTR (parsed by lambdafin.com)',
      source_url: typeof t.ptrLink === 'string' ? t.ptrLink : null,
      notes: [t.assetDescription, t.comment].filter(Boolean).join(' — ').slice(0, 500) || undefined,
    },
  };
}

async function main() {
  const url = `${API}?days=${days}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    console.error(`Upstream returned ${res.status}. Nothing written.`);
    process.exit(1);
  }
  const body = await res.json();
  const trades = Array.isArray(body?.trades) ? body.trades : [];
  if (trades.length === 0) {
    console.error('Upstream returned no trades. Nothing written.');
    process.exit(1);
  }

  const records = [];
  const skipped = new Map();
  for (const t of trades) {
    const out = toRecord(t);
    if (out.record) records.push(out.record);
    else skipped.set(out.skip, (skipped.get(out.skip) ?? 0) + 1);
  }

  console.log(`\n${trades.length} upstream rows -> ${records.length} importable, ${trades.length - records.length} skipped`);
  if (skipped.size) {
    console.log('\nSkipped, by reason:');
    for (const [reason, n] of [...skipped].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${reason}`);
    }
  }
  if (records.length === 0) {
    console.error('\nNothing importable. Nothing written.');
    process.exit(1);
  }

  const dates = records.map((r) => r.tx_date).sort();
  const withSource = records.filter((r) => r.source_url).length;
  console.log(`\nTransaction dates ${dates[0]} to ${dates[dates.length - 1]}`);
  console.log(`${withSource}/${records.length} rows link to their official House PDF`);
  console.log(`${new Set(records.map((r) => r.ticker)).size} distinct tickers, ${new Set(records.map((r) => r.owner)).size} distinct filers`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ disclosures: records }, null, 2), 'utf8');
  console.log(`\nWrote ${outPath}`);

  if (!hasFlag('post')) {
    console.log('\nReview it, then import via Disclosures -> Import data..., or re-run with --post.');
    return;
  }

  console.log(`\nPosting to ${SERVER} ...`);
  const imp = await fetch(`${SERVER}/api/disclosures/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SERVER },
    body: JSON.stringify({ kind: 'json', text: JSON.stringify({ disclosures: records }) }),
  });
  const report = await imp.json().catch(() => null);
  if (!imp.ok && imp.status !== 207) {
    console.error(`Import failed (${imp.status}):`, report?.error ?? '(no detail)');
    process.exit(1);
  }
  console.log(`Imported ${report?.imported_count ?? 0}; server skipped ${report?.report?.skipped ?? 0}.`);
  for (const e of (report?.report?.errors ?? []).slice(0, 10)) console.log(`  ${e.message}`);
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
