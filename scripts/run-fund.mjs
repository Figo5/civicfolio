// Scheduled fund runner: hits the local API's /api/fund/run endpoint.
// Called by launchd three times per trading day (open, midday, close).
// The endpoint itself is idempotent and guard-railed; this script just POSTs
// and logs the outcome.

const PORT = process.env.CIVICFOLIO_PORT || '8787';
const label = process.argv[2] ?? 'scheduled';

async function main() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/fund/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': `http://127.0.0.1:${PORT}` },
      body: '{}',
      signal: AbortSignal.timeout(300_000), // the loop can research+trade for minutes
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] ${label}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      process.exit(1);
    }
    const actions = (body.actions ?? []).map((a) => `${a.ticker} ${a.action}`).join(', ') || 'no actions';
    console.log(`[${new Date().toISOString()}] ${label}: equity $${body.equity_usd} — ${actions}`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] ${label}: failed — ${String(e && e.message || e).slice(0, 200)}`);
    process.exit(1);
  }
}

main();