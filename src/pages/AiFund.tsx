import { useCallback, useEffect, useState } from 'react';
import { api, type AiFundView } from '../api';

const money = (n: number | null | undefined, sign = false): string => {
  if (typeof n !== 'number') return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign ? '+' : ''}$${s}`;
};

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

/**
 * The AI fund: the agent trades its own fake $10k on its own research.
 * Every execution price is a real delayed quote; sizing/caps/stops are code,
 * not model output. Closed trades feed one-line lessons injected into future
 * research — the visible "getting smarter" loop.
 */
export function AiFund({ onOpen }: { onOpen: (t: string) => void }) {
  const [fund, setFund] = useState<AiFundView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.fund().then(setFund).catch((e) => setError(String((e as Error).message ?? e)));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await api.runFund();
      setLastRun(r.ran_at);
      refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  const pnlColor = (n: number) => (n >= 0 ? 'pl-up' : 'pl-down');

  return (
    <div className="card" id="ai-fund">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="card-title">AI fund — the agent trades its own fake $10k</p>
        <button className="btn small teal" type="button" onClick={run} disabled={busy}>
          {busy ? 'Running…' : 'Run the fund'}
        </button>
      </div>

      {error && <div className="error-text">{error}</div>}
      {!fund && !error && <div className="empty-state">Loading fund…</div>}

      {fund && (
        <>
          <div className="track-stats">
            <div><span className="stat-label">Equity</span><span className="track-num">{money(fund.equity_usd)}</span></div>
            <div><span className="stat-label">Total P/L</span><span className={`track-num ${pnlColor(fund.pnl_usd)}`}>{money(fund.pnl_usd, true)}</span></div>
            <div><span className="stat-label">Realized</span><span className={`track-num ${pnlColor(fund.realized_pnl_usd)}`}>{money(fund.realized_pnl_usd, true)}</span></div>
            <div><span className="stat-label">Cash</span><span className="track-num">{money(fund.cash_usd)}</span></div>
            <div><span className="stat-label">Open</span><span className="track-num">{fund.positions.length}</span></div>
          </div>

          {fund.positions.length > 0 && (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Ticker</th><th className="num">Qty</th><th className="num">Avg cost</th><th className="num">Mark</th><th className="num">Value</th><th className="num">P/L</th><th className="num">Stop</th></tr></thead>
                <tbody>
                  {fund.positions.map((p) => (
                    <tr key={p.ticker} className="row-click" onClick={() => onOpen(p.ticker)}>
                      <td><span className="ticker-tag">{p.ticker}</span></td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">{money(p.avg_cost)}</td>
                      <td className="num">{money(p.mark)}</td>
                      <td className="num">{money(p.value_usd)}</td>
                      <td className={`num ${pnlColor(p.pnl_usd)}`}>{money(p.pnl_usd, true)}</td>
                      <td className="num">{p.stop ? money(p.stop) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {fund.trades.length > 0 && (
            <>
              <p className="card-title sub">Trade log</p>
              <div className="table-scroll">
                <table className="table">
                  <thead><tr><th>When</th><th>Ticker</th><th>Side</th><th className="num">Qty</th><th className="num">@</th><th>Why</th><th className="num">Result</th></tr></thead>
                  <tbody>
                    {fund.trades.slice(0, 15).map((t) => (
                      <tr key={t.id} className="row-click" onClick={() => onOpen(t.ticker)}>
                        <td>{t.executed_at.slice(5, 16).replace('T', ' ')}</td>
                        <td><span className="ticker-tag">{t.ticker}</span></td>
                        <td><span className={`badge ${t.side === 'buy' ? 'buy' : 'sell'}`}>{t.side.toUpperCase()}</span></td>
                        <td className="num">{t.quantity}</td>
                        <td className="num">{money(t.price)}</td>
                        <td className="muted" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.rationale}>{t.rationale}</td>
                        <td className={`num ${t.realized_pnl_usd !== undefined ? pnlColor(t.realized_pnl_usd) : ''}`}>
                          {t.realized_pnl_usd !== undefined ? `${money(t.realized_pnl_usd, true)} (${pct(t.pnl_pct)})` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {fund.lessons.length > 0 && (
            <>
              <p className="card-title sub">What it has learned (fed back into its research)</p>
              <ul className="tight-list">
                {fund.lessons.slice(0, 6).map((l) => (
                  <li key={l.id}><span className="ticker-tag">{l.ticker}</span> {l.lesson}</li>
                ))}
              </ul>
            </>
          )}

          <p className="provenance">
            Paper fund — fake money, no broker. Trades execute at real delayed quotes
            {lastRun ? ` · last run ${new Date(lastRun).toLocaleTimeString()}` : ''}
            {' · sizing is code (max 20%/name, 2% risk/trade), not the model'}
          </p>
        </>
      )}
    </div>
  );
}