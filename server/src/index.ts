import { createApp } from './app.js';

// Civicfolio server bootstrap. Always binds 127.0.0.1 — never a public interface.

const PORT = Number(process.env.CIVICFOLIO_PORT || 8787);
const HOST = '127.0.0.1';

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`[civicfolio] API server listening on http://${HOST}:${PORT}`);
  console.log(`[civicfolio] data dir: ${process.env.CIVICFOLIO_DATA_DIR || '~/.civicfolio'}`);
});