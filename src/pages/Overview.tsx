import { useEffect, useState } from 'react';
import { api, fmtUsd, fmtAmountRange, fmtDate, type Meta, type DisclosureRecord, type PortfolioSummary } from '../api';
import { Stat, ModeBadge } from '../App';

interface OverviewData {
  portfolio: PortfolioSummary | null;
  recentDisclosures: DisclosureRecord[];
  ideas: { id: string; ticker: string; company: string; thesis: string; status: string }[];
  watchlist: { id: string; ticker: string; company: string; thesis: string }[];
}

export function OverviewPage({ onNavigate, refreshMeta }: { meta: Meta | null; onNavigate: (p: import('../shell').Page) => void; refreshMeta: () => Promise<void> | void }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newIdea, setNewIdea] = useState({ ticker: '', thesis: '' });
  const [newWatch, setNewWatch] = useState({ ticker: '', thesis: '' });
  const [formError, setFormError] = useState<string | null>(null);

  const loadAll = () => {
    Promise.all([
      api.portfolio().catch(() => null),
      api.disclosures({}).then((r) => r.records.slice(0, 6)),
      fetch('/api/ideas').catch(() => null),
    ]).catch(() => null);
    // ideas/watchlist come via dedicated endpoints below
    void loadLists();
  };

  const [lists, setLists] = useState<{ ideas: OverviewData['ideas']; watchlist: OverviewData['watchlist'] }>({ ideas: [], watchlist: [] });

  const loadLists = async () => {
    // The backend stores ideas/watchlist inside the main data file; simplest
    // reviewable access is via meta + dedicated list endpoints. We fetch them
    // directly here.
    try {
      const [ideasRes, watchRes, portRes, discRes] = await Promise.all([
        fetch('/api/ideas').then((r) => (r.ok ? r.json() : { ideas: [] })),
        fetch('/api/watchlist').then((r) => (r.ok ? r.json() : { items: [] })),
        api.portfolio(),
        api.disclosures({}),
      ]);
      setLists({ ideas: ideasRes.ideas ?? [], watchlist: watchRes.items ?? [] });
      setData({
        portfolio: portRes,
        recentDisclosures: discRes.records.slice(0, 6),
        ideas: ideasRes.ideas ?? [],
        watchlist: watchRes.items ?? [],
      });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => { void loadAll(); }, []);

  const addIdea = async () => {
    setFormError(null);
    try {
      await api.addIdea(newIdea.ticker, newIdea.thesis);
      setNewIdea({ ticker: '', thesis: '' });
      await loadLists();
      void refreshMeta();
    } catch (e) {
      setFormError(String((e as Error).message ?? e));
    }
  };

  const addWatch = async () => {
    setFormError(null);
    try {
      await api.addWatch(newWatch.ticker, newWatch.thesis);
      setNewWatch({ ticker: '', thesis: '' });
      await loadLists();
      void refreshMeta();
    } catch (e) {
      setFormError(String((e as Error).message ?? e));
    }
  };

  const removeIdea = async (id: string) => { await api.removeIdea(id); await loadLists(); void refreshMeta(); };
  const removeWatch = async (id: string) => { await api.removeWatch(id); await loadLists(); void refreshMeta(); };

  const port = data?.portfolio ?? null;
  const total = port ? port.account_cost_usd : 0;
  const alloc = port && total > 0
    ? [{ label: 'Cash', value: port.cash_usd, color: '#2dd4bf' },
       ...port.positions.map((p, i) => ({ label: p.ticker, value: p.cost_basis_usd, color: ['#4f8ff7', '#f5b350', '#9a7ef7', '#f2726f'][i % 4] }))]
    : [];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Overview</h1>
        <p className="page-sub">Local research snapshot — paper trading only, no live market data.</p>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="grid-3">
        <div className="card">
          <p className="card-title">Paper Portfolio</p>
          <Stat label="Account (cost basis)" value={port ? fmtUsd(port.account_cost_usd) : '—'} sub={port ? `${port.trade_count} paper trades` : 'loading…'} />
          <div className="allocation-bar">
            {alloc.map((a, i) => (
              <div key={i} className="allocation-seg" style={{ width: `${total > 0 ? (a.value / total) * 100 : 0}%`, background: a.color }} />
            ))}
          </div>
          <div className="allocation-legend">
            {alloc.map((a, i) => (
              <span key={i}><span className="legend-dot" style={{ background: a.color }} />{a.label} {total > 0 ? `${((a.value / total) * 100).toFixed(0)}%` : ''}</span>
            ))}
            {alloc.length === 0 && <span>No positions yet</span>}
          </div>
        </div>

        <div className="card">
          <p className="card-title">Tracked Ideas</p>
          {lists.ideas.length === 0 && <div className="empty-state">No ideas tracked yet</div>}
          {lists.ideas.slice(0, 4).map((i) => (
            <div key={i.id} style={{ marginBottom: 10 }}>
              <span className="ticker-tag">{i.ticker}</span> <span className="badge neutral">{i.status}</span>
              <button className="btn small danger" type="button" style={{ float: 'right' }} onClick={() => removeIdea(i.id)} aria-label={`Remove idea ${i.ticker}`}>Remove</button>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{i.thesis}</div>
            </div>
          ))}
          <div className="form-row">
            <div className="field">
              <input placeholder="TICKER" value={newIdea.ticker} onChange={(e) => setNewIdea({ ...newIdea, ticker: e.target.value })} style={{ textTransform: 'uppercase' }} />
            </div>
          </div>
          <div className="field">
            <input placeholder="Thesis (one line)" value={newIdea.thesis} onChange={(e) => setNewIdea({ ...newIdea, thesis: e.target.value })} />
          </div>
          <button className="btn small teal" type="button" onClick={addIdea}>Add idea</button>
        </div>

        <div className="card">
          <p className="card-title">Watchlist</p>
          {lists.watchlist.length === 0 && <div className="empty-state">Watchlist is empty</div>}
          {lists.watchlist.slice(0, 4).map((w) => (
            <div key={w.id} style={{ marginBottom: 10 }}>
              <span className="ticker-tag">{w.ticker}</span>
              <button className="btn small danger" type="button" style={{ float: 'right' }} onClick={() => removeWatch(w.id)} aria-label={`Remove ${w.ticker} from watchlist`}>Remove</button>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{w.thesis}</div>
            </div>
          ))}
          <div className="form-row">
            <div className="field">
              <input placeholder="TICKER" value={newWatch.ticker} onChange={(e) => setNewWatch({ ...newWatch, ticker: e.target.value })} style={{ textTransform: 'uppercase' }} />
            </div>
          </div>
          <div className="field">
            <input placeholder="Why watching (one line)" value={newWatch.thesis} onChange={(e) => setNewWatch({ ...newWatch, thesis: e.target.value })} />
          </div>
          <button className="btn small teal" type="button" onClick={addWatch}>Add to watchlist</button>
          {formError && <div className="error-text">{formError}</div>}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <p className="card-title">Recent Disclosed Activity</p>
          <button className="btn small" type="button" onClick={() => onNavigate('disclosures')}>All disclosures →</button>
        </div>
        {(data?.recentDisclosures ?? []).length === 0 && (
          <div className="empty-state">
            No disclosure records. Load demo data in Settings or import your own (Disclosures page).
          </div>
        )}
        {(data?.recentDisclosures ?? []).length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th><th>Owner</th><th>Type</th><th>Transacted</th><th>Published</th><th className="num">Amount range</th><th>Mode</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recentDisclosures ?? []).map((r) => (
                <tr key={r.id}>
                  <td><span className="ticker-tag">{r.ticker}</span></td>
                  <td>{r.owner}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{r.owner_role}</div></td>
                  <td><span className={`badge ${r.tx_type}`}>{r.tx_type}</span></td>
                  <td>{fmtDate(r.tx_date_min)}{r.tx_date_max !== r.tx_date_min ? `–${fmtDate(r.tx_date_max).slice(5)}` : ''}</td>
                  <td>{fmtDate(r.published_date)}</td>
                  <td className="num">{fmtAmountRange(r.amount_min_usd, r.amount_max_usd)}</td>
                  <td><ModeBadge mode={r.data_mode} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">
          Disclosures are delayed, amounts are ranges, and reported trades are not complete holdings. Transaction dates differ from publication dates.
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <p className="card-title">Paper Portfolio Positions</p>
          <button className="btn small" type="button" onClick={() => onNavigate('portfolio')}>Trade →</button>
        </div>
        {!port || port.positions.length === 0 ? (
          <div className="empty-state">No open paper positions.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Ticker</th><th className="num">Quantity</th><th className="num">Avg cost</th><th className="num">Cost basis</th></tr></thead>
            <tbody>
              {port.positions.map((p) => (
                <tr key={p.ticker}>
                  <td><span className="ticker-tag">{p.ticker}</span></td>
                  <td className="num">{p.quantity}</td>
                  <td className="num">{fmtUsd(p.avg_cost)}</td>
                  <td className="num">{fmtUsd(p.cost_basis_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="note">Cost basis only — Civicfolio stores no market prices, so no market value or P/L is shown.</div>
      </div>
    </div>
  );
}