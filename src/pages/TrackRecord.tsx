import { useEffect, useState } from 'react';
import { api, type ScoredVerdict, type TrackRecordSummary } from '../api';

const money = (n: number | null | undefined): string =>
  typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

const VERDICT_SHORT: Record<string, string> = {
  strong_buy: 'BULLISH', buy: 'BULLISH', hold: 'NEUTRAL', avoid: 'BEARISH', unclear: 'UNCLEAR',
};

/**
 * Research journal: what the app observed, when, from what model, with what
 * evidence — plus a descriptive price change since the observation.
 *
 * This is explicitly NOT strategy performance. Whether a call was "right"
 * cannot be graded from one price point, so there is no hit rate and no
 * correct/wrong outcome anywhere on this page. AVOID entries show the price
 * change since the call, described as exactly that — never "profitable short",
 * never a realized return, never a holding period promoted to a strategy.
 */
export function TrackRecord({ onOpen }: { onOpen: (t: string) => void }) {
  const [entries, setEntries] = useState<ScoredVerdict[]>([]);
  const [summary, setSummary] = useState<TrackRecordSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.verdictLogScored()
      .then((r) => { setEntries(r.entries); setSummary(r.summary); })
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, []);

  return (
    <div className="card" id="track-record">
      <p className="card-title">Research journal — observations, not performance</p>

      {error && <div className="error-text">{error}</div>}
      {!error && entries.length === 0 && (
        <div className="empty-state">
          No observations yet. Run <b>Research with AI</b> on a ticker and every research view lands here
          with the price and evidence it was based on.
        </div>
      )}

      {summary && (
        <div className="track-stats">
          <div><span className="stat-label">Observations</span><span className="track-num">{summary.total}</span></div>
          <div><span className="stat-label">With a price since</span><span className="track-num">{summary.measured}</span></div>
          <div><span className="stat-label">Unmeasured (no quote)</span><span className="track-num">{summary.unmeasured}</span></div>
          <div>
            <span className="stat-label">Avg price change since observation</span>
            <span className="track-num">{summary.avg_change_pct !== null ? `${summary.avg_change_pct >= 0 ? '+' : ''}${summary.avg_change_pct}%` : '—'}</span>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Ticker</th><th>Research view</th><th>Confidence</th>
                <th className="num">@ price</th><th className="num">Price now</th>
                <th className="num">Change since</th><th className="num">Age</th><th>Model</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 50).map((s) => (
                <tr key={s.id} className="row-click" onClick={() => onOpen(s.ticker)} title={s.data_notes ?? undefined}>
                  <td>{s.created_at.slice(0, 10)}</td>
                  <td><span className="ticker-tag">{s.ticker}</span></td>
                  <td>
                    <span className={`badge ${s.verdict === 'avoid' ? 'sell' : s.verdict.includes('buy') ? 'buy' : 'neutral'}`}>{VERDICT_SHORT[s.verdict] ?? s.verdict}</span>
                  </td>
                  <td className="num">{s.confidence}</td>
                  <td className="num">{money(s.price_at_call)}</td>
                  <td className="num">{money(s.price_now)}</td>
                  <td className={`num ${(s.change_pct ?? 0) >= 0 ? 'pl-up' : 'pl-down'}`}>{pct(s.change_pct)}</td>
                  <td className="num">{s.elapsed_days === 0 ? 'today' : `${s.elapsed_days}d`}</td>
                  <td className="num">{s.model}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > 0 && (
        <p className="provenance">
          Descriptive only — the change column spans whole-market movement, not the quality of the call.
        </p>
      )}
    </div>
  );
}