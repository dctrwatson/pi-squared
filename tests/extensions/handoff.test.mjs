import test from "node:test";
import assert from "node:assert/strict";

const handoffModule = await import("../../extensions/handoff.ts");
const {
  HANDOFF_SYSTEM_PROMPT,
  buildHandoffGenerationMessages,
  extractVisibleAssistantText,
  getLastCompleteAssistantText,
  parseHandoffMode,
} = handoffModule;

function assistantEntry(content, stopReason = "stop") {
  return {
    type: "message",
    id: "assistant-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage: {},
      stopReason,
      timestamp: 0,
    },
  };
}

function registerHandoffCommand() {
  let handler;
  handoffModule.default({
    registerCommand(name, command) {
      assert.equal(name, "handoff");
      handler = command.handler;
    },
    getThinkingLevel() {
      return "off";
    },
  });
  assert.equal(typeof handler, "function");
  return handler;
}

test("handoff accepts only its default mode and generate", () => {
  assert.equal(parseHandoffMode(""), "verbatim");
  assert.equal(parseHandoffMode("  "), "verbatim");
  assert.equal(parseHandoffMode(" generate "), "generate");
  assert.equal(parseHandoffMode("transfer"), undefined);
  assert.equal(parseHandoffMode("generate now"), undefined);
});

test("handoff extracts only visible assistant text verbatim", () => {
  const message = assistantEntry([
    { type: "thinking", thinking: "hidden reasoning" },
    { type: "text", text: "  First visible block\n" },
    { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "secret.ts" } },
    { type: "text", text: "Second visible block  " },
  ]).message;

  assert.equal(extractVisibleAssistantText(message), "  First visible block\nSecond visible block  ");
  assert.equal(getLastCompleteAssistantText([assistantEntry(message.content)]), "  First visible block\nSecond visible block  ");
});

test("handoff generates rather than using an incomplete newest response", () => {
  const previous = assistantEntry([{ type: "text", text: "A complete older response" }]);
  const newest = assistantEntry([{ type: "text", text: "An incomplete newest response" }], "length");

  assert.equal(getLastCompleteAssistantText([previous, newest]), undefined);
  assert.equal(getLastCompleteAssistantText([assistantEntry([{ type: "thinking", thinking: "only thought" }])]), undefined);
});

test("handoff uses its dedicated replacement system prompt", () => {
  assert.match(HANDOFF_SYSTEM_PROMPT, /only task is to produce the text that will become the first user message/i);
  assert.match(HANDOFF_SYSTEM_PROMPT, /Do not continue or solve the task/i);
  assert.match(HANDOFF_SYSTEM_PROMPT, /Output only the handoff text/i);
});

test("generated handoffs retain the compaction-aware context", () => {
  const messages = buildHandoffGenerationMessages([
    {
      type: "compaction",
      id: "compaction-entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Important compacted context",
      firstKeptEntryId: "kept-user",
      tokensBefore: 100,
    },
    {
      type: "message",
      id: "kept-user",
      parentId: "compaction-entry",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: "Recent uncompressed context",
        timestamp: 1,
      },
    },
  ]);

  assert.equal(messages.length, 3);
  assert.match(messages[0].content[0].text, /Important compacted context/);
  assert.equal(messages[1].content, "Recent uncompressed context");
  assert.equal(messages[2].content[0].text, "Create the handoff now.");
});

test("default handoff creates a linked blank session and leaves the draft in its editor", async () => {
  const handler = registerHandoffCommand();
  const notifications = [];
  const replacementNotifications = [];
  let newSessionOptions;
  let editorText;

  await handler("", {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => "/sessions/source.jsonl",
      getBranch: () => [assistantEntry([{ type: "text", text: "Continue with this exact context." }])],
    },
    ui: {
      notify: (...args) => notifications.push(args),
    },
    newSession: async (options) => {
      newSessionOptions = options;
      await options.withSession({
        ui: {
          setEditorText: (text) => {
            editorText = text;
          },
          notify: (...args) => replacementNotifications.push(args),
        },
      });
      return { cancelled: false };
    },
  });

  assert.equal(newSessionOptions.parentSession, "/sessions/source.jsonl");
  assert.equal(editorText, "Continue with this exact context.");
  assert.deepEqual(notifications, []);
  assert.equal(replacementNotifications.length, 1);
});

test("handoff rejects active sessions and does not create a destination", async () => {
  const handler = registerHandoffCommand();
  const notifications = [];

  await handler("", {
    mode: "tui",
    hasUI: true,
    isIdle: () => false,
    ui: {
      notify: (...args) => notifications.push(args),
    },
    newSession: async () => {
      throw new Error("newSession must not be called");
    },
  });

  assert.deepEqual(notifications, [["/handoff is only available when the agent is idle", "error"]]);
});

test("handoff falls back to generation when there is no complete response", async () => {
  const handler = registerHandoffCommand();
  const notifications = [];

  await handler("", {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    model: undefined,
    sessionManager: {
      getSessionFile: () => "/sessions/source.jsonl",
      getBranch: () => [assistantEntry([{ type: "text", text: "partial" }], "aborted")],
    },
    ui: {
      notify: (...args) => notifications.push(args),
    },
    newSession: async () => {
      throw new Error("newSession must not be called");
    },
  });

  assert.deepEqual(notifications, [["No model selected to generate a handoff", "error"]]);
});
