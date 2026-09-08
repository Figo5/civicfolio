import { useEffect, useState } from 'react';
import { api, type Meta, type SettingsResponse } from '../api';

export function SettingsPage({ meta, refreshMeta }: { meta: Meta | null; refreshMeta: () => Promise<void> | void }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // reset confirmation state
  const [confirmAction, setConfirmAction] = useState<'load' | 'clear' | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.settings().then(setSettings).catch((e) => setError(String((e as Error).message ?? e))); }, []);

  const runAction = async (kind: 'load' | 'clear') => {
    setBusy(true); setActionError(null); setActionMsg(null);
    try {
      if (kind === 'load') {
        const r = await api.demoLoad();
        setActionMsg(`Demo dataset loaded: ${r.counts.disclosures} disclosures, ${r.counts.watchlist} watchlist items, ${r.counts.ideas} ideas, ${r.counts.trades} paper trades. Chat history cleared.`);
      } else {
        await api.demoClear();
        setActionMsg('All local data cleared. The store is empty until you load demo data or import records.');
      }
      setConfirmAction(null);
      setConfirmText('');
      void refreshMeta();
    } catch (e) {
      setActionError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const llm = settings?.providers.llm_endpoint;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-sub">Configuration status only — secrets stay in server env and are never shown or sent to this page.</p>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="grid-2">
        <div className="card">
          <p className="card-title">Research providers</p>
          <div className="kv">
            <span className="k"><span className="status-dot ok" />Deterministic engine</span>
            <span className="v">{settings?.providers.deterministic_engine.note ?? '…'}</span>
            <span className="k"><span className={`status-dot ${llm?.status === 'configured' ? 'ok' : 'off'}`} />LLM endpoint</span>
            <span className="v">
              {llm?.status === 'configured'
                ? <>Configured via server env. Model: <code>{llm.model_when_configured}</code> · endpoint <code>{llm.base_url_when_configured}</code>. Key is stored server-side only and never returned to the frontend.</>
                : (llm?.note ?? 'Not configured.')}
            </span>
          </div>
          <div className="note">LLM mode requires OPENAI_API_KEY in the server's environment (optionally OPENAI_BASE_URL / OPENAI_MODEL). The browser cannot configure or view it.</div>
        </div>

        <div className="card">
          <p className="card-title">Brokerage</p>
          <div className="kv">
            <span className="k"><span className="status-dot off" />Robinhood</span>
            <span className="v"><b>Not configured.</b> {settings?.robinhood.note ?? ''}</span>
          </div>
          <div className="note">
            There is no brokerage login, credential storage, or order execution in Civicfolio. The official Robinhood Agentic MCP is a possible later connector;
            nothing is faked in the meantime.
          </div>
        </div>

        <div className="card">
          <p className="card-title">Data</p>
          <div className="kv">
            <span className="k">Storage directory</span><span className="v"><code>{settings?.data.dir ?? meta?.data_dir ?? '…'}</code></span>
            <span className="k">Demo loaded at</span><span className="v">{settings?.data.demo_loaded_at ? new Date(settings.data.demo_loaded_at).toLocaleString() : 'never (store empty or imported only)'}</span>
            <span className="k">Imports</span>
            <span className="v">
              {settings?.data.imports.length
                ? settings.data.imports.map((i, idx) => <div key={idx}>{i.filename} — {i.count} records — {new Date(i.imported_at).toLocaleString()}</div>)
                : 'none'}
            </span>
          </div>
          <div className="note">
            Data persists as JSON in the directory above (outside this repo by default). Copy it to back up; delete it to fully reset.
          </div>
        </div>

        <div className="card">
          <p className="card-title">Demo data controls</p>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 0 }}>
            The bundled demo dataset contains 12 synthetic disclosure records with fictional owners, labeled demo prices, and sample ideas.
            Loading replaces all current data (disclosures, watchlist, ideas, trades, portfolio, chat).
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn teal" type="button" onClick={() => { setConfirmAction('load'); setConfirmText(''); }}>Load demo dataset…</button>
            <button className="btn danger" type="button" onClick={() => { setConfirmAction('clear'); setConfirmText(''); }}>Clear all data…</button>
          </div>
          {actionMsg && <div className="ok-text">{actionMsg}</div>}
          {actionError && <div className="error-text">{actionError}</div>}
        </div>
      </div>

      {confirmAction && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setConfirmAction(null); }}>
          <div className="modal" style={{ width: 460 }}>
            <h3>{confirmAction === 'load' ? 'Load demo dataset?' : 'Clear all local data?'}</h3>
            {confirmAction === 'load' ? (
              <>
                <div className="confirm-box">This replaces everything currently stored — including imported records, positions, and chat history — with the bundled synthetic demo.</div>
                <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Type <code>LOAD</code> to confirm.</p>
              </>
            ) : (
              <>
                <div className="confirm-box">This permanently deletes all locally stored data (disclosures, watchlist, ideas, trades, portfolio, chat). This cannot be undone.</div>
                <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Type <code>DELETE</code> to confirm.</p>
              </>
            )}
            <div className="field">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={confirmAction === 'load' ? 'LOAD' : 'CLEAR'} />
            </div>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button
                className={`btn ${confirmAction === 'load' ? 'teal' : 'danger'}`}
                type="button"
                disabled={busy || confirmText !== (confirmAction === 'load' ? 'LOAD' : 'CLEAR')}
                onClick={() => runAction(confirmAction)}
              >
                {confirmAction === 'load' ? 'Load demo data' : 'Clear everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}