import { useEffect, useState } from 'react';
import { api, type Meta } from './api';

export type Page = 'overview' | 'disclosures' | 'chat' | 'portfolio' | 'settings';

const NAV: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'disclosures', label: 'Disclosures' },
  { id: 'chat', label: 'Research Chat' },
  { id: 'portfolio', label: 'Paper Portfolio' },
  { id: 'settings', label: 'Settings' },
];

export function Sidebar({ page, onNavigate, meta }: { page: Page; onNavigate: (p: Page) => void; meta: Meta | null }) {
  const mode = meta?.data_modes_present?.[0] ?? 'empty';
  const modeLabel = mode === 'demo' ? 'Demo data' : mode === 'imported' ? 'Imported data' : mode === 'live' ? 'Live data' : 'No data';
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-name">Civicfolio</div>
        <div className="brand-sub">local research · paper only</div>
      </div>
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`nav-item ${page === n.id ? 'active' : ''}`}
          onClick={() => onNavigate(n.id)}
          type="button"
        >
          <span className="nav-dot" />
          <span className="label">{n.label}</span>
        </button>
      ))}
      <div className="sidebar-footer">
        <span className={`mode-pill ${mode}`}>
          <span className="mode-dot" />
          <span className="txt">{modeLabel}</span>
        </span>
      </div>
    </aside>
  );
}

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
      · {meta.counts.disclosures_total} disclosure records · stored in <code>{meta.data_dir}</code>
    </div>
  );
}