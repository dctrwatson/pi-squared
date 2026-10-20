import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WORKSPACE_LINK_PR_TOOL } from "../../extensions/workspace/index.ts";
import { WORKSPACE_SESSION_TYPE } from "../../extensions/workspace/sessions.ts";
import {
  test,
  assert,
  readFile,
  join,
  WorkspaceService,
  GitRepository,
  NodeProcessRunner,
  PiSessionStore,
  workspaceExtension,
  repository,
  removeRepository,
  mapWorkspace,
  switcher,
  formatWorkspaceList,
  git,
} from "./workspace-test-support.mjs";

async function activeWorkspace(managed = false) {
  const root = await repository();
  const sessions = new PiSessionStore(join(root, ".git", "sessions"));
  const realRunner = new NodeProcessRunner();
  const ghCalls = [];
  const runner = {
    async run(command, args, options) {
      if (command !== "gh") return realRunner.run(command, args, options);
      ghCalls.push(args);
      if (args[0] === "repo") {
        return { code: 0, stdout: JSON.stringify({ nameWithOwner: "owner/repo" }), stderr: "" };
      }
      assert.equal(args[1], "view");
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          headRefName: "feature",
          headRefOid: git(options.cwd, "rev-parse", "HEAD"),
          headRepository: { nameWithOwner: "owner/repo" },
        }),
        stderr: "",
      };
    },
  };
  const createService = (cwd) => new WorkspaceService(cwd, { git: new GitRepository(cwd, runner), sessions });
  const sourceService = createService(root);
  let record;
  if (managed) {
    record = (await sourceService.create({ branch: "feature", parallel: true }, {
      parallel: true,
      switchSession: switcher([]),
    })).record;
  } else {
    git(root, "checkout", "-b", "feature");
    record = (await mapWorkspace(sourceService, sessions, "feature", root)).record;
    await (await sourceService.state()).acquireLease(record);
  }
  const manager = SessionManager.open(record.session);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  workspaceExtension({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(event, handler) { handlers.set(event, handler); },
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
    setSessionName(name) { manager.appendSessionInfo(name); },
  }, { createService });
  const ctx = {
    cwd: record.cwd,
    sessionManager: manager,
    ui: { notify() {} },
    shutdown() { assert.fail("Workspace activation must not request shutdown"); },
  };
  return { root, record, manager, tools, commands, handlers, ctx, ghCalls, createService };
}

function linkTool(fixture) {
  return fixture.tools.get(WORKSPACE_LINK_PR_TOOL);
}

function link(fixture, pr = "https://github.com/owner/repo/pull/42", ctx = fixture.ctx) {
  return linkTool(fixture).execute("link-pr", { pr }, undefined, undefined, ctx);
}

test("the PR-link tool is hidden without an owned workspace and rejects direct execution", async () => {
  const fixture = await activeWorkspace();
  try {
    assert.equal(linkTool(fixture).exposure, "hidden");
    const plainCtx = { ...fixture.ctx, sessionManager: { getSessionFile: () => undefined } };
    await fixture.handlers.get("session_start")({}, plainCtx);
    assert.equal(linkTool(fixture).exposure, "hidden");
    await assert.rejects(link(fixture), /No active workspace/);
    assert.deepEqual(fixture.ghCalls, []);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("the PR-link tool updates live and saved session metadata for primary and managed workspaces", async (t) => {
  for (const managed of [false, true]) {
    await t.test(managed ? "managed" : "primary", async () => {
      const fixture = await activeWorkspace(managed);
      try {
        await fixture.handlers.get("session_start")({}, fixture.ctx);
        assert.equal(linkTool(fixture).exposure, "direct");
        assert.equal(linkTool(fixture).executionMode, "sequential");
        assert.equal(await fixture.commands.get("ws").getArgumentCompletions("#"), null);
        const service = fixture.createService(fixture.record.cwd);
        const state = await service.state();
        const lease = await readFile(state.leasePath(fixture.record.session), "utf8");
        const head = git(fixture.record.cwd, "rev-parse", "HEAD");
        const result = await link(fixture);
        assert.deepEqual(result.details, { branch: "feature", number: 42, url: "https://github.com/owner/repo/pull/42" });
        assert.match(result.content[0].text, /Linked \[#42\]\(https:\/\/github.com\/owner\/repo\/pull\/42\) to workspace feature/);
        const metadataEntries = () => fixture.manager.getEntries().filter((entry) =>
          entry.type === "custom" && entry.customType === WORKSPACE_SESSION_TYPE);
        assert.equal(metadataEntries().at(-1).data.pr.number, 42);
        assert.equal((await state.getWorkspace("feature")).pr.number, 42);
        assert.match(formatWorkspaceList(await fixture.createService(fixture.record.cwd).list()), /#42/);
        assert.deepEqual(await fixture.commands.get("ws").getArgumentCompletions("#"), [{
          value: "#42", label: "#42", description: "Known pull request",
        }]);
        const entryCount = metadataEntries().length;
        await link(fixture, "42");
        assert.equal(metadataEntries().length, entryCount);
        assert.equal(fixture.manager.getSessionFile(), fixture.record.session);
        assert.equal(git(fixture.record.cwd, "branch", "--show-current"), "feature");
        assert.equal(git(fixture.record.cwd, "rev-parse", "HEAD"), head);
        assert.equal(await readFile(state.leasePath(fixture.record.session), "utf8"), lease);
        await fixture.handlers.get("session_shutdown")({ reason: "reload" }, fixture.ctx);
        assert.equal(linkTool(fixture).exposure, "hidden");
        await fixture.handlers.get("session_start")({}, fixture.ctx);
        assert.equal(linkTool(fixture).exposure, "direct");
        assert.equal((await state.getWorkspace("feature")).pr.number, 42);
      } finally {
        await removeRepository(fixture.root);
      }
    });
  }
});

test("the PR-link tool rejects branch targets and another session", async () => {
  const fixture = await activeWorkspace();
  try {
    await fixture.handlers.get("session_start")({}, fixture.ctx);
    await assert.rejects(link(fixture, "feature"), /pull request URL or number is required/);
    const otherCtx = { ...fixture.ctx, sessionManager: { getSessionFile: () => `${fixture.record.session}.other` } };
    await assert.rejects(link(fixture, "42", otherCtx), /No active workspace/);
    assert.deepEqual(fixture.ghCalls, []);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("a later plain session hides the tool and clears its active workspace authority", async () => {
  const fixture = await activeWorkspace();
  try {
    await fixture.handlers.get("session_start")({}, fixture.ctx);
    const oldTool = linkTool(fixture);
    const plainCtx = { ...fixture.ctx, sessionManager: { getSessionFile: () => undefined } };
    await fixture.handlers.get("session_start")({}, plainCtx);
    assert.equal(linkTool(fixture).exposure, "hidden");
    assert.equal(fixture.handlers.get("before_agent_start")({ systemPrompt: "Base" }), undefined);
    await assert.rejects(oldTool.execute("old", { pr: "42" }, undefined, undefined, fixture.ctx), /No active workspace/);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("a session change during PR lookup prevents a link and restores PR config", async () => {
  const fixture = await activeWorkspace();
  try {
    await fixture.handlers.get("session_start")({}, fixture.ctx);
    const service = fixture.createService(fixture.record.cwd);
    const runner = service.git.runner;
    const run = runner.run.bind(runner);
    runner.run = async (command, args, options) => {
      const result = await run(command, args, options);
      if (command === "gh" && args[0] === "pr") {
        const plainCtx = { ...fixture.ctx, sessionManager: { getSessionFile: () => undefined } };
        await fixture.handlers.get("session_start")({}, plainCtx);
      }
      return result;
    };
    await assert.rejects(link(fixture), /active workspace session changed/);
    const record = await (await service.state()).getWorkspace("feature");
    assert.equal(record.pr, undefined);
    assert.equal(record.prUrl, undefined);
  } finally {
    await removeRepository(fixture.root);
  }
});

test("publish-pr guidance links a created PR without repeating creation after a link failure", async () => {
  const skill = await readFile(new URL("../../skills/publish-pr/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /After creation, call `workspace_link_pr` with the returned URL when the tool and URL are available/);
  assert.match(skill, /If linking fails, report it; do not repeat PR creation/);
});
