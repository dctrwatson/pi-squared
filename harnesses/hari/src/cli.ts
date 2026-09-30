import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  type LauncherConfig,
  CoordinationError,
  coordinationDirectory,
  bindManagerSession,
  findManager,
  listManagers,
  integrationResources,
  readLauncherConfig,
} from "./coordination.ts";
import { inspectHariManagerSession } from "./session-identity.ts";
import { initializeHari, validateResources } from "./setup.ts";
import { requireCoordinationRepository } from "./coordination-git.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(harnessRoot, "src", "index.ts");

type WorkspaceLaunchPlan = {
  action: "launch";
  cwd: string;
  session: string;
  args: string[];
};

type WorkspaceLaunchCandidate = {
  branch: string;
  cwd: string;
  session?: string;
};

type WorkspaceLauncher = {
  WORKSPACE_LAUNCH_CAPABILITIES?: { beforeActivate?: boolean };
  resolveLaunch(args: string[], cwd?: string, options?: { beforeActivate?: (candidate: WorkspaceLaunchCandidate) => Promise<void> }): Promise<WorkspaceLaunchPlan>;
};

export type LaunchMode = "start" | "resume";

function usage(): string {
  return `Usage:
  hari init [--pi-squared <local-checkout>] [--pi <command>]
  hari                         Open or continue a conversation with Hari

Hari is your coordination agent. His durable home is the Prime Radiant at
~/Projects/primeradiant. Talk with him about projects, priorities, decisions,
inbox items, local checkpoints, and managers.

Advanced resource setup: hari init --workspace-launcher <path>`;
}

function requiredOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CoordinationError(`${name} requires a value`);
  return value;
}

function assertKnownOptions(args: string[], allowed: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!allowed.includes(arg)) throw new CoordinationError(`Unknown option: ${arg}`);
    if (arg.startsWith("--")) index++;
  }
}

export function resourceArguments(config: LauncherConfig, role: "hari" | "manager" = "hari"): string[] {
  const resources = integrationResources(config);
  return [
    "--no-extensions",
    "-e", role === "manager" ? resources.workspaceExtension : join(harnessRoot, "src", "workspace-create.ts"),
    "-e", role === "manager" ? resources.subagentExtension : join(harnessRoot, "src", "session-observer.ts"),
    "-e", extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    // Empty manager overrides select Pi's coding base without ambient SYSTEM/APPEND files.
    ...(role === "manager"
      ? ["--system-prompt", "", "--append-system-prompt", ""]
      : ["--system-prompt", "The harness supplies Hari's role instructions and explicit resources."]),
  ];
}

function roleEnvironment(role: "hari" | "manager", projectId?: string, managerId?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HARI_ROLE: role };
  delete environment.HARI_PROJECT_ID;
  delete environment.HARI_MANAGER_ID;
  if (projectId) environment.HARI_PROJECT_ID = projectId;
  if (managerId) environment.HARI_MANAGER_ID = managerId;
  return environment;
}

function runPi(config: LauncherConfig, args: string[], cwd: string, environment: NodeJS.ProcessEnv): never {
  const result = spawnSync(config.piCommand ?? "pi", args, { cwd, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function launchHari(coordinationDir: string): Promise<never> {
  await requireCoordinationRepository(coordinationDir);
  const config = await readLauncherConfig(coordinationDir);
  await validateResources(config);
  const sessionDir = join(coordinationDir, ".hari", "sessions");
  return runPi(
    config,
    ["--session-dir", sessionDir, "--continue", ...resourceArguments(config)],
    coordinationDir,
    roleEnvironment("hari"),
  );
}

async function workspaceLauncher(config: LauncherConfig): Promise<WorkspaceLauncher> {
  if (!existsSync(config.workspaceLauncher)) {
    throw new CoordinationError(`Configured workspace launcher does not exist: ${config.workspaceLauncher}`);
  }
  const loaded = await import(pathToFileURL(config.workspaceLauncher).href) as Partial<WorkspaceLauncher>;
  if (loaded.WORKSPACE_LAUNCH_CAPABILITIES?.beforeActivate !== true) {
    throw new CoordinationError("Configured workspace launcher lacks WORKSPACE_LAUNCH_CAPABILITIES.beforeActivate; upgrade to the approved pi-squared launch-preflight revision before manager launch");
  }
  if (typeof loaded.resolveLaunch !== "function") throw new CoordinationError("Configured workspace launcher does not export resolveLaunch()");
  return loaded as WorkspaceLauncher;
}

async function samePreparedCheckout(left: string, right: string): Promise<boolean> {
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function isExactManagerIdentity(identity: { coordinationDir: string; projectId: string; managerId: string }, coordinationDir: string, projectId: string, managerId: string): boolean {
  return resolve(identity.coordinationDir) === coordinationDir && identity.projectId === projectId && identity.managerId === managerId;
}

async function verifyPreparedCandidate(
  candidate: WorkspaceLaunchCandidate,
  input: { coordinationDir: string; projectId: string; managerId: string; checkout: string; branch: string; session?: string; mode: LaunchMode },
): Promise<void> {
  if (candidate.branch !== input.branch) throw new CoordinationError(`Workspace preflight selected branch ${candidate.branch}, not the agreed manager branch ${input.branch}`);
  if (!await samePreparedCheckout(candidate.cwd, input.checkout)) throw new CoordinationError(`Workspace preflight selected ${candidate.cwd}, not the agreed prepared checkout ${input.checkout}`);
  const allManagers = await listManagers(input.coordinationDir);
  if (candidate.session) {
    const conflict = allManagers.find(({ project, manager }) => manager.session && resolve(manager.session) === resolve(candidate.session!) && !(project.id === input.projectId && manager.id === input.managerId));
    if (conflict) throw new CoordinationError(`Workspace candidate session is already bound to ${conflict.project.id}/${conflict.manager.id}; refusing before activation`);
  }
  if (input.mode === "resume") {
    if (!input.session || !candidate.session || resolve(candidate.session) !== resolve(input.session)) {
      throw new CoordinationError("Workspace preflight did not return the exact recorded manager session for explicit resume");
    }
    const inspected = await inspectHariManagerSession(candidate.session);
    if (inspected.uncertain) throw new CoordinationError(inspected.uncertain);
    if (!inspected.identity || !isExactManagerIdentity(inspected.identity, input.coordinationDir, input.projectId, input.managerId)) {
      throw new CoordinationError("Recorded manager session lacks an exact, verifiable Hari manager identity; refusing resume before workspace activation");
    }
    return;
  }
  if (!candidate.session) return;
  const inspected = await inspectHariManagerSession(candidate.session);
  if (inspected.uncertain) throw new CoordinationError(inspected.uncertain);
  if (inspected.identity) throw new CoordinationError(`Workspace candidate session is already identified as ${inspected.identity.projectId}/${inspected.identity.managerId}; start will not coopt it`);
  if (inspected.pristineWorkspace) return;
  throw new CoordinationError("Workspace candidate has an untagged native session that is not a pristine public Pi workspace placeholder; start will not coopt it");
}

export async function prepareManagerLaunch(
  coordinationDir: string,
  projectId: string,
  managerId: string,
  mode: LaunchMode,
): Promise<WorkspaceLaunchPlan> {
  coordinationDir = resolve(coordinationDir);
  const config = await readLauncherConfig(coordinationDir);
  const { project, manager } = await findManager(coordinationDir, projectId, managerId);
  if (manager.acceptanceCriteria.length === 0) throw new CoordinationError(`Manager ${manager.id} lacks acceptance criteria; amend assignment before launch`);
  if (mode === "start" && manager.session) {
    throw new CoordinationError(`Manager ${manager.id} already has a bound session; use explicit resume or surface a recovery need`);
  }
  if (mode === "resume") {
    if (!manager.session) throw new CoordinationError(`Manager ${manager.id} has no bound session; explicit resume cannot repair or create one`);
    if (!existsSync(manager.session)) throw new CoordinationError(`Manager ${manager.id} session is missing: ${manager.session}; do not silently replace it`);
  }
  if (!existsSync(manager.checkout)) throw new CoordinationError(`Prepared checkout is missing: ${manager.checkout}`);
  const args = [
    "--profile", "hari",
    ...(mode === "resume" ? ["--expect-session", manager.session!] : []),
    manager.branch,
    "--",
    ...resourceArguments(config, "manager"),
  ];
  const plan = await (await workspaceLauncher(config)).resolveLaunch(args, manager.checkout, {
    beforeActivate: (candidate) => verifyPreparedCandidate(candidate, {
      coordinationDir,
      projectId: project.id,
      managerId: manager.id,
      checkout: manager.checkout,
      branch: manager.branch,
      ...(manager.session ? { session: manager.session } : {}),
      mode,
    }),
  });
  if (!plan || plan.action !== "launch" || !plan.cwd || !plan.session) {
    throw new CoordinationError("Workspace launcher did not return a native launch plan");
  }
  if (!await samePreparedCheckout(plan.cwd, manager.checkout)) throw new CoordinationError(`Workspace launcher activated ${plan.cwd}, not the agreed prepared checkout ${manager.checkout}`);
  const identity = await inspectHariManagerSession(plan.session);
  if (identity.uncertain) throw new CoordinationError(identity.uncertain);
  if (mode === "start" && identity.identity) {
    throw new CoordinationError(`Native session is already identified as ${identity.identity.projectId}/${identity.identity.managerId}; explicit recovery is outside this first cut`);
  }
  if (mode === "resume" && (!identity.identity || !isExactManagerIdentity(identity.identity, coordinationDir, project.id, manager.id))) {
    throw new CoordinationError(`Expected session lacks exact Hari identity for ${project.id}/${manager.id}`);
  }
  await bindManagerSession(coordinationDir, project.id, manager.id, plan.session);
  return plan;
}

function fieldReaderScript(): string {
  return `const plan = JSON.parse(process.env.HARI_PLAN); for (const field of [plan.cwd, plan.session, ...plan.args]) process.stdout.write(field + "\\0");`;
}

function managerWrapperScript(): string {
  return `set -euo pipefail
plan="$(PIW_LEASE_PID="$$" "$HARI_NODE" --experimental-strip-types "$HARI_ROOT/src/cli.ts" internal manager-plan "$HARI_PROJECT_ID" "$HARI_MANAGER_ID" "$HARI_MANAGER_MODE")"
fields=()
while IFS= read -r -d '' field; do fields+=("$field"); done < <(HARI_PLAN="$plan" "$HARI_NODE" --input-type=module -e '${fieldReaderScript()}')
if ((\${#fields[@]} < 2)); then echo "hari: workspace launcher returned an invalid plan" >&2; exit 1; fi
cd -- "\${fields[0]}"
exec "$HARI_PI_COMMAND" --session "\${fields[1]}" "\${fields[@]:2}"`;
}

async function launchManager(coordinationDir: string, projectId: string, managerId: string, mode: LaunchMode): Promise<never> {
  await requireCoordinationRepository(coordinationDir);
  const config = await readLauncherConfig(coordinationDir);
  await validateResources(config);
  const result = spawnSync("bash", ["-c", managerWrapperScript()], {
    cwd: coordinationDir,
    env: {
      ...roleEnvironment("manager", projectId, managerId),
      HARI_MANAGER_MODE: mode,
      HARI_ROOT: harnessRoot,
      HARI_NODE: process.execPath,
      HARI_PI_COMMAND: config.piCommand ?? "pi",
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function internalManagerPlan(args: string[]): Promise<void> {
  if (args.length !== 3) throw new CoordinationError("Internal manager plan requires project, manager, and mode");
  const [projectId, managerId, mode] = args;
  if (mode !== "start" && mode !== "resume") throw new CoordinationError("Internal manager mode is invalid");
  const plan = await prepareManagerLaunch(coordinationDirectory(), projectId, managerId, mode);
  process.stdout.write(JSON.stringify(plan));
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const [command, ...rest] = args;
  if (command === undefined) {
    await launchHari(coordinationDirectory());
    return;
  }
  if (command === "internal") {
    if (rest[0] === "manager-plan") {
      await internalManagerPlan(rest.slice(1));
      return;
    }
    if (rest[0] !== "manager") throw new CoordinationError("Unknown internal command");
    const [, mode, projectId, managerId, ...options] = rest;
    if ((mode !== "start" && mode !== "resume") || !projectId || !managerId || options.length) {
      throw new CoordinationError("Internal manager entry requires start|resume, project, and manager only");
    }
    await launchManager(coordinationDirectory(), projectId, managerId, mode);
    return;
  }
  if (command === "init") {
    assertKnownOptions(rest, ["--pi-squared", "--workspace-launcher", "--pi"]);
    const result = await initializeHari({
      piSquared: requiredOption(rest, "--pi-squared"),
      workspaceLauncher: requiredOption(rest, "--workspace-launcher"),
      piCommand: requiredOption(rest, "--pi"),
    }, harnessRoot);
    process.stdout.write(`Hari's harness is configured.\nPrime Radiant: ${result.coordinationDir}\n${result.commit ? `Initial local checkpoint: ${result.commit}\n` : "Existing history and records preserved.\n"}Run hari to talk with him. No remote was configured or contacted.\n`);
    return;
  }
  throw new CoordinationError(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hari: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
