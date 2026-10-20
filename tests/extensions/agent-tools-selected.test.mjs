import assert from "node:assert/strict";
import test from "node:test";
import agentTools, { AGENT_TOOL_NAMES, createAgentToolsExtension } from "../../extensions/agent-tools/index.ts";

function registration() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
  };
  return { tools, handlers, pi };
}

test("selected agent-tools factory registers only requested tools and hooks", () => {
  const selected = registration();
  createAgentToolsExtension(["read", "find", "grep"])(selected.pi);
  assert.deepEqual([...selected.tools.keys()].sort(), ["find", "grep", "read"]);
  assert.deepEqual([...selected.handlers.keys()], ["tool_result"]);

  const investigation = registration();
  createAgentToolsExtension(["read", "find", "grep", "web_search", "ask_user"])(investigation.pi);
  assert.deepEqual([...investigation.tools.keys()].sort(), ["ask_user", "find", "grep", "read", "web_search"]);
  assert.deepEqual([...investigation.handlers.keys()].sort(), ["before_agent_start", "model_select", "session_shutdown", "session_start", "tool_result"]);

  const defaults = registration();
  agentTools(defaults.pi);
  assert.deepEqual([...defaults.tools.keys()].sort(), [...AGENT_TOOL_NAMES].sort());
  for (const name of ["session_start", "session_shutdown", "model_select", "before_agent_start", "tool_result"])
    assert.ok(defaults.handlers.has(name), `${name} remains registered for the full extension`);
});

test("selected agent-tools factory rejects unknown tool names", () => {
  assert.throws(() => createAgentToolsExtension(["read", "subagent"]), /Unknown agent tool: subagent/);
});
