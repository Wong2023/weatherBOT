/**
 * fetch_observed.js
 *
 * Fetches the actual observed max temperature for a given date and appends
 * it to the observed log (used by predict.js for historical error weighting).
 *
 * Sources (tried in order):
 *   1. Open-Meteo Historical (ERA5 reanalysis) — reliable, no scraping
 *   2. Polymarket event page  — fallback, fragile HTML parsing
 *
 * Usage:
 *   node scripts/fetch_observed.js [--date=YYYY-MM-DD] [--note=text]
 */

const fs = require('fs/promises');
const path = require('path');

const fetch = global.fetch;
const dotenv = require('dotenv');
dotenv.config();

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const OBSERVED_LOG_PATH = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');

const WEATHER_LATITUDE = 51.5048;
const WEATHER_LONGITUDE = 0.0495;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const POLYMARKET_BASE_URL = process.env.POLYMARKET_BASE_URL || 'https://polymarket.com';
const EVENT_SLUG_PREFIX = 'highest-temperature-in-london-on-';
const MONTH_FORMATTER = new Intl.DateTimeFormat('en', { month: 'long' });

// ── Retry helper ──────────────────────────────────────────────────────────────
async function fetchWithRetry(fn, { retries = 3, baseMs = 800, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseMs * Math.pow(2, attempt);
        console.warn(`[retry] ${label} attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms…`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Args ──────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.split('=');
      return [key.replace(/^--?/, ''), rest.join('=')];
    })
  );
  return { date: args.date, note: args.note };
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function pickTargetDate(provided) {
  if (provided) return provided;
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return formatDate(now);
}

// ── Source 1: Polymarket resolved market (exact match with resolution source) ──
// Fetches the event for the given date and finds the winning temperature band.
function buildLondonSlug(date) {
  const [year, month, day] = date.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const monthName = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  return `highest-temperature-in-london-on-${monthName}-${day}-${year}`;
}

function extractTempFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

async function fetchPolymarketResolved(date) {
  return fetchWithRetry(async () => {
    const slug = buildLondonSlug(date);
    const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!r.ok) throw new Error(`gamma-api ${r.status}`);
    const events = await r.json();
    const event = (Array.isArray(events) ? events : []).find(e => e.slug === slug);
    if (!event) throw new Error(`Event "${slug}" not found`);
    if (!event.closed) throw new Error(`Event "${slug}" is not yet resolved`);

    const markets = event.markets ?? [];
    const sorted = [...markets].sort((a, b) =>
      Number(b.lastTradePrice ?? 0) - Number(a.lastTradePrice ?? 0)
    );
    const winner = sorted[0];
    const price = Number(winner?.lastTradePrice ?? 0);
    if (price < 0.8) throw new Error(`No clear winner yet (top price: ${price})`);

    const temp = extractTempFromTitle(winner.groupItemTitle ?? winner.question);
    if (temp === null) throw new Error('Could not parse temperature from winner title');
    return { maxTemp: temp, source: 'polymarket-resolved', note: winner.groupItemTitle };
  }, { label: `Polymarket resolved ${date}`, retries: 2 });
}

// ── Source 2: Open-Meteo Historical (ERA5) ────────────────────────────────────
// Reliable reanalysis data available for dates up to ~5 days ago.
async function fetchOpenMeteoHistorical(date) {
  return fetchWithRetry(async () => {
    const params = new URLSearchParams({
      latitude: WEATHER_LATITUDE.toString(),
      longitude: WEATHER_LONGITUDE.toString(),
      daily: 'temperature_2m_max',
      start_date: date,
      end_date: date,
      timezone: 'UTC',
      models: 'era5'
    });
    const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo Historical ${response.status}`);
    const data = await response.json();
    const temps = data?.daily?.temperature_2m_max;
    if (!Array.isArray(temps) || temps[0] === null || temps[0] === undefined) {
      throw new Error('Open-Meteo Historical: no data for requested date');
    }
    return { maxTemp: Number(Number(temps[0]).toFixed(2)), source: 'open-meteo-era5' };
  }, { label: 'Open-Meteo Historical', retries: 2 });
}

// ── Source 2: Polymarket page (fragile, HTML scraping) ────────────────────────
function buildSlug(date) {
  const [year, month, day] = date.split('-');
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const monthName = MONTH_FORMATTER.format(parsed).toLowerCase();
  return `${EVENT_SLUG_PREFIX}${monthName}-${Number(day)}-${year}`;
}

function parseTemperatureFromPage(text) {
  const patterns = [
    /confirm(?:s)?[\s\S]{0,300}?reached exactly (\d+(?:\.\d+)?)°C/i,
    /highest temperature[^\d]*?(\d+(?:\.\d+)?)°C/i,
    /resolved.*?(\d{2}(?:\.\d+)?)°C/i
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return Number.parseFloat(m[1]);
  }
  return null;
}

async function fetchPolymarketObservation(date) {
  return fetchWithRetry(async () => {
    const slug = buildSlug(date);
    const url = `${POLYMARKET_BASE_URL}/event/${slug}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!response.ok) throw new Error(`Polymarket page ${response.status}`);
    const text = await response.text();
    const maxTemp = parseTemperatureFromPage(text);
    if (maxTemp === null || Number.isNaN(maxTemp)) {
      throw new Error('Polymarket page: temperature pattern not found — market may not be resolved yet');
    }
    return { maxTemp: Number(maxTemp.toFixed(2)), source: 'polymarket', note: `slug: ${slug}` };
  }, { label: 'Polymarket', retries: 2 });
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function alreadyLogged(date) {
  try {
    const content = await fs.readFile(OBSERVED_LOG_PATH, { encoding: 'utf8' });
    return content.split(/\r?\n/).filter(Boolean).some((line) => {
      try { return JSON.parse(line).date === date; } catch { return false; }
    });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function appendObservation({ date, maxTemp, maxTempBand, maxTempEra5, note, source }) {
  await fs.mkdir(path.dirname(OBSERVED_LOG_PATH), { recursive: true });
  const entry = {
    date,
    maxTemp,                       // betting truth (Polymarket band, integer) — what payouts use
    maxTempBand: maxTempBand ?? null,
    maxTempEra5: maxTempEra5 ?? null,  // precise ERA5 value (sub-degree) for model calibration
    source,
    observedAt: new Date().toISOString(),
    note: note ?? null
  };
  await fs.appendFile(OBSERVED_LOG_PATH, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
  const era5Str = maxTempEra5 != null ? `, era5: ${maxTempEra5}°C` : ', era5: pending';
  console.log(`✅ Logged observed max for ${date}: ${maxTemp}°C (source: ${source}${era5Str})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const date = pickTargetDate(args.date);

  if (await alreadyLogged(date)) {
    console.log(`ℹ️  Observation for ${date} already recorded — skipping.`);
    return;
  }

  console.log(`Fetching observed max temperature for ${date}…`);

  // We collect TWO truths, independently:
  //   • Band  — Polymarket's resolved winning band (integer). This is what payouts use.
  //   • ERA5  — Open-Meteo reanalysis (sub-degree). Used for precise model calibration/bias.
  // ERA5 for very recent dates may not be published yet → left null, filled later by
  // scripts/backfill_era5.js.
  let band = null;        // integer band from Polymarket
  let era5 = null;        // precise ERA5 value
  let source = null;      // primary source label for maxTemp
  let note = null;

  // 1. Polymarket resolved band (preferred betting truth).
  try {
    const r = await fetchPolymarketResolved(date);
    band = r.maxTemp;
    source = r.source;
    note = r.note;
    console.log(`✅ Polymarket resolved → ${band}°C (${r.note})`);
  } catch (err) {
    console.warn(`Polymarket resolved unavailable: ${err.message}`);
  }

  // 2. ERA5 precise (independent — always try, regardless of band success).
  try {
    const r = await fetchOpenMeteoHistorical(date);
    era5 = r.maxTemp;
    console.log(`✅ Open-Meteo ERA5 → ${era5}°C`);
  } catch (err) {
    console.warn(`ERA5 unavailable (will backfill later): ${err.message}`);
  }

  // 3. If neither worked, last-resort HTML scrape of the Polymarket page.
  if (band === null && era5 === null) {
    console.log('Falling back to Polymarket page scraping…');
    try {
      const r = await fetchPolymarketObservation(date);
      band = r.maxTemp;
      source = r.source;
      note = r.note;
      console.log(`Polymarket HTML → ${band}°C`);
    } catch (err3) {
      console.error(`All sources failed for ${date}: ${err3.message}`);
      process.exit(1);
    }
  }

  // maxTemp = betting truth: prefer the band; if missing, round ERA5 as a stand-in.
  const maxTemp = band != null ? band : Math.round(era5);
  if (source === null) source = era5 != null ? 'open-meteo-era5' : 'unknown';

  await appendObservation({
    date,
    maxTemp,
    maxTempBand: band,
    maxTempEra5: era5,
    source,
    note: args.note ?? note ?? null
  });
}

main().catch((err) => {
  console.error('fetch_observed failed:', err.message);
  process.exit(1);
});
