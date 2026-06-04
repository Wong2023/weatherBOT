# HEARTBEAT.md

## ⚠️ AUTOMATED — DO NOT RUN MANUALLY

The scheduler (`scripts/scheduler.js`) is running 24/7 via pm2 and handles everything automatically.
**Do NOT call any scripts yourself. Do NOT send weather predictions or analysis to Telegram.**

### What runs automatically:
- **Every hour** — silent forecast logged to `predictions-hourly.ndjson` (no Telegram)
- **08:00 UTC daily** — fetch observed temps + daily accuracy report + prediction → Telegram
- **Sunday 09:00 UTC** — weekly timing analysis → Telegram

### Your only job:
If asked to debug or the user explicitly requests it — check `pm2 logs weatherbot`.
Otherwise: do nothing. The scheduler handles all weather tasks.

## Troubleshooting checklist

- `logs/predictions.ndjson` growing? → prediction is running ✅
- `logs/observed-london.ndjson` growing? → observations are being fetched ✅
- No Telegram message? → check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`
- All sources failed? → Open-Meteo may be rate-limiting; wait and retry
- `Polymarket: n/a`? → market not yet listed for that date, normal before ~2 days ahead

## What NOT to do

- Do NOT run `node scripts/run.js` or `node scripts/predict.js` — scheduler does this
- Do NOT send weather summaries or analysis to Telegram on your own initiative
- Do NOT edit `.ndjson` log files manually
