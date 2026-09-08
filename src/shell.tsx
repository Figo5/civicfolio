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
  const demo = meta.counts.disclosures_demo;
  const imported = meta.counts.disclosures_imported;
  return (
    <div className="provenance" style={{ marginBottom: 18 }}>
      <b>Data mode:</b>{' '}
      {demo > 0 && imported > 0
        ? `mixed — ${demo} synthetic demo records + ${imported} imported records`
        : demo > 0
          ? 'demo — synthetic records with fictional owners, labeled prices'
          : imported > 0
            ? 'imported — user-supplied data with per-record sources'
            : 'empty — no disclosures loaded'}{' '}
      · {meta.counts.disclosures_total} disclosure records · refreshed daily at 08:30 · stored in <code>{meta.data_dir}</code>
    </div>
  );
}