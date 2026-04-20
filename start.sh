#!/usr/bin/env bash
cd "$(dirname "$0")"

if pgrep -f "node pi-monitor.mjs" > /dev/null; then
  echo "⚠️  pi-monitor is already running (PID $(pgrep -f 'node pi-monitor.mjs'))"
  exit 1
fi

nohup node pi-monitor.mjs > /dev/null 2>&1 &
sleep 1

if pgrep -f "node pi-monitor.mjs" > /dev/null; then
  echo "✅ pi-monitor started (PID $(pgrep -f 'node pi-monitor.mjs'))"
else
  echo "❌ pi-monitor failed to start"
  exit 1
fi
