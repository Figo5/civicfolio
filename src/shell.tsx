import { useEffect, useState } from 'react';
import { api, type Meta } from './api';

export type Page = 'one';

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => api.meta().then(setMeta).catch((e) => setError(String(e)));
  useEffect(() => { refresh(); }, []);
  return { meta, error, refresh };
}

export function ModeBanner({ meta }: { meta: Meta | null }) {
  if (!meta) return null;
  const c = meta.counts;
  return (
    <div className="provenance" style={{ marginBottom: 18 }}>
      <b>Research-only.</b> Civicfolio places no orders and connects to no broker — there is no trading
      feature here. Quotes, volume and earnings dates come from a delayed, unofficial public market
      endpoint; company figures from SEC filings; headlines from public news search. Each quote carries
      its own delay, so prices are indicative rather than a trading feed.
      {` · watching ${c.watchlist} · stored in `}<code>{meta.data_dir}</code>
    </div>
  );
}

export function ExternalProcessingNotice() {
  return (
    <p className="provenance" style={{ marginTop: 6 }}>
      <b>External processing:</b> AI research and LLM chat send your question (plus fetched market
      data and, in a stock thread, that thread&apos;s recent messages) to an external cloud model
      endpoint — even though this app runs on localhost — and, for research, to a web-search
      provider. Nothing is executed and no orders are possible; no portfolio, positions, or other
      threads are ever sent.
    </p>
  );
}

export function StatusPanel() {
  const [s, setS] = useState<Awaited<ReturnType<typeof api.settings>> | null>(null);
  useEffect(() => { api.settings().then(setS).catch(() => {}); }, []);
  if (!s) return null;
  const agent = s.providers.research_agent;
  return (
    <p className="provenance" style={{ marginTop: 4 }}>
      {agent?.model ?? 'model not configured'}
      {agent?.web_search ? ' · web search on' : ' · web search off'}
    </p>
  );
}