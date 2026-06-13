/**
 * track_wallet.js — Read-only tracker + paper copy-trader for a Polymarket wallet.
 *
 * Studies a target wallet's weather-market trading and simulates copying it on
 * paper, honestly accounting for the fact that we always act AFTER them:
 *   - they BUY first → we enter a beat later at a slightly worse price (slippage)
 *   - they SELL/exit first → we exit a beat later, also at a worse price
 * On thin weather markets that lag is a real cost, so every copied fill eats a
 * configurable slippage. Paper only — no orders are ever placed.
 *
 * Data source: Polymarket public Data API (no auth, read-only):
 *   activity : https://data-api.polymarket.com/activity?user=<addr>
 *   profit   : https://lb-api.polymarket.com/profit?address=<addr>
 *
 * Modes:
 *   --stats               Historical performance: P&L, win-rate, cities, sizing.
 *   --backtest            Replay the WHOLE history as if we'd copied 1:1, with
 *                         slippage, and report our P&L vs theirs. Sweeps a few
 *                         slippage levels so you can see the break-even lag cost.
 *   --copy                Incremental paper copy: pull trades newer than the last
 *                         run, mirror them into logs/copy-state.json + copy-trades
 *                         .ndjson. Meant to run on a schedule (cron / scheduler).
 *
 * Options:
 *   --wallet=0x...        Target wallet (default = WEATHERK1LLER below).
 *   --slippage=0.02       Per-fill price penalty for acting late (default 2%).
 *   --scale=0.25          Copy size = their USDC size × scale (copy mode only).
 *   --bank=100            Starting paper bank (copy mode only).
 *   --json                Print machine-readable JSON instead of text.
 *
 * Usage:
 *   node scripts/track_wallet.js --stats
 *   node scripts/track_wallet.js --backtest
 *   node scripts/track_wallet.js --backtest --slippage=0.03
 *   node scripts/track_wallet.js --copy --scale=0.25 --bank=100
 */

'use strict';
const fs   = require('fs/promises');
const path = require('path');
require('dotenv').config();

const fetch = global.fetch;

// Default target: the +$3k/month weather trader Arseniy flagged (June 2026).
const WEATHERK1LLER = '0xce071d8aa5c90f92965e08df65175d147caf5c3c';

const DATA_API = 'https://data-api.polymarket.com';
const LB_API   = 'https://lb-api.polymarket.com';

const LOG_DIR     = path.resolve(process.cwd(), 'logs');
const STATE_PATH  = path.resolve(LOG_DIR, 'copy-state.json');
const COPY_LOG    = path.resolve(LOG_DIR, 'copy-trades.ndjson');

// ── Args ────────────────────────────────────────────────────────────────────
function parseArgs() {
  const a = Object.fromEntries(process.argv.slice(2).map(s => {
    const [k, v] = s.replace(/^--?/, '').split('=');
    return [k, v === undefined ? true : v];
  }));
  return {
    mode:     a.stats ? 'stats' : a.backtest ? 'backtest' : a.copy ? 'copy' : 'stats',
    wallet:   (a.wallet || process.env.COPY_WALLET || WEATHERK1LLER).toLowerCase(),
    slippage: a.slippage != null ? Number(a.slippage) : 0.02,
    spread:   a.spread != null ? Number(a.spread) : 0.01,
    scale:    a.scale != null ? Number(a.scale) : 0.25,
    bank:     a.bank != null ? Number(a.bank) : 100,
    loop:     a.loop != null ? Number(a.loop) : 0,
    json:     !!a.json,
  };
}

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchAllActivity(wallet, sinceTs = 0) {
  let all = [], offset = 0;
  for (;;) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=500&offset=${offset}` +
                `&sortBy=TIMESTAMP&sortDirection=ASC`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`activity ${r.status}`);
    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    all = all.concat(page);
    offset += page.length;
    if (page.length < 500) break;
  }
  return sinceTs ? all.filter(e => e.timestamp > sinceTs) : all;
}

// Lightweight incremental fetch for the daemon: newest page only, filtered to
// events after the cursor. If the page is full AND every row is new, there may
// be more than one page of backlog → fall back to the full paginated fetch.
async function fetchRecentActivity(wallet, sinceTs) {
  const r = await fetch(`${DATA_API}/activity?user=${wallet}&limit=300&sortBy=TIMESTAMP&sortDirection=DESC`);
  if (!r.ok) throw new Error(`activity ${r.status}`);
  const page = await r.json();
  if (!Array.isArray(page)) return [];
  const fresh = page.filter(e => e.timestamp > sinceTs);
  if (page.length === 300 && fresh.length === 300) return fetchAllActivity(wallet, sinceTs);
  return fresh.sort((a, b) => a.timestamp - b.timestamp);
}

// Real executable price at OUR (delayed) execution moment. The live order book
// (/price) is unreliable on thin weather markets — it returns crossed bid/ask —
// so we use the last traded price from prices-history (1-min), which is clean.
// Returns null if unavailable → caller falls back to the copied trade's price.
const CLOB = 'https://clob.polymarket.com';
async function livePrice(tokenId) {
  try {
    const end = Math.floor(Date.now() / 1000);
    const r = await fetch(`${CLOB}/prices-history?market=${tokenId}&startTs=${end - 600}&endTs=${end}&fidelity=1`);
    if (!r.ok) return null;
    const h = (await r.json()).history;
    if (!Array.isArray(h) || !h.length) return null;
    const p = h[h.length - 1].p;
    return (p > 0.0005 && p < 0.9995) ? p : null;
  } catch { return null; }
}

async function fetchProfit(wallet) {
  try {
    const r = await fetch(`${LB_API}/profit?window=all&limit=1&address=${wallet}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) && j[0] ? j[0].amount : null;
  } catch { return null; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const CITY_RE = /highest-temperature-in-([a-z-]+?)-on-/;
function cityOf(slug) { const m = (slug || '').match(CITY_RE); return m ? m[1] : 'other'; }
function iso(ts)      { return new Date(ts * 1000).toISOString(); }
function money(x)     { return `$${x.toFixed(2)}`; }

// Group raw events into per-market ledgers (by conditionId).
function buildMarkets(events) {
  const M = {};
  for (const e of events) {
    if (!['TRADE', 'REDEEM'].includes(e.type)) continue;
    const k = e.conditionId;
    if (!M[k]) M[k] = { slug: e.slug, title: e.title, buy: 0, sell: 0, redeem: 0, shares: 0, t0: e.timestamp, t1: e.timestamp, trades: 0 };
    const m = M[k];
    m.t0 = Math.min(m.t0, e.timestamp);
    m.t1 = Math.max(m.t1, e.timestamp);
    if (e.type === 'TRADE') {
      m.trades++;
      if (e.side === 'BUY') { m.buy  += e.usdcSize; m.shares += e.size; }
      else                  { m.sell += e.usdcSize; m.shares -= e.size; }
    } else if (e.type === 'REDEEM') {
      m.redeem += (e.usdcSize || 0);
    }
  }
  for (const m of Object.values(M)) m.pnl = m.sell + m.redeem - m.buy;
  return Object.values(M);
}

// ── Mode: stats ─────────────────────────────────────────────────────────────
async function runStats({ wallet, json }) {
  const events = await fetchAllActivity(wallet);
  const trades = events.filter(e => e.type === 'TRADE');
  if (!trades.length) { console.log('No trades for this wallet.'); return; }
  const markets = buildMarkets(events);
  const profit  = await fetchProfit(wallet);

  let wins = 0, losses = 0, flat = 0, net = 0, deployed = 0;
  const cities = {};
  for (const m of markets) {
    net += m.pnl; deployed += m.buy;
    if (m.pnl > 0.5) wins++; else if (m.pnl < -0.5) losses++; else flat++;
    const c = cityOf(m.slug); cities[c] = (cities[c] || 0) + m.pnl;
  }
  const holds  = markets.map(m => (m.t1 - m.t0) / 3600);
  const avgHold = holds.reduce((a, b) => a + b, 0) / holds.length;
  const winrate = wins + losses ? wins / (wins + losses) : 0;
  const topCities = Object.entries(cities).sort((a, b) => b[1] - a[1]);

  const summary = {
    wallet,
    firstTrade: iso(trades[0].timestamp),
    lastTrade:  iso(trades[trades.length - 1].timestamp),
    trades: trades.length, markets: markets.length,
    netPnl: +net.toFixed(2), apiProfitAllTime: profit != null ? +profit.toFixed(2) : null,
    winrate: +(winrate * 100).toFixed(1), wins, losses, flat,
    deployed: +deployed.toFixed(2), roiOnTurnover: +(net / deployed * 100).toFixed(1),
    avgBet: +(deployed / markets.length).toFixed(2),
    avgHoldHours: +avgHold.toFixed(1),
    topCities: topCities.slice(0, 10).map(([c, p]) => ({ city: c, pnl: +p.toFixed(0) })),
  };
  if (json) { console.log(JSON.stringify(summary, null, 2)); return; }

  console.log(`\n📊 Wallet stats — ${wallet}`);
  console.log(`   ${summary.firstTrade.slice(0,10)} → ${summary.lastTrade.slice(0,10)}  (${summary.trades} trades, ${summary.markets} markets)`);
  console.log(`\n   Net P&L (sell+redeem−buy): ${money(net)}`);
  if (profit != null) console.log(`   API reported all-time profit: ${money(profit)}`);
  console.log(`   Win-rate: ${summary.winrate}%  (${wins}W / ${losses}L / ${flat} flat)`);
  console.log(`   Deployed (Σ buys): ${money(deployed)}  →  ROI on turnover: ${summary.roiOnTurnover}%`);
  console.log(`   Avg bet: ${money(summary.avgBet)}  ·  Avg market lifecycle: ${summary.avgHoldHours}h`);
  console.log(`\n   Top cities by P&L:`);
  for (const { city, pnl } of summary.topCities) console.log(`     ${city.padEnd(16)} ${pnl >= 0 ? '+' : ''}${money(pnl)}`);
  console.log('');
}

// ── Mode: backtest ───────────────────────────────────────────────────────────
// Replay every fill as if we copied it 1:1, charging `slip` on each entry/exit
// to model the late-follow penalty. We can't know the real price `delay` minutes
// after their fill (no historical orderbook on paper), so slippage is the honest
// stand-in. Result = our net vs theirs at several slippage levels.
async function runBacktest({ wallet, slippage, json }) {
  const events = await fetchAllActivity(wallet);
  const trades = events.filter(e => e.type === 'TRADE');
  if (!trades.length) { console.log('No trades to backtest.'); return; }

  const theirNet = buildMarkets(events).reduce((a, m) => a + m.pnl, 0);

  // For a copier, each of their fills becomes our fill at a worse price:
  //   our BUY  cost   = size · price·(1+slip)
  //   our SELL payout = size · price·(1−slip)
  //   REDEEM payout   = unchanged (settlement is at 0/1, no slippage)
  function copyNet(slip) {
    let net = 0;
    for (const e of events) {
      if (e.type === 'TRADE') {
        const px = e.side === 'BUY' ? e.price * (1 + slip) : e.price * (1 - slip);
        net += e.side === 'BUY' ? -e.size * px : e.size * px;
      } else if (e.type === 'REDEEM') {
        net += (e.usdcSize || 0);
      }
    }
    return net;
  }

  const levels = [0, 0.01, 0.02, 0.03, 0.05, slippage]
    .filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const rows = levels.map(s => ({ slip: s, net: +copyNet(s).toFixed(2) }));

  if (json) { console.log(JSON.stringify({ wallet, theirNet: +theirNet.toFixed(2), rows }, null, 2)); return; }

  console.log(`\n🔁 Copy backtest — ${wallet}`);
  console.log(`   Their net P&L (no copy cost):        ${money(theirNet)}`);
  console.log(`   Our net if we'd copied 1:1, by per-fill slippage:`);
  for (const { slip, net } of rows) {
    const keep = theirNet ? (net / theirNet * 100) : 0;
    const flag = net <= 0 ? ' ❌ underwater' : keep < 50 ? ' ⚠️ lag eats most edge' : ' ✅';
    console.log(`     slip ${(slip * 100).toFixed(0).padStart(2)}%  →  ${money(net).padStart(10)}  (${keep.toFixed(0)}% of theirs)${flag}`);
  }
  // Break-even slippage: where copy net crosses 0.
  let be = null;
  for (let s = 0; s <= 0.20; s += 0.001) { if (copyNet(s) <= 0) { be = s; break; } }
  console.log(`\n   Break-even slippage: ${be != null ? (be * 100).toFixed(1) + '% per fill' : '>20% (very robust)'}`);
  console.log(`   → Above that average lag cost, copying loses money.\n`);
}

// ── Mode: copy (incremental paper copy) ───────────────────────────────────────
async function loadState(startBank) {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s.bank === 'number') return s;
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return { wallet: null, cursorTs: 0, bank: startBank, startBank, realized: 0, positions: {}, seenTx: [] };
}
async function saveState(s) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2), 'utf8');
}
async function appendCopy(entry) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(COPY_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

async function runCopy({ wallet, slippage, spread, scale, bank }) {
  const state = await loadState(bank);
  if (state.wallet && state.wallet !== wallet) {
    console.log(`State belongs to ${state.wallet}, not ${wallet}. Refusing to mix wallets.`);
    return;
  }
  state.wallet = wallet;
  const seen = new Set(state.seenTx || []);

  // First run on a clean state → start forward-only (from the latest event),
  // so we copy only FUTURE trades, never the whole back-history.
  if (!state.cursorTs && !Object.keys(state.positions).length) {
    const latest = await fetchAllActivity(wallet);
    const ts = latest.length ? latest[latest.length - 1].timestamp : 0;
    state.cursorTs = ts;
    await saveState(state);
    console.log(`copy: initialized forward-only from ${ts ? iso(ts) : 'start'} (no history copied).`);
    return;
  }

  const fresh = (await fetchRecentActivity(wallet, state.cursorTs))
    .filter(e => ['TRADE', 'REDEEM'].includes(e.type) && !seen.has(e.transactionHash));
  if (!fresh.length) { await saveState(state); return; }

  // For a fresh trade (< LIVE_WINDOW old) book OUR fill at the REAL price now
  // (prices-history at our execution moment) + a half-spread to cross the book —
  // this captures the true lag cost. For older backfilled trades the live price
  // would be stale, so fall back to the trade's own price ± slippage.
  const LIVE_WINDOW = 600;
  const nowSec = Math.floor(Date.now() / 1000);
  async function ourPrice(e, dir) {
    const recent = (nowSec - e.timestamp) <= LIVE_WINDOW;
    const live = recent ? await livePrice(e.asset) : null;
    if (live != null) return { px: dir === 'buy' ? live * (1 + spread) : live * (1 - spread), src: 'live' };
    return { px: dir === 'buy' ? e.price * (1 + slippage) : e.price * (1 - slippage), src: 'his' };
  }

  const actions = [];
  for (const e of fresh) {
    const key = e.asset; // unique per (market, outcome)
    if (e.type === 'TRADE' && e.side === 'BUY') {
      const { px, src } = await ourPrice(e, 'buy');
      const shares = e.size * scale;
      const cost   = shares * px;
      if (cost > state.bank) { actions.push({ act: 'skip_buy', reason: 'insufficient_bank', slug: e.slug, want: +cost.toFixed(2), bank: +state.bank.toFixed(2) }); continue; }
      state.bank -= cost;
      const p = state.positions[key] || { shares: 0, cost: 0, slug: e.slug, title: e.title, outcome: e.outcome };
      p.shares += shares; p.cost += cost;
      state.positions[key] = p;
      actions.push({ act: 'buy', slug: e.slug, outcome: e.outcome, shares: +shares.toFixed(2), price: +px.toFixed(4), hisPrice: +e.price.toFixed(4), priceSrc: src, cost: +cost.toFixed(2) });
    } else if (e.type === 'TRADE' && e.side === 'SELL') {
      const p = state.positions[key];
      if (!p || p.shares <= 0) { actions.push({ act: 'skip_sell', reason: 'no_position', slug: e.slug }); continue; }
      const sellShares = Math.min(e.size * scale, p.shares);
      const { px, src } = await ourPrice(e, 'sell');
      const proceeds = sellShares * px;
      const costPart = p.cost * (sellShares / p.shares);
      const pnl = proceeds - costPart;
      state.bank += proceeds; state.realized += pnl;
      p.shares -= sellShares; p.cost -= costPart;
      if (p.shares <= 0.01) delete state.positions[key];
      actions.push({ act: 'sell', slug: e.slug, shares: +sellShares.toFixed(2), price: +px.toFixed(4), hisPrice: +e.price.toFixed(4), priceSrc: src, pnl: +pnl.toFixed(2) });
    } else if (e.type === 'REDEEM') {
      const p = state.positions[key];
      if (!p || p.shares <= 0) continue;
      const settlePx = e.size ? (e.usdcSize || 0) / e.size : 0; // ≈1 win, ≈0 loss
      const proceeds = p.shares * settlePx;
      const pnl = proceeds - p.cost;
      state.bank += proceeds; state.realized += pnl;
      actions.push({ act: 'redeem', slug: e.slug, settlePx: +settlePx.toFixed(3), pnl: +pnl.toFixed(2) });
      delete state.positions[key];
    }
    seen.add(e.transactionHash);
    state.cursorTs = Math.max(state.cursorTs, e.timestamp);
  }

  // Keep seenTx bounded (last 2000 hashes is plenty against ts-boundary dupes).
  state.seenTx = [...seen].slice(-2000);
  await saveState(state);
  for (const a of actions) await appendCopy({ ...a, at: new Date().toISOString() });

  const openVal = Object.values(state.positions).reduce((a, p) => a + p.cost, 0); // cost-basis, not mark
  console.log(`\n📋 Paper copy — ${wallet}`);
  console.log(`   New events copied: ${actions.length} (scale ${scale}, slippage ${(slippage*100).toFixed(0)}%)`);
  for (const a of actions.slice(0, 20)) {
    if (a.act === 'buy')        console.log(`   🟢 BUY  ${a.outcome ?? ''} ${a.slug} · ${a.shares}sh @ ${a.price} · −${money(a.cost)}`);
    else if (a.act === 'sell')  console.log(`   🔴 SELL ${a.slug} · ${a.shares}sh @ ${a.price} · ${a.pnl>=0?'+':''}${money(a.pnl)}`);
    else if (a.act === 'redeem')console.log(`   🏁 REDEEM ${a.slug} · settle ${a.settlePx} · ${a.pnl>=0?'+':''}${money(a.pnl)}`);
    else                        console.log(`   ⏭️  ${a.act} ${a.slug} (${a.reason})`);
  }
  console.log(`\n   Bank: ${money(state.bank)} (start ${money(state.startBank)})  ·  Realized: ${state.realized>=0?'+':''}${money(state.realized)}`);
  console.log(`   Open positions: ${Object.keys(state.positions).length} (cost basis ${money(openVal)})`);
  console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  if (opts.mode === 'stats')    return runStats(opts);
  if (opts.mode === 'backtest') return runBacktest(opts);
  if (opts.mode !== 'copy')     return;

  // One-shot copy (cron / manual).
  if (!opts.loop) return runCopy(opts);

  // Daemon: run the copy sync every `loop` seconds. setInterval keeps the
  // process alive under pm2. A `running` guard prevents overlap if one tick
  // runs long (each tick is normally well under a second).
  console.log(`copy daemon: every ${opts.loop}s · scale ${opts.scale} · spread ${(opts.spread*100).toFixed(1)}% · wallet ${opts.wallet}`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runCopy(opts); } catch (e) { console.error(`copy tick failed: ${e.message}`); }
    running = false;
  };
  await tick();
  setInterval(tick, opts.loop * 1000);
}

main().catch(err => { console.error('track_wallet failed:', err.message); process.exit(1); });
