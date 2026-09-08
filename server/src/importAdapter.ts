import type { DisclosureRecord, ImportReport } from './types.js';
import { isFiniteNumber, isIsoDate, normalizeTicker, isValidUrl, cleanText } from './validate.js';
import { randomUUID } from 'node:crypto';

// Real-data import adapter: user-supplied JSON/CSV, strictly validated.
// Schema is documented in README.md ("Importing real data").
// Rejected rows never silently pass: every skip is reported.
//
// Security constraints: caller supplies file CONTENT (already read by the
// route with a size cap); we never accept arbitrary filesystem paths here.
// Provenance is enforced server-side: pasted imports are ALWAYS data_mode
// 'imported' regardless of what the payload claims ('live' is never accepted
// from user input).

const TX_TYPES = new Set(['purchase', 'sale', 'exchange']);

export interface RawRecordInput {
  ticker?: unknown;
  company?: unknown;
  owner?: unknown;
  owner_role?: unknown;
  tx_type?: unknown;
  tx_date?: unknown; // single date OR
  tx_date_min?: unknown; // + tx_date_max for a range
  tx_date_max?: unknown;
  published_date?: unknown;
  amount_min_usd?: unknown;
  amount_max_usd?: unknown;
  amendment?: unknown;
  amendment_of?: unknown;
  source_name?: unknown;
  source_url?: unknown;
  notes?: unknown;
  // NOTE: data_mode is deliberately NOT accepted from input. Imports are
  // always 'imported'; 'live' is reserved for a verified adapter that does
  // not exist yet.
  [k: string]: unknown;
}

export type ImportResult = { report: ImportReport; records: DisclosureRecord[] };

function fail(errors: { row: number; message: string }[]): ImportResult {
  return { report: { ok: false, added: 0, skipped: 0, errors, data_mode: 'imported' }, records: [] };
}

function makeRecord(raw: RawRecordInput, idx: number, idPrefix: string): { record?: DisclosureRecord; error?: string } {
  const row = idx + 1;
  const ticker = normalizeTicker(raw.ticker);
  if (!ticker) return { error: `ticker missing or invalid (1-10 uppercase letters)` };

  const company = cleanText(raw.company, 200);
  if (!company) return { error: `company missing` };

  const owner = cleanText(raw.owner, 200);
  if (!owner) return { error: `owner missing` };

  const ownerRole = cleanText(raw.owner_role, 100) || 'unknown';

  const txType = typeof raw.tx_type === 'string' ? raw.tx_type.toLowerCase().trim() : '';
  if (!TX_TYPES.has(txType)) return { error: `tx_type must be purchase|sale|exchange` };

  let txMin: string, txMax: string;
  if (raw.tx_date !== undefined && raw.tx_date !== null && String(raw.tx_date).trim() !== '') {
    if (!isIsoDate(raw.tx_date)) return { error: `tx_date must be YYYY-MM-DD` };
    txMin = txMax = raw.tx_date;
  } else {
    if (!isIsoDate(raw.tx_date_min) || !isIsoDate(raw.tx_date_max)) {
      return { error: `tx_date_min/tx_date_max must be YYYY-MM-DD (or use tx_date)` };
    }
    if (raw.tx_date_min > raw.tx_date_max) return { error: `tx_date_min after tx_date_max` };
    txMin = raw.tx_date_min;
    txMax = raw.tx_date_max;
  }

  if (!isIsoDate(raw.published_date)) return { error: `published_date must be YYYY-MM-DD` };
  if (raw.published_date < txMax) {
    return { error: `published_date (${raw.published_date}) precedes last transaction date (${txMax})` };
  }

  const aMin = raw.amount_min_usd, aMax = raw.amount_max_usd;
  if (!isFiniteNumber(aMin) || !isFiniteNumber(aMax)) return { error: `amount_min_usd/amount_max_usd must be finite numbers` };
  if ((aMin as number) <= 0 || (aMax as number) <= 0) return { error: `amounts must be positive` };
  if ((aMin as number) > (aMax as number)) return { error: `amount_min_usd exceeds amount_max_usd` };

  const amendment = raw.amendment === true || raw.amendment === 'true' || raw.amendment === 'TRUE' || raw.amendment === 1 || raw.amendment === '1';

  let sourceUrl: string | null = null;
  if (raw.source_url !== undefined && raw.source_url !== null && String(raw.source_url).trim() !== '') {
    if (!isValidUrl(raw.source_url)) return { error: `source_url must be an http(s) URL` };
    sourceUrl = String(raw.source_url);
  }

  let sourceName = cleanText(raw.source_name, 200);
  if (!sourceName) sourceName = sourceUrl ? 'Primary source (imported)' : 'User import (no source URL provided)';

  const record: DisclosureRecord = {
    id: `${idPrefix}-${randomUUID()}`,
    ticker,
    company,
    owner,
    owner_role: ownerRole,
    tx_type: txType as DisclosureRecord['tx_type'],
    tx_date_min: txMin,
    tx_date_max: txMax,
    published_date: raw.published_date,
    amount_min_usd: aMin as number,
    amount_max_usd: aMax as number,
    amendment,
    amendment_of: amendment && raw.amendment_of ? cleanText(raw.amendment_of, 100) : undefined,
    source_name: sourceName,
    source_url: sourceUrl,
    data_mode: 'imported', // server-enforced provenance
    notes: cleanText(raw.notes, 500) || undefined,
  };
  return { record };
}

function rowErr(rows: { row: number; message: string }[], row: number, message: string): void {
  rows.push({ row, message: `row ${row}: ${message}` });
}

export function parseJsonImport(text: string, idPrefix: string): ImportResult {
  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch (e) {
    return fail([{ row: 0, message: `Invalid JSON: ${(e as Error).message}` }]);
  }
  if (Array.isArray(items)) {
    // bare array — fine
  } else if (items && typeof items === 'object' && Array.isArray((items as { disclosures?: unknown }).disclosures)) {
    items = (items as { disclosures: unknown[] }).disclosures;
  } else {
    return fail([{ row: 0, message: 'JSON must be an array of records or {"disclosures": [...]}' }]);
  }
  const arr = items as unknown[];
  if (arr.length > 5000) return fail([{ row: 0, message: 'JSON import limited to 5000 records' }]);

  const errors: { row: number; message: string }[] = [];
  const records: DisclosureRecord[] = [];
  arr.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rowErr(errors, i + 1, 'not an object');
      return;
    }
    const res = makeRecord(raw as RawRecordInput, i, idPrefix);
    if (res.record) records.push(res.record);
    else if (res.error) rowErr(errors, i + 1, res.error);
  });
  return {
    report: { ok: errors.length === 0, added: records.length, skipped: arr.length - records.length, errors, data_mode: 'imported' },
    records,
  };
}

function splitCsvLine(line: string): string[] {
  // RFC4180-ish splitter with quotes.
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const CSV_COLUMNS = ['ticker', 'company', 'owner', 'owner_role', 'tx_type', 'tx_date', 'tx_date_min', 'tx_date_max', 'published_date', 'amount_min_usd', 'amount_max_usd', 'amendment', 'amendment_of', 'source_name', 'source_url', 'notes'];

// Parse CSV honoring quoted fields that may span multiple lines (RFC4180).
// Returns rows of raw field strings; malformed quoting produces an error.
export function parseCsvRows(text: string): { rows: string[][]; error?: string } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { cur.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      cur.push(field); field = '';
      rows.push(cur); cur = [];
      i++; continue;
    }
    field += ch; i++;
  }
  if (inQuotes) return { rows: [], error: 'unterminated quoted field (missing closing quote)' };
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  // drop fully empty trailing rows
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== '')) };
}

export function parseCsvImport(text: string, idPrefix: string): ImportResult {
  const parsed = parseCsvRows(text);
  if (parsed.error) return fail([{ row: 0, message: `CSV error: ${parsed.error}` }]);
  const allRows = parsed.rows;
  if (allRows.length < 2) {
    return fail([{ row: 0, message: 'CSV needs a header row and at least one data row' }]);
  }
  if (allRows.length - 1 > 5000) {
    return fail([{ row: 0, message: 'CSV import limited to 5000 records' }]);
  }
  const header = allRows[0].map((h) => h.trim().toLowerCase());
  const missing = ['ticker', 'company', 'owner', 'tx_type', 'published_date', 'amount_min_usd', 'amount_max_usd'].filter((c) => !header.includes(c));
  if (missing.length) {
    return fail([{ row: 0, message: `CSV missing required columns: ${missing.join(', ')}` }]);
  }

  const errors: { row: number; message: string }[] = [];
  const records: DisclosureRecord[] = [];
  for (let i = 1; i < allRows.length; i++) {
    const vals = allRows[i];
    const raw: Record<string, unknown> = {};
    header.forEach((h, j) => {
      if (CSV_COLUMNS.includes(h)) raw[h] = vals[j] ?? '';
    });
    for (const k of ['amount_min_usd', 'amount_max_usd']) {
      if (typeof raw[k] === 'string') {
        raw[k] = Number(String(raw[k]).replace(/[$,]/g, '').trim());
      }
    }
    const res = makeRecord(raw as RawRecordInput, i - 1, idPrefix);
    if (res.record) records.push(res.record);
    else if (res.error) rowErr(errors, i + 1, res.error);
  }
  return {
    report: { ok: errors.length === 0, added: records.length, skipped: allRows.length - 1 - records.length, errors, data_mode: 'imported' },
    records,
  };
}

// Detect duplicates among candidate records and against existing store rows.
// Key: ticker + owner + tx_date_min + tx_date_max + amount range + amendment.
export function dedupeRecords(candidates: DisclosureRecord[], existing: DisclosureRecord[]): { unique: DisclosureRecord[]; duplicates: DisclosureRecord[] } {
  const keyOf = (r: DisclosureRecord) =>
    JSON.stringify([r.ticker, r.owner.toLowerCase(), r.tx_date_min, r.tx_date_max, r.amount_min_usd, r.amount_max_usd, r.amendment]);
  const seen = new Set(existing.map(keyOf));
  const unique: DisclosureRecord[] = [];
  const duplicates: DisclosureRecord[] = [];
  for (const r of candidates) {
    const k = keyOf(r);
    if (seen.has(k)) duplicates.push(r);
    else { seen.add(k); unique.push(r); }
  }
  return { unique, duplicates };
}

export function runImport(text: string, kind: 'json' | 'csv', idPrefix: string): ImportResult {
  return kind === 'json' ? parseJsonImport(text, idPrefix) : parseCsvImport(text, idPrefix);
}