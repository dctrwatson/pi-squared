import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubagentProcessArgs,
  SUBAGENT_EXTENSION_PATHS,
  SUBAGENT_PROCESS_ARGS_CAPABILITIES,
} from "../../extensions/subagents/personas.ts";

function extensionPaths(args) {
  return args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
}

const persona = (extensions) => ({
  name: "extension-check",
  runtime: "pi",
  systemPrompt: "Inspect selected resources.",
  extensions,
  skills: [],
  filePath: "/personas/extension-check.md",
});

test("subagent process-argument capability advertises default extension paths", () => {
  assert.deepEqual(SUBAGENT_PROCESS_ARGS_CAPABILITIES, { defaultExtensionPaths: true });
});

test("subagent builder uses shared extension defaults unless explicitly overridden", () => {
  const omitted = buildSubagentProcessArgs({ mode: "fresh" });
  assert.deepEqual(extensionPaths(omitted), [...SUBAGENT_EXTENSION_PATHS]);

  const explicitDefaults = buildSubagentProcessArgs({ mode: "fresh", defaultExtensionPaths: [...SUBAGENT_EXTENSION_PATHS] });
  assert.deepEqual(extensionPaths(explicitDefaults), [...SUBAGENT_EXTENSION_PATHS]);

  const noDefaults = buildSubagentProcessArgs({ mode: "fresh", defaultExtensionPaths: [] });
  assert.deepEqual(extensionPaths(noDefaults), []);
});

test("persona extensions merge with and deduplicate against selected defaults", () => {
  const custom = "/personas/extensions/custom.ts";
  const sharedDefault = SUBAGENT_EXTENSION_PATHS[0];

  const defaultsAndPersona = buildSubagentProcessArgs({
    mode: "fresh",
    persona: persona([sharedDefault, custom]),
  });
  assert.deepEqual(extensionPaths(defaultsAndPersona), [...SUBAGENT_EXTENSION_PATHS, custom]);

  const selectedDefault = "/psagent/delegate-extension.ts";
  const selectedAndPersona = buildSubagentProcessArgs({
    mode: "fresh",
    defaultExtensionPaths: [selectedDefault],
    persona: persona([selectedDefault, custom]),
  });
  assert.deepEqual(extensionPaths(selectedAndPersona), [selectedDefault, custom]);

  const personaWithoutDefault = buildSubagentProcessArgs({
    mode: "fresh",
    defaultExtensionPaths: [],
    persona: persona([sharedDefault, custom]),
  });
  assert.deepEqual(extensionPaths(personaWithoutDefault), [sharedDefault, custom]);
});
