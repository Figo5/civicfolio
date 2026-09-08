import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage } from '../api';

/**
 * The chat: one box, one conversation. Questions about any ticker work —
 * naming a ticker grounds the answer in that stock's live data, no thread
 * picking needed. Async correctness: an in-flight request renders only into
 * this one view, so there is no cross-thread race by construction.
 */
export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.chat().then((r) => {
      setMessages(r.messages);
      setError(null);
    }).catch((e) => setError(String((e as Error).message ?? e)));
  };

  useEffect(() => { load(); }, []);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [messages, pendingQuestion]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return; // duplicate-send guard: one request at a time
    setBusy(true);
    setError(null);
    setPendingQuestion(question);
    setInput('');
    try {
      const res = await api.ask(question, 'llm');
      setBusy(false);
      setPendingQuestion(null);
      setMessages((m) => [...m, res.message]);
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
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && !busy && (
          <div className="empty-state">Ask anything — a ticker, the market, whatever you're researching.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.content}</div>
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

      {messages.length > 0 && (
        <div className="chat-controls">
          <button
            className="btn small"
            type="button"
            onClick={async () => { await api.clearChat().catch(() => {}); setMessages([]); setError(null); }}
          >
            Clear
          </button>
        </div>
      )}

      <div className="chat-input-row">
        <input
          placeholder="Ask…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void ask(); }}
        />
        <button className="btn primary" type="button" onClick={() => void ask()} disabled={busy}>Send</button>
      </div>
    </div>
  );
}