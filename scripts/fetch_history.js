/**
 * fetch_history.js — Bulk-download observed temperature history from Polymarket.
 *
 * Polymarket resolves London temperature markets against Wunderground (EGLC station).
 * When a market resolves, the winning temperature band settles to price ~1.0.
 * This gives us the EXACT temperature Polymarket used — perfect calibration.
 *
 * Usage:
 *   node scripts/fetch_history.js [--days=90] [--dry-run]
 *
 * Appends new observations to observed-london.ndjson (skips already-logged dates).
 */

const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const fetch = global.fetch;
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const OBSERVED_LOG_PATH = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');
const SERIES_SLUG = 'london-daily-weather';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// ── Args ──────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, ...v] = a.split('=');
      return [k.replace(/^--?/, ''), v.join('=')];
    })
  );
  return {
    days: parseInt(args.days ?? '90', 10),
    dryRun: 'dry-run' in args || args['dry-run'] === 'true'
  };
}

// ── Retry ─────────────────────────────────────────────────────────────────────
async function fetchWithRetry(fn, { retries = 3, baseMs = 800, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseMs * Math.pow(2, attempt);
        console.warn(`[retry] ${label} attempt ${attempt + 1}: ${err.message}. Waiting ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Existing log ──────────────────────────────────────────────────────────────
async function loadExistingDates() {
  try {
    const text = await fs.readFile(OBSERVED_LOG_PATH, 'utf8');
    return new Set(
      text.split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line).date; } catch { return null; }
      }).filter(Boolean)
    );
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

// ── Extract temperature from groupItemTitle ───────────────────────────────────
// Examples: "19°C" → 19,  "15°C or below" → 15,  "25°C or higher" → 25
function extractTemp(title) {
  if (!title) return null;
  const m = title.match(/(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]);
}

// ── Fetch resolved events from the london-daily-weather series ────────────────
async function fetchResolvedEvents(limit) {
  return fetchWithRetry(async () => {
    const params = new URLSearchParams({
      seriesSlug: SERIES_SLUG,
      closed: 'true',
      limit: String(limit),
      order: 'endDate',
      ascending: 'false'
    });
    const url = `${GAMMA_BASE}/events?${params}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!r.ok) throw new Error(`gamma-api responded ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  }, { label: 'fetch series events', retries: 3 });
}

// ── Determine resolved temperature from a closed event ────────────────────────
// The winning market settles to lastTradePrice ≈ 1.0; all others → 0.
function resolvedTemp(event) {
  const markets = event.markets ?? [];
  if (!markets.length) return null;

  // Find the market with the highest lastTradePrice (the winner).
  const sorted = [...markets].sort((a, b) => {
    const pa = Number(a.lastTradePrice ?? a.outcomePrices?.[0] ?? 0);
    const pb = Number(b.lastTradePrice ?? b.outcomePrices?.[0] ?? 0);
    return pb - pa;
  });

  const winner = sorted[0];
  const price = Number(winner.lastTradePrice ?? 0);

  // Only accept if clearly resolved (price > 0.8 means market has strong consensus).
  if (price < 0.8) {
    return null; // Not clearly resolved yet — skip.
  }

  return extractTemp(winner.groupItemTitle ?? winner.question);
}

// ── Append observations ───────────────────────────────────────────────────────
async function appendObservations(entries) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(OBSERVED_LOG_PATH, lines, 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { days, dryRun } = parseArgs();
  if (dryRun) console.log('🔍 Dry run — no files will be written.\n');

  console.log(`Fetching up to ${days} days of resolved Polymarket London temperature history…`);
  const events = await fetchResolvedEvents(days);
  console.log(`Got ${events.length} closed events from series "${SERIES_SLUG}".`);

  const existing = await loadExistingDates();
  console.log(`Already have ${existing.size} dates logged.`);

  const toAdd = [];
  let skipped = 0;
  let unclear = 0;

  for (const event of events) {
    // eventDate is cleanest; fall back to endDate (strip time).
    const date = event.eventDate ?? event.endDate?.slice(0, 10);
    if (!date) continue;
    if (existing.has(date)) { skipped++; continue; }

    const temp = resolvedTemp(event);
    if (temp === null) { unclear++; continue; }

    toAdd.push({
      date,
      maxTemp: temp,
      source: 'polymarket-resolved',
      observedAt: new Date().toISOString(),
      note: `resolved from series ${SERIES_SLUG}`
    });
  }

  console.log(`\nResults:`);
  console.log(`  New observations: ${toAdd.length}`);
  console.log(`  Already logged:   ${skipped}`);
  console.log(`  Unclear/pending:  ${unclear}`);

  if (toAdd.length === 0) {
    console.log('Nothing new to add.');
    return;
  }

  // Sort oldest → newest before appending.
  toAdd.sort((a, b) => a.date.localeCompare(b.date));

  if (!dryRun) {
    await appendObservations(toAdd);
    console.log(`\n✅ Appended ${toAdd.length} observations to ${OBSERVED_LOG_PATH}`);
  } else {
    console.log('\nWould append:');
    toAdd.forEach(e => console.log(`  ${e.date}: ${e.maxTemp}°C`));
  }
}

main().catch(err => {
  console.error('fetch_history failed:', err.message);
  process.exit(1);
});
