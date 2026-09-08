import { useEffect, useState } from 'react';
import { api, type ScoredVerdict, type TrackRecordSummary } from '../api';

const money = (n: number | null | undefined): string =>
  typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

const VERDICT_SHORT: Record<string, string> = {
  strong_buy: 'S.BUY', buy: 'BUY', hold: 'HOLD', avoid: 'AVOID', unclear: 'UNCLEAR',
};

/**
 * Scored verdict history: every AI call with the price it was made at, what
 * the market did since, and whether the directional call was right. This is
 * how the advisor's advice becomes accountable.
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
      <p className="card-title">Track record — was the advice any good?</p>

      {error && <div className="error-text">{error}</div>}
      {!error && entries.length === 0 && (
        <div className="empty-state">
          No verdicts yet. Run <b>Research with AI</b> on a ticker and every call lands here with the price it was made at.
        </div>
      )}

      {summary && summary.scored > 0 && (
        <div className="track-stats">
          <div><span className="stat-label">Directional calls</span><span className="track-num">{summary.scored}</span></div>
          <div><span className="stat-label">Right</span><span className="track-num" style={{ color: 'var(--green)' }}>{summary.correct}</span></div>
          <div><span className="stat-label">Wrong</span><span className="track-num" style={{ color: 'var(--red)' }}>{summary.wrong}</span></div>
          <div><span className="stat-label">Hit rate</span><span className="track-num">{summary.hit_rate !== null ? `${summary.hit_rate}%` : '—'}</span></div>
          <div><span className="stat-label">Avg move since call</span><span className="track-num">{summary.avg_change_pct !== null ? `${summary.avg_change_pct >= 0 ? '+' : ''}${summary.avg_change_pct}%` : '—'}</span></div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Ticker</th><th>Call</th>
                <th className="num">@ price</th><th className="num">Now</th>
                <th className="num">Since call</th><th className="num">Age</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 50).map((s) => (
                <tr key={s.id} className="row-click" onClick={() => onOpen(s.ticker)}>
                  <td>{s.created_at.slice(0, 10)}</td>
                  <td><span className="ticker-tag">{s.ticker}</span></td>
                  <td><span className={`badge ${s.verdict === 'avoid' ? 'sell' : s.verdict.includes('buy') ? 'buy' : 'neutral'}`}>{VERDICT_SHORT[s.verdict] ?? s.verdict}</span></td>
                  <td className="num">{money(s.price_at_call)}</td>
                  <td className="num">{money(s.price_now)}</td>
                  <td className={`num ${(s.change_pct ?? 0) >= 0 ? 'pl-up' : 'pl-down'}`}>{pct(s.change_pct)}</td>
                  <td className="num">{s.elapsed_days === 0 ? 'today' : `${s.elapsed_days}d`}</td>
                  <td>
                    {s.outcome === 'un_scored'
                      ? <span className="muted">{s.direction === 'neutral' ? 'no direction' : 'no quote'}</span>
                      : <span className={`badge ${s.outcome === 'correct' ? 'buy' : s.outcome === 'wrong' ? 'sell' : 'neutral'}`}>{s.outcome}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > 0 && (
        <p className="provenance">
          Scored against the CURRENT delayed quote — older calls may span days of market movement, not just the call's quality.
          HOLD and UNCLEAR calls are shown but not scored, since no direction was claimed.
        </p>
      )}
    </div>
  );
}