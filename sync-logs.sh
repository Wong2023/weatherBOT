#!/bin/bash
# sync-logs.sh — тянет логи с сервера локально
# Запускай: bash sync-logs.sh
# Или добавь в Task Scheduler Windows для автозапуска

SERVER_USER="openclawd"
SERVER_HOST="144.31.153.253"
SERVER_PATH="/home/openclawd/.openclaw/workspace/logs"
LOCAL_PATH="./logs"

echo "[sync] Pulling logs from ${SERVER_HOST}..."
mkdir -p "$LOCAL_PATH"

scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/bank.json"              "$LOCAL_PATH/" 2>/dev/null && echo "  ✓ bank.json"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/paper-bets.ndjson"      "$LOCAL_PATH/" 2>/dev/null && echo "  ✓ paper-bets.ndjson"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/predictions-hourly.ndjson" "$LOCAL_PATH/" 2>/dev/null && echo "  ✓ predictions-hourly.ndjson"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/observed-london.ndjson" "$LOCAL_PATH/" 2>/dev/null && echo "  ✓ observed-london.ndjson"

echo "[sync] Done. Logs are in $LOCAL_PATH"
