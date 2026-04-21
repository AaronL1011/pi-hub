#!/usr/bin/env bash
cd "$(dirname "$0")"

PIDS=$(pgrep -f "node pi-hub.mjs" | tr '\n' ' ')
if [ -z "$PIDS" ]; then
  echo "⚠️  pi-hub is not running"
  exit 1
fi

kill $PIDS 2>/dev/null
sleep 1
echo "✅ pi-hub stopped (was PID $PIDS)"
