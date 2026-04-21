#!/usr/bin/env bash
cd "$(dirname "$0")"

if pgrep -f "node pi-hub.mjs" > /dev/null; then
  echo "⚠️  pi-hub is already running (PID $(pgrep -f 'node pi-hub.mjs'))"
  exit 1
fi

nohup node pi-hub.mjs > /dev/null 2>&1 &
sleep 1

if pgrep -f "node pi-hub.mjs" > /dev/null; then
  echo "✅ pi-hub started (PID $(pgrep -f 'node pi-hub.mjs'))"
else
  echo "❌ pi-hub failed to start"
  exit 1
fi
