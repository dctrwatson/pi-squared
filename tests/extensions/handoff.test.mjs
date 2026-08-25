import test from "node:test";
import assert from "node:assert/strict";

const handoffModule = await import("../../extensions/handoff.ts");
const {
  HANDOFF_MAX_TOKENS,
  HANDOFF_SYSTEM_PROMPT,
  buildHandoffGenerationMessages,
  extractVisibleAssistantText,
  generateHandoffText,
  getLastCompleteAssistantText,
  parseHandoffMode,
} = handoffModule;
const HANDOFF_HELP_TEXT = `Usage: /handoff [generate]

Default (verbatim): Transfer the last complete assistant response.
generate: Generate a self-contained handoff from active context.
--help, -h: Show this help.`;

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
  let command;
  handoffModule.default({
    registerCommand(name, registeredCommand) {
      assert.equal(name, "handoff");
      command = registeredCommand;
    },
    getThinkingLevel() {
      return "off";
    },
  });
  assert.equal(typeof command?.handler, "function");
  assert.equal(typeof command?.getArgumentCompletions, "function");
  return command;
}

test("handoff accepts only its default mode and generate", () => {
  assert.equal(parseHandoffMode(""), "verbatim");
  assert.equal(parseHandoffMode("  "), "verbatim");
  assert.equal(parseHandoffMode(" generate "), "generate");
  assert.equal(parseHandoffMode("transfer"), undefined);
  assert.equal(parseHandoffMode("generate now"), undefined);
});

test("handoff help runs before TUI checks and side effects", async () => {
  const { handler } = registerHandoffCommand();
  const notifications = [];
  let generated = false;
  let sessionCreated = false;
  const context = {
    get mode() {
      throw new Error("Help must run before the TUI check");
    },
    ui: {
      notify: (...args) => notifications.push(args),
      custom: async () => {
        generated = true;
      },
    },
    newSession: async () => {
      sessionCreated = true;
      return { cancelled: false };
    },
  };

  await handler("--help", context);
  await handler("-h", context);

  assert.deepEqual(notifications, [
    [HANDOFF_HELP_TEXT, "info"],
    [HANDOFF_HELP_TEXT, "info"],
  ]);
  assert.equal(generated, false);
  assert.equal(sessionCreated, false);
});

test("handoff completes only its generate first argument", async () => {
  const { getArgumentCompletions } = registerHandoffCommand();
  const values = async (prefix) => {
    const completions = await getArgumentCompletions(prefix);
    return completions ? completions.map((item) => item.value) : null;
  };

  assert.deepEqual(await values(""), ["--help", "-h", "generate"]);
  assert.deepEqual(await values("--"), ["--help"]);
  assert.deepEqual(await values("-h"), ["-h"]);
  assert.deepEqual(await getArgumentCompletions("g"), [{
    value: "generate",
    label: "generate",
    description: "Generate a self-contained handoff from active context",
  }]);
  assert.equal(await values("transfer"), null);
  assert.equal(await values("generate more"), null);
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
  assert.match(HANDOFF_SYSTEM_PROMPT, /only task is to produce the first user message/i);
  assert.match(HANDOFF_SYSTEM_PROMPT, /compact, high-signal, self-contained handoff/i);
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

test("generated handoffs dispatch through the model runtime without retaining cache state", async () => {
  const model = { provider: "custom-provider", id: "handoff-model", maxTokens: 1_024 };
  const signal = new AbortController().signal;
  let request;
  const text = await generateHandoffText({
    getSystemPromptOptions: () => ({
      skills: [
        {
          name: "temporary-review",
          filePath: "/skills/temporary-review/SKILL.md",
          sourceInfo: { source: "extension:skill-loader" },
          disableModelInvocation: false,
        },
        {
          name: "command-only",
          filePath: "/skills/command-only/SKILL.md",
          sourceInfo: { source: "extension:skill-loader" },
          disableModelInvocation: true,
        },
      ],
    }),
    sessionManager: {
      buildContextEntries: () => [{
        type: "message",
        id: "user-entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Original request", timestamp: 0 },
      }],
    },
    modelRegistry: {
      complete: async (...args) => {
        request = args;
        return {
          role: "assistant",
          content: [{ type: "text", text: "Generated handoff" }],
          stopReason: "stop",
          timestamp: Date.now(),
        };
      },
    },
  }, model, signal);

  assert.equal(text, "Generated handoff");
  assert.equal(request[0], model);
  assert.equal(request[1].systemPrompt, HANDOFF_SYSTEM_PROMPT);
  assert.match(request[1].messages.at(-1).content[0].text, /temporary-review/);
  assert.doesNotMatch(request[1].messages.at(-1).content[0].text, /command-only/);
  assert.match(request[1].messages.at(-1).content[0].text, /do not carry into the new session/i);
  assert.equal(request[2].signal, signal);
  assert.equal(request[2].cacheRetention, "none");
  assert.equal(request[2].maxTokens, Math.min(HANDOFF_MAX_TOKENS, model.maxTokens));
  assert.match(request[2].sessionId, /^[0-9a-f-]+$/);
});

test("default handoff creates a linked blank session and leaves the draft in its editor", async () => {
  const { handler } = registerHandoffCommand();
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
  const { handler } = registerHandoffCommand();
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
  const { handler } = registerHandoffCommand();
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
