![Pi hub logo](./image.png)
# pi hub

A real-time dashboard for [pi](https://github.com/mariozechner/pi-coding-agent) coding agent sessions.

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

## PR Review Extension

Load a pull request into context and get an AI-powered initial review summary, then ask follow-up questions about the changes.

**Requires:** [`gh` CLI](https://cli.github.com/) authenticated and on PATH.

### Install

```bash
ln -s "$(pwd)/pi-review-extension.ts" ~/.pi/agent/extensions/pi-review.ts
```

Reload running sessions: `/reload`

### Commands

| Command | Description |
|---------|-------------|
| `/review <number>` | Check out PR `<number>`, inject diff into context, get initial analysis |
| `/review-status` | Show details about the active PR review |
| `/review-done` | End the review session and clear injected context |

### How it works

- **Checks out the branch** — runs `gh pr checkout` so your tools can read the actual files
- **Injects diff into system prompt** — up to 40,000 chars of unified diff; larger PRs get a truncation note pointing you to `bash`/`read`
- **Initial analysis** — automatically asks the LLM to summarise what the PR does, the key changes, and areas worth scrutinising
- **Follow-up Q&A** — ask anything: "Is this safe?", "What are the perf implications?", "Does this have tests?"
- **Session persistence** — review state survives `/reload` and session restarts
- **Named session** — sets the session name to `Review PR #N: <title>` so it's easy to find in `/resume`

---

## PR Review Comment Wizard Extension

Walks through every open comment thread on the current branch's PR, generates three AI-suggested responses per thread using your active model, and lets you pick one (or write your own) before loading the instructions into the editor.

**Requires:** [`gh` CLI](https://cli.github.com/) authenticated and on PATH.

### Install

```bash
ln -s "$(pwd)/pi-pr-review-extension.ts" ~/.pi/agent/extensions/pi-pr-review.ts
```

Reload running sessions: `/reload`

### Commands

| Command | Description |
|---------|-------------|
| `/pr-review` | Launch the comment wizard for the open PR on the current branch |

### How it works

- **Auto-detects the PR** — finds the open PR for the current git branch via `gh`
- **Fetches all comment threads** — inline review comments and general PR comments
- **Generates 3 recommendations per thread** — ranging from minimal fix to full refactor, using your active model
- **Interactive TUI wizard** — navigate threads with ↑↓, pick a recommendation or write a custom instruction, skip any thread
- **Loads into editor** — builds a structured prompt from your selections and puts it in the editor ready to submit

---

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
node pi-hub.mjs        # default port 7420
node pi-hub.mjs 8080   # custom port
```

## systemd service

Create `~/.config/systemd/user/pi-hub.service`:

```ini
[Unit]
Description=pi hub dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/code/pi-hub/pi-hub.mjs
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

## Files

| File | Purpose |
|------|--------|
| `pi-hub.mjs` | Dashboard server (file watcher + SSE + web UI) |
| `pi-hub-extension.ts` | pi extension: real-time lifecycle events to dashboard |
| `pi-review-extension.ts` | pi extension: `/review <PR>` — load PR diff into context |
| `pi-pr-review-extension.ts` | pi extension: `/pr-review` — interactive comment thread wizard |
| `start.sh` / `stop.sh` / `restart.sh` | Dashboard process management |

## License

MIT
