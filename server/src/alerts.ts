// Robinhood alerts + portfolio via the Trading MCP.
//
// Price alerts set here land in the user's actual Robinhood app — push
// notifications come from Robinhood, not from this server, so nothing needs
// to run in the background.

import { mcpCallTool } from './robinhood.js';

export interface PriceAlert {
  symbol: string;
  direction: 'above' | 'below';
  price: number;
}

export async function createPriceAlert(symbol: string, direction: 'above' | 'below', price: number): Promise<{ ok: boolean; alert?: unknown; error?: string }> {
  if (!/^[A-Z]{1,10}$/.test(symbol)) return { ok: false, error: 'invalid ticker' };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'price must be a positive finite number' };
  const r = await mcpCallTool('create_alert', {
    symbol: symbol.toUpperCase(),
    price_trigger: String(price),
    trigger_direction: direction,
  });
  return r.ok ? { ok: true, alert: r.content } : { ok: false, error: r.error };
}

export async function listAlerts(): Promise<{ ok: boolean; alerts?: unknown; error?: string }> {
  return mcpCallTool('get_alerts', {});
}

export async function getPortfolio(): Promise<{ ok: boolean; portfolio?: unknown; error?: string }> {
  return mcpCallTool('get_portfolio', {});
}