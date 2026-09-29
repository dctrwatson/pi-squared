import test from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const gitModule = await import("../../extensions/agent-tools/git.ts");
const ghModule = await import("../../extensions/agent-tools/gh.ts");

const plainTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

for (const [name, createTool] of [
  ["git", gitModule.createAgentGitTool],
  ["gh", ghModule.createAgentGhTool],
]) {
  test(`${name} renders a clear and safe direct-process invocation`, () => {
    const tool = createTool();
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");

    const call = tool.renderCall(
      {
        args: ["pr", "create", "--title", "Ready for review", "bad\u001bargument"],
        cwd: "work\u001bdirectory",
        stdin: "body\u009d52;clipboard",
        timeout_seconds: "1\u009d",
      },
      plainTheme,
      {},
    ).render(200).join("\n");
    assert.match(call, new RegExp(`^\\$ ${name} pr create --title "Ready for review"`));
    assert.match(call, /cwd work\\u001bdirectory/);
    assert.match(call, /stdin body\\u009d52;clipboard/);
    assert.match(call, /timeout 1\\u009ds/);
    assert.doesNotMatch(call, /[\u001b\u009d]/);

    const truncated = tool.renderCall(
      { args: ["pr", "create", "--title", "A title that does not fit the tool row"] },
      plainTheme,
      {},
    ).render(24);
    assert.equal(truncated.length, 1);
    assert.equal(visibleWidth(truncated[0]), 24);
    assert.match(stripTerminalSequences(truncated[0]).trimEnd(), /\.\.\.$/);

    const failure = tool.renderResult(
      {
        content: [{ type: "text", text: `[${name}: exit_code=7; signal=none; timed_out=false; duration_ms=1]` }],
        details: { ok: true, exit_code: 7, signal: null, timed_out: false },
      },
      { expanded: true, isPartial: false },
      { fg: (color, text) => `${color}:${text}`, bold: (text) => text },
      { isError: false },
    ).render(200).join("\n");
    assert.match(failure, /^error:/);

    const result = tool.renderResult(
      { content: [{ type: "text", text: "safe\u001b]52;clipboard\u0007\u009b31m" }], details: undefined },
      { expanded: true, isPartial: false },
      plainTheme,
      { isError: false },
    ).render(200).join("\n");
    assert.doesNotMatch(result, /[\u0007\u001b\u009b]/);
    assert.match(result, /\\u001b/);
  });
}

test("git and gh share one named process-status guideline", () => {
  const git = gitModule.createAgentGitTool();
  const gh = ghModule.createAgentGhTool();
  const shared = "With git or gh, check exit_code, signal, timed_out, and capture state before use. Read artifacts before rerunning when output is omitted.";

  assert.equal(git.promptGuidelines[0], shared);
  assert.equal(gh.promptGuidelines[0], shared);
  assert.match(git.promptGuidelines.slice(1).join("\n"), /\bgit\b/);
  assert.match(gh.promptGuidelines.slice(1).join("\n"), /\bgh\b/);
});

test("git renders status 1 without an error color only for normal boolean results", () => {
  const tool = gitModule.createAgentGitTool();
  const renderResult = (content) => tool.renderResult(
    {
      content,
      details: { ok: true, exit_code: 1, signal: null, timed_out: false },
    },
    { expanded: true, isPartial: false },
    { fg: (color, text) => `${color}:${text}`, bold: (text) => text },
    { isError: false },
  ).render(200).join("\n");

  assert.match(renderResult([
    { type: "text", text: "[git: exit_code=1; signal=none; timed_out=false; duration_ms=1]" },
  ]), /^toolOutput:/);
  assert.match(renderResult([
    { type: "text", text: "[git: exit_code=1; signal=none; timed_out=false; duration_ms=1]" },
    { type: "text", text: "[stderr: capture=complete; preview=complete]\nfatal: bad revision" },
  ]), /^error:/);
});

test("git and gh keep partial wrapper failures marked as errors", () => {
  const details = {
    ok: false,
    error: { code: "OUTPUT_LIMIT", message: "limit" },
    process: { exit_code: 1, signal: null, timed_out: false, stop_reason: "output_limit", cleanup: "complete" },
  };
  const content = [{ type: "text", text: "[git error: OUTPUT_LIMIT; limit]\n[git: exit_code=1]" }];
  assert.equal(gitModule.gitExitIsExpected(details, content), false);
  for (const create of [gitModule.createAgentGitTool, ghModule.createAgentGhTool]) {
    const rendered = create().renderResult({ details, content }, { expanded: true, isPartial: false }, {
      fg: (color, text) => `${color}:${text}`, bold: (text) => text,
    }, { isError: false }).render(200).join("\n");
    assert.match(rendered, /^error:/);
  }
});

test("process call renderers show the whole-result output budget safely", async () => {
  const { createAgentBashTool } = await import("../../extensions/agent-tools/bash.ts");
  for (const create of [createAgentBashTool, gitModule.createAgentGitTool, ghModule.createAgentGhTool]) {
    const tool = create();
    const required = tool.name === "bash" ? { command: "true" } : { args: ["--version"] };
    const render = (max_output_bytes) => tool.renderCall({ ...required, max_output_bytes }, plainTheme, {
      isPartial: false, isError: false,
    }).render(300).join("\n");
    assert.match(render(8192), /\(output 8192 bytes\)/);
    assert.match(render("2048\u001b"), /output 2048\\u001b bytes/);
    assert.doesNotMatch(render("2048\u001b"), /\u001b/);
  }
});
