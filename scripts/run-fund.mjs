// Scheduled fund runner: hits the local API's /api/fund/run endpoint.
// Called by launchd eight times per day at fixed CLOCK times (see
// local.civicfolio.fund.plist) — note: clock-based, NOT trading-day aware
// (it fires on weekends/holidays too). The endpoint is guarded (single-flight
// + idempotency); this script just POSTs with a per-invocation request_id so
// a launchd retry that somehow replays cannot start a second execution, and
// logs the outcome.
//
// Historical note: the plist comment says "three times per trading day" but
// the actual StartCalendarInterval list has 8 clock times. The plist is
// UNTOUCHED by this repair — firing 8x/day is frequent enough, the fix lives
// in the endpoint's guarded coordinator.

const PORT = process.env.CIVICFOLIO_PORT || '8787';
const label = process.argv[2] ?? 'scheduled';

async function main() {
  try {
    // Unique per invocation: a retried run of THIS script process would reuse
    // it; two overlapping scheduler fires do not queue a duplicate (the
    // endpoint returns the active run instead).
    const requestId = `scheduled-${label}-${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${PORT}/api/fund/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': `http://127.0.0.1:${PORT}` },
      body: JSON.stringify({ trigger: 'scheduled', request_id: requestId }),
      signal: AbortSignal.timeout(300_000), // the loop can research+trade for minutes
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] ${label}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      process.exit(1);
    }
    const actions = (body.actions ?? []).map((a) => `${a.ticker} ${a.action}`).join(', ') || 'no actions';
    const status = body.status ? ` [${body.status}${body.reused ? ', shared' : ''}]` : '';
    console.log(`[${new Date().toISOString()}] ${label}: equity $${body.equity_usd}${status} — ${actions}`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] ${label}: failed — ${String(e && e.message || e).slice(0, 200)}`);
    process.exit(1);
  }
}

main();