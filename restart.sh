#!/usr/bin/env bash
cd "$(dirname "$0")"

PIDS=$(pgrep -f "node pi-hub.mjs" | tr '\n' ' ')
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  sleep 1
  echo "⏹️  Stopped (was PID $PIDS)"
else
  echo "⏹️  Was not running"
fi

nohup node pi-hub.mjs > /dev/null 2>&1 &
sleep 1

NEW_PID=$(pgrep -f "node pi-hub.mjs" | head -1)
if [ -n "$NEW_PID" ]; then
  echo "✅ pi-hub started (PID $NEW_PID)"
else
  echo "❌ pi-hub failed to start"
  exit 1
fi
