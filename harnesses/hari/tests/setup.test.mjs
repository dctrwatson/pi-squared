import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addManager, captureInbox, createProject, initializeCoordination, readInbox } from "../src/coordination.ts";
import { roleConfigFromEnvironment } from "../src/context.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(harnessRoot, "..", "..");
const rootHariBin = join(repositoryRoot, "bin", "hari");
const bundledLauncher = join(repositoryRoot, "extensions", "workspace", "launcher.ts");
const hariEntry = join(harnessRoot, "src", "index.ts");
const workspaceCreateEntry = join(harnessRoot, "src", "workspace-create.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hari-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const other = join(root, "other");
  const dependency = join(root, "pi-squared");
  const launcher = join(dependency, "extensions", "workspace", "launcher.ts");
  const bin = join(dependency, "bin");
  const runtimeBin = join(root, "runtime-bin");
  const fakePi = join(bin, "pi");
  const log = join(root, "launch.json");
  const settings = join(home, ".config", "hari", "config.json");
  const coordination = join(home, "Projects", "primeradiant");
  for (const directory of [home, other, memory, join(dependency, "extensions", "workspace"), join(dependency, "extensions", "subagents"), bin, runtimeBin]) await mkdir(directory, { recursive: true });
  await writeFile(join(dirname(launcher), "index.ts"), "export default function () {}\n");
  await writeFile(join(dependency, "extensions", "subagents", "index.ts"), "export default function () {}\n");
  await writeFile(join(memory, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
  await writeFile(join(memory, "index.ts"), "export default function () {}\n");
  await writeFile(launcher, "export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true }; export async function resolveLaunch() { throw new Error('must not activate during init'); }\n");
  await writeFile(fakePi, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HARI_TEST_LAUNCH_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), role: process.env.HARI_ROLE, coordinationOverride: process.env.HARI_COORDINATION_DIR, project: process.env.HARI_PROJECT_ID, manager: process.env.HARI_MANAGER_ID }));
`);
  await chmod(fakePi, 0o755);
  await symlink(process.execPath, join(runtimeBin, "node"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: [runtimeBin, "/usr/bin", "/bin"].join(delimiter), HARI_TEST_LAUNCH_LOG: log };
  for (const name of ["HARI_COORDINATION_DIR", "HARI_PROJECT_ID", "HARI_MANAGER_ID", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  assert.notEqual(spawnSync("bash", ["-c", "command -v piw"], { env, encoding: "utf8" }).status, 0, "the fixture PATH must not contain piw");
  const run = (...args) => spawnSync(rootHariBin, args, { cwd: other, env, encoding: "utf8", timeout: 30_000 });
  const runFrom = (command, cwd, ...args) => spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  const git = (...args) => execFileSync("git", ["-C", coordination, ...args], { env, encoding: "utf8" }).trim();
  return { root, home, other, dependency, memory, launcher, bin, fakePi, log, settings, coordination, env, run, runFrom, git };
}

function succeeded(result) { assert.equal(result.status, 0, result.stderr || String(result.error)); }
function failed(result, message) { assert.notEqual(result.status, 0); assert.match(result.stderr, message); }

// CLI fixtures get an isolated HOME, not a production coordination-directory override.
test("root hari initializes bundled resources and runs from arbitrary and symlinked paths without piw", async t => {
  const f = await fixture(t);
  const setup = f.run("init", "--pi", f.fakePi);
  succeeded(setup);
  assert.match(setup.stdout, /Hari's harness is configured/);
  assert.match(setup.stdout, /Prime Radiant: .*Projects\/primeradiant/);
  assert.match(setup.stdout, /Run hari to talk with him/);
  assert.match(setup.stdout, /Initial local checkpoint/);
  assert.equal(f.git("remote", "-v"), "");
  assert.equal(f.git("rev-list", "--count", "HEAD"), "1");
  assert.deepEqual(f.git("ls-files").split("\n"), [".gitignore", "INBOX.md", "PROJECTS.md"]);
  await assert.rejects(lstat(f.settings), /ENOENT/);
  const configPath = join(f.coordination, ".hari", "launcher.json");
  assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
  const local = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(local.workspaceLauncher, await realpath(bundledLauncher));
  assert.notEqual(local.workspaceLauncher, await realpath(f.launcher));
  // Launching Hari from a manager shell must not carry that manager's assignment.
  f.env.HARI_PROJECT_ID = "old-project";
  f.env.HARI_MANAGER_ID = "old-manager";
  succeeded(f.run());
  const launched = JSON.parse(await readFile(f.log, "utf8"));
  assert.equal(launched.cwd, await realpath(f.coordination));
  assert.equal(launched.role, "hari");
  assert.equal(launched.coordinationOverride, undefined);
  assert.equal(launched.project, undefined);
  assert.equal(launched.manager, undefined);
  assert.ok(launched.args.includes("--continue"));
  assert.equal(launched.args[launched.args.indexOf("--session-dir") + 1], join(f.coordination, ".hari", "sessions"));
  const nested = join(f.other, "nested", "cwd");
  const linkedHari = join(f.root, "hari-link");
  await mkdir(nested, { recursive: true });
  await symlink(rootHariBin, linkedHari);
  succeeded(f.runFrom(linkedHari, nested));
  assert.equal(JSON.parse(await readFile(f.log, "utf8")).cwd, await realpath(f.coordination));
});

test("repeated init preserves records, history and native conversations without checkpointing pending work", async t => {
  const f = await fixture(t);
  succeeded(f.run("init", "--pi-squared", f.dependency, "--pi", f.fakePi));
  const head = f.git("rev-parse", "HEAD");
  await captureInbox(f.coordination, "Still pending");
  const before = await readFile(join(f.coordination, "INBOX.md"), "utf8");
  const session = join(f.coordination, ".hari", "sessions", "previous.jsonl");
  await mkdir(dirname(session), { recursive: true });
  await writeFile(session, "native conversation retained\n");
  succeeded(f.run("init"));
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(f.coordination, "INBOX.md"), "utf8"), before);
  assert.equal(await readFile(session, "utf8"), "native conversation retained\n");
  assert.match(f.git("status", "--short"), /INBOX.md/);
});

test("removed public selectors and session/manager commands fail without launching Pi or creating another store", async t => {
  const f = await fixture(t);
  succeeded(f.run("init"));
  const second = join(f.root, "second-coordination");
  for (const args of [
    ["--coordination", second], ["init", "--coordination", second], ["resume"], ["launch"],
    ["manager", "start", "project", "manager"],
    ["internal", "manager", "start", "project", "manager", "--coordination", second],
    ["internal", "manager-plan", second, "project", "manager", "start"],
  ]) failed(f.run(...args), /Unknown option|Usage:|Internal manager/);
  await assert.rejects(lstat(second), /ENOENT/);
  await assert.rejects(lstat(f.log), /ENOENT/);
  assert.equal(f.git("rev-list", "--count", "HEAD"), "1");
});

test("environment selection cannot redirect initialization, launch or role assembly", async t => {
  const f = await fixture(t);
  f.env.HARI_COORDINATION_DIR = join(f.root, "unrelated-repo");
  succeeded(f.run("init", "--pi", f.fakePi));
  succeeded(f.run());
  assert.equal(JSON.parse(await readFile(f.log, "utf8")).cwd, await realpath(f.coordination));
  assert.equal(roleConfigFromEnvironment({ ...f.env, HARI_ROLE: "hari" }).coordinationDir, f.coordination);
  assert.equal(roleConfigFromEnvironment({ ...f.env, HARI_ROLE: "manager", HARI_PROJECT_ID: "project", HARI_MANAGER_ID: "manager" }).coordinationDir, f.coordination);
  await assert.rejects(lstat(f.env.HARI_COORDINATION_DIR), /ENOENT/);
});

test("file-only coordination already at the global location is adopted without replacing records", async t => {
  const f = await fixture(t);
  await captureInbox(f.coordination, "Retained from first cut");
  succeeded(f.run("init"));
  assert.equal((await readInbox(f.coordination)).items[0].text, "Retained from first cut");
  assert.match(f.git("show", "HEAD:INBOX.md"), /Retained from first cut/);
});

test("missing setup and incompatible resources fail without creating coordination data", async t => {
  const f = await fixture(t);
  failed(f.run(), /run hari init/i);
  await writeFile(f.launcher, "export async function resolveLaunch() { throw new Error('must not run'); }\n");
  failed(f.run("init", "--pi-squared", f.dependency), /beforeActivate/);
  await assert.rejects(lstat(f.coordination), /ENOENT/);
  await assert.rejects(lstat(f.settings), /ENOENT/);
});

test("missing workspace or subagent entries fail before setup writes", async t => {
  for (const extension of ["workspace", "subagents"]) {
    const f = await fixture(t);
    await rm(join(f.dependency, "extensions", extension, "index.ts"));
    failed(f.run("init", "--pi-squared", f.dependency), /Missing pi-squared extension/);
    await assert.rejects(lstat(f.coordination), /ENOENT/);
    await assert.rejects(lstat(f.log), /ENOENT/);
  }
});

test("missing extension after setup blocks launch without changing coordination records", async t => {
  const f = await fixture(t);
  succeeded(f.run("init", "--pi-squared", f.dependency, "--pi", f.fakePi));
  const head = f.git("rev-parse", "HEAD");
  await rm(join(f.dependency, "extensions", "subagents", "index.ts"));
  failed(f.run(), /Missing pi-squared extension/);
  await assert.rejects(lstat(f.log), /ENOENT/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("status", "--short"), "");
});

test("setup does not read old settings or inspect other coordination locations", async t => {
  const f = await fixture(t);
  const old = join(f.home, "hari-coordination");
  // Unreadable path shapes would fail if setup still tried to inspect old records/settings.
  await symlink("hari-coordination", old);
  await mkdir(dirname(f.settings), { recursive: true });
  await writeFile(f.settings, "not JSON and not consulted\n");
  succeeded(f.run("init", "--pi", f.fakePi));
  succeeded(f.run());
  assert.equal(await readFile(f.settings, "utf8"), "not JSON and not consulted\n");
  assert.equal((await lstat(old)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(f.log, "utf8")).cwd, await realpath(f.coordination));
});

test("internal manager start/resume uses the global store without directory arguments", async t => {
  const f = await fixture(t);
  succeeded(f.run("init", "--pi-squared", f.dependency, "--pi", f.fakePi));
  const checkout = join(f.root, "checkout");
  const session = join(f.root, "manager.jsonl");
  await mkdir(checkout);
  await writeFile(f.launcher, `
    import { writeFile } from "node:fs/promises";
    export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true };
    export async function resolveLaunch(args, cwd, options) {
      const resuming = args.includes("--expect-session");
      const session = ${JSON.stringify(session)};
      const candidate = { branch: args[args.indexOf("--") - 1], cwd, ...(resuming ? { session } : {}) };
      await options.beforeActivate(candidate);
      if (!resuming) await writeFile(session, "{}\\n");
      return { action: "launch", cwd, session, args: args.slice(args.indexOf("--") + 1) };
    }
  `);
  const project = await createProject(f.coordination, { name: "Global manager" });
  await addManager(f.coordination, project.id, { id: "manager", assignment: "Use global coordination", acceptanceCriteria: ["Exact native session"], constraints: [], checkout, branch: "feature/managed" });
  succeeded(f.run("internal", "manager", "start", project.id, "manager"));
  let launched = JSON.parse(await readFile(f.log, "utf8"));
  assert.equal(launched.cwd, await realpath(checkout));
  assert.equal(launched.role, "manager");
  assert.equal(launched.project, project.id);
  assert.equal(launched.manager, "manager");
  assert.equal(launched.coordinationOverride, undefined);
  assert.deepEqual(launched.args.slice(0, 2), ["--session", session]);
  const config = roleConfigFromEnvironment({ HOME: f.home, HARI_ROLE: "manager", HARI_PROJECT_ID: project.id, HARI_MANAGER_ID: "manager" });
  assert.equal(config.coordinationDir, f.coordination);
  const identity = { type: "custom", customType: "hari-manager-identity", data: { coordinationDir: f.coordination, projectId: project.id, managerId: "manager" } };
  await writeFile(session, JSON.stringify(identity) + "\n");
  succeeded(f.run("internal", "manager", "resume", project.id, "manager"));
  launched = JSON.parse(await readFile(f.log, "utf8"));
  assert.deepEqual(launched.args.slice(0, 2), ["--session", session]);
  // The existing exact-session identity safeguard remains in place.
  identity.data.coordinationDir = join(f.home, "hari-coordination");
  const oldIdentity = JSON.stringify(identity) + "\n";
  await writeFile(session, oldIdentity);
  await rm(f.log);
  failed(f.run("internal", "manager", "resume", project.id, "manager"), /exact, verifiable Hari manager identity/);
  assert.equal(await readFile(session, "utf8"), oldIdentity);
  await assert.rejects(lstat(f.log), /ENOENT/);
});

test("explicit resource overrides remain saved instead of falling back to bundled defaults", async t => {
  const f = await fixture(t);
  succeeded(f.run(
    "init",
    "--workspace-launcher", f.launcher,
    "--pi", f.fakePi,
  ));
  const configPath = join(f.coordination, ".hari", "launcher.json");
  const configured = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(configured.workspaceLauncher, await realpath(f.launcher));
  succeeded(f.run("init"));
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), configured);
});

test("a missing explicitly selected dependency gives a correction path before setup writes", async t => {
  const f = await fixture(t);
  failed(f.run("init", "--pi-squared", join(f.root, "missing")), /hari init --pi-squared/);
  await assert.rejects(lstat(f.coordination), /ENOENT/);
  await assert.rejects(lstat(f.settings), /ENOENT/);
});
