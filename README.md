# pi hub

Real-time dashboard for monitoring [pi](https://github.com/mariozechner/pi-coding-agent) coding agent sessions.

![dashboard](https://img.shields.io/badge/port-7420-blue)

## What it does

- Watches `~/.pi/agent/sessions/` for live session activity
- Incrementally parses JSONL session files as agents write to them
- Streams updates to the browser via Server-Sent Events (SSE)
- Detects running pi processes and maps them to terminal windows
- Desktop notifications + audio ping when a session awaits input
- One-click terminal focus via `wmctrl`
- Search, filter by status, cost tracking, token usage

## pi extension

The dashboard works passively by watching session files, but for **real-time status** (streaming, tool executing, awaiting input) install the companion pi extension:

```bash
# symlink into global extensions
ln -s "$(pwd)/pi-hub-extension.ts" ~/.pi/agent/extensions/pi-hub-monitor.ts
```

Or copy it:

```bash
cp pi-hub-extension.ts ~/.pi/agent/extensions/pi-hub-monitor.ts
```

The extension POSTs lightweight lifecycle events (`agent_start`, `turn_start`, `tool_execution_start`, etc.) to the dashboard's `/api/agent-event` endpoint, including tool names, turn indices, and stop reasons. Without it, status is inferred from file modification times and process detection, which has a few seconds of lag.

If the dashboard is running on a non-default port:

```bash
export PI_HUB_PORT=8080
```

Reload running pi sessions to pick up the new extension:

```
/reload
```

## Requirements

- Node.js 18+
- `wmctrl` (optional, for terminal focus feature): `sudo apt install wmctrl`

## Quick start

```bash
# start in background
./start.sh

# open dashboard
xdg-open http://localhost:7420

# stop
./stop.sh

# restart
./restart.sh
```

Or run directly:

```bash
node pi-monitor.mjs        # default port 7420
node pi-monitor.mjs 8080   # custom port
```

## systemd service

Create `~/.config/systemd/user/pi-hub.service`:

```ini
[Unit]
Description=pi hub dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/code/pi-hub/pi-monitor.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

> Adjust the `ExecStart` path to match your setup. `%h` expands to your home directory.

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable pi-hub
systemctl --user start pi-hub
```

Check status / logs:

```bash
systemctl --user status pi-hub
journalctl --user -u pi-hub -f
```

## License

MIT
