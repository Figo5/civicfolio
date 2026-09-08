import { useMeta } from './shell';
import { OnePage } from './pages/OnePage';
import { ChatPanel } from './pages/ChatPanel';

export default function App() {
  const { meta } = useMeta();
  return (
    <div className="app">
      <main className="main">
        <OnePage />
      </main>
      <aside className="chat-side">
        <ChatPanel />
      </aside>
      {/* meta is loaded for the data dir shown in settings-less builds */}
      <span hidden>{meta?.data_dir}</span>
    </div>
  );
}
