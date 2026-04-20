/**
 * Pi Hub Monitor Extension
 *
 * Reports real-time agent lifecycle events to pi-hub's monitor dashboard
 * via HTTP POST to localhost. Gives the dashboard instant, accurate status
 * without any file-watching heuristics.
 *
 * Install: Place in ~/.pi/agent/extensions/pi-hub-monitor.ts
 *    or:   pi -e ./pi-hub-monitor.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PI_HUB_PORT = parseInt(process.env.PI_HUB_PORT || "7420", 10);
const PI_HUB_URL = `http://localhost:${PI_HUB_PORT}/api/agent-event`;

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  let cwd: string | undefined;

  function send(event: Record<string, unknown>) {
    const body = JSON.stringify({
      ...event,
      pid: process.pid,
      sessionId,
      sessionFile,
      cwd,
      timestamp: Date.now(),
    });
    // Fire-and-forget HTTP POST — never block the agent
    fetch(PI_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // pi-hub not running — that's fine, silently ignore
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile();
    cwd = ctx.cwd;
    send({ type: "session_start" });
  });

  pi.on("session_shutdown", async () => {
    send({ type: "session_shutdown" });
  });

  pi.on("agent_start", async () => {
    send({ type: "agent_start" });
  });

  pi.on("agent_end", async (event) => {
    send({
      type: "agent_end",
      messageCount: event.messages?.length ?? 0,
    });
  });

  pi.on("turn_start", async (event) => {
    send({
      type: "turn_start",
      turnIndex: event.turnIndex,
    });
  });

  pi.on("turn_end", async (event) => {
    send({
      type: "turn_end",
      turnIndex: event.turnIndex,
      stopReason: event.message?.stopReason,
    });
  });

  pi.on("tool_execution_start", async (event) => {
    send({
      type: "tool_execution_start",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
    });
  });

  pi.on("tool_execution_end", async (event) => {
    send({
      type: "tool_execution_end",
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
    });
  });
}
