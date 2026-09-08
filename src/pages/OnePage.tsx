import { useEffect, useRef, useState } from 'react';
import { api, type Mover, type TickerSnapshot, type AgentVerdict, type InsightBoard, type ScoredIdea, type DataSourceStatus } from '../api';
import { TrackRecord } from './TrackRecord';
import { ExternalProcessingNotice } from '../shell';

const MOVER_TABS = [
  { kind: 'most_actives' as const, label: 'Most active' },
  { kind: 'day_gainers' as const, label: 'Gainers' },
  { kind: 'day_losers' as const, label: 'Losers' },
];

const VERDICT_STYLE: Record<AgentVerdict['verdict'], { label: string; color: string }> = {
  strong_buy: { label: 'BULLISH', color: 'var(--green)' },
  buy: { label: 'BULLISH', color: 'var(--green)' },
  hold: { label: 'NEUTRAL', color: 'var(--text-dim)' },
  avoid: { label: 'BEARISH', color: 'var(--red)' },
  unclear: { label: 'UNCLEAR', color: 'var(--text-dim)' },
};

const money = (n: number | null | undefined, dp = 2): string =>
  typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}` : '—';

const pct = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

const big = (n: number | null | undefined): string => {
  if (typeof n !== 'number') return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString('en-US')}`;
};

const daysUntil = (iso: string | null): string => {
  if (!iso) return '—';
  const days = Math.round((Date.parse(iso) - Date.now()) / 86400000);
  if (Number.isNaN(days)) return '—';
  if (days < 0) return iso.slice(0, 10);
  return days === 0 ? 'today' : `${days}d`;
};

const SOURCE_LABELS: Record<string, string> = {
  quote: 'Quote (delayed, unofficial)',
  price_history: 'Price history (daily closes)',
  news: 'Headlines',
  fundamentals: 'SEC filed fundamentals (as-filed)',
  web_search: 'Web search',
};

/** Per-source availability row: what answered, and the source's own timestamp. */
function SourceAvail({ s }: { s: DataSourceStatus }) {
  return (
    <li>
      {s.available ? '✓' : '✗'}{' '}
      <b>{s.available === true ? 'available' : 'unavailable'}</b>
      {s.as_of ? ` · as of ${s.as_of}` : ' · timestamp unknown'}
      {s.note ? ` — ${s.note}` : ''}
    </li>
  );
}

/** Where price sits in its 52-week range. */
function RangeBar({ position }: { position: number | null }) {
  if (position === null) return <span className="muted">—</span>;
  return (
    <span className="range-bar" title={`${Math.round(position * 100)}% of 52-week range`}>
      <span className="range-fill" style={{ width: `${Math.max(2, Math.min(100, position * 100))}%` }} />
    </span>
  );
}

function LevelRow({ label, value, check }: {
  label: string;
  value: string | null;
  check?: { grounded: boolean; nearest_anchor: string | null; anchor_value: number | null; drift_pct: number | null };
}) {
  if (!value) return null;
  return (
    <div className="level-row">
      <span className="level-label">{label}</span>
      <span className="level-value">{value}</span>
      {check && (check.grounded
        ? <span className="badge ok" title={`matches ${check.nearest_anchor} = ${check.anchor_value} — an anchor match, not a validated prediction`}>anchor match</span>
        : <span className="badge warn" title={`Nearest real level is ${check.nearest_anchor} = ${check.anchor_value}, ${check.drift_pct}% away`}>unsupported</span>
      )}
    </div>
  );
}

function TickerDetail({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [snap, setSnap] = useState<TickerSnapshot | null>(null);
  const [verdict, setVerdict] = useState<AgentVerdict | null>(null);
  const [dataSources, setDataSources] = useState<Record<string, DataSourceStatus> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Guards late responses: only the research run started for THIS ticker may
  // render its verdict into this view.
  const reqRef = useRef(0);

  useEffect(() => {
    setSnap(null); setVerdict(null); setErr(null); setDataSources(null);
    const id = ++reqRef.current;
    api.snapshot(ticker)
      .then((s) => { if (reqRef.current === id) setSnap(s); })
      .catch((e) => { if (reqRef.current === id) setErr(String((e as Error).message ?? e)); });
    return () => { reqRef.current++; }; // unmount/reticker invalidates in-flight work
  }, [ticker]);

  const runResearch = async () => {
    const id = reqRef.current;
    setBusy(true); setErr(null);
    try {
      const r = await api.research(ticker);
      if (reqRef.current === id) {
        setVerdict(r.verdict);
        setDataSources(r.data_sources ?? null);
      }
    } catch (e) {
      if (reqRef.current === id) setErr(String((e as Error).message ?? e));
    } finally {
      if (reqRef.current === id) setBusy(false);
    }
  };

  const checks = Object.fromEntries((verdict?.level_checks ?? []).map((c) => [c.field, c]));
  const style = verdict ? VERDICT_STYLE[verdict.verdict] : null;

  return (
    <div className="card detail">
      <div className="section-head">
        <p className="card-title" style={{ margin: 0 }}>
          {ticker}
          {snap?.sector && <span className="badge neutral" style={{ marginLeft: 8 }}>{snap.sector}</span>}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small teal" type="button" onClick={runResearch} disabled={busy}>
            {busy ? 'Researching…' : 'Research with AI'}
          </button>
          <button className="btn small" type="button" onClick={onClose}>Close</button>
        </div>
      </div>

      <ExternalProcessingNotice />

      {err && <div className="error-text">{err}</div>}
      {!snap && !err && <div className="empty-state">Loading {ticker}…</div>}

      {snap && (
        <>
          <div className="stat-row">
            <div><span className="stat-label">Price</span><span className="stat-value">{money(snap.quote?.price)}</span></div>
            <div><span className="stat-label">As of</span><span className="stat-value">{snap.quote?.as_of ? new Date(snap.quote.as_of).toLocaleString() : 'unknown'}</span></div>
            <div><span className="stat-label">20-day SMA</span><span className="stat-value">{money(snap.history?.sma20)}</span></div>
            <div><span className="stat-label">50-day SMA</span><span className="stat-value">{money(snap.history?.sma50)}</span></div>
            <div><span className="stat-label">6-month range</span><span className="stat-value">{money(snap.history?.recent_low)} – {money(snap.history?.recent_high)}</span></div>
            <div><span className="stat-label">From 6mo high</span><span className="stat-value">{pct(snap.history?.pct_from_recent_high)}</span></div>
          </div>

          {verdict && style && (
            <div className="verdict">
              <div className="verdict-head">
                <span className="verdict-badge" style={{ color: style.color, borderColor: style.color }}>{style.label}</span>
                <span className="muted">qualitative confidence: {verdict.confidence} · model {verdict.model} · {new Date(verdict.generated_at).toLocaleString()}</span>
              </div>
              <p className="verdict-summary">{verdict.summary}</p>

              <LevelRow label="Entry" value={verdict.entry_zone} check={checks.entry_zone} />
              <LevelRow label="Target" value={verdict.exit_target} check={checks.exit_target} />
              <LevelRow label="Stop" value={verdict.stop_loss} check={checks.stop_loss} />
              <LevelRow label="Hold" value={verdict.hold_horizon} />

              {verdict.reasoning.length > 0 && (
                <>
                  <p className="card-title" style={{ margin: '12px 0 4px' }}>Reasoning</p>
                  <ul className="tight-list">{verdict.reasoning.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </>
              )}
              {verdict.risks.length > 0 && (
                <>
                  <p className="card-title" style={{ margin: '12px 0 4px', color: 'var(--red)' }}>Risks</p>
                  <ul className="tight-list">{verdict.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </>
              )}
              {dataSources && (
                <>
                  <p className="card-title" style={{ margin: '12px 0 4px' }}>Data available to this research</p>
                  <ul className="tight-list">
                    {Object.entries(dataSources).map(([k, s]) => (
                      <SourceAvail key={k} s={{ ...s, note: SOURCE_LABELS[k] ? `${SOURCE_LABELS[k]}${s.note ? ` — ${s.note}` : ''}` : s.note }} />
                    ))}
                  </ul>
                </>
              )}
              {verdict.sources.length > 0 && (
                <>
                  <p className="card-title" style={{ margin: '12px 0 4px' }}>Retrieved references</p>
                  <ul className="tight-list">
                    {verdict.sources.map((sx, i) => (
                      <li key={i}><a href={sx.url} target="_blank" rel="noreferrer noopener">{sx.title}</a></li>
                    ))}
                  </ul>
                  <p className="provenance">References retrieved during research — not proof that every claim was verified. Confidence is qualitative, not a probability.</p>
                </>
              )}
              <p className="provenance">
                <b>anchor match</b> means the number equals a real level in this ticker's own data — an SMA, the
                6-month range, or the current price. It is an anchor match, NOT a validated prediction.{' '}
                <b>unsupported</b> means it matches nothing supplied; treat it as the model's invention rather than a
                level. This is a research hypothesis, not advice.
              </p>
            </div>
          )}

          {snap.news.length > 0 && (
            <>
              <p className="card-title" style={{ margin: '14px 0 6px' }}>Recent news</p>
              <ul className="tight-list">
                {snap.news.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    <span className="muted">{n.published?.slice(0, 10) ?? '—'} · {n.publisher ?? 'source'}</span>{' '}
                    <a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}

          {snap.fundamentals && (
            <p className="provenance">
              Filed {snap.fundamentals.source_form ?? 'annual report'} ({snap.fundamentals.source_filed ?? 'date unknown'}):
              revenue {big(snap.fundamentals.revenue_usd)}, net income {big(snap.fundamentals.net_income_usd)},
              diluted EPS {snap.fundamentals.diluted_eps ?? '—'} ·{' '}
              <a href={snap.fundamentals.source_url} target="_blank" rel="noreferrer noopener">SEC filings</a>
            </p>
          )}
          {snap.fundamentals_unavailable && (
            <p className="provenance">SEC figures unavailable: {snap.fundamentals_unavailable}</p>
          )}
        </>
      )}
    </div>
  );
}


function IdeaCard({ idea, onOpen }: { idea: ScoredIdea; onOpen: (t: string) => void }) {
  return (
    <div className="idea">
      <div className="idea-head">
        <button className="ticker-tag link" type="button" onClick={() => onOpen(idea.ticker)}>{idea.ticker}</button>
        <span className={`idea-move ${typeof idea.change_pct === 'number' && idea.change_pct >= 0 ? 'pl-up' : 'pl-down'}`}>
          {pct(idea.change_pct)}
        </span>
        <span className="muted">{money(idea.price)}</span>
        <span className="idea-score" title="Screen score: arithmetic over the facts listed below, not a prediction">
          {idea.score}
        </span>
      </div>
      <div className="idea-name">{idea.name}</div>
      <ul className="tight-list">
        {idea.reasons.slice(0, 3).map((r, i) => <li key={i}>{r}</li>)}
        {idea.cautions.slice(0, 2).map((c, i) => <li key={`c${i}`} className="caution">{c}</li>)}
      </ul>
    </div>
  );
}

function Insights({ onOpen }: { onOpen: (t: string) => void }) {
  const [board, setBoard] = useState<InsightBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.insights().then(setBoard).catch((e) => setErr(String((e as Error).message ?? e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="card" id="insights">
      <div className="section-head">
        <p className="card-title" style={{ margin: 0 }}>Today&apos;s ideas</p>
        <button className="btn small" type="button" onClick={load} disabled={loading}>
          {loading ? 'Screening…' : 'Refresh'}
        </button>
      </div>

      {err && <div className="error-text">{err}</div>}
      {loading && !board && <div className="empty-state">Screening the market…</div>}

      {board && (
        <>
          <p className="card-title sub">Best scoring ({board.best_buys.length})</p>
          {board.best_buys.length === 0
            ? <div className="empty-state">Nothing cleared the threshold today.</div>
            : <div className="idea-grid">{board.best_buys.map((i) => <IdeaCard key={i.ticker} idea={i} onOpen={onOpen} />)}</div>}

          {board.watch.length > 0 && (
            <>
              <p className="card-title sub">Worth watching</p>
              <div className="idea-grid">{board.watch.map((i) => <IdeaCard key={i.ticker} idea={i} onOpen={onOpen} />)}</div>
            </>
          )}

          {board.earnings_soon.length > 0 && (
            <>
              <p className="card-title sub">Reporting within two weeks</p>
              <div className="chips">
                {board.earnings_soon.map((i) => (
                  <button key={i.ticker} className="chip" type="button" onClick={() => onOpen(i.ticker)}>
                    {i.ticker} <span className="muted">{i.earnings_in_days}d</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <p className="provenance">
            {board.notes.join(' ')} Open one and hit <b>Research with AI</b> for a research view with levels.
          </p>
        </>
      )}
    </div>
  );
}

export function OnePage() {
  const [tab, setTab] = useState<typeof MOVER_TABS[number]['kind']>('most_actives');
  const [movers, setMovers] = useState<Mover[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.movers(tab, 20)
      .then((r) => { setMovers(r.movers); setFetchedAt(r.fetched_at); setError(null); })
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
  }, [tab]);

  const openTicker = (t: string) => {
    const up = t.toUpperCase();
    setSelected(up);
    // Point the side chat at this stock's thread.
    window.dispatchEvent(new CustomEvent('civicfolio:ticker', { detail: up }));
    requestAnimationFrame(() => document.getElementById('detail')?.scrollIntoView({ block: 'start' }));
  };

  return (
    <div>
      {error && <div className="error-text">{error}</div>}

      <Insights onOpen={openTicker} />

      <div className="card" id="movers">
        <div className="section-head">
          <div className="tabs">
            {MOVER_TABS.map((t) => (
              <button key={t.kind} type="button" className={`tab${tab === t.kind ? ' active' : ''}`}
                onClick={() => setTab(t.kind)}>{t.label}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) openTicker(lookup.trim()); }}
            style={{ display: 'flex', gap: 6 }}>
            <input className="filter-input" placeholder="Look up any ticker…" value={lookup}
              onChange={(e) => setLookup(e.target.value)} aria-label="Look up a ticker"
              style={{ textTransform: 'uppercase', width: 190 }} />
            <button className="btn small" type="submit">Open</button>
          </form>
        </div>

        {loading ? (
          <div className="empty-state">Loading market data…</div>
        ) : movers.length === 0 ? (
          <div className="empty-state">No data returned. The market may be closed, or the feed is unavailable.</div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Ticker</th><th>Company</th>
                  <th className="num">Price</th><th className="num">Change</th>
                  <th className="num">Vol vs avg</th><th>52-week range</th>
                  <th className="num">Earnings</th><th className="num">Fwd P/E</th><th></th>
                </tr>
              </thead>
              <tbody>
                {movers.map((m) => (
                  <tr key={m.ticker} className="row-click" onClick={() => openTicker(m.ticker)}>
                    <td><span className="ticker-tag">{m.ticker}</span></td>
                    <td className="col-name">{m.name}</td>
                    <td className="num">{money(m.price)}</td>
                    <td className={`num ${typeof m.change_pct === 'number' ? (m.change_pct >= 0 ? 'pl-up' : 'pl-down') : ''}`}>{pct(m.change_pct)}</td>
                    <td className="num" title="Today's volume vs its 3-month average">
                      {typeof m.volume_vs_avg === 'number' ? `${m.volume_vs_avg.toFixed(2)}x` : '—'}
                    </td>
                    <td><RangeBar position={m.range_position} /></td>
                    <td className="num" title={m.next_earnings ? `${m.next_earnings.slice(0, 10)}${m.earnings_is_estimate ? ' (estimated)' : ''}` : 'unknown'}>
                      {daysUntil(m.next_earnings)}{m.earnings_is_estimate && m.next_earnings ? '*' : ''}
                    </td>
                    <td className="num">{typeof m.forward_pe === 'number' ? m.forward_pe.toFixed(1) : '—'}</td>
                    <td><button className="btn small teal" type="button" onClick={(e) => { e.stopPropagation(); openTicker(m.ticker); }}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="provenance">
          Delayed, unofficial market data{fetchedAt ? ` fetched ${new Date(fetchedAt).toLocaleTimeString()}` : ''} from a
          public endpoint that can change or rate-limit without notice — not a real-time trading feed, and not
          guaranteed to stay available. Each quote carries its own delay. Earnings dates marked <b>*</b> are the
          provider's estimate, not confirmed by the company.
        </p>
      </div>

      <div id="detail">
        {selected && <TickerDetail ticker={selected} onClose={() => setSelected(null)} />}
      </div>

      <TrackRecord onOpen={openTicker} />

    </div>
  );
}