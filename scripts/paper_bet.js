/**
 * paper_bet.js — Paper-trading, 9 strategies (3×3 factorial design).
 *
 * Runs daily at 10:10 UTC (13:10 MSK). For each strategy:
 *   1. Settles yesterday's open bet against resolved Polymarket band.
 *   2. Picks today's band via that strategy's selection method.
 *   3. Sizes the stake via that strategy's sizing method.
 *   4. Logs to bank.json + paper-bets.ndjson, sends Telegram summary.
 *
 * ── Factorial design 3×3 ────────────────────────────────────────────────────
 *
 * BAND SELECTION (what to bet on):
 *   forecast  — round(consensusValue). Current baseline.
 *   argmax    — band with most model votes (argmax of distribution).
 *   edge      — band with highest positive edge vs market price.
 *
 * SIZING (how much to bet):
 *   kelly_pure      — ⅓ Kelly on raw edge.       f = 0.33·(p−c)/(1−c)
 *   kelly_shrunk    — ⅓ Kelly, P shrunk halfway to market. p_eff = ½p+½c
 *   market_weighted — stake ∝ market price.       f = 0.15·c
 * All stakes are floored at $1 (Polymarket minimum order).
 *
 * STRATEGIES (9 total, naming: <sizing>_<band>):
 *   kelly_pure      = forecast + kelly_pure      (original, backward-compat)
 *   kelly_shrunk    = forecast + kelly_shrunk     (original, backward-compat)
 *   market_weighted = forecast + market_weighted  (original, backward-compat)
 *   argmax_pure     = argmax   + kelly_pure
 *   argmax_shrunk   = argmax   + kelly_shrunk
 *   argmax_mkt      = argmax   + market_weighted
 *   edge_pure       = edge     + kelly_pure
 *   edge_shrunk     = edge     + kelly_shrunk
 *   edge_mkt        = edge     + market_weighted
 *
 * After 14 days, analysis:
 *   Sizing winner  = avg ROI across 3 band methods per sizing
 *   Band winner    = avg ROI across 3 sizing methods per band selection
 *   Best combo     = top single strategy by ROI + Sharpe
 *
 * Usage: node scripts/paper_bet.js [--date=YYYY-MM-DD] [--dry-run]
 */

'use strict';
const fs   = require('fs/promises');
const path = require('path');
require('dotenv').config();

const fetch = global.fetch;
const LOG_DIR        = path.resolve(process.cwd(), 'logs');
const PREDICTION_LOG = path.resolve(LOG_DIR, 'predictions.ndjson');
const HOURLY_LOG     = path.resolve(LOG_DIR, 'predictions-hourly.ndjson');
const OBSERVED_LOG   = path.resolve(LOG_DIR, process.env.OBSERVED_LOG_PATH || 'observed-london.ndjson');
const BANK_PATH      = path.resolve(LOG_DIR, 'bank.json');
const BETS_LOG       = path.resolve(LOG_DIR, 'paper-bets.ndjson');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Tunables ──────────────────────────────────────────────────────────────────
const START_BANK         = 100;
const KELLY_FRACTION      = 0.33;   // ⅓ Kelly — meatier than ¼ but still conservative
const SHRINK_LAMBDA      = 0.5;
const MAX_STAKE_FRAC     = 0.10;
const MAX_MARKET_PRICE   = 0.60;   // above this the payoff is too thin to bother
const MIN_MARKET_PRICE   = 0.09;   // below this it's an illiquid longshot — skip
const MARKET_WEIGHTED_K  = 0.15;
const MIN_STAKE_USD      = 1.00;   // Polymarket minimum order — can't bet less than $1
// Conviction floor: when we bet our forecast band but the edge is ≤ 0 (market
// prices it as high or higher than we do), Kelly is undefined → fall back to a
// small flat stake. We still bet because the point forecast is our signal; the
// stake is tiny so a mispriced conviction bet can't hurt much.
const MIN_CONVICTION_FRAC = 0.01;

// ── Strategy definitions ──────────────────────────────────────────────────────
// Each strategy = { band: 'forecast'|'argmax'|'edge', sizing: 'kelly_pure'|'kelly_shrunk'|'market_weighted' }
const STRATEGY_CONFIG = {
  // Group: forecast band
  kelly_pure:      { band: 'forecast', sizing: 'kelly_pure' },
  kelly_shrunk:    { band: 'forecast', sizing: 'kelly_shrunk' },
  market_weighted: { band: 'forecast', sizing: 'market_weighted' },
  // Group: argmax(model distribution) band
  argmax_pure:     { band: 'argmax',   sizing: 'kelly_pure' },
  argmax_shrunk:   { band: 'argmax',   sizing: 'kelly_shrunk' },
  argmax_mkt:      { band: 'argmax',   sizing: 'market_weighted' },
  // Group: best edge vs market
  edge_pure:       { band: 'edge',     sizing: 'kelly_pure' },
  edge_shrunk:     { band: 'edge',     sizing: 'kelly_shrunk' },
  edge_mkt:        { band: 'edge',     sizing: 'market_weighted' },
};

const STRATEGIES = Object.keys(STRATEGY_CONFIG);

const STRATEGY_LABEL = {
  kelly_pure:      'forecast + ¼Kelly',
  kelly_shrunk:    'forecast + shrunk',
  market_weighted: 'forecast + mkt∝',
  argmax_pure:     'argmax + ¼Kelly',
  argmax_shrunk:   'argmax + shrunk',
  argmax_mkt:      'argmax + mkt∝',
  edge_pure:       'best-edge + ¼Kelly',
  edge_shrunk:     'best-edge + shrunk',
  edge_mkt:        'best-edge + mkt∝',
};

const BAND_GROUP = {
  forecast: 'Forecast band (round consensus)',
  argmax:   'Argmax band (most model votes)',
  edge:     'Best-edge band (max edge vs market)',
};

// ── Args ──────────────────────────────────────────────────────────────────────
function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map(s => {
    const [k, v] = s.replace(/^--?/, '').split('=');
    return [k, v];
  }));
  // --at=<ISO timestamp>: reconstruct the forecast state as of that moment
  // (used by backfill to pin to the morning snapshot's prices, not the latest).
  return { date: a.date, dryRun: 'dry-run' in a, at: a.at };
}

function todayUTC() { return new Date().toISOString().slice(0, 10); }

// ── IO ────────────────────────────────────────────────────────────────────────
async function readNdjson(filePath) {
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
  let bank;
  try {
    const raw = await fs.readFile(BANK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.strategies) bank = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!bank) bank = { startedAt: todayUTC(), strategies: {} };
  // Add missing strategies (migration-safe: new ones start fresh at $100)
  for (const s of STRATEGIES) {
    if (!bank.strategies[s]) bank.strategies[s] = { bank: START_BANK, open: null };
  }
  return bank;
}

async function saveBank(bank, dryRun) {
  if (dryRun) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.writeFile(BANK_PATH, JSON.stringify(bank, null, 2), 'utf8');
}

async function appendBet(entry, dryRun) {
  if (dryRun) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(BETS_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(text); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) { console.warn('Telegram error:', err.message); }
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function latestPred(records, date, at) {
  let m = records.filter(r => r.targetDate === date && r.decision && r.timestamp);
  // When pinning (--at), only consider snapshots taken at or before that instant.
  if (at) m = m.filter(r => String(r.timestamp) <= at);
  if (!m.length) return null;
  return m.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
}

function observedBand(observations, date) {
  for (const o of observations) {
    if (o.date !== date) continue;
    if (typeof o.maxTempBand === 'number') return o.maxTempBand;
    if (typeof o.maxTemp     === 'number') return o.maxTemp;
  }
  return null;
}

// ── Band selection ────────────────────────────────────────────────────────────
// Returns { band, betOn, p, c, edge } or null.
function selectBand(pred, method) {
  const d = pred.decision;
  if (!d) return null;
  const dist     = d.distribution || {};
  const value    = d.value        || [];
  const outcomes = pred.market?.outcomes || [];

  // Look up market price for a given integer band
  function marketPrice(band) {
    const o = outcomes.find(o => parseInt(o.name) === band);
    return o?.price ?? null;
  }

  if (method === 'forecast') {
    // forecastRounded = Math.round(consensus value) — set correctly in predict.js
    const band = d.forecastRounded;
    if (band == null) return null;
    const p = dist[String(band)] ?? 0;
    // Price MUST be looked up for THIS band — d.marketPrice is the argmax band's price,
    // which differs when forecast ≠ argmax. Using it would price a different basket.
    const c = marketPrice(band);
    if (c == null) return null;
    const o = outcomes.find(o => parseInt(o.name) === band);
    return { band, betOn: o?.name ?? `${band}°C`, p, c, edge: +(p - c).toFixed(3) };
  }

  if (method === 'argmax') {
    // argmax(distribution) — band with most model votes (d.forecastArgmax if available,
    // otherwise recompute from distribution directly)
    const argmaxBand = d.forecastArgmax != null
      ? d.forecastArgmax
      : (() => {
          const entries = Object.entries(dist).filter(([, v]) => v > 0);
          if (!entries.length) return null;
          return parseInt(entries.sort((a, b) => b[1] - a[1])[0][0]);
        })();
    if (argmaxBand == null) return null;
    const p = dist[String(argmaxBand)] ?? 0;
    const c = marketPrice(argmaxBand);
    if (c == null) return null;
    const o = outcomes.find(o => parseInt(o.name) === argmaxBand);
    return { band: argmaxBand, betOn: o?.name ?? `${argmaxBand}°C`, p, c, edge: +(p - c).toFixed(3) };
  }

  if (method === 'edge') {
    // Best edge available inside the tradable price window. We no longer require
    // edge > 0: if nothing is positive we still take the least-bad basket so the
    // strategy participates every day (value[] is pre-sorted by edge desc).
    const candidates = value.filter(v =>
      v.price >= MIN_MARKET_PRICE && v.price <= MAX_MARKET_PRICE
    );
    if (!candidates.length) return null;
    const top = candidates[0];
    const band = parseInt(top.name);
    if (isNaN(band)) return null;
    return { band, betOn: top.name, p: top.ourP, c: top.price, edge: +top.edge.toFixed(3) };
  }

  return null;
}

// ── Stake sizing ──────────────────────────────────────────────────────────────
// Price window is enforced by the caller; here we only turn (p, c) into a stake
// fraction. On non-positive edge the Kelly methods fall back to a flat conviction
// floor instead of returning 0, so a forecast-band bet still gets placed.
function stakeF(method, p, c) {
  if (c > MAX_MARKET_PRICE || c < MIN_MARKET_PRICE) return 0;
  const edge = p - c;
  let f = 0;
  if (method === 'kelly_pure') {
    f = edge > 0 ? KELLY_FRACTION * (edge / (1 - c)) : MIN_CONVICTION_FRAC;
  } else if (method === 'kelly_shrunk') {
    const pEff = SHRINK_LAMBDA * p + (1 - SHRINK_LAMBDA) * c;
    const eEff = pEff - c;
    f = eEff > 0 ? KELLY_FRACTION * (eEff / (1 - c)) : MIN_CONVICTION_FRAC;
  } else if (method === 'market_weighted') {
    f = MARKET_WEIGHTED_K * c;
  }
  return Number.isFinite(f) && f > 0 ? Math.min(f, MAX_STAKE_FRAC) : 0;
}

// ── Settlement ────────────────────────────────────────────────────────────────
function settle(open, obs) {
  const won   = Math.round(obs) === open.band;
  const delta = won ? +(open.stake * (1 - open.price) / open.price).toFixed(2) : -open.stake;
  return { won, delta };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const { date: dateArg, dryRun, at } = parseArgs();
  const today = dateArg || todayUTC();

  const [mainPreds, hourlyPreds, obs] = await Promise.all([
    readNdjson(PREDICTION_LOG),
    readNdjson(HOURLY_LOG),
    readNdjson(OBSERVED_LOG),
  ]);
  const allPreds = [...mainPreds, ...hourlyPreds];
  const pred     = latestPred(allPreds, today, at);
  const bank     = await loadBank();

  // 1. Settle
  const settlements = [];
  for (const s of STRATEGIES) {
    const st = bank.strategies[s];
    if (!st.open) continue;
    const fact = observedBand(obs, st.open.targetDate);
    if (fact == null) continue;
    const { won, delta } = settle(st.open, fact);
    st.bank = +((st.bank + delta).toFixed(2));
    const rec = {
      type: 'settle', strategy: s,
      date: st.open.targetDate, band: st.open.band, betOn: st.open.betOn,
      stake: st.open.stake, price: st.open.price,
      observedBand: fact, won, delta, bankAfter: st.bank,
      settledAt: new Date().toISOString(),
    };
    settlements.push(rec);
    await appendBet(rec, dryRun);
    st.open = null;
  }

  // 2. Place
  const placements = [];
  for (const s of STRATEGIES) {
    const cfg = STRATEGY_CONFIG[s];
    const st  = bank.strategies[s];
    if (st.open) continue;

    if (!pred) {
      placements.push({ strategy: s, skipped: true, reason: 'no_forecast' });
      continue;
    }

    const sig = selectBand(pred, cfg.band);
    // Bet whenever the chosen basket sits inside the tradable price window
    // [MIN, MAX]. We deliberately do NOT gate on edge sign anymore: the forecast
    // itself is the signal, so we still bet (small) even on non-positive edge.
    if (!sig) {
      placements.push({ strategy: s, skipped: true, reason: 'no_signal' });
      continue;
    }
    if (sig.c > MAX_MARKET_PRICE || sig.c < MIN_MARKET_PRICE) {
      placements.push({ strategy: s, skipped: true, reason: 'out_of_price_band' });
      continue;
    }

    const frac = stakeF(cfg.sizing, sig.p, sig.c);
    let stake  = +((st.bank * frac).toFixed(2));
    // Polymarket won't accept orders under ~$1: round a tiny stake up to the
    // floor, or skip if the bank can't even cover $1.
    if (frac > 0 && stake < MIN_STAKE_USD) stake = st.bank >= MIN_STAKE_USD ? MIN_STAKE_USD : 0;
    if (stake <= 0) {
      placements.push({ strategy: s, skipped: true, reason: frac > 0 ? 'below_min_stake' : 'zero_stake' });
      continue;
    }

    st.open = {
      targetDate: today, band: sig.band, betOn: sig.betOn,
      stake, price: sig.c, ourP: sig.p, edge: sig.edge,
      placedAt: new Date().toISOString(),
    };
    await appendBet({ type: 'place', strategy: s, ...st.open, bankBefore: st.bank }, dryRun);
    placements.push({ strategy: s, skipped: false, stake, frac, sig });
  }

  await saveBank(bank, dryRun);
  await sendTelegram(buildMessage({ today, settlements, placements, bank }));
  console.log(`paper_bet done — ${today}${dryRun ? ' [DRY RUN]' : ''}`);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function pct(x)   { return `${(x * 100).toFixed(0)}%`; }
function money(x) { return `$${x.toFixed(2)}`; }
function roiStr(b) {
  const r = b - START_BANK;
  return `${r >= 0 ? '+' : ''}${money(r)}`;
}

function buildMessage({ today, settlements, placements, bank }) {
  let msg = `💵 <b>Paper-trading — ${today}</b>\n`;

  // Settlements
  if (settlements.length) {
    msg += `\n<b>Закрыто вчера:</b>\n`;
    for (const s of settlements) {
      msg += `  ${s.won ? '✅' : '❌'} [${STRATEGY_LABEL[s.strategy]}] ${s.betOn} · факт ${s.observedBand}°C · ${s.delta >= 0 ? '+' : ''}${money(s.delta)}\n`;
    }
  }

  // Placements grouped by band method
  const byBand = { forecast: [], argmax: [], edge: [] };
  for (const p of placements) {
    const g = STRATEGY_CONFIG[p.strategy].band;
    byBand[g].push(p);
  }

  msg += `\n<b>Ставки сегодня:</b>\n`;
  for (const [bandMethod, items] of Object.entries(byBand)) {
    msg += `\n<i>📐 ${BAND_GROUP[bandMethod]}:</i>\n`;
    for (const p of items) {
      const sizingName = STRATEGY_CONFIG[p.strategy].sizing.replace('kelly_', '').replace('market_weighted', 'mkt∝');
      if (p.skipped) {
        const why = p.reason === 'out_of_price_band' ? 'цена вне 9–60%'
                  : p.reason === 'no_signal'         ? 'нет сигнала'
                  : p.reason === 'below_min_stake'   ? 'банк < $1'
                  : p.reason === 'zero_stake'        ? 'ставка 0'
                  : p.reason === 'no_forecast'       ? 'нет прогноза'
                  : p.reason;
        msg += `  • ${sizingName}: пропуск (${why})\n`;
      } else {
        msg += `  • ${sizingName}: <b>${p.sig.betOn}</b> · ${money(p.stake)} (${pct(p.frac)}) · P ${pct(p.sig.p)} vs рынок ${pct(p.sig.c)} · эдж +${pct(p.sig.edge)}\n`;
      }
    }
  }

  // Bank summary grouped by band method
  msg += `\n<b>Банк ($ из ${START_BANK}):</b>\n`;
  for (const [bandMethod, label] of Object.entries(BAND_GROUP)) {
    const group = STRATEGIES.filter(s => STRATEGY_CONFIG[s].band === bandMethod);
    msg += `<i>${label.split('(')[0].trim()}:</i>\n`;
    for (const s of group) {
      const b = bank.strategies[s].bank;
      msg += `  ${STRATEGY_LABEL[s]}: <b>${money(b)}</b> (${roiStr(b)})\n`;
    }
  }

  return msg;
}

main().catch(err => { console.error('paper_bet failed:', err.message); process.exit(1); });
