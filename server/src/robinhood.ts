// Robinhood Trading MCP client.
//
// Official connector: https://agent.robinhood.com/mcp/trading
// Auth: OAuth 2.1 authorization-code + PKCE. Discovery endpoints (verified live):
//   /.well-known/oauth-protected-resource/mcp/trading  → authorization_servers
//   /.well-known/oauth-authorization-server/mcp/trading → authorization_endpoint,
//     token_endpoint, registration_endpoint (dynamic client registration)
// Callback: this server serves GET /robinhood/callback on 127.0.0.1:8787.
//
// Tokens live in ~/.civicfolio/robinhood-tokens.json (chmod 600, outside the
// repo). The browser never sees client secrets or tokens; it only ever gets
// "connected/not connected" status.
//
// Order safety: place_equity_order is NEVER called without a prior
// review_equity_order (pre-trade warnings) and the order being confirmed by
// the user in the UI. No automatic trading, ever.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDir } from './store.js';

const MCP_URL = 'https://agent.robinhood.com/mcp/trading';
const OAUTH_META_URL = 'https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading';
const REDIRECT_URI = 'http://127.0.0.1:8787/robinhood/callback';
const TIMEOUT_MS = 30_000;

export interface RobinhoodTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: string; // ISO
  token_type?: string;
  scope?: string;
  client_id?: string;
  obtained_at: string;
}

interface OAuthMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  code_challenge_methods_supported: string[];
}

let metaCache: OAuthMeta | null = null;

async function oauthMeta(): Promise<OAuthMeta> {
  if (metaCache) return metaCache;
  const res = await fetch(OAUTH_META_URL);
  if (!res.ok) throw new Error(`Robinhood OAuth discovery failed (${res.status})`);
  const body = await res.json() as OAuthMeta;
  metaCache = body;
  return body;
}

function tokensFile(): string {
  return path.join(dataDir(), 'robinhood-tokens.json');
}

function saveTokens(t: RobinhoodTokens): void {
  const file = tokensFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function readTokens(): RobinhoodTokens | null {
  try {
    return JSON.parse(fs.readFileSync(tokensFile(), 'utf8')) as RobinhoodTokens;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  try { fs.unlinkSync(tokensFile()); } catch { /* already gone */ }
}

export interface ConnectionState {
  connected: boolean;
  expires_at: string | null;
  has_refresh: boolean;
  account_hint: string | null; // never the token itself
}

export function connectionState(): ConnectionState {
  const t = readTokens();
  if (!t) return { connected: false, expires_at: null, has_refresh: false, account_hint: null };
  const hint = crypto.createHash('sha256').update(t.access_token).digest('hex').slice(0, 8);
  return {
    connected: true,
    expires_at: t.expires_at ?? null,
    has_refresh: Boolean(t.refresh_token),
    account_hint: `session ${hint}`,
  };
}

// ---- PKCE + authorization URL --------------------------------------------

export interface PendingAuth {
  state: string;
  code_verifier: string;
  client_id: string | null;
  authorization_url: string;
  created_at: string;
}

let pendingAuth: PendingAuth | null = null;

export async function beginAuthorization(): Promise<PendingAuth> {
  const meta = await oauthMeta();
  // Dynamic client registration (RFC 7591) — Robinhood advertises it.
  let clientId: string | null = null;
  try {
    const reg = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Civicfolio (local research app)',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // public client
      }),
    });
    if (reg.ok) {
      const body = await reg.json() as { client_id?: string };
      if (body.client_id) clientId = body.client_id;
    }
  } catch { /* fall through to manual flow */ }

  const state = crypto.randomBytes(16).toString('hex');
  const code_verifier = crypto.randomBytes(48).toString('base64url');
  const code_challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');

  const url = new URL(meta.authorization_endpoint);
  if (clientId) url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (meta.scopes_supported.length) url.searchParams.set('scope', meta.scopes_supported.join(' '));

  pendingAuth = { state, code_verifier, client_id: clientId, authorization_url: url.toString(), created_at: new Date().toISOString() };
  return pendingAuth;
}

export async function completeAuthorization(code: string, state: string): Promise<{ ok: boolean; error?: string }> {
  const pending = pendingAuth;
  if (!pending) return { ok: false, error: 'no authorization in progress — start it from the app first' };
  if (state !== pending.state) return { ok: false, error: 'state mismatch (possible CSRF) — authorization aborted' };
  const meta = await oauthMeta();
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pending.code_verifier,
  };
  if (pending.client_id) body.client_id = pending.client_id;
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `token exchange failed (${res.status}): ${text.slice(0, 300)}` };
  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { return { ok: false, error: 'token endpoint returned non-JSON' }; }
  const accessToken = json.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') return { ok: false, error: 'token response missing access_token' };
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : null;
  saveTokens({
    access_token: accessToken,
    ...(typeof json.refresh_token === 'string' ? { refresh_token: json.refresh_token } : {}),
    ...(expiresIn ? { expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
    token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    client_id: pending.client_id ?? undefined,
    obtained_at: new Date().toISOString(),
  });
  pendingAuth = null;
  return { ok: true };
}

// ---- MCP JSON-RPC ----------------------------------------------------------

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
  id?: number | string;
}

let sessionId: string | null = null;
let nextRpcId = 1;

async function mcpPost(payload: Record<string, unknown>): Promise<{ status: number; json?: Record<string, unknown>; body?: string; headers: Headers }> {
  const t = readTokens();
  if (!t) throw new Error('Robinhood is not connected — authorize first');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${t.access_token}`,
    };
    if (sessionIdStorage.session) headers['Mcp-Session-Id'] = sessionIdStorage.session;
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionIdStorage.session = sid;
    const text = await res.text();
    return { status: res.status, json: parseMcpBody(text), body: text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// The endpoint replies either as bare JSON or as SSE ("event: message\ndata: {...}").
function parseMcpBody(text: string): Record<string, unknown> | undefined {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { /* try SSE */ }
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  if (dataLine) {
    try { return JSON.parse(dataLine.slice(6).trim()) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return undefined;
}

// Session id survives across calls within one server process.
const sessionIdStorage: { session: string | null } = { session: null };

export async function mcpInitialize(): Promise<{ ok: boolean; error?: string; tools?: string[] }> {
  const res = await mcpPost({
    jsonrpc: '2.0', id: nextRpcId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'civicfolio', version: '0.1.0' },
    },
  });
  if (res.status === 401) return { ok: false, error: 'token expired or revoked — re-authorize' };
  if (!res.json || res.json.error) return { ok: false, error: `initialize failed: ${JSON.stringify(res.json?.error ?? res.body?.slice(0, 200))}` };
  // notifications/initialized per spec, then list tools so the UI can show them.
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const toolsRes = await mcpPost({ jsonrpc: '2.0', id: nextRpcId++, method: 'tools/list', params: {} });
  const tools = extractToolNames(toolsRes.json);
  return { ok: true, tools };
}

function extractToolNames(resJson: Record<string, unknown> | undefined): string[] {
  const result = resJson?.result as { tools?: { name?: string }[] } | undefined;
  return (result?.tools ?? []).map((t) => t.name ?? '').filter(Boolean);
}

type ToolResult = { ok: true; content?: unknown } | { ok: false; error: string };

export async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await mcpPost({
    jsonrpc: '2.0', id: nextRpcId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (res.status === 401) return { ok: false, error: 'unauthorized — re-authorize the Robinhood connection' };
  if (res.json?.error) return { ok: false, error: String((res.json.error as { message?: string }).message ?? 'tool call failed') };
  const result = res.json?.result as { content?: unknown; isError?: boolean } | undefined;
  if (result?.isError) return { ok: false, error: JSON.stringify(result.content ?? 'tool error').slice(0, 500) };
  return { ok: true, content: result?.content };
}

// ---- High-level API used by routes ----------------------------------------

export function isExpiredSoon(): boolean {
  const t = readTokens();
  if (!t?.expires_at) return false;
  return Date.parse(t.expires_at) - Date.now() < 5 * 60_000;
}

// The agentic MCP requires an explicit agentic-allowed account number on
// order tools. Their schema says use the account with agentic_allowed=true;
// there is exactly one. The response nests under data.accounts[].
let cachedAccount: string | null = null;

async function agenticAccountNumber(): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  if (cachedAccount) return { ok: true, account: cachedAccount };
  const r = await mcpCallTool('get_accounts', {});
  if (!r.ok) return { ok: false, error: r.error };
  // Tool content is an array of text blocks; the account list is JSON inside one.
  const blocks = Array.isArray(r.content) ? r.content : [r.content];
  for (const block of blocks) {
    const text = typeof (block as { text?: string })?.text === 'string' ? (block as { text?: string }).text as string : JSON.stringify(block ?? '');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const accounts = (parsed as { data?: { accounts?: Record<string, unknown>[] } })?.data?.accounts;
    if (Array.isArray(accounts)) {
      const agentic = accounts.find((a) => a.agentic_allowed === true && a.state === 'active');
      if (agentic && typeof agentic.account_number === 'string') {
        cachedAccount = agentic.account_number;
        return { ok: true, account: cachedAccount };
      }
      return { ok: false, error: 'no active account with agentic_allowed=true — Robinhood orders must go to an Agentic account. Open one at robinhood.com (agent onboarding) if you have not.' };
    }
    // Fallback: unstructured text with a single account number.
    const all = [...text.matchAll(/"account_number"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
    if (all.length === 1) {
      cachedAccount = all[0];
      return { ok: true, account: cachedAccount };
    }
    if (all.length > 1) {
      return { ok: false, error: 'multiple accounts found and none parse as agentic-allowed — cannot pick one automatically' };
    }
  }
  return { ok: false, error: 'get_accounts returned no parsable account data' };
}

export interface OrderInput {
  ticker: string;
  side: 'buy' | 'sell';
  quantity: number;
  kind?: 'market' | 'limit';
  limit_price?: number | null;
  client_id?: string;
}

/** Build tool arguments in Robinhood's declared schema (strings, `type` key). */
async function orderArgs(input: OrderInput): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; error: string }> {
  const acct = await agenticAccountNumber();
  if (!acct.ok) return acct;
  const args: Record<string, unknown> = {
    account_number: acct.account,
    symbol: input.ticker.toUpperCase(),
    side: input.side,
    type: input.kind ?? 'market',
    quantity: String(input.quantity), // schema: string, fractional allowed for market
    time_in_force: 'gfd',
  };
  if ((input.kind ?? 'market') === 'limit') {
    if (!input.limit_price || input.limit_price <= 0) return { ok: false, error: 'limit orders need a positive limit price' };
    args.limit_price = String(input.limit_price);
  }
  if (input.client_id) args.client_order_id = input.client_id;
  return { ok: true, args };
}

/** Simulate the order server-side and return pre-trade warnings. */
export async function reviewOrder(input: OrderInput): Promise<{ ok: boolean; review?: unknown; error?: string }> {
  const built = await orderArgs(input);
  if (!built.ok) return { ok: false, error: built.error };
  const r = await mcpCallTool('review_equity_order', built.args);
  return r.ok ? { ok: true, review: r.content } : { ok: false, error: r.error };
}

export async function placeOrder(input: OrderInput): Promise<{ ok: boolean; order?: unknown; error?: string }> {
  const built = await orderArgs(input);
  if (!built.ok) return { ok: false, error: built.error };
  const r = await mcpCallTool('place_equity_order', built.args);
  return r.ok ? { ok: true, order: r.content } : { ok: false, error: r.error };
}

async function getPortfolio(): Promise<{ ok: boolean; portfolio?: unknown; error?: string }> {
  return mcpCallTool('get_portfolio', {});
}

export async function getPositions(): Promise<{ ok: boolean; positions?: unknown; error?: string }> {
  return mcpCallTool('get_equity_positions', {});
}

export async function getQuotesRH(symbols: string[]): Promise<{ ok: boolean; quotes?: unknown; error?: string }> {
  return mcpCallTool('get_equity_quotes', { symbols: symbols.slice(0, 20) });
}

export { sessionIdStorage };