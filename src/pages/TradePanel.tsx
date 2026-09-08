import { useEffect, useState } from 'react';
import { api } from '../api';

const money = (n: number | null | undefined): string =>
  typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

type Stage = 'setup' | 'entry' | 'review' | 'done';

interface RhPosition { symbol?: string; quantity?: string | number; average_buy_price?: string | number }

/**
 * Real-order flow against the Robinhood Trading MCP.
 * Nothing is sent to Robinhood until you press "Confirm & place" after seeing
 * Robinhood's own pre-trade review. There is no auto-trading anywhere.
 * Also shows your existing position in this ticker (over-concentration guard)
 * and sets price alerts that land in your Robinhood app.
 */
export function TradePanel({ ticker, price, earningsInDays }: { ticker: string; price: number | null; earningsInDays?: number | null }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('entry');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('');
  const [kind, setKind] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [review, setReview] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [heldQty, setHeldQty] = useState<number | null>(null);
  const [heldCost, setHeldCost] = useState<number | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);

  useEffect(() => {
    api.rhStatus().then((s) => setConnected(s.connected)).catch(() => setConnected(false));
  }, []);

  // Existing position in this ticker — shown so a BUY recommendation cannot
  // silently stack onto a large holding.
  useEffect(() => {
    setHeldQty(null); setHeldCost(null);
    api.rhStatus().then((s) => {
      if (!s.connected) return;
      api.rhPositions().then((r) => {
        const list = (r.positions as { data?: RhPosition[]; positions?: RhPosition[] } | RhPosition[] | null);
        const arr: RhPosition[] = Array.isArray(list) ? list : (list?.data ?? list?.positions ?? []);
        const mine = arr.find((p) => String(p.symbol ?? '').toUpperCase() === ticker.toUpperCase());
        if (mine) {
          const q = Number(mine.quantity);
          if (Number.isFinite(q) && q > 0) {
            setHeldQty(q);
            const c = Number(mine.average_buy_price);
            setHeldCost(Number.isFinite(c) ? c : null);
          }
        }
      }).catch(() => {});
    }).catch(() => {});
  }, [ticker]);

  // Reset the trade form when the ticker changes.
  useEffect(() => {
    setStage('entry'); setReview(null); setResult(null); setError(null); setAlertMsg(null);
  }, [ticker]);

  const setAlert = async (direction: 'above' | 'below') => {
    if (price === null) { setError('No quote available to base an alert on.'); return; }
    setAlertBusy(true); setError(null); setAlertMsg(null);
    try {
      // Default: 5% beyond the current price, adjustable by the user in Robinhood.
      const target = direction === 'below' ? price * 0.95 : price * 1.05;
      await api.rhCreateAlert(ticker, direction, Number(target.toFixed(2)));
      setAlertMsg(`Alert set in Robinhood: ${ticker} ${direction} $${target.toFixed(2)} — notifications arrive from Robinhood.`);
    } catch (e) {
      setAlertMsg(String((e as Error).message ?? e));
    } finally { setAlertBusy(false); }
  };

  const estNotional = (() => {
    const q = Number(qty);
    if (!qty || Number.isNaN(q) || q <= 0) return null;
    if (kind === 'limit') {
      const lp = Number(limitPrice);
      if (!limitPrice || Number.isNaN(lp) || lp <= 0) return null;
      return q * lp;
    }
    return price !== null ? q * price : null;
  })();

  const startConnect = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.rhConnect();
      setConnectUrl(r.authorization_url);
      window.open(r.authorization_url, '_blank', 'noopener');
      setStage('setup');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  const checkConnection = async () => {
    setBusy(true); setError(null);
    try {
      const s = await api.rhStatus();
      if (!s.connected) {
        setError('Not connected yet — complete the authorization in the Robinhood window, then press Check again.');
        return;
      }
      const v = await api.rhVerify();
      if (v.ok) {
        setConnected(true);
        setConnectUrl(null);
        setStage('entry');
      } else {
        setError(v.error ?? 'Connection check failed');
      }
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  const doReview = async () => {
    const q = Number(qty);
    if (!qty || Number.isNaN(q) || q <= 0) { setError('Enter a quantity.'); return; }
    if (kind === 'limit') {
      const lp = Number(limitPrice);
      if (!limitPrice || Number.isNaN(lp) || lp <= 0) { setError('Limit orders need a limit price.'); return; }
    }
    setBusy(true); setError(null); setReview(null);
    try {
      const r = await api.rhReview({
        ticker, side, quantity: q, kind,
        limit_price: kind === 'limit' ? Number(limitPrice) : null,
      });
      setReview(JSON.stringify(r.review, null, 2).slice(0, 2000));
      setStage('review');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  const doPlace = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.rhPlace({
        ticker, side, quantity: Number(qty), kind,
        limit_price: kind === 'limit' ? Number(limitPrice) : null,
        client_request_id: crypto.randomUUID(),
        confirm: true,
      });
      setResult(JSON.stringify(r.order, null, 2).slice(0, 1500));
      setStage('done');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally { setBusy(false); }
  };

  // ---- connect flow --------------------------------------------------------
  if (connected === null) return <p className="provenance">Checking Robinhood connection…</p>;

  if (!connected) {
    return (
      <div className="trade-panel">
        <p className="card-title">Trade on Robinhood</p>
        {stage === 'setup' || connectUrl ? (
          <>
            <p className="provenance" style={{ marginTop: 0 }}>
              1. Authorize Civicfolio in the Robinhood window that just opened
              (you may be prompted to open a free <b>Agentic</b> account — Robinhood requires it for agent trading, desktop only).<br />
              2. Come back here and press Check.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn small teal" type="button" onClick={checkConnection} disabled={busy}>{busy ? 'Checking…' : 'Check connection'}</button>
              {connectUrl && <a className="btn small" href={connectUrl} target="_blank" rel="noreferrer noopener">Open authorization again</a>}
            </div>
          </>
        ) : (
          <>
            <p className="provenance" style={{ marginTop: 0 }}>
              Connects through Robinhood's <b>official Trading MCP</b> — the same integration Robinhood documents for AI agents.
              You'll authorize once in your browser (a free Agentic account is required by Robinhood; desktop only).
              Orders placed here go to <b>your real account</b> and always require your explicit confirmation after a pre-trade review.
            </p>
            <button className="btn small teal" type="button" onClick={startConnect} disabled={busy}>{busy ? 'Starting…' : 'Connect Robinhood'}</button>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
        <p className="provenance" style={{ marginTop: 8 }}>
          Not ready to connect? <a href={`https://robinhood.com/stocks/${ticker}`} target="_blank" rel="noreferrer noopener">Open {ticker} on Robinhood ↗</a> and place the order there.
        </p>
      </div>
    );
  }

  // ---- trade flow ----------------------------------------------------------
  return (
    <div className="trade-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p className="card-title" style={{ margin: 0 }}>Trade on Robinhood</p>
        <span className="badge ok">connected</span>
      </div>

      {heldQty !== null && (
        <p className="provenance" style={{ marginTop: 8 }}>
          You already hold <b>{heldQty} {ticker}</b>
          {heldCost !== null && <> at avg cost {money(heldCost)}</>}
          {price !== null && heldCost !== null && (
            <>, currently {((price - heldCost) / heldCost * 100).toFixed(1)}% {price >= heldCost ? 'up' : 'down'}</>
          )}
          . Adding more increases your concentration in this name.
        </p>
      )}

      {typeof earningsInDays === 'number' && earningsInDays >= 0 && earningsInDays <= 7 && (
        <p className="confirm-box" style={{ marginTop: 8 }}>
          Earnings {earningsInDays === 0 ? 'is today' : `in ${earningsInDays} day${earningsInDays === 1 ? '' : 's'}`} — expect outsized volatility around the print.
        </p>
      )}

      {stage !== 'done' && (
        <>
          <div className="form-row" style={{ marginTop: 10 }}>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>Side</label>
              <select value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
                <option value="buy">BUY</option>
                <option value="sell">SELL</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 110 }}>
              <label>Quantity</label>
              <input inputMode="decimal" placeholder="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="field" style={{ maxWidth: 120 }}>
              <label>Type</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as 'market' | 'limit')}>
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </div>
            {kind === 'limit' && (
              <div className="field" style={{ maxWidth: 120 }}>
                <label>Limit $</label>
                <input inputMode="decimal" placeholder={price ? price.toFixed(2) : '0.00'} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
              </div>
            )}
            <div className="field" style={{ alignSelf: 'flex-end' }}>
              <button className="btn small" type="button" onClick={doReview} disabled={busy}>{busy ? 'Reviewing…' : 'Review order'}</button>
            </div>
          </div>
          {estNotional !== null && (
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-dim)' }}>
              Estimated {side === 'buy' ? 'cost' : 'proceeds'}: <b>{money(estNotional)}</b>
              {kind === 'market' && price !== null && <span className="muted"> at the last price {money(price)} (market orders fill at the next available price)</span>}
            </p>
          )}
        </>
      )}

      {review && stage === 'review' && (
        <div style={{ marginTop: 12 }}>
          <p className="card-title" style={{ margin: '0 0 4px' }}>Robinhood pre-trade check</p>
          <pre className="review-box">{review}</pre>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <button className="btn primary small" type="button" onClick={doPlace} disabled={busy}>
              {busy ? 'Placing…' : `Confirm: ${side.toUpperCase()} ${qty} ${ticker}`}
            </button>
            <button className="btn small" type="button" onClick={() => { setStage('entry'); setReview(null); }} disabled={busy}>Cancel</button>
          </div>
          <p className="provenance" style={{ marginTop: 8 }}>
            This places a <b>real order</b> in your Robinhood Agentic account. Market orders fill at the next available price —
            for fast-moving stocks use a limit order instead.
          </p>
        </div>
      )}

      {stage === 'done' && result && (
        <div style={{ marginTop: 10 }}>
          <p className="ok-text">Order submitted to Robinhood.</p>
          <pre className="review-box">{result}</pre>
          <button className="btn small" type="button" onClick={() => { setStage('entry'); setReview(null); setResult(null); setQty(''); }}>New order</button>
        </div>
      )}

      {stage === 'entry' && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
          <p className="card-title" style={{ margin: '0 0 6px' }}>Price alerts (push to your Robinhood app)</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small" type="button" onClick={() => setAlert('below')} disabled={alertBusy || price === null}>
              {alertBusy ? 'Setting…' : `Alert below ${price !== null ? money(price * 0.95) : '—'}`}
            </button>
            <button className="btn small" type="button" onClick={() => setAlert('above')} disabled={alertBusy || price === null}>
              {alertBusy ? 'Setting…' : `Alert above ${price !== null ? money(price * 1.05) : '—'}`}
            </button>
          </div>
          {alertMsg && <p className="provenance" style={{ marginTop: 6 }}>{alertMsg}</p>}
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
    </div>
  );
}