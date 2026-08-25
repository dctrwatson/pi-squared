import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../extensions");

test("auto-discoverable extension modules export factory functions", async () => {
  const entries = await readdir(EXTENSIONS_DIRECTORY, { withFileTypes: true });
  const extensionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(EXTENSIONS_DIRECTORY, entry.name));
  const modules = await Promise.all(extensionFiles.map((file) => import(pathToFileURL(file).href)));

  for (const module of modules) {
    assert.equal(typeof module.default, "function");
  }
});

test("all Pi extension modules load with the pinned Pi API", async () => {
  const modules = await Promise.all([
    import("../../extensions/subagents/index.ts"),
    import("../../extensions/qa.ts"),
    import("../../extensions/handoff.ts"),
    import("../../extensions/skill-loader.ts"),
    import("../../extensions/prevent-idle.ts"),
    import("../../extensions/interactive-shell.ts"),
    import("../../extensions/workspace/index.ts"),
    import("../../extensions/ask-user.ts"),
    import("../../extensions/codex-tools/index.ts"),
  ]);

  for (const module of modules) {
    assert.equal(typeof module.default, "function");
  }
});
