#!/bin/bash
# sync-logs.sh — тянет логи с сервера локально
# Запускай из папки weatherBOT: bash sync-logs.sh

SERVER_USER="openclawd"
SERVER_HOST="144.31.153.253"
SERVER_PATH="/home/openclawd/.openclaw/workspace/logs"
LOCAL_PATH="$(dirname "$0")/logs"   # всегда рядом с этим скриптом

mkdir -p "$LOCAL_PATH"

echo "[sync] Pulling from ${SERVER_HOST}..."
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/bank.json"                 "$LOCAL_PATH/" && echo "  ✓ bank.json"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/paper-bets.ndjson"         "$LOCAL_PATH/" && echo "  ✓ paper-bets.ndjson"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/predictions-hourly.ndjson" "$LOCAL_PATH/" && echo "  ✓ predictions-hourly.ndjson"
scp "${SERVER_USER}@${SERVER_HOST}:${SERVER_PATH}/observed-london.ndjson"    "$LOCAL_PATH/" && echo "  ✓ observed-london.ndjson"

echo "[sync] Done → $LOCAL_PATH"
