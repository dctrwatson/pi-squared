import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launchPi = await import("../../extensions/workspace/launch-pi.ts");
const {
  GHOSTTY_TAB_SCRIPT,
  LAUNCH_PI_TOOL,
  buildPiwStartupInput,
  registerLaunchPi,
  resolveLaunchPiCwd,
} = launchPi;

function register(options = {}, execResult = { code: 0, stdout: "", stderr: "" }) {
  let tool;
  const calls = [];
  registerLaunchPi({
    registerTool(definition) {
      tool = definition;
    },
    async exec(command, args, execOptions) {
      calls.push({ command, args, execOptions });
      return execResult;
    },
  }, options);
  assert.ok(tool);
  return { tool, calls };
}

test("launch_pi starts piw with a quoted prompt", () => {
  assert.equal(
    buildPiwStartupInput("Continue with 'quoted' text."),
    "'piw' '--' '--' 'Continue with '\"'\"'quoted'\"'\"' text.'\n",
  );
});

test("launch_pi resolves relative working directories and rejects files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launch-pi-"));
  try {
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, "file.txt"), "test\n");

    const resolvedNested = await realpath(nested);
    assert.equal(await resolveLaunchPiCwd(root, "nested"), resolvedNested);
    assert.equal(await resolveLaunchPiCwd(root, "@nested"), resolvedNested);
    await assert.rejects(resolveLaunchPiCwd(root, "file.txt"), /Not a directory/);
    await assert.rejects(resolveLaunchPiCwd(root, "   "), /working directory is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch_pi opens a Ghostty tab after confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launch-pi-"));
  try {
    const { tool, calls } = register({ platform: "darwin" });
    const cwd = await realpath(root);
    const signal = new AbortController().signal;
    const confirmations = [];

    const result = await tool.execute("tool-1", {
      cwd: root,
      prompt: "Start the worker.",
    }, signal, undefined, {
      cwd: root,
      ui: {
        confirm: async (...args) => {
          confirmations.push(args);
          return true;
        },
      },
    });

    assert.deepEqual(confirmations, [[
      "Launch workspace Pi",
      `Open interactive Pi in a new Ghostty tab for ${cwd}?`,
    ]]);
    assert.deepEqual(calls, [{
      command: "/usr/bin/osascript",
      args: ["-e", GHOSTTY_TAB_SCRIPT, "--", cwd, buildPiwStartupInput("Start the worker.")],
      execOptions: { signal },
    }]);
    assert.deepEqual(result.details, {
      ok: true,
      tool: LAUNCH_PI_TOOL,
      launched: true,
      cwd,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch_pi reports Ghostty launch errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launch-pi-"));
  try {
    const { tool } = register(
      { platform: "darwin" },
      { code: 1, stdout: "", stderr: "Application isn't running.\n" },
    );
    await assert.rejects(tool.execute("tool-1", {
      cwd: root,
      prompt: "Start the worker.",
    }, undefined, undefined, {
      cwd: root,
      ui: { confirm: async () => true },
    }), /Could not open the Ghostty tab: Application isn't running\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch_pi does not open a tab when the user cancels", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launch-pi-"));
  try {
    const { tool, calls } = register({ platform: "darwin" });
    const result = await tool.execute("tool-1", {
      cwd: root,
      prompt: "Start the worker.",
    }, undefined, undefined, {
      cwd: root,
      ui: { confirm: async () => false },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result.details, {
      ok: true,
      tool: LAUNCH_PI_TOOL,
      launched: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launch_pi rejects platforms without Ghostty AppleScript", async () => {
  const { tool } = register({ platform: "linux" });
  await assert.rejects(tool.execute("tool-1", {
    cwd: "/tmp",
    prompt: "Start the worker.",
  }, undefined, undefined, {}), /requires macOS and Ghostty/);
});
