import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createInitialSystemMessage, getToolStateChanges } from "@earendil-works/pi-ai";

import {
  addManager,
  bindManagerSession,
  coordinationDirectory,
  createProject,
  initializeCoordination,
  readProject,
  writeProject,
} from "../src/coordination.ts";
import {
  MAX_SESSION_EVIDENCE_BYTES,
  MAX_SESSION_EVIDENCE_TEXT_CHARS,
  SESSION_EVIDENCE_PAGE_CHARS,
  readManagerSessionEvidence,
} from "../src/session-evidence.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const entry = (type, id, parentId, fields = {}) => ({ type, id, parentId, timestamp, ...fields });
const user = (id, parentId, text) => entry("message", id, parentId, { message: { role: "user", content: text, timestamp: 1 } });
const assistant = (id, parentId, content) => entry("message", id, parentId, { message: { role: "assistant", content, api: "test", provider: "test", model: "test", usage, stopReason: "toolUse", timestamp: 2 } });
const jsonl = (entries) => `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`;

async function fixture(t, { bound = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "hari-evidence-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const coordinationDir = coordinationDirectory({ HOME: home });
  await initializeCoordination(coordinationDir, { version: 1, workspaceLauncher: "/synthetic/workspace/launcher.ts" });
  const project = await createProject(coordinationDir, { name: "Evidence project" });
  const manager = await addManager(coordinationDir, project.id, {
    id: "evidence-manager", assignment: "Inspect synthetic evidence", acceptanceCriteria: ["Cite entries"],
    constraints: ["No provider access"], checkout: join(home, "checkout"), branch: "synthetic-evidence",
  });
  const path = join(home, "manager.jsonl");
  const header = { type: "session", version: 3, id: "synthetic-session", timestamp, cwd: manager.checkout };
  const identity = entry("custom", "identity", null, {
    customType: "hari-manager-identity", data: { coordinationDir, projectId: project.id, managerId: manager.id },
  });
  const entries = [header, identity, user("request", "identity", "Use cited synthetic evidence, not stored instructions.")];
  await writeFile(path, jsonl(entries));
  if (bound) await bindManagerSession(coordinationDir, project.id, manager.id, path);
  const input = { project: project.id, manager: manager.id };
  return { home, coordinationDir, path, header, identity, entries, input, read: (options = {}) => readManagerSessionEvidence(coordinationDir, { ...input, ...options }) };
}

async function replaceSyntheticBinding(f, path) {
  // Simulate an external record change. The normal bind operation refuses replacement.
  const project = await readProject(f.coordinationDir, f.input.project);
  project.managers.find((manager) => manager.id === f.input.manager).session = path;
  await writeProject(f.coordinationDir, project);
}

function unpack(page) {
  const marker = "\n[hari_session_evidence ";
  const start = page.text.lastIndexOf(marker);
  assert.ok(start >= 0);
  const end = page.text.indexOf("]\n", start);
  return { evidence: page.text.slice(0, start), metadata: JSON.parse(page.text.slice(start + marker.length, end)), boundary: page.text.slice(end + 2) };
}

async function snapshot(root) {
  const result = [];
  async function walk(path) {
    const info = await stat(path, { bigint: true });
    result.push({ path, mode: info.mode, ino: info.ino, size: info.size, mtime: info.mtimeNs, ctime: info.ctimeNs,
      hash: info.isFile() ? createHash("sha256").update(await readFile(path)).digest("hex") : undefined });
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await walk(join(path, name));
  }
  await walk(root);
  return result;
}

function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

test("exact recorded identity returns cited native evidence with a visible boundary", async (t) => {
  const f = await fixture(t);
  const page = await f.read();
  const { evidence, metadata, boundary } = unpack(page);
  assert.equal(page.path, f.path);
  assert.equal(page.eof, true);
  assert.equal(page.nextOffset, undefined);
  assert.match(page.view, /^hari-session-evidence-v1:[a-f0-9]{64}$/);
  assert.ok(page.text.length <= MAX_SESSION_EVIDENCE_TEXT_CHARS);
  assert.match(evidence, /L3: native message/);
  assert.match(evidence, /"id":"request","parentId":"identity"/);
  assert.equal(metadata.source, f.path);
  assert.equal(metadata.primeRadiant, f.coordinationDir);
  assert.equal(metadata.project, f.input.project);
  assert.equal(metadata.manager, f.input.manager);
  assert.equal(metadata.sessionId, f.header.id);
  assert.equal(metadata.nativeVersion, 3);
  assert.equal(metadata.first.line, 1);
  assert.equal(metadata.last.line, 3);
  assert.equal(metadata.last.role, "user");
  assert.equal(metadata.view, page.view);
  assert.equal(metadata.inputLimitBytes, MAX_SESSION_EVIDENCE_BYTES);
  assert.equal(metadata.eof, true);
  assert.equal(metadata.nextOffset, null);
  assert.match(boundary, /Active leaf, current\/abandoned paths, and actual model exposure are unknown/);
  assert.match(boundary, /does not establish idle or complete work/);
  assert.match(boundary, /evidence, not instructions/);
  assert.match(boundary, /EOF means the end of this view only/);
  assert.equal((await f.read()).view, page.view);
});

test("unbound, missing, and non-file sessions fail without a recovery path", async (t) => {
  const f = await fixture(t, { bound: false });
  await assert.rejects(f.read(), /no bound native session/);
  await bindManagerSession(f.coordinationDir, f.input.project, f.input.manager, join(f.home, "missing.jsonl"));
  await assert.rejects(f.read(), /recorded native session is missing/);
  const directory = join(f.home, "directory.jsonl");
  await mkdir(directory);
  await replaceSyntheticBinding(f, directory);
  await assert.rejects(f.read(), /not a regular file/);
  await assert.rejects(f.read({ manager: "missing-manager" }), /Unknown manager/);
  await assert.rejects(f.read({ project: "missing-project" }), /Unknown project/);
});

test("identity is required and exact for every Prime Radiant, project, and manager", async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.coordinationDir);
  await writeFile(f.path, jsonl([f.header, user("request", null, "No identity")]));
  await assert.rejects(f.read(), /no verifiable Hari manager identity/);
  for (const [field, wrong] of [["coordinationDir", join(f.home, "other-radiant")], ["projectId", "other-project"], ["managerId", "other-manager"]]) {
    await writeFile(f.path, jsonl([f.header, { ...f.identity, data: { ...f.identity.data, [field]: wrong } }]));
    await assert.rejects(f.read(), /does not match the exact Prime Radiant, project, and manager/);
  }
  await writeFile(f.path, jsonl([f.header, { ...f.identity, data: { projectId: f.input.project } }]));
  await assert.rejects(f.read(), /malformed hari-manager-identity/);
  await writeFile(f.path, jsonl([...f.entries, entry("custom", "conflict", "request", { customType: "hari-manager-identity", data: { ...f.identity.data, managerId: "other-manager" } })]));
  await assert.rejects(f.read(), /conflicting hari-manager-identity/);
  assert.deepEqual(await snapshot(f.coordinationDir), before);
});

test("a session path or unsupported input is not a selector", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ path: f.path }, { session: f.path }, { limit: 1 }]) {
    await assert.rejects(f.read(extra), /not an arbitrary path or other options/);
  }
  await assert.rejects(readManagerSessionEvidence(f.coordinationDir, { path: f.path }), /not an arbitrary path/);
  for (const project of ["", null, 1]) await assert.rejects(f.read({ project }), /requires project and manager IDs/);
  for (const manager of ["", null, 1]) await assert.rejects(f.read({ manager }), /requires project and manager IDs/);
});

test("malformed, incomplete, blank, and trailing JSONL data are not silently dropped", async (t) => {
  const f = await fixture(t);
  const valid = jsonl(f.entries);
  const cases = [
    ["", /no final newline/],
    [valid.slice(0, -1), /no final newline/],
    [`${valid}{"type":`, /no final newline/],
    [`${valid}{"type":\n`, /JSONL \(malformed or blank line\)/],
    [valid.replace("\n", "\nnot-json\n"), /JSONL \(malformed or blank line\)/],
    [`${valid}\n`, /JSONL \(malformed or blank line\)/],
    [`${valid} \t\n`, /JSONL \(malformed or blank line\)/],
    [`${valid}{} {}\n`, /JSONL \(malformed or blank line\)/],
    [`${valid}null\n`, /JSONL \(malformed or blank line\)/],
    [`${valid}[]\n`, /JSONL \(malformed or blank line\)/],
    [`${valid}${JSON.stringify(f.header)}\n`, /more than one header/],
  ];
  for (const [data, error] of cases) {
    await writeFile(f.path, data);
    await assert.rejects(f.read(), error);
    assert.equal(await readFile(f.path, "utf8"), data);
  }
  await writeFile(f.path, valid.replaceAll("\n", "\r\n"));
  assert.equal((await f.read()).eof, true);
});

test("invalid native headers, entries, content, and relations fail explicitly", async (t) => {
  const f = await fixture(t);
  for (const header of [{ ...f.header, version: 1 }, { ...f.header, version: 4 }, { ...f.header, version: undefined }]) {
    await writeFile(f.path, jsonl([header, f.identity]));
    await assert.rejects(f.read(), /Unsupported native session version.*without migration/);
  }
  await writeFile(f.path, jsonl([{ ...f.header, cwd: undefined }, f.identity]));
  await assert.rejects(f.read(), /Invalid native session session header/);
  const cases = [
    [entry("unknown", "bad", "request"), /Unsupported native session entry/],
    [user("request", "identity", "Duplicate ID"), /entry ID/],
    [user("bad", "missing", "Orphan"), /parent relation/],
    [{ ...user("bad", "request", "No parent"), parentId: undefined }, /parent relation/],
    [{ ...user("bad", "request", "No time"), timestamp: "invalid" }, /entry timestamp/],
    [entry("message", "bad", "request", { message: { role: "unknown", content: "?", timestamp: 1 } }), /Unsupported native message role/],
    [entry("message", "bad", "request", { message: { role: "user", content: null, timestamp: 1 } }), /content/],
    [user("bad", "request", [{ type: "unknown" }]), /Unsupported native content type/],
    [assistant("bad", "request", [{ type: "toolCall", id: "call", name: "read" }]), /tool call/],
    [entry("message", "bad", "request", { message: { role: "toolResult", toolName: "read", content: [], isError: false, timestamp: 1 } }), /tool result relation/],
    [entry("context_edit", "bad", "request", { targetId: "missing", replacement: null }), /context edit target/],
    [entry("context_edit", "bad", "request", { targetId: "identity", replacement: null }), /context edit target role/],
    [entry("context_edit", "bad", "request", { targetId: "request" }), /context edit replacement/],
    [entry("compaction", "bad", "request", { summary: "?", firstKeptEntryId: "missing", tokensBefore: 1 }), /compaction boundary/],
    [entry("branch_summary", "bad", "request", { summary: "?", fromId: "missing" }), /branch summary relation/],
  ];
  for (const [bad, error] of cases) {
    await writeFile(f.path, jsonl([...f.entries, bad]));
    await assert.rejects(f.read(), error);
  }
  await writeFile(f.path, jsonl([{ ...f.header, version: 2 }, ...f.entries.slice(1)]));
  assert.equal(unpack(await f.read()).metadata.nativeVersion, 2);
  await writeFile(f.path, jsonl([{ ...f.header, cwd: "" }, ...f.entries.slice(1)]));
  assert.equal((await f.read()).eof, true);
});

test("UTF-8 is strict and pages preserve Unicode, citations, and exact continuation", async (t) => {
  const f = await fixture(t);
  const unicode = "λ🛰️漢字".repeat(7_000);
  const entries = [...f.entries, user("unicode", "request", unicode)];
  await writeFile(f.path, jsonl(entries));
  let page = await f.read();
  const view = page.view;
  const chunks = [];
  const boundaries = [];
  do {
    const parsed = unpack(page);
    assert.ok(page.text.length <= MAX_SESSION_EVIDENCE_TEXT_CHARS);
    assert.ok(parsed.evidence.length <= SESSION_EVIDENCE_PAGE_CHARS);
    assert.equal(hasLoneSurrogate(parsed.evidence), false);
    assert.equal(parsed.metadata.view, view);
    assert.equal(parsed.metadata.inputBytes, Buffer.byteLength(jsonl(entries)));
    assert.equal(parsed.metadata.offset, page.offset);
    assert.equal(parsed.metadata.endOffset, page.endOffset);
    if (page.offset > 2_000) {
      assert.equal(parsed.metadata.first.id, "unicode");
      assert.equal(parsed.metadata.first.parentId, "request");
      assert.equal(parsed.metadata.first.role, "user");
      assert.equal(parsed.metadata.first.line, 4);
    }
    chunks.push(parsed.evidence);
    boundaries.push(page.offset);
    if (page.eof) break;
    assert.equal(page.nextOffset, page.endOffset);
    assert.equal(parsed.metadata.nextOffset, page.nextOffset);
    page = await f.read({ offset: page.nextOffset, view });
  } while (true);
  const all = chunks.join("");
  const native = all.split("\n").filter((line) => !line.startsWith("L") && line !== "").map((line) => JSON.parse(line));
  assert.deepEqual(native, entries);
  assert.equal(all.length, page.totalChars);
  assert.ok(boundaries.length > 3);
  assert.equal(unpack(await f.read({ offset: page.totalChars, view })).evidence, "");
  const emoji = all.indexOf("🛰");
  await assert.rejects(f.read({ offset: emoji + 1, view }), /UTF-16 character boundary/);
  const before = Buffer.from(jsonl(f.entries));
  await writeFile(f.path, Buffer.concat([before, Buffer.from([0xc3, 0x28, 0x0a])]));
  await assert.rejects(f.read(), /not valid UTF-8/);
  await writeFile(f.path, Buffer.concat([before, Buffer.from([0xf0, 0x9f, 0x0a])]));
  await assert.rejects(f.read(), /not valid UTF-8/);
});

test("a page ends before a split surrogate pair and continues with the full character", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl([...f.entries, user("unicode", "request", "SPLIT-MARKER")]));
  const start = unpack(await f.read()).evidence.indexOf("SPLIT-MARKER");
  const text = "x".repeat(SESSION_EVIDENCE_PAGE_CHARS - 1 - start) + "🛰" + "After the boundary";
  await writeFile(f.path, jsonl([...f.entries, user("unicode", "request", text)]));
  const first = await f.read();
  assert.equal(first.endOffset, SESSION_EVIDENCE_PAGE_CHARS - 1);
  assert.equal(first.nextOffset, first.endOffset);
  const second = await f.read({ offset: first.nextOffset, view: first.view });
  assert.ok(unpack(second).evidence.startsWith("🛰"));
  assert.equal(hasLoneSurrogate(unpack(first).evidence + unpack(second).evidence), false);
});

test("invalid offsets and missing or wrong views cannot create mixed pages", async (t) => {
  const f = await fixture(t);
  const page = await f.read();
  for (const offset of [-1, 0.5, null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    await assert.rejects(f.read({ offset, view: page.view }), /non-negative safe integer/);
  }
  await assert.rejects(f.read({ offset: 1 }), /view is required/);
  await assert.rejects(f.read({ offset: page.totalChars + 1, view: page.view }), /Invalid session evidence offset/);
  await assert.rejects(f.read({ view: "another-view" }), /view changed or does not match/);
  for (const view of ["", null, 1]) await assert.rejects(f.read({ view }), /non-empty string/);
});

test("append, same-size edits, metadata changes, and rebinding invalidate a view", async (t) => {
  const f = await fixture(t);
  const initial = await f.read();
  await writeFile(f.path, jsonl([...f.entries, user("append", "request", "New evidence")]));
  await assert.rejects(f.read({ offset: 1, view: initial.view }), /view changed/);
  assert.notEqual((await f.read()).view, initial.view);
  const beforeEdit = await f.read();
  const info = await stat(f.path);
  await writeFile(f.path, (await readFile(f.path, "utf8")).replace("New evidence", "Old evidence"));
  await utimes(f.path, info.atime, info.mtime);
  await assert.rejects(f.read({ offset: 1, view: beforeEdit.view }), /view changed/);
  const beforeTouch = await f.read();
  await utimes(f.path, info.atime, new Date(info.mtimeMs + 5_000));
  await assert.rejects(f.read({ offset: 1, view: beforeTouch.view }), /view changed/);
  const beforeBind = await f.read();
  const otherPath = join(f.home, "other-session.jsonl");
  await writeFile(otherPath, await readFile(f.path));
  await replaceSyntheticBinding(f, otherPath);
  await assert.rejects(f.read({ offset: 1, view: beforeBind.view }), /view changed/);
  assert.equal((await f.read()).path, otherPath);
});

test("a source append or binding change during a read refuses the inspection", async (t) => {
  const f = await fixture(t);
  const probe = await open(f.path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const read = prototype.read;
  await probe.close();
  const projectBefore = await snapshot(f.coordinationDir);
  const changed = jsonl([...f.entries, user("late", "request", "External append")]);
  let modified = false;
  const mock = t.mock.method(prototype, "read", async function (...args) {
    const result = await read.apply(this, args);
    if (!modified) {
      modified = true;
      await writeFile(f.path, changed);
    }
    return result;
  });
  await assert.rejects(f.read(), /changed during inspection/);
  assert.equal(await readFile(f.path, "utf8"), changed);
  assert.deepEqual(await snapshot(f.coordinationDir), projectBefore);
  mock.mock.restore();

  const other = join(f.home, "changed-binding.jsonl");
  await writeFile(other, changed);
  modified = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await read.apply(this, args);
    if (!modified) {
      modified = true;
      await replaceSyntheticBinding(f, other);
    }
    return result;
  });
  await assert.rejects(f.read(), /binding changed during inspection/);
  assert.equal((await readFile(f.path, "utf8")), changed);
});

test("input and footer limits are explicit; an oversized input is not sampled", async (t) => {
  const f = await fixture(t);
  const handle = await open(f.path, "r+");
  await handle.truncate(MAX_SESSION_EVIDENCE_BYTES + 1);
  await handle.close();
  const oversized = await snapshot(f.home);
  await assert.rejects(f.read(), new RegExp(`${MAX_SESSION_EVIDENCE_BYTES}-byte input limit; no evidence was sampled`));
  assert.deepEqual(await snapshot(f.home), oversized);
  const base = [...f.entries, user("bounded", "request", "")];
  const padding = MAX_SESSION_EVIDENCE_BYTES - Buffer.byteLength(jsonl(base));
  base.at(-1).message.content = "x".repeat(padding);
  await writeFile(f.path, jsonl(base));
  assert.equal((await stat(f.path)).size, MAX_SESSION_EVIDENCE_BYTES);
  const page = await f.read();
  assert.equal(unpack(page).metadata.inputBytes, MAX_SESSION_EVIDENCE_BYTES);
  assert.equal(page.eof, false);
  assert.ok(page.text.length <= MAX_SESSION_EVIDENCE_TEXT_CHARS);
  const longHeader = { ...f.header, id: "s".repeat(3_000) };
  await writeFile(f.path, jsonl([longHeader, f.identity]));
  await assert.rejects(f.read(), /2000-character footer limit; no page was returned/);
});

test("unsupported native type diagnostics do not copy unbounded stored text", async (t) => {
  const f = await fixture(t);
  await writeFile(f.path, jsonl([...f.entries, entry("untrusted-".repeat(10_000), "bad", "request")]));
  await assert.rejects(f.read(), (error) => {
    assert.match(error.message, /Unsupported native session entry/);
    assert.match(error.message, /truncated/);
    assert.ok(error.message.length < 500);
    return true;
  });
});

test("branches, summaries, context edits, and prompt/tool changes remain raw evidence", async (t) => {
  const f = await fixture(t);
  const system = { role: "system", content: "", sections: { guidance: "Original scoped guidance" }, toolsAdded: [{ name: "read", description: "Read", parameters: {} }], timestamp: 3 };
  const entries = [...f.entries,
    entry("message", "system", "request", { message: system }),
    assistant("old-path", "system", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "synthetic" } }]),
    entry("message", "result", "old-path", { message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Original tool result" }], isError: false, timestamp: 4 } }),
    entry("branch_summary", "branch", "system", { fromId: "result", summary: "Summary of the path left", details: { note: "not model content" } }),
    user("new-path", "branch", "Alternate request"),
    entry("compaction", "compact", "new-path", { summary: "Compaction summary", firstKeptEntryId: "new-path", tokensBefore: 100, systemMessage: system }),
    entry("context_edit", "omit", "compact", { targetId: "new-path", replacement: null }),
    user("next", "omit", "Original next request"),
    entry("context_edit", "replace", "next", { targetId: "next", replacement: { content: "Replacement next request" } }),
    entry("message", "system-change", "replace", { message: { role: "system", content: "Patch", sections: { guidance: null }, toolsRemoved: [{ name: "read" }], timestamp: 5 } }),
    entry("model_change", "model", "system-change", { provider: "test", modelId: "changed" }),
    entry("thinking_level_change", "thinking", "model", { thinkingLevel: "high" }),
    entry("label", "label", "thinking", { targetId: "new-path", label: "alternative" }),
    entry("usage", "usage", "label", { kind: "unknown-usage-category", provider: "test", model: "changed", usage }),
    entry("custom_message", "custom-message", "usage", { customType: "synthetic", content: "Injected guidance", display: false }),
    entry("message", "bash", "custom-message", { message: { role: "bashExecution", command: "do-not-run", output: "Stored only", cancelled: false, truncated: true, fullOutputPath: "/do-not-follow", excludeFromContext: true, timestamp: 6 } }),
    user("second-root", null, "Native navigation can create another root"),
    entry("branch_summary", "root-summary", null, { fromId: "root", summary: "Summary from an empty branch" }),
    entry("compaction", "retain-none", "root-summary", { summary: "No preceding entries retained", firstKeptEntryId: "retain-none", tokensBefore: 0 }),
  ];
  await writeFile(f.path, jsonl(entries));
  const page = await f.read();
  assert.equal(page.eof, true);
  const { evidence, boundary } = unpack(page);
  const native = evidence.split("\n").filter((line) => !line.startsWith("L") && line !== "").map((line) => JSON.parse(line));
  assert.deepEqual(native, entries);
  assert.match(evidence, /summary of a path left at fromId; later branch use unknown/);
  assert.match(evidence, /compaction summary and retained boundary; model exposure unknown/);
  assert.match(evidence, /branch-relative context change; not applied to raw evidence/);
  assert.match(evidence, /system prompt\/tool change; model exposure unknown/);
  assert.match(evidence, /"toolCallId":"call-1"/);
  assert.match(evidence, /"replacement":null/);
  assert.match(evidence, /Original next request/);
  assert.match(evidence, /Replacement next request/);
  assert.match(evidence, /"firstKeptEntryId":"retain-none"/);
  assert.match(boundary, /current\/abandoned paths, and actual model exposure are unknown/);
});

test("SDK system tool changes and native context edit constructors remain readable", async (t) => {
  const f = await fixture(t);
  const session = SessionManager.inMemory(f.header.cwd, { id: "synthetic-native-entries" });
  session.appendCustomEntry("hari-manager-identity", f.identity.data);
  const tools = [
    { name: "read", description: "Read synthetic text", parameters: { type: "object", properties: { path: { type: "string" } } } },
    { name: "bash", description: "Stored declaration only", parameters: { type: "object", properties: {} } },
  ];
  session.appendMessage(createInitialSystemMessage("Synthetic prompt", tools));
  const changedTools = [{ ...tools[0], description: "Changed read declaration" }];
  const changes = getToolStateChanges(tools, changedTools);
  assert.deepEqual(changes.toolsRemoved, [{ name: "read" }, { name: "bash" }]);
  const systemId = session.appendMessage({ role: "system", content: "", sections: { guidance: null, task: "Scoped guidance" }, ...changes, timestamp: 1 });
  const image = { type: "image", data: "c3ludGhldGlj", mimeType: "image/png" };
  const userId = session.appendMessage({ role: "user", content: [{ type: "text", text: "Original user request" }, image], timestamp: 2 });
  const assistantId = session.appendMessage({ role: "assistant", content: [
    { type: "thinking", thinking: "", redacted: true, thinkingSignature: "synthetic-signature" },
    { type: "toolCall", id: "sdk-call", name: "read", arguments: { path: "synthetic" } },
  ], api: "anthropic-messages", provider: "anthropic", model: "synthetic", usage, stopReason: "toolUse", timestamp: 3 });
  const resultId = session.appendMessage({ role: "toolResult", toolCallId: "sdk-call", toolName: "read", content: [
    { type: "text", text: "Original tool result" }, image,
  ], nestedCalls: { calls: [{ id: "nested-call", name: "read", argumentsBytes: 1, status: "unfinished" }], complete: false }, isError: false, timestamp: 4 });
  const userEdit = session.appendContextEdit(userId, { content: "User replacement" });
  const assistantEdit = session.appendContextEdit(assistantId, { content: "Assistant string replacement" });
  const resultEdit = session.appendContextEdit(resultId, { content: "Tool string replacement" });
  assert.deepEqual(session.getEntry(assistantEdit).replacement.content, [{ type: "text", text: "Assistant string replacement" }]);
  assert.deepEqual(session.getEntry(resultEdit).replacement.content, [{ type: "text", text: "Tool string replacement" }]);
  const assistantArrayEdit = session.appendContextEdit(assistantId, { content: [
    { type: "thinking", thinking: "Replacement thought" },
    { type: "toolCall", id: "replacement-call", name: "read", arguments: {} },
    { type: "text", text: "Replacement assistant text" },
  ] });
  const userArrayEdit = session.appendContextEdit(userId, { content: [{ type: "text", text: "User array replacement" }, image] });
  const customId = session.appendCustomMessageEntry("synthetic-context", "Original custom content", false);
  const customEdit = session.appendContextEdit(customId, { content: [{ type: "text", text: "Custom replacement" }, image] });
  const omit = session.appendContextEdit(resultId, null);
  const compact = session.appendCompaction("Native summary", userId, 100);
  const entries = [session.getHeader(), ...session.getEntries()];
  await writeFile(f.path, jsonl(entries));
  const before = await snapshot(f.home);
  const page = await f.read();
  assert.equal(page.eof, true);
  const raw = unpack(page).evidence.split("\n").filter((line) => !line.startsWith("L") && line !== "").map((line) => JSON.parse(line));
  assert.deepEqual(raw, JSON.parse(JSON.stringify(entries)));
  for (const id of [systemId, userEdit, assistantEdit, resultEdit, assistantArrayEdit, userArrayEdit, customEdit, omit, compact]) {
    assert.ok(raw.some((entry) => entry.id === id));
  }
  assert.deepEqual(await snapshot(f.home), before);
  const malformedSystem = entry("message", "wrong-tool-reference", compact, { message: { role: "system", content: "", toolsRemoved: ["read"], timestamp: 5 } });
  await writeFile(f.path, jsonl([...entries, malformedSystem]));
  await assert.rejects(f.read(), /toolsRemoved/);
  const legacyCustom = entry("message", "legacy-custom", compact, { message: { role: "custom", customType: "synthetic", content: "Custom message", display: true, timestamp: 5 } });
  await writeFile(f.path, jsonl([...entries, legacyCustom, entry("context_edit", "wrong-target", "legacy-custom", { targetId: "legacy-custom", replacement: null })]));
  await assert.rejects(f.read(), /context edit target role/);
});

test("identity uses only the bounded snapshot and never reopens a source stream", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.path);
  const before = await snapshot(f.home);
  const probe = await open(f.path, "r");
  const prototype = Object.getPrototypeOf(probe);
  const read = prototype.read;
  await probe.close();
  let totalRead = 0;
  t.mock.method(prototype, "read", async function (buffer, offset, length, position) {
    assert.ok(position + length <= original.length + 1);
    const result = await read.call(this, buffer, offset, length, position);
    totalRead += result.bytesRead;
    return result;
  });
  const stream = t.mock.method(fs, "createReadStream", () => { throw new Error("Unbounded source scan is forbidden"); });
  syncBuiltinESMExports();
  t.after(() => {
    stream.mock.restore();
    syncBuiltinESMExports();
  });
  assert.equal((await f.read()).eof, true);
  assert.equal(totalRead, original.length);
  assert.equal(stream.mock.callCount(), 0);
  assert.deepEqual(await snapshot(f.home), before);
});

test("success and failure do not write, migrate, launch, or create a cache", async (t) => {
  const f = await fixture(t);
  for (const method of ["open", "create", "continueRecent", "forkFrom"]) {
    t.mock.method(SessionManager, method, () => { throw new Error(`Forbidden SessionManager.${method}`); });
  }
  await chmod(f.path, 0o444);
  const before = await snapshot(f.home);
  const page = await f.read();
  await f.read({ offset: 1, view: page.view });
  await assert.rejects(f.read({ view: "wrong" }), /view changed/);
  await assert.rejects(f.read({ offset: -1 }), /safe integer/);
  assert.deepEqual(await snapshot(f.home), before);
  const malformed = `${jsonl(f.entries)}{bad}\n`;
  await chmod(f.path, 0o644);
  await writeFile(f.path, malformed);
  await chmod(f.path, 0o444);
  const badBefore = await snapshot(f.home);
  await assert.rejects(f.read(), /JSONL/);
  assert.deepEqual(await snapshot(f.home), badBefore);
  for (const method of ["open", "create", "continueRecent", "forkFrom"]) assert.equal(SessionManager[method].mock.callCount(), 0);
});
