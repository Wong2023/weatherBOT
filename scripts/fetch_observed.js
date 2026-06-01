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

const WEATHER_LATITUDE = 51.5074;
const WEATHER_LONGITUDE = -0.1278;
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

// ── Source 1: Open-Meteo Historical (ERA5) ────────────────────────────────────
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

async function appendObservation({ date, maxTemp, note, source }) {
  await fs.mkdir(path.dirname(OBSERVED_LOG_PATH), { recursive: true });
  const entry = { date, maxTemp, source, observedAt: new Date().toISOString(), note: note ?? null };
  await fs.appendFile(OBSERVED_LOG_PATH, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
  console.log(`✅ Logged observed max for ${date}: ${maxTemp}°C (source: ${source})`);
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

  // Try ERA5 first (most reliable), then Polymarket as fallback.
  let result = null;
  try {
    result = await fetchOpenMeteoHistorical(date);
    console.log(`Open-Meteo ERA5 → ${result.maxTemp}°C`);
  } catch (err) {
    console.warn(`Open-Meteo Historical unavailable: ${err.message}`);
    console.log('Falling back to Polymarket page…');
    try {
      result = await fetchPolymarketObservation(date);
      console.log(`Polymarket → ${result.maxTemp}°C`);
    } catch (err2) {
      console.error(`Both sources failed for ${date}:`);
      console.error(`  ERA5: already failed above`);
      console.error(`  Polymarket: ${err2.message}`);
      process.exit(1);
    }
  }

  await appendObservation({ date, maxTemp: result.maxTemp, source: result.source, note: args.note ?? result.note ?? null });
}

main().catch((err) => {
  console.error('fetch_observed failed:', err.message);
  process.exit(1);
});
