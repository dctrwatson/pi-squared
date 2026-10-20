import {
  test,
  assert,
  workspaceExtension,
  handleWorkspace,
  picker,
  parseCommandWords,
  CREATE_WORKSPACE_TOOL,
} from "./workspace-test-support.mjs";

function registerExtension(createService) {
  const commands = new Map();
  const tools = new Map();
  workspaceExtension({
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {},
  }, { createService });
  return { commands, tools };
}

test("workspace describe updates labels without switching sessions", async () => {
  const calls = [];
  const notices = [];
  const service = {
    async describe(options) {
      calls.push(options);
      return { branch: options.branch ?? "current" };
    },
  };
  const context = {
    mode: "tui",
    cwd: "/repo",
    ui: { notify: (...args) => notices.push(args) },
    async switchSession() { throw new Error("describe must not switch sessions"); },
    sessionManager: { getSessionFile() { throw new Error("describe must not read session state"); } },
  };

  await handleWorkspace('describe feature/auth --name "Auth review" --description "Review sign-in"', context, service);
  await handleWorkspace('describe --name ""', context, service);

  assert.deepEqual(calls, [
    { branch: "feature/auth", name: "Auth review", description: "Review sign-in" },
    { name: "" },
  ]);
  assert.deepEqual(notices, [
    ["Workspace labels updated for feature/auth.", "info"],
    ["Workspace labels updated for current.", "info"],
  ]);
});

test("workspace label completions keep values out of branch and ref suggestions", async () => {
  const service = {
    async state() { return { async listWorkspaces() { return []; } }; },
    git: {
      async localBranches() { return ["feature/auth", "main", "describe"]; },
      async localRefs() { return ["feature/auth", "main", "release/1"]; },
    },
  };
  const { commands } = registerExtension(() => service);
  const command = commands.get("ws");
  const values = async (prefix) => (await command.getArgumentCompletions(prefix))?.map((item) => item.value) ?? null;

  assert.deepEqual(await values(""), [
    "--help", "-h", "new", "describe", "merge", "prune", "--worktree",
    "feature/auth", "main", "branch:describe",
  ]);
  assert.deepEqual(await values("new "), [
    "new --from", "new --worktree", "new --no-worktree", "new --name", "new --description",
  ]);
  assert.deepEqual(await values("feature/auth"), ["feature/auth"]);
  assert.deepEqual(await values("describe "), [
    "describe feature/auth", "describe main", "describe branch:describe",
    "describe --name", "describe --description",
  ]);

  const multiword = await values('describe --name "Auth label" ');
  assert.deepEqual(multiword, ['describe --name "Auth label" --description']);
  assert.deepEqual(parseCommandWords(multiword[0]), ["describe", "--name", "Auth label", "--description"]);

  const empty = await values('describe --name "" ');
  assert.deepEqual(empty, ['describe --name "" --description']);
  assert.deepEqual(parseCommandWords(empty[0]), ["describe", "--name", "", "--description"]);

  const quoted = await values('describe --name "a \\"quote\\"" ');
  assert.deepEqual(quoted, ['describe --name "a \\"quote\\"" --description']);
  assert.deepEqual(parseCommandWords(quoted[0]), ["describe", "--name", 'a "quote"', "--description"]);

  const backslash = await values('describe --name "a \\\\ path" ');
  assert.deepEqual(backslash, ['describe --name "a \\\\ path" --description']);
  assert.deepEqual(parseCommandWords(backslash[0]), ["describe", "--name", "a \\ path", "--description"]);

  const newLabel = await values('new feature/auth --description "Auth purpose" ');
  assert.deepEqual(newLabel, [
    'new feature/auth --description "Auth purpose" --from',
    'new feature/auth --description "Auth purpose" --worktree',
    'new feature/auth --description "Auth purpose" --no-worktree',
    'new feature/auth --description "Auth purpose" --name',
  ]);
  assert.deepEqual(parseCommandWords(newLabel[0]), ["new", "feature/auth", "--description", "Auth purpose", "--from"]);
  assert.deepEqual(await values("new feature/auth --from "), [
    "new feature/auth --from current",
    "new feature/auth --from feature/auth",
    "new feature/auth --from main",
    "new feature/auth --from release/1",
  ]);
});

test("workspace picker keeps branch identity visible with labels", async () => {
  const selected = [];
  let activated;
  const status = {
    record: { branch: "feature/auth", name: "Auth review", description: "Review sign-in" },
    placement: "managed",
    recency: undefined,
    dirty: false,
    stale: false,
    active: false,
  };
  const service = {
    async list() { return [status]; },
    async activationBlockers() { return new Set(); },
    async activate(target) { activated = target; },
  };
  await picker(service, {
    mode: "tui",
    cwd: "/repo",
    ui: {
      notify() {},
      async select(_title, choices) { selected.push(...choices); return choices[0]; },
    },
  });

  assert.ok(selected[0].startsWith("feature/auth • name: Auth review • description: Review sign-in"));
  assert.deepEqual(activated, { type: "branch", branch: "feature/auth" });
});

test("workspace picker keeps the selected record when its recency label changes", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const status = {
      record: { branch: "feature/recency" },
      placement: "managed",
      recency: now - 59_400,
      dirty: false,
      stale: false,
      active: false,
    };
    let activated;
    await picker({
      async list() { return [status]; },
      async activationBlockers() { return new Set(); },
      async activate(target) { activated = target; },
    }, {
      mode: "tui",
      cwd: "/repo",
      ui: {
        notify() {},
        async select(_title, choices) {
          assert.match(choices[0], / • now$/);
          now += 1_000;
          return choices[0];
        },
      },
    });

    assert.deepEqual(activated, { type: "branch", branch: "feature/recency" });
  } finally {
    Date.now = originalNow;
  }
});

test("create_workspace passes optional labels and returns the stored labels", async () => {
  const created = [];
  const service = {
    async create(options) {
      created.push(options);
      return {
        record: {
          branch: options.branch,
          cwd: "/repo/.worktrees/feature/src",
          session: "/sessions/feature.jsonl",
          name: options.name,
          description: options.description,
        },
      };
    },
    async state() { return { async releaseLease() {} }; },
  };
  const { tools } = registerExtension(() => service);
  const tool = tools.get(CREATE_WORKSPACE_TOOL);
  const execute = (params) => tool.execute("call", params, undefined, () => {}, { cwd: "/repo" });
  const result = await execute({ branch: "feature/auth", name: "Auth review", description: "Review sign-in" });

  assert.equal(created[0].name, "Auth review");
  assert.equal(created[0].description, "Review sign-in");
  assert.equal(result.details.name, "Auth review");
  assert.equal(result.details.description, "Review sign-in");

  await assert.rejects(execute({ branch: "feature/auth", name: "\nAuth review" }), /single-line text without control characters/);
  await assert.rejects(execute({ branch: "feature/auth", description: "Review sign-in\t" }), /single-line text without control characters/);
  await assert.rejects(execute({ branch: "feature/auth", name: "" }), /workspace name is required/);
  await assert.rejects(execute({ branch: "feature/auth", description: "  " }), /workspace description is required/);
  assert.equal(created.length, 1);
});
