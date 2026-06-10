const fs = require('fs/promises');
const path = require('path');
const fetch = global.fetch;
const dotenv = require('dotenv');

dotenv.config();

// ── Retry with exponential backoff ────────────────────────────────────────────
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

// ── Telegram notifications ────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.warn('Telegram send failed:', err.message);
  }
}

// London City Airport (EGLC) — the exact station Polymarket/Wunderground uses for resolution.
// NOT central London (51.5074, -0.1278) which can differ by 1-2°C on hot days.
const WEATHER_LATITUDE = 51.5048;
const WEATHER_LONGITUDE = 0.0495;
const WEATHER_TIMEZONE = 'UTC';
const WEATHER_TARGET_CITY = 'London';

// Open-Meteo model IDs. Two rules that were previously broken:
//   1. They MUST be passed via the `models=` param (plural). The old code used
//      `model=` (singular) which Open-Meteo silently ignores → every request
//      returned the SAME default blend, so the "ensemble" was 12 identical copies.
//   2. The ID must be a real Open-Meteo model. The old list had 7 invalid IDs
//      (ecmwf, icon, gfs, nam, gefs, ukmo, hrrr — all error out).
// Every ID below was validated live against London/EGLC and returns a distinct
// forecast. Prefer high-resolution NW-Europe models (UKMO, AROME, HARMONIE).
const OPEN_METEO_MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF' },
  { id: 'gfs_seamless', label: 'GFS' },
  { id: 'icon_seamless', label: 'ICON' },
  { id: 'ukmo_seamless', label: 'UKMO' },
  { id: 'meteofrance_arpege_world', label: 'ARPEGE' },
  { id: 'meteofrance_arome_france', label: 'AROME' },
  { id: 'knmi_seamless', label: 'KNMI' },
  { id: 'dmi_seamless', label: 'DMI' },
  { id: 'gem_seamless', label: 'GEM' },
  { id: 'jma_seamless', label: 'JMA' },
  { id: 'metno_seamless', label: 'MET Norway' },
  { id: 'cma_grapes_global', label: 'CMA' }
];

// Direct external scrapers (wttr.in, met.no API, 7timer) were removed — unreliable for London.
// Note: MET Norway and UKMO ARE included above, but as proper Open-Meteo *models*, not scrapers.
const EXTERNAL_SOURCES = [];

const POLYMARKET_BASE_URL = process.env.POLYMARKET_BASE_URL || 'https://gamma-api.polymarket.com';
const POLYMARKET_REST_BASE_URL = process.env.POLYMARKET_REST_BASE_URL || POLYMARKET_BASE_URL;
const POLYMARKET_GRAPHQL_URL = process.env.POLYMARKET_GRAPHQL_URL || 'https://api.polymarket.com/v0/graphql';
const POLYMARKET_MARKET_ID = process.env.POLYMARKET_MARKET_ID;
const POLYMARKET_SEARCH_KEYWORD = process.env.POLYMARKET_SEARCH_KEYWORD ?? 'London temperature';
const VALUE_DIFF_THRESHOLD = parseFloat(process.env.VALUE_TEMPERATURE_DIFF_THRESHOLD ?? '1.2');
const OUTCOME_TEMPERATURE_MAP = (() => {
  if (!process.env.OUTCOME_TEMPERATURE_MAP) return {};
  try {
    return JSON.parse(process.env.OUTCOME_TEMPERATURE_MAP);
  } catch (error) {
    console.warn('OUTCOME_TEMPERATURE_MAP is not valid JSON, ignoring it.');
    return {};
  }
})();
const CONSENSUS_THRESHOLD = parseFloat(process.env.CONSENSUS_THRESHOLD ?? '0.75');
const CONSENSUS_TOLERANCE = parseFloat(process.env.CONSENSUS_TOLERANCE ?? '0.4');

const MANUAL_MODE = process.argv.includes('--manual');

const TARGET_DAY_OFFSET = (() => {
  const value = parseInt(process.env.TARGET_DAY_OFFSET ?? '', 10);
  if (!Number.isNaN(value)) return value;
  // --manual: before 15:00 UTC (18:00 MSK) → today, after → tomorrow
  if (MANUAL_MODE) {
    const now = new Date();
    return now.getUTCHours() < 15 ? 0 : 1;
  }
  return 1; // default for scheduler hourly --silent etc.
})();
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const DEFAULT_LOG_PATH = path.join(LOG_DIR, 'predictions.ndjson');
const LOG_PATH = path.resolve(process.cwd(), process.env.PREDICTION_LOG_PATH || DEFAULT_LOG_PATH);
const OBSERVED_LOG_PATH = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');
const ADDITIONAL_PREDICTION_LOG_PATHS = [
  LOG_PATH,
  path.resolve(LOG_DIR, 'predictions-same-day.ndjson')
];
const HISTORY_MAX_ENTRIES = parseInt(process.env.HISTORY_MAX_ENTRIES ?? '60', 10);

// --silent flag: run without sending Telegram, log to hourly log instead of main log.
const SILENT_MODE = process.argv.includes('--silent');
const HOURLY_LOG_PATH = path.resolve(LOG_DIR, 'predictions-hourly.ndjson');
const HISTORY_WEIGHT_ALPHA = parseFloat(process.env.HISTORY_WEIGHT_ALPHA ?? '0.3');
const MIN_META_ERROR = parseFloat(process.env.MIN_META_ERROR ?? '0.35');
const META_ERROR_EPSILON = parseFloat(process.env.META_ERROR_EPSILON ?? '0.1');

async function ensureLogDir() {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function targetDates(start = new Date(), targetOffset = 1) {
  const base = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const today = new Date(base);
  const target = new Date(base);
  target.setUTCDate(target.getUTCDate() + targetOffset);
  const after = new Date(target);
  after.setUTCDate(after.getUTCDate() + 1);
  return {
    today: formatDate(today),
    target: formatDate(target),
    after: formatDate(after)
  };
}

async function fetchOpenMeteoModel(modelId, startDate, endDate) {
  return fetchWithRetry(async () => {
    const params = new URLSearchParams({
      latitude: WEATHER_LATITUDE.toString(),
      longitude: WEATHER_LONGITUDE.toString(),
      daily: 'temperature_2m_max',
      start_date: startDate,
      end_date: endDate,
      timezone: WEATHER_TIMEZONE,
      models: modelId   // MUST be plural `models=` — singular `model=` is ignored by Open-Meteo.
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo (${modelId}) failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.daily || !data.daily.time || !data.daily.temperature_2m_max) {
      throw new Error(`Open-Meteo (${modelId}) returned unexpected payload`);
    }
    return { source: `open-meteo:${modelId}`, label: modelId.toUpperCase(), payload: data.daily };
  }, { label: `Open-Meteo:${modelId}` });
}

// Removed: fetchWttrMax, fetchMetNoMax, fetch7TimerMax — unreliable for London forecasts.

function computeTargetDay(sources, targetDate) {
  return sources.map((entry) => ({
    source: entry.source,
    label: entry.label,
    maxTemp: entry.maxTemp
  }));
}

function computeConsensus(models) {
  if (!models.length) return null;
  const tolerance = CONSENSUS_TOLERANCE;
  const totalWeight = models.reduce((acc, model) => acc + (model.weight ?? 1), 0);
  const candidates = models.map((model) => ({
    value: Number(model.maxTemp.toFixed(2)),
    source: model.source,
    label: model.label,
    weight: model.weight ?? 1
  }));
  const scored = candidates.map((candidate) => {
    const agreeing = candidates.filter((other) => Math.abs(other.value - candidate.value) <= tolerance);
    const agreementWeight = agreeing.reduce((acc, entry) => acc + entry.weight, 0);
    return {
      value: candidate.value,
      agreementWeight,
      sources: [...new Set(agreeing.map((entry) => entry.source))],
      labels: [...new Set(agreeing.map((entry) => entry.label))]
    };
  });
  scored.sort((a, b) => b.agreementWeight - a.agreementWeight || a.value - b.value);
  const best = scored[0];
  const ratio = totalWeight ? best.agreementWeight / totalWeight : 0;
  return {
    consensusValue: Number(best.value.toFixed(2)),
    agreementRatio: Number(ratio.toFixed(2)),
    sourceCount: best.sources.length,
    agreeingSources: best.sources,
    achieved: ratio >= CONSENSUS_THRESHOLD
  };
}

function describeStats(models) {
  if (!models.length) return null;
  const values = models.map((model) => model.maxTemp);
  const weights = models.map((model) => model.weight ?? 1);
  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0);
  const plainMean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const weightedMean = totalWeight
    ? models.reduce((acc, model) => acc + model.maxTemp * (model.weight ?? 1), 0) / totalWeight
    : plainMean;
  const variance = totalWeight
    ? models.reduce((acc, model) => acc + (model.weight ?? 1) * Math.pow(model.maxTemp - weightedMean, 2), 0) / totalWeight
    : values.reduce((acc, value) => acc + Math.pow(value - plainMean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const spread = max - min;
  const confidenceLabel = deriveConfidenceLabel(spread);
  const confidenceScore = Number(Math.max(0, 1 - Math.min(1, spread / 5)).toFixed(2));
  return { mean: weightedMean, median, min, max, stddev, spread, confidenceLabel, confidenceScore };
}

function deriveConfidenceLabel(spread) {
  if (spread <= 0.6) return 'high';
  if (spread <= 1.2) return 'medium';
  return 'low';
}

async function readJsonLines(filePath) {
  try {
    const content = await fs.readFile(filePath, { encoding: 'utf8' });
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.warn('Failed to read ' + filePath + ': ' + error.message);
    return [];
  }
}

async function loadPredictionHistoryRecords() {
  const uniquePaths = [...new Set(ADDITIONAL_PREDICTION_LOG_PATHS)];
  const records = [];
  for (const filePath of uniquePaths) {
    const lines = await readJsonLines(filePath);
    records.push(...lines);
  }
  return records;
}

async function loadObservedHistory() {
  return readJsonLines(OBSERVED_LOG_PATH);
}

function buildObservedMap(observedEntries) {
  return observedEntries.reduce((map, entry) => {
    if (!entry?.date || typeof entry.maxTemp !== 'number') return map;
    map[entry.date] = entry.maxTemp;
    return map;
  }, {});
}

function computeSourceErrorRecords(predictions, observedMap) {
  const sorted = [...predictions].sort((a, b) => {
    const aTime = Date.parse(a.timestamp || a.targetDate || a.date || '');
    const bTime = Date.parse(b.timestamp || b.targetDate || b.date || '');
    return (aTime || 0) - (bTime || 0);
  });
  const recordsBySource = {};
  for (const record of sorted) {
    const actual = observedMap[record.targetDate];
    if (actual === undefined) continue;
    const models = record?.ensembleForecast?.models ?? record?.models ?? [];
    for (const model of models) {
      if (typeof model.maxTemp !== 'number') continue;
      const label = model.label ?? model.source ?? 'unknown';
      const diff = model.maxTemp - actual;
      recordsBySource[label] = recordsBySource[label] ?? [];
      recordsBySource[label].push({
        diff,
        abs: Math.abs(diff),
        timestamp: Date.parse(record.timestamp || record.targetDate || ''),
        date: record.targetDate
      });
    }
  }
  return recordsBySource;
}

function computeEma(records, alpha) {
  let ema = null;
  for (const entry of records) {
    if (ema === null) {
      ema = entry.abs;
      continue;
    }
    ema = alpha * entry.abs + (1 - alpha) * ema;
  }
  return ema;
}

function computeErrorStats(recordsBySource) {
  const stats = {};
  for (const [label, records] of Object.entries(recordsBySource)) {
    const sorted = [...records].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const windowed = sorted.slice(-HISTORY_MAX_ENTRIES);
    if (!windowed.length) continue;
    const rmse = Math.sqrt(windowed.reduce((acc, entry) => acc + entry.diff * entry.diff, 0) / windowed.length);
    const ema = computeEma(windowed, HISTORY_WEIGHT_ALPHA);
    stats[label] = {
      rmse,
      ema,
      lastError: windowed[windowed.length - 1].diff,
      samples: windowed.length
    };
  }
  return stats;
}

function applyHistoricalWeights(models, errorStats) {
  const enriched = models.map((model) => {
    const key = model.label ?? model.source;
    const stat = errorStats[key] ?? errorStats[model.source] ?? null;
    const metaError = stat?.rmse && stat?.ema ? (stat.rmse + stat.ema) / 2 : stat?.rmse ?? stat?.ema ?? null;
    const safeError = Math.max(metaError ?? MIN_META_ERROR, MIN_META_ERROR);
    const weight = 1 / Math.pow(safeError + META_ERROR_EPSILON, 2);
    return {
      ...model,
      metaError: metaError ? Number(metaError.toFixed(3)) : null,
      weight,
      history: stat
    };
  });
  const totalWeight = enriched.reduce((acc, entry) => acc + entry.weight, 0);
  return enriched.map((entry) => ({
    ...entry,
    normalizedWeight: totalWeight ? entry.weight / totalWeight : 0
  }));
}


function ensureProbability(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return raw > 1 ? raw / 100 : raw;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function parseTemperatureFromOutcome(outcomeName) {
  if (!outcomeName) return null;
  if (Object.prototype.hasOwnProperty.call(OUTCOME_TEMPERATURE_MAP, outcomeName)) {
    return OUTCOME_TEMPERATURE_MAP[outcomeName];
  }
  const numbers = [...outcomeName.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (!numbers.length) return null;
  if (numbers.length === 1) {
    const value = numbers[0];
    if (/over|above|greater|higher|more/i.test(outcomeName) && !/under|below|less/i.test(outcomeName)) {
      return value + 0.25;
    }
    if (/under|below|less|lower/i.test(outcomeName)) {
      return value - 0.25;
    }
    return value;
  }
  const sum = numbers.reduce((acc, num) => acc + num, 0);
  return sum / numbers.length;
}

function computeMarketExpectation(outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
  const interpreted = [];
  for (const outcome of outcomes) {
    const rawProb = ensureProbability(outcome.probability);
    if (rawProb === null) continue;
    const tempValue = parseTemperatureFromOutcome(outcome.name);
    if (tempValue === null || Number.isNaN(tempValue)) continue;
    interpreted.push({ temperature: tempValue, probability: rawProb });
  }
  if (!interpreted.length) return null;
  const totalProb = interpreted.reduce((acc, next) => acc + next.probability, 0);
  if (totalProb === 0) return null;
  const weighted = interpreted.reduce((acc, next) => acc + next.temperature * next.probability, 0);
  return weighted / totalProb;
}

// Predictive probability distribution over integer bands.
// We fit a Gaussian to the weighted ensemble (μ = weighted mean, σ = weighted
// std with a floor) and integrate it over each band's ±0.5°C interval. This is
// the honest probability the day's max lands in a band — unlike raw vote-share,
// which undercounts confidence (12 clustered models give the central band ~35%
// when the true mass is closer to ~45%). SIGMA_FLOOR caps overconfidence: even
// when all models agree, day-ahead forecasts carry irreducible ~0.6°C error.
// TODO: replace fixed SIGMA_FLOOR with our own historical forecast RMSE once
//       enough observed days accumulate (self-calibration).
// Returns { "16": 0.18, "17": 0.46, ... } normalized to sum ~1.
const SIGMA_FLOOR = 0.6;

// Error function (Abramowitz & Stegun 7.1.26) → standard normal CDF, no deps.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-ax * ax);
  return sign * y;
}
function normalCdf(x, mu, sigma) {
  return 0.5 * (1 + erf((x - mu) / (sigma * Math.SQRT2)));
}

function computeBandDistribution(models) {
  const pts = [];
  for (const m of models) {
    if (typeof m.maxTemp !== 'number' || Number.isNaN(m.maxTemp)) continue;
    // Keep the model's weight, or mark for a uniform fallback if missing/zero.
    const w = (typeof m.normalizedWeight === 'number' && m.normalizedWeight > 0) ? m.normalizedWeight : null;
    pts.push({ t: m.maxTemp, w });
  }
  if (!pts.length) return {};
  const n = pts.length;
  for (const p of pts) if (p.w === null) p.w = 1 / n;
  const wsum  = pts.reduce((a, p) => a + p.w, 0) || 1;
  const mu    = pts.reduce((a, p) => a + p.w * p.t, 0) / wsum;
  const varw  = pts.reduce((a, p) => a + p.w * (p.t - mu) ** 2, 0) / wsum;
  const sigma = Math.max(Math.sqrt(Math.max(varw, 0)), SIGMA_FLOOR);

  // Integrate the predictive normal over each integer band in μ ± 4σ.
  const dist = {};
  let total = 0;
  const lo = Math.floor(mu - 4 * sigma);
  const hi = Math.ceil(mu + 4 * sigma);
  for (let b = lo; b <= hi; b++) {
    const p = normalCdf(b + 0.5, mu, sigma) - normalCdf(b - 0.5, mu, sigma);
    if (p > 0.0005) { dist[b] = p; total += p; }
  }
  if (total > 0) {
    for (const b of Object.keys(dist)) dist[b] = Number((dist[b] / total).toFixed(3));
  }
  return dist;
}

// Our probability that a given market outcome wins, given the band distribution.
// Handles open-ended bands: "X or below" sums all bands ≤X, "X or higher" sums all ≥X.
function ourProbabilityForOutcome(outcomeName, dist) {
  const t = parseTemperatureFromOutcome(outcomeName);
  if (t === null || Number.isNaN(t)) return null;
  const band = Math.round(t);
  const isBelow = /below|under|less|lower/i.test(outcomeName);
  const isAbove = /above|higher|greater|over|more/i.test(outcomeName);
  let p = 0;
  for (const [b, w] of Object.entries(dist)) {
    const bb = Number(b);
    if (isBelow ? bb <= band : isAbove ? bb >= band : bb === band) p += w;
  }
  return Number(p.toFixed(3));
}

// Build the value table: our P vs market price vs edge, per outcome.
// edge = ourP - marketPrice. Positive edge = market underprices our band → value bet.
// Bands priced below MIN_TRADABLE_PRICE are Polymarket placeholders for illiquid/
// untraded outcomes (default ~0.001) — skip them so we don't flag a fake huge edge.
const MIN_TRADABLE_PRICE = 0.01;
function computeValueTable(outcomes, dist) {
  return outcomes
    .map((o) => {
      const price = ensureProbability(o.probability);
      const ourP = ourProbabilityForOutcome(o.name, dist);
      const tradable = price !== null && price >= MIN_TRADABLE_PRICE;
      const edge = (tradable && ourP !== null) ? Number((ourP - price).toFixed(3)) : null;
      return { name: o.name, ourP, price, edge };
    })
    .filter((r) => r.edge !== null)
    .sort((a, b) => b.edge - a.edge);
}


// Build the Polymarket event slug from a date string (YYYY-MM-DD).
// Pattern: highest-temperature-in-london-on-{month}-{day}-{year}
// e.g. 2026-06-03 → "highest-temperature-in-london-on-june-3-2026"
function buildLondonSlug(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const monthName = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
  return `highest-temperature-in-london-on-${monthName}-${day}-${year}`;
}

// Fetch a Polymarket event by slug and return its first market's outcomes + id.
async function fetchEventBySlug(slug) {
  return fetchWithRetry(async () => {
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!r.ok) throw new Error(`gamma-api /events?slug= responded ${r.status}`);
    const data = await r.json();
    // The endpoint returns an array of events
    const events = Array.isArray(data) ? data : [];
    const event = events.find(e => e.slug === slug);
    if (!event) throw new Error(`Event slug "${slug}" not found in response (got ${events.length} events)`);
    return event;
  }, { label: `Polymarket slug ${slug}`, retries: 2 });
}

// Fetch a single Polymarket market by conditionId via CLOB REST API.
async function fetchMarketByConditionId(conditionId) {
  return fetchWithRetry(async () => {
    const url = `https://clob.polymarket.com/markets/${conditionId}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!r.ok) throw new Error(`CLOB /markets/${conditionId} responded ${r.status}`);
    return r.json();
  }, { label: `CLOB market ${conditionId}`, retries: 2 });
}

async function findLatestLondonMarket() {
  // Not used — replaced by slug-based lookup. Kept as no-op.
  return null;
}

// Main entry: fetch the Polymarket market for targetDate.
// Strategy:
//   1. If POLYMARKET_MARKET_ID is set → use it directly via CLOB API.
//   2. Otherwise build slug from targetDate and fetch the event → extract first market.
async function fetchPolymarketMarketForDate(targetDate) {
  // Path A: explicit market ID in env
  if (POLYMARKET_MARKET_ID) {
    try {
      const clob = await fetchMarketByConditionId(POLYMARKET_MARKET_ID);
      return normalizeClobMarket(clob);
    } catch (err) {
      console.warn(`CLOB lookup for POLYMARKET_MARKET_ID failed: ${err.message}`);
      return null;
    }
  }

  // Path B: build slug from the target date and fetch via gamma-api
  const slug = buildLondonSlug(targetDate);
  console.log(`Auto-resolving market via slug: ${slug}`);
  let event;
  try {
    event = await fetchEventBySlug(slug);
  } catch (err) {
    console.warn(`Could not fetch event by slug: ${err.message}`);
    return null;
  }

  // The event has a `markets` array; take the first active one.
  const markets = Array.isArray(event.markets) ? event.markets : [];
  const market = markets.find(m => !m.closed && !m.archived) ?? markets[0];
  if (!market) {
    console.warn(`Event "${slug}" found but has no markets.`);
    return null;
  }

  return normalizeGammaEvent(event);
}

// Normalise a CLOB API market response into our internal shape.
function normalizeClobMarket(clob) {
  if (!clob) return null;
  const tokens = clob.tokens ?? [];
  const outcomes = tokens.map(t => ({
    id: t.token_id,
    name: t.outcome,
    probability: t.price != null ? Number(t.price) : null
  }));
  return {
    id: clob.condition_id ?? clob.market_slug,
    name: clob.question ?? clob.market_slug,
    status: clob.active ? 'open' : 'closed',
    outcomes
  };
}

// Normalise a gamma-api EVENT into our internal shape.
// London temp markets use one Yes/No market per temperature band.
// We collect all bands and treat each market's Yes-price as P(that temperature).
function normalizeGammaEvent(event) {
  const markets = Array.isArray(event.markets) ? event.markets : [];

  const outcomes = markets
    .map(m => {
      const rawPrices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : (m.outcomePrices ?? []);
      // Yes is index 0; groupItemTitle is cleanest: "19°C", "15°C or below", etc.
      const name = (m.groupItemTitle ?? m.question ?? '').replace(/Â°/g, '°');
      const probability = rawPrices[0] != null ? Number(rawPrices[0]) : null;
      return { id: String(m.id), name, probability };
    })
    .filter(o => o.probability !== null);

  return {
    id: event.id,
    name: event.title ?? event.slug,
    status: event.closed ? 'closed' : 'open',
    outcomes
  };
}

async function logPrediction(record) {
  await ensureLogDir();
  // Silent mode → hourly log; normal mode → main log.
  const dest = (SILENT_MODE || MANUAL_MODE) ? HOURLY_LOG_PATH : LOG_PATH;
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(dest, line, { encoding: 'utf8' });
}

async function runPredictionCycle() {
  const now = new Date();
  const dates = targetDates(now, TARGET_DAY_OFFSET);
  const targetDate = dates.target;

  const predictionHistory = await loadPredictionHistoryRecords();
  const observedHistory = await loadObservedHistory();
  const observedMap = buildObservedMap(observedHistory);
  const errorRecords = computeSourceErrorRecords(predictionHistory, observedMap);
  const errorStats = computeErrorStats(errorRecords);

  // Stagger Open-Meteo requests by 200ms each to avoid hitting rate limits
  const openMeteoPromises = OPEN_METEO_MODELS.map(async (model, i) => {
    await new Promise(r => setTimeout(r, i * 200));
    try {
      const forecast = await fetchOpenMeteoModel(model.id, dates.today, dates.after);
      const index = forecast.payload.time.findIndex((day) => day === targetDate);
      const value = forecast.payload.temperature_2m_max[index];
      if (value === null || Number.isNaN(value)) {
        console.warn(`Open-Meteo ${model.label} missing max for ${targetDate}`);
        return null;
      }
      return { source: forecast.source, label: model.label, maxTemp: value };
    } catch (error) {
      console.warn(`Open-Meteo ${model.label} error: ${error.message}`);
      return null;
    }
  });

  const readings = await Promise.all([...openMeteoPromises]);
  const validForecasts = readings.filter(Boolean);
  if (!validForecasts.length) {
    throw new Error('All weather sources failed to provide a max temperature.');
  }

  const weightedModels = applyHistoricalWeights(validForecasts, errorStats);
  const stats = describeStats(weightedModels);
  const consensus = computeConsensus(weightedModels);
  const observedDates = observedHistory.map((entry) => entry.date).filter(Boolean);
  const latestObservedDate = observedDates.length ? observedDates.sort()[observedDates.length - 1] : null;

  const ensembleForecast = {
    models: weightedModels,
    stats,
    consensus,
    history: {
      observedDays: Object.keys(observedMap).length,
      sourcesTracked: Object.keys(errorStats).length,
      latestObservation: latestObservedDate
    }
  };

  const polymarketData = await fetchPolymarketMarketForDate(targetDate);
  const marketExpectation = polymarketData ? computeMarketExpectation(polymarketData.outcomes) : null;

  const marketLookup = {
    id: polymarketData?.id ?? null,
    source: POLYMARKET_MARKET_ID ? 'static-env' : 'auto-slug',
    slug: POLYMARKET_MARKET_ID ? null : buildLondonSlug(targetDate)
  };

  const result = {
    timestamp: now.toISOString(),
    targetDate,
    targetDayOffset: TARGET_DAY_OFFSET,
    ensembleForecast: {
      models: ensembleForecast.models,
      stats: ensembleForecast.stats,
      consensus: ensembleForecast.consensus
    },
    marketLookup,
    market: polymarketData
      ? {
          id: polymarketData.id,
          name: polymarketData.name,
          status: polymarketData.status,
          expectation: marketExpectation,
          outcomeNames: polymarketData.outcomes.map((o) => o.name),
          // Full market "ladder": every temperature band with its current price.
          // Lets us reconstruct how the odds evolve hour-by-hour for timing analysis.
          outcomes: polymarketData.outcomes.map((o) => ({
            name: o.name,
            price: o.probability != null ? Number(Number(o.probability).toFixed(3)) : null
          }))
        }
      : null,
    decision: null
  };

  if (polymarketData) {
    const rawForecast = ensembleForecast.consensus?.consensusValue ?? stats?.median ?? 0;
    const confidenceScore = stats?.confidenceScore ?? null;

    // Probability distribution over bands + value (edge) vs the market.
    const distribution = computeBandDistribution(ensembleForecast.models);

    // PRIMARY band for betOn display: argmax of distribution = band with most model votes.
    const argmaxBand = Object.keys(distribution).length
      ? Number(Object.entries(distribution).sort((a, b) => b[1] - a[1])[0][0])
      : Math.round(rawForecast);

    // forecastRounded = Math.round(consensus mean) — used by paper_bet "forecast" strategy.
    // SEPARATE from argmaxBand so the two band methods are truly different in paper_bet.
    const forecastRounded = Math.round(rawForecast);

    // Find the matching market outcome for betOn (uses argmax — most model votes).
    const targetOutcome = polymarketData.outcomes.find(o => {
      const t = parseTemperatureFromOutcome(o.name);
      return t !== null && Math.round(t) === argmaxBand;
    }) ?? null;

    const valueTable = computeValueTable(polymarketData.outcomes, distribution);
    // Best value bet = highest positive edge (market underprices our band the most).
    const bestValue = valueTable.find(v => v.edge > 0) ?? null;

    result.decision = {
      forecastRaw: Number(rawForecast.toFixed(2)),
      forecastRounded,          // Math.round(consensus mean) — for "forecast" band strategy
      forecastArgmax: argmaxBand, // argmax(distribution) — for "argmax" band strategy
      betOn: targetOutcome?.name ?? `${argmaxBand}°C`,  // display uses argmax
      marketPrice: targetOutcome?.probability != null
        ? Number(Number(targetOutcome.probability).toFixed(3))
        : null,
      confidence: confidenceScore,
      confidenceLabel: stats?.confidenceLabel ?? null,
      spread: Number((stats?.spread ?? 0).toFixed(2)),
      // Betting intelligence: our P per band, and where the market misprices it.
      distribution,
      value: valueTable,
      bestValue
    };
  } else {
    result.decision = {
      forecastRaw: Number((ensembleForecast.consensus?.consensusValue ?? stats?.median ?? 0).toFixed(2)),
      forecastRounded: Math.round(ensembleForecast.consensus?.consensusValue ?? stats?.median ?? 0),
      betOn: null,
      marketPrice: null,
      reason: 'Polymarket data unavailable'
    };
  }

  await logPrediction(result);

  // ── Console summary ──────────────────────────────────────────────────────
  console.log('\n=========== Weather signal ===========');
  console.log(`Target city: ${WEATHER_TARGET_CITY} (max temp for ${targetDate})`);
  console.log(`Models/sources: ${ensembleForecast.models.map((m) => `${m.label}=${m.maxTemp.toFixed(1)}°C (w=${(m.normalizedWeight * 100).toFixed(1)}%)`).join(', ')}`);
  if (ensembleForecast.stats) {
    console.log(`Stats → min ${ensembleForecast.stats.min.toFixed(1)}°C, max ${ensembleForecast.stats.max.toFixed(1)}°C, mean ${ensembleForecast.stats.mean.toFixed(1)}°C, spread ${ensembleForecast.stats.spread.toFixed(1)}°C`);
  }
  if (ensembleForecast.consensus) {
    console.log(`Consensus: ${ensembleForecast.consensus.consensusValue.toFixed(2)}°C → rounded: ${result.decision.forecastRounded}°C (${Math.round(ensembleForecast.consensus.agreementRatio * 100)}% sources agree, confidence: ${result.decision.confidenceLabel})`);
  }
  console.log(`Polymarket: ${marketLookup.slug ?? marketLookup.id ?? 'n/a'}`);
  if (result.decision.betOn) {
    const price = result.decision.marketPrice;
    console.log(`🎯 BET ON: "${result.decision.betOn}" @ ${price != null ? (price * 100).toFixed(1) + '% market price' : 'price unknown'}`);
  } else {
    console.log('Polymarket data unavailable — only weather consensus recorded.');
  }
  // Value table: our P vs market price vs edge, per band.
  if (result.decision.value?.length) {
    console.log('Value (наша P vs рынок):');
    for (const v of result.decision.value) {
      const tag = v.edge > 0.05 ? '  ✅ VALUE' : v.edge < -0.05 ? '  ✗' : '';
      console.log(`  ${v.name.padEnd(16)} ours ${(v.ourP * 100).toFixed(0).padStart(3)}% | mkt ${(v.price * 100).toFixed(0).padStart(3)}% | edge ${v.edge >= 0 ? '+' : ''}${(v.edge * 100).toFixed(0)}%${tag}`);
    }
    if (result.decision.bestValue) {
      const bv = result.decision.bestValue;
      console.log(`💰 BEST VALUE: "${bv.name}" edge +${(bv.edge * 100).toFixed(0)}% (наша ${(bv.ourP * 100).toFixed(0)}% vs рынок ${(bv.price * 100).toFixed(0)}%)`);
    }
  }
  console.log(`Log appended to ${(SILENT_MODE || MANUAL_MODE) ? HOURLY_LOG_PATH : LOG_PATH}`);
  console.log('=======================================\n');

  // Silent mode: skip Telegram, just log.
  if (SILENT_MODE) return;

  // ── Telegram notification ─────────────────────────────────────────────────
  const d = result.decision;
  const cons = ensembleForecast.consensus;
  const st = ensembleForecast.stats;
  const price = d.marketPrice != null ? `@ ${(d.marketPrice * 100).toFixed(1)}%` : '(price unknown)';
  const agreePct = cons ? Math.round(cons.agreementRatio * 100) : 0;

  // Per-model breakdown — sorted by value
  const modelLines = [...ensembleForecast.models]
    .sort((a, b) => a.maxTemp - b.maxTemp)
    .map(m => `  ${m.label}: ${m.maxTemp.toFixed(1)}°C`)
    .join('\n');

  let tgText = `🌡 <b>London max temp — ${targetDate}</b>\n\n`;
  tgText += `<b>Models:</b>\n${modelLines}\n\n`;
  tgText += `📊 <b>Stats:</b> min ${st?.min.toFixed(1)}°C | max ${st?.max.toFixed(1)}°C | spread ${st?.spread.toFixed(1)}°C\n`;
  tgText += `🤝 <b>Consensus:</b> ${agreePct}% of models agree on <b>${cons?.consensusValue.toFixed(1)}°C</b>\n`;
  tgText += `   → rounded to <b>${d.forecastRounded}°C</b> (confidence: ${d.confidenceLabel})\n\n`;
  tgText += `🎯 <b>BET ON: "${d.betOn ?? 'unknown'}"</b> ${price}`;

  // Value table — our P vs market, highlight mispriced bands.
  if (d.value?.length) {
    const valueLines = d.value
      .filter(v => Math.abs(v.edge) >= 0.03)
      .map(v => `  ${v.name}: наша ${(v.ourP * 100).toFixed(0)}% / рынок ${(v.price * 100).toFixed(0)}% → ${v.edge >= 0 ? '+' : ''}${(v.edge * 100).toFixed(0)}%${v.edge > 0.05 ? ' ✅' : ''}`)
      .join('\n');
    if (valueLines) tgText += `\n\n📈 <b>Value (наша P vs рынок):</b>\n${valueLines}`;
    if (d.bestValue) {
      tgText += `\n\n💰 <b>BEST VALUE: "${d.bestValue.name}"</b> — эдж +${(d.bestValue.edge * 100).toFixed(0)}% (мы ${(d.bestValue.ourP * 100).toFixed(0)}% vs рынок ${(d.bestValue.price * 100).toFixed(0)}%)`;
    }
  }

  await sendTelegram(tgText);
}

runPredictionCycle().catch(async (error) => {
  console.error('Prediction cycle failed:', error.message);
  await sendTelegram(`🚨 <b>Prediction cycle FAILED</b>\n${error.message}`);
  process.exit(1);
});
