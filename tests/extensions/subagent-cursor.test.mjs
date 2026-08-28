import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFile = promisify(execFileCallback);
const sdkModule = await import("../../extensions/subagents/cursor-sdk.ts");
const repositoriesModule = await import("../../extensions/subagents/cursor-repositories.ts");
const modelsModule = await import("../../extensions/subagents/cursor-models.ts");
const contextModule = await import("../../extensions/subagents/cursor-context.ts");

async function git(cwd, ...args) {
  await execFile("git", args, { cwd });
}

async function createPushedRepository(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-cursor-repository-"));
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(worktree);
  await git(root, "init", "--bare", remote);
  await git(worktree, "init");
  await git(worktree, "config", "user.email", "cursor-tests@example.invalid");
  await git(worktree, "config", "user.name", "Cursor tests");
  await git(worktree, "checkout", "-b", "main");
  await writeFile(join(worktree, "README.md"), "initial\n");
  await git(worktree, "add", "README.md");
  await git(worktree, "commit", "-m", "initial");
  await git(worktree, "remote", "add", "origin", remote);
  await git(worktree, "push", "-u", "origin", "main");
  await git(worktree, "remote", "set-url", "origin", "git@github.com:Example/Project.git");
  return { root, worktree };
}

test("Cursor SDK validates credentials, caches one port, and trims operation keys", async () => {
  let loads = 0;
  const missing = new sdkModule.CursorSdkGateway({
    getApiKey: () => undefined,
    load: async () => { loads++; throw new Error("must not load"); },
  });
  await assert.rejects(missing.listModels(), (error) => error.code === "AUTH_REQUIRED");
  await assert.rejects(missing.createAgent({ agentId: "bc-no-key" }), (error) => error.code === "AUTH_REQUIRED");
  await assert.rejects(missing.resumeAgent("bc-no-key"), (error) => error.code === "AUTH_REQUIRED");
  assert.equal(loads, 0, "missing credentials do not import the SDK or use browser fallback");

  const operations = [];
  const gateway = new sdkModule.CursorSdkGateway({
    getApiKey: () => "  cursor-trimmed-key  ",
    load: async () => {
      loads++;
      return {
        async listModels({ apiKey }) { operations.push(["models", apiKey]); return [{ id: "model" }]; },
        async listRepositories({ apiKey }) { operations.push(["repositories", apiKey]); return [{ url: "https://github.com/example/repo" }]; },
      };
    },
  });
  await Promise.all([gateway.listModels(), gateway.listRepositories(), gateway.listModels()]);
  assert.equal(loads, 1);
  assert.deepEqual(operations, [
    ["models", "cursor-trimmed-key"],
    ["repositories", "cursor-trimmed-key"],
    ["models", "cursor-trimmed-key"],
  ]);
});

test("Cursor SDK error mapping uses stable credential-free results", () => {
  for (const { error, code, message } of [
    { error: Object.assign(new Error("cursor-secret"), { status: 401 }), code: "AUTH_REQUIRED", message: "Cursor Cloud authentication failed. Set a valid CURSOR_API_KEY and retry." },
    { error: Object.assign(new Error("cursor-secret"), { status: 409 }), code: "BUSY", message: "Cursor Cloud already has an active run. Wait for it to settle, then retry." },
    { error: Object.assign(new Error("cursor-secret"), { status: 404 }), code: "REMOTE_NOT_FOUND", message: "The Cursor Cloud agent was not found. Refresh status before retrying." },
    { error: { name: "AbortError" }, code: "CANCELLED", message: "The Cursor Cloud operation was cancelled." },
    { error: { code: "repository_access" }, code: "REPOSITORY_UNAVAILABLE", message: "Cursor Cloud could not access the repository. Confirm repository access and retry." },
    { error: new Error("x".repeat(20_000)), code: "BACKEND_FAILED", message: "Cursor Cloud operation failed. Retry the operation." },
  ]) {
    const mapped = sdkModule.mapCursorSdkError(error);
    assert.equal(mapped.code, code);
    assert.equal(mapped.message, message);
    assert.doesNotMatch(mapped.message, /cursor-secret/);
  }
});

test("public index exposes Cursor helpers without invoking its SDK loader", async () => {
  const publicIndex = await import("../../extensions/subagents/index.ts");
  assert.equal(typeof publicIndex.buildCursorCloudBootstrap, "function");
  let loads = 0;
  const gateway = new publicIndex.CursorSdkGateway({
    getApiKey: () => undefined,
    load: async () => { loads++; throw new Error("must not load"); },
  });
  await assert.rejects(gateway.listRepositories(), (error) => error.code === "AUTH_REQUIRED");
  assert.equal(loads, 0);
});

test("repository provenance pins pushed HEAD, warns for dirty worktrees, and rejects unpushed HEAD", async (t) => {
  const { worktree } = await createPushedRepository(t);
  const primary = await repositoriesModule.detectCursorPrimaryRepository(worktree);
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: worktree });
  assert.equal(primary.url, "https://github.com/Example/Project");
  assert.equal(primary.startingRef, stdout.trim());
  assert.equal(primary.head, stdout.trim());
  assert.equal(primary.remoteHeadKnown, true);
  assert.equal(primary.dirty, false);

  await writeFile(join(worktree, "dirty.txt"), "local only\n");
  const dirty = await repositoriesModule.detectCursorPrimaryRepository(worktree);
  assert.equal(dirty.dirty, true);
  assert.match(dirty.warnings[0], /committed HEAD state/);

  await git(worktree, "branch", "--unset-upstream");
  await git(worktree, "add", "dirty.txt");
  await git(worktree, "commit", "-m", "unpushed");
  await assert.rejects(
    repositoriesModule.detectCursorPrimaryRepository(worktree),
    /not pushed to its configured remote branch/,
  );

  await git(worktree, "update-ref", "-d", "refs/remotes/origin/main");
  const unknown = await repositoriesModule.detectCursorPrimaryRepository(worktree);
  assert.equal(unknown.remoteHeadKnown, false);
});

test("repository normalization pins primary SHAs and resolves duplicate support refs deterministically", async () => {
  assert.equal(repositoriesModule.normalizeCursorGitHubUrl("git@github.com:Example/Repo.git"), "https://github.com/Example/Repo");
  assert.equal(repositoriesModule.normalizeCursorGitHubUrl("ssh://git@github.com/Example/Repo.git"), "https://github.com/Example/Repo");
  for (const url of [
    "https://token@github.com/example/repo",
    "https://github.com/example/repo?",
    "https://github.com/example/repo#",
    "https://gitlab.com/example/repo",
  ]) {
    assert.throws(() => repositoriesModule.normalizeCursorGitHubUrl(url));
  }
  const primary = { url: "https://github.com/example/main", startingRef: "a".repeat(40) };
  assert.throws(() => repositoriesModule.buildCursorRepositoryList({ ...primary, startingRef: "main" }), /exact commit SHA/);
  assert.equal(repositoriesModule.normalizeCursorStartingRef("A".repeat(64)), "a".repeat(64));
  assert.deepEqual(repositoriesModule.buildCursorRepositoryList({ url: "https://github.com/example/sha64", startingRef: "A".repeat(64) }), [
    { url: "https://github.com/example/sha64", startingRef: "a".repeat(64) },
  ]);
  for (const ref of ["--upload-pack=unsafe", "main..next", "refs//heads/main"]) assert.throws(() => repositoriesModule.normalizeCursorStartingRef(ref), /invalid startingRef/);
  const support = "https://github.com/example/support";
  for (const duplicateOrder of [
    [{ url: support }, { url: support, startingRef: "main" }],
    [{ url: support, startingRef: "main" }, { url: support }],
  ]) {
    assert.deepEqual(repositoriesModule.buildCursorRepositoryList(primary, duplicateOrder), [
      { url: "https://github.com/example/main", startingRef: "a".repeat(40) },
      { url: support, startingRef: "main" },
    ]);
  }
  for (const duplicatePrimary of [
    { url: "git@github.com:Example/Main.git" },
    { url: "https://github.com/example/main", startingRef: "main" },
    { url: "https://github.com/example/main", startingRef: "b".repeat(40) },
  ]) {
    assert.deepEqual(repositoriesModule.buildCursorRepositoryList(primary, [duplicatePrimary]), [
      { url: "https://github.com/example/main", startingRef: "a".repeat(40) },
    ]);
  }
  assert.throws(() => repositoriesModule.buildCursorRepositoryList(primary, [
    { url: support, startingRef: "main" },
    { url: support, startingRef: "release" },
  ]), /conflicting startingRef/);
  const maximum = repositoriesModule.buildCursorRepositoryList(primary, Array.from({ length: 19 }, (_, index) => ({
    url: `https://github.com/example/support-${index}`,
  })));
  assert.equal(maximum.length, 20);
  assert.throws(() => repositoriesModule.buildCursorRepositoryList(primary, Array.from({ length: 20 }, (_, index) => ({
    url: `https://github.com/example/overflow-${index}`,
  }))), /at most 20 repositories/);
  const mixedCaseSha = "Ab".repeat(20);
  assert.deepEqual(repositoriesModule.buildCursorRepositoryList(
    { url: "https://github.com/example/case", startingRef: mixedCaseSha },
    [{ url: "https://github.com/example/case", startingRef: mixedCaseSha.toLowerCase() }],
  ), [{ url: "https://github.com/example/case", startingRef: mixedCaseSha.toLowerCase() }]);
});

test("repository discovery passes remote names directly to git remote get-url", async () => {
  const calls = [];
  const sha = "b".repeat(40);
  const output = new Map([
    ["rev-parse\u0000--show-toplevel", "/tmp/project"],
    ["rev-parse\u0000--verify\u0000HEAD^{commit}", sha],
    ["symbolic-ref\u0000--quiet\u0000--short\u0000HEAD", "main"],
    ["config\u0000--get\u0000branch.main.remote", "team/review"],
    ["remote\u0000get-url\u0000team/review", "git@github.com:example/project.git"],
    ["status\u0000--porcelain=v1\u0000-z", ""],
  ]);
  const gitPort = {
    async run(_cwd, args) {
      calls.push(args);
      const value = output.get(args.join("\u0000"));
      return value === undefined ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: value, stderr: "" };
    },
  };
  const primary = await repositoriesModule.detectCursorPrimaryRepository("/tmp/project", gitPort);
  assert.equal(primary.remote, "team/review");
  assert.equal(primary.url, "https://github.com/example/project");
  assert.ok(calls.some((args) => args.join("\u0000") === "remote\u0000get-url\u0000team/review"));
  assert.equal(calls.some((args) => args.join("\u0000").includes("remote.team/review.url")), false);

  const unsafeCalls = [];
  const unsafePort = {
    async run(_cwd, args) {
      unsafeCalls.push(args);
      const key = args.join("\u0000");
      const value = key === "rev-parse\u0000--show-toplevel" ? "/tmp/project"
        : key === "rev-parse\u0000--verify\u0000HEAD^{commit}" ? sha
          : key === "symbolic-ref\u0000--quiet\u0000--short\u0000HEAD" ? "main"
            : key === "config\u0000--get\u0000branch.main.remote" ? "--upload-pack=unsafe"
              : undefined;
      return value === undefined ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: value, stderr: "" };
    },
  };
  await assert.rejects(repositoriesModule.detectCursorPrimaryRepository("/tmp/project", unsafePort), /remote name is invalid/);
  assert.equal(unsafeCalls.some((args) => args[0] === "remote"), false);
});

test("Git discovery reports stable preconditions", async () => {
  const sha = "c".repeat(40);
  for (const { name, output, message } of [
    { name: "outside a repository", output: new Map(), message: /not in a Git repository/ },
    {
      name: "missing selected remote",
      output: new Map([
        ["rev-parse\u0000--show-toplevel", "/tmp/project"],
        ["rev-parse\u0000--verify\u0000HEAD^{commit}", sha],
        ["symbolic-ref\u0000--quiet\u0000--short\u0000HEAD", "main"],
      ]),
      message: /No Git URL is configured/,
    },
  ]) {
    const port = {
      async run(_cwd, args) {
        const value = output.get(args.join("\u0000"));
        return value === undefined ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: value, stderr: "" };
      },
    };
    await assert.rejects(repositoriesModule.detectCursorPrimaryRepository("/tmp/project", port), (error) => {
      assert.equal(error.code, "GIT_PRECONDITION", name);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("connected repository lookup is cached and URL-only", async () => {
  let calls = 0;
  const lookup = new repositoriesModule.CursorConnectedRepositoryLookup({
    async listRepositories() {
      calls++;
      return [
        { url: "git@github.com:Example/Repo.git" },
        { url: "https://not-github.invalid/example/repo" },
      ];
    },
  });
  assert.equal(await lookup.has("https://github.com/example/repo"), true);
  assert.equal(await lookup.has("https://github.com/example/missing"), false);
  assert.equal(calls, 1);
});

test("Cursor catalog resolves exact Luna, Terra, and Sol targets with catalog parameters", async () => {
  let calls = 0;
  const catalog = new modelsModule.CursorModelCatalog({
    async listModels() {
      calls++;
      return [
        {
          id: "catalog-luna",
          displayName: "GPT-5.6 Luna",
          parameters: [{ id: "reasoning_effort", displayName: "Thinking", values: [{ value: "high" }, { value: "xhigh" }] }],
        },
        {
          id: "catalog-terra",
          displayName: "GPT-5.6 Terra",
          parameters: [{ id: "reasoning_effort", displayName: "Thinking", values: [{ value: "high" }, { value: "xhigh" }] }],
        },
        {
          id: "catalog-sol",
          displayName: "GPT-5.6 Sol",
          parameters: [{ id: "reasoning_effort", displayName: "Thinking", values: [{ value: "high" }, { value: "xhigh" }] }],
        },
      ];
    },
  });
  assert.deepEqual((await catalog.resolveProfile("fast")).selection, {
    id: "catalog-luna", parameters: [{ id: "reasoning_effort", value: "high" }],
  });
  assert.deepEqual((await catalog.resolveProfile("balanced")).selection, {
    id: "catalog-terra", parameters: [{ id: "reasoning_effort", value: "xhigh" }],
  });
  assert.deepEqual((await catalog.resolveProfile("deep")).selection, {
    id: "catalog-sol", parameters: [{ id: "reasoning_effort", value: "xhigh" }],
  });
  assert.deepEqual((await catalog.resolveCreation(undefined)).selection, {
    id: "catalog-terra", parameters: [{ id: "reasoning_effort", value: "xhigh" }],
  });
  assert.equal(calls, 1);
  assert.deepEqual(await catalog.panelModels(), [
    { id: "catalog-luna", name: "GPT-5.6 Luna", thinking: { parameterId: "reasoning_effort", values: [{ value: "high", name: "high" }, { value: "xhigh", name: "xhigh" }] } },
    { id: "catalog-terra", name: "GPT-5.6 Terra", thinking: { parameterId: "reasoning_effort", values: [{ value: "high", name: "high" }, { value: "xhigh", name: "xhigh" }] } },
    { id: "catalog-sol", name: "GPT-5.6 Sol", thinking: { parameterId: "reasoning_effort", values: [{ value: "high", name: "high" }, { value: "xhigh", name: "xhigh" }] } },
  ]);
});

test("Cursor profiles select complete standard-speed catalog variants", async () => {
  const variant = (reasoning, context = "272k", fast = "false") => ({
    displayName: `${context}-${reasoning}-${fast}`,
    params: [
      { id: "context", value: context },
      { id: "reasoning", value: reasoning },
      { id: "fast", value: fast },
    ],
  });
  const catalog = new modelsModule.CursorModelCatalog({
    async listModels() {
      return [
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          variants: [variant("high"), variant("high", "272k", "true"), variant("high", "1m")],
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6 Terra",
          variants: [variant("high"), variant("high", "272k", "true"), variant("xhigh"), variant("xhigh", "272k", "true"), variant("xhigh", "1m")],
        },
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          variants: [variant("xhigh"), variant("xhigh", "272k", "true"), variant("xhigh", "1m")],
        },
      ];
    },
  });
  assert.deepEqual((await catalog.resolveProfile("fast")).selection, {
    id: "gpt-5.6-luna",
    parameters: variant("high").params,
  });
  assert.deepEqual((await catalog.resolveProfile("balanced")).selection, {
    id: "gpt-5.6-terra",
    parameters: variant("xhigh").params,
  });
  assert.deepEqual((await catalog.resolveProfile("deep")).selection, {
    id: "gpt-5.6-sol",
    parameters: variant("xhigh").params,
  });
  assert.deepEqual((await catalog.resolveCreation(undefined)).selection, {
    id: "gpt-5.6-terra",
    parameters: variant("xhigh").params,
  });
});

test("Cursor variants provide canonical thinking selections when definitions are absent", async () => {
  const catalog = new modelsModule.CursorModelCatalog({
    async listModels() {
      return [{
        id: "variant-terra",
        displayName: "GPT-5.6 Terra",
        variants: [
          { displayName: "High", params: [{ id: "reasoning_effort", value: "high" }, { id: "quality", value: "balanced" }] },
          { displayName: "Extra high", params: [{ id: "reasoning_effort", value: "xhigh" }, { id: "quality", value: "balanced" }] },
        ],
      }];
    },
  });
  const resolved = await catalog.resolveSelection("variant-terra", [{ id: "reasoning_effort", value: "xhigh" }]);
  assert.deepEqual(resolved.selection, {
    id: "variant-terra",
    parameters: [{ id: "reasoning_effort", value: "xhigh" }, { id: "quality", value: "balanced" }],
  });
  assert.deepEqual((await catalog.resolveSelection("variant-terra", [])).selection.parameters, []);
  assert.deepEqual((await catalog.resolveSelection("variant-terra", [{ id: "reasoning_effort", value: "high" }])).selection.parameters, [
    { id: "reasoning_effort", value: "high" }, { id: "quality", value: "balanced" },
  ]);
  for (const { name, parameters } of [
    { name: "ambiguous", parameters: [{ id: "quality", value: "balanced" }] },
    { name: "invalid", parameters: [{ id: "reasoning_effort", value: "low" }] },
    { name: "duplicate", parameters: [{ id: "reasoning_effort", value: "high" }, { id: "reasoning_effort", value: "high" }] },
  ]) {
    await assert.rejects(catalog.resolveSelection("variant-terra", parameters), (error) => {
      assert.equal(error.code, "MODEL_UNAVAILABLE", name);
      return true;
    });
  }
  const panel = await catalog.panelModels();
  assert.deepEqual(panel[0].thinking, {
    parameterId: "reasoning_effort",
    values: [
      { value: "high", name: "high", parameters: [{ id: "reasoning_effort", value: "high" }, { id: "quality", value: "balanced" }] },
      { value: "xhigh", name: "xhigh", parameters: [{ id: "reasoning_effort", value: "xhigh" }, { id: "quality", value: "balanced" }] },
    ],
  });
  const oversized = modelsModule.normalizeCursorModelCatalog([{
    id: "too-many-variant-parameters",
    variants: [{ params: Array.from({ length: 17 }, (_, index) => ({ id: `parameter-${index}`, value: "selected" })) }],
  }]);
  assert.equal(oversized[0].variantsPresent, true);
  assert.equal(oversized[0].variantsComplete, false);
  assert.deepEqual(oversized[0].variants, []);
  const incompleteVariants = new modelsModule.CursorModelCatalog({
    async listModels() {
      return [{
        id: "variant-with-overlong-canonical-selection",
        parameters: [{ id: "reasoning_effort", values: [{ value: "xhigh" }] }],
        variants: [{ params: [{ id: "reasoning_effort", value: "xhigh" }, ...Array.from({ length: 16 }, (_, index) => ({ id: `parameter-${index}`, value: "selected" }))] }],
      }];
    },
  });
  await assert.rejects(incompleteVariants.resolveSelection("variant-with-overlong-canonical-selection", [{ id: "reasoning_effort", value: "xhigh" }]), (error) => {
    assert.equal(error.code, "MODEL_UNAVAILABLE");
    return true;
  });
});

test("model lookup refreshes once and never substitutes an unavailable target", async () => {
  let calls = 0;
  const catalog = new modelsModule.CursorModelCatalog({
    async listModels() {
      calls++;
      return calls === 1 ? [] : [{
        id: "catalog-terra",
        displayName: "GPT-5.6 Terra",
        parameters: [{ id: "custom_reasoning", displayName: "Reasoning effort", values: [{ value: "xhigh" }] }],
      }];
    },
  });
  assert.equal((await catalog.resolveProfile("balanced")).selection.id, "catalog-terra");
  assert.equal(calls, 2);
  await assert.rejects(catalog.resolveProfile("fast"), (error) => {
    assert.equal(error.code, "MODEL_UNAVAILABLE");
    assert.match(error.message, /GPT-5.6 Luna/);
    assert.match(error.message, /GPT-5.6 Terra/);
    return true;
  });
  assert.equal(calls, 3);
});

function userEntry(id, textOrBlocks) {
  const content = Array.isArray(textOrBlocks)
    ? textOrBlocks.map((text) => ({ type: "text", text }))
    : [{ type: "text", text: textOrBlocks }];
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
}

function assistantEntry(id, textOrBlocks, extra = {}) {
  const content = Array.isArray(textOrBlocks)
    ? textOrBlocks.map((text) => ({ type: "text", text }))
    : [{ type: "text", text: textOrBlocks }];
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content,
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 1,
      ...extra,
    },
  };
}

function toolEntry(id, text) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: [{ type: "text", text }], isError: true, timestamp: 1, details: { secret: text } },
  };
}

function sourceTextStats(entries) {
  let blocks = 0;
  let bytes = 0;
  for (const entry of entries) {
    const texts = entry.type === "message" && Array.isArray(entry.message.content)
      ? entry.message.content.filter((block) => block.type === "text").map((block) => block.text)
      : entry.type === "compaction" || entry.type === "branch_summary" ? [entry.summary] : [];
    blocks += texts.length;
    bytes += texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }
  return { blocks, bytes };
}

test("fork handoff redacts credentials, excludes tool and error fields, and persists bounded metadata", async () => {
  const secrets = [
    "https://alice:password-secret@github.com/example/repo?access_token=query-secret",
    "password = 'password-secret'\nclient_secret=query-secret\ntoken: token-secret\nauthorization: token-secret\nsession_token=token-secret",
    "Cookie: sessionid=cookie-sessionid-secret; connect.sid=cookie-connect-secret; jwt=cookie-jwt-secret\nSet-Cookie: session=cookie-session-secret; Path=/; HttpOnly\ncurl -H 'Cookie: sid=embedded-cookie-secret' https://example.invalid\ncurl -H \"Set-Cookie: session=embedded-set-cookie-secret; Path=/\" https://example.invalid\nsessionid=cookie-sessionid-secret\nconnect.sid=cookie-connect-secret\njwt=cookie-jwt-secret\nsession=cookie-session-secret",
    "-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----",
  ].join("\n");
  const branch = [
    userEntry("user-one", "Inspect the feature."),
    assistantEntry("assistant-one", "Reviewed source.\n```ts\nconst source = 'omit';\n```", {
      errorMessage: secrets,
      diagnostics: [{ type: "error", message: secrets }],
    }),
    toolEntry("tool-secret", secrets),
    assistantEntry("unterminated-code", "```ts\nconst unterminatedSourceSecret = 'omit through end';"),
    userEntry("user-latest", `Implement only WP4. ${secrets}`),
    assistantEntry("in-progress", "This in-progress tool call must not transfer."),
  ];
  let source;
  const handoff = await contextModule.createCursorForkHandoff(branch, {
    async generate(value) {
      source = value;
      return `## Goal\nWP4\n\`\`\`ts\nconst source = 'omit';\n\`\`\`\n${secrets}`;
    },
  });
  const sourceJson = JSON.stringify(source);
  for (const secret of ["password-secret", "query-secret", "token-secret", "private-secret", "cookie-sessionid-secret", "cookie-connect-secret", "cookie-jwt-secret", "cookie-session-secret", "embedded-cookie-secret", "embedded-set-cookie-secret", "const source", "unterminatedSourceSecret", "errorMessage", "tool-secret"]) {
    assert.doesNotMatch(sourceJson, new RegExp(secret));
  }
  assert.doesNotMatch(sourceJson, /(?:Cookie|Set-Cookie):/i);
  assert.equal(source.entries.some((entry) => entry.id === "in-progress"), false);
  assert.deepEqual(source.entryIds, ["user-one", "assistant-one", "unterminated-code", "user-latest"]);
  assert.ok(source.entryCount <= contextModule.MAX_CURSOR_FORK_SOURCE_ENTRIES);
  assert.ok(source.blockCount <= contextModule.MAX_CURSOR_FORK_SOURCE_BLOCKS);
  assert.ok(source.textBytes <= contextModule.MAX_CURSOR_FORK_SOURCE_BYTES);
  assert.doesNotMatch(handoff.summary, /password-secret|query-secret|token-secret|private-secret|cookie-sessionid-secret|cookie-connect-secret|cookie-jwt-secret|cookie-session-secret|embedded-cookie-secret|embedded-set-cookie-secret|const source|unterminatedSourceSecret/);
  assert.doesNotMatch(handoff.summary, /(?:Cookie|Set-Cookie):/i);
  const deliveredHash = createHash("sha256").update(handoff.summary, "utf8").digest("hex");
  const deliveredBytes = Buffer.byteLength(handoff.summary, "utf8");
  assert.equal(handoff.metadata.summarySha256, deliveredHash);
  assert.equal(handoff.metadata.summaryBytes, deliveredBytes);
  const persisted = contextModule.persistableCursorForkHandoff(handoff);
  assert.deepEqual(Object.keys(persisted).sort(), ["inheritedEntryIds", "latestUserEntryId", "mode", "summaryBytes", "summarySha256"]);
  assert.equal(persisted.summarySha256, deliveredHash);
  assert.equal(persisted.summaryBytes, deliveredBytes);
  assert.ok(persisted.inheritedEntryIds.length <= contextModule.MAX_CURSOR_FORK_SOURCE_IDS);
  assert.doesNotMatch(JSON.stringify(persisted), /Goal|source|secret/);
  const defensivePersisted = contextModule.persistableCursorForkHandoff({
    summary: "must not persist",
    metadata: {
      mode: "fork",
      inheritedEntryIds: Array.from({ length: 200 }, () => "secret-token"),
      latestUserEntryId: "password-secret",
      summarySha256: "summary-secret",
      summaryBytes: Number.POSITIVE_INFINITY,
    },
  });
  assert.equal(defensivePersisted.inheritedEntryIds.length, contextModule.MAX_CURSOR_FORK_SOURCE_IDS);
  assert.equal(defensivePersisted.summaryBytes, 0);
  assert.equal(defensivePersisted.summarySha256.length, 64);
  assert.doesNotMatch(JSON.stringify(defensivePersisted), /secret|must not persist/);
});

test("fork source bounds entries, blocks, text, IDs, and keeps the latest user request", () => {
  const branch = [];
  for (let index = 0; index < 120; index++) {
    branch.push(userEntry(`user-${index}`, Array.from({ length: 10 }, () => `user-${index}-${"x".repeat(3000)}`)));
    branch.push(assistantEntry(`assistant-${index}`, Array.from({ length: 10 }, () => `assistant-${index}-${"y".repeat(3000)}`), {
      errorMessage: "error-secret",
    }));
  }
  branch.push(toolEntry("tool-large", "tool-output-secret"));
  branch.push(userEntry("latest-user", "The required latest request."));
  const source = contextModule.prepareCursorForkSummarySource(branch);
  const observed = sourceTextStats(source.entries);
  assert.equal(source.entryCount, source.entries.length);
  assert.ok(source.entryCount <= contextModule.MAX_CURSOR_FORK_SOURCE_ENTRIES);
  assert.equal(source.blockCount, observed.blocks);
  assert.equal(source.textBytes, observed.bytes);
  assert.ok(observed.blocks <= contextModule.MAX_CURSOR_FORK_SOURCE_BLOCKS);
  assert.ok(observed.bytes <= contextModule.MAX_CURSOR_FORK_SOURCE_BYTES);
  assert.ok(source.entryIds.length <= contextModule.MAX_CURSOR_FORK_SOURCE_IDS);
  assert.equal(source.latestUserEntryId, "latest-user");
  assert.equal(source.entries.at(-1).id, "latest-user");
  const text = JSON.stringify(source);
  assert.doesNotMatch(text, /tool-output-secret|errorMessage|error-secret/);
});

test("fork handoff and follow-up respect UTF-8 byte limits", async () => {
  const oversized = "🙂".repeat(10_000);
  const handoff = await contextModule.createCursorForkHandoff([userEntry("utf8-user", "Summarize this.")], {
    async generate() { return oversized; },
  });
  const followUp = contextModule.buildCursorCloudFollowUp(oversized, "task");
  assert.ok(Buffer.byteLength(handoff.summary, "utf8") <= contextModule.MAX_CURSOR_FORK_SUMMARY_BYTES);
  assert.match(followUp, /Lifetime: task/);
  assert.match(followUp, /Inspect and plan only\. Do not edit, commit, push/i);
  assert.ok(Buffer.byteLength(followUp, "utf8") <= contextModule.MAX_CURSOR_FOLLOW_UP_BYTES);
  assert.match(handoff.summary, /\[Content limited\]$/);
  assert.match(followUp, /\[Content limited\]$/);
});

test("fork context rejects blank, no-user, and empty-summary input", async () => {
  for (const { name, operation } of [
    { name: "blank user", operation: () => contextModule.prepareCursorForkSummarySource([userEntry("blank", "  ")]) },
    { name: "no user", operation: () => contextModule.prepareCursorForkSummarySource([assistantEntry("assistant", "Only an assistant message.")]) },
    { name: "empty summary", operation: () => contextModule.createCursorForkHandoff([userEntry("user", "Request")], { async generate() { return " "; } }) },
  ]) {
    await assert.rejects(Promise.resolve().then(operation), (error) => {
      assert.equal(error.code, "BACKEND_FAILED", name);
      return true;
    });
  }
});

test("Pi fork generator uses active model, model registry auth, injected primitive, and in-memory branch", async () => {
  const branch = [userEntry("ephemeral-user", "Summarize this in memory.")];
  const signal = new AbortController().signal;
  let primitiveCalls = 0;
  const handoff = await contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 128000 },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "pi-summary-secret", headers: { Authorization: "Bearer pi-summary-secret" } };
        },
      },
      sessionManager: { getBranch: () => branch },
    },
    signal,
    async generate(entries, options) {
      primitiveCalls++;
      assert.equal(entries.at(-1).id, "ephemeral-user");
      assert.equal(options.signal, signal);
      assert.equal(options.reserveTokens, 122000);
      assert.match(options.customInstructions, /Do not include credentials/);
      return { summary: "## Goal\nUse the active Pi model." };
    },
  });
  assert.equal(primitiveCalls, 1);
  assert.equal(handoff.summary, "## Goal\nUse the active Pi model.");
  assert.doesNotMatch(JSON.stringify(contextModule.persistableCursorForkHandoff(handoff)), /pi-summary-secret/);
  await assert.rejects(contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 128000 },
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: false, error: "secret failure" }; } },
      sessionManager: { getBranch: () => branch },
    },
    signal,
  }), /fork context could not be created/);
  await assert.rejects(contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 128000 },
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "pi-summary-secret" }; } },
      sessionManager: { getBranch: () => branch },
    },
    signal,
    async generate() { return { error: "pi-summary-secret" }; },
  }), (error) => {
    assert.match(error.message, /fork context could not be created/);
    assert.doesNotMatch(error.message, /pi-summary-secret/);
    return true;
  });
  let moderateReserveTokens;
  await contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 20_000 },
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "pi-summary-secret" }; } },
      sessionManager: { getBranch: () => branch },
    },
    signal,
    async generate(_entries, options) {
      moderateReserveTokens = options.reserveTokens;
      return { summary: "Moderate context succeeded." };
    },
  });
  assert.equal(moderateReserveTokens, 16_384);
  assert.equal(20_000 - moderateReserveTokens, 3_616);
  assert.ok(20_000 - moderateReserveTokens > 0 && 20_000 - moderateReserveTokens <= 6_000);
  let lowContextCalls = 0;
  await assert.rejects(contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 2_560 },
      modelRegistry: { async getApiKeyAndHeaders() { return { ok: true, apiKey: "pi-summary-secret" }; } },
      sessionManager: { getBranch: () => branch },
    },
    signal,
    async generate() { lowContextCalls++; return { summary: "must not run" }; },
  }), /fork context could not be created/);
  assert.equal(lowContextCalls, 0);
  const aborted = new AbortController();
  aborted.abort();
  let abortedAuthCalls = 0;
  let abortedPrimitiveCalls = 0;
  await assert.rejects(contextModule.createCursorForkHandoffWithPiSummary({
    context: {
      model: { contextWindow: 128_000 },
      modelRegistry: { async getApiKeyAndHeaders() { abortedAuthCalls++; return { ok: true, apiKey: "pi-summary-secret" }; } },
      sessionManager: { getBranch: () => branch },
    },
    signal: aborted.signal,
    async generate() { abortedPrimitiveCalls++; return { summary: "must not run" }; },
  }), /fork context could not be created/);
  assert.equal(abortedAuthCalls, 0);
  assert.equal(abortedPrimitiveCalls, 0);
});

test("Cloud bootstrap keeps explicit code and redacts tested credential fields", async () => {
  const code = "```ts\nconst source = 'keep';\n```";
  const secrets = "https://user:password-secret@example.invalid/?access_token=query-secret\npassword='password-secret'\nclient_secret=query-secret\nauthorization: token-secret\nCookie: sessionid=cookie-sessionid-secret; connect.sid=cookie-connect-secret; jwt=cookie-jwt-secret\nSet-Cookie: session=cookie-session-secret; Path=/; HttpOnly\ncurl -H 'Cookie: sid=embedded-cookie-secret' https://example.invalid\ncurl -H \"Set-Cookie: session=embedded-set-cookie-secret; Path=/\" https://example.invalid\nsessionid=cookie-sessionid-secret\nconnect.sid=cookie-connect-secret\njwt=cookie-jwt-secret\nsession=cookie-session-secret\n-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----";
  const bootstrap = contextModule.buildCursorCloudBootstrap({
    mode: "fresh",
    persona: { name: "cloud-scout", systemPrompt: `${code}\n${secrets}`, cursorMcps: ["datadog", "sentry"] },
    purpose: "Inspect Cloud evidence",
    lifetime: "task",
    parentContext: `${code}\n${secrets}`,
    request: `${code}\n${secrets}`,
  });
  for (const value of ["password-secret", "query-secret", "token-secret", "private-secret", "cookie-sessionid-secret", "cookie-connect-secret", "cookie-jwt-secret", "cookie-session-secret", "embedded-cookie-secret", "embedded-set-cookie-secret"]) assert.doesNotMatch(bootstrap, new RegExp(value));
  assert.doesNotMatch(bootstrap, /(?:Cookie|Set-Cookie):/i);
  assert.match(bootstrap, /const source = 'keep'/);
  assert.match(bootstrap, /Expected MCP servers: datadog, sentry/);
  const forkBootstrap = contextModule.buildCursorCloudBootstrap({
    mode: "fork",
    purpose: "Continue the analysis",
    lifetime: "task",
    request: "Continue from the inherited facts.",
    forkHandoff: { summary: "## Goal\nContinue safely.", metadata: { mode: "fork", inheritedEntryIds: [], latestUserEntryId: "user", summarySha256: "a".repeat(64), summaryBytes: 25 } },
  });
  assert.match(forkBootstrap, /## Inherited Pi context/);
  assert.match(forkBootstrap, /Continue safely/);
  const followUp = contextModule.buildCursorCloudFollowUp(`${code}\nCookie: sessionid=followup-cookie-secret; jwt=followup-jwt-secret\nsession=followup-session-secret`, "task");
  assert.match(followUp, /Lifetime: task/);
  assert.match(followUp, /const source = 'keep'/);
  assert.doesNotMatch(followUp, /followup-cookie-secret|followup-jwt-secret|followup-session-secret|(?:Cookie|Set-Cookie):/i);
  assert.throws(() => contextModule.buildCursorCloudBootstrap({
    mode: "fork", purpose: "Inspect", lifetime: "task", request: "Do work",
  }), /fork context could not be created/);
});

test("Cursor SDK exhausts paginated runs, deduplicates IDs, and reports a page safety bound", async () => {
  const calls = [];
  const paginated = new sdkModule.CursorSdkGateway({
    getApiKey: () => "key",
    load: async () => ({
      async listRuns(_agentId, options) {
        calls.push(options.cursor);
        if (!options.cursor) return { items: [{ id: "run-a" }, { id: "run-b" }], nextCursor: "page-2" };
        return { items: [{ id: "run-b" }, { id: "run-c" }] };
      },
    }),
  });
  assert.deepEqual(await paginated.listRuns("bc-pages"), {
    runs: [{ id: "run-a" }, { id: "run-b" }, { id: "run-c" }], complete: true,
  });
  assert.deepEqual(calls, [undefined, "page-2"]);

  let pages = 0;
  const bounded = new sdkModule.CursorSdkGateway({
    getApiKey: () => "key",
    load: async () => ({
      async listRuns(_agentId, options) {
        pages++;
        return { items: [{ id: `run-${options.cursor ?? "first"}` }], nextCursor: `page-${pages}` };
      },
    }),
  });
  const incomplete = await bounded.listRuns("bc-incomplete-pages");
  assert.equal(incomplete.complete, false);
  assert.equal(pages, sdkModule.MAX_CURSOR_RUN_LIST_PAGES);
  assert.equal(incomplete.runs.length, sdkModule.MAX_CURSOR_RUN_LIST_PAGES);

  let oversizedCursorCalls = 0;
  const oversizedCursor = new sdkModule.CursorSdkGateway({
    getApiKey: () => "key",
    load: async () => ({
      async listRuns() {
        oversizedCursorCalls++;
        return { items: [{ id: "run-first" }], nextCursor: "x".repeat(sdkModule.MAX_CURSOR_RUN_LIST_CURSOR_CHARS + 1) };
      },
    }),
  });
  assert.deepEqual(await oversizedCursor.listRuns("bc-oversized-cursor"), {
    runs: [{ id: "run-first" }], complete: false,
  });
  assert.equal(oversizedCursorCalls, 1, "an oversized opaque cursor is never reused");
});
