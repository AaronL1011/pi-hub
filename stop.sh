#!/usr/bin/env bash
cd "$(dirname "$0")"

PIDS=$(pgrep -f "node pi-monitor.mjs" | tr '\n' ' ')
if [ -z "$PIDS" ]; then
  echo "⚠️  pi-monitor is not running"
  exit 1
fi

kill $PIDS 2>/dev/null
sleep 1
echo "✅ pi-monitor stopped (was PID $PIDS)"
