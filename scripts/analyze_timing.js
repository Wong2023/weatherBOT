/**
 * analyze_timing.js — Weekly timing analysis.
 *
 * Reads the hourly silent-mode log (logs/predictions-hourly.ndjson) and
 * compares each hourly forecast against actual Polymarket observations.
 *
 * Answers two questions:
 *   A. Same-day forecasts (TARGET_DAY_OFFSET=0, before 09:00 UTC):
 *      at which UTC hour is our forecast most accurate for TODAY?
 *
 *   B. Next-day forecasts (TARGET_DAY_OFFSET=1, before 21:00 UTC):
 *      at which UTC hour is our forecast most accurate for TOMORROW?
 *
 * Sends a Telegram report with the best hours to trust.
 *
 * Usage: node scripts/analyze_timing.js [--days=7]
 */

const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const fetch = global.fetch;
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const HOURLY_LOG = path.resolve(LOG_DIR, 'predictions-hourly.ndjson');
const OBSERVED_LOG = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map(s => {
    const [k, v] = s.split('=');
    return [k.replace(/^--?/, ''), v];
  }));
  return { days: parseInt(a.days ?? '7', 10) };
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text); return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (err) { console.warn('Telegram failed:', err.message); }
}

function hourlyStats(entries) {
  // entries: [{hour, forecastRounded, actual}]
  const byHour = {};
  for (const e of entries) {
    const h = e.hour;
    if (!(h in byHour)) byHour[h] = { hits: 0, total: 0, absErrors: [] };
    byHour[h].total++;
    byHour[h].absErrors.push(Math.abs(e.forecastRounded - e.actual));
    if (e.forecastRounded === Math.round(e.actual)) byHour[h].hits++;
  }
  return Object.entries(byHour)
    .map(([hour, s]) => ({
      hour: Number(hour),
      accuracy: Math.round((s.hits / s.total) * 100),
      avgErr: (s.absErrors.reduce((a, b) => a + b, 0) / s.absErrors.length).toFixed(2),
      samples: s.total
    }))
    .sort((a, b) => b.accuracy - a.accuracy || a.avgErr - b.avgErr);
}

async function main() {
  const { days } = parseArgs();
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffISO = cutoff.toISOString();

  const [hourlyPreds, observations] = await Promise.all([
    readJsonLines(HOURLY_LOG),
    readJsonLines(OBSERVED_LOG)
  ]);

  const observed = {};
  for (const o of observations) {
    if (!o.date) continue;
    // Timing analysis is about BETTING → use the Polymarket band (integer payout truth).
    const band = typeof o.maxTempBand === 'number' ? o.maxTempBand
      : (typeof o.maxTemp === 'number' ? o.maxTemp : null);
    if (band !== null) observed[o.date] = band;
  }

  // Filter to last N days
  const recent = hourlyPreds.filter(p => (p.timestamp ?? '') >= cutoffISO);

  if (!recent.length) {
    await sendTelegram(`⏰ <b>Timing Analysis</b>\nNo hourly data yet.\nMake sure the hourly cron (node scripts/predict.js --silent) is running.`);
    return;
  }

  const sameDayEntries = [];   // offset=0, hour <= 14 UTC (≤17:00 MSK, before peak settles)
  const nextDayEntries = [];   // offset=1, hour < 21 UTC

  for (const p of recent) {
    const actual = observed[p.targetDate];
    if (actual === undefined) continue;
    const forecastRaw = p.decision?.forecastRaw ?? p.ensembleForecast?.consensus?.consensusValue;
    if (forecastRaw == null) continue;
    // Measure the band we actually bet/display (betOn = argmax). Fall back to
    // forecastRounded, then round(raw) for older logs predating the split.
    const forecastRounded = p.decision?.forecastArgmax
      ?? p.decision?.forecastRounded
      ?? Math.round(forecastRaw);
    const hour = new Date(p.timestamp).getUTCHours();
    const offset = p.targetDayOffset ?? 1;

    if (offset === 0 && hour <= 14) {
      sameDayEntries.push({ hour, forecastRounded, actual });
    } else if (offset === 1 && hour < 21) {
      nextDayEntries.push({ hour, forecastRounded, actual });
    }
  }

  function formatTable(stats, label) {
    if (!stats.length) return `${label}: no data yet\n`;
    const rows = stats.slice(0, 5).map(s =>
      `  ${String(s.hour).padStart(2, '0')}:00 UTC — ${s.accuracy}% acc, err ${s.avgErr}°C (n=${s.samples})`
    ).join('\n');
    return `<b>${label}</b>\n<pre>${rows}</pre>`;
  }

  const sdStats = hourlyStats(sameDayEntries);
  const ndStats = hourlyStats(nextDayEntries);

  const totalSamples = sameDayEntries.length + nextDayEntries.length;
  const msg =
    `⏰ <b>Timing Analysis — last ${days} days</b>\n` +
    `(${totalSamples} hourly forecasts evaluated)\n\n` +
    formatTable(sdStats, '📍 Same-day (offset=0, ≤14:00 UTC / 17:00 MSK)') + '\n' +
    formatTable(ndStats, '📅 Next-day (offset=1, before 21:00 UTC)') + '\n' +
    `<i>Best hour = highest accuracy, lowest avg error</i>`;

  await sendTelegram(msg);
  console.log('Timing analysis sent.');
}

main().catch(err => {
  console.error('analyze_timing failed:', err.message);
  process.exit(1);
});
