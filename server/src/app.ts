import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { load, update, save, resetDemo, resetEmpty, dataDir } from './store.js';
import { answerQuestion } from './research.js';
import { submitTrade, setMark, addIdea, addWatchlistItem, removeIdea, removeWatchlistItem, portfolioSummary } from './portfolio.js';
import { runImport, dedupeRecords } from './importAdapter.js';
import { getLlmConfig, callLlm, buildStoreContext } from './llm.js';
import { getQuotes } from './quotes.js';
import { getFundamentals } from './fundamentals.js';
import { buildProposals, buildTrends } from './proposals.js';
import { runResearchAgent, getAgentConfig } from './ollamaAgent.js';
import { cleanText } from './validate.js';
import type { AppData, ChatMessage } from './types.js';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5MB import cap

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const data = (): AppData => load();
  const fail = (res: express.Response, status: number, error: string): void => {
    res.status(status).json({ error });
  };

  // ---- mutation guards (Origin/Host/content-type) --------------------------
  // Localhost-only app: mutations must come from our own UI. Browsers always
  // send Origin on cross-origin requests; a missing Origin means a non-browser
  // client (curl etc.), which we allow for local API testing.
  // Allowed: this server's own loopback origin (built app) + the Vite dev
  // origin. No wildcard CORS.
  const OWN_PORT = String(process.env.CIVICFOLIO_PORT || 8787);
  const ALLOWED_ORIGINS = new Set([
    `http://127.0.0.1:${OWN_PORT}`,
    `http://localhost:${OWN_PORT}`,
    'http://127.0.0.1:5173', // vite dev
    'http://localhost:5173',
  ]);

  app.use((req, res, next) => {
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    // Host must be a loopback form (no DNS rebinding to other hosts).
    const host = String(req.headers.host ?? '');
    const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    if (!hostOk) {
      return fail(res, 403, `rejected: Host header must be loopback (got ${host || 'none'})`);
    }

    // Reads expose private local records too; validate Host before allowing them.
    if (!isMutation) return next();

    // Origin: when present it must be an exact allow-list match.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const originStr = Array.isArray(origin) ? origin[0] : origin;
      if (originStr !== '' && !ALLOWED_ORIGINS.has(originStr)) {
        return fail(res, 403, `rejected: Origin not allowed (${originStr})`);
      }
    }

    // Mutations must carry a JSON content type (blocks cross-origin form posts,
    // which are always application/x-www-form-urlencoded or multipart).
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ct)) {
      return fail(res, 415, 'mutations require Content-Type: application/json');
    }

    return next();
  });

  // ---- health ----
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'civicfolio', time: new Date().toISOString() });
  });

  // ---- meta ----
  app.get('/api/meta', (_req, res) => {
    const d = data();
    res.json({
      data_modes_present: [...new Set(d.disclosures.map((r) => r.data_mode))],
      counts: {
        disclosures_total: d.disclosures.length,
        disclosures_demo: d.disclosures.filter((r) => r.data_mode === 'demo').length,
        disclosures_imported: d.disclosures.filter((r) => r.data_mode !== 'demo').length,
        watchlist: d.watchlist.length,
        ideas: d.ideas.length,
        trades: d.trades.length,
        chat_messages: d.chat.length,
      },
      demo_loaded_at: d.meta.demo_loaded_at,
      imports: d.meta.imports,
      data_dir: dataDir(),
      llm_mode_available: getLlmConfig().enabled,
      robinhood: { status: 'not_configured', note: 'Brokerage execution is disabled. No credentials are read or stored.' },
    });
  });

  // ---- disclosures ----
  app.get('/api/disclosures', (req, res) => {
    const d = data();
    const rows = [...d.disclosures];
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

    let out = rows;
    const ticker = str(req.query.ticker)?.toUpperCase();
    if (ticker) out = out.filter((r) => r.ticker === ticker);

    const owner = str(req.query.owner);
    if (owner) out = out.filter((r) => r.owner.toLowerCase().includes(owner.toLowerCase()));

    const txType = str(req.query.tx_type)?.toLowerCase();
    if (txType && ['purchase', 'sale', 'exchange'].includes(txType)) {
      out = out.filter((r) => r.tx_type === txType);
    }

    const chamber = str(req.query.chamber);
    if (chamber === 'senate') out = out.filter((r) => r.owner_role.includes('Senator'));
    if (chamber === 'house') out = out.filter((r) => r.owner_role.includes('House'));

    const mode = str(req.query.data_mode);
    if (mode && ['demo', 'imported', 'live'].includes(mode)) {
      out = out.filter((r) => r.data_mode === mode);
    }

    const amendment = str(req.query.amendment);
    if (amendment === 'true') out = out.filter((r) => r.amendment === true);
    if (amendment === 'false') out = out.filter((r) => r.amendment === false);

    const from = str(req.query.published_from);
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) out = out.filter((r) => r.published_date >= from);
    const to = str(req.query.published_to);
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) out = out.filter((r) => r.published_date <= to);

    const ft = str(req.query.q)?.toLowerCase();
    if (ft) {
      out = out.filter((r) =>
        [r.ticker, r.company, r.owner, r.owner_role, r.notes ?? ''].join(' ').toLowerCase().includes(ft),
      );
    }

    res.json({
      data_mode_present: [...new Set(out.map((r) => r.data_mode))],
      count: out.length,
      records: out,
    });
  });

  // Company fundamentals from SEC EDGAR XBRL (official, keyless, filed data).
  // Failures are reasons, never invented figures. Cached 24h per CIK.
  app.get('/api/fundamentals', async (req, res) => {
    const raw = typeof req.query.ticker === 'string' ? req.query.ticker.trim() : '';
    if (!raw) return fail(res, 400, 'ticker query parameter is required');
    const result = await getFundamentals(raw);
    if ('reason' in result) return fail(res, 404, result.reason);
    res.json({ fundamentals: result });
  });

  // Stock proposals: transparent heuristic over stored disclosures. Buy-side
  // only; every proposal carries reasons, counterpoints, and record citations.
  app.get('/api/proposals', async (_req, res) => {
    res.json(await buildProposals(data()));
  });

  // What's trending across the stored window: most bought/sold, by volume, top filers.
  app.get('/api/trends', (_req, res) => {
    res.json(buildTrends(data()));
  });

  // Deep research on one ticker: Ollama Cloud agent with web_search tool.
  // Results cached ~6h per ticker; verdicts labeled with model + timestamp.
  const researchCache = new Map<string, { at: number; verdict: unknown }>();
  const RESEARCH_TTL = 6 * 60 * 60 * 1000;
  app.post('/api/research/:ticker', async (req, res) => {
    const cfg = getAgentConfig();
    if (!cfg.enabled) {
      return fail(res, 400, 'Research agent is disabled: set OLLAMA_API_KEY in server env to enable it.');
    }
    const ticker = String(req.params.ticker ?? '').trim().toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(ticker)) return fail(res, 400, 'invalid ticker');

    const cached = researchCache.get(ticker);
    if (cached && Date.now() - cached.at < RESEARCH_TTL) {
      return res.json({ verdict: cached.verdict, cached: true });
    }

    const proposals = await buildProposals(data());
    const proposal = proposals.proposals.find((p) => p.ticker === ticker);
    if (!proposal) return fail(res, 404, `no stored disclosure data for ${ticker} — nothing to research`);

    const fund = await getFundamentals(ticker);
    const fundSummary = 'cik' in fund
      ? `Revenue ${fund.revenue_usd ?? 'n/a'}, net income ${fund.net_income_usd ?? 'n/a'}, assets ${fund.assets_usd ?? 'n/a'}, equity ${fund.equity_usd ?? 'n/a'}, diluted EPS ${fund.diluted_eps ?? 'n/a'} — ${fund.source_form ?? 'filing'} filed ${fund.source_filed ?? 'unknown'} (${fund.company_name}).`
      : `Unavailable: ${fund.reason}`;

    const disclosureLines = proposals.proposals.length > 0
      ? `Records for ${ticker}: ${proposal.buys} purchase(s), ${proposal.sells} sale(s); ${proposal.buy_owners.length} distinct buyer(s): ${proposal.buy_owners.join(', ')}; aggregate filed range ${proposal.total_range_label}; latest filing published ${proposal.latest_published}.`
      : 'none';

    const result = await runResearchAgent({
      ticker,
      company: proposal.company,
      score: proposal.score,
      disclosure_summary: disclosureLines,
      fundamentals_summary: fundSummary,
    });
    if (!result.ok) return fail(res, 502, result.error);
    researchCache.set(ticker, { at: Date.now(), verdict: result.verdict });
    res.json({ verdict: result.verdict, cached: false });
  });

  // ---- chat ----
  app.get('/api/chat', (_req, res) => {
    const d = data();
    res.json({ mode_available: getLlmConfig().enabled, messages: d.chat.slice(-100) });
  });

  app.post('/api/chat', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = cleanText(body.question, 2000);
    if (!question) return fail(res, 400, 'question is required');
    const mode = body.mode === 'llm' ? 'llm' : 'deterministic';
    const d = data();

    if (mode === 'llm') {
      const cfg = getLlmConfig();
      if (!cfg.enabled) {
        return fail(res, 400, 'LLM mode not configured on the server. Deterministic mode works without any API key.');
      }
      // Minimal lower-trust projection: disclosures only, no user content.
      // Portfolio goes to the external endpoint only when the user asks for it.
      const includePortfolio = body.include_portfolio === true;
      const summary = includePortfolio ? portfolioSummary(d) : undefined;
      // Refresh marks from live quotes first so an assessment reasons about
      // current prices rather than whatever was last typed in.
      if (summary && summary.positions.length > 0) {
        const { quotes } = await getQuotes(summary.positions.map((p) => p.ticker));
        if (quotes.length > 0) {
          update((draft) => {
            for (const q of quotes) setMark(draft, { ticker: q.ticker, price: q.price, source: 'quote', quote_source: q.source });
            return { committed: true, value: null };
          });
        }
      }
      const fresh = includePortfolio ? portfolioSummary(load()) : undefined;
      const ctx = buildStoreContext({ disclosures: d.disclosures }, fresh && {
        cash_usd: fresh.cash_usd,
        positions: fresh.positions.map((p) => ({
          ticker: p.ticker, quantity: p.quantity, cost_basis_usd: p.cost_basis_usd, avg_cost: p.avg_cost,
          mark_price: p.mark_price, mark_source: p.mark_source, market_value_usd: p.market_value_usd,
          unrealized_pl_usd: p.unrealized_pl_usd, unrealized_pl_pct: p.unrealized_pl_pct,
        })),
        unrealized_pl_usd: fresh.unrealized_pl_usd,
      });
      const llmRes = await callLlm(cfg, question, ctx);
      if (!llmRes.ok) return fail(res, 502, llmRes.error ?? 'LLM request failed');
      const userMsg: ChatMessage = { role: 'user', content: question, ts: new Date().toISOString() };
      const msg: ChatMessage = {
        role: 'assistant', content: llmRes.content ?? '', mode: 'llm',
        citations: (llmRes.citations ?? []).map((c) => ({ record_id: c.record_id, source_url: null, source_name: c.source_name })),
        ts: new Date().toISOString(),
      };
      // LLM answers are lower-trust: store, but they only carry citations for
      // records that actually exist in the sent context.
      update((draft) => {
        draft.chat.push(userMsg, msg);
        return { committed: true, value: undefined as void };
      });
      return res.json({ message: msg });
    }

    const ans = answerQuestion(question, d);
    const userMsg: ChatMessage = { role: 'user', content: question, ts: new Date().toISOString() };
    const msg: ChatMessage = { role: 'assistant', content: ans.content, citations: ans.citations, mode: 'deterministic', ts: new Date().toISOString() };
    update((draft) => {
      draft.chat.push(userMsg, msg);
      return { committed: true, value: undefined as void };
    });
    res.json({ message: msg });
  });

  // Chat history is append-only and survives data reimports, so old answers
  // ("no data about MSFT") linger after the store has changed and read as
  // current. Let it be cleared without wiping the whole store.
  app.delete('/api/chat', (_req, res) => {
    const removed = update((draft) => {
      const n = draft.chat.length;
      draft.chat = [];
      return { committed: n > 0, value: n };
    });
    res.json({ ok: true, removed });
  });

  // ---- watchlist / ideas ----
  app.get('/api/ideas', (_req, res) => {
    res.json({ ideas: data().ideas });
  });

  app.get('/api/watchlist', (_req, res) => {
    res.json({ items: data().watchlist });
  });

  app.post('/api/watchlist', (req, res) => {
    const result = update((draft) => {
      const r = addWatchlistItem(draft, req.body);
      return r.ok ? { committed: true, value: r } : { committed: false, value: r };
    });
    if (!result.ok) return fail(res, 400, result.error ?? 'invalid watchlist item');
    res.json({ item: result.item });
  });

  app.delete('/api/watchlist/:id', (req, res) => {
    const removed = update((draft) => {
      const before = draft.watchlist.length;
      draft.watchlist = draft.watchlist.filter((w) => w.id !== req.params.id);
      return { committed: draft.watchlist.length < before, value: draft.watchlist.length < before };
    });
    if (!removed) return fail(res, 404, 'watchlist item not found');
    res.json({ ok: true });
  });

  app.post('/api/ideas', (req, res) => {
    const result = update((draft) => {
      const r = addIdea(draft, req.body);
      return r.ok ? { committed: true, value: r } : { committed: false, value: r };
    });
    if (!result.ok) return fail(res, 400, result.error ?? 'invalid idea');
    res.json({ idea: result.idea });
  });

  app.delete('/api/ideas/:id', (req, res) => {
    const removed = update((draft) => {
      const before = draft.ideas.length;
      draft.ideas = draft.ideas.filter((i) => i.id !== req.params.id);
      return { committed: draft.ideas.length < before, value: draft.ideas.length < before };
    });
    if (!removed) return fail(res, 404, 'idea not found');
    res.json({ ok: true });
  });

  // ---- portfolio ----
  app.get('/api/portfolio', (_req, res) => {
    res.json(portfolioSummary(data()));
  });

  app.get('/api/portfolio/trades', (_req, res) => {
    res.json({ trades: [...data().trades].reverse() });
  });

  app.post('/api/portfolio/trades', (req, res) => {
    const result = update((draft) => {
      const r = submitTrade(draft, req.body);
      return r.ok ? { committed: true, value: r } : { committed: false, value: r };
    });
    if (!result.ok) return fail(res, 400, result.error ?? 'invalid trade');
    res.json({ trade: result.trade, portfolio: portfolioSummary(load()), duplicate: result.duplicate === true });
  });
  // Live quotes. Delayed, unofficial, best-effort: unresolvable symbols come
  // back under `failed` rather than as a fabricated price.
  app.get('/api/quotes', async (req, res) => {
    const raw = typeof req.query.tickers === 'string' ? req.query.tickers : '';
    const tickers = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (tickers.length === 0) return fail(res, 400, 'tickers query parameter is required (comma separated)');
    const { quotes, failed } = await getQuotes(tickers);
    res.json({
      quotes,
      failed,
      fetched_at: new Date().toISOString(),
      disclaimer: 'Delayed, unofficial market data from a public endpoint. Not a real-time trading feed.',
    });
  });

  // Value every open position from live quotes in one call, tagging each mark
  // as quote-sourced so it is never mistaken for a price you entered.
  app.post('/api/portfolio/marks/refresh', async (_req, res) => {
    const tickers = Object.keys(load().portfolio.positions);
    if (tickers.length === 0) return res.json({ updated: 0, failed: [], portfolio: portfolioSummary(load()) });

    const { quotes, failed } = await getQuotes(tickers);
    const out = update((draft) => {
      let updated = 0;
      for (const q of quotes) {
        const r = setMark(draft, { ticker: q.ticker, price: q.price, source: 'quote', quote_source: q.source });
        if (r.ok) updated += 1;
      }
      return { committed: updated > 0, value: updated };
    });
    res.json({ updated: out, failed, portfolio: portfolioSummary(load()) });
  });

  // Mark prices: user-entered valuations for held positions. Not market data.
  app.post('/api/portfolio/marks', (req, res) => {
    const out = update<{ status: number; body: unknown }>((draft) => {
      const result = setMark(draft, req.body);
      if (!result.ok) return { committed: false, value: { status: 400, body: { error: result.error ?? 'invalid mark' } } };
      return { committed: true, value: { status: 200, body: { portfolio: portfolioSummary(draft) } } };
    });
    res.status(out.status).json(out.body);
  });

  // ---- import ----
  app.post('/api/disclosures/import', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = body.text;
    if (typeof text !== 'string' || text.length === 0) return fail(res, 400, 'text field with file content is required');
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
      return fail(res, 413, `import too large (max ${MAX_IMPORT_BYTES / 1024 / 1024}MB)`);
    }
    let kind: 'json' | 'csv' = 'json';
    if (body.kind !== undefined) {
      if (body.kind !== 'json' && body.kind !== 'csv') return fail(res, 400, 'kind must be "json" or "csv"');
      kind = body.kind;
    }
    const idPrefix = 'imp-' + Date.now().toString(36);
    const { report, records } = runImport(text, kind, idPrefix);
    if (records.length === 0) {
      const structural = report.errors.some((e) => e.row === 0);
      return res.status(structural ? 400 : 207).json({ report, imported_count: 0 });
    }
    const outcome = update((draft) => {
      const { unique, duplicates } = dedupeRecords(records, draft.disclosures);
      const rowErrors = duplicates.map((r, i) => ({ row: -(i + 1), message: `duplicate skipped: ${r.ticker} ${r.owner} ${r.tx_date_min}..${r.tx_date_max}` }));
      if (unique.length > 0) {
        draft.disclosures.push(...unique);
        draft.meta.imports.push({ filename: kind === 'json' ? 'pasted-json' : 'pasted-csv', imported_at: new Date().toISOString(), count: unique.length });
      }
      const finalReport = {
        ...report,
        added: unique.length,
        skipped: report.skipped + duplicates.length,
        errors: [...report.errors, ...rowErrors],
        ok: report.errors.length === 0 && duplicates.length === 0 ? true : (unique.length + duplicates.length === 0),
      };
      return { committed: unique.length > 0, value: { finalReport, imported: unique.length } };
    });
    const { finalReport, imported } = outcome;
    const structural = finalReport.errors.some((e) => e.row === 0);
    res.status(structural ? 400 : finalReport.ok ? 200 : 207).json({ report: finalReport, imported_count: imported });
  });

  // ---- demo reset controls ----
  app.post('/api/demo/load', (_req, res) => {
    const d = resetDemo();
    res.json({
      ok: true,
      counts: {
        disclosures: d.disclosures.length,
        watchlist: d.watchlist.length,
        ideas: d.ideas.length,
        trades: d.trades.length,
      },
    });
  });

  app.post('/api/demo/clear', (_req, res) => {
    resetEmpty();
    res.json({ ok: true, counts: { disclosures: 0, watchlist: 0, ideas: 0, trades: 0 } });
  });

  // ---- settings (no secrets) ----
  app.get('/api/settings', (_req, res) => {
    const llm = getLlmConfig();
    const d = data();
    res.json({
      data_mode: d.disclosures.some((r) => r.data_mode === 'demo')
        ? 'demo'
        : d.disclosures.some((r) => r.data_mode !== 'demo')
          ? 'imported'
          : 'empty',
      providers: {
        deterministic_engine: {
          status: 'configured',
          note: 'Local deterministic engine. No API key, no external calls.',
        },
        llm_endpoint: {
          status: llm.enabled ? 'configured' : 'not_configured',
          has_key: llm.hasKey,
          model_when_configured: llm.enabled ? llm.model : undefined,
          advisor_mode: llm.advisorMode,
          advisor_mode_note: llm.advisorMode === 'advisor'
            ? 'Advisor mode: gives direct recommendations with conviction and sizing. Set by you in server env.'
            : 'Analyst mode (default): lays out considerations without directive buy/sell calls. Set CIVICFOLIO_ADVISOR_MODE=advisor to change.',
          base_url_when_configured: llm.enabled ? llm.baseUrl : undefined,
          note: llm.enabled
            ? 'OpenAI-compatible endpoint configured via server env. Key never exposed to the frontend. Only a minimized disclosure summary is sent (never your ideas, watchlist, trades, or portfolio); content is delimited as untrusted data and citations are limited to records actually present in the context.'
            : 'Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL / OPENAI_MODEL) in server env to enable. Never in browser storage.',
        },
      },
      data: { dir: dataDir(), demo_loaded_at: d.meta.demo_loaded_at, imports: d.meta.imports },
      robinhood: {
        status: 'not_configured',
        note: 'Robinhood Agentic MCP is a possible future connector. Brokerage execution remains disabled; no credentials are read or stored.',
      },
    });
  });

  // ---- static frontend (production build) ----
  const dist = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) return fail(res, 404, 'not found');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // ---- 404 + error handler ----
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) fail(res, 404, 'not found');
    else res.status(404).send('not found');
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (typeof err === 'object' && err !== null) {
      const e = err as { type?: string; status?: number };
      if (e.type === 'entity.too.large') return fail(res, 413, 'request body too large');
      if (e.type === 'entity.parse.failed') return fail(res, 400, 'malformed JSON body');
    }
    console.error('[civicfolio] error:', err instanceof Error ? err.message : String(err));
    fail(res, 500, 'internal error');
  });

  return app;
}
