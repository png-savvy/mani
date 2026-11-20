#!/usr/bin/env bash
# Keeps Mani running: starts the app and restarts it within seconds if it ever stops or crashes.
# Windows starts this at boot (see README "Keep it running 24/7"). Output goes to data/logs/mani.log.
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/logs
LOG=data/logs/mani.log
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d ' "')
PORT=${PORT:-3000}

while true; do
  # Keep the log from growing forever (~5 MB, one old copy kept).
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi
  # Only Mani's own answer counts: any other program on this port (a 404, an error page) must not look like "running".
  STATUS=$(curl -sf -m 3 "http://127.0.0.1:$PORT/api/auth/status")
  if echo "$STATUS" | grep -q '"setUp"'; then
    # Already running (for example started by hand in a terminal) — check again in a minute.
    sleep 60
    continue
  fi
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "$(date -Is) port $PORT is used by another program, not Mani; retrying in 60 seconds" >> "$LOG"
    sleep 60
    continue
  fi
  echo "$(date -Is) starting Mani" >> "$LOG"
  npm start >> "$LOG" 2>&1
  echo "$(date -Is) Mani stopped (exit code $?); restarting in 5 seconds" >> "$LOG"
  sleep 5
done
