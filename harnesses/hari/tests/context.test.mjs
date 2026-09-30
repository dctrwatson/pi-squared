import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addManager, createProject, initializeCoordination, readInbox, readIndex, readProject, writeIndex, writeProject } from "../src/coordination.ts";
import { initializeCoordinationRepository } from "../src/coordination-git.ts";
import { assembleContext, checkoutGuidance, managerSystemPrompt, refreshManagerBoundary } from "../src/context.ts";
import hariExtension from "../src/index.ts";

async function setupManager(t, { guidance = "# Checkout rule\n\n- Run the focused test." } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hari-checkout-"));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, "AGENTS.md"), guidance);
  const home = await mkdtemp(join(tmpdir(), "hari-coordination-"));
  const coordination = join(home, "Projects", "primeradiant");
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
  t.after(() => Promise.all([root, home].map((path) => rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))));
  return { root, home, coordination, project };
}

function roleHarness(role, fixture, managerId) {
  Object.assign(process.env, { HOME: fixture.home, HARI_ROLE: role });
  if (role === "manager") {
    Object.assign(process.env, { HARI_PROJECT_ID: fixture.project.id, HARI_MANAGER_ID: managerId });
  } else {
    delete process.env.HARI_PROJECT_ID;
    delete process.env.HARI_MANAGER_ID;
  }
  const handlers = new Map();
  const tools = new Map();
  const calls = [];
  const pi = {
    handlers, tools, calls,
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    exec: async (command, args) => { calls.push({ command, args }); throw new Error("No runtime launch is permitted in this fixture"); },
  };
  hariExtension(pi);
  return pi;
}

async function learningHandoff(t) {
  const fixture = await setupManager(t);
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  await initializeCoordinationRepository(fixture.coordination);
  const hari = roleHarness("hari", fixture);
  const promptBeforeNotes = await assembleContext({ role: "hari", coordinationDir: fixture.coordination });
  const guidance = "Trial advice: When another manager must reproduce a blocked local check, include the exact failing command. This does not expand test or publication authority.";
  const noteText = [
    `Candidate: ${guidance}`,
    "Evidence: synthetic context-manager session, entries command-1 and handoff-2.",
    "Applies when: another manager must reproduce a blocked local check.",
    "Expected benefit: fewer requests for a missing reproduction command.",
    "Review: the next applicable handoff. Disposition: not yet reviewed.",
  ].join("\n");
  const capture = await hari.tools.get("hari_capture_inbox").execute("capture", { project: fixture.project.id, text: noteText });
  const note = capture.details.item;
  const page = await hari.tools.get("hari_record_page").execute("notes", { kind: "inbox", offset: 0 });
  assert.ok(page.content[0].text.includes(noteText));
  const checkpoint = await hari.tools.get("hari_git").execute("checkpoint", { action: "commit", message: "retain a synthetic learning candidate" });
  assert.equal(checkpoint.details.changed, true);
  assert.ok(execFileSync("git", ["-C", fixture.coordination, "show", "HEAD:INBOX.md"], { encoding: "utf8" }).includes(noteText));
  // Select usable text from the saved note. This does not test model judgment.
  const saved = (await readInbox(fixture.coordination)).items.find((item) => item.id === note.id);
  const selectedGuidance = saved.text.split("\n")[0].slice("Candidate: ".length);
  const assignment = `Prepare a blocked-check handoff.\n\n### Applicable learned guidance\n${selectedGuidance}\nSource: INBOX.md#${saved.id}; synthetic context-manager entries command-1 and handoff-2.`;
  const create = await hari.tools.get("hari_manager_create").execute("assign", {
    project: fixture.project.id,
    manager: "fresh-manager",
    assignment,
    acceptanceCriteria: ["Report the blocked check and its evidence"],
    constraints: ["No publication"],
    checkout: fixture.root,
    branch: "feature/handoff",
  });
  return { ...fixture, hari, promptBeforeNotes, note, noteText, guidance, assignment, manager: create.details.manager };
}

function deliveredContext(response) {
  return { messages: [{ role: "toolResult", toolName: "manager_context", isError: false, details: response.details, content: response.content }] };
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
  assert.match(changed.prompt, /conversation does not override current records/);
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

test("short learning instructions preserve user direction and existing record ownership", async (t) => {
  const { coordination } = await setupManager(t);
  const hari = await assembleContext({ role: "hari", coordinationDir: coordination });
  assert.equal(hari.blocked, undefined);
  assert.match(hari.prompt, /You are never autonomous/);
  assert.match(hari.prompt, /within the current user-directed request/);
  assert.match(hari.prompt, /Do not publish, push, merge, deploy, close issues, or automatically wake\/resume managers/);
  assert.match(hari.prompt, /The user controls manager continuation/);
  assert.match(hari.prompt, /Only for the current authorized learning request, use subagent with hari-session-observer/);
  assert.match(hari.prompt, /Check result status and evidence limits/);
  assert.match(hari.prompt, /Hypotheses are not facts/);
  assert.match(hari.prompt, /project-linked inbox notes with hari_capture_inbox\/hari_update_inbox, not authoritative decisions/);
  assert.match(hari.prompt, /Before related assignments, read the project and relevant inbox notes/);
  assert.match(hari.prompt, /Correct your own preparation first/);
  assert.match(hari.prompt, /Applicable learned guidance in assignment text for manager_context/);
  assert.match(hari.prompt, /usable guidance, scope, limits, and source; a link alone is insufficient/);
  assert.match(hari.prompt, /Note edits do not amend assignments; use hari_manager_amend only with authority/);
  assert.match(hari.prompt, /Do not add a memory store or automatic lesson loader/);
  assert.match(hari.prompt, /do not copy private records there/);
  assert.match(hari.prompt, /existing workspace\/manager workflow/);

  const manager = managerSystemPrompt("Native coding base");
  assert.match(manager, /normal manager_report, distinguishing observed facts from hypotheses/);
  assert.match(manager, /not a mandatory retrospective or authority to change the harness outside your assignment/);
  assert.match(manager, /Keep company-specific glossary, skills, and lessons in the Prime Radiant at ~\/Projects\/primeradiant, not in reusable harness code or skills/);
  assert.doesNotMatch(manager, /hari-session-observer|hari_capture_inbox|Applicable learned guidance/);
});

test("adaptation instructions distinguish tested, unused, harmful, and unknown outcomes", async (t) => {
  const { coordination } = await setupManager(t);
  const { prompt } = await assembleContext({ role: "hari", coordinationDir: coordination });
  const checks = [
    /record applicability, source, expected benefit, and next review opportunity/,
    /delivery, applicability, use, and outcome against the expected benefit/,
    /Missing delivery is a handoff problem/,
    /Without an applicable situation, the trial is untested/,
    /Unused guidance or unknown evidence is not success/,
    /Check adverse effects and alternative causes; smooth work does not prove causation/,
    /Record retain, revise, remove, or inconclusive with reason and source/,
    /The observer recommends; you decide within authority/,
    /Remove superseded advice from future assignments/,
    /Do not rewrite past assignments to imply success or silently change active agreements/,
    /User preferences and decisions are not experiments; follow them within scope/,
  ];
  for (const check of checks) assert.match(prompt, check);
});

test("a selected inbox candidate reaches a fresh manager only through its assignment and manager_context", async (t) => {
  const f = await learningHandoff(t);
  const notes = await readInbox(f.coordination);
  assert.equal(notes.version, 1);
  assert.deepEqual(Object.keys(notes.items[0]).sort(), ["createdAt", "id", "project", "text"]);
  assert.equal(notes.items[0].project, f.project.id);
  assert.equal(notes.items[0].text, f.noteText);
  assert.deepEqual((await readProject(f.coordination, f.project.id)).decisions, []);
  assert.deepEqual((await readIndex(f.coordination)).decisions, []);
  assert.equal(f.manager.assignment, f.assignment);
  assert.equal(f.manager.session, undefined, "recording guidance does not start a manager");

  const fresh = roleHarness("manager", f, f.manager.id);
  const stable = await fresh.handlers.get("before_agent_start")({ systemPrompt: "Native coding base" });
  assert.ok(!stable.systemPrompt.includes(f.guidance));
  assert.ok(!stable.systemPrompt.includes(f.note.id));
  const received = await fresh.tools.get("manager_context").execute("first-view", {});
  assert.equal(received.details.blocked, undefined);
  assert.ok(received.content[0].text.includes(f.assignment));
  fresh.handlers.get("context")(deliveredContext(received));
  assert.equal(await fresh.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }), undefined);

  const unrelated = roleHarness("manager", f, "context-manager");
  const other = await unrelated.tools.get("manager_context").execute("unrelated-view", {});
  assert.equal(other.details.blocked, undefined);
  assert.ok(!other.content[0].text.includes(f.guidance));
  assert.ok(!other.content[0].text.includes(f.note.id));
  const hari = await assembleContext({ role: "hari", coordinationDir: f.coordination });
  assert.deepEqual(hari, f.promptBeforeNotes);
  assert.ok(!hari.prompt.includes(f.guidance));
  assert.ok(!hari.prompt.includes(f.note.id));
  assert.deepEqual(f.hari.calls, []);
  assert.deepEqual(fresh.calls, []);
});

test("inbox revision leaves delivered guidance unchanged; an authorized amendment invalidates the old view", async (t) => {
  const f = await learningHandoff(t);
  const fresh = roleHarness("manager", f, f.manager.id);
  const before = await fresh.tools.get("manager_context").execute("before-review", {});
  const oldView = deliveredContext(before);
  fresh.handlers.get("context")(oldView);
  const config = { role: "manager", coordinationDir: f.coordination, projectId: f.project.id, managerId: f.manager.id };
  const boundaryBefore = await refreshManagerBoundary(config);
  const guidanceBefore = await readFile(join(f.root, "AGENTS.md"), "utf8");

  await f.hari.tools.get("hari_update_inbox").execute("review", {
    id: f.note.id, action: "replace", text: "Disposition: inconclusive. Use is unknown in the synthetic session. Review at the next applicable handoff. Source: context-manager entry handoff-2.",
  });
  assert.equal((await readProject(f.coordination, f.project.id)).managers.find((entry) => entry.id === f.manager.id).assignment, f.assignment);
  assert.deepEqual(await refreshManagerBoundary(config), boundaryBefore);
  assert.equal(await fresh.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }), undefined);
  assert.deepEqual(await fresh.tools.get("manager_context").execute("after-note-edit", {}), before);
  fresh.handlers.get("context")(oldView);

  const revisedAssignment = `${f.assignment}\nTrial limit: Include the command only in a blocked-check handoff.`;
  await f.hari.tools.get("hari_manager_amend").execute("authorized-amendment", { project: f.project.id, manager: f.manager.id, assignment: revisedAssignment });
  const boundaryAfter = await refreshManagerBoundary(config);
  assert.notEqual(boundaryAfter.coordinationSignature, boundaryBefore.coordinationSignature);
  assert.notEqual(boundaryAfter.signature, boundaryBefore.signature);
  assert.equal(boundaryAfter.sourceSignature, boundaryBefore.sourceSignature);
  const blocked = await fresh.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /Retrieve the full manager_context/);
  const after = await fresh.tools.get("manager_context").execute("amended-view", {});
  assert.notEqual(after.details.signature, before.details.signature);
  assert.ok(after.content[0].text.includes(revisedAssignment));
  fresh.handlers.get("context")(oldView);
  assert.equal((await fresh.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } })).block, true);
  fresh.handlers.get("context")(deliveredContext(after));
  assert.equal(await fresh.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }), undefined);
  const record = (await readProject(f.coordination, f.project.id)).managers.find((entry) => entry.id === f.manager.id);
  assert.deepEqual(record.acceptanceCriteria, f.manager.acceptanceCriteria);
  assert.deepEqual(record.constraints, f.manager.constraints);
  assert.equal(record.session, undefined);
  assert.equal(await readFile(join(f.root, "AGENTS.md"), "utf8"), guidanceBefore);
  assert.deepEqual(f.hari.calls, []);
  assert.deepEqual(fresh.calls, []);
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
