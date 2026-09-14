import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.js';

// Civicfolio server bootstrap. Always binds 127.0.0.1 — never a public interface.

// Load local secrets from ~/.civicfolio/env (KEY=value lines). Lives outside
// the repo, never tracked. Real environment variables win over the file.
const envFile = path.join(os.homedir(), '.civicfolio', 'env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const PORT = Number(process.env.CIVICFOLIO_PORT || 8787);
const HOST = '127.0.0.1';

const app = createApp();
app.listen(PORT, HOST, () => {
  console.log(`[civicfolio] API server listening on http://${HOST}:${PORT}`);
  console.log(`[civicfolio] data dir: ${process.env.CIVICFOLIO_DATA_DIR || '~/.civicfolio'}`);
  console.log(process.env.OPENAI_API_KEY?.trim()
    ? '[civicfolio] AI: enabled (OpenAI, server-side key)'
    : '[civicfolio] AI: disabled — set OPENAI_API_KEY in .env or ~/.civicfolio/env to enable research and LLM chat');
});