#!/usr/bin/env node

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const activeTools = new Map();
let finalResponse = "";

function log(message) {
  process.stderr.write(`[pi] ${message}\n`);
}

function firstLine(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(/\r?\n/, 1)[0].slice(0, 120);
}

function describeTool(name, args) {
  const toolArgs = args && typeof args === "object" ? args : {};
  const detail =
    name === "bash"
      ? firstLine(toolArgs.command)
      : ["read", "edit", "write"].includes(name)
        ? firstLine(toolArgs.path)
        : undefined;

  return detail ? `${name}: ${detail}` : name;
}

function messageText(message) {
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

for await (const line of lines) {
  let event;

  try {
    event = JSON.parse(line);
  } catch {
    log("received unrecognized output");
    continue;
  }

  switch (event.type) {
    case "agent_start":
      log("started");
      break;

    case "turn_start":
      log("thinking…");
      break;

    case "tool_execution_start": {
      const description = describeTool(event.toolName, event.args);
      activeTools.set(event.toolCallId, { description, startedAt: Date.now(), reportedProgress: false });
      log(`→ ${description}`);
      break;
    }

    case "tool_execution_update": {
      const activeTool = activeTools.get(event.toolCallId);
      if (activeTool && !activeTool.reportedProgress) {
        activeTool.reportedProgress = true;
        log(`… ${activeTool.description}`);
      }
      break;
    }

    case "tool_execution_end": {
      const activeTool = activeTools.get(event.toolCallId);
      const description = activeTool?.description ?? event.toolName;
      const elapsed = activeTool ? ` (${((Date.now() - activeTool.startedAt) / 1000).toFixed(1)}s)` : "";
      log(`${event.isError ? "✗" : "✓"} ${description}${elapsed}`);
      activeTools.delete(event.toolCallId);
      break;
    }

    case "auto_retry_start":
      log(`retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage ?? "request failed"}`);
      break;

    case "compaction_start":
      log("compacting context…");
      break;

    case "message_end": {
      const text = messageText(event.message);
      if (text) finalResponse = text;
      break;
    }

    case "agent_end":
      log("finished");
      break;
  }
}

if (finalResponse) {
  process.stdout.write(`${finalResponse.trimEnd()}\n`);
}
