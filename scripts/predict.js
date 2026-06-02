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

const WEATHER_LATITUDE = 51.5074;
const WEATHER_LONGITUDE = -0.1278;
const WEATHER_TIMEZONE = 'UTC';
const WEATHER_TARGET_CITY = 'London';

const OPEN_METEO_MODELS = [
  { id: 'ecmwf', label: 'ECMWF' },
  { id: 'icon', label: 'ICON' },
  { id: 'gfs', label: 'GFS' },
  { id: 'nam', label: 'NAM' },
  { id: 'gefs', label: 'GEFS' },
  { id: 'ukmo', label: 'UKMO' },
  { id: 'hrrr', label: 'HRRR' },
  { id: 'ecmwf_ifs', label: 'ECMWF IFS' },
  { id: 'icon_seamless', label: 'ICON Seamless' },
  { id: 'gfs_seamless', label: 'GFS Seamless' },
  { id: 'meteofrance_arpege_world', label: 'ARPEGE World' },
  { id: 'knmi_seamless', label: 'KNMI Seamless' }
];

const EXTERNAL_SOURCES = [
  { id: 'wttr', label: 'wttr.in' },
  { id: 'metno', label: 'Met Norway (Frost)' },
  { id: '7timer', label: '7timer' }
];

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

const TARGET_DAY_OFFSET = (() => {
  const value = parseInt(process.env.TARGET_DAY_OFFSET ?? '1', 10);
  return Number.isNaN(value) ? 1 : value;
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
      model: modelId
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

async function fetchWttrMax(targetDate) {
  return fetchWithRetry(async () => {
    const url = `https://wttr.in/${encodeURIComponent(WEATHER_TARGET_CITY)}?format=j1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Jarvis-weather/1.0' } });
    if (!response.ok) throw new Error(`wttr.in failed with ${response.status}`);
    const data = await response.json();
    const day = (data?.weather ?? []).find((item) => item?.date === targetDate);
    if (!day) throw new Error('wttr.in response missing target day');
    const max = Number.parseFloat(day?.maxtempC);
    if (Number.isNaN(max)) throw new Error('wttr.in returned invalid max temp');
    return { source: 'wttr', label: 'wttr.in', maxTemp: max };
  }, { label: 'wttr.in' });
}

async function fetchMetNoMax(targetDate) {
  return fetchWithRetry(async () => {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${WEATHER_LATITUDE}&lon=${WEATHER_LONGITUDE}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Jarvis-weather/1.0 (jarvis@openclaw.ai)',
        Accept: 'application/json'
      }
    });
    if (!response.ok) throw new Error(`Met Norway failed with ${response.status}`);
    const data = await response.json();
    const timeseries = data?.properties?.timeseries ?? [];
    const dailyTemps = {};
    for (const entry of timeseries) {
      const date = entry?.time?.slice(0, 10);
      const temp = entry?.data?.instant?.details?.air_temperature;
      if (!date || typeof temp !== 'number') continue;
      if (!dailyTemps[date]) dailyTemps[date] = temp;
      dailyTemps[date] = Math.max(dailyTemps[date], temp);
    }
    const max = dailyTemps[targetDate];
    if (max === undefined) throw new Error('Met Norway missing target date');
    return { source: 'metno', label: 'Met Norway', maxTemp: max };
  }, { label: 'Met Norway' });
}

async function fetch7TimerMax(targetDate) {
  return fetchWithRetry(async () => {
    const url = `https://www.7timer.info/bin/api.pl?lon=${WEATHER_LONGITUDE}&lat=${WEATHER_LATITUDE}&product=civillight&output=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`7timer failed with ${response.status}`);
    const data = await response.json();
    const series = data?.dataseries ?? [];
    const temps = series
      .filter((entry) => entry?.date)
      .reduce((acc, entry) => {
        const rawDate = entry.date?.toString();
        if (!rawDate) return acc;
        const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
        const temp = entry?.temp2m?.max;
        if (typeof temp !== 'number') return acc;
        if (!acc[date]) acc[date] = temp;
        acc[date] = Math.max(acc[date], temp);
        return acc;
      }, {});
    const max = temps[targetDate];
    if (max === undefined) throw new Error('7timer missing target date');
    return { source: '7timer', label: '7timer', maxTemp: max };
  }, { label: '7timer' });
}

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
      const name = m.groupItemTitle ?? m.question ?? '';
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
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(LOG_PATH, line, { encoding: 'utf8' });
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

  const openMeteoPromises = OPEN_METEO_MODELS.map(async (model) => {
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

  const externalPromises = EXTERNAL_SOURCES.map(async (source) => {
    try {
      if (source.id === 'wttr') return await fetchWttrMax(targetDate);
      if (source.id === 'metno') return await fetchMetNoMax(targetDate);
      if (source.id === '7timer') return await fetch7TimerMax(targetDate);
      return null;
    } catch (error) {
      console.warn(`${source.label} failed: ${error.message}`);
      return null;
    }
  });

  const readings = await Promise.all([...openMeteoPromises, ...externalPromises]);
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
          outcomeNames: polymarketData.outcomes.map((o) => o.name)
        }
      : null,
    decision: null
  };

  if (marketExpectation !== null) {
    const baseExpectation = ensembleForecast.consensus?.consensusValue ?? stats?.median;
    const diff = baseExpectation - marketExpectation;
    const valuePct = Math.abs(diff) / (marketExpectation || 1) * 100;
    const direction = diff > 0 ? 'warmer' : 'cooler';
    const wouldTrade = Math.abs(diff) >= VALUE_DIFF_THRESHOLD;
    const confidenceScore = stats?.confidenceScore ?? null;
    result.decision = {
      diff: Number(diff.toFixed(2)),
      valuePercent: Number(valuePct.toFixed(1)),
      signal: wouldTrade ? 'YES' : 'NO',
      direction,
      marketExpectation: Number(marketExpectation.toFixed(2)),
      ourExpectation: Number((baseExpectation ?? 0).toFixed(2)),
      confidence: confidenceScore,
      confidenceLabel: stats?.confidenceLabel ?? null
    };
  } else {
    result.decision = {
      signal: 'NONE',
      reason: 'Unable to derive a market expectation from Polymarket outcomes.'
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
    console.log(`Consensus estimate: ${ensembleForecast.consensus.consensusValue.toFixed(2)}°C (${Math.round(ensembleForecast.consensus.agreementRatio * 100)}% of sources agree${ensembleForecast.consensus.achieved ? '' : '; below threshold'})`);
  }
  console.log(`Polymarket lookup: ${marketLookup.source} slug="${marketLookup.slug ?? 'n/a'}" → ${marketLookup.id ?? 'not found'}`);
  if (result.market) {
    console.log(`Polymarket (${result.market.name}) expectation: ${result.market.expectation?.toFixed(2) ?? 'n/a'}°C`);
    console.log(`Decision signal: ${result.decision.signal}`);
    if (result.decision.signal === 'YES') {
      console.log(`We expect it to be ${result.decision.direction} by ${Math.abs(result.decision.diff).toFixed(2)}°C (value ${result.decision.valuePercent.toFixed(1)}%)`);
    } else {
      console.log('Value gap too small — hold position and watch how the forecast moves.');
    }
  } else {
    console.log('Polymarket data unavailable — only weather consensus recorded.');
  }
  console.log(`Consensus sources agreeing: ${ensembleForecast.consensus?.agreeingSources?.join(', ') ?? 'n/a'}`);
  console.log(`Log appended to ${LOG_PATH}`);
  console.log('=======================================\n');

  // ── Telegram notification ─────────────────────────────────────────────────
  const d = result.decision;
  const signalEmoji = d?.signal === 'YES' ? '🟢' : d?.signal === 'NO' ? '🔴' : '⚪';
  const confLabel = ensembleForecast.stats?.confidenceLabel ?? 'n/a';
  const modelCount = ensembleForecast.models.length;
  const sourceList = ensembleForecast.consensus?.agreeingSources?.slice(0, 4).join(', ') ?? 'n/a';

  let tgText = `${signalEmoji} <b>SIGNAL: ${d?.signal ?? 'NONE'}</b> — London max temp ${targetDate}\n`;
  if (d?.signal === 'YES' || d?.signal === 'NO') {
    tgText += `📊 Forecast: <b>${d.ourExpectation?.toFixed(2)}°C</b> | Market: <b>${d.marketExpectation?.toFixed(2)}°C</b> | Δ <b>${d.diff > 0 ? '+' : ''}${d.diff?.toFixed(2)}°C</b>\n`;
    tgText += `📈 Direction: ${d.direction} | Value: ${d.valuePercent?.toFixed(1)}%\n`;
  }
  tgText += `🌡 Spread: ${ensembleForecast.stats?.spread?.toFixed(1)}°C | Confidence: ${confLabel} | Sources: ${modelCount} (${sourceList})\n`;
  if (result.market?.name) tgText += `🏦 Market: ${result.market.name}`;

  await sendTelegram(tgText);
}

runPredictionCycle().catch(async (error) => {
  console.error('Prediction cycle failed:', error.message);
  await sendTelegram(`🚨 <b>Prediction cycle FAILED</b>\n${error.message}`);
  process.exit(1);
});
