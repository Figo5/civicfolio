// Shared validation helpers. Everything crossing the API boundary is treated
// as untrusted. Finite numbers only — NaN/Infinity are rejected everywhere.

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isNonEmptyString(v: unknown, maxLen = 500): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  if (Number.isNaN(t)) return false;
  // round-trip check rejects e.g. 2026-02-31
  return new Date(t).toISOString().slice(0, 10) === v;
}

export function isIsoDateTime(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 10) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t);
}

export function isValidUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2000) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const TICKER_RE = /^[A-Z]{1,10}$/;

export function normalizeTicker(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

// Sanitize free text that will be stored / echoed back: strip control chars,
// cap length. This is defense-in-depth; we never execute content from data.
export function cleanText(v: unknown, maxLen = 500): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}