/**
 * daily_report.js — Daily accuracy report sent to Telegram.
 *
 * For each date where we have BOTH a prediction AND a resolved Polymarket observation,
 * compares what we predicted (betOn temperature) vs what actually happened.
 * Sends a summary to Telegram once per day.
 *
 * Usage: node scripts/daily_report.js
 */

const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const fetch = global.fetch;
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const PREDICTION_LOG = path.resolve(LOG_DIR, 'predictions.ndjson');
const OBSERVED_LOG = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    console.log('Telegram not configured, printing to stdout:\n' + text);
    return;
  }
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const [predictions, observations] = await Promise.all([
    readJsonLines(PREDICTION_LOG),
    readJsonLines(OBSERVED_LOG)
  ]);

  // Build observed map: date → actual temp
  const observed = {};
  for (const o of observations) {
    if (o.date && typeof o.maxTemp === 'number') observed[o.date] = o.maxTemp;
  }

  // Build prediction map: date → latest prediction for that date
  const predByDate = {};
  for (const p of predictions) {
    const date = p.targetDate;
    if (!date) continue;
    // Keep latest prediction per date (highest timestamp)
    if (!predByDate[date] || p.timestamp > predByDate[date].timestamp) {
      predByDate[date] = p;
    }
  }

  // Match predictions with observations
  const results = [];
  for (const [date, pred] of Object.entries(predByDate)) {
    if (!(date in observed)) continue;
    const actual = observed[date];
    const forecastRaw = pred.decision?.forecastRaw ?? pred.ensembleForecast?.consensus?.consensusValue ?? pred.ensembleForecast?.stats?.mean;
    const forecastRounded = pred.decision?.forecastRounded ?? (forecastRaw != null ? Math.round(forecastRaw) : null);
    const betOn = pred.decision?.betOn ?? (forecastRounded != null ? `${forecastRounded}°C` : null);
    if (forecastRounded == null) continue;

    const hit = Math.round(actual) === forecastRounded;
    const err = Number((actual - forecastRaw).toFixed(1));
    results.push({ date, forecastRaw, forecastRounded, betOn, actual, hit, err });
  }

  // Sort newest first
  results.sort((a, b) => b.date.localeCompare(a.date));

  if (!results.length) {
    await sendTelegram('📊 <b>Daily Report</b>\nNo completed predictions to compare yet. Run fetch-history first.');
    return;
  }

  const hits = results.filter(r => r.hit).length;
  const total = results.length;
  const accuracy = Math.round((hits / total) * 100);
  const avgErrAll = (results.reduce((s, r) => s + Math.abs(r.err), 0) / total).toFixed(2);

  // Within 1°C hits (close but not exact)
  const within1 = results.filter(r => Math.abs(r.err) <= 1).length;
  const within1pct = Math.round((within1 / total) * 100);

  const last14 = results.slice(0, 14);
  const last7 = last14.slice(0, 7);
  const prev7 = last14.slice(7, 14);
  const hits14 = last14.filter(r => r.hit).length;
  const hits7 = last7.filter(r => r.hit).length;
  const hitsPrev7 = prev7.filter(r => r.hit).length;

  // Bias: avg signed error over last 14 (positive = we over-predict, negative = under-predict)
  const bias = last14.length
    ? (last14.reduce((s, r) => s + r.err, 0) / last14.length).toFixed(2)
    : '0.00';
  const biasDir = Number(bias) > 0.2 ? '↑ завышаем' : Number(bias) < -0.2 ? '↓ занижаем' : '≈ нейтрально';

  // Current streak
  let streak = 0;
  let streakType = null;
  for (const r of results) {
    if (streakType === null) streakType = r.hit;
    if (r.hit === streakType) streak++;
    else break;
  }
  const streakLabel = streakType ? `✅ ${streak} верных подряд` : `❌ ${streak} мимо подряд`;

  // Trend: last 7 vs prev 7
  const trendArrow = hits7 > hitsPrev7 ? '📈' : hits7 < hitsPrev7 ? '📉' : '➡️';
  const trendLabel = `${trendArrow} ${hits7}/${last7.length} vs ${hitsPrev7}/${prev7.length} пред.`;

  // Format recent results table (14 days)
  const rows = last14.map(r => {
    const icon = r.hit ? '✅' : '❌';
    const errStr = (r.err >= 0 ? '+' : '') + r.err;
    return `${icon} ${r.date}  пред:${r.forecastRounded}°  факт:${r.actual}°  (${errStr}°)`;
  }).join('\n');

  const msg =
    `📊 <b>Daily Accuracy Report</b>\n\n` +
    `<b>Всего за всё время: ${hits}/${total}</b>\n` +
    `  Точное попадание: <b>${accuracy}%</b>\n` +
    `  В пределах ±1°C: <b>${within1pct}%</b> (${within1}/${total})\n` +
    `  Средняя ошибка: ${avgErrAll}°C\n\n` +
    `<b>Последние 14 дней: ${hits14}/${last14.length}</b>\n` +
    `  Тренд: ${trendLabel}\n` +
    `  Bias: ${bias}°C (${biasDir})\n` +
    `  Серия: ${streakLabel}\n\n` +
    `<b>Прогноз vs Polymarket (14 дней):</b>\n<pre>${rows}</pre>`;

  await sendTelegram(msg);
  console.log(`Report sent: ${hits}/${total} accuracy (${accuracy}%), within1°C: ${within1pct}%, avg error ${avgErrAll}°C`);
}

main().catch(err => {
  console.error('daily_report failed:', err.message);
  process.exit(1);
});
