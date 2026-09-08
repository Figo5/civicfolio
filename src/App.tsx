import { useEffect, useState } from 'react';
import { type DisclosureRecord, fmtUsd, fmtDate } from './api';
import { Sidebar, useMeta, ModeBanner, type Page } from './shell';
import { OverviewPage } from './pages/Overview';
import { DisclosuresPage } from './pages/Disclosures';
import { ChatPage } from './pages/Chat';
import { PortfolioPage } from './pages/Portfolio';
import { SettingsPage } from './pages/Settings';

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const { meta, refresh } = useMeta();

  // refresh meta when navigating so mode pill / banner stay accurate
  useEffect(() => { refresh(); }, [page]);

  return (
    <div className="app">
      <Sidebar page={page} onNavigate={setPage} meta={meta} />
      <main className="main">
        <ModeBanner meta={meta} />
        {page === 'overview' && <OverviewPage meta={meta} onNavigate={setPage} refreshMeta={refresh} />}
        {page === 'disclosures' && <DisclosuresPage meta={meta} />}
        {page === 'chat' && <ChatPage />}
        {page === 'portfolio' && <PortfolioPage refreshMeta={refresh} />}
        {page === 'settings' && <SettingsPage meta={meta} refreshMeta={refresh} />}
      </main>
    </div>
  );
}

// Shared small components used by pages:
export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function ModeBadge({ mode }: { mode: DisclosureRecord['data_mode'] }) {
  const label = mode === 'demo' ? 'demo' : mode === 'imported' ? 'imported' : 'live';
  return <span className={`badge ${mode}`}>{label}</span>;
}

export function TradeSideBadge({ side }: { side: 'BUY' | 'SELL' }) {
  return <span className={`badge ${side === 'BUY' ? 'buy' : 'sell'}`}>{side}</span>;
}

export { fmtUsd, fmtDate };