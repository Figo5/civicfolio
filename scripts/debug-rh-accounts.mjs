// Inspect get_accounts response to see the actual shape.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.civicfolio', 'robinhood-tokens.json'), 'utf8'));
const MCP = 'https://agent.robinhood.com/mcp/trading';
const H = () => ({ 'Content-Type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` });

function extractJson(text) {
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (line) return JSON.parse(line.slice(6));
  return JSON.parse(text);
}

const init = await fetch(MCP, { method: 'POST', headers: H(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'civicfolio-debug', version: '0.1.0' } } }) });
const sid = init.headers.get('mcp-session-id');
await init.text();
await fetch(MCP, { method: 'POST', headers: { ...H(), ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

const res = await fetch(MCP, { method: 'POST', headers: { ...H(), ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_accounts', arguments: {} } }) });
const json = extractJson(await res.text());
const content = json.result?.content ?? [];
for (const c of content) {
  if (c.type === 'text') {
    // Pretty-print the first text block, trimmed
    try {
      const parsed = JSON.parse(c.text);
      console.log(JSON.stringify(parsed, null, 1).slice(0, 2500));
    } catch {
      console.log(c.text.slice(0, 1500));
    }
  }
}