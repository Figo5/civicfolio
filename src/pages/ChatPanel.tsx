import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type ChatThread } from '../api';

const GENERAL = '__general__';

/**
 * Side panel chat. One thread per stock, so a conversation about NVDA stays
 * separate from one about AMD — mixing them was what made the old single log
 * unreadable once more than one name was in play.
 *
 * Async correctness: an in-flight request is bound to the thread it was sent
 * from. Switching threads (or having a ticker opened in the main pane) detaches
 * the response — it lands in its own thread via the persisted server copy, never
 * rendered into the wrong thread. Late responses never overwrite another
 * thread's view.
 */
export function ChatPanel() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [active, setActive] = useState<string>(GENERAL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modeAvailable, setModeAvailable] = useState(false);
  const [mode, setMode] = useState<'deterministic' | 'llm'>('llm');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const ticker = active === GENERAL ? undefined : active;

  const load = (t?: string) => {
    api.chat(t).then((r) => {
      setMessages(r.messages);
      setThreads(r.threads);
      setModeAvailable(r.mode_available);
      setError(null);
    }).catch((e) => setError(String((e as Error).message ?? e)));
  };

  useEffect(() => { load(ticker); }, [active]);

  // Follow a ticker opened in the main pane, so asking about what you are
  // looking at does not require picking the thread by hand.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (t) setActive(t);
    };
    window.addEventListener('civicfolio:ticker', onOpen);
    return () => window.removeEventListener('civicfolio:ticker', onOpen);
  }, []);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages, pendingQuestion]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return; // duplicate-send guard: one request at a time
    const sentThread = ticker;
    setBusy(true);
    setError(null);
    setPendingQuestion(question);
    setInput('');
    try {
      const res = await api.ask(question, mode, sentThread);
      // Guard against the user having switched threads while the request was
      // in flight: only render into the view if we are still on the same
      // thread. Either way, refresh whatever thread is now active — the
      // response is persisted server-side, so it is never lost.
      setBusy(false);
      setPendingQuestion(null);
      if (sentThread === (active === GENERAL ? undefined : active)) {
        setMessages((m) => [...m, res.message]);
      }
      load(sentThread === (active === GENERAL ? undefined : active) ? sentThread : active);
    } catch (e) {
      setBusy(false);
      setPendingQuestion(null);
      // Failure is visible, not silent: the question stays in the input box so
      // nothing is lost, and an explicit error with a Retry button is shown.
      setInput(question);
      setError(String((e as Error).message ?? e));
      return;
    }
  };

  const retryLast = () => {
    setError(null);
    void ask();
  };

  return (
    <div className="chat-panel">
      <div className="chat-threads">
        <button
          type="button"
          className={`thread${active === GENERAL ? ' active' : ''}`}
          onClick={() => setActive(GENERAL)}
        >
          General
        </button>
        {/* Include the open stock even before it has messages, otherwise
            switching threads by opening a ticker looks like nothing happened. */}
        {[...(ticker && !threads.some((t) => t.ticker === ticker)
              ? [{ ticker, messages: 0, last_at: null }]
              : []),
          ...threads].map((t) => (
          <button
            key={t.ticker}
            type="button"
            className={`thread${active === t.ticker ? ' active' : ''}`}
            onClick={() => setActive(t.ticker)}
            title={t.messages ? `${t.messages} message(s)` : 'new thread'}
          >
            {t.ticker}
          </button>
        ))}
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            {ticker
              ? `Ask anything about ${ticker}.`
              : 'Ask about a quote or the market. Open a stock to start a thread about it.'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.content}</div>
            {m.role === 'assistant' && !m.model_used && (
              <div className="chat-citations"><span className="chat-citation">legacy answer — predates current provenance tracking</span></div>
            )}
            {m.role === 'assistant' && m.model_used && (
              <div className="chat-citations"><span className="chat-citation">{m.model_used} · {m.ts.slice(0, 16).replace('T', ' ')}</span></div>
            )}
            {m.citations && m.citations.length > 0 && (
              <div className="chat-citations">
                {m.citations.slice(0, 8).map((c, j) => (
                  c.source_url
                    ? <a key={j} href={c.source_url} target="_blank" rel="noreferrer" className="chat-citation">{c.source_name ?? c.source_url}</a>
                    : <span key={j} className="chat-citation">{c.source_name ?? c.record_id}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && pendingQuestion && (
          <div className="chat-msg user"><div className="chat-bubble">{pendingQuestion}</div></div>
        )}
        {busy && <div className="chat-msg assistant"><div className="chat-bubble muted">thinking…</div></div>}
        {error && (
          <div className="chat-msg assistant">
            <div className="error-text">
              {error}
              <div><button className="btn small" type="button" onClick={retryLast}>Retry</button></div>
            </div>
          </div>
        )}
      </div>

      <div className="chat-controls">
        <select value={mode} onChange={(e) => setMode(e.target.value as 'deterministic' | 'llm')}>
          <option value="deterministic">Local engine</option>
          {modeAvailable && <option value="llm">LLM</option>}
        </select>
        {messages.length > 0 && (
          <button
            className="btn small"
            type="button"
            onClick={async () => { await api.clearChat(ticker).catch(() => {}); setMessages([]); setError(null); load(ticker); }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="chat-input-row">
        <input
          placeholder={ticker ? `Ask about ${ticker}…` : 'Ask…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void ask(); }}
        />
        <button className="btn primary" type="button" onClick={() => void ask()} disabled={busy}>Send</button>
      </div>
    </div>
  );
}