#!/bin/bash
LOCKFILE="/tmp/pumpfun-bot.lock"

# Prevent multiple instances
if [ -f "$LOCKFILE" ]; then
  OLDPID=$(cat "$LOCKFILE")
  if kill -0 "$OLDPID" 2>/dev/null; then
    echo "[$(date)] Bot already running (PID $OLDPID). Exiting."
    exit 1
  else
    echo "[$(date)] Stale lockfile found (PID $OLDPID dead). Cleaning up."
    rm -f "$LOCKFILE"
  fi
fi

# Write our PID as the lock
echo $$ > "$LOCKFILE"

cleanup() {
  echo "[$(date)] Watchdog shutting down. Cleaning lockfile."
  rm -f "$LOCKFILE"
  # Kill the bot process if still running
  if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill -9 "$BOT_PID" 2>/dev/null
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

cd /home/ubuntu/workspace/pumpfun || exit 1

while true; do
  echo "[$(date)] Starting pumpfun bot..."
  node dist/main.js 2>&1 &
  BOT_PID=$!
  wait $BOT_PID
  EXIT_CODE=$?
  echo "[$(date)] Bot exited with code $EXIT_CODE, restarting in 5s..."
  sleep 5
done
