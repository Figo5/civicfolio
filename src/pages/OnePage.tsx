import { useEffect, useState } from 'react';
import { api, type Fundamentals, type ProposalsResponse, type Trends, type Proposal, type ChatMessage, type AgentVerdict } from '../api';
import { ModeBadge } from '../App';

const VERDICT_STYLE: Record<AgentVerdict['verdict'], { label: string; color: string }> = {
  strong_buy: { label: 'STRONG BUY', color: 'var(--green)' },
  buy: { label: 'BUY', color: 'var(--green)' },
  hold: { label: 'HOLD', color: 'var(--text-dim)' },
  avoid: { label: 'AVOID', color: 'var(--red)' },
  unclear: { label: 'UNCLEAR', color: 'var(--text-dim)' },
};

function ScoreBar({ score }: { score: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div className="allocation-bar" style={{ width: 90, height: 6 }}>
        <div className="allocation-seg" style={{ width: `${score}%`, background: score >= 60 ? 'var(--green)' : score >= 35 ? '#8a8a8a' : '#4a4a4a' }} />
      </div>
      <b style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{score}</b>
    </div>
  );
}

function ProposalRow({ p }: { p: Proposal }) {
  const [open, setOpen] = useState(false);
  const [fundamentals, setFundamentals] = useState<Fundamentals | null>(null);
  const [fundError, setFundError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<AgentVerdict | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);

  const expand = () => {
    const next = !open;
    setOpen(next);
    if (next && !fundamentals && !fundError) {
      api.fundamentals(p.ticker)
        .then((r) => setFundamentals(r.fundamentals))
        .catch((e) => setFundError(String((e as Error).message ?? e)));
    }
  };

  const runResearch = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(true);
    setResearchBusy(true);
    setResearchError(null);
    api.research(p.ticker)
      .then((r) => setVerdict(r.verdict))
      .catch((e) => setResearchError(String((e as Error).message ?? e)))
      .finally(() => setResearchBusy(false));
  };

  const quote = p.quote ?? null;

  return (
    <>
      <tr onClick={expand} style={{ cursor: 'pointer' }}>
        <td><span className="ticker-tag">{p.ticker}</span></td>
        <td style={{ fontSize: 12.5 }}>{p.company}</td>
        <td className="num">
          {quote ? (
            <>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>${quote.price.toFixed(2)}</b>
              {quote.previous_close != null && quote.previous_close > 0 && (
                <span className={quote.price >= quote.previous_close ? 'pl-up' : 'pl-down'} style={{ display: 'block', fontSize: 11 }}>
                  {quote.price >= quote.previous_close ? '▲' : '▼'} {(((quote.price / quote.previous_close) - 1) * 100).toFixed(1)}%
                </span>
              )}
            </>
          ) : <span className="muted">no quote</span>}
        </td>
        <td><ScoreBar score={p.score} /></td>
        <td className="num">{p.buys} / {p.sells}</td>
        <td className="num">{p.total_range_label}</td>
        <td>{p.days_since_published}d ago</td>
        <td>{p.data_modes.length === 1 && p.data_modes[0] === 'demo' ? <ModeBadge mode="demo" /> : <ModeBadge mode="imported" />}</td>
        <td>
          <button className="btn small teal" type="button" onClick={runResearch} disabled={researchBusy} aria-label={`Research ${p.ticker}`}>
            {researchBusy ? 'Researching…' : verdict ? 'Re-research' : 'Research'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ background: 'var(--panel-2)', padding: '14px 18px' }}>
            {verdict && (
              <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', background: 'var(--panel)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 14, letterSpacing: 0.5, color: VERDICT_STYLE[verdict.verdict].color }}>
                    {VERDICT_STYLE[verdict.verdict].label}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                    confidence: {verdict.confidence} · {verdict.model} · {verdict.searches_used} web search(es) · {new Date(verdict.generated_at).toLocaleTimeString()}
                  </span>
                </div>
                <p style={{ margin: '0 0 8px', fontSize: 13.5, color: 'var(--text)' }}>{verdict.summary}</p>
                {verdict.reasoning.length > 0 && (
                  <>
                    <p className="card-title" style={{ margin: '10px 0 4px' }}>Reasoning</p>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
                      {verdict.reasoning.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </>
                )}
                {verdict.risks.length > 0 && (
                  <>
                    <p className="card-title" style={{ margin: '10px 0 4px', color: 'var(--red)' }}>Risks</p>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-dim)' }}>
                      {verdict.risks.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  </>
                )}
                {verdict.sources.length > 0 && (
                  <>
                    <p className="card-title" style={{ margin: '10px 0 4px' }}>Web sources</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {verdict.sources.map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }} title={s.title}>
                          {s.title.length > 48 ? s.title.slice(0, 48) + '…' : s.title} ↗
                        </a>
                      ))}
                    </div>
                  </>
                )}
                <p className="provenance" style={{ marginTop: 10 }}>Agent research with live web search — not financial advice. Verify before you trade.</p>
              </div>
            )}
            {researchError && <div className="error-text" style={{ marginBottom: 12 }}>Research agent: {researchError}</div>}
            {researchBusy && !verdict && <p className="provenance" style={{ marginBottom: 12 }}>Agent is searching the web and analyzing… this takes up to a minute.</p>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              <div>
                <p className="card-title" style={{ marginBottom: 6 }}>Why it's proposed</p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
                  {p.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
                <p className="card-title" style={{ margin: '12px 0 6px' }}>Watch out for</p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-dim)' }}>
                  {p.counterpoints.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
              <div>
                <p className="card-title" style={{ marginBottom: 6 }}>Filed financials (SEC EDGAR)</p>
                {fundError && <p className="provenance">{fundError}</p>}
                {!fundamentals && !fundError && <p className="provenance">Fetching…</p>}
                {fundamentals && (
                  <table className="table">
                    <tbody>
                      {([
                        ['Revenue (annual)', fundamentals.revenue_usd],
                        ['Net income', fundamentals.net_income_usd],
                        ['Total assets', fundamentals.assets_usd],
                        ['Stockholders’ equity', fundamentals.equity_usd],
                      ] as [string, number | null][]).map(([label, v]) => (
                        <tr key={label}>
                          <td>{label}</td>
                          <td className="num">{v === null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${v}`}</td>
                        </tr>
                      ))}
                      <tr>
                        <td>Diluted EPS</td>
                        <td className="num">{fundamentals.diluted_eps === null ? '—' : `$${fundamentals.diluted_eps.toFixed(2)}`}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {fundamentals && (
                  <p className="provenance">
                    {fundamentals.company_name} · {fundamentals.source_form ?? 'filing'} filed {fundamentals.source_filed ?? 'unknown'} ·{' '}
                    <a href={fundamentals.source_url} target="_blank" rel="noreferrer">EDGAR</a>. As-filed annual figures — may be months old.
                  </p>
                )}
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)' }}>
              Buyers: {p.buy_owners.join(', ') || '—'}
              {p.sell_owners.length > 0 && <> · Sellers: {p.sell_owners.join(', ')}</>}
            </div>
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Source filings:{' '}
              {p.record_ids.map((id, i) => (
                <span key={id} style={{ marginRight: 10 }}>
                  <code>{id}</code>
                  {p.source_urls[i] && <> <a href={p.source_urls[i] ?? '#'} target="_blank" rel="noreferrer">[PDF]</a></>}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modeAvailable, setModeAvailable] = useState(false);
  const [mode, setMode] = useState<'deterministic' | 'llm'>('deterministic');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.chat().then((r) => { setMessages(r.messages.slice(-30)); setModeAvailable(r.mode_available); }).catch(() => {});
  }, []);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setBusy(true); setError(null);
    setMessages((m) => [...m, { role: 'user', content: question, ts: new Date().toISOString() }]);
    setInput('');
    try {
      const res = await api.ask(question, mode, false);
      setMessages((m) => [...m, res.message]);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setMessages((m) => m.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <p className="card-title" style={{ margin: 0 }}>Ask about the data</p>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'deterministic' | 'llm')} style={{ width: 'auto' }}>
          <option value="deterministic">Local engine (no key)</option>
          {modeAvailable && <option value="llm">LLM (configured)</option>}
        </select>
      </div>
      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length === 0 && (
          <div className="empty-state">Ask about any ticker in the feed, reporting delays, or why something ranks where it does.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {m.citations.map((c, j) => (
                  <span key={j} className="cite">
                    {c.source_url
                      ? <a href={c.source_url} target="_blank" rel="noreferrer" title={c.source_name ?? ''}>[{c.record_id}] ↗</a>
                      : <span className="cite-no-link">[{c.record_id}]</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="chat-input-row">
        <input
          placeholder={busy ? 'Thinking…' : 'e.g. what does the store say about UBER?'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          disabled={busy}
        />
        <button className="btn primary" type="button" onClick={ask} disabled={busy || !input.trim()}>Ask</button>
      </div>
    </div>
  );
}

export function OnePage() {
  const [data, setData] = useState<ProposalsResponse | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.proposals().then(setData).catch((e) => setError(String((e as Error).message ?? e)));
    api.trends().then(setTrends).catch(() => {});
  }, []);

  const proposals = data?.proposals ?? [];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Civicfolio</h1>
        <p className="page-sub">
          Stocks congressional filers bought, ranked and cited — take the idea to your brokerage. Not advice; filings are delayed and amounts are ranges.
        </p>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <p className="card-title">Proposals <span className="badge imported">last {data?.window_days ?? 180} days of filings</span></p>
        {proposals.length === 0 ? (
          <div className="empty-state">
            No proposals yet — waiting for the next daily disclosure refresh, or import filings on the Disclosures page.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Ticker</th><th>Company</th><th className="num">Price*</th><th>Score</th>
                <th className="num">Buys/Sells</th><th className="num">Filed range</th><th>Latest filing</th><th>Mode</th><th></th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => <ProposalRow key={p.ticker} p={p} />)}
            </tbody>
          </table>
        )}
        <p className="provenance">
          *Price is a delayed, unofficial quote from a public endpoint — indicative only, never a trading feed.
          {' '}{data?.notes.slice(0, 2).join(' ')}
        </p>
      </div>

      {trends && (
        <div className="grid-2">
          <div className="card">
            <p className="card-title">Most bought</p>
            {trends.most_bought.length === 0 ? <div className="empty-state">No data</div> : (
              <table className="table">
                <thead><tr><th>Ticker</th><th className="num">Buyers</th><th className="num">Trades</th><th className="num">Filed max</th></tr></thead>
                <tbody>
                  {trends.most_bought.map((t) => (
                    <tr key={t.ticker}>
                      <td><span className="ticker-tag">{t.ticker}</span></td>
                      <td className="num">{t.buyers}</td>
                      <td className="num">{t.trades}</td>
                      <td className="num">${t.total_max_usd >= 1e6 ? `${(t.total_max_usd / 1e6).toFixed(1)}M` : `${Math.round(t.total_max_usd / 1e3)}k`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <p className="card-title">Most sold</p>
            {trends.most_sold.length === 0 ? <div className="empty-state">No data</div> : (
              <table className="table">
                <thead><tr><th>Ticker</th><th className="num">Sellers</th><th className="num">Trades</th><th className="num">Filed max</th></tr></thead>
                <tbody>
                  {trends.most_sold.map((t) => (
                    <tr key={t.ticker}>
                      <td><span className="ticker-tag">{t.ticker}</span></td>
                      <td className="num">{t.sellers}</td>
                      <td className="num">{t.trades}</td>
                      <td className="num">${t.total_max_usd >= 1e6 ? `${(t.total_max_usd / 1e6).toFixed(1)}M` : `${Math.round(t.total_max_usd / 1e3)}k`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <Chat />
    </div>
  );
}