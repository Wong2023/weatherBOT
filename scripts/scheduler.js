/**
 * scheduler.js — Background scheduler for weatherBOT.
 *
 * Runs three recurring jobs:
 *   1. Hourly silent forecasts  — every hour, no Telegram, logs to predictions-hourly.ndjson
 *   2. Daily full run           — 09:00 UTC: fetch observed + daily report + TODAY's prediction (offset=0) with Telegram
 *   3. Weekly timing report     — Sunday 10:00 UTC: analyze_timing.js sends timing accuracy to Telegram
 *
 * Usage:
 *   node scripts/scheduler.js
 *
 * Keep it running in the background (pm2, screen, Windows Task Scheduler on startup, etc.)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const SCRIPTS = {
  predictSilent: path.resolve(__dirname, 'predict.js'),
  dailyRun:      path.resolve(__dirname, 'run.js'),
  timingReport:  path.resolve(__dirname, 'analyze_timing.js'),
  paperBet:      path.resolve(__dirname, 'paper_bet.js'),
};

function log(msg) {
  console.log(`[scheduler] ${new Date().toISOString()}  ${msg}`);
}

function run(label, scriptPath, extraArgs = [], extraEnv = {}) {
  log(`▶ ${label}`);
  try {
    execFileSync(process.execPath, [scriptPath, ...extraArgs], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv }
    });
    log(`✅ ${label} — done`);
  } catch (err) {
    log(`❌ ${label} — failed (exit ${err.status ?? '?'}): ${err.message}`);
  }
}

// Same-day forecasts only make sense before the daily temperature peak.
// London peak ≈ 15:00–16:00 local (BST). 14:00 UTC = 17:00 MSK = 15:00 London.
// After this, today's max is effectively settled → no betting value, stop offset=0.
const SAME_DAY_CUTOFF_UTC = 14;

// ── State tracking ─────────────────────────────────────────────────────────────
let lastHourlyHour   = -1;  // UTC hour when last hourly run fired
let lastDailyDate    = '';  // YYYY-MM-DD of last daily run
let lastWeeklyDate   = '';  // YYYY-MM-DD of last weekly report (Sunday)
let lastBetDate      = '';  // YYYY-MM-DD of last paper-bet signal

function utcDateStr(d) {
  return d.toISOString().slice(0, 10);
}

// ── Main tick — runs every 60 seconds ─────────────────────────────────────────
function tick() {
  const now   = new Date();
  const hour  = now.getUTCHours();
  const min   = now.getUTCMinutes();
  const today = utcDateStr(now);
  const dow   = now.getUTCDay(); // 0 = Sunday

  // 1. Hourly silent forecasts — fire once per UTC hour (at :01 to avoid overlap with daily)
  if (min >= 1 && hour !== lastHourlyHour) {
    lastHourlyHour = hour;
    // Always forecast TOMORROW (offset=1) — long lead-time data for next-day timing.
    run('Hourly forecast — tomorrow', SCRIPTS.predictSilent, ['--silent'], { TARGET_DAY_OFFSET: '1' });
    // Also forecast TODAY (offset=0) until the peak has passed (≤14:00 UTC = 17:00 MSK).
    if (hour <= SAME_DAY_CUTOFF_UTC) {
      run('Hourly forecast — today', SCRIPTS.predictSilent, ['--silent'], { TARGET_DAY_OFFSET: '0' });
    }
  }

  // 2. Daily full run — 10:00 UTC (≈13:00 MSK): fetch observed + accuracy report + TODAY forecast → Telegram.
  //    Moved from 09:00 UTC so the signal arrives together with paper-bet at 13:00 MSK.
  if (hour === 10 && min >= 0 && lastDailyDate !== today) {
    lastDailyDate = today;
    run('Daily full run (fetch + report + predict TODAY)', SCRIPTS.dailyRun, [], { TARGET_DAY_OFFSET: '0' });
  }

  // 3. Daily paper-bet signal — 10:10 UTC (≈13:10 MSK): settle + size + Telegram.
  //    Runs at :10 so the daily run above (fetch + predict) finishes first → freshest signal.
  if (hour === 10 && min >= 10 && lastBetDate !== today) {
    lastBetDate = today;
    run('Daily paper-bet signal', SCRIPTS.paperBet);
  }

  // 4. Weekly timing report — Sunday 10:00 UTC (only once per calendar day)
  if (dow === 0 && hour === 10 && min >= 0 && lastWeeklyDate !== today) {
    lastWeeklyDate = today;
    run('Weekly timing analysis', SCRIPTS.timingReport, ['--days=7']);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
log('weatherBOT scheduler started.');
log('Jobs: hourly forecast tomorrow + today(≤17:00 MSK) | daily 10:00 UTC (13:00 MSK) report+bet | weekly timing Sunday 10:00 UTC');

// Fire immediately on startup so we don't wait up to an hour for first run.
run('Startup: initial hourly forecast (tomorrow)', SCRIPTS.predictSilent, ['--silent'], { TARGET_DAY_OFFSET: '1' });
if (new Date().getUTCHours() <= SAME_DAY_CUTOFF_UTC) {
  run('Startup: initial hourly forecast (today)', SCRIPTS.predictSilent, ['--silent'], { TARGET_DAY_OFFSET: '0' });
}
lastHourlyHour = new Date().getUTCHours();

// Check every 60 seconds.
setInterval(tick, 60 * 1000);
