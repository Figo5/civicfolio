import { useEffect, useRef, useState } from 'react';
import { api, type ChatMessage } from '../api';

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [modeAvailable, setModeAvailable] = useState(false);
  const [mode, setMode] = useState<'deterministic' | 'llm'>('deterministic');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includePortfolio, setIncludePortfolio] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chat().then((r) => { setMessages(r.messages); setModeAvailable(r.mode_available); }).catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const ask = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    const userMsg: ChatMessage = { role: 'user', content: question, ts: new Date().toISOString() };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    try {
      const res = await api.ask(question, mode, mode === 'llm' && includePortfolio);
      setMessages((m) => [...m, res.message]);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setMessages((m) => m.slice(0, -1)); // roll back optimistic user msg on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Research Chat</h1>
        <p className="page-sub">
          Answers come from the local store only, with citations.<span className="sep">·</span>
          {modeAvailable
            ? 'LLM mode is configured on the server (labeled on each answer).'
            : 'LLM mode is not configured; deterministic mode needs no API key.'}
        </p>
      </div>

      <div className="chat-window card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="card-title" style={{ margin: 0 }}>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'deterministic' | 'llm')} style={{ width: 'auto' }}>
            <option value="deterministic">Deterministic (local engine — rule-based, not an LLM)</option>
            {modeAvailable && <option value="llm">LLM (configured endpoint)</option>}
          </select>
          {mode === 'llm' && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 12.5, color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={includePortfolio} onChange={(e) => setIncludePortfolio(e.target.checked)} style={{ width: 'auto' }} />
              Include my paper portfolio — sends your positions to the configured endpoint
            </label>
          )}
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              Try: "what data do you have?" · "what does the store say about ARRX?" · "typical publication delay?" ·
              "compare ARRX and HRZN" · "my portfolio concentration" · "show my paper trades"
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              <div className="chat-bubble">{m.content}</div>
              <div className="chat-meta">
                {m.role === 'assistant' && m.mode === 'deterministic' && <span className="badge neutral">deterministic</span>}
                {m.role === 'assistant' && m.mode === 'llm' && <span className="badge imported">llm</span>}
                <span>{new Date(m.ts).toLocaleTimeString()}</span>
              </div>
              {m.citations && m.citations.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                  {m.citations.map((c, j) => (
                    <span key={j} className="cite">
                      {c.source_url
                        ? <a href={c.source_url} target="_blank" rel="noreferrer" title={c.source_name ?? ''}>[{c.record_id}] ↗</a>
                        : <span className="cite-no-link" title={c.source_name ?? 'no source URL'}>[{c.record_id}]</span>}
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
            placeholder={busy ? 'Thinking…' : 'Ask about stored disclosures, delays, concentration…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
            disabled={busy}
          />
          <button className="btn primary" type="button" onClick={ask} disabled={busy || !input.trim()}>Ask</button>
        </div>
        <div className="note">
          Deterministic mode: rule-based computation over stored records — not an LLM, no external calls. Abstains when data is absent.
          Never invents prices, returns, or probabilities.
        </div>
      </div>
    </div>
  );
}