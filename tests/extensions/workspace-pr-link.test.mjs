import { appendFileSync } from "node:fs";

import {
  test,
  assert,
  mkdir,
  readFile,
  writeFile,
  realpath,
  join,
  dirname,
  WorkspaceService,
  GitRepository,
  NodeProcessRunner,
  repository,
  removeRepository,
  FakeSessions,
  mapWorkspace,
  git,
} from "./workspace-test-support.mjs";
import { readWorkspaceSession } from "../../extensions/workspace/sessions.ts";

function mockedRunner(options = {}) {
  const realRunner = new NodeProcessRunner();
  const calls = [];
  return {
    calls,
    async run(command, args, processOptions) {
      calls.push({ command, args });
      if (command !== "gh") return realRunner.run(command, args, processOptions);
      if (args[0] === "repo") {
        return { stdout: JSON.stringify({ nameWithOwner: options.baseRepository ?? "owner/repo" }), stderr: "", code: 0 };
      }
      if (args[0] === "pr") {
        await options.onPrView?.();
        const pr = options.pr ?? {};
        return {
          stdout: JSON.stringify({
            number: pr.number ?? 42,
            url: pr.url ?? "https://github.com/owner/repo/pull/42",
            headRefName: pr.headRefName ?? options.branch ?? "main",
            headRefOid: pr.headRefOid ?? options.headOid ?? "0123456789abcdef0123456789abcdef01234567",
            headRepository: { nameWithOwner: pr.headRepository ?? "owner/repo" },
          }),
          stderr: "",
          code: 0,
        };
      }
      throw new Error(`Unexpected gh command: ${args.join(" ")}`);
    },
  };
}

async function fixture({ managed = false, pr = {}, onPrView, branch } = {}) {
  const root = await repository();
  const sessions = new FakeSessions(root);
  const actualBranch = branch ?? (managed ? "feature/pr-link" : "main");
  const runner = mockedRunner({ branch: actualBranch, pr, onPrView, headOid: git(root, "rev-parse", "HEAD") });
  let cwd = await realpath(root);
  if (managed) {
    const setupService = new WorkspaceService(root, { git: new GitRepository(root, runner), sessions });
    const setupState = await setupService.state();
    cwd = setupState.worktreePath(actualBranch);
    await mkdir(dirname(cwd), { recursive: true });
    git(root, "worktree", "add", "-b", actualBranch, cwd);
  }
  const service = new WorkspaceService(cwd, { git: new GitRepository(cwd, runner), sessions });
  const { state, record: initialRecord } = await mapWorkspace(service, sessions, actualBranch, cwd);
  const head = git(cwd, "rev-parse", "HEAD");
  const record = {
    ...initialRecord,
    name: "PR workspace",
    description: "Keep this label",
    baseBranch: "release",
    baseOid: git(root, "rev-parse", "HEAD"),
  };
  await state.putWorkspace(record);
  await state.putLast(record);
  await state.acquireLease(record);
  const savedRecord = await state.getWorkspace(actualBranch);
  return { root, cwd, service, sessions, state, runner, branch: actualBranch, record: savedRecord, head };
}

function appendMetadata(sessions, record, entries) {
  return (metadata) => {
    appendFileSync(record.session, `${JSON.stringify({
      type: "custom",
      id: `link-${entries.length + 1}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "pi-workspace",
      data: metadata,
    })}\n`);
    sessions.entries.set(record.session, metadata);
    entries.push(metadata);
  };
}

async function link(ctx, target = { type: "pr", number: 42 }, append = () => {}) {
  return ctx.service.linkPullRequest(target, { branch: ctx.branch, session: ctx.record.session }, append);
}

test("links a PR to the active primary and managed workspaces without changing checkout or lease", async (t) => {
  for (const managed of [false, true]) {
    await t.test(managed ? "managed" : "primary", async () => {
      const ctx = await fixture({ managed });
      try {
        const dirtyFile = join(ctx.cwd, "dirty-local-file.txt");
        await writeFile(dirtyFile, "keep dirty files\n");
        const leaseBefore = await readFile(ctx.state.leasePath(ctx.record.session), "utf8");
        const entries = [];
        const appended = appendMetadata(ctx.sessions, ctx.record, entries);
        const result = await link(ctx, { type: "pr", number: 42 }, appended);

        assert.equal(result.prUrl, "https://github.com/owner/repo/pull/42");
        assert.deepEqual(result.pr, {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          baseRepository: "owner/repo",
          headRepository: "owner/repo",
          headRef: ctx.branch,
          headOid: ctx.head,
        });
        assert.deepEqual(entries, [{
          repository: ctx.state.commonDir,
          branch: ctx.branch,
          cwd: ctx.cwd,
          pr: result.pr,
        }]);
        assert.equal(git(ctx.cwd, "rev-parse", "HEAD"), ctx.head);
        assert.equal(git(ctx.cwd, "branch", "--show-current"), ctx.branch);
        assert.equal(await readFile(dirtyFile, "utf8"), "keep dirty files\n");
        assert.equal(await readFile(ctx.state.leasePath(ctx.record.session), "utf8"), leaseBefore);
        assert.equal(ctx.runner.calls.some(({ command, args }) => command === "git"
          && ["checkout", "switch", "reset", "push"].includes(args[0])), false);

        const freshService = new WorkspaceService(ctx.cwd, {
          git: new GitRepository(ctx.cwd, ctx.runner),
          sessions: ctx.sessions,
        });
        const persisted = await (await freshService.state()).getWorkspace(ctx.branch);
        assert.deepEqual(persisted.pr, result.pr);
        assert.equal(persisted.prUrl, result.pr.url);
        assert.equal(persisted.session, ctx.record.session);
        assert.equal(persisted.cwd, ctx.cwd);
        assert.equal(persisted.name, "PR workspace");
        assert.equal(persisted.description, "Keep this label");
        assert.equal(persisted.baseBranch, "release");
        assert.equal(persisted.baseOid, ctx.head);
        assert.equal(await (await freshService.state()).getLast(), ctx.branch);
        assert.deepEqual((await readWorkspaceSession(ctx.record.session)).metadata.pr, result.pr);

        const retried = await link(ctx, { type: "pr", number: 42 }, appended);
        assert.deepEqual(retried.pr, result.pr);
        assert.equal(entries.length, 1);
      } finally {
        await removeRepository(ctx.root);
      }
    });
  }
});

test("rejects a different PR and rejects a wrong head branch, fork, or repository", async (t) => {
  await t.test("different PR", async () => {
    const ctx = await fixture();
    try {
      const entries = [];
      const appended = appendMetadata(ctx.sessions, ctx.record, entries);
      await link(ctx, { type: "pr", number: 42 }, appended);
      ctx.runner.calls.length = 0;
      ctx.runner.run = async function (command, args, processOptions) {
        if (command !== "gh") return new NodeProcessRunner().run(command, args, processOptions);
        if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "owner/repo" }), stderr: "", code: 0 };
        return { stdout: JSON.stringify({
          number: 43,
          url: "https://github.com/owner/repo/pull/43",
          headRefName: ctx.branch,
          headRefOid: ctx.head,
          headRepository: { nameWithOwner: "owner/repo" },
        }), stderr: "", code: 0 };
      };
      await assert.rejects(link(ctx, { type: "pr", number: 43 }, appended), /already bound to a different pull request/);
      assert.equal(entries.length, 1);
      assert.equal((await ctx.state.getWorkspace(ctx.branch)).pr.number, 42);
    } finally {
      await removeRepository(ctx.root);
    }
  });

  for (const [name, setup, message] of [
    ["wrong head branch", { pr: { headRefName: "other-branch" } }, /does not match workspace branch/],
    ["fork", { pr: { headRepository: "contributor/repo" } }, /another repository/],
    ["wrong repository", { pr: { url: "https:\/\/github.com\/other\/repo\/pull\/42" } }, /does not belong to this repository/],
  ]) {
    await t.test(name, async () => {
      const ctx = await fixture(setup);
      try {
        const entries = [];
        await assert.rejects(link(ctx, { type: "pr", number: 42 }, appendMetadata(ctx.sessions, ctx.record, entries)), message);
        assert.equal(entries.length, 0);
        assert.equal(await ctx.state.getConfig(ctx.state.prKey(ctx.branch)), undefined);
      } finally {
        await removeRepository(ctx.root);
      }
    });
  }
});

test("requires the saved current-session binding and its owned live lease", async (t) => {
  for (const scenario of ["branch", "session", "missing lease", "other lease"]) {
    await t.test(scenario, async () => {
      const ctx = await fixture();
      try {
        let binding = { branch: ctx.branch, session: ctx.record.session };
        if (scenario === "branch") binding.branch = "other-branch";
        if (scenario === "session") binding.session = `${ctx.record.session}.other`;
        if (scenario === "missing lease") await ctx.state.releaseLease(ctx.record);
        if (scenario === "other lease") {
          await ctx.state.releaseLease(ctx.record);
          await ctx.state.acquireLease(ctx.record, process.pid + 100_000);
        }
        const entries = [];
        await assert.rejects(ctx.service.linkPullRequest({ type: "pr", number: 42 }, binding,
          appendMetadata(ctx.sessions, ctx.record, entries)));
        assert.equal(entries.length, 0);
        assert.equal(await ctx.state.getConfig(ctx.state.prKey(ctx.branch)), undefined);
      } finally {
        await removeRepository(ctx.root);
      }
    });
  }
});

test("rolls back PR config when metadata append or config update fails", async (t) => {
  for (const failure of ["metadata append", "config update"]) {
    await t.test(failure, async () => {
      const ctx = await fixture();
      try {
        ctx.service.state = async () => ctx.state;
        const prKey = ctx.state.prKey(ctx.branch);
        if (failure === "metadata append") {
          await assert.rejects(link(ctx, { type: "pr", number: 42 }, () => { throw new Error("append failed"); }), /append failed/);
        } else {
          const setConfig = ctx.state.setConfig.bind(ctx.state);
          let failOnce = true;
          ctx.state.setConfig = async (key, value) => {
            await setConfig(key, value);
            if (key === prKey && failOnce) {
              failOnce = false;
              throw new Error("config write failed");
            }
          };
          await assert.rejects(link(ctx, { type: "pr", number: 42 }, () => assert.fail("metadata must not be appended")), /config write failed/);
        }
        assert.equal(await ctx.state.getConfig(prKey), undefined);
        assert.equal((await ctx.state.getWorkspace(ctx.branch)).pr, undefined);
      } finally {
        await removeRepository(ctx.root);
      }
    });
  }
});

test("rechecks branch and session binding after PR lookup", async (t) => {
  for (const drift of ["branch", "session"]) {
    await t.test(drift, async () => {
      let ctx;
      ctx = await fixture({ onPrView: async () => {
        if (drift === "branch") git(ctx.root, "checkout", "-b", "changed-during-lookup");
        else await ctx.state.setConfig(ctx.state.sessionKey(ctx.branch), `${ctx.record.session}.changed`);
      } });
      try {
        const entries = [];
        await assert.rejects(link(ctx, { type: "pr", number: 42 }, appendMetadata(ctx.sessions, ctx.record, entries)));
        assert.equal(entries.length, 0);
        assert.equal(await ctx.state.getConfig(ctx.state.prKey(ctx.branch)), undefined);
      } finally {
        await removeRepository(ctx.root);
      }
    });
  }
});
