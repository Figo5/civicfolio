// DETERMINISTIC ENGINE (not an LLM, and never presented as one)
//
// Answers from data the app actually holds: your watchlist, your paper
// positions, and live quotes. It computes; it does not opine. Anything
// requiring judgement is handed to the research agent instead.
//
// Rules:
//  - never invent a price, return, target or probability
//  - say plainly when the answer is not derivable and what would provide it
//  - every figure traces to a quote timestamp or a stored record

import type { AppData, ChatCitation } from './types.js';
import { getQuotes } from './quotes.js';
import { buildInsights } from './insights.js';

export interface EngineAnswer {
  content: string;
  citations: ChatCitation[];
  confidence: 'deterministic';
}

function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const answer = (content: string, citations: ChatCitation[] = []): EngineAnswer => ({
  content,
  citations,
  confidence: 'deterministic',
});

const HELP = [
  'I sort and quote from live market data. Try:',
  '- "what should i buy?" — today\'s highest-scoring ideas',
  '- "quote NVDA" or just "NVDA"',
  '- "how is my portfolio doing?"',
  '',
  'For a judgement call with entry and exit levels, open a ticker and press Research — that runs the AI agent.',
].join('\n');

const STOPWORDS = new Set([
  'A', 'AN', 'AND', 'ARE', 'AS', 'AT', 'BE', 'BUY', 'BY', 'CAN', 'DO', 'DOES', 'DOING',
  'FOR', 'FROM', 'GET', 'GOOD', 'HAS', 'HAVE', 'HOW', 'I', 'IF', 'IN', 'IS', 'IT', 'ITS',
  'LONG', 'ME', 'MY', 'NOW', 'OF', 'ON', 'OR', 'OUT', 'SELL', 'SHOULD', 'SHOW', 'SO',
  'STOCK', 'STOCKS', 'TELL', 'THAT', 'THE', 'THEN', 'THIS', 'TO', 'UP', 'US', 'WHAT',
  'WHEN', 'WHERE', 'WHICH', 'WHY', 'WILL', 'WITH', 'YOU', 'YOUR', 'PRICE', 'QUOTE',
  'WORTH', 'MUCH', 'MANY', 'ANY', 'ALL', 'NOT', 'NO', 'YES', 'OK', 'HOLD', 'ABOUT',
]);

export async function answerQuestion(question: string, data: AppData, threadTicker?: string): Promise<EngineAnswer> {
  const q = question.toLowerCase();

  // Explicit refusal: prediction is not something arithmetic can supply.
  if (/(will .* go (up|down)|forecast|predict|price target|probability|guarantee)/.test(q)) {
    return answer(
      'I abstain: I do not forecast prices, set targets, or estimate probabilities — none of that is derivable from the data here.\n\n' +
      'I can give you the current quote, your position and its unrealized P&L, and your concentration. ' +
      'For a judgement call with entry and exit levels, run Research on the ticker; that uses the AI agent and shows which levels are grounded in real data.',
    );
  }

  // ---- what should I buy: surface today's screened ideas ---------------
  // The most natural question for this app. The arithmetic screen already
  // exists (insights.ts) — the chat just never learned about it.
  if (/(what should i buy|what to buy|any ideas|good (buy|stock|idea)|stock ideas?|top picks?|best scoring)/.test(q)) {
    const board = await buildInsights();
    const picks = board.best_buys.slice(0, 5);
    if (picks.length === 0) {
      return answer('The market screen found nothing worth a closer look right now — flat day, or the data feed is warming up. Try again after the next refresh.');
    }
    const lines = picks.map((p) =>
      `- ${p.ticker} (${p.name}) — score ${p.score}. ${p.reasons.slice(0, 2).join('; ')}.` +
      (p.cautions.length > 0 ? ` Watch out: ${p.cautions[0]}.` : ''),
    );
    return answer(
      `Today's highest-scoring ideas from the live market screen (universe of ${board.universe_size} movers):\n` +
      lines.join('\n') +
      '\n\nScores are arithmetic over observable facts — volume, range position, trend — not predictions. ' +
      'Open a ticker and run Research for the AI verdict with entry/exit levels before acting.',
      picks.map((p) => ({ record_id: p.ticker, source_name: 'live market screen' })),
    );
  }

  const tickers = [...new Set((question.toUpperCase().match(/\b[A-Z]{1,10}\b/g) ?? []))];
  const held = new Set(Object.keys(data.portfolio.positions));
  const watched = new Set(data.watchlist.map((w) => w.ticker));

  // ---- portfolio -----------------------------------------------------
  if (/(portfolio|position|holding|how am i doing|p&l|pnl|profit|loss|concentration|allocation)/.test(q)) {
    const entries = Object.entries(data.portfolio.positions);
    if (entries.length === 0) {
      return answer(
        `No open paper positions. Cash is ${usd(data.portfolio.cash_usd)}.\n` +
        'Record a paper trade to start tracking one.',
      );
    }
    const { quotes, failed } = await getQuotes(entries.map(([t]) => t));
    const priceOf = new Map(quotes.map((x) => [x.ticker, x.price]));

    let cost = 0;
    let value = 0;
    const lines: string[] = [];
    for (const [ticker, pos] of entries) {
      cost += pos.cost_basis_usd;
      const px = priceOf.get(ticker);
      const mv = typeof px === 'number' ? px * pos.quantity : null;
      if (mv !== null) value += mv;
      else value += pos.cost_basis_usd; // no quote: hold at cost rather than guess
      const pl = mv === null ? null : mv - pos.cost_basis_usd;
      lines.push(
        `- ${ticker}: ${pos.quantity} sh, cost ${usd(pos.cost_basis_usd)}` +
        (mv === null
          ? ' — no quote available, counted at cost'
          : `, now ${usd(mv)} (${pl! >= 0 ? '+' : ''}${usd(pl!)}, ${((pl! / pos.cost_basis_usd) * 100).toFixed(1)}%)`),
      );
    }
    const total = value - cost;
    const sorted = [...entries].sort((a, b) => b[1].cost_basis_usd - a[1].cost_basis_usd);
    const account = value + data.portfolio.cash_usd;
    const topPct = account > 0 ? ((sorted[0][1].cost_basis_usd / account) * 100).toFixed(1) : '0.0';

    return answer(
      `Paper portfolio — ${entries.length} position(s), cash ${usd(data.portfolio.cash_usd)}.\n` +
      lines.join('\n') +
      `\n\nCost ${usd(cost)} → value ${usd(value)} (${total >= 0 ? '+' : ''}${usd(total)}).` +
      `\nAccount total ${usd(account)}. Largest position ${sorted[0][0]} at ${topPct}% of it.` +
      (failed.length > 0 ? `\n\nNo quote for: ${failed.map((f) => f.ticker).join(', ')}.` : '') +
      '\n\nQuotes are delayed and unofficial. Paper trading only — these are not real holdings.',
    );
  }

  // ---- watchlist -----------------------------------------------------
  if (/(watchlist|watch list|watching|my list|ideas?)/.test(q)) {
    if (data.watchlist.length === 0 && data.ideas.length === 0) {
      return answer('Your watchlist and ideas are both empty. Add a ticker to start tracking one.');
    }
    const { quotes } = await getQuotes(data.watchlist.map((w) => w.ticker));
    const priceOf = new Map(quotes.map((x) => [x.ticker, x]));
    const lines = data.watchlist.map((w) => {
      const qt = priceOf.get(w.ticker);
      return `- ${w.ticker}: ${qt ? usd(qt.price) : 'no quote'}${w.thesis ? ` — ${w.thesis}` : ''}`;
    });
    const ideaLines = data.ideas.map((i) => `- ${i.ticker} (${i.status}): ${i.thesis}`);
    return answer(
      (lines.length ? `Watchlist (${lines.length}):\n${lines.join('\n')}` : 'Watchlist is empty.') +
      (ideaLines.length ? `\n\nIdeas (${ideaLines.length}):\n${ideaLines.join('\n')}` : ''),
      data.watchlist.map((w) => ({ record_id: w.id, source_name: 'local watchlist' })),
    );
  }

  // ---- trade journal --------------------------------------------------
  if (/(trade|traded|journal|bought|sold|order)/.test(q)) {
    if (data.trades.length === 0) return answer('No paper trades recorded yet.');
    const buys = data.trades.filter((t) => t.side === 'BUY').length;
    return answer(
      `Paper trade journal: ${data.trades.length} trade(s) — ${buys} BUY, ${data.trades.length - buys} SELL.\n` +
      data.trades.slice(-8).reverse()
        .map((t) => `- [${t.trade_date}] ${t.side} ${t.quantity} ${t.ticker} @ ${usd(t.price)} (${t.price_source === 'demo' ? 'demo-labeled' : 'you entered'})`)
        .join('\n') +
      '\n\nAll prices are values you entered, never market data.',
      data.trades.slice(-8).map((t) => ({ record_id: t.id, source_name: 'paper trade journal' })),
    );
  }

  // ---- quote lookup ---------------------------------------------------
  // English words are indistinguishable from tickers by shape, so a plain
  // /[A-Z]+/ scan turns "what is the price of X" into a lookup for WHAT, THE
  // and OF. Filter aggressively; a missed ticker just falls through to help,
  // whereas a false one produces four confusing "no quote" lines.
  let candidates = tickers.filter((t) => !STOPWORDS.has(t));
  // Inside a stock's thread, a bare "quote" or "how's it doing" means THAT
  // stock. Without this the thread context is decorative.
  if (candidates.length === 0 && threadTicker) candidates = [threadTicker];
  if (candidates.length > 0) {
    const { quotes, failed } = await getQuotes(candidates.slice(0, 5));
    if (quotes.length === 0) {
      return answer(
        `No quote for ${failed.map((f) => f.ticker).join(', ') || candidates.join(', ')}.\n` +
        (failed[0]?.reason ? `Reason: ${failed[0].reason}\n` : '') +
        'Check the symbol, or ask something else — see the examples below.\n\n' + HELP,
      );
    }
    const lines = quotes.map((qt) => {
      const chg = qt.previous_close ? ((qt.price - qt.previous_close) / qt.previous_close) * 100 : null;
      const where = held.has(qt.ticker) ? ' — you hold this' : watched.has(qt.ticker) ? ' — on your watchlist' : '';
      return `- ${qt.ticker}: ${usd(qt.price)}${chg !== null ? ` (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% vs previous close)` : ''} on ${qt.exchange ?? 'exchange'}${where}`;
    });
    return answer(
      lines.join('\n') +
      `\n\nAs of ${quotes[0].as_of}. Delayed, unofficial data — not a trading feed.` +
      '\nFor a view on entry and exit levels, run Research on the ticker.',
      quotes.map((qt) => ({ source_name: `quote (${qt.source})`, source_url: null })),
    );
  }

  return answer(HELP);
}
