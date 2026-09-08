import type { AppData, DisclosureRecord, ChatCitation } from './types.js';

// DETERMINISTIC RESEARCH ENGINE (not an LLM, and never presented as one)
//
// Rules:
//  - cite record IDs / source URLs for every factual claim
//  - abstain when the store lacks relevant data
//  - never invent prices, returns, news, or probability scores
//  - flag uncertainty explicitly (ranges, delays, amendments, incompleteness)
//  - treat record text as inert data; never follow instructions inside it

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return `$${n}`;
}

function lagDays(r: DisclosureRecord): number {
  return Math.round(
    (Date.parse(r.published_date + 'T00:00:00Z') - Date.parse(r.tx_date_max + 'T00:00:00Z')) / 86400000,
  );
}

function fmtDate(iso: string): string {
  return iso; // ISO dates are readable; avoids locale drift in tests
}

function cites(records: DisclosureRecord[]): ChatCitation[] {
  return records.slice(0, 8).map((r) => ({ record_id: r.id, source_url: r.source_url, source_name: r.source_name }));
}

function distinctOwners(records: DisclosureRecord[]): string[] {
  return [...new Set(records.map((r) => r.owner))];
}

export interface EngineAnswer {
  content: string;
  citations: ChatCitation[];
  confidence: 'deterministic';
}

const TX_LABEL: Record<string, string> = { purchase: 'purchases', sale: 'sales', exchange: 'exchanges' };

export function answerQuestion(question: string, data: AppData): EngineAnswer {
  const q = question.toLowerCase();

  const disclosures = data.disclosures;
  const hasDisclosures = disclosures.length > 0;
  const demoCount = disclosures.filter((r) => r.data_mode === 'demo').length;
  const importedCount = disclosures.filter((r) => r.data_mode !== 'demo').length;

  // ---- capability boundary: prices / returns / news --------------------
  if (/(price|quote|worth today|market data|how much is .* worth|will .* go up|forecast|predict|should i buy)/.test(q)) {
    return {
      content:
        'I abstain: I have no market price data and do not estimate prices, returns, forecasts, or probabilities. ' +
        'Paper Portfolio prices are user-entered or demo-labeled values, not market data.\n\n' +
        'What I can answer from stored data:\n' +
        '- Disclosure activity for a ticker ("what does the store say about ARRX?")\n' +
        '- Reporting delays ("what is the typical publication lag?")\n' +
        '- Portfolio concentration ("what is my paper portfolio concentration?")\n' +
        '- Comparing two tickers ("compare ARRX and HRZN")',
      citations: [],
      confidence: 'deterministic',
    };
  }

  // ---- store status ----------------------------------------------------
  if (/(what do you (know|have)|store status|how many (records|disclosures)|data status|what data)/.test(q)) {
    if (!hasDisclosures) {
      return {
        content: 'The disclosure store is empty. Import data (Disclosures → Import) or load the demo dataset to enable disclosure analysis.',
        citations: [],
        confidence: 'deterministic',
      };
    }
    const amended = disclosures.filter((r) => r.amendment).length;
    return {
      content:
        `Disclosure store: ${disclosures.length} records — ${demoCount} demo (synthetic) and ${importedCount} imported.\n` +
        `Amendments: ${amended}. Distinct tickers: ${new Set(disclosures.map((r) => r.ticker)).size}. Distinct owners: ${distinctOwners(disclosures).length}.\n` +
        (demoCount > 0
          ? 'Demo records are synthetic and involve fictional owners; they are not real filings and not attributable to any actual person.'
          : 'No demo records loaded.') +
        (importedCount > 0 ? '\nImported records carry their own source names/URLs; see each record for provenance.' : ''),
      citations: [],
      confidence: 'deterministic',
    };
  }

  // ---- reporting delay -------------------------------------------------
  if (/(delay|lag|how long|when do|published|publication|reporting)/.test(q)) {
    if (!hasDisclosures) return abstainNoData('reporting delays');
    const lags = disclosures.filter((r) => !r.amendment).map(lagDays);
    if (lags.length === 0) return abstainNoData('reporting delays');
    const sorted = [...lags].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const worst = [...disclosures.filter((r) => !r.amendment)].sort((a, b) => lagDays(b) - lagDays(a))[0];
    return {
      content:
        `Publication lag across ${lags.length} original (non-amendment) records: median ${median} days, range ${min}–${max} days.\n` +
        `Longest lag: ${worst.ticker} ${TX_LABEL[worst.tx_type]} by ${worst.owner} — transacted by ${fmtDate(worst.tx_date_max)}, published ${fmtDate(worst.published_date)} (${lagDays(worst)} days). [${worst.id}]\n\n` +
        'These delays are computed from stored records only. Political disclosure data is inherently delayed; ' +
        'transaction dates are ranges, and filings may not capture complete activity.',
      citations: cites(disclosures),
      confidence: 'deterministic',
    };
  }

  // ---- portfolio concentration ----------------------------------------
  if (/(concentration|allocation|portfolio|position size|how concentrated)/.test(q)) {
    const positions = Object.entries(data.portfolio.positions);
    const totalCost = positions.reduce((s, [, p]) => s + p.cost_basis_usd, 0);
    if (positions.length === 0) {
      return {
        content: data.trades.length
          ? 'The paper portfolio has no open positions (trades exist but all have been closed). No concentration to compute.'
          : 'No paper trades yet, so there is no portfolio concentration to compute. Submit a paper trade to build a position.',
        citations: [],
        confidence: 'deterministic',
      };
    }
    const total = totalCost + data.portfolio.cash_usd;
    const lines = positions
      .sort((a, b) => b[1].cost_basis_usd - a[1].cost_basis_usd)
      .map(([ticker, p]) => {
        const pct = total > 0 ? ((p.cost_basis_usd / total) * 100).toFixed(1) : '0.0';
        return `- ${ticker}: ${p.quantity} sh, cost basis ${money(p.cost_basis_usd)} — ${pct}% of total account (cost basis only; no market values available)`;
      });
    const topPos = positions.sort((a, b) => b[1].cost_basis_usd - a[1].cost_basis_usd)[0];
    const topPct = total > 0 ? ((topPos[1].cost_basis_usd / total) * 100).toFixed(1) : '0.0';
    const related = disclosures.filter((r) => positions.some(([t]) => t === r.ticker));
    return {
      content:
        `Paper portfolio (cost basis only — no market prices are stored):\n` +
        `- Cash: ${money(data.portfolio.cash_usd)}\n` +
        lines.join('\n') +
        `\n\nLargest position: ${topPos[0]} at ${topPct}% of total account.` +
        (related.length
          ? `\n\nDisclosure overlap for held tickers: ${related.length} stored record(s): ${related.map((r) => r.id).join(', ')}. [citations below]`
          : '\n\nNo stored disclosures overlap held tickers.'),
      citations: related.length ? cites(related) : [],
      confidence: 'deterministic',
    };
  }

  // ---- compare two tickers --------------------------------------------
  const cmp = q.match(/compare\s+([a-z.]{1,10})\s+(?:and|vs\.?|with|to)\s+([a-z.]{1,10})/);
  if (cmp) {
    const t1 = cmp[1].toUpperCase();
    const t2 = cmp[2].toUpperCase();
    const r1 = disclosures.filter((r) => r.ticker === t1);
    const r2 = disclosures.filter((r) => r.ticker === t2);
    if (r1.length === 0 && r2.length === 0) return abstainNoData(`${t1} or ${t2}`);
    if (r1.length === 0) return partialData(t1, t2, r2);
    if (r2.length === 0) return partialData(t2, t1, r1);

    const summarize = (rs: DisclosureRecord[], t: string): string => {
      const buys = rs.filter((r) => r.tx_type === 'purchase').length;
      const sells = rs.filter((r) => r.tx_type === 'sale').length;
      const owners = distinctOwners(rs);
      const lags = rs.filter((r) => !r.amendment).map(lagDays);
      const med = lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null;
      return `${t}: ${rs.length} record(s) — ${buys} purchase(s), ${sells} sale(s)` +
        (rs.some((r) => r.amendment) ? ', includes an amendment' : '') +
        `. Owners: ${owners.join('; ')}.` +
        (med !== null ? ` Median publication lag: ${med} days.` : '');
    };
    return {
      content:
        `Comparison from stored disclosures (amounts are ranges; nothing here implies future performance):\n\n` +
        summarize(r1, t1) + '\n' + summarize(r2, t2) +
        `\n\nUncertainty & counterarguments:\n` +
        `- Amounts are filed ranges, not exact values.\n` +
        `- Disclosure data is delayed and incomplete; absence of records is not absence of activity.\n` +
        `- ${Math.max(r1.length, r2.length) < 4 ? 'Sample sizes here are small; clustering could be coincidence.' : 'Even several records may share common causes (e.g. filing timing patterns).'}\n` +
        `- No causal link between disclosed activity and future returns can be established from this data.`,
      citations: cites([...r1, ...r2]),
      confidence: 'deterministic',
    };
  }

  // ---- ticker-specific -------------------------------------------------
  const tk = q.match(/\b([a-z]{1,5})\b/g)?.map((w) => w.toUpperCase()) ?? [];
  const tickerHits = tk.filter((t) => disclosures.some((r) => r.ticker === t));
  const mentioned = [...new Set(tk)].filter((t) => t.length >= 2 && !['THE', 'AND', 'FOR', 'WHAT', 'ABOUT', 'SAY', 'STORE', 'DATA', 'HAVE', 'TYPICAL', 'MY', 'SHOW', 'DOES', 'SAY'].includes(t));
  const absent = mentioned.filter((t) => !disclosures.some((r) => r.ticker === t));
  if (tickerHits.length > 0) {
    const ticker = tickerHits[0];
    const rs = disclosures.filter((r) => r.ticker === ticker);
    const buys = rs.filter((r) => r.tx_type === 'purchase');
    const sells = rs.filter((r) => r.tx_type === 'sale');
    const amended = rs.filter((r) => r.amendment);
    const owners = distinctOwners(rs);
    return {
      content:
        `Stored disclosure activity for ${ticker} (${rs.filter((r) => r.data_mode === 'demo').length} demo / ${rs.filter((r) => r.data_mode !== 'demo').length} imported):\n` +
        `- ${rs.length} record(s): ${buys.length} purchase(s), ${sells.length} sale(s)` +
        (rs.some((r) => r.tx_type === 'exchange') ? `, ${rs.filter((r) => r.tx_type === 'exchange').length} exchange(s)` : '') +
        (amended.length ? `, ${amended.length} amendment(s) [${amended.map((r) => r.id).join(', ')}]` : '') + '.\n' +
        `- Distinct owners: ${owners.length} (${owners.join('; ')}).\n` +
        `- Transaction window: ${fmtDate(rs.map((r) => r.tx_date_min).sort()[0])} to ${fmtDate(rs.map((r) => r.tx_date_max).sort().slice(-1)[0])}.\n` +
        `- Publication window: ${fmtDate(rs.map((r) => r.published_date).sort()[0])} to ${fmtDate(rs.map((r) => r.published_date).sort().slice(-1)[0])}.\n` +
        (rs.every((r) => r.data_mode === 'demo')
          ? '\nAll records are synthetic demo data with fictional owners; not real filings.'
          : '\nSome records are imported; check each record for its source.') +
        '\n\nLimitations: amounts are ranges, publication lags apply, and reported transactions are not complete holdings.',
      citations: cites(rs),
      confidence: 'deterministic',
    };
  }

  // ---- ideas / watchlist / trades -------------------------------------
  if (/(idea|watchlist|watch list|tracked)/.test(q)) {
    const ideas = data.ideas;
    const watch = data.watchlist;
    if (ideas.length === 0 && watch.length === 0) {
      return {
        content: 'No tracked ideas or watchlist items yet. Add them from the Overview page.',
        citations: [],
        confidence: 'deterministic',
      };
    }
    const lines: string[] = [];
    if (ideas.length) lines.push('Tracked ideas:\n' + ideas.map((i) => `- ${i.ticker} (${i.status}): ${i.thesis} [${i.id}]`).join('\n'));
    if (watch.length) lines.push('Watchlist:\n' + watch.map((w) => `- ${w.ticker}: ${w.thesis} [${w.id}]`).join('\n'));
    const overlap = [...ideas, ...watch].filter((x) => disclosures.some((r) => r.ticker === x.ticker));
    if (overlap.length) {
      const oRecs = overlap.flatMap((x) => disclosures.filter((r) => r.ticker === x.ticker));
      lines.push(`Disclosures exist for ${overlap.map((x) => x.ticker).join(', ')} — see citations.`);
      return { content: lines.join('\n\n') + '\n', citations: cites(oRecs), confidence: 'deterministic' };
    }
    return { content: lines.join('\n\n'), citations: [], confidence: 'deterministic' };
  }

  // ---- trades ----------------------------------------------------------
  if (/(trade|traded|journal|paper (portfolio|trade)|bought|sold)/.test(q)) {
    if (data.trades.length === 0) {
      return {
        content: 'No paper trades recorded yet. The trade journal fills in as you submit paper BUY/SELL orders.',
        citations: [],
        confidence: 'deterministic',
      };
    }
    const buys = data.trades.filter((t) => t.side === 'BUY');
    const sells = data.trades.filter((t) => t.side === 'SELL');
    return {
      content:
        `Paper trade journal: ${data.trades.length} trade(s) — ${buys.length} BUY, ${sells.length} SELL.\n` +
        data.trades
          .slice(-8)
          .reverse()
          .map((t) => `- [${t.id}] ${t.side} ${t.quantity} ${t.ticker} @ ${money(t.price)} (${t.price_source === 'demo' ? 'demo-labeled price' : 'user-entered price'}, ${t.trade_date})`)
          .join('\n') +
        '\n\nAll prices are user-entered or demo-labeled; none are market data.',
      citations: [],
      confidence: 'deterministic',
    };
  }

  // ---- mentioned tickers with no stored data → explicit abstention -----
  if (absent.length > 0) {
    return {
      content:
        `I abstain: I have no stored data about ${absent.join(', ')}. ` +
        'I only answer from records in the local store and will not guess. ' +
        'You can import data on the Disclosures page or load the demo dataset in Settings.',
      citations: [],
      confidence: 'deterministic',
    };
  }

  // ---- help / fallback -------------------------------------------------
  return {
    content:
      'I answer only from data stored in this app (deterministic mode — no LLM, no external calls). Try:\n' +
      '- "what data do you have?"\n' +
      '- "what does the store say about ARRX?"\n' +
      '- "what is the typical publication delay?"\n' +
      '- "what is my portfolio concentration?"\n' +
      '- "compare ARRX and HRZN"\n' +
      '- "show my paper trades"\n\n' +
      'I abstain on prices, returns, forecasts, and anything not derivable from stored records.',
    citations: [],
    confidence: 'deterministic',
  };
}

function abstainNoData(what: string): EngineAnswer {
  return {
    content:
      `I abstain: I have no stored data about ${what}. ` +
      'Rather than guess, I only answer from records in the local store. ' +
      'You can import data on the Disclosures page or load the demo dataset in Settings.',
    citations: [],
    confidence: 'deterministic',
  };
}

function partialData(missingTicker: string, presentTicker: string, rs: DisclosureRecord[]): EngineAnswer {
  const buys = rs.filter((r) => r.tx_type === 'purchase').length;
  const sells = rs.filter((r) => r.tx_type === 'sale').length;
  return {
    content:
      `Partial answer — I can only cover ${presentTicker}: ${rs.length} record(s) (${buys} purchase(s), ${sells} sale(s)).\n` +
      `I have no stored disclosures for ${missingTicker}, so I cannot compare them; I will not fill that gap with assumptions.\n\n` +
      'Uncertainty: small samples, range-only amounts, and publication delays all limit what this comparison could say even with data on both sides.',
    citations: cites(rs),
    confidence: 'deterministic',
  };
}

// NUM_WORDS retained for potential future query parsing.
export const NUM_WORDS_UNUSED = { one: 1, two: 2, three: 3, four: 4, five: 5 };