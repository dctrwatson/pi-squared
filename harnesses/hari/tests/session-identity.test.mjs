import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectHariManagerSession, inspectHariManagerSessionEntries } from "../src/session-identity.ts";

test("native-session identity detects a prior Hari manager without becoming a registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    JSON.stringify({ type: "session", version: 1 }),
    JSON.stringify({
      type: "custom",
      customType: "hari-manager-identity",
      data: { coordinationDir: "/tmp/coordination", projectId: "project", managerId: "manager" },
    }),
  ].join("\n"));
  assert.deepEqual(await inspectHariManagerSession(session), {
    identity: { coordinationDir: "/tmp/coordination", projectId: "project", managerId: "manager" },
  });
});

test("only the exact public Pi workspace placeholder is pristine", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    JSON.stringify({ type: "session", version: 3, cwd: "/tmp/checkout" }),
    JSON.stringify({ type: "session_info", name: "feature/prepared" }),
    JSON.stringify({ type: "custom", customType: "pi-workspace-session-name", data: { branch: "feature/prepared" } }),
    JSON.stringify({ type: "custom", customType: "pi-workspace", data: { repository: "/tmp/checkout/.git", branch: "feature/prepared", cwd: "/tmp/checkout" } }),
  ].join("\n"));
  assert.deepEqual(await inspectHariManagerSession(session), { pristineWorkspace: true });
  await writeFile(session, `${await readFile(session, "utf8")}\n${JSON.stringify({ type: "custom", customType: "unrelated-extension-entry", data: {} })}`);
  assert.deepEqual(await inspectHariManagerSession(session), {});
});

test("identity at session start survives a later conversation beyond the former tail limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    JSON.stringify({ type: "session", version: 1 }),
    JSON.stringify({
      type: "custom",
      customType: "hari-manager-identity",
      data: { coordinationDir: "/tmp/coordination", projectId: "project", managerId: "manager" },
    }),
    JSON.stringify({ type: "message", role: "assistant", content: "x".repeat(300_000) }),
  ].join("\n"));
  assert.deepEqual(await inspectHariManagerSession(session), {
    identity: { coordinationDir: "/tmp/coordination", projectId: "project", managerId: "manager" },
  });
});

test("conflicting or malformed Hari identity entries remain uncertain", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  await writeFile(session, [
    JSON.stringify({ type: "session", version: 1 }),
    JSON.stringify({ type: "custom", customType: "hari-manager-identity", data: { coordinationDir: "/tmp/a", projectId: "project", managerId: "manager" } }),
    JSON.stringify({ type: "custom", customType: "hari-manager-identity", data: { coordinationDir: "/tmp/b", projectId: "project", managerId: "manager" } }),
  ].join("\n"));
  assert.match((await inspectHariManagerSession(session)).uncertain ?? "", /conflicting/);
  await writeFile(session, JSON.stringify({ type: "custom", customType: "hari-manager-identity", data: { projectId: "missing" } }));
  assert.match((await inspectHariManagerSession(session)).uncertain ?? "", /malformed/);
});

test("escaped conflicting identity in a valid entry beyond the former tail limit is detected", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  const escapedIdentity = `{"type":"custom","customType":"hari\\u002dmanager\\u002didentity","data":{"coordinationDir":"/tmp/b","projectId":"project","managerId":"manager"},"padding":"${"x".repeat(300_000)}"}`;
  await writeFile(session, [
    JSON.stringify({ type: "session", version: 1 }),
    JSON.stringify({ type: "custom", customType: "hari-manager-identity", data: { coordinationDir: "/tmp/a", projectId: "project", managerId: "manager" } }),
    escapedIdentity,
  ].join("\n"));
  assert.match((await inspectHariManagerSession(session)).uncertain ?? "", /conflicting/);
});

test("entries over the explicit 16 MiB parser cap surface uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-session-identity-"));
  const session = join(root, "session.jsonl");
  await writeFile(session, "x".repeat(17 * 1024 * 1024));
  assert.match((await inspectHariManagerSession(session)).uncertain ?? "", /line limit/);
});

test("parsed snapshot inspection shares exact launch identity and placeholder rules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hari-identity-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = join(root, "session.jsonl");
  const header = { type: "session", version: 3, cwd: "/synthetic/checkout" };
  const data = { coordinationDir: "/synthetic/radiant", projectId: "project", managerId: "manager" };
  const identity = { type: "custom", customType: "hari-manager-identity", data };
  const placeholder = [header,
    { type: "session_info", name: "feature/prepared" },
    { type: "custom", customType: "pi-workspace-session-name", data: { branch: "feature/prepared" } },
    { type: "custom", customType: "pi-workspace", data: { repository: "/synthetic/checkout/.git", branch: "feature/prepared", cwd: "/synthetic/checkout" } },
  ];
  const cases = [
    [[], {}],
    [[header], {}],
    [[header, identity], { identity: data }],
    [[header, identity, identity], { identity: data }],
    [placeholder, { pristineWorkspace: true }],
    [[...placeholder, identity], { identity: data }],
    [[...placeholder, { type: "custom", customType: "unknown" }], {}],
    [[header, null], {}],
    [[header, identity, { ...identity, data: { ...data, managerId: "other" } }], /conflicting/],
    [[header, { ...identity, data: { projectId: "project" } }], /malformed/],
    [[header, { ...identity, type: "custom_message" }], /malformed/],
  ];
  for (const [entries, expected] of cases) {
    const original = JSON.stringify(entries);
    await writeFile(session, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const before = await readFile(session);
    const snapshot = inspectHariManagerSessionEntries(entries.values());
    assert.deepEqual(snapshot, await inspectHariManagerSession(session));
    if (expected instanceof RegExp) assert.match(snapshot.uncertain, expected);
    else assert.deepEqual(snapshot, expected);
    assert.equal(JSON.stringify(entries), original);
    assert.deepEqual(await readFile(session), before);
  }
});

test("ordinary launch inspection keeps history uncapped while each line stays bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hari-identity-long-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = join(root, "session.jsonl");
  const data = { coordinationDir: "/synthetic/radiant", projectId: "project", managerId: "manager" };
  await writeFile(session, `${JSON.stringify({ type: "session", version: 3 })}\n${JSON.stringify({ type: "custom", customType: "hari-manager-identity", data })}\n`);
  const line = `${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(1024 * 1024), timestamp: 1 } })}\n`;
  for (let index = 0; index < 17; index += 1) await appendFile(session, line);
  assert.deepEqual(await inspectHariManagerSession(session), { identity: data });
  await appendFile(session, `${JSON.stringify({ type: "custom", customType: "hari-manager-identity", data: { ...data, managerId: "late-conflict" } })}\n`);
  assert.match((await inspectHariManagerSession(session)).uncertain, /conflicting/);
});
