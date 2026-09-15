import { useEffect, useRef, useState } from 'react';
import { api, type Mover, type TickerSnapshot, type AgentVerdict, type InsightBoard, type ScoredIdea, type DataSourceStatus, type DeepResult, type DeepClaim } from '../api';
import { AiFund } from './AiFund';

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
  // --- experimental Deep Research. Off unless the server says it is enabled.
  const [deepOn, setDeepOn] = useState(false);
  const [deep, setDeep] = useState<DeepResult | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepErr, setDeepErr] = useState<string | null>(null);
  const deepAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    api.meta()
      .then((m) => { if (live) setDeepOn(m.deep_research_experiment?.enabled === true); })
      .catch(() => { /* the experiment simply stays hidden */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    setSnap(null); setVerdict(null); setErr(null); setDataSources(null);
    setDeep(null); setDeepErr(null);
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

  // One run at a time: a second click joins nothing, it just cannot start a
  // second pair of model calls.
  const runDeep = async () => {
    if (deepBusy) return;
    const id = reqRef.current;
    const ctrl = new AbortController();
    deepAbort.current = ctrl;
    setDeepBusy(true); setDeepErr(null);
    try {
      const r = await api.deepResearch(ticker, ctrl.signal);
      if (reqRef.current === id) setDeep(r);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (reqRef.current === id) setDeepErr(/abort/i.test(msg) ? 'Cancelled.' : msg);
    } finally {
      if (reqRef.current === id) setDeepBusy(false);
      deepAbort.current = null;
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
          {deepOn && (
            <button
              className="btn small"
              type="button"
              onClick={deepBusy ? () => deepAbort.current?.abort() : runDeep}
              title="Experimental: verified evidence packet, then a researcher and a reviewer. Read-only."
            >
              {deepBusy ? 'Cancel deep run' : 'Deep Research (exp.)'}
            </button>
          )}
          <button className="btn small" type="button" onClick={onClose}>Close</button>
        </div>
      </div>

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
                  <p className="provenance">Retrieved references. Confidence is qualitative.</p>
                </>
              )}
            </div>
          )}

          {deepOn && (deepBusy || deepErr || deep) && (
            <DeepPanel result={deep} busy={deepBusy} error={deepErr} />
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


// ---- EXPERIMENTAL: Deep Research panel ------------------------------------
//
// Read-only. It renders the reviewed report, what the application could not
// verify, the dates behind the evidence, and what the run cost. Nothing here
// can place a trade or touch the paper fund.

function ClaimList({ title, claims, color }: { title: string; claims: DeepClaim[]; color?: string }) {
  if (claims.length === 0) return null;
  return (
    <>
      <p className="card-title" style={{ margin: '10px 0 4px', ...(color ? { color } : {}) }}>{title}</p>
      <ul className="tight-list">
        {claims.map((c, i) => (
          <li key={i}>
            {c.text}{' '}
            <span className="muted">[{c.evidence_ids.join(', ') || 'uncited'}]</span>
            {c.unsupported && c.unsupported.length > 0 && (
              <span className="caution"> · unverified figure(s): {c.unsupported.join(', ')}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function DeepPanel({ result, busy, error }: { result: DeepResult | null; busy: boolean; error: string | null }) {
  if (busy) {
    return (
      <div className="verdict">
        <p className="card-title" style={{ margin: 0 }}>Deep Research (experimental)</p>
        <p className="muted">Resolving instrument, collecting evidence, then researcher and reviewer… This takes a minute or two.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="verdict">
        <p className="card-title" style={{ margin: 0 }}>Deep Research (experimental)</p>
        <div className="error-text">{error}</div>
      </div>
    );
  }
  if (!result) return null;

  const p = result.packet;
  const tokens = result.usage.reduce(
    (a, u) => ({ in: a.in + (u.input_tokens ?? 0), out: a.out + (u.output_tokens ?? 0) }),
    { in: 0, out: 0 },
  );
  const latency = result.usage.reduce((a, u) => a + u.latency_ms, 0);

  return (
    <div className="verdict">
      <div className="verdict-head">
        <span className="verdict-badge" style={{ color: 'var(--text-dim)', borderColor: 'var(--text-dim)' }}>
          EXPERIMENTAL
        </span>
        <span className="muted">
          {p.identity.company ?? p.identity.ticker} · identity {p.identity.state} ·
          {' '}model {result.model} · {new Date(result.generated_at).toLocaleString()}
          {result.cached ? ' · cached' : ''}
        </span>
      </div>

      <p className="verdict-summary">{result.report.situation}</p>

      <ClaimList title="Supporting case" claims={result.report.supporting_case} />
      <ClaimList title="Opposing case" claims={result.report.opposing_case} />
      <ClaimList title="What changed" claims={result.report.what_changed} />
      <ClaimList title="Risks" claims={result.report.risks} color="var(--red)" />

      {result.report.unanswered_questions.length > 0 && (
        <>
          <p className="card-title" style={{ margin: '10px 0 4px' }}>The evidence does not answer</p>
          <ul className="tight-list">
            {result.report.unanswered_questions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </>
      )}

      {result.review_issues.length > 0 && (
        <>
          <p className="card-title" style={{ margin: '10px 0 4px' }}>Reviewer found</p>
          <ul className="tight-list">
            {result.review_issues.map((x, i) => (
              <li key={i}><span className="muted">{x.severity} · {x.kind}</span> — {x.detail}</li>
            ))}
          </ul>
        </>
      )}

      {!result.validation.ok && (
        <>
          <p className="card-title" style={{ margin: '10px 0 4px', color: 'var(--red)' }}>
            The application could not verify
          </p>
          <ul className="tight-list">
            {[...result.validation.entity_problems, ...result.validation.bad_citations,
              ...result.validation.unsupported_numbers, ...result.validation.uncited_claims]
              .slice(0, 8).map((x, i) => <li key={i} className="caution">{x}</li>)}
          </ul>
        </>
      )}
      {result.validation.removed.length > 0 && (
        <p className="provenance">
          {result.validation.removed.length} claim(s) were removed because the evidence did not support them.
        </p>
      )}

      <p className="card-title" style={{ margin: '10px 0 4px' }}>Evidence</p>
      <ul className="tight-list">
        {p.items.slice(0, 20).map((it) => (
          <li key={it.id}>
            <span className="muted">[{it.id}] {it.kind}</span> {it.claim}
            {' · '}
            <span className="muted">
              {it.published_at ? `published ${it.published_at.slice(0, 10)}` : 'publication date unknown'}
              {it.period_end ? `, period ${it.period_end.slice(0, 10)}` : ''}
              {`, retrieved ${it.retrieved_at.slice(0, 10)}`}
            </span>
            {it.url && <> · <a href={it.url} target="_blank" rel="noreferrer noopener">source</a></>}
          </li>
        ))}
      </ul>

      {p.missing.length > 0 && (
        <p className="provenance">Missing: {p.missing.map((m) => `${m.kind} (${m.reason})`).join('; ')}</p>
      )}

      <p className="card-title" style={{ margin: '10px 0 4px' }}>Limitations</p>
      <ul className="tight-list">
        {result.limitations.slice(0, 8).map((l, i) => <li key={i} className="caution">{l}</li>)}
      </ul>

      <p className="provenance">
        {result.usage.length} model call(s) · {tokens.in} input tokens ({result.usage.reduce((a, u) => a + (u.cached_input_tokens ?? 0), 0)} cached),
        {' '}{tokens.out} output tokens · {(latency / 1000).toFixed(1)}s ·{' '}
        {result.cost.amount === null ? `cost unknown (${result.cost.basis})` : `~${result.cost.amount.toFixed(4)} (${result.cost.basis})`}
      </p>
      <p className="provenance">
        Experimental research output. Read-only: it places no orders and does not affect the paper fund.
        Confidence is not quantified and no recommendation is implied.
      </p>
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

          <p className="provenance">{board.notes.join(' ')}</p>
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
          Delayed, unofficial market data{fetchedAt ? ` fetched ${new Date(fetchedAt).toLocaleTimeString()}` : ''}.
          Earnings dates marked <b>*</b> are the provider's estimate.
        </p>
      </div>

      <div id="detail">
        {selected && <TickerDetail ticker={selected} onClose={() => setSelected(null)} />}
      </div>

      <AiFund onOpen={openTicker} />

    </div>
  );
}