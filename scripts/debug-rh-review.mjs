// Debug: raw MCP review_equity_order call to see the actual response shape.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.civicfolio', 'robinhood-tokens.json'), 'utf8'));
const MCP = 'https://agent.robinhood.com/mcp/trading';

const init = await fetch(MCP, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'civicfolio-debug', version: '0.1.0' } } }),
});
const sid = init.headers.get('mcp-session-id');
await init.text();
console.log('init status:', init.status, '| session:', sid);

await fetch(MCP, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});

const res = await fetch(MCP, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'review_equity_order', arguments: { symbol: 'AAPL', side: 'buy', quantity: 1, order_type: 'market' } } }),
});
console.log('review status:', res.status);
const text = await res.text();
console.log('body:', text.slice(0, 1200));