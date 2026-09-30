import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FOLLOWING_FILE, followGitHubItem, initializeCoordination, readCoordinationRecord, readFollowing, readInbox, readIndex, unfollowGitHubItem } from "../src/coordination.ts";

const issue = "https://github.com/Acme/Widgets/issues/12";
const pr = "https://github.com/Other/Tools/pull/34";
const resources = { version: 1, workspaceLauncher: "/resources/workspace/launcher.ts" };

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "hari-following-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function metadata(source) {
  return JSON.parse(source.split("<!-- hari-meta:start -->\n")[1].split("\n<!-- hari-meta:end -->")[0]);
}

function replaceMetadata(source, value) {
  return source.replace(/(?<=<!-- hari-meta:start -->\n)[\s\S]*?(?=\n<!-- hari-meta:end -->)/, JSON.stringify(value, null, 2));
}

test("missing following reads and pages stay empty without creating files", async (t) => {
  const root = await directory(t);
  const missing = join(root, "not-created");
  assert.deepEqual(await readFollowing(missing), { version: 1, items: [] });
  assert.equal(await unfollowGitHubItem(missing, issue), false);
  const page = await readCoordinationRecord(missing, "following");
  assert.equal(page.path, join(missing, FOLLOWING_FILE));
  assert.match(page.content, /No GitHub items followed/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);
});

test("following is lazy and issues and PRs need no project or manager", async (t) => {
  const root = await directory(t);
  const first = await followGitHubItem(root, { url: `${issue}/?plain=1#comment`, note: " Watch this approach " });
  const second = await followGitHubItem(root, { url: pr });
  assert.deepEqual(first, { kind: "issue", repository: "Acme/Widgets", number: 12, url: issue, note: "Watch this approach", followedAt: first.followedAt });
  assert.equal(new Date(first.followedAt).toISOString(), first.followedAt);
  assert.equal(second.kind, "pr");
  assert.deepEqual(await readdir(root), [FOLLOWING_FILE]);
  assert.deepEqual(await readFollowing(root), { version: 1, items: [first, second] });
  const source = await readFile(join(root, FOLLOWING_FILE), "utf8");
  assert.match(source, /Hari-managed record/);
  assert.match(source, /\[Acme\/Widgets#12\]\(https:\/\/github.com\/Acme\/Widgets\/issues\/12\)/);
  assert.equal((await readCoordinationRecord(root, "following")).content, source);
});

test("following notes keep metadata markers as data", async (t) => {
  const root = await directory(t);
  const note = "Inspect <!-- hari-meta:start --> and <!-- hari-meta:end --> as text.";
  const saved = await followGitHubItem(root, { url: issue, note });
  assert.deepEqual((await readFollowing(root)).items, [saved]);
  assert.equal(saved.note, note);
  const source = await readFile(join(root, FOLLOWING_FILE), "utf8");
  assert.equal(metadata(source).items[0].note, note);
  assert.equal((await readCoordinationRecord(root, "following")).content, source);
  assert.equal(await unfollowGitHubItem(root, issue), true);
});

test("case-insensitive follows update or clear notes and preserve the original identity and time", async (t) => {
  const root = await directory(t);
  const first = await followGitHubItem(root, { url: issue, note: "Original" });
  assert.deepEqual(await followGitHubItem(root, { url: issue.toLowerCase() }), first);
  const updated = await followGitHubItem(root, { url: issue.toLowerCase(), note: "Replacement" });
  assert.equal(updated.note, "Replacement");
  assert.equal(updated.url, first.url);
  assert.equal(updated.repository, first.repository);
  assert.equal(updated.followedAt, first.followedAt);
  const cleared = await followGitHubItem(root, { url: issue, note: "   " });
  assert.equal(Object.hasOwn(cleared, "note"), false);
  assert.equal(cleared.followedAt, first.followedAt);
  assert.equal((await readFollowing(root)).items.length, 1);
  const before = await readFile(join(root, FOLLOWING_FILE), "utf8");
  await assert.rejects(followGitHubItem(root, { url: issue.replace("issues", "pull") }), /Contradictory GitHub item kind/);
  await assert.rejects(unfollowGitHubItem(root, issue.replace("issues", "pull")), /Contradictory GitHub item kind/);
  assert.equal(await readFile(join(root, FOLLOWING_FILE), "utf8"), before);
  assert.equal(await unfollowGitHubItem(root, pr), false);
  assert.equal(await readFile(join(root, FOLLOWING_FILE), "utf8"), before);
  assert.equal(await unfollowGitHubItem(root, issue.toLowerCase()), true);
  assert.deepEqual(await readFollowing(root), { version: 1, items: [] });
  assert.equal(await unfollowGitHubItem(root, issue), false);
});

test("invalid URLs and bounded note checks cannot create or change following", async (t) => {
  const root = await directory(t);
  for (const url of ["acme/widgets#12", "https://example.invalid/acme/widgets/issues/12", "https://github.com/acme/widgets", "https://github.com/acme/widgets/issues/0"]) {
    await assert.rejects(followGitHubItem(root, { url }), /Invalid followed GitHub item/);
    await assert.rejects(unfollowGitHubItem(root, url), /Invalid followed GitHub item/);
  }
  for (const note of ["x".repeat(2001), null, 42]) {
    await assert.rejects(followGitHubItem(root, { url: issue, note }), /at most 2000 characters/);
  }
  assert.deepEqual(await readdir(root), []);
  await followGitHubItem(root, { url: issue, note: "x".repeat(2000) });
  const before = await readFile(join(root, FOLLOWING_FILE), "utf8");
  await assert.rejects(followGitHubItem(root, { url: issue, note: "x".repeat(2001) }), /at most 2000 characters/);
  assert.equal(await readFile(join(root, FOLLOWING_FILE), "utf8"), before);
});

test("following metadata rejects invalid fields, mismatched identities, duplicates, and timestamps", async (t) => {
  const root = await directory(t);
  await followGitHubItem(root, { url: issue });
  const path = join(root, FOLLOWING_FILE);
  const original = await readFile(path, "utf8");
  const cases = [
    ["version", (value) => { value.version = 2; }, /Unsupported/],
    ["items", (value) => { value.items = {}; }, /following items/],
    ["record field", (value) => { value.lessons = []; }, /metadata fields/],
    ["null item", (value) => { value.items = [null]; }, /item fields/],
    ["item field", (value) => { value.items[0].project = "not-work"; }, /item fields/],
    ["repository", (value) => { value.items[0].repository = "Other/Repository"; }, /not canonical/],
    ["number", (value) => { value.items[0].number = "12"; }, /not canonical/],
    ["kind", (value) => { value.items[0].kind = "pr"; }, /not canonical/],
    ["URL query", (value) => { value.items[0].url += "?extra=1"; }, /not canonical/],
    ["URL path", (value) => { value.items[0].url = "https://github.com/acme/widgets"; }, /Invalid followed GitHub item/],
    ["duplicate", (value) => { value.items.push({ ...value.items[0], repository: "acme/widgets", url: issue.toLowerCase() }); }, /Duplicate followed GitHub identity/],
    ["contradictory duplicate", (value) => { value.items.push({ ...value.items[0], kind: "pr", url: issue.replace("issues", "pull") }); }, /Duplicate followed GitHub identity/],
    ["note size", (value) => { value.items[0].note = "x".repeat(2001); }, /at most 2000 characters/],
    ["note type", (value) => { value.items[0].note = 42; }, /at most 2000 characters/],
    ["empty note", (value) => { value.items[0].note = ""; }, /empty following note/],
    ["timestamp", (value) => { value.items[0].followedAt = "not-a-date"; }, /timestamp/],
    ["calendar date", (value) => { value.items[0].followedAt = "2026-02-30T00:00:00.000Z"; }, /timestamp/],
    ["missing timestamp", (value) => { delete value.items[0].followedAt; }, /timestamp/],
  ];
  for (const [name, mutate, error] of cases) {
    const value = metadata(original);
    mutate(value);
    const changed = replaceMetadata(original, value);
    await writeFile(path, changed);
    await assert.rejects(readFollowing(root), error, name);
    await assert.rejects(followGitHubItem(root, { url: pr }), error, name);
    await assert.rejects(unfollowGitHubItem(root, issue), error, name);
    assert.equal(await readFile(path, "utf8"), changed, name);
  }
});

test("following refuses malformed metadata and manual or stale generated views without overwrites", async (t) => {
  const root = await directory(t);
  await followGitHubItem(root, { url: issue });
  const path = join(root, FOLLOWING_FILE);
  const original = await readFile(path, "utf8");
  const changedMetadata = metadata(original);
  changedMetadata.items[0].note = "Not in the generated view";
  for (const [source, error] of [
    ["not a record\n", /missing Hari metadata/],
    [original.replace('"version": 1', '"version": invalid'), /invalid Hari metadata/],
    [`${original}manual prose\n`, /manual or stale generated-view edits/],
    [replaceMetadata(original, changedMetadata), /manual or stale generated-view edits/],
    [original.replace("# Hari following", "# Edited view"), /manual or stale generated-view edits/],
  ]) {
    await writeFile(path, source);
    await assert.rejects(readFollowing(root), error);
    await assert.rejects(readCoordinationRecord(root, "following"), error);
    await assert.rejects(followGitHubItem(root, { url: pr }), error);
    await assert.rejects(unfollowGitHubItem(root, issue), error);
    assert.equal(await readFile(path, "utf8"), source);
  }
});

test("following rejects symlinks, dangling links, nonregular files, and filesystem errors", async (t) => {
  const root = await directory(t);
  await followGitHubItem(root, { url: issue });
  const path = join(root, FOLLOWING_FILE);
  const original = await readFile(path, "utf8");
  const target = join(root, "target.md");
  await writeFile(target, original);
  for (const destination of [target, join(root, "missing.md")]) {
    await rm(path);
    await symlink(destination, path);
    await assert.rejects(readFollowing(root), /regular file/);
    await assert.rejects(followGitHubItem(root, { url: pr }), /regular file/);
    await assert.rejects(unfollowGitHubItem(root, issue), /regular file/);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
  }
  assert.equal(await readFile(target, "utf8"), original);
  await rm(path);
  await mkdir(path);
  await assert.rejects(readFollowing(root), /regular file/);
  await assert.rejects(followGitHubItem(root, { url: pr }), /regular file/);
  await assert.rejects(unfollowGitHubItem(root, issue), /regular file/);
  await assert.rejects(readFollowing(target), { code: "ENOTDIR" });
});

test("an initialized home needs no following migration and its other records stay unchanged", async (t) => {
  const root = await directory(t);
  await initializeCoordination(root, resources);
  const paths = ["PROJECTS.md", "INBOX.md", ".hari/launcher.json"];
  const before = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  assert.deepEqual(await readFollowing(root), { version: 1, items: [] });
  assert.deepEqual(await initializeCoordination(root, resources), { created: [] });
  await assert.rejects(lstat(join(root, FOLLOWING_FILE)), { code: "ENOENT" });
  await followGitHubItem(root, { url: issue });
  await followGitHubItem(root, { url: pr });
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(root, path), "utf8"))), before);
  assert.deepEqual((await readIndex(root)).projects, []);
  assert.deepEqual((await readInbox(root)).items, []);
});
