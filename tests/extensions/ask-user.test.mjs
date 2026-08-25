import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

const askUserModule = await import("../../extensions/ask-user.ts");
const {
  askUserCancelled,
  createAskUserTool,
  executeAskUser,
  normalizeAskUserInput,
  prepareAskUserArguments,
  resolveAskUserAnswer,
} = askUserModule;

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function createContext(custom, mode = "tui") {
  return {
    mode,
    ui: {
      custom,
    },
  };
}

function answered(text) {
  return { ok: true, status: "answered", selected_ids: [], ...(text === undefined ? {} : { text }) };
}

test("ask_user validates input and preserves valid text", () => {
  const input = normalizeAskUserInput({
    prompt: "Choose an answer",
    options: [
      { id: "one", label: " First ", description: " Details " },
      { id: "two", label: "Second" },
    ],
    placeholder: " Other ",
  });

  assert.equal(input.multiple, false);
  assert.equal(input.allowOther, true);
  assert.deepEqual(input.options, [
    { id: "one", label: " First ", description: " Details " },
    { id: "two", label: "Second" },
  ]);
  assert.equal(input.placeholder, " Other ");

  const cases = [
    {},
    { prompt: " " },
    { prompt: "ok", multiple: false },
    { prompt: "ok", options: [] },
    { prompt: "ok", options: [{ id: "bad id", label: "ok" }] },
    { prompt: "ok", options: [{ id: "same", label: "one" }, { id: "same", label: "two" }] },
    { prompt: "ok", options: [{ id: "one", label: "ok", unexpected: true }] },
    { prompt: "ok", options: [{ id: "one", label: "ok" }], allow_other: false, placeholder: "other" },
  ];
  for (const value of cases) {
    assert.throws(() => normalizeAskUserInput(value));
  }

  assert.throws(() => normalizeAskUserInput({ prompt: "😀".repeat(4_001) }));
  assert.doesNotThrow(() => normalizeAskUserInput({ prompt: "😀".repeat(4_000) }));
  assert.deepEqual(prepareAskUserArguments({}), { prompt: "" });
  assert.throws(
    () => normalizeAskUserInput({ prompt: "ok", ["x".repeat(10_000)]: true }),
    (error) => error.message === "Unknown input field.",
  );
});

test("ask_user resolves free-text, single-select, and multi-select answers", () => {
  const freeText = normalizeAskUserInput({ prompt: "Explain" });
  assert.deepEqual(
    resolveAskUserAnswer(freeText, new Set(), "  exact\ntext  ").result,
    answered("  exact\ntext  "),
  );
  assert.equal(resolveAskUserAnswer(freeText, new Set(), " \n").feedback, "Enter a nonblank answer.");

  const single = normalizeAskUserInput({
    prompt: "Choose",
    options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
  });
  assert.deepEqual(
    resolveAskUserAnswer(single, new Set(["second"]), "ignored").result,
    { ok: true, status: "answered", selected_ids: ["second"] },
  );
  assert.deepEqual(
    resolveAskUserAnswer(single, new Set(), " custom ").result,
    answered(" custom "),
  );
  assert.deepEqual(
    resolveAskUserAnswer(single, new Set(["first"]), "x".repeat(16_385)).result,
    { ok: true, status: "answered", selected_ids: ["first"] },
  );

  const multiple = normalizeAskUserInput({
    prompt: "Choose",
    options: [{ id: "first", label: "First" }, { id: "second", label: "Second" }],
    multiple: true,
  });
  assert.deepEqual(
    resolveAskUserAnswer(multiple, new Set(["second", "first"]), " note ").result,
    { ok: true, status: "answered", selected_ids: ["first", "second"], text: " note " },
  );
  assert.equal(resolveAskUserAnswer(multiple, new Set(), "").feedback, "Select an option or enter a nonblank answer.");
});

test("ask_user returns a structured unavailable error without a TUI", async () => {
  const result = await executeAskUser(
    { prompt: "Continue?" },
    createContext(async () => {
      throw new Error("custom must not run");
    }, "print"),
    undefined,
    {},
  );

  assert.deepEqual(result, {
    ok: false,
    error: { code: "UI_UNAVAILABLE", message: "ask_user requires an interactive TUI." },
  });
});

test("ask_user rejects concurrent prompts and clears active state after an answer", async () => {
  let component;
  const state = {};
  const context = createContext((factory) => new Promise((resolve) => {
    component = factory({ requestRender() {} }, theme, {}, resolve);
  }));

  const first = executeAskUser({ prompt: "First?" }, context, undefined, state);
  const second = await executeAskUser({ prompt: "Second?" }, context, undefined, state);
  assert.deepEqual(second, {
    ok: false,
    error: { code: "PROMPT_ACTIVE", message: "This session already has an active ask_user prompt." },
  });

  component.handleInput("\u001b");
  assert.deepEqual(await first, askUserCancelled());
  assert.equal(state.active, undefined);
});

test("ask_user preserves bracketed-paste text", async () => {
  let component;
  const context = createContext((factory) => new Promise((resolve) => {
    component = factory({ requestRender() {} }, theme, {}, resolve);
  }));
  const pending = executeAskUser({ prompt: "Explain" }, context, undefined, {});

  const narrowLines = component.render(1);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 1), JSON.stringify(narrowLines));
  component.handleInput("\u001b[200~  first\nsecond  \u001b[201~");
  assert.equal(component.text, "  first\nsecond  ");
  component.handleInput("\u001b");
  assert.deepEqual(await pending, askUserCancelled());
});

test("ask_user records invocation cancellation before a user answer", async () => {
  const controller = new AbortController();
  const context = createContext((factory) => new Promise((resolve) => {
    factory({ requestRender() {} }, theme, {}, resolve);
  }));
  const pending = executeAskUser({ prompt: "Continue?" }, context, controller.signal, {});

  controller.abort();
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: "INVOCATION_CANCELLED", message: "The ask_user invocation was cancelled." },
  });
});

test("ask_user exposes concise model guidance and clears a prompt on session shutdown", async () => {
  let tool;
  let shutdown;
  askUserModule.default({
    registerTool(value) {
      tool = value;
    },
    on(event, handler) {
      assert.equal(event, "session_shutdown");
      shutdown = handler;
    },
  });

  assert.equal(tool.name, "ask_user");
  assert.deepEqual(tool.promptGuidelines, [
    "Use ask_user only when required information or a decision cannot be inferred safely.",
    "Do not use ask_user to request passwords, access tokens, or other secrets.",
  ]);

  const pending = tool.execute(
    "tool-call",
    { prompt: "Continue?" },
    undefined,
    undefined,
    createContext((factory) => new Promise((resolve) => {
      factory({ requestRender() {} }, theme, {}, resolve);
    })),
  );
  shutdown({}, {});

  const toolResult = await pending;
  assert.deepEqual(JSON.parse(toolResult.content[0].text), {
    ok: false,
    tool: "ask_user",
    error: { code: "INVOCATION_CANCELLED", message: "The ask_user invocation was cancelled." },
  });
  assert.deepEqual(toolResult.details, {
    ok: false,
    tool: "ask_user",
    error: { code: "INVOCATION_CANCELLED", message: "The ask_user invocation was cancelled." },
  });

  const standaloneTool = createAskUserTool();
  assert.equal(standaloneTool.name, "ask_user");
});
