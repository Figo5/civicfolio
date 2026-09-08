import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type ChatThread } from '../api';

const GENERAL = '__general__';

/**
 * Side panel chat. One thread per stock, so a conversation about NVDA stays
 * separate from one about AMD — mixing them was what made the old single log
 * unreadable once more than one name was in play.
 */
export function ChatPanel() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [active, setActive] = useState<string>(GENERAL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modeAvailable, setModeAvailable] = useState(false);
  const [mode, setMode] = useState<'deterministic' | 'llm'>('llm');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const ticker = active === GENERAL ? undefined : active;

  const load = (t?: string) => {
    api.chat(t).then((r) => {
      setMessages(r.messages);
      setThreads(r.threads);
      setModeAvailable(r.mode_available);
    }).catch(() => {});
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

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: question, ts: new Date().toISOString() }]);
    setInput('');
    try {
      const res = await api.ask(question, mode, mode === 'llm', ticker);
      setMessages((m) => [...m, res.message]);
      load(ticker);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: String((e as Error).message ?? e), ts: new Date().toISOString() }]);
    } finally {
      setBusy(false);
    }
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
              : 'Ask about a quote or your positions. Open a stock to start a thread about it.'}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.content}</div>
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><div className="chat-bubble muted">thinking…</div></div>}
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
            onClick={async () => { await api.clearChat(ticker).catch(() => {}); setMessages([]); load(ticker); }}
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
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
        />
        <button className="btn primary" type="button" onClick={ask} disabled={busy}>Send</button>
      </div>
    </div>
  );
}
