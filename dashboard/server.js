'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 4000;
const DASH_USER = process.env.DASHBOARD_USER || 'admin';
const DASH_PASS = process.env.DASHBOARD_PASS || 'changeme';
const LOGS = path.join(__dirname, '..', 'logs');
const SESSION_SECRET = process.env.SESSION_SECRET || 'wb-dashboard-secret-change-me';

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

// Rate limiter for login
const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = loginAttempts.get(ip) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > e.reset) { e = { count: 0, reset: now + 15 * 60 * 1000 }; }
  e.count++;
  loginAttempts.set(ip, e);
  return e.count > 10;
}

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
}

// --- File helpers ---
function readNdjson(file) {
  try {
    return fs.readFileSync(path.join(LOGS, file), 'utf8')
      .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(LOGS, file), 'utf8')); }
  catch { return null; }
}

// --- Auth routes (no auth required) ---
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (rateLimited(req.ip)) {
    return res.status(429).send('Too many attempts. Wait 15 minutes.');
  }
  if (req.body.username === DASH_USER && req.body.password === DASH_PASS) {
    req.session.authenticated = true;
    loginAttempts.delete(req.ip);
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Protected zone ---
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', (req, res) => {
  const hourly = readNdjson('predictions-hourly.ndjson');
  const bank = readJson('bank.json');
  const bets = readNdjson('paper-bets.ndjson');
  const observed = readNdjson('observed-london.ndjson');

  // Latest forecast per offset (0=today, 1=tomorrow)
  const forecasts = {};
  for (const r of hourly) {
    const k = r.targetDayOffset;
    if (!forecasts[k] || r.timestamp > forecasts[k].timestamp) forecasts[k] = r;
  }

  // P&L history per strategy from settle records
  const STRATEGIES = ['kelly_pure','kelly_shrunk','market_weighted','argmax_pure','argmax_shrunk','argmax_mkt','edge_pure','edge_shrunk','edge_mkt'];
  const pnlHistory = {};
  for (const s of STRATEGIES) pnlHistory[s] = [];
  for (const bet of bets.filter(b => b.type === 'settle')) {
    const s = bet.strategy;
    if (pnlHistory[s]) {
      pnlHistory[s].push({
        date: bet.date || (bet.settledAt || '').substring(0, 10),
        bank: bet.bankAfter,
        won: bet.won,
        delta: bet.delta
      });
    }
  }

  // History: latest prediction per date joined with observed fact
  const latestByDate = {};
  for (const r of hourly) {
    if (!latestByDate[r.targetDate] || r.timestamp > latestByDate[r.targetDate].timestamp) {
      latestByDate[r.targetDate] = r;
    }
  }
  const history = observed.slice(-30).map(o => {
    const pred = latestByDate[o.date];
    // Use the band actually bet/displayed (betOn = argmax). Fall back to
    // forecastRounded for older logs predating the argmax/forecast split.
    const predicted = pred?.decision?.forecastArgmax ?? pred?.decision?.forecastRounded ?? null;
    const actual = o.maxTempBand ?? o.maxTemp ?? null;
    const err = predicted != null && actual != null ? predicted - actual : null;
    return {
      date: o.date,
      predicted,
      betOn: pred?.decision?.betOn ?? null,
      actual,
      actualEra5: o.maxTempEra5 ?? null,
      hit: err === 0,
      close: err != null && Math.abs(err) <= 1,
      error: err != null ? parseFloat(err.toFixed(1)) : null
    };
  }).reverse();

  // Stats over available history
  const withData = history.filter(h => h.actual != null && h.predicted != null);
  const errors = withData.map(h => h.error).filter(e => e != null);
  const absErrors = errors.map(Math.abs);
  const exactHits = withData.filter(h => h.hit).length;
  const closeHits = withData.filter(h => h.close).length;
  const mae = absErrors.length ? absErrors.reduce((a, b) => a + b, 0) / absErrors.length : null;
  const bias = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;

  res.json({
    updatedAt: new Date().toISOString(),
    forecasts,
    bank,
    pnlHistory,
    history,
    stats: {
      total: withData.length,
      exactHits,
      exactPct: withData.length ? Math.round(exactHits / withData.length * 100) : 0,
      closeHits,
      closePct: withData.length ? Math.round(closeHits / withData.length * 100) : 0,
      mae: mae != null ? parseFloat(mae.toFixed(2)) : null,
      bias: bias != null ? parseFloat(bias.toFixed(2)) : null
    }
  });
});

app.listen(PORT, () => {
  console.log(`[dashboard] running → http://localhost:${PORT}`);
});
