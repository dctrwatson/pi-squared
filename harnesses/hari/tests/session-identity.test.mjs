import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectHariManagerSession } from "../src/session-identity.ts";

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
