import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import test from "node:test";

const {
  default: bashToolInterceptor,
  interceptorGuidance,
  withInterceptorBins,
} = await import("../../extensions/bash-tool-interceptor/index.ts");
const { BASH_COMMAND_INTERCEPTORS } = await import("../../extensions/bash-tool-interceptor/interceptors/index.ts");
const {
  FD_SYSTEM_PROMPT_GUIDANCE,
  FIND_INTERCEPTOR_BIN_DIR,
} = await import("../../extensions/bash-tool-interceptor/interceptors/find.ts");
const {
  INTERCEPTED_PYTHON_COMMANDS,
  PYTHON_INTERCEPTOR_BIN_DIR,
  UV_SYSTEM_PROMPT_GUIDANCE,
} = await import("../../extensions/bash-tool-interceptor/interceptors/python.ts");

const exampleInterceptors = [
  { name: "first", binDir: "/first/bin", systemPromptGuidance: "First policy guidance." },
  { name: "second", binDir: "/second/bin", systemPromptGuidance: "Second policy guidance." },
];

test("composes registered interceptor bins and guidance", () => {
  const result = withInterceptorBins({
    PATH: ["/usr/bin", "/second/bin", "/first/bin", "/custom/bin"].join(delimiter),
    KEEP_ME: "yes",
  }, exampleInterceptors);

  assert.equal(result.PATH, ["/first/bin", "/second/bin", "/usr/bin", "/custom/bin"].join(delimiter));
  assert.equal(result.KEEP_ME, "yes");
  assert.equal(interceptorGuidance(exampleInterceptors), "First policy guidance.\nSecond policy guidance.");

  const caseInsensitive = withInterceptorBins({ Path: "/usr/local/bin" }, exampleInterceptors);
  assert.equal(caseInsensitive.Path, ["/first/bin", "/second/bin", "/usr/local/bin"].join(delimiter));
  assert.equal(caseInsensitive.PATH, undefined);
  assert.deepEqual(BASH_COMMAND_INTERCEPTORS.map((interceptor) => interceptor.name), ["python", "find"]);
});

test("Python command wrappers give uv steering guidance", () => {
  for (const command of INTERCEPTED_PYTHON_COMMANDS) {
    const result = spawnSync(join(PYTHON_INTERCEPTOR_BIN_DIR, command), ["--version"], { encoding: "utf8" });

    assert.equal(result.status, 1, command);
    assert.doesNotMatch(result.stderr, /bash-tool-interceptor/);
    assert.match(result.stderr, /Use uv for Python work/);
    assert.match(result.stderr, /Do not mechanically substitute/);
  }
});

test("find wrapper gives fd steering guidance", () => {
  const result = spawnSync(join(FIND_INTERCEPTOR_BIN_DIR, "find"), [".", "-type", "f"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /bash-tool-interceptor/);
  assert.match(result.stderr, /Use fd for file discovery/);
  assert.match(result.stderr, /Do not mechanically substitute find syntax/);
});

test("registers a model Bash override with composed guidance", async () => {
  const handlers = new Map();
  const tools = [];
  bashToolInterceptor({
    on: (event, handler) => handlers.set(event, handler),
    registerTool: (tool) => tools.push(tool),
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "bash");
  assert.match(tools[0].promptSnippet, /Execute bash commands/);
  assert.equal(handlers.has("tool_call"), false);

  assert.equal(handlers.has("before_agent_start"), false);
  assert.ok(tools[0].promptGuidelines.some((guideline) => /Use `uv`/.test(guideline)));
  assert.ok(tools[0].promptGuidelines.some((guideline) => /Use `fd`/.test(guideline)));
  assert.match(UV_SYSTEM_PROMPT_GUIDANCE, /Use `uv` for all Python work/);
  assert.match(FD_SYSTEM_PROMPT_GUIDANCE, /Prefer Pi's built-in `find` tool/);

  const toolContext = {
    model: undefined,
    thinkingLevel: "off",
    sessionManager: {
      getSessionId: () => "interceptor-test-session",
      getSessionFile: () => undefined,
    },
  };
  await assert.rejects(
    tools[0].execute("interceptor-test", { command: "python --version" }, undefined, undefined, toolContext),
    /Use uv for Python work/,
  );
  await assert.rejects(
    tools[0].execute("interceptor-test", { command: "find . -type f" }, undefined, undefined, toolContext),
    /Use fd for file discovery/,
  );
});
