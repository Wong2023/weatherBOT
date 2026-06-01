# HEARTBEAT.md

## Daily task (run once per day, ~18:00 UTC)

```
node scripts/run.js
```

That's it. This single command:
1. Fetches yesterday's observed temperature (ERA5 historical API → Polymarket fallback)
2. Runs the prediction cycle for tomorrow
3. Sends a Telegram signal automatically

**Do NOT run the scripts separately unless debugging.**

## Weekly task (run once per week, e.g. Monday morning)

```
node scripts/run.js --analyze
```

Runs the full daily sequence plus accuracy analysis across all logged predictions.

## Troubleshooting checklist

- `logs/predictions.ndjson` growing? → prediction is running ✅
- `logs/observed-london.ndjson` growing? → observations are being fetched ✅
- No Telegram message? → check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`
- All sources failed? → Open-Meteo may be rate-limiting; wait and retry
- `SIGNAL: NONE`? → Polymarket market not found; set `POLYMARKET_MARKET_ID` in `.env`

## What NOT to do

- Don't manually edit `.ndjson` log files
- Don't run `predict.js` without first running `fetch_observed.js` (they're sequenced in `run.js`)
- Don't run multiple times per day (one prediction per day is enough)
