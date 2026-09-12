import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { resourceArguments, prepareManagerLaunch } from "../src/cli.ts";
import { addManager, createProject, initializeCoordination, readProject } from "../src/coordination.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(harnessRoot, "..", "..");
const hariEntry = join(harnessRoot, "src", "index.ts");
const workspaceCreateEntry = join(harnessRoot, "src", "workspace-create.ts");
const bundledWorkspaceLauncher = join(repoRoot, "extensions", "workspace", "launcher.ts");

function identity(coordination, project, manager) {
  return JSON.stringify({
    type: "custom",
    customType: "hari-manager-identity",
    data: { coordinationDir: resolve(coordination), projectId: project, managerId: manager },
  }) + "\n";
}

test("Hari resource profiles are explicit and the manager suppresses ambient prompt overrides", () => {
  const config = {
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  };
  const args = resourceArguments(config);
  assert.deepEqual(args.slice(0, 7), [
    "--no-extensions",
    "-e",
    "-e",
    workspaceCreateEntry,
    "-e",
    hariEntry,
  ]);
  for (const flag of ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.ok(args.includes("--system-prompt"));

  const manager = resourceArguments(config, "manager");
  assert.equal(manager[manager.indexOf("--system-prompt") + 1], "");
  assert.equal(manager[manager.indexOf("--append-system-prompt") + 1], "");
});

test("manager resource arguments suppress ambient Pi system, append, and context files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hari-manager-resource-loader-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(cwd, "AGENTS.md"), "PROJECT AGENTS MUST NOT SURVIVE\n"),
    writeFile(join(agentDir, "AGENTS.md"), "GLOBAL AGENTS MUST NOT SURVIVE\n"),
    writeFile(join(agentDir, "SYSTEM.md"), "AMBIENT SYSTEM MUST NOT SURVIVE\n"),
    writeFile(join(agentDir, "APPEND_SYSTEM.md"), "AMBIENT APPEND MUST NOT SURVIVE\n"),
  ]);
  const managerArgs = resourceArguments({
    version: 1,
    workspaceLauncher: "/resources/workspace/launcher.ts",
  }, "manager");
  const systemPrompt = managerArgs[managerArgs.indexOf("--system-prompt") + 1];
  const appendSystemPrompt = managerArgs[managerArgs.indexOf("--append-system-prompt") + 1];
  const noContextFiles = managerArgs.includes("--no-context-files");
  assert.equal(systemPrompt, "");
  assert.equal(appendSystemPrompt, "");
  assert.equal(noContextFiles, true);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: managerArgs.includes("--no-extensions"),
    noSkills: managerArgs.includes("--no-skills"),
    noPromptTemplates: managerArgs.includes("--no-prompt-templates"),
    noThemes: managerArgs.includes("--no-themes"),
    noContextFiles,
    systemPrompt,
    appendSystemPrompt: [appendSystemPrompt],
  });
  await resourceLoader.reload();
  assert.equal(resourceLoader.getSystemPrompt(), undefined);
  assert.equal(resourceLoader.getSystemPromptSource(), undefined);
  assert.deepEqual(resourceLoader.getAppendSystemPrompt(), []);
  assert.deepEqual(resourceLoader.getAppendSystemPromptSources(), []);
  assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
});

test("manager planning uses pre-activation candidate validation and binds only the exact native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-manager-launch-"));
  const coordination = join(root, "coordination");
  const checkout = join(root, "checkout");
  const launcher = join(root, "workspace-launcher.mjs");
  const session = join(root, "manager.jsonl");
  const log = join(root, "launch.json");
  await mkdir(checkout);
  await writeFile(launcher, `
    import { writeFile } from "node:fs/promises";
    export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true };
    export async function resolveLaunch(args, cwd, options) {
      const candidate = { branch: args[args.indexOf("hari") + 1], cwd };
      await options.beforeActivate(candidate);
      await writeFile(process.env.HARI_TEST_SESSION, "{}\\n");
      await writeFile(process.env.HARI_TEST_LAUNCH_LOG, JSON.stringify({ args, candidate }));
      return { action: "launch", cwd, session: process.env.HARI_TEST_SESSION, args: args.slice(args.indexOf("--") + 1) };
    }
  `);
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: launcher,
  });
  const project = await createProject(coordination, { name: "Manager launch" });
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Own the launch test",
    acceptanceCriteria: ["Native session is exact"],
    constraints: [],
    checkout,
    branch: "feature/manager-launch",
  });
  const oldLog = process.env.HARI_TEST_LAUNCH_LOG;
  const oldSession = process.env.HARI_TEST_SESSION;
  process.env.HARI_TEST_LAUNCH_LOG = log;
  process.env.HARI_TEST_SESSION = session;
  try {
    const plan = await prepareManagerLaunch(coordination, project.id, "manager", "start");
    assert.equal(plan.session, session);
    const start = JSON.parse(await readFile(log, "utf8"));
    assert.deepEqual(start.args.slice(0, 3), ["--profile", "hari", "feature/manager-launch"]);
    assert.equal(start.args[3], "--");
    assert.equal((await readProject(coordination, project.id)).managers[0].session, session);

    await writeFile(session, identity(coordination, project.id, "manager"));
    await writeFile(launcher, `
      import { writeFile } from "node:fs/promises";
      export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true };
      export async function resolveLaunch(args, cwd, options) {
        const session = args[args.indexOf("--expect-session") + 1];
        const candidate = { branch: args[args.indexOf("--") - 1], cwd, session };
        await options.beforeActivate(candidate);
        await writeFile(process.env.HARI_TEST_LAUNCH_LOG, JSON.stringify({ args, candidate }));
        return { action: "launch", cwd, session, args: args.slice(args.indexOf("--") + 1) };
      }
    `);
    // Dynamic module imports are cached by URL. Use a fresh configured module path for resume.
    const resumeLauncher = join(root, "workspace-launcher-resume.mjs");
    await writeFile(resumeLauncher, await readFile(launcher, "utf8"));
    const config = JSON.parse(await readFile(join(coordination, ".hari", "launcher.json"), "utf8"));
    config.workspaceLauncher = resumeLauncher;
    await writeFile(join(coordination, ".hari", "launcher.json"), `${JSON.stringify(config, null, 2)}\n`);
    await prepareManagerLaunch(coordination, project.id, "manager", "resume");
    const resume = JSON.parse(await readFile(log, "utf8"));
    assert.deepEqual(resume.args.slice(0, 5), ["--profile", "hari", "--expect-session", session, "feature/manager-launch"]);
  } finally {
    if (oldLog === undefined) delete process.env.HARI_TEST_LAUNCH_LOG; else process.env.HARI_TEST_LAUNCH_LOG = oldLog;
    if (oldSession === undefined) delete process.env.HARI_TEST_SESSION; else process.env.HARI_TEST_SESSION = oldSession;
  }
});

test("older workspace launcher without the public preflight capability cannot activate", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-capability-reject-"));
  const coordination = join(root, "coordination");
  const checkout = join(root, "checkout");
  const marker = join(root, "activated");
  const launcher = join(root, "old-workspace-launcher.mjs");
  await mkdir(checkout);
  await writeFile(launcher, `
    import { writeFile } from "node:fs/promises";
    export async function resolveLaunch() {
      await writeFile(${JSON.stringify(marker)}, "activated");
      return { action: "launch", cwd: ${JSON.stringify(checkout)}, session: ${JSON.stringify(join(root, "session.jsonl"))}, args: [] };
    }
  `);
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: launcher,
  });
  const project = await createProject(coordination, { name: "Capability reject" });
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Reject a launcher that cannot preflight",
    acceptanceCriteria: ["Old launcher cannot activate"],
    constraints: [],
    checkout,
    branch: "feature/expected",
  });
  await assert.rejects(prepareManagerLaunch(coordination, project.id, "manager", "start"), /WORKSPACE_LAUNCH_CAPABILITIES\.beforeActivate/);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("manager preflight rejects a changed checkout before a launcher can activate it", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-preflight-reject-"));
  const coordination = join(root, "coordination");
  const checkout = join(root, "checkout");
  const marker = join(root, "activated");
  const launcher = join(root, "workspace-launcher.mjs");
  await mkdir(checkout);
  await writeFile(launcher, `
    import { writeFile } from "node:fs/promises";
    export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true };
    export async function resolveLaunch(_args, cwd, options) {
      await options.beforeActivate({ branch: "wrong-branch", cwd });
      await writeFile(${JSON.stringify(marker)}, "activated");
      return { action: "launch", cwd, session: ${JSON.stringify(join(root, "session.jsonl"))}, args: [] };
    }
  `);
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: launcher,
  });
  const project = await createProject(coordination, { name: "Preflight reject" });
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Reject an unexpected launch target",
    acceptanceCriteria: ["Unexpected launch does not activate"],
    constraints: [],
    checkout,
    branch: "feature/expected",
  });
  await assert.rejects(prepareManagerLaunch(coordination, project.id, "manager", "start"), /agreed manager branch/);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("bundled workspace seam runs Hari preflight in an isolated home and repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-workspace-seam-"));
  const home = join(root, "home");
  const coordination = join(root, "coordination");
  const checkout = join(root, "checkout");
  await mkdir(home);
  await mkdir(checkout);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "hari-test@example.invalid"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Hari seam test"], { cwd: checkout });
  await writeFile(join(checkout, "README.md"), "isolated workspace seam test\n");
  execFileSync("git", ["add", "README.md"], { cwd: checkout });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
  execFileSync("git", ["checkout", "-qb", "feature/hari-manager"], { cwd: checkout });
  await initializeCoordination(coordination, {
    version: 1,
    workspaceLauncher: bundledWorkspaceLauncher,
  });
  const project = await createProject(coordination, { name: "Workspace seam" });
  await addManager(coordination, project.id, {
    id: "manager",
    assignment: "Verify exact workspace activation preflight",
    acceptanceCriteria: ["Preflight returns a native session for the prepared branch"],
    constraints: [],
    checkout,
    branch: "feature/hari-manager",
  });
  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    const plan = await prepareManagerLaunch(coordination, project.id, "manager", "start");
    assert.equal(await realpath(plan.cwd), await realpath(checkout));
    assert.ok(plan.session.startsWith(home), `expected isolated session home, got ${plan.session}`);
    assert.equal((await readProject(coordination, project.id)).managers[0].session, plan.session);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  }
});

test("bundled fresh public Pi workspace placeholder can become the requested manager session", async () => {
  const root = await mkdtemp(join(tmpdir(), "hari-workspace-placeholder-"));
  const home = join(root, "home");
  const coordination = join(root, "coordination");
  const checkout = join(root, "checkout");
  await mkdir(home);
  await mkdir(checkout);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "hari-test@example.invalid"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Hari placeholder test"], { cwd: checkout });
  await writeFile(join(checkout, "README.md"), "fresh public workspace placeholder\n");
  execFileSync("git", ["add", "README.md"], { cwd: checkout });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  try {
    const workspace = await import(pathToFileURL(bundledWorkspaceLauncher).href);
    const placeholder = await workspace.resolveLaunch(["--profile", "hari", "new", "feature/prepared", "--from", "main"], checkout);
    assert.equal(placeholder.action, "launch");
    await initializeCoordination(coordination, {
      version: 1,
      workspaceLauncher: bundledWorkspaceLauncher,
    });
    const project = await createProject(coordination, { name: "Workspace placeholder" });
    await addManager(coordination, project.id, {
      id: "manager",
      assignment: "Adopt only a fresh public workspace placeholder",
      acceptanceCriteria: ["The exact prepared session is used"],
      constraints: [],
      checkout: placeholder.cwd,
      branch: "feature/prepared",
    });
    const plan = await prepareManagerLaunch(coordination, project.id, "manager", "start");
    assert.equal(plan.session, placeholder.session);
    assert.equal((await readProject(coordination, project.id)).managers[0].session, placeholder.session);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = priorXdg;
  }
});

test("CLI help names Hari and the Prime Radiant without requiring configuration", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", join(harnessRoot, "src", "cli.ts"), "--help"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(output, /hari init/);
  assert.match(output, /Open or continue a conversation with Hari/);
  assert.match(output, /Hari is your coordination agent/);
  assert.match(output, /His durable home is the Prime Radiant/);
  assert.match(output, /Talk with him about projects/);
  assert.match(output, /~\/Projects\/primeradiant/);
  assert.doesNotMatch(output, /--coordination|hari resume|hari manager/);
});
