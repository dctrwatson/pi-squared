import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import hariExtension from "../src/index.ts";
import { createProject, initializeCoordination, readFollowing, readIndex, readInbox, readProject } from "../src/coordination.ts";
import { initializeCoordinationRepository } from "../src/coordination-git.ts";
import { registerGitHubInboxTools } from "../src/github-tools.ts";
import { parseGitHubItemUrl } from "../src/github-reference.ts";

const url = "https://github.com/acme/widgets/pull/7";

function fakePi() {
  const tools = new Map(["create_workspace", "subagent"].map((name) => [name, { name }]));
  const handlers = new Map();
  const active = [];
  return {
    tools, handlers, active,
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools() { return [...tools.values()]; },
    setActiveTools(names) { active.splice(0, active.length, ...names); },
    appendEntry() {},
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hari-github-tools-"));
  const previous = { ...process.env };
  const home = join(root, "home");
  const directory = join(home, "Projects", "primeradiant");
  const bin = join(root, "bin");
  const log = join(root, "calls.jsonl");
  await mkdir(bin);
  await writeFile(log, "");
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HARI_TOOLS_GH_LOG, JSON.stringify(args) + "\\n");
const endpoint = args[1];
const method = args[args.indexOf("--method") + 1];
let status = 200;
const updated = "2026-02-03T04:05:06Z";
const item = {
  number: 7, html_url: "https://github.com/acme/widgets/pull/7",
  url: "https://api.github.com/repos/acme/widgets/pulls/7",
  repository_url: "https://api.github.com/repos/acme/widgets",
  title: "Related change", state: "open", updated_at: updated,
  user: { login: "alice" }, assignees: [{ login: "alice" }], body: "Selected PR body"
};
const notification = {
  id: "91", url: "https://api.github.com/notifications/threads/91",
  unread: true, reason: "review_requested", updated_at: updated, last_read_at: null,
  repository: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" },
  subject: { title: "Related change", type: "PullRequest", url: item.url, latest_comment_url: null }
};
let value;
if (method === "PATCH" || method === "DELETE") {
  if (endpoint !== "/notifications/threads/91") process.exit(77);
  status = method === "PATCH" ? 205 : 204;
} else if (endpoint === "/user") value = { login: "alice" };
else if (endpoint === "/search/issues") value = { total_count: 1, incomplete_results: false, items: [{ ...item, url: "https://api.github.com/repos/acme/widgets/issues/7" }] };
else if (endpoint === "/notifications") value = [notification];
else if (endpoint === "/notifications/threads/91") value = notification;
else if (endpoint === "/repos/acme/widgets/pulls/7") value = item;
else { process.stderr.write("Unknown synthetic endpoint"); process.exit(77); }
process.stdout.write("HTTP/2.0 " + status + " Fake\\r\\n\\r\\n" + (value === undefined ? "" : JSON.stringify(value)));
`);
  await chmod(join(bin, "gh"), 0o755);
  Object.assign(process.env, { HOME: home, HARI_ROLE: "hari", PATH: `${bin}:${previous.PATH}`, HARI_TOOLS_GH_LOG: log });
  await initializeCoordination(directory, { version: 1, workspaceLauncher: "/resources/workspace/launcher.ts" });
  await initializeCoordinationRepository(directory);
  await createProject(directory, { name: "Widgets", repository: "acme/widgets" });
  const pi = fakePi();
  hariExtension(pi);
  const ctx = { ui: { setStatus() {}, notify() {} } };
  await pi.handlers.get("session_start")({}, ctx);
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  return {
    directory, pi, ctx,
    async calls() { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); },
    async execute(name, params) { return pi.tools.get(name).execute("test", params); },
  };
}

function view(response) { return response.details.view; }

test("canonical follows accept links to comments but reject foreign hosts and identities", () => {
  assert.equal(parseGitHubItemUrl(`${url}?diff=split#discussion_r1`).url, url);
  assert.equal(parseGitHubItemUrl("https://github.com/acme/widgets/issues/3/").kind, "issue");
  for (const input of ["acme/widgets#7", "https://example.com/acme/widgets/pull/7", "https://github.com:8443/acme/widgets/pull/7", "https://me@github.com/acme/widgets/pull/7", "https://github.com/acme/widgets/issues/0", "https://github.com/acme/widgets/pull/9007199254740992"]) {
    assert.throws(() => parseGitHubItemUrl(input));
  }
});

test("Hari's follows survive reload and checkpoint without creating work or GitHub calls", async (t) => {
  const f = await fixture(t);
  assert.ok(["hari_follow", "hari_github_work", "hari_notifications"].every((name) => f.pi.active.includes(name)));
  assert.deepEqual(await f.calls(), [], "startup reads no GitHub data");
  const beforeIndex = await readIndex(f.directory);
  const beforeInbox = await readInbox(f.directory);
  await f.execute("hari_follow", { action: "follow", url, note: "Interested in the new cache API" });
  await f.execute("hari_follow", { action: "follow", url: "https://github.com/other/repo/issues/4" });
  assert.deepEqual(await readIndex(f.directory), beforeIndex);
  assert.deepEqual(await readInbox(f.directory), beforeInbox);
  assert.deepEqual(await f.calls(), []);
  const page = await f.execute("hari_follow", { action: "list", limit: 1 });
  assert.equal(view(page).nextOffset, 1);
  assert.match(page.content[0].text, /nextOffset=1/);
  const record = await f.execute("hari_record_page", { kind: "following" });
  assert.match(record.content[0].text, /FOLLOWING.md/);
  assert.match(record.content[0].text, /new cache API/);
  const checkpoint = await f.execute("hari_git", { action: "commit", message: "follow interesting work" });
  assert.equal(checkpoint.details.changed, true);
  assert.match(execFileSync("git", ["-C", f.directory, "show", "HEAD:FOLLOWING.md"], { encoding: "utf8" }), /new cache API/);
  const fresh = fakePi();
  hariExtension(fresh);
  const reloaded = view(await fresh.tools.get("hari_follow").execute("reload", { action: "list" }));
  assert.equal(reloaded.items.length, 2);
  assert.equal(reloaded.items[0].note, "Interested in the new cache API");
  await f.execute("hari_follow", { action: "unfollow", url });
  assert.equal((await readFollowing(f.directory)).items.length, 1);
  assert.deepEqual(await f.calls(), []);
});

test("account work, followed updates, and notifications expose local relevance without clearing", async (t) => {
  const f = await fixture(t);
  await f.execute("hari_follow", { action: "follow", url, note: "new cache API" });
  const work = view(await f.execute("hari_github_work", { action: "list" }));
  assert.equal(work.items.length, 1);
  assert.deepEqual(work.items[0].reasons, ["authored", "assigned", "review_requested"]);
  assert.equal(work.items[0].following, true);
  assert.equal(work.items[0].interestNote, "new cache API");
  assert.deepEqual(work.items[0].projects, ["widgets"]);
  const following = view(await f.execute("hari_github_work", { action: "following" }));
  assert.equal(following.items[0].following, true);
  assert.equal(following.items[0].body, undefined, "digest previews omit item bodies");
  const detail = view(await f.execute("hari_github_work", { action: "read", url }));
  assert.equal(detail.body, "Selected PR body");
  const notifications = view(await f.execute("hari_notifications", { action: "list" }));
  assert.equal(notifications.items[0].url, url);
  assert.equal(notifications.items[0].following, true);
  assert.equal(notifications.items[0].interestNote, "new cache API");
  assert.deepEqual(notifications.items[0].projects, ["widgets"]);
  const thread = view(await f.execute("hari_notifications", { action: "read", thread: "91" }));
  assert.equal(thread.following, true);
  assert.ok((await f.calls()).every((args) => args[args.indexOf("--method") + 1] === "GET"));
  assert.equal((await readFollowing(f.directory)).items.length, 1, "reads do not follow recommendations");
  await f.execute("hari_track_issue", { project: "widgets", reference: url });
  assert.equal((await readProject(f.directory, "widgets")).issues[0].reference, url);
  assert.equal((await readFollowing(f.directory)).items.length, 1, "project tracking does not add follows");
});

test("selected notification actions are distinct from read and reject a missing target", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.execute("hari_notifications", { action: "mark_done" }), /selected notification thread/);
  assert.deepEqual(await f.calls(), []);
  assert.equal(view(await f.execute("hari_notifications", { action: "mark_read", thread: "91" })).status, "confirmed");
  assert.equal(view(await f.execute("hari_notifications", { action: "mark_done", thread: "91" })).status, "confirmed");
  assert.deepEqual((await f.calls()).map((args) => [args[1], args[args.indexOf("--method") + 1]]), [["/notifications/threads/91", "PATCH"], ["/notifications/threads/91", "DELETE"]]);
});

test("GitHub inbox tools refuse manager use and stable prompts carry only policy", async (t) => {
  const f = await fixture(t);
  const prompt = await f.pi.handlers.get("before_agent_start")({}, f.ctx);
  assert.match(prompt.systemPrompt, /account-wide authored\/assigned/);
  assert.match(prompt.systemPrompt, /After finishing the selected page reads and presenting a requested notification digest/);
  assert.match(prompt.systemPrompt, /use hari_notifications with mark_done to remove only its included threads from the GitHub notifications inbox/);
  assert.match(prompt.systemPrompt, /unless the user asks to keep them there/);
  assert.match(prompt.systemPrompt, /Marking read alone does not remove them/);
  assert.match(prompt.systemPrompt, /Do not mark merely fetched, omitted, or unreviewed notifications done/);
  assert.match(prompt.systemPrompt, /Finish pagination before these writes/);
  assert.match(prompt.systemPrompt, /Other selected read\/done actions need an explicit user request/);
  assert.match(f.pi.tools.get("hari_notifications").description, /present a digest before using mark_done on its included threads/);
  assert.match(prompt.systemPrompt, /Suggest follows without adding them automatically/);
  await f.execute("hari_follow", { action: "follow", url, note: "PRIVATE INTEREST NOTE" });
  const next = await f.pi.handlers.get("before_agent_start")({}, f.ctx);
  assert.deepEqual(next, prompt);
  assert.doesNotMatch(next.systemPrompt, /PRIVATE INTEREST NOTE/);
  const manager = fakePi();
  registerGitHubInboxTools(manager, () => ({ role: "manager", coordinationDir: f.directory }), (operation) => operation());
  for (const [name, params] of [["hari_follow", { action: "follow", url }], ["hari_github_work", { action: "list" }], ["hari_notifications", { action: "mark_done", thread: "91" }]]) {
    await assert.rejects(manager.tools.get(name).execute("blocked", params), /belong to Hari/);
  }
  assert.deepEqual(await f.calls(), []);
});
