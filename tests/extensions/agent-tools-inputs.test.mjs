import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createAgentReadTool } from "../../extensions/agent-tools/read.ts";
import { createAgentBashTool, normalizeInput as normalizeBashInput } from "../../extensions/agent-tools/bash.ts";
import { BashProcessOwner } from "../../extensions/agent-tools/bash-process.ts";
import { BashJobRegistry } from "../../extensions/agent-tools/bash-jobs.ts";
import { createAgentBashJobTool } from "../../extensions/agent-tools/bash-job.ts";
import { createAgentGitTool } from "../../extensions/agent-tools/git.ts";
import { createAgentGhTool } from "../../extensions/agent-tools/gh.ts";
import { createAgentFindTool, createAgentGrepTool } from "../../extensions/agent-tools/search.ts";
import { createAgentWebSearchTool } from "../../extensions/agent-tools/web-search.ts";
import { createAskUserTool, normalizeAskUserInput } from "../../extensions/agent-tools/ask-user.ts";
import { omitNullOptionalFields } from "../../extensions/agent-tools/optional-input.ts";

function context(cwd) {
  return {
    cwd,
    mode: "print",
    model: {
      provider: "openai-codex",
      id: "test-model",
      api: "openai-codex-responses",
      compat: { supportsAdditionalTools: true },
    },
    thinkingLevel: "off",
    sessionManager: { getSessionId: () => "input-test", getSessionFile: () => undefined },
    ui: { custom: () => { throw new Error("The input test must not open a UI"); } },
    modelRegistry: {
      getAvailable: () => [],
      complete: async (_model, request) => ({
        provider: "openai-codex",
        model: "test-model",
        content: [{ type: "text", text: request.messages[0].content[0].text }],
        stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }),
    },
  };
}

async function withDirectory(callback) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-agent-input-test-")));
  const artifacts = [];
  const originalPath = process.env.PATH;
  try {
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "source"), "one\ntwo\n");
    for (const name of ["git", "gh"]) {
      const executable = join(directory, name);
      await writeFile(executable, '#!/usr/bin/env bash\nprintf "cwd=%s\\n" "$PWD"\nprintf "arg=<%s>\\n" "$@"\ncat\n');
      await chmod(executable, 0o700);
    }
    const rg = join(directory, "rg");
    await writeFile(rg, "#!/usr/bin/env bash\nexit 1\n");
    await chmod(rg, 0o700);
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
    const onArtifactCreated = (artifact) => artifacts.push(artifact.directory);
    await callback({ directory, rg, onArtifactCreated });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await Promise.all(artifacts.map((path) => rm(path, { recursive: true, force: true })));
    await rm(directory, { recursive: true, force: true });
  }
}

function prepareAndValidate(tool, input) {
  return validateToolArguments(tool, {
    id: "input-test",
    name: tool.name,
    arguments: tool.prepareArguments(input),
  });
}

async function execute(tool, input, directory) {
  return tool.execute("input-test", input, undefined, undefined, context(directory));
}

function comparableResult(result) {
  const copy = structuredClone(result);
  if (copy.details.duration_ms !== undefined) {
    delete copy.details.duration_ms;
    delete copy.details.artifact;
    copy.content[0].text = copy.content[0].text.replace(/duration_ms=\d+/, "duration_ms=0");
  }
  return copy;
}

const option = { id: "first", label: " First " };

function cases({ rg, onArtifactCreated }) {
  return [
    {
      tool: createAgentReadTool(), required: "path", base: { path: "source" },
      fields: [
        ["mode", "lines", "invalid"],
        ["start_line", 1, "10"],
        ["max_lines", 1, "10"],
        ["show_line_numbers", true, 1],
        ["max_bytes", 10, "10"],
        ["start_byte", 0, "10", { path: "source", mode: "bytes" }],
        ["encoding", "base64", "invalid", { path: "source", mode: "bytes" }],
      ],
    },
    {
      tool: createAgentBashTool({ onArtifactCreated }), required: "command", base: { command: "printf ok" },
      fields: [["cwd", "nested", 1], ["timeout_seconds", 1.25, "10"], ["background", false, 1],
        ["max_output_bytes", 2048, "2048"]],
    },
    {
      tool: createAgentBashJobTool(new BashJobRegistry(new BashProcessOwner(), "input-test")),
      required: "job_id", base: { action: "status", job_id: "job_test" },
      fields: [
        ["wait_seconds", 0.125, "1", { action: "wait", job_id: "job_test" }],
        ["stream", "stderr", "invalid", { action: "output", job_id: "job_test" }],
        ["start_byte", 0, "0", { action: "output", job_id: "job_test" }],
        ["max_bytes", 2048, "2048", { action: "output", job_id: "job_test" }],
        ["encoding", "base64", "invalid", { action: "output", job_id: "job_test" }],
      ],
    },
    ...[createAgentGitTool, createAgentGhTool].map((factory) => ({
      tool: factory({ onArtifactCreated }), required: "args", base: { args: [" inspect "] },
      fields: [["cwd", "nested", 1], ["stdin", " exact\ntext ", 1], ["timeout_seconds", 1.25, "10"],
        ["max_output_bytes", 2048, "2048"]],
    })),
    {
      tool: createAgentFindTool({ onArtifactCreated, operations: { exists: () => true, glob: async () => ["source"] } }),
      required: "pattern", base: { pattern: " * " }, fields: [["path", "nested", 1], ["include_ignored", true, 1], ["limit", 10, "10"]],
    },
    {
      tool: createAgentGrepTool({ executable: rg, onArtifactCreated }), required: "pattern", base: { pattern: " target " },
      fields: [["path", "nested", 1], ["glob", " *.ts ", 1], ["ignore_case", true, 1],
        ["literal", true, 1], ["mode", "files", "invalid"], ["include_ignored", true, 1],
        ["context", 10, "10"], ["limit", 10, "10"]],
    },
    { tool: createAgentWebSearchTool(), required: "query", base: { query: " exact query " }, fields: [] },
    {
      tool: createAskUserTool(), required: "prompt", base: { prompt: " exact question " },
      fields: [["options", [option], {}], ["multiple", true, 1, { prompt: "Choose", options: [option] }],
        ["allow_other", false, 1, { prompt: "Choose", options: [option] }], ["placeholder", " exact hint ", 1]],
    },
  ];
}

async function assertInvalid(tool, input, directory) {
  const original = structuredClone(input);
  assert.throws(() => tool.prepareArguments(input), `${tool.name} preparation must reject ${String(input)}`);
  assert.throws(() => prepareAndValidate(tool, input));
  const result = await execute(tool, input, directory);
  assert.equal(result.details.ok, false, JSON.stringify(result));
  assert.equal(result.details.error.code, "INVALID_INPUT", JSON.stringify(result));
  assert.deepEqual(input, original);
}

test("the optional-null helper copies only listed null fields", () => {
  const input = { optional: null, omitted: undefined, required: null, surprise: null };
  const original = structuredClone(input);
  const copied = omitNullOptionalFields(input, ["optional", "omitted"]);
  assert.deepEqual(copied, { omitted: undefined, required: null, surprise: null });
  assert.notEqual(copied, input);
  assert.deepEqual(input, original);
});

test("all optional fields use the same omission defaults without conversion or mutation", async (t) => {
  await withDirectory(async (fixture) => {
    for (const { tool, base, fields, preparationDefaults = {} } of cases(fixture)) {
      assert.deepEqual(new Set(fields.map(([field]) => field)),
        new Set(Object.keys(tool.parameters.properties).filter((field) => !tool.parameters.required.includes(field))));
      for (const [field, valid, invalid, fieldBase = base] of fields) {
        await t.test(`${tool.name}.${field}`, async () => {
          const preparedDefault = prepareAndValidate(tool, fieldBase);
          const executionDefault = comparableResult(await execute(tool, fieldBase, fixture.directory));
          for (const absent of [undefined, null]) {
            const input = { ...structuredClone(fieldBase), [field]: absent };
            const original = structuredClone(input);
            assert.deepEqual(tool.prepareArguments(input), preparedDefault);
            assert.deepEqual(prepareAndValidate(tool, input), preparedDefault);
            assert.deepEqual(comparableResult(await execute(tool, input, fixture.directory)), executionDefault);
            assert.deepEqual(input, original);
          }
          const input = { ...structuredClone(fieldBase), [field]: structuredClone(valid) };
          const original = structuredClone(input);
          const prepared = tool.prepareArguments(input);
          assert.notEqual(prepared, input);
          assert.deepEqual(prepared, { ...preparationDefaults, ...original });
          assert.deepEqual(prepareAndValidate(tool, input), { ...preparationDefaults, ...original });
          const result = await execute(tool, input, fixture.directory);
          assert.notEqual(result.details.error?.code, "INVALID_INPUT", JSON.stringify(result));
          assert.deepEqual(input, original);
          await assertInvalid(tool, { ...fieldBase, [field]: invalid }, fixture.directory);
          for (const badType of [[], {}, true, 1]) {
            if (typeof badType !== typeof valid || (Array.isArray(badType) !== Array.isArray(valid))) {
              await assertInvalid(tool, { ...fieldBase, [field]: badType }, fixture.directory);
            }
          }
        });
      }
    }
  });
});

test("all tools reject invalid required inputs, unknown fields, and invalid raw objects", async (t) => {
  await withDirectory(async (fixture) => {
    for (const { tool, base, required, preparationDefaults = {} } of cases(fixture)) {
      await t.test(tool.name, async () => {
        assert.equal(tool.parameters.additionalProperties, false);
        for (const invalid of [null, undefined, 1, true, {}, []]) {
          await assertInvalid(tool, { ...base, [required]: invalid }, fixture.directory);
        }
        for (const raw of [null, undefined, [], "input", 1, true]) {
          await assertInvalid(tool, raw, fixture.directory);
        }
        for (const unknown of ["surprise", ""]) {
          await assertInvalid(tool, { ...base, [unknown]: null }, fixture.directory);
          await assertInvalid(tool, { ...base, [unknown]: undefined }, fixture.directory);
        }
        assert.throws(() => validateToolArguments(tool, { id: "input-test", name: tool.name, arguments: { ...base, surprise: null } }));
        const input = structuredClone(base);
        const original = structuredClone(input);
        assert.deepEqual(prepareAndValidate(tool, input), { ...preparationDefaults, ...original });
        const result = await execute(tool, input, fixture.directory);
        assert.notEqual(result.details.error?.code, "INVALID_INPUT", JSON.stringify(result));
        assert.deepEqual(input, original);
        if (required === "args") {
          for (const args of ["inspect", [1], [null], ["inspect", {}], ["\0"]]) {
            await assertInvalid(tool, { args }, fixture.directory);
          }
        }
      });
    }
  });
});

test("integer schemas and execution guards enforce safe bounded integers", async (t) => {
  await withDirectory(async (fixture) => {
    for (const { tool, base } of cases(fixture)) {
      for (const [field, schema] of Object.entries(tool.parameters.properties)) {
        if (schema.type !== "integer") continue;
        await t.test(`${tool.name}.${field}`, async () => {
          const fieldBase = tool.name === "bash_job" ? { ...base, action: "output" }
            : field === "start_byte" ? { path: "source", mode: "bytes" } : base;
          for (const invalid of ["10", 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity,
            schema.minimum - 1, schema.maximum + 1]) {
            await assertInvalid(tool, { ...fieldBase, [field]: invalid }, fixture.directory);
          }
          for (const valid of [schema.minimum, schema.maximum]) {
            const input = { ...fieldBase, [field]: valid };
            assert.equal(prepareAndValidate(tool, input)[field], valid);
            const result = await execute(tool, input, fixture.directory);
            assert.notEqual(result.details.error?.code, "INVALID_INPUT", JSON.stringify(result));
          }
        });
      }
    }
  });
});

test("seconds retain finite fractions from 0.1 through 3600", async () => {
  await withDirectory(async (fixture) => {
    for (const { tool, base } of cases(fixture)) {
      const schema = tool.parameters.properties.timeout_seconds;
      if (!schema) continue;
      assert.equal(schema.type, "number");
      assert.equal(schema.minimum, 0.1);
      assert.equal(schema.maximum, tool.name === "bash" ? 86400 : 3600);
      for (const invalid of ["10", NaN, Infinity, -Infinity, 0, 0.099, 3600.1, Number.MAX_SAFE_INTEGER + 1]) {
        await assertInvalid(tool, { ...base, timeout_seconds: invalid }, fixture.directory);
      }
      for (const valid of [0.1, 0.125, 3600]) {
        const input = { ...base, timeout_seconds: valid };
        assert.equal(prepareAndValidate(tool, input).timeout_seconds, valid);
        const result = await execute(tool, input, fixture.directory);
        assert.equal(result.details.ok, true, JSON.stringify(result));
      }
    }
    assert.deepEqual(normalizeBashInput({ command: " true ", cwd: undefined, timeout_seconds: null }),
      { command: " true ", timeoutSeconds: 120, maxOutputBytes: 8192, background: false });
    const bash = createAgentBashTool();
    for (const timeout_seconds of [3600.1, 86400]) {
      const input = { command: "true", background: true, timeout_seconds };
      assert.deepEqual(prepareAndValidate(bash, input), input);
      assert.equal((await execute(bash, input, fixture.directory)).details.error.code, "CONTROL_UNAVAILABLE");
    }
    await assertInvalid(bash, { command: "true", background: true, timeout_seconds: 86400.1 }, fixture.directory);
    await assertInvalid(bash, { command: "true", background: true, max_output_bytes: 8192 }, fixture.directory);
  });
});

test("read uses enum schemas and retains mode-specific field exclusions", async () => {
  await withDirectory(async ({ directory }) => {
    const tool = createAgentReadTool();
    assert.deepEqual(tool.parameters.properties.mode.anyOf.map((choice) => choice.const), ["lines", "bytes"]);
    assert.deepEqual(tool.parameters.properties.encoding.anyOf.map((choice) => choice.const), ["utf8", "base64"]);
    for (const [field, minimum, maximum] of [["start_line", 1, 2147483647], ["max_lines", 1, 2000],
      ["max_bytes", 1, 40960], ["start_byte", 0, Number.MAX_SAFE_INTEGER]]) {
      assert.equal(tool.parameters.properties[field].type, "integer");
      assert.equal(tool.parameters.properties[field].minimum, minimum);
      assert.equal(tool.parameters.properties[field].maximum, maximum);
    }
    for (const input of [{ path: "source", mode: "invalid" }, { path: "source", mode: "bytes", encoding: "invalid" },
      { path: "source", start_byte: 0 }, { path: "source", encoding: "utf8" },
      { path: "source", mode: "bytes", start_line: 1 }, { path: "source", mode: "bytes", max_lines: 1 },
      { path: "source", mode: "bytes", show_line_numbers: false },
      { path: "source", mode: "bytes", encoding: "base64", max_bytes: 30721 }]) {
      await assertInvalid(tool, input, directory);
    }
    for (const mode of ["lines", "bytes"]) {
      const base = { path: "source", mode };
      for (const absent of [undefined, null]) {
        const input = { ...base, start_line: absent, max_lines: absent, show_line_numbers: absent,
          max_bytes: absent, start_byte: absent, encoding: absent };
        assert.deepEqual(prepareAndValidate(tool, input), base);
        assert.deepEqual(await execute(tool, input, directory), await execute(tool, base, directory));
      }
    }
  });
});

test("search limits and context have the specified schema bounds", () => {
  for (const tool of [createAgentFindTool(), createAgentGrepTool()]) {
    assert.equal(tool.parameters.properties.limit.minimum, 1);
    assert.equal(tool.parameters.properties.limit.maximum, 2147483647);
  }
  const contextSchema = createAgentGrepTool().parameters.properties.context;
  assert.equal(contextSchema.minimum, 0);
  assert.equal(contextSchema.maximum, 200);
});

test("ask_user copies option objects and omits only optional descriptions", async () => {
  const tool = createAskUserTool();
  assert.equal(tool.parameters.properties.options.items.additionalProperties, false);
  const base = { prompt: " exact question ", options: [option] };
  const defaultResult = await execute(tool, base, process.cwd());
  for (const absent of [undefined, null]) {
    const input = { ...base, options: [{ ...option, description: absent }] };
    const original = structuredClone(input);
    const prepared = tool.prepareArguments(input);
    assert.deepEqual(prepared, base);
    assert.notEqual(prepared.options, input.options);
    assert.notEqual(prepared.options[0], input.options[0]);
    assert.deepEqual(prepareAndValidate(tool, input), base);
    assert.deepEqual(await execute(tool, input, process.cwd()), defaultResult);
    assert.deepEqual(input, original);
  }
  const input = { ...base, options: [{ ...option, description: " exact description " }] };
  const original = structuredClone(input);
  const prepared = tool.prepareArguments(input);
  assert.notEqual(prepared.options[0], input.options[0]);
  assert.deepEqual(prepareAndValidate(tool, input), original);
  assert.deepEqual(normalizeAskUserInput(input).options, original.options);
  await execute(tool, input, process.cwd());
  assert.deepEqual(input, original);
  prepared.options[0].label = "Changed";
  assert.deepEqual(input, original);
  for (const invalid of [1, true, [], {}, " "]) {
    await assertInvalid(tool, { ...base, options: [{ ...option, description: invalid }] }, process.cwd());
  }
  for (const badOption of [{ ...option, id: null }, { ...option, label: null },
    { ...option, id: 1 }, { ...option, label: 1 }, { ...option, surprise: null }, { ...option, "": null }, null, 1, []]) {
    await assertInvalid(tool, { ...base, options: [badOption] }, process.cwd());
  }
  assert.throws(() => validateToolArguments(tool, { id: "input-test", name: "ask_user",
    arguments: { ...base, options: [{ ...option, surprise: null }] } }));
});

test("ask_user keeps question rules with absent optional fields", async () => {
  const tool = createAskUserTool();
  for (const options of [undefined, null]) {
    for (const field of ["multiple", "allow_other"]) {
      for (const value of [true, false]) {
        await assertInvalid(tool, { prompt: "Choose", options, [field]: value }, process.cwd());
      }
    }
  }
  await assertInvalid(tool, { prompt: "Choose", options: [option], allow_other: false, placeholder: "other" }, process.cwd());
  for (const absent of [undefined, null]) {
    assert.deepEqual(normalizeAskUserInput({ prompt: " exact prompt ", options: absent, multiple: absent,
      allow_other: absent, placeholder: absent }), { prompt: " exact prompt ", multiple: false, allowOther: true });
    assert.deepEqual(normalizeAskUserInput({ prompt: "Choose", options: [option], multiple: absent,
      allow_other: absent, placeholder: absent }), { prompt: "Choose", options: [option], multiple: false, allowOther: true });
  }
});

test("web_search rejects invalid input before model selection or network work", async () => {
  const tool = createAgentWebSearchTool();
  for (const input of [{ query: null }, { query: 1 }, { query: " " }, { query: "ok", surprise: null }]) {
    const result = await tool.execute("input-test", input, undefined, undefined, {});
    assert.equal(result.details.error.code, "INVALID_INPUT");
  }
});
