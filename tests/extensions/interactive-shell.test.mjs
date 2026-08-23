import test from "node:test";
import assert from "node:assert/strict";

import interactiveShell from "../../extensions/interactive-shell.ts";

function setup(options = {}) {
  let handler;
  interactiveShell({
    on(event, registered) {
      assert.equal(event, "user_bash");
      handler = registered;
    },
  }, options);
  return handler;
}

function tuiContext(events) {
  return {
    mode: "tui",
    ui: {
      async custom(factory) {
        let completed;
        const component = factory({
          stop() { events.push("stop"); },
          start() { events.push("start"); },
          requestRender(force) { events.push(`render:${force}`); },
        }, {}, {}, (value) => { completed = value; });
        assert.deepEqual(component.render(), []);
        return completed;
      },
    },
  };
}

test("plain ! commands keep Pi's normal captured-output handling", async () => {
  let spawned = false;
  const handler = setup({
    spawn() {
      spawned = true;
      return { status: 0, signal: null };
    },
  });

  const result = await handler({
    command: "printf normal",
    excludeFromContext: false,
    cwd: "/tmp",
  }, tuiContext([]));

  assert.equal(result, undefined);
  assert.equal(spawned, false);
});

test("!! commands suspend and restore the TUI around inherited shell execution", async () => {
  const events = [];
  let invocation;
  const handler = setup({
    spawn(command, args, options) {
      invocation = { command, args, options };
      events.push("spawn");
      return { status: 0, signal: null };
    },
    writeTerminal(text) {
      events.push(`write:${JSON.stringify(text)}`);
    },
  });

  const result = await handler({
    command: "vim README.md",
    excludeFromContext: true,
    cwd: "/worktree",
  }, tuiContext(events));

  assert.equal(invocation.command, process.env.SHELL || "/bin/sh");
  assert.deepEqual(invocation.args, ["-c", "vim README.md"]);
  assert.equal(invocation.options.cwd, "/worktree");
  assert.equal(invocation.options.env, process.env);
  assert.equal(invocation.options.stdio, "inherit");
  assert.deepEqual(events, [
    "stop",
    'write:"\\u001b[2J\\u001b[H"',
    "spawn",
    "start",
    "render:true",
  ]);
  assert.deepEqual(result, {
    result: {
      output: "(suspended command completed successfully)",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    },
  });
});

test("suspended command failures still restore the TUI", async () => {
  const events = [];
  const handler = setup({
    spawn() {
      events.push("spawn");
      throw new Error("could not launch shell");
    },
    writeTerminal() {},
  });

  const result = await handler({
    command: "broken-command",
    excludeFromContext: true,
    cwd: "/tmp",
  }, tuiContext(events));

  assert.deepEqual(events, ["stop", "spawn", "start", "render:true"]);
  assert.deepEqual(result, {
    result: {
      output: "(suspended command failed: could not launch shell)",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
});

test("!! commands fall back to normal handling outside TUI mode", async () => {
  const handler = setup();
  const result = await handler({
    command: "echo rpc",
    excludeFromContext: true,
    cwd: "/tmp",
  }, { mode: "rpc", ui: {} });

  assert.equal(result, undefined);
});
