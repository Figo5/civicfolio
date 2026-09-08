import { type DisclosureRecord, fmtUsd, fmtDate } from './api';
import { useMeta, ModeBanner } from './shell';
import { OnePage } from './pages/OnePage';

export default function App() {
  const { meta, refresh } = useMeta();
  void refresh; // meta refreshes on mount; no multi-page nav anymore

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">Civicfolio</div>
          <div className="brand-sub">disclosure research · daily</div>
        </div>
        <div className="sidebar-footer">
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>one page · nothing to configure</span>
        </div>
      </aside>
      <main className="main">
        <ModeBanner meta={meta} />
        <OnePage />
      </main>
    </div>
  );
}

// Shared badge used by the proposals table:
export function ModeBadge({ mode }: { mode: DisclosureRecord['data_mode'] }) {
  const label = mode === 'demo' ? 'demo' : mode === 'imported' ? 'imported' : 'live';
  return <span className={`badge ${mode}`}>{label}</span>;
}

export { fmtUsd, fmtDate };