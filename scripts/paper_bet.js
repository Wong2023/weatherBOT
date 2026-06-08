/**
 * paper_bet.js — Paper-trading money management (bankroll + Kelly sizing).
 *
 * Runs once daily (≈13:00 MSK / 10:00 UTC). For each of 3 sizing strategies it
 * keeps a virtual bankroll and:
 *   1. Settles yesterday's open bet against the resolved Polymarket band.
 *   2. Picks today's band = our consensus/cluster band (decision.forecastRounded).
 *   3. Sizes a stake from that strategy's bank and "places" a paper bet.
 *   4. Logs everything and sends a Telegram summary.
 *
 * NO REAL MONEY. This is to validate which sizing strategy actually grows the
 * bank over ~2 weeks before risking anything real.
 *
 * Strategies (all share the same band pick + skip rules; they differ only in stake size):
 *   - kelly_pure      : ¼ Kelly on raw edge.            f = 0.25·(p−c)/(1−c)
 *   - kelly_shrunk    : ¼ Kelly after shrinking our P halfway to the market (recommended,
 *                       conservative while the model is uncalibrated). p_eff = ½p+½c
 *   - market_weighted : user's rule — stake grows with the market price (more market
 *                       agreement ⇒ bigger), cheap bands ⇒ smaller. f = 0.15·c
 *
 * Shared rules: only bet when edge = p−c > 0 AND market price c ≤ 0.60 (above that the
 * payout is too small — "не интересно"); hard cap 10% of bank per bet.
 *
 * Usage: node scripts/paper_bet.js [--date=YYYY-MM-DD] [--dry-run]
 */

const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const fetch = global.fetch;
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const PREDICTION_LOG = path.resolve(LOG_DIR, 'predictions.ndjson');
const HOURLY_LOG = path.resolve(LOG_DIR, 'predictions-hourly.ndjson');
const OBSERVED_LOG = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');
const BANK_PATH = path.resolve(LOG_DIR, 'bank.json');
const PAPER_BETS_LOG = path.resolve(LOG_DIR, 'paper-bets.ndjson');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Tunables ────────────────────────────────────────────────────────────────
const START_BANK = 100;
const KELLY_FRACTION = 0.25;     // quarter Kelly
const SHRINK_LAMBDA = 0.5;       // trust in our own P vs market (raise toward 1 as we calibrate)
const MAX_STAKE_FRAC = 0.10;     // never risk more than 10% of bank on one bet
const MAX_MARKET_PRICE = 0.60;   // skip if our band already priced above this (low payout)
const MIN_MARKET_PRICE = 0.02;   // skip if our band priced below this — Polymarket placeholder/illiquid
const MARKET_WEIGHTED_K = 0.15;  // slope for the market_weighted strategy

const STRATEGIES = ['kelly_pure', 'kelly_shrunk', 'market_weighted'];
const STRATEGY_LABEL = {
  kelly_pure: '¼ Kelly',
  kelly_shrunk: '¼ Kelly + ужатие в рынок',
  market_weighted: 'по рынку (∝ цена)'
};

// ── Args ────────────────────────────────────────────────────────────────────
function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map(s => {
    const [k, v] = s.split('=');
    return [k.replace(/^--?/, ''), v];
  }));
  return { date: a.date, dryRun: 'dry-run' in a || a['dry-run'] === 'true' };
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ── IO helpers ──────────────────────────────────────────────────────────────
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

async function loadBank() {
  try {
    const raw = await fs.readFile(BANK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.strategies) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Fresh bank.
  const strategies = {};
  for (const s of STRATEGIES) strategies[s] = { bank: START_BANK, open: null };
  return { startedAt: todayUTC(), strategies };
}

async function saveBank(bank, dryRun) {
  if (dryRun) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.writeFile(BANK_PATH, JSON.stringify(bank, null, 2), 'utf8');
}

async function appendPaperBet(entry, dryRun) {
  if (dryRun) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(PAPER_BETS_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(text); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' })
    });
  } catch (err) { console.warn('Telegram failed:', err.message); }
}

// ── Data extraction ─────────────────────────────────────────────────────────
// Latest prediction record for a target date (prefer the freshest by timestamp).
function latestPredictionForDate(records, date) {
  const matching = records.filter(r => r.targetDate === date && r.decision && r.timestamp);
  if (!matching.length) return null;
  matching.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return matching[0];
}

// Observed band (integer Polymarket truth) for a date.
function observedBandFor(observations, date) {
  for (const o of observations) {
    if (o.date !== date) continue;
    if (typeof o.maxTempBand === 'number') return o.maxTempBand;
    if (typeof o.maxTemp === 'number') return o.maxTemp;
  }
  return null;
}

// Pull the betting signal out of a prediction record.
// band = consensus/cluster band; p = our probability for that band; c = its market price.
function extractSignal(pred) {
  const d = pred.decision;
  const band = d.forecastRounded;
  if (band == null) return null;
  const dist = d.distribution || {};
  const p = typeof dist[band] === 'number' ? dist[band] : 0;
  const c = typeof d.marketPrice === 'number' ? d.marketPrice : null;
  if (c == null) return null; // can't price our band → no bet today
  return { band, p, c, edge: Number((p - c).toFixed(3)), betOn: d.betOn };
}

// ── Sizing ──────────────────────────────────────────────────────────────────
// Returns stake fraction of bank (0..MAX_STAKE_FRAC) for a strategy.
function stakeFraction(strategy, p, c) {
  const edge = p - c;
  // Shared skip rules.
  if (edge <= 0) return 0;
  if (c > MAX_MARKET_PRICE) return 0;
  if (c < MIN_MARKET_PRICE) return 0; // illiquid/placeholder price — don't trust the edge

  let f = 0;
  if (strategy === 'kelly_pure') {
    f = KELLY_FRACTION * (edge / (1 - c));
  } else if (strategy === 'kelly_shrunk') {
    const pEff = SHRINK_LAMBDA * p + (1 - SHRINK_LAMBDA) * c;
    const edgeEff = pEff - c;
    if (edgeEff <= 0) return 0;
    f = KELLY_FRACTION * (edgeEff / (1 - c));
  } else if (strategy === 'market_weighted') {
    f = MARKET_WEIGHTED_K * c; // grows with market price; cheap band ⇒ smaller
  }
  if (!Number.isFinite(f) || f <= 0) return 0;
  return Math.min(f, MAX_STAKE_FRAC);
}

// Settle a single open bet against the observed band. Returns {won, delta}.
function settleBet(open, observedBand) {
  const won = Math.round(observedBand) === open.band;
  // Buy at price c: stake S buys S/c shares paying 1 each on win.
  const delta = won ? open.stake * (1 - open.price) / open.price : -open.stake;
  return { won, delta: Number(delta.toFixed(2)) };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const { date: dateArg, dryRun } = parseArgs();
  const today = dateArg || todayUTC();

  const [mainPreds, hourlyPreds, observations] = await Promise.all([
    readJsonLines(PREDICTION_LOG),
    readJsonLines(HOURLY_LOG),
    readJsonLines(OBSERVED_LOG)
  ]);
  const allPreds = [...mainPreds, ...hourlyPreds];

  const bank = await loadBank();

  // ── 1. Settle any open bets that have now resolved ──────────────────────────
  const settlements = [];
  for (const s of STRATEGIES) {
    const st = bank.strategies[s] ?? (bank.strategies[s] = { bank: START_BANK, open: null });
    if (!st.open) continue;
    const obs = observedBandFor(observations, st.open.targetDate);
    if (obs == null) continue; // not resolved yet — leave open
    const { won, delta } = settleBet(st.open, obs);
    st.bank = Number((st.bank + delta).toFixed(2));
    const record = {
      type: 'settle', strategy: s, date: st.open.targetDate,
      band: st.open.band, stake: st.open.stake, price: st.open.price,
      observedBand: obs, won, delta, bankAfter: st.bank,
      settledAt: new Date().toISOString()
    };
    settlements.push(record);
    await appendPaperBet(record, dryRun);
    st.open = null;
  }

  // ── 2. Today's signal ───────────────────────────────────────────────────────
  const pred = latestPredictionForDate(allPreds, today);
  const signal = pred ? extractSignal(pred) : null;

  // ── 3. Size + place today's paper bets ──────────────────────────────────────
  const placements = [];
  for (const s of STRATEGIES) {
    const st = bank.strategies[s];
    if (st.open) continue; // safety: don't double-open (shouldn't happen after settle)
    if (!signal) continue;
    const frac = stakeFraction(s, signal.p, signal.c);
    const stake = Number((st.bank * frac).toFixed(2));
    if (stake <= 0) { placements.push({ strategy: s, skipped: true }); continue; }

    st.open = {
      targetDate: today, band: signal.band, betOn: signal.betOn,
      stake, price: signal.c, ourP: signal.p, edge: signal.edge,
      placedAt: new Date().toISOString()
    };
    const record = { type: 'place', strategy: s, ...st.open, bankBefore: st.bank };
    placements.push({ strategy: s, stake, frac });
    await appendPaperBet(record, dryRun);
  }

  await saveBank(bank, dryRun);

  // ── 4. Telegram summary ─────────────────────────────────────────────────────
  await sendTelegram(buildMessage({ today, signal, settlements, placements, bank }));
  console.log('paper_bet done.');
}

function pct(x) { return `${(x * 100).toFixed(0)}%`; }
function money(x) { return `$${x.toFixed(2)}`; }

function buildMessage({ today, signal, settlements, placements, bank }) {
  let msg = `💵 <b>Paper-trading — ${today}</b>\n`;

  if (settlements.length) {
    msg += `\n<b>Вчерашние ставки закрыты:</b>\n`;
    for (const s of settlements) {
      const icon = s.won ? '✅' : '❌';
      msg += `  ${icon} ${STRATEGY_LABEL[s.strategy]}: ${s.band}°C, факт ${s.observedBand}°C → ${s.delta >= 0 ? '+' : ''}${money(s.delta)}\n`;
    }
  }

  if (!signal) {
    msg += `\n⚠️ Нет прогноза на сегодня — ставки не размещены.`;
  } else {
    msg += `\n<b>Сегодня:</b> банд <b>${signal.band}°C</b> | наша P ${pct(signal.p)} / рынок ${pct(signal.c)} / эдж ${signal.edge >= 0 ? '+' : ''}${pct(signal.edge)}\n`;
    if (signal.edge <= 0) {
      msg += `  → нет эджа, ставки не размещены.\n`;
    } else if (signal.c > MAX_MARKET_PRICE) {
      msg += `  → рынок уже >${pct(MAX_MARKET_PRICE)} — пропуск (низкая выплата).\n`;
    } else if (signal.c < MIN_MARKET_PRICE) {
      msg += `  → рынок не торгует эту корзину (цена <${pct(MIN_MARKET_PRICE)}) — пропуск.\n`;
    } else {
      msg += `\n<b>Размер ставки по стратегиям:</b>\n`;
      for (const p of placements) {
        const st = bank.strategies[p.strategy];
        if (p.skipped || !st.open) {
          msg += `  • ${STRATEGY_LABEL[p.strategy]}: пропуск\n`;
        } else {
          msg += `  • ${STRATEGY_LABEL[p.strategy]}: <b>${money(p.stake)}</b> (${pct(p.frac)} банка)\n`;
        }
      }
    }
  }

  msg += `\n<b>Банк сейчас:</b>\n`;
  for (const s of STRATEGIES) {
    const b = bank.strategies[s].bank;
    const sign = b >= START_BANK ? '+' : '';
    msg += `  ${STRATEGY_LABEL[s]}: <b>${money(b)}</b> (${sign}${money(b - START_BANK)})\n`;
  }
  return msg;
}

main().catch(err => {
  console.error('paper_bet failed:', err.message);
  process.exit(1);
});
