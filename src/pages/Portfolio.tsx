import { useEffect, useState } from 'react';
import { api, fmtUsd, fmtDate, type PortfolioSummary, type PaperTrade } from '../api';
import { Stat, TradeSideBadge } from '../App';

export function PortfolioPage({ refreshMeta }: { refreshMeta: () => Promise<void> | void }) {
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [form, setForm] = useState({ ticker: '', side: 'BUY' as 'BUY' | 'SELL', quantity: '', price: '', priceSource: 'user_entered', tradeDate: new Date().toISOString().slice(0, 10), note: '' });
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const loadAll = () => {
    api.portfolio().then(setPortfolio).catch((e) => setError(String((e as Error).message ?? e)));
    api.trades().then((r) => setTrades(r.trades)).catch(() => {});
  };
  useEffect(() => { loadAll(); }, []);

  const notional = (() => {
    const q = Number(form.quantity), p = Number(form.price);
    if (!form.quantity || !form.price || Number.isNaN(q) || Number.isNaN(p)) return null;
    return q * p;
  })();

  const cashAfter = portfolio && notional !== null
    ? form.side === 'BUY' ? portfolio.cash_usd - notional : portfolio.cash_usd + notional
    : null;

  const submit = async () => {
    setError(null); setOkMsg(null); setFormError(null);
    const q = Number(form.quantity), p = Number(form.price);
    if (!form.ticker.trim() || !form.quantity || !form.price || Number.isNaN(q) || Number.isNaN(p)) {
      setFormError('Enter a ticker, quantity, and price.');
      return;
    }
    try {
      const clientRequestId = crypto.randomUUID();
      const res = await api.submitTrade({
        ticker: form.ticker.trim(), side: form.side, quantity: q, price: p,
        price_source: form.priceSource, trade_date: form.tradeDate,
        note: form.note.trim() || undefined,
        client_request_id: clientRequestId,
      });
      setOkMsg(res.duplicate
        ? 'Duplicate submission ignored — the original order stands.'
        : `${form.side} ${form.quantity} ${res.trade.ticker} recorded at ${fmtUsd(res.trade.price)} (${res.trade.price_source === 'demo' ? 'demo-labeled price' : 'user-entered price'}).`);
      setForm({ ...form, ticker: '', quantity: '', price: '', note: '' });
      setPortfolio(res.portfolio);
      const t = await api.trades();
      setTrades(t.trades);
      void refreshMeta();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const overSpendWarning = form.side === 'BUY' && cashAfter !== null && cashAfter < 0;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Paper Portfolio</h1>
        <p className="page-sub">
          Paper trading only — no brokerage connection, no real orders.<span className="sep">·</span>
          Prices are user-entered or demo-labeled; nothing here is market data.
        </p>
      </div>

      <div className="grid-3">
        <div className="card">
          <p className="card-title">Cash</p>
          <Stat label="Cash available" value={portfolio ? fmtUsd(portfolio.cash_usd) : '—'} sub="paper account, starts at $100,000" />
        </div>
        <div className="card">
          <p className="card-title">Invested (cost)</p>
          <Stat label="Cost basis of open positions" value={portfolio ? fmtUsd(portfolio.invested_cost_usd) : '—'} sub={`${portfolio?.positions.length ?? 0} open position(s)`} />
        </div>
        <div className="card">
          <p className="card-title">Trades</p>
          <Stat label="Journal entries" value={String(portfolio?.trade_count ?? '—')} sub="persisted locally across restarts" />
        </div>
      </div>

      <div className="card">
        <p className="card-title">New paper order</p>
        <div className="form-row">
          <div className="field" style={{ maxWidth: 120 }}>
            <label>Side</label>
            <select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as 'BUY' | 'SELL' })}>
              <option value="BUY">BUY</option><option value="SELL">SELL</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 140 }}>
            <label>Ticker</label>
            <input placeholder="AAPL" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} />
          </div>
          <div className="field" style={{ maxWidth: 120 }}>
            <label>Quantity</label>
            <input type="number" min="0" step="any" placeholder="10" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field" style={{ maxWidth: 140 }}>
            <label>Price ($)</label>
            <input type="number" min="0" step="any" placeholder="150.00" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </div>
          <div className="field" style={{ maxWidth: 190 }}>
            <label>Price source</label>
            <select value={form.priceSource} onChange={(e) => setForm({ ...form, priceSource: e.target.value })}>
              <option value="user_entered">I entered this price myself</option>
              <option value="demo">Demo-labeled price</option>
            </select>
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>Trade date</label>
            <input type="date" value={form.tradeDate} onChange={(e) => setForm({ ...form, tradeDate: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label>Note (optional)</label>
          <input placeholder="why this trade…" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button className="btn primary" type="button" onClick={submit}>Record paper {form.side}</button>
          {notional !== null && (
            <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              Notional: <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(notional)}</b>
              {cashAfter !== null && <> · cash after: <b style={{ fontVariantNumeric: 'tabular-nums', color: overSpendWarning ? 'var(--red)' : undefined }}>{fmtUsd(cashAfter)}</b></>}
            </span>
          )}
        </div>
        {overSpendWarning && <div className="error-text">Notional exceeds available cash — the server will reject this order.</div>}
        {formError && <div className="error-text">{formError}</div>}
        {error && <div className="error-text">{error}</div>}
        {okMsg && <div className="ok-text">{okMsg}</div>}
        <div className="note">
          Orders never reach a broker. Prices you enter are stored as-is and labeled "user-entered" — they are not verified market prices.
        </div>
      </div>

      <div className="card">
        <p className="card-title">Open positions</p>
        {!portfolio || portfolio.positions.length === 0 ? (
          <div className="empty-state">No open positions.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Ticker</th><th className="num">Quantity</th><th className="num">Avg cost</th><th className="num">Cost basis</th></tr></thead>
            <tbody>
              {portfolio.positions.map((p) => (
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
      </div>

      <div className="card">
        <p className="card-title">Trade journal</p>
        {trades.length === 0 ? (
          <div className="empty-state">No paper trades yet.</div>
        ) : (
          <table className="table">
            <thead><tr><th>Date</th><th>Side</th><th>Ticker</th><th className="num">Qty</th><th className="num">Price</th><th>Price source</th><th>Note</th></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.trade_date)}</td>
                  <td><TradeSideBadge side={t.side} /></td>
                  <td><span className="ticker-tag">{t.ticker}</span></td>
                  <td className="num">{t.quantity}</td>
                  <td className="num">{fmtUsd(t.price)}</td>
                  <td><span className={`badge ${t.price_source === 'demo' ? 'demo' : 'imported'}`}>{t.price_source === 'demo' ? 'demo price' : 'user-entered'}</span></td>
                  <td style={{ fontSize: 12 }}>{t.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}