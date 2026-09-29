import test from "node:test";
import assert from "node:assert/strict";
import { CURSOR_MARKER, Editor, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";

const askUserModule = await import("../../extensions/agent-tools/ask-user.ts");
const {
  askUserCancelled,
  createAskUserTool,
  executeAskUser,
  normalizeAskUserInput,
  prepareAskUserArguments,
  registerAskUserTool,
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

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
const options = [{ id: "first", label: "First", description: "First details" }, { id: "second", label: "Second" }];
const invocationCancelled = {
  ok: false,
  error: { code: "INVOCATION_CANCELLED", message: "The ask_user invocation was cancelled." },
};
let previousKeybindings;
let keybindings;

test.beforeEach(() => {
  previousKeybindings = getKeybindings();
  keybindings = new KeybindingsManager();
  setKeybindings(keybindings);
});
test.afterEach(() => setKeybindings(previousKeybindings));

function prompt(t, input = { prompt: "Explain" }, bindings = {}, config = {}) {
  keybindings = new KeybindingsManager(bindings);
  setKeybindings(keybindings);
  const state = config.state ?? {};
  const results = [];
  const tui = { terminal: { rows: 24 }, requestRender() { harness.renderRequests++; } };
  const harness = {
    state, results, tui, keybindings, renderRequests: 0, customCalls: 0,
    send(...chunks) { for (const chunk of chunks) this.component.handleInput(chunk); },
  };
  harness.context = createContext((factory) => new Promise((resolve) => {
    harness.customCalls++;
    harness.component = factory(tui, theme, keybindings, (result) => {
      results.push(result);
      resolve(result);
    });
    harness.component.focused = true;
  }));
  harness.pending = executeAskUser(input, harness.context, config.signal, state);
  assert.ok(harness.component.editor instanceof Editor);
  assert.equal(harness.component.editor.disableSubmit, true);
  assert.equal(harness.component.editor.onSubmit, undefined);
  assert.equal(getKeybindings(), harness.keybindings);
  t.after(async () => {
    state.active?.finish(invocationCancelled);
    await harness.pending;
  });
  return harness;
}

function markerCount(lines) {
  return lines.join("\n").split(CURSOR_MARKER).length - 1;
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
  assert.throws(() => prepareAskUserArguments({}));
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

test("ask_user keeps null normalizers and strict schemas", () => {
  assert.deepEqual(prepareAskUserArguments({ prompt: "Explain", options: null, multiple: null, allow_other: null, placeholder: null }), { prompt: "Explain" });
  assert.deepEqual(prepareAskUserArguments({ prompt: "Choose", options: [{ id: "first", label: "First", description: null }] }), { prompt: "Choose", options: [{ id: "first", label: "First" }] });
  const schema = createAskUserTool().parameters;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.options.items.additionalProperties, false);
  for (const [key, value] of [["multiple", 1], ["allow_other", "true"], ["placeholder", 5]]) {
    assert.throws(() => prepareAskUserArguments({ prompt: "Choose", options, [key]: value }));
  }
});

test("ask_user rejects print, JSON, and RPC without calling custom", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    let calls = 0;
    const result = await executeAskUser({ prompt: "Continue?" }, createContext(() => { calls++; }, mode), undefined, {});
    assert.equal(calls, 0);
    assert.deepEqual(result, { ok: false, error: { code: "UI_UNAVAILABLE", message: "ask_user requires an interactive TUI." } });
  }
  const invalid = await executeAskUser({}, createContext(() => assert.fail("custom must not run"), "rpc"), undefined, {});
  assert.deepEqual(invalid, { ok: false, error: { code: "INVALID_INPUT", message: "prompt must be a string." } });
});

test("ask_user edits in the middle with forward and backward deletion", async (t) => {
  const h = prompt(t);
  h.send("ac", `${ESC}[D`, "b");
  assert.equal(h.component.editor.getExpandedText(), "abc");
  h.send(`${ESC}[3~`, "\u007f", "B");
  assert.equal(h.component.editor.getExpandedText(), "aB");
  h.send("\r");
  assert.deepEqual(await h.pending, answered("aB"));
});

test("ask_user moves and deletes Unicode graphemes", (t) => {
  const h = prompt(t);
  h.send("A😀e\u0301界", `${ESC}[D`, `${ESC}[D`, "!");
  assert.equal(h.component.editor.getExpandedText(), "A😀!e\u0301界");
  h.send(`${ESC}[3~`);
  assert.equal(h.component.editor.getExpandedText(), "A😀!界");
  h.send("\u007f", "\u007f");
  assert.equal(h.component.editor.getExpandedText(), "A界");
});

test("ask_user submits on Enter and inserts configured default newlines", async (t) => {
  for (const newline of ["\n", `${ESC}[13;2u`]) {
    const h = prompt(t);
    h.send("first", newline, "second", "\r");
    assert.deepEqual(await h.pending, answered("first\nsecond"));
    assert.equal(h.component.editor.getExpandedText(), "first\nsecond");
  }
});

test("ask_user preserves expanded, untrimmed text after normalized paste", async (t) => {
  const h = prompt(t);
  h.send(PASTE_START, "  first\r\n", "\tsecond  ", PASTE_END, "\r");
  assert.deepEqual(await h.pending, answered("  first\n    second  "));
});

test("ask_user routes chunked pasted controls before wrapper actions", async (t) => {
  const h = prompt(t);
  h.send(PASTE_START, ESC, "\r", "\t", "\u0003", "x", PASTE_END);
  assert.equal(h.results.length, 0);
  assert.equal(h.component.editor.getExpandedText(), "\n    x");
  assert.equal(h.component.focus, "text");
  h.send("\r");
  assert.deepEqual(await h.pending, answered("\n    x"));
});

test("ask_user sends paste-end tails through submit, focus, and cancellation policies", async (t) => {
  const submit = prompt(t);
  submit.send(PASTE_START, "answer", `${PASTE_END}\r`);
  assert.deepEqual(await submit.pending, answered("answer"));

  const focus = prompt(t, { prompt: "Choose", options });
  focus.send("\t", PASTE_START, "note", `${PASTE_END}\t`);
  assert.equal(focus.results.length, 0);
  assert.equal(focus.component.focus, "options");
  assert.equal(focus.component.editor.focused, false);
  assert.equal(focus.component.editor.getExpandedText(), "note");

  const cancel = prompt(t);
  cancel.send(PASTE_START, "retained", `${PASTE_END}${ESC}`);
  assert.deepEqual(await cancel.pending, askUserCancelled());
  assert.equal(cancel.component.editor.getExpandedText(), "retained");
});

test("ask_user detects every split paste-end boundary and routes its tail", async (t) => {
  for (let index = 1; index < PASTE_END.length; index++) {
    const h = prompt(t);
    h.send(PASTE_START, "answer", PASTE_END.slice(0, index));
    assert.equal(h.results.length, 0);
    h.send(`${PASTE_END.slice(index)}\r`);
    assert.deepEqual(await h.pending, answered("answer"));
  }
  const h = prompt(t);
  h.send(PASTE_START, "ab", ESC, "[", "2", "0", "1", "~\r");
  assert.deepEqual(await h.pending, answered("ab"));
});

test("ask_user discards option-focus paste and controls without changing focus or selection", async (t) => {
  const h = prompt(t, { prompt: "Choose", options, multiple: true });
  h.send(" ", PASTE_START, "\r", "\t", ESC, "\u0003", " ", "text", `${ESC}[20`, "1~");
  assert.equal(h.results.length, 0);
  assert.equal(h.component.focus, "options");
  assert.equal(h.component.optionIndex, 0);
  assert.deepEqual([...h.component.selected], ["first"]);
  assert.equal(h.component.editor.getExpandedText(), "");
  h.send(PASTE_START, "discarded", `${PASTE_END}\t`);
  assert.equal(h.component.focus, "text");
  assert.equal(h.component.editor.getExpandedText(), "");
  h.send("\r");
  assert.deepEqual(await h.pending, { ok: true, status: "answered", selected_ids: ["first"] });
});

test("ask_user retains a rejected blank buffer and cursor, then clears feedback on change", async (t) => {
  const h = prompt(t);
  h.send("  ");
  const cursor = h.component.editor.getCursor();
  h.send("\r");
  assert.equal(h.results.length, 0);
  assert.equal(h.component.feedback, "Enter a nonblank answer.");
  assert.equal(h.component.editor.getExpandedText(), "  ");
  assert.deepEqual(h.component.editor.getCursor(), cursor);
  h.send("x");
  assert.equal(h.component.feedback, undefined);
  h.send("\r");
  assert.deepEqual(await h.pending, answered("  x"));
});

test("ask_user validates expanded large paste and retains selections and cursor on failure", async (t) => {
  for (const input of [{ prompt: "Explain" }, { prompt: "Choose", options, multiple: true }]) {
    const h = prompt(t, input);
    if (input.options) h.send(" ", "\t");
    h.send(PASTE_START, "x".repeat(16_385), PASTE_END);
    assert.match(h.component.editor.getText(), /\[paste #1 /);
    assert.equal(h.component.editor.getExpandedText(), "x".repeat(16_385));
    const cursor = h.component.editor.getCursor();
    const selected = [...h.component.selected];
    h.send("\r");
    assert.equal(h.results.length, 0);
    assert.equal(h.component.feedback, "Keep the answer within 16384 code points.");
    assert.equal(h.component.editor.getExpandedText(), "x".repeat(16_385));
    assert.deepEqual(h.component.editor.getCursor(), cursor);
    assert.deepEqual([...h.component.selected], selected);
    h.send("\u007f", "replacement", "\r");
    assert.deepEqual(await h.pending, { ...answered("replacement"), selected_ids: selected });
  }
  const h = prompt(t);
  h.send(PASTE_START, "😀".repeat(16_384), PASTE_END, "\r");
  assert.deepEqual(await h.pending, answered("😀".repeat(16_384)));
});

test("ask_user selects single options with Space or confirm and prioritizes IDs over text", async (t) => {
  for (const key of [" ", "\r"]) {
    const h = prompt(t, { prompt: "Choose", options });
    h.send("\t", "ignored", "\t", `${ESC}[B`, key);
    assert.deepEqual(await h.pending, { ok: true, status: "answered", selected_ids: ["second"] });
    assert.equal(h.component.editor.getExpandedText(), "ignored");
  }
});

test("ask_user preserves ordered multiple IDs and text over Tab cycles", async (t) => {
  const h = prompt(t, { prompt: "Choose", options, multiple: true });
  h.send(`${ESC}[B`, " ", `${ESC}[A`, " ", "\t", " note ", "\t");
  assert.equal(h.component.editor.getExpandedText(), " note ");
  assert.deepEqual([...h.component.selected], ["second", "first"]);
  h.send("\t", "\t", "\r");
  assert.deepEqual(await h.pending, { ok: true, status: "answered", selected_ids: ["first", "second"], text: " note " });
});

test("ask_user consumes Tab when other answers are disabled and ignores option text", async (t) => {
  const h = prompt(t, { prompt: "Choose", options, multiple: true, allow_other: false });
  h.send("\t", "ignored", "\r");
  assert.equal(h.results.length, 0);
  assert.equal(h.component.focus, "options");
  assert.equal(h.component.feedback, "Select at least one option.");
  assert.equal(h.component.editor.getExpandedText(), "");
  assert.equal(h.component.render(200).some((line) => line.includes("Other answer:")), false);
  assert.equal(h.component.render(200).at(-1).includes("switch"), false);
  h.send(" ", " ");
  assert.equal(h.component.selected.size, 0);
  h.send(`${ESC}[B`, " ", "\r");
  assert.deepEqual(await h.pending, { ok: true, status: "answered", selected_ids: ["second"] });
});

test("ask_user keeps text arrows in the editor and renders placeholder as a hint only", async (t) => {
  const h = prompt(t, { prompt: "Choose", options, placeholder: "Hint only" });
  assert.ok(h.component.render(80).some((line) => line.includes("Hint only")));
  h.send("\t", "\r");
  assert.equal(h.component.editor.getExpandedText(), "");
  assert.equal(h.results.length, 0);
  h.send("first", "\n", "second");
  h.component.render(80);
  const renders = h.renderRequests;
  h.send(`${ESC}[A`);
  assert.equal(h.component.editor.getCursor().line, 0);
  assert.equal(h.component.optionIndex, 0);
  assert.ok(h.renderRequests > renders);
  h.send(`${ESC}[B`);
  assert.equal(h.component.editor.getCursor().line, 1);
  assert.equal(h.component.optionIndex, 0);
  assert.equal(h.component.render(80).some((line) => line.includes("Hint only")), false);
  h.send("\r");
  assert.deepEqual(await h.pending, answered("first\nsecond"));
});

test("ask_user uses remapped submit, newline, and Tab actions", async (t) => {
  const h = prompt(t, { prompt: "Choose", options }, {
    "tui.input.submit": "ctrl+enter",
    "tui.input.newLine": "ctrl+n",
    "tui.input.tab": "ctrl+t",
  });
  h.send("\u0014", "first", "\r");
  assert.equal(h.results.length, 0);
  assert.equal(h.component.editor.getExpandedText(), "first");
  h.send("\u000e", "second", "\u0014");
  assert.equal(h.component.focus, "options");
  h.send("\u0014", `${ESC}[13;5u`);
  assert.deepEqual(await h.pending, answered("first\nsecond"));
  const unconfigured = prompt(t);
  unconfigured.send("answer", `${ESC}[13;5u`);
  assert.equal(unconfigured.results.length, 0);
  assert.equal(unconfigured.component.editor.getExpandedText(), "answer");
});

test("ask_user uses remapped selection actions and a separate resolver submit", async (t) => {
  const bindings = {
    "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+f",
    "tui.input.submit": "ctrl+s", "tui.select.cancel": "ctrl+x",
  };
  const select = prompt(t, { prompt: "Choose", options, allow_other: false }, bindings);
  select.send(`${ESC}[B`, "\r");
  assert.equal(select.component.optionIndex, 0);
  assert.equal(select.results.length, 0);
  select.send("\u000e", "\u0010", "\u000e", "\u0006");
  assert.deepEqual(await select.pending, { ok: true, status: "answered", selected_ids: ["second"] });
  const submit = prompt(t, { prompt: "Choose", options, multiple: true }, bindings);
  submit.send(" ", "\u0013");
  assert.deepEqual(await submit.pending, { ok: true, status: "answered", selected_ids: ["first"] });
  const invalid = prompt(t, { prompt: "Choose", options, allow_other: false }, bindings);
  invalid.send("\u0013");
  assert.equal(invalid.results.length, 0);
  assert.equal(invalid.component.feedback, "Select one option.");
  invalid.send("\u0018");
  assert.deepEqual(await invalid.pending, askUserCancelled());
});

test("ask_user protects text copy collisions without testing copy implementation", (t) => {
  for (const bindings of [
    {},
    { "tui.input.copy": "ctrl+x", "tui.select.cancel": "ctrl+x", "tui.input.submit": "ctrl+x", "tui.input.newLine": "ctrl+x", "tui.input.tab": "ctrl+x" },
  ]) {
    const h = prompt(t, { prompt: "Choose", options });
    h.send("\t");
    h.keybindings.setUserBindings(bindings);
    h.send("retained");
    const cursor = h.component.editor.getCursor();
    h.send(bindings["tui.input.copy"] ? "\u0018" : "\u0003");
    assert.equal(h.results.length, 0);
    assert.equal(h.component.focus, "text");
    assert.equal(h.component.editor.getExpandedText(), "retained");
    assert.deepEqual(h.component.editor.getCursor(), cursor);
  }
});

test("ask_user uses newline, submit, and Tab precedence over text cancel", async (t) => {
  const newline = prompt(t, { prompt: "Explain" }, {
    "tui.input.newLine": "ctrl+x", "tui.input.submit": "ctrl+x", "tui.select.cancel": "ctrl+x",
  });
  newline.send("first", "\u0018", "second");
  assert.equal(newline.results.length, 0);
  assert.equal(newline.component.editor.getExpandedText(), "first\nsecond");
  const submit = prompt(t, { prompt: "Explain" }, { "tui.input.submit": "ctrl+x", "tui.select.cancel": "ctrl+x" });
  submit.send("answer", "\u0018");
  assert.deepEqual(await submit.pending, answered("answer"));
  const switcher = prompt(t, { prompt: "Choose", options }, { "tui.input.tab": "ctrl+t", "tui.select.cancel": "ctrl+x" });
  switcher.send("\u0014");
  switcher.keybindings.setUserBindings({ "tui.input.tab": "ctrl+x", "tui.select.cancel": "ctrl+x" });
  switcher.send("\u0018");
  assert.equal(switcher.results.length, 0);
  assert.equal(switcher.component.focus, "options");
});

test("ask_user uses exact option action precedence", async (t) => {
  const cancel = prompt(t, { prompt: "Choose", options }, {
    "tui.select.cancel": "ctrl+x", "tui.input.tab": "ctrl+x", "tui.select.up": "ctrl+x",
    "tui.select.down": "ctrl+x", "tui.select.confirm": "ctrl+x", "tui.input.submit": "ctrl+x",
  });
  cancel.send("\u0018");
  assert.deepEqual(await cancel.pending, askUserCancelled());
  const tab = prompt(t, { prompt: "Choose", options }, {
    "tui.input.tab": "ctrl+t", "tui.select.down": "ctrl+t", "tui.select.confirm": "ctrl+t", "tui.input.submit": "ctrl+t",
  });
  tab.send("\u0014");
  assert.equal(tab.component.focus, "text");
  assert.equal(tab.component.optionIndex, 0);
  assert.equal(tab.results.length, 0);
  const up = prompt(t, { prompt: "Choose", options, multiple: true }, { "tui.select.up": "ctrl+x", "tui.select.down": ["down", "ctrl+x"], "tui.select.confirm": "ctrl+x", "tui.input.submit": "ctrl+x" });
  up.send(`${ESC}[B`, "\u0018");
  assert.equal(up.component.optionIndex, 0);
  assert.equal(up.results.length, 0);
  const space = prompt(t, { prompt: "Choose", options, multiple: true }, { "tui.select.confirm": "space", "tui.input.submit": "space" });
  space.send(" ");
  assert.deepEqual([...space.component.selected], ["first"]);
  assert.equal(space.results.length, 0);
  const confirm = prompt(t, { prompt: "Choose", options }, { "tui.select.confirm": "ctrl+x", "tui.input.submit": "ctrl+x" });
  confirm.send("\u0018");
  assert.deepEqual(await confirm.pending, { ok: true, status: "answered", selected_ids: ["first"] });
});

test("ask_user cancels only through selection cancel, with default focus-specific Ctrl+C", async (t) => {
  for (const input of [{ prompt: "Explain" }, { prompt: "Choose", options }]) {
    const h = prompt(t, input);
    h.send(ESC);
    assert.deepEqual(await h.pending, askUserCancelled());
  }
  const h = prompt(t, { prompt: "Choose", options });
  h.send("\u0003");
  assert.deepEqual(await h.pending, askUserCancelled());
  for (const input of [{ prompt: "Explain" }, { prompt: "Choose", options }]) {
    const remap = prompt(t, input, { "app.interrupt": "ctrl+x", "tui.select.cancel": "ctrl+q" });
    remap.send("\u0018");
    assert.equal(remap.results.length, 0);
    remap.send("\u0011");
    assert.deepEqual(await remap.pending, askUserCancelled());
  }
  const noFallback = prompt(t, { prompt: "Explain" }, { "tui.input.copy": "escape", "tui.select.cancel": "escape" });
  noFallback.send("retained", ESC);
  assert.equal(noFallback.results.length, 0);
  assert.equal(noFallback.component.editor.getExpandedText(), "retained");
});

test("ask_user footer shows configured, unbound, and filtered cancellation keys", (t) => {
  const h = prompt(t, { prompt: "Choose", options }, {
    "tui.input.submit": "ctrl+s", "tui.input.newLine": [], "tui.input.tab": "ctrl+t",
    "tui.select.up": "ctrl+p", "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+f",
    "tui.select.cancel": ["ctrl+c", "ctrl+s", "ctrl+t", "escape"],
  });
  const optionFooter = h.component.render(300).at(-1);
  assert.match(optionFooter, /ctrl\+p\/ctrl\+n move/);
  assert.match(optionFooter, /space select/);
  assert.match(optionFooter, /ctrl\+f select/);
  assert.match(optionFooter, /ctrl\+c\/ctrl\+s\/ctrl\+t\/escape cancel/);
  const bindings = h.keybindings.getUserBindings();
  h.keybindings.setUserBindings({ ...bindings, "tui.select.cancel": ["ctrl+c", "ctrl+s", "escape"] });
  h.send("\u0014");
  h.keybindings.setUserBindings(bindings);
  const textFooter = h.component.render(300).at(-1);
  assert.match(textFooter, /ctrl\+s submit/);
  assert.match(textFooter, /unbound newline/);
  assert.match(textFooter, /ctrl\+t switch/);
  assert.match(textFooter, /escape cancel/);
  assert.equal(textFooter.includes("ctrl+enter"), false);
  assert.equal(textFooter.includes("copy"), false);
  assert.equal(textFooter.includes("ctrl+c"), false);
  h.keybindings.setUserBindings({ "tui.select.cancel": "return" });
  assert.match(h.component.render(300).at(-1), /unbound cancel/);
});

test("ask_user propagates wrapper and internal focus to the child cursor marker", (t) => {
  const text = prompt(t);
  assert.equal(text.component.editor.focused, true);
  text.send("abc");
  assert.equal(markerCount(text.component.render(40)), 1);
  text.component.focused = false;
  assert.equal(text.component.editor.focused, false);
  assert.equal(markerCount(text.component.render(40)), 0);
  text.component.focused = true;
  assert.equal(markerCount(text.component.render(40)), 1);

  const h = prompt(t, { prompt: "Choose", options, multiple: true });
  assert.equal(h.component.editor.focused, false);
  assert.equal(markerCount(h.component.render(40)), 0);
  h.send(" ", "\t", "abc");
  assert.equal(h.component.editor.focused, true);
  assert.equal(markerCount(h.component.render(40)), 1);
  h.send("\t");
  assert.equal(h.component.editor.focused, false);
  assert.equal(markerCount(h.component.render(40)), 0);
  h.component.focused = false;
  h.send("\t");
  assert.equal(h.component.editor.focused, false);
  assert.equal(h.component.editor.getExpandedText(), "abc");
  assert.deepEqual([...h.component.selected], ["first"]);
  h.component.focused = true;
  assert.equal(h.component.editor.focused, true);
  assert.equal(markerCount(h.component.render(40)), 1);
});

test("ask_user guards narrow editor rendering across resize and invalidation", (t) => {
  for (const text of ["abc", "界😀e\u0301", "first\n界😀\nlast", "x\n".repeat(100)]) {
    const h = prompt(t, { prompt: "界😀 question", options, placeholder: "界😀 hint" });
    h.send("\t", PASTE_START, text, PASTE_END);
    const expanded = h.component.editor.getExpandedText();
    const cursor = h.component.editor.getCursor();
    const originalInvalidate = h.component.editor.invalidate.bind(h.component.editor);
    let invalidations = 0;
    h.component.editor.invalidate = () => { invalidations++; originalInvalidate(); };
    for (const width of [1, 2, 3, 8, 40, 8, 1]) {
      h.tui.terminal.rows = width < 3 ? 12 : 40;
      h.component.invalidate();
      const lines = h.component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), JSON.stringify({ width, lines }));
      assert.ok(markerCount(lines) <= 1);
      if (width >= 3) assert.equal(markerCount(lines), 1);
      assert.equal(h.component.editor.getExpandedText(), expanded);
      assert.deepEqual(h.component.editor.getCursor(), cursor);
    }
    assert.equal(invalidations, 7);
  }
});

test("ask_user rejects concurrent prompts and creates a fresh editor after cleanup", async (t) => {
  const state = {};
  const first = prompt(t, { prompt: "First?" }, {}, { state });
  const second = await executeAskUser({ prompt: "Second?" }, first.context, undefined, state);
  assert.deepEqual(second, { ok: false, error: { code: "PROMPT_ACTIVE", message: "This session already has an active ask_user prompt." } });
  assert.equal(first.customCalls, 1);
  first.send("answer", "\r");
  assert.deepEqual(await first.pending, answered("answer"));
  assert.equal(state.active, undefined);
  const next = prompt(t, { prompt: "Next?" }, {}, { state });
  assert.notEqual(next.component.editor, first.component.editor);
  assert.equal(next.component.editor.getExpandedText(), "");
  next.send(ESC);
  assert.deepEqual(await next.pending, askUserCancelled());
  assert.equal(state.active, undefined);
});

test("ask_user rejects pre-abort and keeps validation and concurrency guard order", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const state = {};
  let calls = 0;
  const ctx = createContext(() => { calls++; });
  assert.deepEqual(await executeAskUser({ prompt: "Continue?" }, ctx, controller.signal, state), invocationCancelled);
  assert.equal(calls, 0);
  assert.equal(state.active, undefined);
  const active = prompt(t, { prompt: "First?" }, {}, { state });
  const result = await executeAskUser({ prompt: "Second?" }, ctx, controller.signal, state);
  assert.equal(result.error.code, "PROMPT_ACTIVE");
  assert.equal(calls, 0);
  active.send(ESC);
  await active.pending;
});

test("ask_user uses the editor-backed factory when abort occurs before factory entry", async () => {
  const controller = new AbortController();
  const state = {};
  let factory;
  let done;
  const pending = executeAskUser({ prompt: "Continue?" }, createContext((value) => new Promise((resolve) => {
    factory = value;
    done = resolve;
  })), controller.signal, state);
  controller.abort();
  const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keybindings, done);
  assert.ok(component.editor instanceof Editor);
  assert.equal(component.editor.disableSubmit, true);
  assert.equal(typeof component.editor.onChange, "function");
  assert.deepEqual(await pending, invocationCancelled);
  assert.equal(state.active, undefined);
});

test("ask_user settles once on mid-prompt abort or answer and removes abort listeners", async (t) => {
  for (const abortFirst of [true, false]) {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { added++; add(...args); };
    controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
    const h = prompt(t, { prompt: "Continue?" }, {}, { signal: controller.signal });
    if (abortFirst) controller.abort();
    h.send("answer", "\r", ESC);
    if (!abortFirst) controller.abort();
    assert.deepEqual(await h.pending, abortFirst ? invocationCancelled : answered("answer"));
    assert.equal(h.results.length, 1);
    assert.equal(h.state.active, undefined);
    assert.equal(added, 1);
    assert.equal(removed, 1);
  }
});

test("ask_user clears active state when custom fails", async () => {
  const state = {};
  const result = await executeAskUser({ prompt: "Continue?" }, createContext(() => { throw new Error("unavailable"); }), undefined, state);
  assert.deepEqual(result, { ok: false, error: { code: "UI_UNAVAILABLE", message: "The interactive prompt is unavailable." } });
  assert.equal(state.active, undefined);
  const controller = new AbortController();
  const cancelled = await executeAskUser({ prompt: "Continue?" }, createContext(() => {
    controller.abort();
    throw new Error("cancelled");
  }), controller.signal, state);
  assert.deepEqual(cancelled, invocationCancelled);
  assert.equal(state.active, undefined);
});

test("ask_user keeps guidance and result envelopes and cancels on session shutdown", async () => {
  let tool;
  let shutdown;
  registerAskUserTool({
    registerTool(value) { tool = value; },
    on(event, handler) { if (event === "session_shutdown") shutdown = handler; },
  });
  assert.equal(tool.name, "ask_user");
  assert.deepEqual(tool.promptGuidelines, [
    "Use ask_user only when required information or a decision cannot be safely inferred.",
    "Do not use ask_user to request passwords, access tokens, or other secrets.",
  ]);
  let component;
  const context = createContext((factory) => new Promise((resolve) => {
    component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, keybindings, resolve);
  }));
  const pending = tool.execute("tool-call", { prompt: "Continue?" }, undefined, undefined, context);
  shutdown({}, {});
  component.handleInput("answer");
  component.handleInput("\r");
  shutdown({}, {});
  const toolResult = await pending;
  assert.deepEqual(JSON.parse(toolResult.content[0].text), { ...invocationCancelled, tool: "ask_user" });
  assert.deepEqual(toolResult.details, { ...invocationCancelled, tool: "ask_user" });

  const next = tool.execute("next-call", { prompt: "Next?" }, undefined, undefined, context);
  component.handleInput("  exact");
  component.handleInput("\n");
  component.handleInput("text  ");
  component.handleInput("\r");
  const answer = await next;
  assert.deepEqual(answer.details, { ...answered("  exact\ntext  "), tool: "ask_user" });
  assert.deepEqual(JSON.parse(answer.content[0].text), answer.details);
  assert.equal(createAskUserTool().name, "ask_user");
});
