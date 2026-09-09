import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AiFundView, type AiFundRunView } from '../api';

const money = (n: number | null | undefined, sign = false): string => {
  if (typeof n !== 'number') return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : sign ? '+' : ''}$${s}`;
};

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

const timeShort = (iso: string | null | undefined): string =>
  iso ? iso.slice(5, 16).replace('T', ' ') : '—';

const STATUS_LABEL: Record<string, string> = {
  completed: 'completed',
  partial: 'partial — some sources failed',
  failed: 'failed',
  interrupted: 'interrupted (server restarted mid-run)',
  running: 'running…',
};

function RunRow({ run }: { run: AiFundRunView }) {
  const statusClass = run.status === 'completed' ? '' : run.status === 'running' ? 'muted' : 'error-text';
  return (
    <li key={run.id} style={{ marginBottom: 6 }}>
      <span className="muted">{timeShort(run.finished_at ?? run.started_at)}</span>{' '}
      <span className={`badge ${run.status === 'completed' ? 'buy' : run.status === 'partial' || run.status === 'running' ? 'hold-badge' : 'sell'}`}>{run.status}</span>{' '}
      <span className={statusClass}>
        {run.imported ? `imported: ${run.note ?? ''}` : run.actions.length > 0
          ? run.actions.map((a) => `${a.ticker === '-' ? 'scan' : a.ticker} ${a.action}`).join(', ').slice(0, 120)
          : 'no ticker actions'}
        {run.failures.length > 0 ? ` · ${run.failures.length} failure(s)` : ''}
        {run.marks_stale ? ' · marks stale' : ''}
      </span>
    </li>
  );
}

/**
 * The AI fund: the agent trades its own fake $10k on its own research.
 * Every execution price is a real delayed quote; sizing/caps/stops are code,
 * not model output. Closed trades feed one-line lessons injected into future
 * research — the visible "getting smarter" loop.
 *
 * This page READS status only. Refreshes poll /api/fund (read-only), never the
 * run loop. Trades happen ONLY through the explicit Run-the-fund button.
 */
export function AiFund({ onOpen }: { onOpen: (t: string) => void }) {
  const [fund, setFund] = useState<AiFundView | null>(null);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // prevents overlapping fetches
  const [lastRun, setLastRun] = useState<AiFundRunView | null>(null);
  const [lastManualRunId, setLastManualRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const f = await api.fund();
      setFund(f);
      if (f.last_run) setLastRun(f.last_run);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { inFlight.current = false; }
  }, []);

  useEffect(() => {
    void refresh();
    // Poll while visible: status only — never invokes models or trades.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, 45_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // When a manual run is executing, poll faster so the UI follows it.
  useEffect(() => {
    if (!fund?.running_run) return;
    const t = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(t);
  }, [fund?.running_run, refresh]);

  const run = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Idempotency key: a retry of this click returns the same run.
      const requestId = crypto.randomUUID?.() ?? `manual-${Date.now()}`;
      const r = await api.runFund(requestId);
      if (r.run_id) setLastManualRunId(r.run_id);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  const markRefresh = async () => {
    if (marking) return;
    setMarking(true); setError(null);
    try {
      await api.refreshFundMarks();
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setMarking(false); }
  };

  const pnlColor = (n: number) => (n >= 0 ? 'pl-up' : 'pl-down');
  const running = fund?.running_run ?? null;
  const statusLine = running
    ? `run ${running.id.slice(0, 8)} ${running.status} (${running.trigger})`
    : lastRun
      ? `last run ${STATUS_LABEL[lastRun.status] ?? lastRun.status} · ${timeShort(lastRun.finished_at ?? lastRun.started_at)} (${lastRun.trigger}${lastRun.imported ? ', imported' : ''})`
      : 'no runs recorded yet';

  return (
    <div className="card" id="ai-fund">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="card-title">AI fund — the agent trades its own fake $10k</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small" type="button" onClick={markRefresh} disabled={marking || busy} title="Refresh quote marks for held positions — never trades">
            {marking ? 'Refreshing…' : 'Refresh marks'}
          </button>
          <button className="btn small teal" type="button" onClick={run} disabled={busy || !!running}>
            {busy || running ? 'Running…' : 'Run the fund'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-text">
          {error} <button className="btn small" type="button" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {!fund && !error && <div className="empty-state">Loading fund…</div>}

      {fund && (
        <>
          <div className="track-stats">
            <div><span className="stat-label">Equity</span><span className="track-num">{money(fund.equity_usd)}</span></div>
            <div><span className="stat-label">Total P/L</span><span className={`track-num ${pnlColor(fund.pnl_usd)}`}>{money(fund.pnl_usd, true)}</span></div>
            <div><span className="stat-label">Realized</span><span className={`track-num ${pnlColor(fund.realized_pnl_usd)}`}>{money(fund.realized_pnl_usd, true)}</span></div>
            <div><span className="stat-label">Unrealized</span><span className={`track-num ${pnlColor(fund.unrealized_pnl_usd)}`}>{money(fund.unrealized_pnl_usd, true)}</span></div>
            <div><span className="stat-label">Cash</span><span className="track-num">{money(fund.cash_usd)}</span></div>
            <div><span className="stat-label">Open</span><span className="track-num">{fund.positions.length}</span></div>
          </div>

          <p className="provenance" style={{ marginTop: 4 }}>
            {statusLine}{fund.next_scheduled_run ? ` · next scheduled run ${new Date(fund.next_scheduled_run.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} local (clock-based, fires weekends/holidays too)` : ''}
          </p>
          {fund.marks_stale && (
            <div className="error-text">Some positions have stale or missing marks — equity is an estimate until quotes return. Use “Refresh marks” (never trades).</div>
          )}

          {fund.positions.length > 0 && (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>Ticker</th><th className="num">Qty</th><th className="num">Avg cost</th><th className="num">Mark</th><th className="num">Value</th><th className="num">P/L</th><th className="num">Stop</th><th>Mark freshness</th></tr></thead>
                <tbody>
                  {fund.positions.map((p) => (
                    <tr key={p.ticker} className="row-click" onClick={() => onOpen(p.ticker)}>
                      <td><span className="ticker-tag">{p.ticker}</span></td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">{money(p.avg_cost)}</td>
                      <td className="num">{money(p.mark)}{p.mark_freshness.stale ? ' ⚠' : ''}</td>
                      <td className="num">{money(p.value_usd)}</td>
                      <td className={`num ${pnlColor(p.pnl_usd)}`}>{money(p.pnl_usd, true)}</td>
                      <td className="num">{p.stop ? money(p.stop) : '—'}</td>
                      <td className="muted" style={{ fontSize: 11 }}>
                        {p.mark_freshness.price_known
                          ? (p.mark_freshness.carrying_at_cost
                            ? 'at cost — no quote yet'
                            : `quote ${p.mark_freshness.quote_as_of ? timeShort(p.mark_freshness.quote_as_of) : 'time ?'}${p.mark_freshness.stale ? ' · STALE' : ''}${p.mark_freshness.quote_source ? ` · ${p.mark_freshness.quote_source}` : ''}`)
                          : 'no mark — carried at cost'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {fund.runs.length > 0 && (
            <>
              <p className="card-title sub">Run history</p>
              <ul className="tight-list">
                {fund.runs.slice(0, 8).map((r) => <RunRow key={r.id} run={r} />)}
              </ul>
            </>
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
            {lastManualRunId ? ` · your last manual run ${lastManualRunId.slice(0, 8)}` : ''}
            {lastRun ? ` · last recorded run ${timeShort(lastRun.finished_at ?? lastRun.started_at)}` : ''}
            {' · sizing is code (max 20%/name, 2% risk/trade), not the model'}
          </p>
        </>
      )}
    </div>
  );
}