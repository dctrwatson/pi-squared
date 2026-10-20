import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import githubReadModule, { createGitHubReadTool } from "../../extensions/github-read/index.ts";

const issueUrl = "https://github.com/acme/widgets/issues/7";
const pullUrl = "https://github.com/acme/widgets/pull/8";
const createdAt = "2026-02-03T04:05:06Z";
const updatedAt = "2026-02-04T04:05:06Z";
const tool = createGitHubReadTool();

async function fakeGh(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-github-read-"));
  const state = join(root, "responses.json");
  const log = join(root, "calls.jsonl");
  const home = join(root, "home");
  await mkdir(home);
  await symlink(process.execPath, join(root, "node"));
  const names = ["PATH", "HOME", "GH_HOST", "GITHUB_READ_FAKE_STATE", "GITHUB_READ_FAKE_LOG"];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  await writeFile(join(root, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cliEndpoint = args[0] === "api" ? args[1] : "";
const endpoint = cliEndpoint === "graphql" ? "/graphql" : cliEndpoint;
const method = args[args.indexOf("--method") + 1];
const fields = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-F") { const field = args[++i]; const at = field.indexOf("="); fields[field.slice(0, at)] = field.slice(at + 1); }
}
fs.appendFileSync(process.env.GITHUB_READ_FAKE_LOG, JSON.stringify({args,cliEndpoint,endpoint,method,fields}) + "\\n");
if (cliEndpoint === "/graphql" && method === "POST") { process.stderr.write("gh GraphQL endpoint must be graphql"); process.exit(78); }
if (endpoint === "/graphql") {
  const declaration = /^query\\s*\\(([^)]*)\\)/.exec(fields.query || "")?.[1] || "";
  const required = [...declaration.matchAll(/\\$([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*[^,)]*!/g)].map((match) => match[1]);
  if (cliEndpoint !== "graphql" || method !== "POST" || args.includes("-f") || !fields.query?.startsWith("query") || required.some((name) => fields[name] === undefined)) { process.stderr.write("Invalid GraphQL variable envelope"); process.exit(79); }
}
const rules = JSON.parse(fs.readFileSync(process.env.GITHUB_READ_FAKE_STATE, "utf8"));
const priorCalls = fs.readFileSync(process.env.GITHUB_READ_FAKE_LOG, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line));
const occurrence = priorCalls.filter(call => call.endpoint === endpoint && call.method === method).length;
const matching = rules.filter(rule => rule.endpoint === endpoint && (rule.method || "GET") === method && Object.entries(rule.fields || {}).every(([key,value]) => fields[key] === value));
const selected = matching.find(rule => rule.occurrence === occurrence) || matching.find(rule => rule.occurrence === undefined);
if (!selected) { process.stderr.write("No fake response for " + method + " " + endpoint); process.exit(77); }
function respond() {
  if (selected.raw !== undefined) process.stdout.write(selected.raw);
  else {
    const headers = Object.entries(selected.headers || {}).map(([key,value]) => key + ": " + value + "\\r\\n").join("");
    process.stdout.write("HTTP/2.0 " + (selected.status || 200) + " Fake status\\r\\n" + headers + "\\r\\n" + (selected.json === undefined ? "" : JSON.stringify(selected.json)));
  }
  if (selected.exit) { process.stderr.write(selected.error || "Synthetic gh failure"); process.exit(selected.exit); }
}
if (selected.delay) setTimeout(respond, selected.delay); else respond();
`);
  await chmod(join(root, "gh"), 0o755);
  process.env.PATH = root;
  process.env.HOME = home;
  process.env.GH_HOST = "unsafe.example.invalid";
  process.env.GITHUB_READ_FAKE_STATE = state;
  process.env.GITHUB_READ_FAKE_LOG = log;
  t.after(async () => {
    for (const [name, value] of original) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(root, { recursive: true, force: true });
  });
  return {
    async set(rules) { await writeFile(state, JSON.stringify(rules)); await writeFile(log, ""); },
    async calls() { return (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async wait(count) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await this.calls()).length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Fake gh did not receive the expected request");
    },
  };
}

function response(endpoint, json, extra = {}) { return { endpoint, json, ...extra }; }
function changedFile(filename, extra = {}) {
  return { filename, status: "modified", additions: 2, deletions: 1, changes: 3, ...extra };
}
function pullMetadata(changedFiles = 1) {
  return { number: 8, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) }, changed_files: changedFiles };
}
function item(kind, number, body, extra = {}) {
  return {
    html_url: kind === "pr" ? pullUrl : issueUrl,
    url: `https://api.github.com/repos/acme/widgets/${kind === "pr" ? "pulls" : "issues"}/${number}`,
    number,
    title: kind === "pr" ? "Pull request title" : "Issue title",
    state: "open",
    updated_at: updatedAt,
    user: { login: "alice" },
    assignees: [{ login: "bob" }],
    body,
    ...extra,
  };
}
function comment(id, body, route = issueUrl) {
  return { id, html_url: `${route}#issuecomment-${id}`, user: { login: "alice" }, created_at: createdAt, updated_at: updatedAt, body };
}
function review(id, body) {
  return { id, html_url: `${pullUrl}#pullrequestreview-${id}`, user: { login: "reviewer" }, submitted_at: createdAt, state: "APPROVED", body };
}
function graphComment(id, databaseId, body) {
  return { id, databaseId, url: `${pullUrl}#discussion_r${databaseId}`, author: { login: "reviewer" }, createdAt, updatedAt, body };
}
function content(result) {
  const entry = result.content.find((part) => part.type === "text");
  assert.ok(entry);
  return entry.text;
}
function invoke(input, signal) { return tool.execute("test-call", input, signal, undefined, {}); }
function assertStructured(result) {
  assert.deepEqual(result.details, result.structuredContent);
  assert.deepEqual(JSON.parse(content(result)), result.structuredContent);
  assert.ok(Buffer.byteLength(content(result), "utf8") <= 64 * 1024);
}

await test("github_read exposes structured read-only input and bounded issue/PR body windows", async (t) => {
  const gh = await fakeGh(t);
  assert.equal(tool.name, "github_read");
  assert.ok(tool.outputSchema);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  let automaticallyRegistered = false;
  githubReadModule({ registerTool() { automaticallyRegistered = true; } });
  assert.equal(automaticallyRegistered, false);

  const issueBody = `A😀"\\\n${"🙂".repeat(8_005)}`;
  await gh.set([
    response("/repos/acme/widgets/issues/7", item("issue", 7, issueBody, { state_reason: "completed" })),
    response("/repos/acme/widgets/pulls/8", item("pr", 8, "PR body", { draft: true, merged: false, mergeable: null, mergeable_state: "unknown" })),
  ]);

  const issueResult = await invoke({ action: "read", url: `${issueUrl}?tab=comments#top`, bodyOffset: 1, bodyLimit: 4 });
  assertStructured(issueResult);
  const issue = issueResult.structuredContent.data;
  assert.equal(issue.url, issueUrl);
  assert.equal(issue.kind, "issue");
  assert.equal(issue.title, "Issue title");
  assert.equal(issue.body, "😀\"\\\n");
  assert.equal(issue.bodyOffset, 1);
  assert.equal(issue.bodyLength, 8_000);
  assert.equal(issue.bodyTruncated, true);
  assert.equal(issue.bodyWindowTruncated, true);
  assert.match(issue.sourceTruncationNotice, /at most 8,000 Unicode code points/);
  assert.equal(issue.stateReason, "completed");
  assert.equal(new Date(issue.observedAt).toISOString(), issue.observedAt);

  const prResult = await invoke({ action: "read", url: pullUrl });
  assertStructured(prResult);
  const pr = prResult.structuredContent.data;
  assert.equal(pr.kind, "pr");
  assert.equal(pr.draft, true);
  assert.equal(pr.merged, false);
  assert.equal(pr.mergeable, null);
  assert.equal(pr.mergeState, "unknown");
  assert.equal(pr.body, "PR body");
  assert.equal(pr.bodyWindowTruncated, false);

  const calls = await gh.calls();
  assert.deepEqual(calls.map((call) => call.endpoint), ["/repos/acme/widgets/issues/7", "/repos/acme/widgets/pulls/8"]);
  assert.ok(calls.every((call) => call.method === "GET" && call.args.includes("--hostname") && call.args[call.args.indexOf("--hostname") + 1] === "github.com"));
  assert.ok(calls.every((call) => call.args[0] === "api" && call.args[2] === "--hostname"));
  assert.ok(calls.every((call) => !call.args.includes("--paginate")));
  const itemProjection = calls[0].args[calls[0].args.indexOf("--jq") + 1];
  assert.match(itemProjection, /body\[0:8001\]/);
});

await test("github_read pages discussion comments and windows only the selected entry", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([response("/repos/acme/widgets/issues/7/comments", [
    comment(101, "first " + "x".repeat(500)),
    comment(102, "A😀\"\\\n" + "🙂".repeat(8_005)),
  ], { fields: { page: "2", per_page: "2" } })]);

  const result = await invoke({ action: "comments", url: issueUrl, page: 2, perPage: 2, entryId: "102", bodyOffset: 1, bodyLimit: 4 });
  assertStructured(result);
  const discussion = result.structuredContent.data;
  assert.equal(discussion.source, "comments");
  assert.equal(discussion.kind, "issue");
  assert.equal(discussion.page, 2);
  assert.equal(discussion.perPage, 2);
  assert.equal(discussion.nextPage, 3);
  assert.equal(discussion.eof, false);
  assert.equal(discussion.coverage, "page");
  assert.equal(discussion.items[0].bodyExcerpt, true);
  assert.equal(discussion.items[0].body.length, 400);
  assert.equal(discussion.items[1].body, "😀\"\\\n");
  assert.equal(discussion.items[1].bodyOffset, 1);
  assert.equal(discussion.items[1].bodyLength, 8_000);
  assert.equal(discussion.items[1].bodyTruncated, true);
  assert.equal(discussion.items[1].bodyWindowTruncated, true);
  assert.match(discussion.sourceTruncationNotice, /at most 8,000 Unicode code points/);
  assert.equal((await gh.calls())[0].endpoint, "/repos/acme/widgets/issues/7/comments");
});

await test("github_read supports PR reviews, review threads, and thread comment cursors", async (t) => {
  const gh = await fakeGh(t);
  const threadId = "PRRT_Thread123";
  const cursor = "Y3Vyc29yLTI=";
  await gh.set([
    response("/repos/acme/widgets/pulls/8/reviews", [review(21, "Approved")]),
    response("/graphql", {
      errors: [],
      data: { repository: { pullRequest: { url: pullUrl, reviewThreads: {
        nodes: [{ id: threadId, isResolved: false, isOutdated: true, path: "src/file.ts", comments: { totalCount: 2, nodes: [graphComment("PRRC_Comment1", 31, "Thread preview")], pageInfo: { hasNextPage: true, endCursor: cursor } } }],
        pageInfo: { hasNextPage: true, endCursor: "dGhyZWFkLTI=" },
      } } } },
    }, { method: "POST", fields: { number: "8" } }),
    response("/graphql", {
      errors: [],
      data: { node: { id: threadId, pullRequest: { url: pullUrl }, comments: { nodes: [graphComment("PRRC_Comment2", 32, "Thread reply")], pageInfo: { hasNextPage: false, endCursor: cursor } } } },
    }, { method: "POST", fields: { threadId, after: cursor } }),
  ]);

  const reviewResult = await invoke({ action: "comments", url: pullUrl, source: "reviews" });
  assertStructured(reviewResult);
  assert.equal(reviewResult.structuredContent.data.items[0].state, "APPROVED");
  assert.equal(reviewResult.structuredContent.data.items[0].body, "Approved");
  assert.equal(reviewResult.structuredContent.data.coverage, "source_complete");

  const threadsResult = await invoke({ action: "comments", url: pullUrl, source: "threads", entryId: threadId });
  assertStructured(threadsResult);
  const threads = threadsResult.structuredContent.data;
  assert.equal(threads.items[0].id, threadId);
  assert.equal(threads.items[0].path, "src/file.ts");
  assert.equal(threads.items[0].resolved, false);
  assert.equal(threads.items[0].hasMoreComments, true);
  assert.equal(threads.items[0].body, "Thread preview");
  assert.equal(threads.nextCursor, "dGhyZWFkLTI=");
  assert.equal(threads.coverage, "page");

  const commentsResult = await invoke({ action: "comments", url: pullUrl, source: "thread_comments", threadId, cursor, perPage: 2 });
  assertStructured(commentsResult);
  assert.equal(commentsResult.structuredContent.ok, true, JSON.stringify(commentsResult.structuredContent));
  assert.equal(commentsResult.structuredContent.data.threadId, threadId);
  assert.equal(commentsResult.structuredContent.data.cursor, cursor);
  assert.equal(commentsResult.structuredContent.data.items[0].body, "Thread reply");
  assert.equal(commentsResult.structuredContent.data.eof, true);
  assert.equal(commentsResult.structuredContent.data.coverage, "page");
  const calls = await gh.calls();
  assert.equal(calls[0].endpoint, "/repos/acme/widgets/pulls/8/reviews");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].cliEndpoint, "graphql");
  assert.deepEqual({ owner: calls[1].fields.owner, name: calls[1].fields.name, number: calls[1].fields.number, first: calls[1].fields.first }, { owner: "acme", name: "widgets", number: "8", first: "5" });
  assert.match(calls[1].fields.query, /^query\(\$owner:String!,\$name:String!,\$number:Int!,\$first:Int!/);
  assert.equal(calls.length, 3, JSON.stringify(commentsResult.structuredContent));
  assert.equal(calls[2].cliEndpoint, "graphql");
  assert.equal(calls[2].fields.threadId, threadId);
  assert.equal(calls[2].fields.after, cursor);
});

await test("github_read returns changed paths independently of long bot comments", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(2)),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("infra/first.yaml", { patch: "-old\n+new" }), changedFile("infra/second.yaml", { status: "renamed", previous_filename: "infra/old-second.yaml" })], { fields: { page: "1", per_page: "100" } }),
    response("/repos/acme/widgets/issues/8/comments", [{ ...comment(901, "noise".repeat(8_000), pullUrl), user: { login: "github-actions[bot]" } }]),
  ]);

  const result = await invoke({ action: "files", url: pullUrl });
  assertStructured(result);
  assert.equal(result.structuredContent.action, "files");
  const files = result.structuredContent.data;
  assert.equal(files.baseSha, "a".repeat(40));
  assert.equal(files.headSha, "b".repeat(40));
  assert.equal(files.totalChangedFiles, 2);
  assert.deepEqual(files.items.map((entry) => entry.path), ["infra/first.yaml", "infra/second.yaml"]);
  assert.equal(files.items[1].previousPath, "infra/old-second.yaml");
  assert.equal(files.items[1].previousPathTruncated, false);
  assert.equal(files.coverage, "source_complete");
  assert.equal(files.eof, true);
  assert.equal(files.patchLimit, 512);
  assert.equal(files.snapshotStable, true);
  assert.equal(files.items[0].patchAvailable, true);
  assert.equal(files.items[0].patch, "-old\n+new");
  assert.equal(files.items[0].patchTruncated, false);
  const calls = await gh.calls();
  assert.deepEqual(calls.map((call) => call.endpoint), ["/repos/acme/widgets/pulls/8", "/repos/acme/widgets/pulls/8/files", "/repos/acme/widgets/pulls/8"]);
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.match(calls[1].args[calls[1].args.indexOf("--jq") + 1], /filename.*patch/);

  const noPatchText = await invoke({ action: "files", url: pullUrl, patchLimit: 0 });
  assertStructured(noPatchText);
  assert.equal(noPatchText.structuredContent.data.items[0].patch, "");
  assert.equal(noPatchText.structuredContent.data.items[0].patchAvailable, true);
  assert.equal(noPatchText.structuredContent.data.items[0].patchTruncated, true);
});

await test("github_read reads 100 compact files in one API page with three gh requests", async (t) => {
  const gh = await fakeGh(t);
  const files = Array.from({ length: 100 }, (_, index) => changedFile(`src/file-${String(index).padStart(3, "0")}.ts`));
  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(100)),
    response("/repos/acme/widgets/pulls/8/files", files, { fields: { page: "1", per_page: "100" } }),
  ]);

  const result = await invoke({ action: "files", url: pullUrl });
  assertStructured(result);
  const data = result.structuredContent.data;
  assert.equal(data.perPage, 100);
  assert.equal(data.itemOffset, 0);
  assert.equal(data.items.length, 100);
  assert.deepEqual(data.items.map((entry) => entry.path), files.map((entry) => entry.filename));
  assert.equal(data.eof, true);
  assert.equal(data.coverage, "source_complete");
  const calls = await gh.calls();
  assert.deepEqual(calls.map((call) => call.endpoint), ["/repos/acme/widgets/pulls/8", "/repos/acme/widgets/pulls/8/files", "/repos/acme/widgets/pulls/8"]);
  assert.equal(calls[1].fields.per_page, "100");
});

await test("github_read windows large escaped file pages exactly once within the output limit", async (t) => {
  const gh = await fakeGh(t);
  const files = Array.from({ length: 100 }, (_, index) => {
    const tag = String(index).padStart(3, "0");
    return changedFile(`${tag}😀${"\0".repeat(508)}`, {
      status: "renamed",
      previous_filename: `old${tag}😀${"\0".repeat(505)}`,
      patch: `😀${"\0".repeat(511)}`,
    });
  });
  const captureBytes = Buffer.byteLength(JSON.stringify(files), "utf8");
  assert.ok(captureBytes > 256 * 1024 && captureBytes < 1024 * 1024);
  const expectedPaths = files.map((entry) => entry.filename);
  const expectedPreviousPaths = files.map((entry) => entry.previous_filename);
  const seenPaths = [];
  const seenPreviousPaths = [];
  let itemOffset = 0;

  while (true) {
    await gh.set([
      response("/repos/acme/widgets/pulls/8", pullMetadata(100)),
      response("/repos/acme/widgets/pulls/8/files", files, { fields: { page: "1", per_page: "100" } }),
    ]);
    const originalStringify = JSON.stringify;
    let fileItemSerializations = 0;
    JSON.stringify = function (...args) {
      const value = args[0];
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.path === "string" && typeof value.patch === "string" && typeof value.patchAvailable === "boolean") fileItemSerializations += 1;
      return Reflect.apply(originalStringify, JSON, args);
    };
    let result;
    try {
      result = await invoke({ action: "files", url: pullUrl, perPage: 100, itemOffset });
    } finally {
      JSON.stringify = originalStringify;
    }
    assert.equal(fileItemSerializations, files.length);
    assertStructured(result);
    const data = result.structuredContent.data;
    assert.equal(data.page, 1);
    assert.equal(data.perPage, 100);
    assert.equal(data.itemOffset, itemOffset);
    assert.ok(data.items.length > 0);
    seenPaths.push(...data.items.map((entry) => entry.path));
    seenPreviousPaths.push(...data.items.map((entry) => entry.previousPath));
    assert.equal(data.snapshotStable, true);
    if (data.nextItemOffset === undefined) {
      assert.equal(data.eof, true);
      assert.equal(data.coverage, "page");
      assert.equal(Object.hasOwn(data, "nextPage"), false);
      break;
    }
    assert.ok(data.nextItemOffset > itemOffset);
    assert.equal(data.eof, false);
    assert.equal(data.coverage, "page");
    assert.equal(Object.hasOwn(data, "nextPage"), false);
    itemOffset = data.nextItemOffset;
  }

  assert.ok(itemOffset > 0);
  assert.deepEqual(seenPaths, expectedPaths);
  assert.deepEqual(seenPreviousPaths, expectedPreviousPaths);
  assert.equal(new Set(seenPaths).size, 100);
  assert.equal(new Set(seenPreviousPaths).size, 100);
  assert.equal((await gh.calls()).length, 3);
});

await test("github_read reads merged PR revisions and rejects missing or malformed base/head SHAs", async (t) => {
  const gh = await fakeGh(t);
  const pullEndpoint = "/repos/acme/widgets/pulls/8";
  const filesEndpoint = `${pullEndpoint}/files`;
  const mergedMetadata = {
    number: 8,
    merged: true,
    merged_at: "2026-02-05T04:05:06Z",
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    changed_files: 1,
  };
  await gh.set([
    response(pullEndpoint, mergedMetadata),
    response(filesEndpoint, [changedFile("src/merged.ts")], { fields: { page: "1", per_page: "100" } }),
  ]);

  const merged = await invoke({ action: "files", url: pullUrl });
  assertStructured(merged);
  assert.equal(merged.structuredContent.ok, true, JSON.stringify(merged.structuredContent));
  assert.equal(merged.structuredContent.data.baseSha, "a".repeat(40));
  assert.equal(merged.structuredContent.data.headSha, "b".repeat(40));
  assert.equal(merged.structuredContent.data.coverage, "source_complete");
  assert.equal(merged.structuredContent.data.snapshotStable, true);
  const metadataCall = (await gh.calls())[0];
  assert.equal(metadataCall.args[metadataCall.args.indexOf("--jq") + 1], "{number,base:{sha:.base.sha},head:{sha:.head.sha},changed_files}");

  const invalidRevisions = [
    { revision: "base", metadata: { ...mergedMetadata, base: null } },
    { revision: "base", metadata: { ...mergedMetadata, base: {} } },
    { revision: "base", metadata: { ...mergedMetadata, base: { sha: "a".repeat(39) } } },
    { revision: "head", metadata: { ...mergedMetadata, head: null } },
    { revision: "head", metadata: { ...mergedMetadata, head: {} } },
    { revision: "head", metadata: { ...mergedMetadata, head: { sha: "g".repeat(40) } } },
  ];
  for (const scenario of invalidRevisions) {
    await gh.set([response(pullEndpoint, scenario.metadata)]);
    const result = await invoke({ action: "files", url: pullUrl });
    assertStructured(result);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "invalid_pull_request_revision");
    assert.match(result.structuredContent.error.message, new RegExp(`valid ${scenario.revision} SHA`));
    assert.match(result.structuredContent.error.message, /Exact changed-file coverage cannot be reported/);
    assert.equal(Object.hasOwn(result.structuredContent, "data"), false);
    assert.deepEqual((await gh.calls()).map((call) => call.endpoint), [pullEndpoint]);
  }
});

await test("github_read does not return files when confirmation metadata has an invalid base/head SHA", async (t) => {
  const gh = await fakeGh(t);
  const pullEndpoint = "/repos/acme/widgets/pulls/8";
  const filesEndpoint = `${pullEndpoint}/files`;
  const initialMetadata = pullMetadata(1);
  const invalidConfirmations = [
    { revision: "base", metadata: { ...initialMetadata, base: {} } },
    { revision: "base", metadata: { ...initialMetadata, base: { sha: "a".repeat(39) } } },
    { revision: "head", metadata: { ...initialMetadata, head: {} } },
    { revision: "head", metadata: { ...initialMetadata, head: { sha: "g".repeat(40) } } },
  ];

  for (const scenario of invalidConfirmations) {
    await gh.set([
      response(pullEndpoint, initialMetadata),
      response(filesEndpoint, [changedFile("src/confirmed.ts")], { fields: { page: "1", per_page: "100" } }),
      response(pullEndpoint, scenario.metadata, { occurrence: 2 }),
    ]);
    const result = await invoke({ action: "files", url: pullUrl });
    assertStructured(result);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "invalid_pull_request_revision");
    assert.match(result.structuredContent.error.message, new RegExp(`valid ${scenario.revision} SHA`));
    assert.match(result.structuredContent.error.message, /Exact changed-file coverage cannot be reported/);
    assert.equal(Object.hasOwn(result.structuredContent, "data"), false);
    assert.deepEqual((await gh.calls()).map((call) => call.endpoint), [pullEndpoint, filesEndpoint, pullEndpoint]);
  }
});

await test("github_read pages changed files, bounds patches, and reports API coverage gaps", async (t) => {
  const gh = await fakeGh(t);
  const firstMetadata = pullMetadata(3);
  await gh.set([
    response("/repos/acme/widgets/pulls/8", firstMetadata),
    response("/repos/acme/widgets/pulls/8/files", [
      changedFile("src/first.ts", { patch: "abcdef" }),
      changedFile("src/second.ts", { status: "renamed", previous_filename: "src/old-second.ts", patch: "-old\n+new" }),
    ], { fields: { page: "1", per_page: "2" } }),
    response("/repos/acme/widgets/pulls/8", firstMetadata),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("src/third.ts", { patch: "" })], { fields: { page: "2", per_page: "2" } }),
    response("/repos/acme/widgets/pulls/8", pullMetadata(3_001)),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("src/first.ts")], { fields: { page: "1", per_page: "1" } }),
  ]);

  const first = await invoke({ action: "files", url: pullUrl, perPage: 2, patchLimit: 2 });
  assertStructured(first);
  const firstPage = first.structuredContent.data;
  assert.equal(firstPage.coverage, "page");
  assert.equal(firstPage.nextPage, 2);
  assert.equal(firstPage.items[0].patch, "ab");
  assert.equal(firstPage.items[0].patchTruncated, true);
  assert.equal(firstPage.items[1].patch, "-o");
  assert.equal(firstPage.items[1].patchTruncated, true);
  assert.equal(firstPage.items[1].previousPath, "src/old-second.ts");
  assert.equal(firstPage.items[1].previousPathTruncated, false);

  const second = await invoke({ action: "files", url: pullUrl, page: 2, perPage: 2, patchLimit: 2 });
  assertStructured(second);
  assert.equal(second.structuredContent.data.eof, true);
  assert.equal(second.structuredContent.data.coverage, "page");
  assert.equal(second.structuredContent.data.items[0].patchAvailable, true);
  assert.equal(second.structuredContent.data.items[0].patchTruncated, false);

  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(3_001)),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("src/first.ts")], { fields: { page: "1", per_page: "1" } }),
  ]);
  const gap = await invoke({ action: "files", url: pullUrl, perPage: 1 });
  assertStructured(gap);
  assert.equal(gap.structuredContent.data.coverage, "gap");
  assert.ok(gap.structuredContent.data.gapReasons.includes("github_file_limit"));
  assert.equal(gap.structuredContent.data.totalChangedFiles, 3_001);
});

await test("github_read reports PR changes during a changed-files read as a gap", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(1), { occurrence: 1 }),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("src/file.ts")], { fields: { page: "1", per_page: "100" } }),
    response("/repos/acme/widgets/pulls/8", { ...pullMetadata(1), head: { sha: "c".repeat(40) } }, { occurrence: 2 }),
  ]);
  const result = await invoke({ action: "files", url: pullUrl });
  assertStructured(result);
  assert.equal(result.structuredContent.data.snapshotStable, false);
  assert.equal(result.structuredContent.data.coverage, "gap");
  assert.ok(result.structuredContent.data.gapReasons.includes("metadata_mismatch"));
});

await test("github_read marks truncated changed paths as a coverage gap and validates files inputs", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(1)),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("x".repeat(513))], { fields: { page: "1", per_page: "100" } }),
  ]);
  const pathResult = await invoke({ action: "files", url: pullUrl });
  assertStructured(pathResult);
  assert.equal(pathResult.structuredContent.data.coverage, "gap");
  assert.ok(pathResult.structuredContent.data.gapReasons.includes("path_truncated"));
  assert.equal(pathResult.structuredContent.data.items[0].path.length, 512);
  assert.equal(pathResult.structuredContent.data.items[0].pathTruncated, true);

  await gh.set([]);
  for (const input of [
    { action: "files", url: issueUrl },
    { action: "files", url: pullUrl, perPage: 101 },
    { action: "files", url: pullUrl, itemOffset: 100 },
    { action: "files", url: pullUrl, perPage: 2, itemOffset: 2 },
    { action: "files", url: pullUrl, patchLimit: 513 },
    { action: "files", url: pullUrl, bodyOffset: 1 },
    { action: "comments", url: pullUrl, patchLimit: 1 },
  ]) await assert.rejects(invoke(input), /Invalid|pull request/);
  assert.deepEqual(await gh.calls(), []);
});

await test("github_read rejects an in-range item offset beyond the fetched API page", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([
    response("/repos/acme/widgets/pulls/8", pullMetadata(1)),
    response("/repos/acme/widgets/pulls/8/files", [changedFile("src/only.ts")], { fields: { page: "1", per_page: "100" } }),
  ]);

  const result = await invoke({ action: "files", url: pullUrl, itemOffset: 1 });
  assertStructured(result);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, "github_read_failed");
  assert.match(result.structuredContent.error.message, /item offset/);
  assert.deepEqual((await gh.calls()).map((call) => call.endpoint), ["/repos/acme/widgets/pulls/8", "/repos/acme/widgets/pulls/8/files", "/repos/acme/widgets/pulls/8"]);
});

await test("github_read reports missing or truncated old rename paths as coverage gaps", async (t) => {
  const gh = await fakeGh(t);
  for (const scenario of [
    { file: changedFile("new/path.ts", { status: "renamed" }), reason: "previous_path_missing" },
    { file: changedFile("new/path.ts", { status: "renamed", previous_filename: "old/" + "x".repeat(510) }), reason: "previous_path_truncated" },
  ]) {
    await gh.set([
      response("/repos/acme/widgets/pulls/8", pullMetadata(1)),
      response("/repos/acme/widgets/pulls/8/files", [scenario.file], { fields: { page: "1", per_page: "100" } }),
    ]);
    const result = await invoke({ action: "files", url: pullUrl });
    assertStructured(result);
    const data = result.structuredContent.data;
    const renamed = data.items[0];
    assert.equal(data.coverage, "gap");
    assert.ok(data.gapReasons.includes(scenario.reason));
    assert.equal(renamed.path, "new/path.ts");
    if (scenario.reason === "previous_path_missing") {
      assert.equal(Object.hasOwn(renamed, "previousPath"), false);
      assert.equal(renamed.previousPathTruncated, false);
    } else {
      assert.equal(renamed.previousPath.length, 512);
      assert.equal(renamed.previousPathTruncated, true);
    }
  }
});

await test("github_read rejects writes, unsafe URLs, unknown fields, and invalid pagination before gh", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([]);
  for (const input of [
    { action: "write", url: issueUrl },
    { action: "read", url: issueUrl, args: ["issue", "close", "7"] },
    { action: "read", url: issueUrl, endpoint: "/repos/acme/widgets/issues/7" },
    { action: "read", url: issueUrl, projection: ".body" },
    { action: "read", url: issueUrl, query: "mutation { closeIssue }" },
    { action: "read", url: "https://evil.invalid/acme/widgets/issues/7" },
    { action: "read", url: issueUrl, bodyOffset: 8_001 },
    { action: "read", url: issueUrl, source: "comments" },
    { action: "comments", url: issueUrl, source: "unknown" },
    { action: "comments", url: issueUrl, perPage: 6 },
    { action: "comments", url: issueUrl, page: 1_001 },
    { action: "comments", url: issueUrl, bodyLimit: 20 },
    { action: "comments", url: issueUrl, source: "reviews" },
    { action: "comments", url: pullUrl, source: "thread_comments" },
  ]) await assert.rejects(invoke(input), /Invalid|Use an https/);
  assert.deepEqual(await gh.calls(), []);
});

await test("github_read returns structured authentication failures and preserves aborts", async (t) => {
  const gh = await fakeGh(t);
  await gh.set([response("/repos/acme/widgets/issues/7", undefined, { status: 401, exit: 1, error: "HTTP 401 authentication failed" })]);
  const auth = await invoke({ action: "read", url: issueUrl });
  assert.equal(auth.isError, true);
  assertStructured(auth);
  assert.equal(auth.structuredContent.error.code, "authentication");
  assert.match(auth.structuredContent.error.message, /authentication failed/);

  const before = new AbortController();
  before.abort();
  await assert.rejects(invoke({ action: "read", url: issueUrl }, before.signal), { name: "AbortError" });
  assert.equal((await gh.calls()).length, 1);

  await gh.set([response("/repos/acme/widgets/issues/7", item("issue", 7, "later"), { delay: 1_000 })]);
  const controller = new AbortController();
  const pending = invoke({ action: "read", url: issueUrl }, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await gh.wait(1);
  controller.abort();
  await rejected;
  assert.equal((await gh.calls()).length, 1);
});
