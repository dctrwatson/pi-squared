import test from "node:test";
import assert from "node:assert/strict";

test("all Pi extension modules load with the pinned Pi API", async () => {
  const modules = await Promise.all([
    import("../../extensions/subagents/index.ts"),
    import("../../extensions/qa.ts"),
    import("../../extensions/handoff.ts"),
    import("../../extensions/skill-loader.ts"),
    import("../../extensions/prevent-idle.ts"),
    import("../../extensions/interactive-shell.ts"),
    import("../../extensions/codex-tools/index.ts"),
  ]);

  for (const module of modules) {
    assert.equal(typeof module.default, "function");
  }
});
