import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

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

  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await discoverAndLoadExtensions([extensionDirectory], cwd, join(cwd, "agent"));

  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const [extension] = result.extensions;
  assert.equal(extension.resolvedPath, join(extensionDirectory, "index.ts"));
  assert.ok(extension.tools.has("recall"));
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
    import("../../extensions/agent-tools/index.ts"),
  ]);

  for (const module of modules) {
    assert.equal(typeof module.default, "function");
  }
});
