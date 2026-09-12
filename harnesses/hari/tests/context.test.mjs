import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addManager, createProject, initializeCoordination, readIndex, readProject, writeIndex, writeProject } from "../src/coordination.ts";
import { assembleContext, checkoutGuidance, managerSystemPrompt } from "../src/context.ts";

async function setupManager(t, { guidance = "# Checkout rule\n\n- Run the focused test." } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hari-checkout-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "AGENTS.md"), guidance);
  const coordination = await mkdtemp(join(tmpdir(), "hari-coordination-"));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const project = await createProject(coordination, { name: "Context project" });
  await addManager(coordination, project.id, {
    id: "context-manager",
    assignment: "Inspect actual checkout guidance",
    acceptanceCriteria: ["Use applicable guidance"],
    constraints: ["No publication"],
    checkout: root,
    branch: "feature/context",
  });
  t.after(() => Promise.all([root, coordination].map((path) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))));
  return { root, coordination, project };
}

test("Hari prompt is independent of coordination record contents, size, and availability", async (t) => {
  const coordination = await mkdtemp(join(tmpdir(), "hari-stable-context-"));
  t.after(() => rm(coordination, { recursive: true, force: true }));
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  });
  const config = { role: "hari", coordinationDir: coordination };
  const initial = await assembleContext(config);
  assert.equal(initial.blocked, undefined);

  await createProject(coordination, { name: "On-demand fixture", repository: "acme/on-demand" });
  const index = await readIndex(coordination);
  index.priorities = ["On-demand priority"];
  index.decisions = [`On-demand decision: ${"x".repeat(61_000)}`];
  await writeIndex(coordination, index);
  const changed = await assembleContext(config);
  assert.equal(changed.blocked, undefined);
  assert.deepEqual(changed, initial);
  assert.doesNotMatch(changed.prompt, /On-demand|acme\/on-demand|Current cross-project view/);
  assert.match(changed.prompt, /hari_projects/);
  assert.match(changed.prompt, /retrieve any needed facts that are missing, stale, or uncertain/);
  assert.match(changed.prompt, /Reuse still-applicable results rather than rereading or restating unchanged records on every turn/);

  await rm(join(coordination, "PROJECTS.md"));
  assert.deepEqual(await assembleContext(config), initial);
});

test("manager context contains only live checkout guidance with provenance", async (t) => {
  const { root, coordination, project } = await setupManager(t);
  const guidance = await checkoutGuidance(root);
  assert.equal(guidance.length, 1);
  assert.match(guidance[0].path, /AGENTS\.md$/);

  const assembly = await assembleContext({
    role: "manager",
    coordinationDir: coordination,
    projectId: project.id,
    managerId: "context-manager",
  });
  assert.equal(assembly.blocked, undefined);
  assert.match(assembly.prompt, /Inspect actual checkout guidance/);
  assert.match(assembly.prompt, /AGENTS\.md/);
  assert.match(assembly.prompt, /Run the focused test/);
  assert.doesNotMatch(assembly.prompt, /# Hari manager/);
  assert.doesNotMatch(assembly.prompt, /GitHub access is read-only/);
  assert.doesNotMatch(assembly.prompt, /hari\/AGENTS\.md/);
});

test("manager system text stays stable while live assignment and source state change", async (t) => {
  const { root, coordination, project } = await setupManager(t);
  const config = {
    role: "manager",
    coordinationDir: coordination,
    projectId: project.id,
    managerId: "context-manager",
  };
  const base = "Native coding base\nWorkspace guidance";
  const stable = managerSystemPrompt(base);
  const initial = await assembleContext(config);

  const record = await readProject(coordination, project.id);
  record.managers[0].assignment = "Changed manager assignment";
  await writeProject(coordination, record);
  await writeFile(join(root, "source-change.txt"), "changed source state\n");
  const changed = await assembleContext(config);

  assert.notEqual(changed.signature, initial.signature);
  assert.match(changed.prompt, /Changed manager assignment/);
  assert.equal(managerSystemPrompt(base), stable);
  assert.match(stable, /^Native coding base\nWorkspace guidance\n\n# Hari manager/);
  assert.equal([...stable.matchAll(/# Hari manager/g)].length, 1);
});

test("manager context includes compact cross-project index decisions with PROJECTS provenance", async (t) => {
  const { coordination, project } = await setupManager(t);
  const index = await readIndex(coordination);
  index.decisions.push("Do not merge project work before dependency review");
  await writeIndex(coordination, index);
  const assembly = await assembleContext({
    role: "manager",
    coordinationDir: coordination,
    projectId: project.id,
    managerId: "context-manager",
  });
  assert.match(assembly.prompt, /Cross-project decisions \(provenance: .*PROJECTS\.md\)/);
  assert.match(assembly.prompt, /Do not merge project work before dependency review/);
});

test("runtime learning guidance uses existing records and normal manager reports within authority", async (t) => {
  const { coordination, project } = await setupManager(t);
  const hari = await assembleContext({ role: "hari", coordinationDir: coordination });
  assert.equal(hari.blocked, undefined);
  assert.match(hari.prompt, /You are Hari, the user's coordination agent/);
  assert.match(hari.prompt, /Use judgment to identify priorities, connect related work/);
  assert.match(hari.prompt, /carry out authorized coordination without waiting for command-by-command instructions/);
  assert.match(hari.prompt, /The Prime Radiant at ~\/Projects\/primeradiant is your durable home/);
  assert.match(hari.prompt, /Do not publish, push, merge, deploy, close issues, or automatically wake\/resume managers/);
  assert.match(hari.prompt, /The user controls manager continuation/);
  assert.match(hari.prompt, /Improve how you work from actual use, not hypothetical needs/);
  assert.match(hari.prompt, /your own interactions and manager reports/);
  assert.match(hari.prompt, /existing inbox\/project records in the Prime Radiant/);
  assert.match(hari.prompt, /Your memory and company-specific glossary, skills, conventions, and knowledge belong there/);
  assert.match(hari.prompt, /Keep reusable harness code, skills, and maintainer guidance in the harness implementation repository/);
  assert.match(hari.prompt, /do not copy private memory into those shared resources/);
  assert.match(hari.prompt, /existing workspace\/manager workflow/);
  assert.match(hari.prompt, /retain what helps, and revise or remove what does not/);
  assert.match(hari.prompt, /Do not turn every correction into a permanent rule, add a learning subsystem, or silently change active agreements/);
  assert.match(hari.prompt, /Proceed within agreed authority; ask when an improvement would cross it/);

  const manager = managerSystemPrompt("Native coding base");
  assert.match(manager, /You are a manager working with Hari/);
  assert.match(manager, /meaningful friction working with Hari or his harness, or a reusable successful practice/);
  assert.match(manager, /normal manager_report, distinguishing observed facts from hypotheses/);
  assert.match(manager, /not a mandatory retrospective or authority to change the harness outside your assignment/);
  assert.match(manager, /Keep company-specific glossary, skills, and lessons in the Prime Radiant at ~\/Projects\/primeradiant, not in reusable harness code or skills/);
  assert.doesNotMatch(manager, /Keep concise observations and evidence references in existing inbox\/project records/);
});

test("oversized native manager base prompt blocks rather than truncating it", () => {
  assert.throws(
    () => managerSystemPrompt("x".repeat(60_001)),
    /Required Hari context is .*limit 60000/,
  );
});

test("oversized required checkout guidance blocks rather than truncating it", async (t) => {
  const { coordination, project } = await setupManager(t, { guidance: "x".repeat(61_000) });
  const assembly = await assembleContext({
    role: "manager",
    coordinationDir: coordination,
    projectId: project.id,
    managerId: "context-manager",
  });
  assert.match(assembly.blocked ?? "", /Required Hari context is/);
  assert.match(assembly.prompt, /Do not take actions/);
});
