#!/usr/bin/env node
/**
 * Pi Agent Monitor — real-time dashboard for all pi coding agent sessions.
 *
 * Usage:  node pi-monitor.mjs [port]
 *         Default port: 7420
 *
 * Architecture:
 *   • fs.watch on ~/.pi/agent/sessions/ (recursive) detects file changes instantly
 *   • Incremental JSONL parsing — tracks byte offset per file, only reads new lines
 *   • Server-Sent Events (SSE) pushes deltas to the browser in real-time
 *   • Browser applies surgical DOM patches — no full re-render, preserves scroll/hover
 *   • Process detection maps pi PIDs → terminal windows for one-click focus
 *   • Desktop notifications + audio ping when sessions await user input
 */

import { createServer } from "node:http";
import { readdir, readFile, stat, open, readlink } from "node:fs/promises";
import { watch, existsSync, readFileSync, readlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const PORT = parseInt(process.argv[2] || "7420", 10);
const SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

process.on("uncaughtException", (err) => { console.error("  ⚠ Uncaught:", err.message); });
process.on("unhandledRejection", (err) => { console.error("  ⚠ Unhandled rejection:", err); });

// ── In-memory session state ──────────────────────────────────────────
const sessionCache = new Map();   // filePath → parsed session summary
const fileOffsets = new Map();    // filePath → { byteOffset }

// ── Live status from pi-hub-monitor extension ───────────────────────
// Key: sessionId → { status, timestamp, pid, cwd, ... }
const liveStatus = new Map();

// ── SSE clients ──────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── Incremental JSONL parser ─────────────────────────────────────────

function processEntry(entry, session) {
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
  if (ts > session.lastActivityTs) session.lastActivityTs = ts;

  if (entry.type === "session_info" && entry.name) session.sessionName = entry.name;
  if (entry.type === "model_change") { session.model = entry.modelId; session.provider = entry.provider; }
  if (entry.type === "thinking_level_change") session.thinkingLevel = entry.thinkingLevel;
  if (entry.type === "compaction") session.compactions++;
  if (entry.type === "branch_summary") session.branches++;

  if (entry.type !== "message") return;
  const msg = entry.message;
  if (!msg) return;

  session.entryCount++;
  const msgTs = msg.timestamp || ts;
  if (!session.firstMessageTs) session.firstMessageTs = msgTs;

  if (msg.role === "user") {
    session.userMessages++;
    const text = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    session.lastUserMessage = text.slice(0, 2000);
  }

  if (msg.role === "assistant") {
    session.assistantMessages++;
    session.lastStopReason = msg.stopReason || null;
    session.lastErrorMessage = msg.errorMessage || null;
    if (msg.usage) {
      session.totalCost += msg.usage.cost?.total || 0;
      session.totalTokens.input += msg.usage.input || 0;
      session.totalTokens.output += msg.usage.output || 0;
      session.totalTokens.cacheRead += msg.usage.cacheRead || 0;
      session.totalTokens.cacheWrite += msg.usage.cacheWrite || 0;
      session.totalTokens.total += msg.usage.totalTokens || 0;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") session.lastAssistantText = block.text.slice(0, 2000);
        if (block.type === "toolCall") {
          session.toolCalls++;
          session.lastToolCall = { name: block.name, args: summarizeArgs(block.arguments) };
        }
      }
    }
    if (msg.model) session.model = msg.model;
    if (msg.provider) session.provider = msg.provider;
  }

  if (msg.role === "toolResult") {
    const text = Array.isArray(msg.content) ? msg.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    session.lastToolResult = { toolName: msg.toolName, isError: msg.isError, preview: text.slice(0, 300) };
  }
}

function makeEmptySession(filePath, header) {
  return {
    id: header.id, sessionName: null,
    projectPath: header.cwd || filePath, cwd: header.cwd,
    filePath, fileName: basename(filePath),
    startedAt: header.timestamp, firstMessageTs: null,
    lastActivityTs: new Date(header.timestamp).getTime(),
    model: null, provider: null, thinkingLevel: null,
    status: "idle", isActive: false, awaitingInput: false,
    userMessages: 0, assistantMessages: 0, toolCalls: 0,
    totalCost: 0, totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    compactions: 0, branches: 0,
    lastUserMessage: null, lastAssistantText: null,
    lastToolCall: null, lastToolResult: null,
    lastStopReason: null, lastErrorMessage: null,
    entryCount: 0,
    terminalWindow: null, // { wid, title, type }
    piPid: null,
  };
}

function computeStatus(session, mtimeMs) {
  const isActive = Date.now() - mtimeMs < 8000;
  session.isActive = isActive;

  // Priority 1: Live status from pi-hub-monitor extension (real-time, authoritative)
  const live = liveStatus.get(session.id);
  if (live && Date.now() - live.timestamp < 30000) {
    session.isActive = true;
    session.piPid = live.pid || session.piPid;
    const ls = live.status;
    if (ls === "streaming" || ls === "tool_executing" || ls === "turn_running") {
      session.status = "running"; session.awaitingInput = false;
    } else if (ls === "awaiting_input") {
      session.status = "awaiting_input"; session.awaitingInput = true;
    } else if (ls === "error") {
      session.status = "error"; session.awaitingInput = false;
    } else {
      session.status = "running"; session.awaitingInput = false;
    }
    return;
  }
  const r = session.lastStopReason;
  const hasProcess = session.piPid != null;

  // If pi process is alive, use it as the primary signal
  if (hasProcess) {
    if (r === "stop" && !isActive) {
      // Agent finished its turn, pi is waiting for user input
      session.status = "awaiting_input"; session.awaitingInput = true;
    } else if (r === "stop" && isActive) {
      // Just wrote the final message, transitioning to awaiting
      session.status = "awaiting_input"; session.awaitingInput = true;
    } else if (r === "error") {
      session.status = "error"; session.awaitingInput = false;
    } else {
      // Process alive + not stopped = agent is working (tools or LLM streaming)
      session.status = "running"; session.awaitingInput = false;
    }
    return;
  }

  // No live process — determine status from file state alone
  if (isActive) {
    // File recently written but no process detected (race condition or detection lag)
    if (r === "toolUse") { session.status = "running"; session.awaitingInput = false; }
    else if (r === "stop") { session.status = "awaiting_input"; session.awaitingInput = true; }
    else if (r === "error") { session.status = "error"; session.awaitingInput = false; }
    else if (r === "aborted") { session.status = "aborted"; session.awaitingInput = false; }
    else if (r === "length") { session.status = "context_full"; session.awaitingInput = false; }
    else { session.status = "active"; session.awaitingInput = false; }
  } else {
    // File not recently modified, no live process
    if (r === "stop") { session.status = "idle"; session.awaitingInput = false; }
    else if (r === "error") { session.status = "error"; session.awaitingInput = false; }
    else if (r === "aborted") { session.status = "aborted"; session.awaitingInput = false; }
    else if (r === "toolUse") { session.status = "interrupted"; session.awaitingInput = false; }
    else if (r === "length") { session.status = "context_full"; session.awaitingInput = false; }
    else { session.status = "idle"; session.awaitingInput = false; }
  }
}

async function fullParseSession(filePath) {
  let raw;
  try { raw = await readFile(filePath, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  let header;
  try { header = JSON.parse(lines[0]); } catch { return null; }
  if (header.type !== "session") return null;

  const session = makeEmptySession(filePath, header);
  for (let i = 1; i < lines.length; i++) {
    try { processEntry(JSON.parse(lines[i]), session); } catch {}
  }
  fileOffsets.set(filePath, { byteOffset: Buffer.byteLength(raw, "utf8") });
  try { const fstat = await stat(filePath); computeStatus(session, fstat.mtimeMs); } catch { computeStatus(session, 0); }
  sessionCache.set(filePath, session);
  return session;
}

async function incrementalUpdate(filePath) {
  const prev = fileOffsets.get(filePath);
  if (!prev) return fullParseSession(filePath);

  let fstat;
  try { fstat = await stat(filePath); } catch {
    sessionCache.delete(filePath); fileOffsets.delete(filePath); return null;
  }

  const fileSize = fstat.size;
  if (fileSize < prev.byteOffset) return fullParseSession(filePath);
  if (fileSize === prev.byteOffset) {
    const session = sessionCache.get(filePath);
    if (session) {
      const oldStatus = session.status;
      computeStatus(session, fstat.mtimeMs);
      if (session.status !== oldStatus) return session;
    }
    return null;
  }

  const bytesToRead = fileSize - prev.byteOffset;
  const buf = Buffer.alloc(bytesToRead);
  let fd;
  try { fd = await open(filePath, "r"); await fd.read(buf, 0, bytesToRead, prev.byteOffset); }
  catch { return fullParseSession(filePath); }
  finally { await fd?.close(); }

  prev.byteOffset = fileSize;
  const newLines = buf.toString("utf8").split("\n").filter(Boolean);
  let session = sessionCache.get(filePath);
  if (!session) return fullParseSession(filePath);
  for (const line of newLines) { try { processEntry(JSON.parse(line), session); } catch {} }
  computeStatus(session, fstat.mtimeMs);
  return session;
}

function summarizeArgs(args) {
  if (!args) return "";
  if (args.command) return args.command.slice(0, 200);
  if (args.path) return args.path;
  return JSON.stringify(args).slice(0, 150);
}

// ── File watching ────────────────────────────────────────────────────

const pendingChanges = new Map();
const DEBOUNCE_MS = 50;

function scheduleUpdate(filePath) {
  if (pendingChanges.has(filePath)) clearTimeout(pendingChanges.get(filePath));
  pendingChanges.set(filePath, setTimeout(async () => {
    pendingChanges.delete(filePath);
    const session = await incrementalUpdate(filePath);
    if (session) broadcast("session_update", session);
  }, DEBOUNCE_MS));
}

async function scanForDeletedSessions() {
  for (const filePath of sessionCache.keys()) {
    try { await stat(filePath); } catch {
      const session = sessionCache.get(filePath);
      sessionCache.delete(filePath); fileOffsets.delete(filePath);
      if (session) broadcast("session_remove", { id: session.id, filePath });
    }
  }
}

let rootWatcher = null;
const dirWatchers = new Map();

function startWatching() {
  try {
    rootWatcher = watch(SESSION_DIR, { persistent: false }, async (eventType, filename) => {
      if (!filename) return;
      const dirPath = join(SESSION_DIR, filename);
      try {
        const s = await stat(dirPath);
        if (s.isDirectory() && !dirWatchers.has(dirPath)) { watchProjectDir(dirPath); await scanProjectDir(dirPath); }
      } catch {
        if (dirWatchers.has(dirPath)) { dirWatchers.get(dirPath).close(); dirWatchers.delete(dirPath); }
      }
    });
  } catch (e) { console.error("  ⚠ Could not watch sessions directory:", e.message); }
}

function watchProjectDir(dirPath) {
  if (dirWatchers.has(dirPath)) return;
  try {
    const watcher = watch(dirPath, { persistent: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      const filePath = join(dirPath, filename);
      if (eventType === "rename") {
        stat(filePath).then(() => scheduleUpdate(filePath)).catch(() => {
          const session = sessionCache.get(filePath);
          sessionCache.delete(filePath); fileOffsets.delete(filePath);
          if (session) broadcast("session_remove", { id: session.id, filePath });
        });
      } else { scheduleUpdate(filePath); }
    });
    dirWatchers.set(dirPath, watcher);
  } catch {}
}

async function scanProjectDir(dirPath) {
  let files;
  try { files = await readdir(dirPath); } catch { return; }
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const filePath = join(dirPath, file);
    if (!sessionCache.has(filePath)) await fullParseSession(filePath);
  }
}

async function initialScan() {
  let dirs;
  try { dirs = await readdir(SESSION_DIR, { withFileTypes: true }); } catch {
    console.error("  ⚠ Sessions directory not found:", SESSION_DIR); return;
  }
  const parsePromises = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(SESSION_DIR, d.name);
    watchProjectDir(dirPath);
    let files;
    try { files = await readdir(dirPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      parsePromises.push(fullParseSession(join(dirPath, file)));
    }
  }
  await Promise.all(parsePromises);
  console.log(`  📂 Loaded ${sessionCache.size} sessions from ${dirWatchers.size} project directories`);
}

// ── Process & terminal window detection ──────────────────────────────

let cachedProcesses = [];

// Terminal emulator binaries we recognize
const TERMINAL_EMULATORS = new Set([
  "alacritty", "kitty", "ghostty", "foot", "wezterm-gui", "wezterm",
  "xterm", "gnome-terminal-", "konsole", "tilix", "xfce4-terminal",
  "mate-terminal", "terminator", "sakura", "urxvt",
]);

function isTerminalEmulator(comm) {
  if (TERMINAL_EMULATORS.has(comm)) return true;
  // gnome-terminal uses "gnome-terminal-" as comm prefix
  for (const t of TERMINAL_EMULATORS) {
    if (comm.startsWith(t)) return true;
  }
  return false;
}

function getParentPid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return parseInt(stat.split(")")[1].trim().split(/\s+/)[1]);
  } catch { return 1; }
}

function getComm(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { return ""; }
}

function getCwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ""; }
}

function getWmctrlWindows() {
  try {
    const out = execSync("wmctrl -l -p 2>/dev/null", { encoding: "utf8", timeout: 3000 });
    const windows = {};
    for (const line of out.trim().split("\n")) {
      const parts = line.split(/\s+/, 5);
      if (parts.length < 4) continue;
      const wid = parts[0];
      const wpid = parseInt(parts[2]);
      const title = line.slice(line.indexOf(parts[3]) + parts[3].length).trim();
      if (wpid > 0) windows[wpid] = { wid, title, pid: wpid };
    }
    return windows;
  } catch { return {}; }
}

function refreshProcesses() {
  const piProcs = [];

  // Find pi processes via pgrep
  let piPids;
  try {
    piPids = execSync("pgrep -x pi 2>/dev/null", { encoding: "utf8", timeout: 3000 })
      .trim().split("\n").filter(Boolean).map(Number);
  } catch {
    piPids = [];
  }

  for (const pid of piPids) {
    const cwd = getCwd(pid);
    if (!cwd) continue;
    piProcs.push({ pid, cwd });
  }

  // Get wmctrl windows for terminal mapping
  const wmWindows = getWmctrlWindows();

  // Build zellij/tmux server→client mapping
  // For zellij: servers have --server in cmdline, clients are plain "zellij"
  // For tmux: similar pattern with tmux server/client
  const muxServerToWindow = new Map(); // mux server PID → wmctrl window

  try {
    const psOut = execSync("ps -eo pid,ppid,args 2>/dev/null", { encoding: "utf8", timeout: 3000 });
    const muxClients = [];  // { pid, parentPid, type }
    const muxServers = {};  // pid → { sessionName, type }

    for (const line of psOut.trim().split("\n")) {
      const trimmed = line.trim();
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1]), ppid = parseInt(m[2]), args = m[3];

      if (args.includes("zellij") && args.includes("--server")) {
        const m = args.match(/\/([^/]+)$/);
        if (m) muxServers[pid] = { sessionName: m[1], type: "zellij" };
      } else if (args.trim() === "zellij") {
        muxClients.push({ pid, parentPid: ppid, type: "zellij" });
      }
      if (args.includes("tmux") && args.includes("new-session")) {
        muxServers[pid] = { sessionName: "tmux", type: "tmux" };
      } else if (args.match(/^tmux\s*$/) || args.includes("tmux attach")) {
        muxClients.push({ pid, parentPid: ppid, type: "tmux" });
      }
    }

    // Map client's terminal window → server via session name in window title
    for (const client of muxClients) {
      if (client.parentPid in wmWindows) {
        const win = wmWindows[client.parentPid];
        for (const [serverPid, server] of Object.entries(muxServers)) {
          if (win.title.includes(server.sessionName)) {
            muxServerToWindow.set(parseInt(serverPid), { ...win, type: server.type });
          }
        }
      }
    }
  } catch {}

  // For each pi process, walk up to find its terminal window
  const result = [];
  for (const proc of piProcs) {
    let walk = proc.pid;
    let window = null;

    while (walk > 1) {
      // Direct terminal emulator ancestor?
      const comm = getComm(walk);
      if (isTerminalEmulator(comm) && walk in wmWindows) {
        window = { ...wmWindows[walk], type: comm };
        break;
      }
      // wmctrl window match (e.g., VS Code integrated terminal)?
      if (walk in wmWindows) {
        window = { ...wmWindows[walk], type: comm };
        break;
      }
      // Multiplexer server?
      if (muxServerToWindow.has(walk)) {
        window = muxServerToWindow.get(walk);
        break;
      }
      walk = getParentPid(walk);
    }

    result.push({
      pid: proc.pid,
      cwd: proc.cwd,
      window: window ? { wid: window.wid, title: window.title, type: window.type } : null,
    });
  }

  cachedProcesses = result;

  // Attach terminal info to sessions by matching CWD (1:1 mapping)
  // Group processes by CWD
  const procsByCwd = new Map();
  for (const p of result) {
    if (!procsByCwd.has(p.cwd)) procsByCwd.set(p.cwd, []);
    procsByCwd.get(p.cwd).push({ ...p, claimed: false });
  }

  // Group sessions by CWD, sorted by most recent activity first
  const sessionsByCwd = new Map();
  for (const [, session] of sessionCache) {
    const cwd = session.cwd;
    if (!cwd) continue;
    if (!sessionsByCwd.has(cwd)) sessionsByCwd.set(cwd, []);
    sessionsByCwd.get(cwd).push(session);
  }

  // For each CWD, match N processes to the N most recently active sessions
  for (const [cwd, sessions] of sessionsByCwd) {
    const procs = procsByCwd.get(cwd) || [];
    // Sort sessions by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    for (let i = 0; i < sessions.length; i++) {
      if (i < procs.length) {
        sessions[i].piPid = procs[i].pid;
        sessions[i].terminalWindow = procs[i].window || null;
      } else {
        sessions[i].piPid = null;
        sessions[i].terminalWindow = null;
      }
    }
  }
}

function focusWindow(wid) {
  try {
    execSync(`wmctrl -i -a ${wid}`, { timeout: 2000 });
    return true;
  } catch { return false; }
}

// ── Stale status ticker ──────────────────────────────────────────────

function checkStaleStatuses() {
  for (const [filePath, session] of sessionCache) {
    if (!session.isActive) continue;
    stat(filePath)
      .then((fstat) => {
        const oldStatus = session.status;
        computeStatus(session, fstat.mtimeMs);
        if (session.status !== oldStatus) broadcast("session_update", session);
      })
      .catch(() => {
        sessionCache.delete(filePath); fileOffsets.delete(filePath);
        broadcast("session_remove", { id: session.id, filePath });
      });
  }
}

// ── Handle live agent events from extension ─────────────────────────

function handleAgentEvent(event) {
  const { type, sessionId, pid, cwd, timestamp } = event;
  if (!sessionId) return;

  // Map extension event types to dashboard status
  let status;
  switch (type) {
    case "agent_start":
    case "turn_start":
      status = "streaming";
      break;
    case "tool_execution_start":
      status = "tool_executing";
      break;
    case "tool_execution_end":
      status = "streaming"; // back to LLM after tool
      break;
    case "turn_end":
    case "agent_end":
      status = "awaiting_input";
      break;
    case "session_shutdown":
      liveStatus.delete(sessionId);
      // Re-compute status for this session without live data
      for (const [filePath, session] of sessionCache) {
        if (session.id === sessionId) {
          session.piPid = null;
          stat(filePath).then(fstat => {
            computeStatus(session, fstat.mtimeMs);
            broadcast("session_update", session);
          }).catch(() => {});
        }
      }
      return;
    case "session_start":
      status = "awaiting_input";
      break;
    default:
      return;
  }

  liveStatus.set(sessionId, { status, pid, cwd, timestamp: timestamp || Date.now() });

  // Find and update the matching session
  for (const [filePath, session] of sessionCache) {
    if (session.id === sessionId) {
      const oldStatus = session.status;
      stat(filePath).then(fstat => {
        computeStatus(session, fstat.mtimeMs);
        if (session.status !== oldStatus || type === "tool_execution_start") {
          broadcast("session_update", session);
        }
      }).catch(() => {
        // File might not exist yet for brand new sessions
        computeStatus(session, Date.now());
        if (session.status !== oldStatus) broadcast("session_update", session);
      });
      return;
    }
  }
}

// ── HTTP Server ──────────────────────────────────────────────────────

function getSortedSessions() {
  return [...sessionCache.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      Connection: "keep-alive", "Access-Control-Allow-Origin": "*",
    });
    res.write(":\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    res.write(`event: snapshot\ndata: ${JSON.stringify({ sessions: getSortedSessions(), processes: cachedProcesses })}\n\n`);
    return;
  }

  if (url.pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ sessions: getSortedSessions(), processes: cachedProcesses, timestamp: Date.now() }));
    return;
  }

  // Focus a terminal window by session ID
  if (url.pathname.startsWith("/api/focus/")) {
    const sessionId = url.pathname.split("/").pop();
    const session = [...sessionCache.values()].find(s => s.id === sessionId);
    if (!session?.terminalWindow?.wid) {
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "No terminal window found for session" }));
      return;
    }
    const ok = focusWindow(session.terminalWindow.wid);
    res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ success: ok, wid: session.terminalWindow.wid }));
    return;
  }

  // Receive live agent events from pi-hub-monitor extension
  if (url.pathname === "/api/agent-event" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const event = JSON.parse(body);
        handleAgentEvent(event);
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});

// ── Bootstrap ────────────────────────────────────────────────────────

await initialScan();
startWatching();
refreshProcesses();

// Recompute statuses now that PIDs are mapped
for (const [filePath, session] of sessionCache) {
  try { const fstat = await stat(filePath); computeStatus(session, fstat.mtimeMs); } catch { computeStatus(session, 0); }
}

setInterval(() => {
  const old = JSON.stringify(cachedProcesses.map(p => p.pid));
  refreshProcesses();
  const now = JSON.stringify(cachedProcesses.map(p => p.pid));
  if (old !== now) broadcast("processes", cachedProcesses);
  // Process changes can flip session statuses (e.g. awaiting_input → idle when pi exits)
  for (const [filePath, session] of sessionCache) {
    const oldStatus = session.status;
    stat(filePath).then(fstat => {
      computeStatus(session, fstat.mtimeMs);
      if (session.status !== oldStatus) broadcast("session_update", session);
    }).catch(() => {});
  }
}, 10000);

setInterval(checkStaleStatuses, 3000);
setInterval(scanForDeletedSessions, 60000);

server.listen(PORT, () => {
  console.log(`  🔭 Dashboard: http://localhost:${PORT}`);
  console.log(`  📡 SSE stream: http://localhost:${PORT}/api/events`);
  console.log(`  🔄 Watching ${SESSION_DIR}\n`);
});

// ── HTML Dashboard ───────────────────────────────────────────────────

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 256 256'><style>path{fill:%23e6edf3}@media(prefers-color-scheme:light){path{fill:%23000000}}</style><path d='M236,172a40,40,0,0,1-80,0V76H100V200a12,12,0,0,1-24,0V76H72a36,36,0,0,0-36,36,12,12,0,0,1-24,0A60.07,60.07,0,0,1,72,52H224a12,12,0,0,1,0,24H180v96a16,16,0,0,0,32,0,12,12,0,0,1,24,0Z'/></svg>">
<title>Pi Agent Monitor</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --bg-card: #161b22; --bg-card-hover: #1c2333;
    --border: #30363d; --text: #e6edf3; --text-dim: #8b949e; --text-bright: #f0f6fc;
    --accent: #58a6ff; --green: #3fb950; --yellow: #d29922; --orange: #db6d28;
    --red: #f85149; --purple: #bc8cff; --cyan: #39d353;
    --font-mono: 'SF Mono','Fira Code','JetBrains Mono',Consolas,monospace;
    --font-sans: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    --radius: 8px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:var(--font-sans); background:var(--bg); color:var(--text); min-height:100vh; line-height:1.5; }

  .header { background:var(--bg-card); border-bottom:1px solid var(--border); padding:16px 24px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:100; backdrop-filter:blur(12px); }
  .header-left { display:flex; align-items:center; gap:16px; }
  .header h1 { font-size:18px; font-weight:600; display:flex; align-items:center; gap:8px; }
  .header h1 .logo { vertical-align:middle; }
  .hub-badge { background:rgb(255,153,0); color:#000; font-size:22px; font-weight:700; padding:0px 5px; border-radius:4px; line-height:1.4; margin-left:-4px; }
  .header-stats { display:flex; gap:20px; font-size:13px; color:var(--text-dim); position:absolute; left:50%; transform:translateX(-50%); }
  .header-stats .sv { color:var(--text-bright); font-weight:600; font-family:var(--font-mono); }
  .header-right { display:flex; align-items:center; gap:12px; }
  .conn-indicator { font-size:12px; color:var(--text-dim); font-family:var(--font-mono); display:flex; align-items:center; gap:6px; }
  .conn-dot { width:8px; height:8px; border-radius:50%; transition:background 0.3s; }
  .conn-dot.connected { background:var(--green); }
  .conn-dot.disconnected { background:var(--red); animation:pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  @keyframes flash { 0%{box-shadow:0 0 0 0 rgba(63,185,80,0.4)} 100%{box-shadow:0 0 0 8px rgba(63,185,80,0)} }
  .conn-dot.flash { animation:flash 0.4s ease-out; }

  .filter-bar { padding:12px 24px; display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid var(--border); background:var(--bg); }
  .filter-btn { background:var(--bg-card); border:1px solid var(--border); color:var(--text-dim); padding:4px 12px; border-radius:20px; font-size:12px; cursor:pointer; transition:all 0.15s; font-family:var(--font-sans); }
  .filter-btn:hover { border-color:var(--text-dim); color:var(--text); }
  .filter-btn.active { border-color:var(--accent); color:var(--accent); background:rgba(88,166,255,0.08); }
  .filter-btn .count { background:rgba(255,255,255,0.08); padding:1px 6px; border-radius:10px; margin-left:4px; font-family:var(--font-mono); font-size:11px; }
  .filter-btn.active .count { background:rgba(88,166,255,0.15); }
  .search-input { background:var(--bg-card); border:1px solid var(--border); color:var(--text); padding:4px 12px; border-radius:20px; font-size:12px; outline:none; width:220px; font-family:var(--font-sans); margin-left:auto; }
  .search-input:focus { border-color:var(--accent); }
  .search-input::placeholder { color:var(--text-dim); }

  .main { padding:20px 24px; }
  .section-title { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-dim); margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .section-title .badge { background:var(--accent); color:var(--bg); padding:1px 7px; border-radius:10px; font-size:11px; font-weight:700; }



  .session-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); gap:12px; margin-bottom:28px; width:100%; }
  @media (min-width:1400px) { .session-grid { grid-template-columns:repeat(3,1fr); } }

  .session-card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); padding:16px; transition:background 0.15s,border-color 0.15s; cursor:default; position:relative; overflow:hidden; }
  .session-card:hover { background:var(--bg-card-hover); border-color:#444c56; }
  .session-card.status-running { border-left:3px solid var(--green); }
  .session-card.status-awaiting_input { border-left:3px solid var(--yellow); }
  .session-card.status-error { border-left:3px solid var(--red); }
  .session-card.status-aborted { border-left:3px solid var(--orange); }
  .session-card.status-context_full { border-left:3px solid var(--purple); }
  .session-card.status-active { border-left:3px solid var(--cyan); }
  .session-card.status-idle { border-left:3px solid var(--border); }
  .session-card.status-interrupted { border-left:3px solid var(--orange); }
  .session-card.just-updated { animation:cardFlash 0.6s ease-out; }
  @keyframes cardFlash { 0%{box-shadow:inset 0 0 0 1px var(--accent)} 100%{box-shadow:inset 0 0 0 1px transparent} }

  .card-header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
  .card-project { font-family:var(--font-mono); font-size:13px; color:var(--accent); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:300px; }
  .card-name { font-size:14px; font-weight:600; color:var(--text-bright); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .status-badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:12px; text-transform:uppercase; letter-spacing:0.03em; white-space:nowrap; flex-shrink:0; }
  .status-badge.running { background:rgba(63,185,80,0.15); color:var(--green); }
  .status-badge.awaiting_input { background:rgba(210,153,34,0.15); color:var(--yellow); }
  .status-badge.error { background:rgba(248,81,73,0.15); color:var(--red); }
  .status-badge.aborted { background:rgba(219,109,40,0.15); color:var(--orange); }
  .status-badge.context_full { background:rgba(188,140,255,0.15); color:var(--purple); }
  .status-badge.active { background:rgba(57,211,83,0.15); color:var(--cyan); }
  .status-badge.idle { background:rgba(139,148,158,0.1); color:var(--text-dim); }
  .status-badge.interrupted { background:rgba(219,109,40,0.15); color:var(--orange); }

  .card-model { font-size:11px; color:var(--text-dim); font-family:var(--font-mono); margin-bottom:10px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .card-model .thinking-badge { background:rgba(188,140,255,0.15); color:var(--purple); padding:0 5px; border-radius:4px; font-size:10px; white-space:nowrap; width:min-content; }
  .card-model .terminal-badge { white-space:nowrap; width:min-content; }
  .card-activity { background:rgba(0,0,0,0.25); border-radius:6px; padding:10px 12px; margin-bottom:10px; font-size:12px; }
  .activity-label { color:var(--text-dim); font-size:11px; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px; }
  .activity-text { color:var(--text); font-size:12.5px; line-height:1.5; max-height:200px; overflow-y:auto; overflow-x:hidden; scroll-behavior:smooth; overscroll-behavior:contain; }
  .activity-text.error { color:var(--red); font-family:var(--font-mono); white-space:pre-wrap; word-break:break-all; }
  .activity-text.tool { color:var(--cyan); font-family:var(--font-mono); white-space:pre-wrap; word-break:break-all; }
  .activity-text p { margin:0 0 8px 0; }
  .activity-text p:last-child { margin-bottom:0; }
  .activity-text code { font-family:var(--font-mono); font-size:11.5px; background:rgba(255,255,255,0.06); padding:1px 5px; border-radius:4px; color:var(--accent); }
  .activity-text pre { margin:6px 0; padding:8px 10px; background:rgba(0,0,0,0.3); border-radius:6px; overflow-x:auto; border:1px solid var(--border); }
  .activity-text pre code { background:none; padding:0; color:var(--text); font-size:11px; line-height:1.4; display:block; white-space:pre; }
  .activity-text pre { position:relative; }
  .activity-text pre code[class*="language-"]::after { position:absolute; top:4px; right:8px; font-size:9px; color:var(--text-dim); font-family:var(--font-mono); text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; pointer-events:none; }
  .activity-text pre code.language-js::after { content:'JS'; }
  .activity-text pre code.language-javascript::after { content:'JS'; }
  .activity-text pre code.language-ts::after { content:'TS'; }
  .activity-text pre code.language-typescript::after { content:'TS'; }
  .activity-text pre code.language-python::after { content:'PY'; }
  .activity-text pre code.language-py::after { content:'PY'; }
  .activity-text pre code.language-bash::after { content:'BASH'; }
  .activity-text pre code.language-sh::after { content:'SH'; }
  .activity-text pre code.language-shell::after { content:'SHELL'; }
  .activity-text pre code.language-html::after { content:'HTML'; }
  .activity-text pre code.language-css::after { content:'CSS'; }
  .activity-text pre code.language-json::after { content:'JSON'; }
  .activity-text pre code.language-sql::after { content:'SQL'; }
  .activity-text pre code.language-rust::after { content:'RUST'; }
  .activity-text pre code.language-go::after { content:'GO'; }
  .activity-text pre code.language-java::after { content:'JAVA'; }
  .activity-text pre code.language-c::after { content:'C'; }
  .activity-text pre code.language-cpp::after { content:'C++'; }
  .activity-text pre code.language-ruby::after { content:'RUBY'; }
  .activity-text pre code.language-yaml::after { content:'YAML'; }
  .activity-text pre code.language-toml::after { content:'TOML'; }
  .activity-text pre code.language-xml::after { content:'XML'; }
  .activity-text pre code.language-diff::after { content:'DIFF'; }
  /* Syntax highlighting */
  /* highlight.js theme overrides to match dashboard */
  .activity-text pre code.hljs { background:transparent; padding:0; }
  /* Tool call pretty rendering */
  .tool-call-header { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .tool-call-name { font-family:var(--font-mono); font-size:12px; font-weight:600; color:var(--cyan); }
  .tool-call-icon { font-size:14px; }
  .tool-call-args { font-family:var(--font-mono); font-size:11px; color:var(--text); background:rgba(0,0,0,0.3); padding:6px 10px; border-radius:6px; border:1px solid var(--border); white-space:pre-wrap; word-break:break-all; overflow-x:auto; max-height:120px; overflow-y:auto; }
  .tool-call-args .arg-key { color:var(--purple); }
  .tool-call-args .arg-val { color:var(--text); }
  .tool-result-badge { display:inline-block; font-size:10px; padding:1px 6px; border-radius:4px; margin-right:6px; font-weight:600; }
  .tool-result-badge.success { background:rgba(63,185,80,0.15); color:var(--green); }
  .tool-result-badge.error { background:rgba(248,81,73,0.15); color:var(--red); }
  .activity-expand { font-size:11px; color:var(--accent); cursor:pointer; padding:4px 0; font-family:var(--font-mono); border:none; background:none; }
  .activity-expand:hover { text-decoration:underline; }
  .activity-text.collapsed { max-height:120px; overflow:hidden; position:relative; }
  .activity-text.collapsed::after { content:''; position:absolute; bottom:0; left:0; right:0; height:40px; background:linear-gradient(transparent,rgba(0,0,0,0.25)); pointer-events:none; }
  /* Markdown tables */
  .activity-text table { border-collapse:collapse; margin:6px 0; font-size:11px; font-family:var(--font-mono); width:100%; }
  .activity-text th { background:rgba(255,255,255,0.05); font-weight:600; text-align:left; }
  .activity-text th,.activity-text td { padding:4px 10px; border:1px solid var(--border); }
  .activity-text tr:nth-child(even) { background:rgba(255,255,255,0.02); }
  .activity-text strong { color:var(--text-bright); font-weight:600; }
  .activity-text em { font-style:italic; color:var(--text); }
  .activity-text h1,.activity-text h2,.activity-text h3,.activity-text h4 { color:var(--text-bright); font-weight:600; margin:8px 0 4px 0; }
  .activity-text h1 { font-size:15px; } .activity-text h2 { font-size:14px; } .activity-text h3 { font-size:13px; } .activity-text h4 { font-size:12.5px; }
  .activity-text ul,.activity-text ol { margin:4px 0; padding-left:20px; }
  .activity-text li { margin:2px 0; }
  .activity-text hr { border:none; border-top:1px solid var(--border); margin:8px 0; }
  .activity-text a { color:var(--accent); text-decoration:none; }
  .activity-text a:hover { text-decoration:underline; }
  .activity-text blockquote { border-left:3px solid var(--border); padding-left:10px; margin:6px 0; color:var(--text-dim); }
  .activity-text::-webkit-scrollbar { width:5px; } .activity-text::-webkit-scrollbar-thumb { background:var(--border); border-radius:3px; }

  .card-stats { display:flex; gap:14px; font-size:11px; color:var(--text-dim); font-family:var(--font-mono); flex-wrap:wrap; }
  .card-stats span { display:flex; align-items:center; gap:3px; }
  .card-stats .label { color:var(--text-dim); }
  .card-stats .value { color:var(--text); }

  .card-actions { display:flex; gap:6px; margin-top:10px; padding-top:10px; border-top:1px solid var(--border); flex-wrap:wrap; align-items:center; }
  .card-footer-times { flex:1; display:flex; justify-content:space-between; font-size:11px; color:var(--text-dim); font-family:var(--font-mono); min-width:200px; }

  .btn { font-size:11px; font-family:var(--font-mono); padding:3px 10px; border-radius:6px; cursor:pointer; border:1px solid var(--border); background:var(--bg); color:var(--text-dim); transition:all 0.15s; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .btn:hover { border-color:var(--accent); color:var(--accent); }
  .btn.btn-focus { border-color:var(--green); color:var(--green); display:inline-flex; align-items:center; gap:4px; }
  .btn.btn-focus .icon { display:inline-flex; align-items:center; }
  .btn.btn-focus:hover { background:rgba(63,185,80,0.1); }
  .btn.btn-copy:hover { background:rgba(88,166,255,0.1); }
  .btn .icon { font-size:13px; }

  .toast { position:fixed; bottom:20px; right:20px; background:var(--bg-card); border:1px solid var(--green); color:var(--green); padding:10px 16px; border-radius:8px; font-size:13px; font-family:var(--font-mono); opacity:0; transform:translateY(10px); transition:all 0.3s; z-index:200; pointer-events:none; }
  .toast.show { opacity:1; transform:translateY(0); }

  .empty-state { text-align:center; padding:60px 20px; color:var(--text-dim); }
  .empty-state .icon { font-size:48px; margin-bottom:16px; }
  .empty-state h2 { font-size:18px; color:var(--text); margin-bottom:8px; }
  .empty-state p { font-size:14px; }

  ::-webkit-scrollbar { width:8px; }
  ::-webkit-scrollbar-track { background:var(--bg); }
  ::-webkit-scrollbar-thumb { background:var(--border); border-radius:4px; }
  ::-webkit-scrollbar-thumb:hover { background:#444c56; }

  @media (max-width:768px) { .session-grid{grid-template-columns:1fr} .header{flex-wrap:wrap;gap:10px} .filter-bar{padding:10px 16px} .main{padding:16px} }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <h1><svg class="logo" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 256 256"><path fill="currentColor" d="M236,172a40,40,0,0,1-80,0V76H100V200a12,12,0,0,1-24,0V76H72a36,36,0,0,0-36,36,12,12,0,0,1-24,0A60.07,60.07,0,0,1,72,52H224a12,12,0,0,1,0,24H180v96a16,16,0,0,0,32,0,12,12,0,0,1,24,0Z"/></svg><span class="hub-badge">hub</span></h1>
    <div class="header-stats" id="header-stats"></div>
  </div>
  <div class="header-right">
    <div class="conn-indicator">
      <div class="conn-dot connected" id="conn-dot"></div>
      <span id="conn-label">SSE connected</span>
    </div>
  </div>
</div>
<div class="filter-bar" id="filter-bar"></div>
<div class="main">
  <div id="sessions-container"></div>
</div>
<div class="toast" id="toast"></div>

<script>
// ── State ───────────────────────────────────────────────────────
const sessionsById = new Map();
let allProcesses = [];
let activeFilter = "all";
let searchQuery = "";
let notificationsEnabled = false;
let previousStatuses = new Map(); // id → status (for transition detection)

// ── Notifications ───────────────────────────────────────────────

async function initNotifications() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") { notificationsEnabled = true; return; }
  if (Notification.permission === "default") {
    const perm = await Notification.requestPermission();
    notificationsEnabled = perm === "granted";
  }
}

function notifySession(session, reason) {
  const isError = reason === "error";
  const title = isError ? "π Agent error" : "π Agent awaiting input";
  // Desktop notification
  if (notificationsEnabled) {
    const body = shortPath(session.projectPath) + (session.sessionName ? " — " + session.sessionName : "") +
      "\\n" + (isError ? (session.lastErrorMessage || "Unknown error").slice(0, 100) : (session.lastAssistantText || session.lastUserMessage || "").slice(0, 100));
    const n = new Notification(title, {
      body,
      icon: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">π</text></svg>'),
      tag: "pi-notify-" + session.id,
      requireInteraction: false,
    });
    n.onclick = () => { window.focus(); focusTerminal(session.id); n.close(); };
    setTimeout(() => n.close(), 15000);
  }
  // Audio ping
  playPing();
}

function playPing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch {}
}

// ── Actions ─────────────────────────────────────────────────────

async function focusTerminal(sessionId) {
  try {
    const res = await fetch("/api/focus/" + sessionId);
    const data = await res.json();
    if (data.success) showToast("Terminal focused ✓");
    else showToast("Could not focus terminal");
  } catch { showToast("Focus failed"); }
}

function copyResumeCmd(filePath) {
  const cmd = "pi -c --session " + filePath;
  navigator.clipboard.writeText(cmd).then(
    () => showToast("Copied: " + cmd),
    () => showToast("Copy failed")
  );
}

function copySessionPath(filePath) {
  navigator.clipboard.writeText(filePath).then(
    () => showToast("Session path copied"),
    () => showToast("Copy failed")
  );
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 2500);
}

// ── SSE Connection ──────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource("/api/events");

  es.addEventListener("snapshot", (e) => {
    const data = JSON.parse(e.data);
    sessionsById.clear();
    previousStatuses.clear();
    for (const s of data.sessions) {
      sessionsById.set(s.id, s);
      previousStatuses.set(s.id, s.status);
    }
    allProcesses = data.processes || [];
    fullRender();
    setConnected(true);
  });

  es.addEventListener("session_update", (e) => {
    const session = JSON.parse(e.data);
    const isNew = !sessionsById.has(session.id);
    const prevStatus = previousStatuses.get(session.id);
    sessionsById.set(session.id, session);
    previousStatuses.set(session.id, session.status);

    // Notify on clean agent completion (awaiting input with stop reason) or terminal errors
    if (session.status === "awaiting_input" && prevStatus && prevStatus !== "awaiting_input" && session.lastStopReason === "stop") {
      notifySession(session, "awaiting_input");
    } else if (session.status === "error" && prevStatus && prevStatus !== "error") {
      notifySession(session, "error");
    }

    if (isNew) { fullRender(); } else {
      patchCard(session);
      renderHeaderStats();
      renderFilterBar();
    }
    flashConnDot();
  });

  es.addEventListener("session_remove", (e) => {
    const { id } = JSON.parse(e.data);
    sessionsById.delete(id);
    previousStatuses.delete(id);
    const el = document.getElementById("card-" + id);
    if (el) {
      el.style.transition = "opacity 0.3s,transform 0.3s";
      el.style.opacity = "0"; el.style.transform = "scale(0.95)";
      setTimeout(() => fullRender(), 350);
    } else { fullRender(); }
  });

  es.addEventListener("processes", (e) => {
    allProcesses = JSON.parse(e.data);
    renderHeaderStats();
  });

  es.onopen = () => setConnected(true);
  es.onerror = () => setConnected(false);
}

function setConnected(ok) {
  document.getElementById("conn-dot").className = "conn-dot " + (ok ? "connected" : "disconnected");
  document.getElementById("conn-label").textContent = ok ? "connected" : "reconnecting…";
}
function flashConnDot() {
  const dot = document.getElementById("conn-dot");
  dot.classList.remove("flash"); void dot.offsetWidth; dot.classList.add("flash");
}

// ── Sorted + filtered ───────────────────────────────────────────

function getSorted() { return [...sessionsById.values()].sort((a,b) => b.lastActivityTs - a.lastActivityTs); }
function getFiltered() {
  let s = getSorted();
  if (activeFilter !== "all") s = s.filter(x => x.status === activeFilter);
  if (searchQuery) { const q = searchQuery.toLowerCase(); s = s.filter(x =>
    (x.projectPath||"").toLowerCase().includes(q) || (x.sessionName||"").toLowerCase().includes(q) ||
    (x.model||"").toLowerCase().includes(q) || (x.provider||"").toLowerCase().includes(q) ||
    (x.lastUserMessage||"").toLowerCase().includes(q)
  ); }
  return s;
}

// ── Render ───────────────────────────────────────────────────────

function fullRender() { renderHeaderStats(); renderFilterBar(); renderSessionGrid(); }

function renderHeaderStats() {
  const all = getSorted();
  const active = all.filter(s => s.isActive).length;
  const awaiting = all.filter(s => s.awaitingInput).length;
  const cost = all.reduce((sum,s) => sum + s.totalCost, 0);
  document.getElementById("header-stats").innerHTML =
    '<span><span class="sv">'+active+'</span> active</span>'+
    '<span><span class="sv"'+(awaiting>0?' style="color:var(--yellow)"':'')+'>'+awaiting+'</span> awaiting</span>'+
    '<span><span class="sv">$'+cost.toFixed(2)+'</span> cost</span>';
}

function renderFilterBar() {
  const all = getSorted();
  const counts = {all:all.length};
  for (const s of ["running","awaiting_input","active","error","aborted","interrupted","context_full","idle"]) counts[s] = all.filter(x=>x.status===s).length;
  const labels = {all:"All",running:"Running",awaiting_input:"Awaiting Input",active:"Active",error:"Error",aborted:"Aborted",interrupted:"Interrupted",context_full:"Context Full",idle:"Idle"};
  const se = document.querySelector(".search-input");
  const hadFocus = se && document.activeElement === se;
  const ss = se?.selectionStart, sn = se?.selectionEnd;
  let h = "";
  for (const [k,l] of Object.entries(labels)) {
    if (k!=="all" && counts[k]===0) continue;
    h += '<button class="filter-btn '+(activeFilter===k?"active":"")+'" onclick="setFilter(\\''+k+'\\')">'+l+'<span class="count">'+counts[k]+'</span></button>';
  }
  h += '<input class="search-input" type="text" placeholder="Search projects, models…" value="'+esc(searchQuery)+'" oninput="setSearch(this.value)">';
  document.getElementById("filter-bar").innerHTML = h;
  if (hadFocus) { const n = document.querySelector(".search-input"); if(n){n.focus();n.setSelectionRange(ss,sn);} }
}

function renderSessionGrid() {
  const c = document.getElementById("sessions-container");
  const sessions = getFiltered();
  if (!sessions.length) {
    c.innerHTML = '<div class="empty-state"><div class="icon">π</div><h2>No sessions found</h2><p>'+(sessionsById.size===0?"Start a pi agent to see sessions here":"No sessions match the current filter")+'</p></div>';
    return;
  }
  const active = sessions.filter(s => s.isActive || s.awaitingInput);
  const recent = sessions.filter(s => !s.isActive && !s.awaitingInput);
  let h = "";
  if (active.length) { h += '<div class="section-title">Active Sessions <span class="badge">'+active.length+'</span></div><div class="session-grid" id="grid-active">'+active.map(cardHtml).join("")+'</div>'; }
  if (recent.length) { h += '<div class="section-title">Recent Sessions <span class="badge">'+recent.length+'</span></div><div class="session-grid" id="grid-recent">'+recent.map(cardHtml).join("")+'</div>'; }
  c.innerHTML = h;
}

function patchCard(s) {
  const el = document.getElementById("card-"+s.id);
  if (!el) { fullRender(); return; }
  const isAct = s.isActive||s.awaitingInput;
  const gid = el.closest(".session-grid")?.id;
  if ((isAct && gid==="grid-recent") || (!isAct && gid==="grid-active")) { fullRender(); return; }
  el.className = "session-card status-"+s.status+" just-updated";
  el.innerHTML = cardInner(s);
  setTimeout(() => el.classList.remove("just-updated"), 600);
}

const SL = {running:"Running",awaiting_input:"Awaiting Input",active:"Active",error:"Error",aborted:"Aborted",interrupted:"Interrupted",context_full:"Ctx Full",idle:"Idle"};

function cardHtml(s) { return '<div class="session-card status-'+s.status+'" id="card-'+s.id+'">'+cardInner(s)+'</div>'; }

function cardInner(s) {
  let act = "";
  if (s.lastErrorMessage) {
    act = '<div class="card-activity"><div class="activity-label">⚠ Error</div><div class="activity-text error">'+esc(s.lastErrorMessage)+'</div></div>';
  } else if (s.lastAssistantText) {
    const rendered = renderMd(s.lastAssistantText);
    const needsCollapse = s.lastAssistantText.length > 400 || (s.lastAssistantText.match(/\\n/g)||[]).length > 8;
    act = '<div class="card-activity"><div class="activity-label">Last Response</div><div class="activity-text' + (needsCollapse ? ' collapsed" data-expandable="true' : '') + '">' + rendered + '</div>' + (needsCollapse ? '<button class="activity-expand" onclick="toggleExpand(this)">▼ Show more</button>' : '') + '</div>';
  } else if (s.lastToolCall) {
    act = '<div class="card-activity"><div class="activity-label">Last Tool Call</div><div class="activity-text">' + renderToolCall(s.lastToolCall) + '</div></div>';
  } else if (s.lastUserMessage) {
    act = '<div class="card-activity"><div class="activity-label">Last Prompt</div><div class="activity-text">'+renderMd(s.lastUserMessage)+'</div></div>';
  }
  if (s.lastToolResult && !s.lastErrorMessage) {
    const badge = s.lastToolResult.isError ? '<span class="tool-result-badge error">ERROR</span>' : '<span class="tool-result-badge success">OK</span>';
    const toolName = s.lastToolResult.toolName ? '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim)">' + esc(s.lastToolResult.toolName) + '</span> ' : '';
    act += '<div class="card-activity" style="margin-top:6px"><div class="activity-label">Last Tool Result ' + toolName + badge + '</div><div class="activity-text tool" style="max-height:80px">'+esc(s.lastToolResult.preview)+'</div></div>';
  }

  const hasTerm = s.terminalWindow;
  let btns =
    (hasTerm ? '<button class="btn btn-focus" onclick="event.stopPropagation();focusTerminal(\\''+s.id+'\\')"><span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M251,123.13c-.37-.81-9.13-20.26-28.48-39.61C196.63,57.67,164,44,128,44S59.37,57.67,33.51,83.52C14.16,102.87,5.4,122.32,5,123.13a12.08,12.08,0,0,0,0,9.75c.37.82,9.13,20.26,28.49,39.61C59.37,198.34,92,212,128,212s68.63-13.66,94.48-39.51c19.36-19.35,28.12-38.79,28.49-39.61A12.08,12.08,0,0,0,251,123.13Zm-46.06,33C183.47,177.27,157.59,188,128,188s-55.47-10.73-76.91-31.88A130.36,130.36,0,0,1,29.52,128,130.45,130.45,0,0,1,51.09,99.89C72.54,78.73,98.41,68,128,68s55.46,10.73,76.91,31.89A130.36,130.36,0,0,1,226.48,128,130.45,130.45,0,0,1,204.91,156.12ZM128,84a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,84Zm0,64a20,20,0,1,1,20-20A20,20,0,0,1,128,148Z"></path></svg></span> Focus Terminal</button>' : '') +
    '<button class="btn btn-copy" onclick="event.stopPropagation();copyResumeCmd(\\''+esc(s.filePath)+'\\')"><span class="icon">⎘</span> Resume Cmd</button>' +
    '<button class="btn" onclick="event.stopPropagation();copySessionPath(\\''+esc(s.filePath)+'\\')"><span class="icon">📋</span> Path</button>';

  return '<div class="card-header"><div>'+
    '<div class="card-project" title="'+esc(s.cwd||s.projectPath)+'">'+esc(shortPath(s.projectPath))+'</div>'+
    (s.sessionName?'<div class="card-name">'+esc(s.sessionName)+'</div>':'')+
    '</div><span class="status-badge '+s.status+'">'+(SL[s.status]||s.status)+'</span></div>'+
    '<div class="card-model">'+(s.provider?esc(s.provider)+' / ':'')+(s.model?esc(s.model):'no model')+
    (s.thinkingLevel&&s.thinkingLevel!=='off'?' <span class="thinking-badge">🧠 '+s.thinkingLevel+'</span>':'')+
    (hasTerm?' <span class="terminal-badge" style="color:var(--green)">● '+esc(s.terminalWindow.type)+'</span>':'')+
    '</div>'+act+
    '<div class="card-stats">'+
    '<span><span class="label">msgs</span> <span class="value">'+(s.userMessages+s.assistantMessages)+'</span></span>'+
    '<span><span class="label">tools</span> <span class="value">'+s.toolCalls+'</span></span>'+
    '<span><span class="label">cost</span> <span class="value">$'+s.totalCost.toFixed(3)+'</span></span>'+
    '<span><span class="label">tokens</span> <span class="value">'+fmtTok(s.totalTokens.total)+'</span></span>'+
    (s.compactions?'<span><span class="label">compacts</span> <span class="value">'+s.compactions+'</span></span>':'')+
    (s.branches?'<span><span class="label">branches</span> <span class="value">'+s.branches+'</span></span>':'')+
    '</div>'+
    '<div class="card-actions">'+btns+
    '<div class="card-footer-times"><span title="'+esc(s.startedAt)+'">Started '+timeAgo(new Date(s.startedAt).getTime())+'</span>'+
    '<span>Activity '+timeAgo(s.lastActivityTs)+'</span></div></div>';
}

// ── Helpers ─────────────────────────────────────────────────────

function shortPath(p) { return p ? p.replace(new RegExp("^/home/[^/]+"),"~") : "~"; }
function timeAgo(ts) {
  if (!ts) return "—";
  const d = Date.now()-ts; if (d<0) return "just now";
  const s = Math.floor(d/1000);
  if (s<10) return "just now"; if (s<60) return s+"s ago";
  const m = Math.floor(s/60); if (m<60) return m+"m ago";
  const h = Math.floor(m/60); if (h<24) return h+"h ago";
  return Math.floor(h/24)+"d ago";
}
function fmtTok(n) { if(!n)return"0"; if(n>=1e6)return(n/1e6).toFixed(1)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n); }
function esc(s) { return s ? s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;") : ""; }

function renderToolCall(tc) {
  const icons = {read:'📄',bash:'⚡',edit:'✏️',write:'💾',grep:'🔍',find:'🔍',search:'🔍'};
  const icon = icons[tc.name] || '🔧';
  let argsHtml = '';
  if (tc.args) {
    // Try to pretty-format as key: value if it looks like a path or command
    argsHtml = '<div class="tool-call-args">' + esc(tc.args) + '</div>';
  }
  return '<div class="tool-call-header"><span class="tool-call-icon">' + icon + '</span><span class="tool-call-name">' + esc(tc.name) + '</span></div>' + argsHtml;
}

function toggleExpand(btn) {
  const textEl = btn.previousElementSibling;
  if (textEl.classList.contains('collapsed')) {
    textEl.classList.remove('collapsed');
    btn.textContent = '▲ Show less';
  } else {
    textEl.classList.add('collapsed');
    btn.textContent = '▼ Show more';
  }
}

function renderMd(src) {
  if (!src) return '';
  marked.setOptions({
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, {language: lang}).value; } catch {}
      }
      try { return hljs.highlightAuto(code).value; } catch {}
      return '';
    },
    breaks: false, gfm: true,
  });
  try { return DOMPurify.sanitize(marked.parse(src)); } catch { return esc(src); }
}
function setFilter(f) { activeFilter=f; fullRender(); }
function setSearch(q) { searchQuery=q; fullRender(); }

document.addEventListener("keydown",(e)=>{
  if(e.key==="Escape"&&document.activeElement.tagName!=="INPUT"){searchQuery="";activeFilter="all";fullRender();}
});

function refreshTimeAgos() {
  for (const [id,s] of sessionsById) {
    const card = document.getElementById("card-"+id);
    if (!card) continue;
    const ft = card.querySelector(".card-footer-times");
    if (ft) ft.innerHTML = '<span title="'+esc(s.startedAt)+'">Started '+timeAgo(new Date(s.startedAt).getTime())+'</span><span>Activity '+timeAgo(s.lastActivityTs)+'</span>';
  }
}

// ── Init ────────────────────────────────────────────────────────

initNotifications();
connectSSE();
setInterval(refreshTimeAgos, 30000);
</script>
</body>
</html>`;
