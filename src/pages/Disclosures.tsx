import { useEffect, useMemo, useState } from 'react';
import { api, fmtAmountRange, fmtDate, type Meta, type DisclosureRecord } from '../api';
import { ModeBadge } from '../App';

const EMPTY_FILTERS = { ticker: '', owner: '', tx_type: '', data_mode: '', amendment: '', published_from: '', published_to: '', q: '' };

export function DisclosuresPage({ meta }: { meta: Meta | null }) {
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [records, setRecords] = useState<DisclosureRecord[]>([]);
  const [count, setCount] = useState(0);
  const [selected, setSelected] = useState<DisclosureRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // import state
  const [importOpen, setImportOpen] = useState(false);
  const [importKind, setImportKind] = useState<'json' | 'csv'>('json');
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const query = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')), [filters]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      api.disclosures(query)
        .then((r) => { setRecords(r.records); setCount(r.count); setError(null); })
        .catch((e) => setError(String((e as Error).message ?? e)))
        .finally(() => setLoading(false));
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const runImport = async () => {
    setImportError(null);
    setImportResult(null);
    try {
      const res = await api.importDisclosures(importText, importKind);
      const rep = res.report;
      setImportResult(`Added ${rep.added}, skipped ${rep.skipped}` + (rep.errors.length ? ` — ${rep.errors.length} row(s) rejected:` : '') +
        (rep.errors.length ? '\n' + rep.errors.slice(0, 10).map((e) => `• ${e.message}`).join('\n') : ''));
      if (rep.added > 0) setImportText('');
    } catch (e) {
      setImportError(String((e as Error).message ?? e));
    }
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 className="page-title">Disclosures</h1>
          <p className="page-sub">
            {count} record{count === 1 ? '' : 's'}
            {meta && meta.counts.disclosures_demo > 0 && meta.counts.disclosures_imported > 0
              ? ` — ${meta.counts.disclosures_demo} demo / ${meta.counts.disclosures_imported} imported`
              : ''}
            <span className="sep">·</span>delayed filings, amount ranges, not current holdings
          </p>
        </div>
        <button className="btn" type="button" onClick={() => { setImportOpen(true); setImportResult(null); setImportError(null); }}>Import data…</button>
      </div>

      <div className="card">
        <div className="filter-bar">
          <div className="field">
            <label>Ticker</label>
            <input placeholder="e.g. ARRX" value={filters.ticker} onChange={(e) => setFilters({ ...filters, ticker: e.target.value })} style={{ textTransform: 'uppercase', width: 110 }} />
          </div>
          <div className="field">
            <label>Owner contains</label>
            <input placeholder="name…" value={filters.owner} onChange={(e) => setFilters({ ...filters, owner: e.target.value })} style={{ width: 150 }} />
          </div>
          <div className="field">
            <label>Type</label>
            <select value={filters.tx_type} onChange={(e) => setFilters({ ...filters, tx_type: e.target.value })}>
              <option value="">Any</option><option value="purchase">Purchase</option><option value="sale">Sale</option><option value="exchange">Exchange</option>
            </select>
          </div>
          <div className="field">
            <label>Data mode</label>
            <select value={filters.data_mode} onChange={(e) => setFilters({ ...filters, data_mode: e.target.value })}>
              <option value="">All</option><option value="demo">Demo</option><option value="imported">Imported</option>
            </select>
          </div>
          <div className="field">
            <label>Amended</label>
            <select value={filters.amendment} onChange={(e) => setFilters({ ...filters, amendment: e.target.value })}>
              <option value="">All</option><option value="true">Amendments only</option><option value="false">Originals only</option>
            </select>
          </div>
          <div className="field">
            <label>Published from</label>
            <input type="date" value={filters.published_from} onChange={(e) => setFilters({ ...filters, published_from: e.target.value })} />
          </div>
          <div className="field">
            <label>Published to</label>
            <input type="date" value={filters.published_to} onChange={(e) => setFilters({ ...filters, published_to: e.target.value })} />
          </div>
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label>Search</label>
            <input placeholder="free text…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn small" type="button" onClick={() => setFilters({ ...EMPTY_FILTERS })}>Clear</button>
          </div>
        </div>

        {error && <div className="error-text">{error}</div>}
        {loading && <div className="empty-state">Loading…</div>}
        {!loading && records.length === 0 && !error && (
          <div className="empty-state">No records match. Load demo data in Settings or import your own JSON/CSV.</div>
        )}
        {!loading && records.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th><th>Owner</th><th>Type</th><th>Transacted</th><th>Published</th>
                <th className="num">Amount range</th><th>Amend</th><th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => setSelected(r)}>
                  <td><span className="ticker-tag">{r.ticker}</span></td>
                  <td>{r.owner}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{r.owner_role}</div></td>
                  <td><span className={`badge ${r.tx_type}`}>{r.tx_type}</span></td>
                  <td>{fmtDate(r.tx_date_min)}{r.tx_date_max !== r.tx_date_min ? `–${fmtDate(r.tx_date_max).slice(5)}` : ''}</td>
                  <td>{fmtDate(r.published_date)}</td>
                  <td className="num">{fmtAmountRange(r.amount_min_usd, r.amount_max_usd)}</td>
                  <td>{r.amendment ? <span className="badge amend">yes</span> : <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                  <td><ModeBadge mode={r.data_mode} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <DisclosureDetail record={selected} onClose={() => setSelected(null)} />}
      {importOpen && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className="modal">
            <h3>Import disclosure data</h3>
            <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
              Paste user-supplied data. Validated server-side; invalid rows are rejected with reasons. Max 5MB, 5000 records.
            </p>
            <div className="form-row">
              <div className="field">
                <label>Format</label>
                <select value={importKind} onChange={(e) => setImportKind(e.target.value as 'json' | 'csv')}>
                  <option value="json">JSON (array or {"{disclosures: […]}"})</option>
                  <option value="csv">CSV (header row required)</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label>File content</label>
              <textarea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={importKind === 'json' ? '[{"ticker":"EXAMPLE","company":"Co","owner":"Person","owner_role":"Senator","tx_type":"purchase","tx_date":"2026-01-15","published_date":"2026-03-01","amount_min_usd":1000,"amount_max_usd":15000,"amendment":false,"source_url":"https://…"}]' : 'ticker,company,owner,owner_role,tx_type,tx_date,published_date,amount_min_usd,amount_max_usd,amendment,source_url'} />
              <span className="hint">Required fields: ticker, company, owner, tx_type (purchase|sale|exchange), published_date (≥ transaction date), amount_min_usd ≤ amount_max_usd. Optional: owner_role, tx_date_min/max, amendment, amendment_of, source_name, source_url, notes. See README for the full schema.</span>
            </div>
            {importResult && <div className="ok-text" style={{ whiteSpace: 'pre-wrap' }}>{importResult}</div>}
            {importError && <div className="error-text">{importError}</div>}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setImportOpen(false)}>Close</button>
              <button className="btn primary" type="button" disabled={!importText.trim()} onClick={runImport}>Validate &amp; import</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DisclosureDetail({ record, onClose }: { record: DisclosureRecord; onClose: () => void }) {
  const lagDays = Math.round((Date.parse(record.published_date + 'T00:00:00Z') - Date.parse(record.tx_date_max + 'T00:00:00Z')) / 86400000);
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3><span className="ticker-tag" style={{ fontSize: 15 }}>{record.ticker}</span> — {record.company}</h3>
          <button className="btn small" type="button" onClick={onClose}>Close</button>
        </div>
        <div className="kv">
          <span className="k">Record ID</span><span className="v"><code>{record.id}</code></span>
          <span className="k">Owner</span><span className="v">{record.owner} <span style={{ color: 'var(--text-faint)' }}>({record.owner_role})</span></span>
          <span className="k">Transaction type</span><span className="v"><span className={`badge ${record.tx_type}`}>{record.tx_type}</span></span>
          <span className="k">Transaction date</span><span className="v">{fmtDate(record.tx_date_min)}{record.tx_date_max !== record.tx_date_min ? ` to ${fmtDate(record.tx_date_max)}` : ''} <span style={{ color: 'var(--text-faint)' }}>(as filed — may be a range)</span></span>
          <span className="k">Publication date</span><span className="v">{fmtDate(record.published_date)} <span style={{ color: 'var(--text-faint)' }}>({lagDays} days after transaction)</span></span>
          <span className="k">Amount range</span><span className="v">{fmtAmountRange(record.amount_min_usd, record.amount_max_usd)} <span style={{ color: 'var(--text-faint)' }}>(filed range, not exact)</span></span>
          <span className="k">Amendment</span><span className="v">{record.amendment ? <span className="badge amend">amendment{record.amendment_of ? ` of ${record.amendment_of}` : ''}</span> : 'original filing'}</span>
          <span className="k">Data mode</span><span className="v"><ModeBadge mode={record.data_mode} /></span>
          <span className="k">Source</span>
          <span className="v">
            {record.source_url
              ? <a href={record.source_url} target="_blank" rel="noreferrer">{record.source_name || record.source_url}</a>
              : `${record.source_name} (no external link — ${record.data_mode === 'demo' ? 'synthetic record' : 'no URL supplied'})`}
          </span>
          {record.notes && (<><span className="k">Notes</span><span className="v">{record.notes}</span></>)}
        </div>
        <div className="provenance">
          <b>Limitations:</b> political disclosure filings arrive weeks-to-months after transactions; amounts are filed ranges;
          reported transactions are not complete current holdings. {record.data_mode === 'demo' && 'This record is synthetic demo data — the owner is fictional and it must not be attributed to any real person.'}
          {record.data_mode === 'imported' && 'Provenance comes from the import source; verify the primary link before relying on it.'}
        </div>
      </div>
    </div>
  );
}