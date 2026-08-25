import test from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const gitModule = await import("../../extensions/codex-tools/git.ts");
const ghModule = await import("../../extensions/codex-tools/gh.ts");

const plainTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

for (const [name, createTool] of [
  ["git", gitModule.createCodexGitTool],
  ["gh", ghModule.createCodexGhTool],
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
        content: [{ type: "text", text: `[${name}: exit_code=1; signal=none; timed_out=false; duration_ms=1]` }],
        details: { ok: true, exit_code: 1, signal: null, timed_out: false },
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
