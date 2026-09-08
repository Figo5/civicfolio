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
      <b>Live market data</b> — quotes, volume and earnings dates from the exchange; company figures from SEC
      filings; headlines from public news search. Each quote carries its own delay, so prices are indicative
      rather than a trading feed.
      {` · watching ${c.watchlist} · ${c.trades} paper trade(s) · stored in `}<code>{meta.data_dir}</code>
    </div>
  );
}