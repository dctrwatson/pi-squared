import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readGitHubIssue, readGitHubWork, readGitHubItem, readGitHubNotifications, readGitHubNotification,
  updateGitHubNotification, GitHubNotificationUpdateError,
} from "../src/github-access.ts";

const updated = "2026-02-03T04:05:06Z";
const web = (kind, number, repo = "acme/widgets") => `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
const item = (number, kind = "issue", extra = {}) => ({
  number, html_url: web(kind, number), url: `https://api.github.com/repos/acme/widgets/${kind === "pr" ? "pulls" : "issues"}/${number}`,
  repository_url: "https://api.github.com/repos/acme/widgets",
  title: `Item ${number}`, state: "open", updated_at: updated, user: { login: "bob" }, assignees: [{ login: "alice" }], body: "Synthetic body", ...extra,
});
const search = (items, total = items.length, incomplete = false) => ({ total_count: total, incomplete_results: incomplete, items: items.map((entry) => ({ ...entry, url: entry.url === `https://api.github.com/repos/acme/widgets/pulls/${entry.number}` ? `https://api.github.com/repos/acme/widgets/issues/${entry.number}` : entry.url })) });
const notification = (id = "91", type = "Issue", extra = {}) => ({
  id, url: `https://api.github.com/notifications/threads/${id}`, unread: true, reason: "subscribed", updated_at: updated, last_read_at: null,
  repository: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" },
  subject: { title: "Selected notification", type, url: `https://api.github.com/repos/acme/widgets/${type === "PullRequest" ? "pulls" : "issues"}/7`, latest_comment_url: null }, ...extra,
});
const rule = (endpoint, json, extra = {}) => ({ endpoint, method: "GET", json, ...extra });
const userRule = rule("/user", { login: "alice" });

async function fakeGh(t) {
  const root = await mkdtemp(join(tmpdir(), "hari-github-inbox-"));
  const state = join(root, "responses.json");
  const log = join(root, "calls.jsonl");
  const home = join(root, "home");
  await mkdir(home);
  await symlink(process.execPath, join(root, "node"));
  const names = ["PATH", "HOME", "GH_HOST", "HARI_INBOX_FAKE_STATE", "HARI_INBOX_FAKE_LOG"];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  await writeFile(join(root, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[0] === "api" ? args[1] : args.slice(0, 2).join(" ");
const method = args[0] === "api" ? args[args.indexOf("--method") + 1] : "GET";
const fields = {};
for (let i = 0; i < args.length; i++) if (args[i] === "-f") { const field = args[++i]; const end = field.indexOf("="); fields[field.slice(0, end)] = field.slice(end + 1); }
fs.appendFileSync(process.env.HARI_INBOX_FAKE_LOG, JSON.stringify({ args, endpoint, method, fields }) + "\\n");
const rules = JSON.parse(fs.readFileSync(process.env.HARI_INBOX_FAKE_STATE, "utf8"));
const selected = rules.find(rule => rule.endpoint === endpoint && (rule.method || "GET") === method && Object.entries(rule.fields || {}).every(([key, value]) => fields[key] === value));
if (!selected) { process.stderr.write("No fake response for " + method + " " + endpoint); process.exit(77); }
function respond() {
  if (selected.exit) { process.stderr.write(selected.error || "Simulated request failure"); process.exit(selected.exit); }
  if (selected.raw !== undefined) { process.stdout.write(selected.raw); return; }
  const status = selected.status || 200;
  const headers = Object.entries(selected.headers || {}).map(([key, value]) => key + ": " + value + "\\r\\n").join("");
  process.stdout.write("HTTP/2.0 " + status + " Fake status\\r\\n" + headers + "\\r\\n" + (selected.json === undefined ? "" : JSON.stringify(selected.json)));
}
if (selected.delay) setTimeout(respond, selected.delay); else respond();
`);
  await chmod(join(root, "gh"), 0o755);
  process.env.PATH = root;
  process.env.HOME = home;
  process.env.GH_HOST = "unsafe.example.invalid";
  process.env.HARI_INBOX_FAKE_STATE = state;
  process.env.HARI_INBOX_FAKE_LOG = log;
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

function publicReads(calls) {
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.args[call.args.indexOf("--hostname") + 1], "github.com");
    assert.ok(call.args.includes("--include"));
    assert.equal(call.args.includes("--paginate"), false);
    assert.equal(call.args.some((arg) => arg.startsWith("https://")), false);
  }
}

await test("bounded GitHub personal work and selected notifications use fake gh only", async (t) => {
  const f = await fakeGh(t);

  await t.test("account-wide source union retains reasons, identity, and updated order", async () => {
    await f.set([userRule,
      rule("/search/issues", search([item(1, "pr"), item(2)]), { fields: { q: "author:alice is:open" } }),
      rule("/search/issues", search([item(1, "pr"), item(3, "pr", { updated_at: "2026-03-01T00:00:00Z" })]), { fields: { q: "assignee:alice is:open" } }),
      rule("/search/issues", search([item(1, "pr"), item(3, "pr", { updated_at: "2026-03-01T00:00:00Z" })]), { fields: { q: "review-requested:alice is:open is:pr" } }),
    ]);
    const result = await readGitHubWork();
    assert.equal(result.account, "alice");
    assert.equal(result.page, 1);
    assert.equal(result.perPage, 10);
    assert.deepEqual(result.items.map((entry) => entry.number), [3, 1, 2]);
    assert.deepEqual(result.items.find((entry) => entry.number === 1).reasons, ["authored", "assigned", "review_requested"]);
    assert.deepEqual(result.items[0].reasons, ["assigned", "review_requested"]);
    assert.equal(result.items[0].url, web("pr", 3));
    assert.deepEqual(result.items[0].assignees, ["alice"]);
    assert.equal(result.items[0].author, "bob");
    assert.equal(result.sources.length, 3);
    assert.ok(result.sources.every((source) => source.count === 2 && source.incomplete_results === false));
    assert.deepEqual(result.warnings, []);
    const calls = await f.calls();
    assert.equal(calls.length, 4);
    assert.equal(calls[0].endpoint, "/user");
    publicReads(calls);
    for (const call of calls.slice(1)) {
      assert.equal(call.fields.sort, "updated");
      assert.equal(call.fields.order, "desc");
      assert.equal(call.fields.page, "1");
      assert.equal(call.fields.per_page, "10");
      assert.equal(call.fields.q.includes("repo:"), false);
      assert.ok(call.args.includes("--jq"));
    }
  });

  await t.test("issue-only pages query applicable sources and retain continuation and partial sources", async () => {
    await f.set([userRule,
      rule("/search/issues", search([item(7, "issue", { state: "closed" })], 12, true), { fields: { q: "author:alice is:issue", page: "2", per_page: "3" } }),
      rule("/search/issues", undefined, { fields: { q: "assignee:alice is:issue" }, exit: 1, error: "Simulated rate limit" }),
    ]);
    const result = await readGitHubWork({ kind: "issue", state: "all", page: 2, perPage: 3 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].state, "closed");
    assert.deepEqual(result.sources.map((source) => source.source), ["authored", "assigned"]);
    assert.equal(result.sources[0].nextPage, 3);
    assert.equal(result.sources[0].incomplete_results, true);
    assert.match(result.sources[1].error, /rate limit/);
    assert.ok(result.warnings.some((warning) => warning.includes("incomplete_results")));
    assert.equal((await f.calls()).length, 3);
    publicReads(await f.calls());
  });

  await t.test("closed PR filters and maximum page sizes preserve explicit continuation", async () => {
    await f.set([userRule, rule("/search/issues", search([item(12, "pr", { state: "closed" })], 51), { fields: { q: "author:alice is:closed is:pr", page: "2", per_page: "25" } })]);
    const work = await readGitHubWork({ source: "authored", kind: "pr", state: "closed", page: 2, perPage: 25 });
    assert.equal(work.items[0].state, "closed");
    assert.equal(work.sources[0].nextPage, 3);
    assert.equal((await f.calls()).length, 2);
    await f.set([rule("/notifications", Array.from({ length: 25 }, (_, index) => notification(String(index + 1))))]);
    const notifications = await readGitHubNotifications({ perPage: 25 });
    assert.equal(notifications.items.length, 25);
    assert.equal(notifications.nextPage, 2);
    assert.equal((await f.calls()).length, 1);
  });

  await t.test("malformed work items are explicit and search exposes no pages after result 1000", async () => {
    await f.set([userRule, rule("/search/issues", search([item(9), item(10, "issue", { html_url: "https://evil.invalid/issue/10" })], 1200))]);
    const result = await readGitHubWork({ source: "authored", page: 100 });
    assert.deepEqual(result.items.map((entry) => entry.number), [9]);
    assert.equal(result.sources[0].nextPage, undefined);
    assert.equal(result.sources[0].count, 1);
    assert.match(result.sources[0].error, /Omitted 1 invalid/);
    assert.ok(result.warnings.some((warning) => warning.includes("1,000")));
    await f.set([userRule, rule("/search/issues", search([item(9, "issue", { repository_url: "https://api.github.com/repos/other/repo" })]))]);
    assert.match((await readGitHubWork({ source: "assigned" })).sources[0].error, /Omitted 1 invalid/);
    await f.set([userRule, rule("/search/issues", { items: [] })]);
    const malformed = await readGitHubWork({ source: "assigned" });
    assert.match(malformed.sources[0].error, /search page/);
  });

  await t.test("bad inputs and unsafe authenticated login do not spawn searches", async () => {
    await f.set([]);
    for (const options of [
      { perPage: 26 }, { perPage: 0 }, { perPage: "10" }, { page: -1 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER + 1 },
      { page: 101 }, { source: "mentions" }, { source: null }, { kind: "commit" }, { state: "merged" },
      { source: "review_requested", kind: "issue" }, { repository: "acme/widgets" },
    ]) await assert.rejects(readGitHubWork(options), /Invalid GitHub/);
    assert.deepEqual(await f.calls(), []);
    await f.set([rule("/user", { login: "alice assignee:someone" })]);
    await assert.rejects(readGitHubWork(), /account login/);
    assert.equal((await f.calls()).length, 1);
    await f.set([rule("/user", undefined, { exit: 1 })]);
    await assert.rejects(readGitHubWork(), /GitHub CLI read failed/);
  });

  await t.test("aborted personal-work calls are not downgraded to successful empty sources", async () => {
    const before = new AbortController();
    before.abort();
    await f.set([]);
    await assert.rejects(readGitHubWork({ signal: before.signal }), { name: "AbortError" });
    assert.deepEqual(await f.calls(), []);
    await f.set([userRule, rule("/search/issues", search([]), { delay: 1000 })]);
    const controller = new AbortController();
    const pending = readGitHubWork({ signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await f.wait(2);
    controller.abort();
    await rejected;
    assert.equal((await f.calls()).length, 2);
  });

  await t.test("exact issue and PR reads bound Unicode body/title and expose native PR status", async () => {
    await f.set([rule("/repos/acme/widgets/issues/7", item(7, "issue", { title: "🛰".repeat(513), body: "🛰".repeat(8001), state_reason: "completed" })),
      rule("/repos/acme/widgets/pulls/8", item(8, "pr", { state: "closed", draft: false, merged: true, mergeable: null, mergeable_state: "unknown", merged_at: updated })),
    ]);
    const issue = await readGitHubItem(web("issue", 7));
    assert.equal([...issue.body].length, 8000);
    assert.equal(issue.bodyTruncated, true);
    assert.equal([...issue.title].length, 512);
    assert.equal(issue.titleTruncated, true);
    assert.equal(issue.stateReason, "completed");
    const pr = await readGitHubItem(web("pr", 8));
    assert.equal(pr.kind, "pr");
    assert.equal(pr.merged, true);
    assert.equal(pr.mergeable, null);
    assert.equal(pr.mergeState, "unknown");
    assert.equal(pr.mergedAt, updated);
    publicReads(await f.calls());
  });

  await t.test("issue compatibility wrapper reads a selected PR through the exact item API", async () => {
    await f.set([rule("/repos/acme/widgets/pulls/8", item(8, "pr", { state: "closed", body: "🛰".repeat(8001), draft: false, merged: true }))]);
    const result = await readGitHubIssue(web("pr", 8), { repository: "other/repo" });
    assert.deepEqual(result, {
      url: web("pr", 8), title: "Item 8", body: "🛰".repeat(8000), bodyTruncated: true,
      state: "CLOSED", updatedAt: updated, repository: "acme/widgets", number: 8, observedAt: result.observedAt,
    });
    assert.equal(new Date(result.observedAt).toISOString(), result.observedAt);
    const calls = await f.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, "/repos/acme/widgets/pulls/8");
    publicReads(calls);
  });

  await t.test("issue compatibility wrapper preserves all legacy issue references and commands", async () => {
    const legacy = { url: web("issue", 7), title: "Legacy issue", body: "🛰".repeat(32001), state: "OPEN", updatedAt: updated };
    await f.set([rule("issue view", undefined, { raw: JSON.stringify(legacy) })]);
    const references = [
      ["#7", { repository: "acme/widgets" }], ["7", { repository: "acme/widgets" }],
      ["acme/widgets#7", undefined], [web("issue", 7), undefined], [web("issue", 7), { repository: "other/repo" }],
    ];
    for (const [reference, options] of references) {
      const result = await readGitHubIssue(reference, options);
      assert.deepEqual(result, { ...legacy, body: "🛰".repeat(32000), bodyTruncated: true, repository: "acme/widgets", number: 7, observedAt: result.observedAt });
    }
    const calls = await f.calls();
    assert.deepEqual(calls.map((call) => call.args), references.map(() => ["issue", "view", "7", "--repo", "acme/widgets", "--json", "url,title,body,state,updatedAt"]));
  });

  await t.test("issue compatibility wrapper preserves aborts and selected PR identity checks", async () => {
    await f.set([]);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(readGitHubIssue(web("pr", 8), { signal: cancelled.signal }), { name: "AbortError" });
    await assert.rejects(readGitHubIssue("#7", { repository: "acme/widgets", signal: cancelled.signal }), { name: "AbortError" });
    await assert.rejects(readGitHubIssue("#7"), /explicit repository option/);
    await assert.rejects(readGitHubIssue("https://evil.invalid/acme/widgets/pull/8"));
    assert.deepEqual(await f.calls(), []);
    await f.set([rule("/repos/acme/widgets/pulls/8", item(9, "pr"))]);
    await assert.rejects(readGitHubIssue(web("pr", 8)), /selected item identity/);
    assert.equal((await f.calls()).length, 1);
    await f.set([rule("/repos/acme/widgets/pulls/8", item(8, "pr"), { delay: 1000 })]);
    const controller = new AbortController();
    const pending = readGitHubIssue(web("pr", 8), { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await f.wait(1);
    controller.abort();
    await rejected;
    assert.equal((await f.calls()).length, 1);
  });

  await t.test("item input URLs and returned identities are checked without following response links", async () => {
    await f.set([]);
    for (const url of ["/tmp/session", "acme/widgets#7", "http://github.com/acme/widgets/issues/7", "https://evil.invalid/acme/widgets/issues/7", "https://github.com/user/repo/issues/0", "https://user@github.com/acme/widgets/issues/7", "https://github.com:8443/acme/widgets/issues/7"]) {
      await assert.rejects(readGitHubItem(url));
    }
    assert.deepEqual(await f.calls(), []);
    for (const changed of [
      { html_url: web("issue", 8) }, { html_url: web("pr", 7) }, { number: 8 },
      { url: "https://evil.invalid/repos/acme/widgets/issues/7" }, { url: "https://api.github.com/repos/other/repo/issues/7" },
      { html_url: `${web("issue", 7)}?token=untrusted` },
    ]) {
      await f.set([rule("/repos/acme/widgets/issues/7", item(7, "issue", changed))]);
      await assert.rejects(readGitHubItem(web("issue", 7)), /Invalid GitHub/);
      assert.equal((await f.calls()).length, 1);
    }
    await f.set([rule("/repos/acme/widgets/issues/7", undefined, { raw: "HTTP/2.0 200 OK\n\n{bad}" })]);
    await assert.rejects(readGitHubItem(web("issue", 7)), /malformed/);
    await f.set([rule("/repos/acme/widgets/issues/7", undefined, { raw: `HTTP/2.0 200 OK\n\n${"x".repeat(300_000)}` })]);
    await assert.rejects(readGitHubItem(web("issue", 7)), /bounded output|output limit|maxBuffer/);
  });

  await t.test("notification pages include all participation types, unread defaults, and real Link continuation", async () => {
    const types = ["Issue", "PullRequest", "Release", "Commit", "Discussion", "CheckSuite"];
    await f.set([rule("/notifications", types.map((type, index) => notification(String(index + 1), type)), {
      headers: { Link: '<https://api.github.com/notifications?page=2&per_page=10>; rel="next", <https://api.github.com/notifications?page=5&per_page=10>; rel="last"' },
    })]);
    const result = await readGitHubNotifications();
    assert.equal(result.items.length, 6);
    assert.equal(result.nextPage, 2);
    assert.equal(result.pagination, "link");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.items[0].item.kind, "issue");
    assert.equal(result.items[1].item.kind, "pr");
    assert.equal(result.items[1].url, web("pr", 7));
    for (const entry of result.items.slice(2)) { assert.equal(entry.item, undefined); assert.equal(entry.url, "https://github.com/acme/widgets"); }
    const calls = await f.calls();
    assert.deepEqual(calls[0].fields, { page: "1", per_page: "10", all: "false", participating: "false" });
    publicReads(calls);
  });

  await t.test("notification read options and conservative completion never auto-fetch or clear", async () => {
    await f.set([rule("/notifications", [notification("91", "Issue", { unread: false, last_read_at: updated })])]);
    const result = await readGitHubNotifications({ page: 2, perPage: 1, includeRead: true, since: updated });
    assert.equal(result.nextPage, 3);
    assert.equal(result.pagination, "conservative");
    assert.match(result.warnings[0], /one extra read/);
    assert.equal(result.items[0].unread, false);
    assert.equal(result.items[0].lastReadAt, updated);
    const calls = await f.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fields, { page: "2", per_page: "1", all: "true", participating: "false", since: "2026-02-03T04:05:06.000Z" });
    publicReads(calls);
    await f.set([rule("/notifications", [])]);
    const empty = await readGitHubNotifications();
    assert.equal(empty.nextPage, undefined);
    assert.deepEqual(empty.warnings, [], "complete pages need no pagination warning");
  });

  await t.test("notification option, subject, repository, and pagination URL errors are explicit", async () => {
    await f.set([]);
    for (const options of [{ includeRead: "true" }, { since: "not a timestamp" }, { since: "2026-02-30T00:00:00Z" }, { page: 0 }, { page: Number.MAX_SAFE_INTEGER }, { perPage: 26 }, { participating: true }]) {
      await assert.rejects(readGitHubNotifications(options), /Invalid GitHub/);
    }
    assert.deepEqual(await f.calls(), []);
    const unsafe = [
      notification("91", "Issue", { repository: { full_name: "acme/widgets", html_url: "https://evil.invalid/acme/widgets" } }),
      notification("91", "Issue", { subject: { type: "Issue", title: "Unsafe", url: "https://api.github.com/repos/other/repo/issues/7" } }),
      notification("91", "Issue", { subject: { type: "Issue", title: "Unsafe", url: "https://evil.invalid/repos/acme/widgets/issues/7" } }),
      notification("91", "Issue", { id: "92" }),
    ];
    for (const entry of unsafe) {
      await f.set([rule("/notifications", [entry])]);
      await assert.rejects(readGitHubNotifications(), /Invalid GitHub/);
      assert.equal((await f.calls()).length, 1);
    }
    await f.set([rule("/notifications", [], { headers: { Link: '<https://evil.invalid/notifications?page=2>; rel="next"' } })]);
    await assert.rejects(readGitHubNotifications(), /pagination URL/);
  });

  await t.test("selected threads fetch only approved same-repository comments with bounded detail", async () => {
    for (const category of ["issues", "pulls"]) {
      const commentUrl = `https://api.github.com/repos/acme/widgets/${category}/comments/81`;
      const selected = notification("91", "Issue", { subject: { title: "Selected", type: "Issue", url: "https://api.github.com/repos/acme/widgets/issues/7", latest_comment_url: commentUrl } });
      await f.set([rule("/notifications/threads/91", selected), rule(`/repos/acme/widgets/${category}/comments/81`, { id: 81, url: commentUrl, body: "🛰".repeat(8001), user: { login: "bob" }, updated_at: updated })]);
      const result = await readGitHubNotification("91");
      assert.equal(result.id, "91");
      assert.equal(result.latestComment.url, commentUrl);
      assert.equal([...result.latestComment.body].length, 8000);
      assert.equal(result.latestComment.bodyTruncated, true);
      assert.equal(result.latestComment.author, "bob");
      assert.deepEqual(result.warnings, []);
      const calls = await f.calls();
      assert.deepEqual(calls.map((call) => call.endpoint), ["/notifications/threads/91", `/repos/acme/widgets/${category}/comments/81`]);
      publicReads(calls);
    }
    await f.set([rule("/notifications/threads/91", notification())]);
    assert.equal((await readGitHubNotification("91")).latestComment, undefined);
    assert.equal((await f.calls()).length, 1);
  });

  await t.test("unsafe or failed comment detail is partial, not invented or followed", async () => {
    for (const url of ["https://evil.invalid/repos/acme/widgets/issues/comments/81", "https://api.github.com/repos/other/repo/issues/comments/81", "https://api.github.com/repos/acme/widgets/issues/comments/81?unsafe=true", "https://api.github.com/repos/acme/widgets/pulls/81", "https://user@api.github.com/repos/acme/widgets/issues/comments/81"]) {
      await f.set([rule("/notifications/threads/91", notification("91", "Issue", { subject: { type: "Issue", title: "Selected", url: "https://api.github.com/repos/acme/widgets/issues/7", latest_comment_url: url } }))]);
      const result = await readGitHubNotification("91");
      assert.equal(result.latestComment, undefined);
      assert.match(result.warnings[0], /partial/);
      assert.equal((await f.calls()).length, 1);
    }
    const url = "https://api.github.com/repos/acme/widgets/issues/comments/81";
    const selected = notification("91", "Issue", { subject: { type: "Issue", title: "Selected", url: "https://api.github.com/repos/acme/widgets/issues/7", latest_comment_url: url } });
    await f.set([rule("/notifications/threads/91", selected), rule("/repos/acme/widgets/issues/comments/81", undefined, { exit: 1, error: "Comment deleted" })]);
    assert.match((await readGitHubNotification("91")).warnings[0], /partial.*Comment deleted/);
    await f.set([rule("/notifications/threads/91", selected), rule("/repos/acme/widgets/issues/comments/81", { id: 82, url, body: "Wrong comment", updated_at: updated })]);
    assert.equal((await readGitHubNotification("91")).latestComment, undefined);
  });

  await t.test("unsafe thread IDs and mismatched selected thread replies cannot become requests", async () => {
    await f.set([]);
    for (const thread of ["0", "01", "-1", "1.5", "1;echo nope", "/notifications", "https://api.github.com/notifications/threads/1", "1".repeat(21), 91]) {
      await assert.rejects(readGitHubNotification(thread), /thread ID/);
      await assert.rejects(updateGitHubNotification(thread, "mark_read"), /thread ID/);
    }
    await assert.rejects(updateGitHubNotification("91", "subscribe"), /notification action/);
    assert.deepEqual(await f.calls(), []);
    await f.set([rule("/notifications/threads/91", notification("92"))]);
    await assert.rejects(readGitHubNotification("91"), /selected notification thread binding/);
    assert.equal((await f.calls()).length, 1);
  });

  await t.test("selected read/done writes use exact methods and confirm only expected HTTP statuses", async () => {
    await f.set([
      rule("/notifications/threads/91", undefined, { method: "PATCH", status: 205 }),
      rule("/notifications/threads/92", undefined, { method: "DELETE", status: 204 }),
    ]);
    assert.deepEqual(await updateGitHubNotification("91", "mark_read"), { thread: "91", action: "mark_read", status: "confirmed" });
    assert.deepEqual(await updateGitHubNotification("92", "mark_done"), { thread: "92", action: "mark_done", status: "confirmed" });
    const calls = await f.calls();
    assert.deepEqual(calls.map((call) => [call.method, call.endpoint]), [["PATCH", "/notifications/threads/91"], ["DELETE", "/notifications/threads/92"]]);
    for (const call of calls) {
      assert.deepEqual(call.fields, {});
      assert.equal(call.args[call.args.indexOf("--hostname") + 1], "github.com");
      assert.equal(call.endpoint === "/notifications", false);
    }
    for (const action of ["mark_read", "mark_done"]) {
      const method = action === "mark_read" ? "PATCH" : "DELETE";
      const status = action === "mark_read" ? 205 : 204;
      await f.set([rule("/notifications/threads/91", undefined, { method, raw: `HTTP/2.0 ${status} No body\nContent-Length: 0\n\r\n` })]);
      assert.equal((await updateGitHubNotification("91", action)).status, "confirmed", "gh emits LF headers followed by a CRLF separator even with no body");
      for (const response of [{ status: 200 }, { status: 202 }, { exit: 1, error: "Permission denied" }, { raw: "" }]) {
        await f.set([rule("/notifications/threads/91", undefined, { method, ...response })]);
        await assert.rejects(updateGitHubNotification("91", action), (error) => {
          assert.ok(error instanceof GitHubNotificationUpdateError);
          assert.equal(error.status, "unconfirmed");
          assert.match(error.message, /Inspect the thread before retry/);
          return true;
        });
        assert.equal((await f.calls()).length, 1);
      }
    }
  });

  await t.test("interrupted writes stay unconfirmed and interrupted detail reads are not partial success", async () => {
    const before = new AbortController();
    before.abort();
    await f.set([]);
    await assert.rejects(updateGitHubNotification("91", "mark_done", { signal: before.signal }), (error) => error.name === "AbortError" && error.status === "unconfirmed");
    assert.deepEqual(await f.calls(), []);
    await f.set([rule("/notifications/threads/91", undefined, { method: "PATCH", status: 205, delay: 1000 })]);
    const writing = new AbortController();
    const pending = updateGitHubNotification("91", "mark_read", { signal: writing.signal });
    const rejected = assert.rejects(pending, (error) => error.name === "AbortError" && error.status === "unconfirmed" && /Inspect/.test(error.message));
    await f.wait(1);
    writing.abort();
    await rejected;
    assert.equal((await f.calls()).length, 1);
    const comment = "https://api.github.com/repos/acme/widgets/issues/comments/81";
    await f.set([rule("/notifications/threads/91", notification("91", "Issue", { subject: { type: "Issue", title: "Selected", url: "https://api.github.com/repos/acme/widgets/issues/7", latest_comment_url: comment } })), rule("/repos/acme/widgets/issues/comments/81", {}, { delay: 1000 })]);
    const reading = new AbortController();
    const detail = readGitHubNotification("91", { signal: reading.signal });
    const detailRejected = assert.rejects(detail, { name: "AbortError" });
    await f.wait(2);
    reading.abort();
    await detailRejected;
    publicReads(await f.calls());
  });
});
