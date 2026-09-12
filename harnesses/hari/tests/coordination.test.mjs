import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  addIssue,
  addManager,
  bindManagerSession,
  captureInbox,
  createProject,
  findManager,
  initializeCoordination,
  projectReports,
  readIndex,
  readInbox,
  readProject,
  writeManagerReport,
  amendManager,
  replaceIndexItems,
  replaceProjectItems,
  updateInboxItem,
} from "../src/coordination.ts";

test("file-backed index, inbox, project, and manager report remain separate", async () => {
  const coordination = await mkdtemp(join(tmpdir(), "hari-coordination-"));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });

  const project = await createProject(coordination, {
    name: "Infra queue",
    goal: "Make queue work observable",
    repository: "acme/widgets",
    priority: "high",
  });
  await addIssue(coordination, project.id, {
    reference: "https://github.com/acme/widgets/issues/123",
    title: "Observe queue",
    repository: "acme/widgets",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  const inbox = await captureInbox(coordination, "Check dependent service", project.id);
  const manager = await addManager(coordination, project.id, {
    id: "queue-manager",
    issue: "https://github.com/acme/widgets/issues/123",
    assignment: "Deliver the agreed queue observation outcome",
    acceptanceCriteria: ["Evidence is recorded"],
    constraints: ["No GitHub publication"],
    checkout: "/tmp/queue-checkout",
    branch: "feature/queue-observation",
  });
  await bindManagerSession(coordination, project.id, manager.id, "/tmp/queue.jsonl");
  const reportPath = await writeManagerReport(coordination, project.id, manager.id, {
    result: "Blocked on a missing dependency",
    blockers: ["Dependency has no observed disposition"],
    evidenceReferences: ["docs/evidence.md"],
  });

  assert.equal((await readIndex(coordination)).projects[0].id, project.id);
  assert.equal((await readInbox(coordination)).items[0].id, inbox.id);
  const stored = await readProject(coordination, project.id);
  assert.equal(stored.issues[0].reference, "https://github.com/acme/widgets/issues/123");
  assert.equal(stored.managers[0].checkout, "/tmp/queue-checkout");
  assert.equal((await findManager(coordination, project.id, manager.id)).manager.session, "/tmp/queue.jsonl");
  const reports = await projectReports(coordination, project.id);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].path, reportPath);
  assert.match(reports[0].content, /Blocked on a missing dependency/);

  const indexText = await readFile(join(coordination, "PROJECTS.md"), "utf8");
  const projectText = await readFile(join(coordination, "projects", project.id, "PROJECT.md"), "utf8");
  assert.match(indexText, /Hari projects/);
  assert.match(projectText, /queue-manager/);
  assert.doesNotMatch(projectText, /Blocked on a missing dependency/);
});

test("coordination reads preserve filesystem errors rather than reporting missing records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hari-record-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notDirectory = join(root, "not-a-directory");
  await writeFile(notDirectory, "not a coordination directory\n");
  await assert.rejects(readIndex(notDirectory), { code: "ENOTDIR" });
});

test("exact pre-notice generated records remain readable while prose edits do not", async () => {
  const coordination = await mkdtemp(join(tmpdir(), "hari-legacy-generated-"));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const indexPath = join(coordination, "PROJECTS.md");
  const current = await readFile(indexPath, "utf8");
  const legacy = current.replace("> **Hari-managed record.** The JSON between `hari-meta` markers is authoritative. The Markdown view below is generated; do not edit either representation by hand. Use Hari update tools. Hari detects generated-view edits and refuses to overwrite them.\n\n", "");
  await writeFile(indexPath, legacy);
  assert.deepEqual(await readIndex(coordination), { version: 1, projects: [], priorities: [], decisions: [] });
  await writeFile(indexPath, `${legacy}unexpected prose\n`);
  await assert.rejects(readIndex(coordination), /manual or stale generated-view edits/);
});

test("Hari update surfaces replace and clear authoritative state without silently overwriting generated prose", async () => {
  const coordination = await mkdtemp(join(tmpdir(), "hari-coordination-update-"));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const project = await createProject(coordination, { name: "Updates" });
  const inbox = await captureInbox(coordination, "Clarify this", project.id);
  await replaceProjectItems(coordination, project.id, "blockers", ["Known blocker"]);
  assert.deepEqual((await replaceProjectItems(coordination, project.id, "blockers", [])).blockers, []);
  assert.deepEqual((await replaceIndexItems(coordination, "decisions", ["Cross-project order"])).decisions, ["Cross-project order"]);
  assert.equal(await updateInboxItem(coordination, inbox.id, { remove: true }), undefined);
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Original assignment",
    acceptanceCriteria: ["Original criterion"],
    constraints: [],
    checkout: "/tmp/updates",
    branch: "feature/updates",
  });
  assert.equal((await amendManager(coordination, project.id, "manager", { assignment: "Amended assignment", acceptanceCriteria: ["Amended criterion"] })).assignment, "Amended assignment");
  const projectPath = join(coordination, "projects", project.id, "PROJECT.md");
  await writeFile(projectPath, `${await readFile(projectPath, "utf8")}manual prose\n`);
  await assert.rejects(readProject(coordination, project.id), /manual or stale generated-view edits/);
});

test("a native session cannot be silently coopted by another manager", async () => {
  const coordination = await mkdtemp(join(tmpdir(), "hari-coordination-"));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const project = await createProject(coordination, { name: "One" });
  const second = await createProject(coordination, { name: "Two" });
  for (const [id, manager] of [[project.id, "one-manager"], [second.id, "two-manager"]]) {
    await addManager(coordination, id, {
      id: manager,
      assignment: "Own one outcome",
      acceptanceCriteria: ["Own outcome is reported"],
      constraints: [],
      checkout: "/tmp/checkout",
      branch: `feature/${manager}`,
    });
  }
  await bindManagerSession(coordination, project.id, "one-manager", "/tmp/shared.jsonl");
  await assert.rejects(
    bindManagerSession(coordination, second.id, "two-manager", "/tmp/shared.jsonl"),
    /already bound to one\/one-manager/,
  );
});
