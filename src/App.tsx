import { useEffect, useState } from 'react';
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
        <SectionNav />
        <div className="sidebar-footer">
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            {meta ? `${meta.counts.disclosures_total} filings · updated daily` : 'loading…'}
          </span>
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

const SECTIONS = [
  { id: 'proposals', label: 'Proposals' },
  { id: 'trends', label: 'Most bought / sold' },
  { id: 'ask', label: 'Ask about the data' },
];

function SectionNav() {
  const [active, setActive] = useState('proposals');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        // Topmost visible section wins, so the highlight tracks reading position
        // rather than flickering between whichever fired last.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="section-nav" aria-label="Sections">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className={`section-link${active === s.id ? ' active' : ''}`}
          aria-current={active === s.id ? 'true' : undefined}
          // No preventDefault: the native anchor jump always works, including
          // where smooth scrolling is disabled or unavailable. CSS handles the
          // easing. Setting active here is just immediate feedback before the
          // observer catches up.
          onClick={() => setActive(s.id)}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
