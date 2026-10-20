import { access } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { WorkspaceService, parseNewWorkspace, parseWorkspaceDescribe, parseWorkspaceTarget } from "./core.ts";
import { workspaceLabelText } from "./labels.ts";
import { readWorkspaceRepositories } from "./registry.ts";
import type { ActivationOptions } from "./core.ts";
import { WorkspaceError } from "./process.ts";
import type { NewWorkspaceOptions, WorkspaceDescribeOptions, WorkspaceLaunchCandidate, WorkspaceStatus } from "./types.ts";

interface WorkspaceLaunchPlan {
    action: "launch";
    cwd: string;
    session: string;
    args: string[];
}

interface PrunePlan {
    action: "prune";
    pruned: string[];
    skipped: Array<{ branch: string; reason: string }>;
}

interface ListPlan {
    action: "list";
    output: string;
}

interface DescribePlan {
    action: "describe";
    output: string;
}

interface HelpPlan {
    action: "help";
    output: string;
}

type LaunchPlan = WorkspaceLaunchPlan | PrunePlan | ListPlan | DescribePlan | HelpPlan;

export type LaunchCandidate = Readonly<WorkspaceLaunchCandidate>;

export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true } as const;

/** Options for programmatic workspace launch resolution. */
export interface ResolveLaunchOptions {
    /** Validate an explicit prepared branch binding before activation can change workspace state. */
    beforeActivate?: (candidate: LaunchCandidate) => Promise<void>;
}

function usage(): string {
    return `Usage:
  piw [--list] [--global | --local]
  piw <target> [launch options] [-- <Pi arguments>]
  piw --current [launch options] [-- <Pi arguments>]
  piw new <branch> [new options] [launch options] [-- <Pi arguments>]
  piw describe [branch] <label options>
  piw prune
  piw --help  (also: piw -h)

List workspaces (does not start Pi):
  piw, --list          Inside a Git worktree: list this repository's workspaces.
                      Outside a Git worktree: list all known workspaces.
  --global            List all known workspaces from any directory.
  --local             List this repository only; requires a Git worktree.

Start Pi:
  <target>            Open a local branch or GitHub pull request workspace.
                      Use a branch, PR number (123 or '#123'), or GitHub PR URL.
                      Use branch:<name> to force a local branch target.
  --current           Use the branch in this checkout.
  new <branch>        Create a branch in a managed worktree and start Pi.

Launch options:
  --worktree          Use a managed Git worktree, not the primary checkout.
  --expect-session <path>
                      Require this saved session; explicit local branches only.
                      Not valid with new or --current.
  --profile <name>    Allow --no-extensions after --. The name is a label only;
                      it does not load configuration or add Pi arguments.
  -- <Pi arguments>   Forward arguments to Pi. Session options are not allowed;
                      piw selects the workspace session.

New options (managed worktree by default):
  --no-worktree       Create the branch in the primary checkout instead.
  --from <ref>        Select the base ref (default: local main).
                      Use --from current for the current commit.
  --name <text>, --description <text>  Set optional workspace labels.

Update labels (does not start Pi):
  describe [branch]   Update an existing workspace; default: current branch.
  --name <text>, --description <text>  Set one or both labels.
                      Use an empty quoted value ("") to clear a label.

Remove workspaces:
  prune               Remove inactive managed workspaces when their work is
                      integrated or their remote branch no longer exists.

Examples:
  piw
  piw --current
  piw feature/auth
  piw '#123'
  piw new feature/auth --from current
  piw new feature/serial --no-worktree
  piw describe feature/auth --name "Auth review"
  piw --current -- --model anthropic/claude-sonnet-4-5
`;
}

function recency(timestamp: number | undefined): string {
    if (!timestamp) return "no session";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
    if (seconds < 60) return "now";
    if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
    return `${Math.round(seconds / 86_400)}d`;
}

function pullRequestNumber(status: WorkspaceStatus): number | undefined {
    if (status.record.pr) return status.record.pr.number;
    const match = status.record.prUrl?.match(/\/pull\/(\d+)$/i);
    return match?.[1] ? Number(match[1]) : undefined;
}

function workspaceState(status: WorkspaceStatus): string {
    const state = [status.active ? `active (PID ${status.activeLease?.pid ?? "unknown"})` : "inactive"];
    if (status.dirty) state.push("dirty");
    if (status.stale) state.push("stale");
    return state.join(", ");
}

export function formatWorkspaceList(statuses: WorkspaceStatus[], includeRepository = false): string {
    if (statuses.length === 0) return "No workspaces.\n";
    const includeNames = statuses.some((status) => workspaceLabelText(status.record.name));
    const includeDescriptions = statuses.some((status) => workspaceLabelText(status.record.description));
    const rows = statuses.map((status) => {
        const pr = pullRequestNumber(status);
        const repository = status.record.repository;
        return [
            ...(includeRepository ? [basename(repository) === ".git" ? dirname(repository) : repository] : []),
            status.record.branch,
            ...(includeNames ? [workspaceLabelText(status.record.name) ?? "-"] : []),
            pr ? `#${pr}` : "-",
            status.placement === "primary" ? "primary" : "worktree",
            workspaceState(status),
            recency(status.recency),
            status.record.cwd,
            ...(includeDescriptions ? [workspaceLabelText(status.record.description) ?? "-"] : []),
        ];
    });
    const headings = [
        ...(includeRepository ? ["REPOSITORY"] : []), "BRANCH", ...(includeNames ? ["NAME"] : []),
        "PR", "PLACEMENT", "STATE", "RECENT", "PATH", ...(includeDescriptions ? ["DESCRIPTION"] : []),
    ];
    const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)));
    return [headings, ...rows]
        .map((row) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
        .join("\n") + "\n";
}

async function listWorkspaces(service: WorkspaceService, scope?: "global" | "local"): Promise<ListPlan> {
    const worktree = await service.git.tryRun(["rev-parse", "--is-inside-work-tree"]);
    const local = worktree.ok && worktree.stdout.trim() === "true";
    if (scope === "local" && !local) throw new WorkspaceError("--local requires a Git worktree");
    if (scope !== "global" && local) return { action: "list", output: formatWorkspaceList(await service.list()) };

    const statuses: WorkspaceStatus[] = [];
    const skipped: string[] = [];
    let localCommonDir: string | undefined;
    if (local) {
        try {
            localCommonDir = (await service.git.paths()).commonDir;
            statuses.push(...await service.list());
        } catch (error) {
            skipped.push(`Skipped ${service.git.cwd}: ${error instanceof Error ? error.message : String(error)}.\n`);
        }
    }
    for (const entry of await readWorkspaceRepositories()) {
        try {
            if (entry.commonDir === localCommonDir) continue;
            await access(entry.primaryCwd);
            const repository = new WorkspaceService(entry.primaryCwd);
            if ((await repository.git.paths()).commonDir !== entry.commonDir) {
                throw new WorkspaceError("Repository path changed");
            }
            statuses.push(...await repository.list());
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            skipped.push(`Skipped ${entry.primaryCwd}: ${error instanceof Error ? error.message : String(error)}.\n`);
        }
    }
    statuses.sort((left, right) => (right.recency ?? 0) - (left.recency ?? 0)
        || left.record.repository.localeCompare(right.record.repository) || left.record.branch.localeCompare(right.record.branch));
    return { action: "list", output: formatWorkspaceList(statuses, true) + skipped.join("") };
}

const PROTECTED_SESSION_OPTIONS = new Set([
    "--session",
    "--session-id",
    "--fork",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--no-session",
]);

const EXTENSION_DISCOVERY_OPTIONS = new Set(["--no-extensions", "-ne"]);

export function validateForwardedPiArguments(args: string[], profile?: string): void {
    for (const argument of args) {
        const option = argument.split("=", 1)[0] ?? argument;
        if (PROTECTED_SESSION_OPTIONS.has(option) || (!profile && EXTENSION_DISCOVERY_OPTIONS.has(option))) {
            throw new WorkspaceError(`piw manages ${option}; remove it from forwarded Pi arguments`);
        }
    }
}

export interface LauncherArguments {
    parallel: boolean;
    help?: true;
    profile?: string;
    expectedSession?: string;
    prune?: true;
    list?: true;
    listScope?: "global" | "local";
    current?: true;
    target?: string;
    create?: NewWorkspaceOptions;
    describe?: WorkspaceDescribeOptions;
    piArgs: string[];
}

export function parseLauncherArguments(args: string[]): LauncherArguments {
    let parallel = false;
    let profile: string | undefined;
    let expectedSession: string | undefined;
    let prune = false;
    let list = false;
    let listScope: "global" | "local" | undefined;
    let current = false;
    let target: string | undefined;
    let createWords: string[] | undefined;
    let describeWords: string[] | undefined;
    let piArgs: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--") {
            piArgs = args.slice(index + 1);
            break;
        }
        if (arg === "--profile") {
            const name = args[++index];
            if (!name || name === "--") throw new WorkspaceError("--profile requires a name");
            if (profile) throw new WorkspaceError("piw accepts one profile");
            profile = name;
            continue;
        }
        if (arg === "--expect-session") {
            const session = args[++index];
            if (!session || session === "--") throw new WorkspaceError("--expect-session requires a path");
            if (expectedSession) throw new WorkspaceError("piw accepts one expected session");
            expectedSession = session;
            continue;
        }
        if (createWords || describeWords) {
            (createWords ?? describeWords)?.push(arg ?? "");
            continue;
        }
        if (arg === "new" || arg === "describe") {
            if (prune) throw new WorkspaceError("piw prune accepts no arguments");
            if (list) throw new WorkspaceError("piw --list accepts no arguments");
            if (target) throw new WorkspaceError("piw accepts one workspace target");
            if (arg === "new") createWords = [];
            else describeWords = [];
            continue;
        }
        if (arg === "--worktree") {
            parallel = true;
            continue;
        }
        if (arg === "prune") {
            if (prune) throw new WorkspaceError("piw prune accepts no arguments");
            prune = true;
            continue;
        }
        if (arg === "--list") {
            list = true;
            continue;
        }
        if (arg === "--global" || arg === "--local") {
            const scope = arg === "--global" ? "global" : "local";
            if (listScope && listScope !== scope) throw new WorkspaceError("--global and --local cannot be used together");
            listScope = scope;
            list = true;
            continue;
        }
        if (arg === "--current") {
            current = true;
            continue;
        }
        if (arg === "--help" || arg === "-h") return { parallel: false, help: true, piArgs: [] };
        if (arg?.startsWith("-")) throw new WorkspaceError(`Unknown piw option: ${arg}`);
        if (target) throw new WorkspaceError("piw accepts one workspace target");
        target = arg;
    }
    if (prune && (parallel || profile || expectedSession || list || current || target || createWords || describeWords || piArgs.length > 0)) {
        throw new WorkspaceError("piw prune accepts no arguments");
    }
    if (current && (target || createWords || describeWords)) throw new WorkspaceError("--current cannot be used with another workspace target");
    if (expectedSession && !target && !createWords && !describeWords) throw new WorkspaceError("--expect-session requires an explicit local branch target");
    if (!prune && !target && !createWords && !describeWords && !current) list = true;
    if (list && (parallel || profile || expectedSession || current || target || createWords || describeWords || piArgs.length > 0)) {
        throw new WorkspaceError("piw --list accepts only --global or --local; use a branch, PR, or --current to start Pi");
    }
    if (createWords) {
        if (expectedSession) throw new WorkspaceError("--expect-session cannot be used with piw new");
        const create = parseNewWorkspace([...(parallel ? ["--worktree"] : []), ...createWords], "piw new");
        return { parallel: create.parallel, ...(profile ? { profile } : {}), create, piArgs };
    }
    if (describeWords) {
        if (parallel || profile || expectedSession || piArgs.length > 0) {
            throw new WorkspaceError("piw describe accepts only a local branch and --name or --description");
        }
        return { parallel: false, describe: parseWorkspaceDescribe(describeWords, "piw describe"), piArgs: [] };
    }
    return {
        parallel,
        ...(profile ? { profile } : {}),
        ...(expectedSession ? { expectedSession } : {}),
        ...(prune ? { prune: true as const } : {}),
        ...(list ? { list: true as const } : {}),
        ...(listScope ? { listScope } : {}),
        ...(current ? { current: true as const } : {}),
        ...(target ? { target } : {}),
        piArgs,
    };
}

/**
 * Resolve a Pi workspace launch. beforeActivate is limited to an explicit local
 * branch that is already checked out at cwd. It receives the exact binding,
 * waits for validation, and then permits activation.
 */
export async function resolveLaunch(
    args: string[],
    cwd = process.cwd(),
    options: ResolveLaunchOptions = {},
): Promise<LaunchPlan> {
    const parsed = parseLauncherArguments(args);
    if (parsed.help) return { action: "help", output: usage() };
    validateForwardedPiArguments(parsed.piArgs, parsed.profile);
    if (options.beforeActivate && (parsed.list || parsed.prune || parsed.create || parsed.describe)) {
        throw new WorkspaceError("beforeActivate requires an explicit existing local branch target");
    }
    const service = new WorkspaceService(cwd);
    if (parsed.list) {
        return listWorkspaces(service, parsed.listScope);
    }
    if (parsed.describe) {
        const record = await service.describe(parsed.describe);
        return { action: "describe", output: `Updated workspace ${record.branch}.\n` };
    }
    if (parsed.prune) {
        const result = await service.prune();
        return { action: "prune", ...result };
    }
    const requestedLeasePid = Number(process.env.PIW_LEASE_PID);
    const leasePid = Number.isSafeInteger(requestedLeasePid) && requestedLeasePid > 0 ? requestedLeasePid : undefined;
    const activationOptions: ActivationOptions = {
        parallel: parsed.parallel,
        switchSession: async () => ({ cancelled: false }),
        ...(leasePid ? { leasePid } : {}),
        ...(parsed.expectedSession ? { expectedSession: parsed.expectedSession } : {}),
    };
    if (parsed.create) {
        const activation = await service.create(parsed.create, activationOptions);
        return { action: "launch", cwd: activation.record.cwd, session: activation.record.session, args: parsed.piArgs };
    }
    const target = parsed.target
        ? parseWorkspaceTarget(parsed.target)
        : { type: "branch" as const, branch: await service.git.branch(cwd) };
    if (!target) throw new WorkspaceError("A workspace target is required");
    if (parsed.expectedSession && target.type !== "branch") {
        throw new WorkspaceError("--expect-session requires an explicit local branch target");
    }
    if (options.beforeActivate) {
        if (!parsed.target || target.type !== "branch") {
            throw new WorkspaceError("beforeActivate requires an explicit existing local branch target");
        }
        const candidate = await service.preparedLaunchCandidate(target.branch, cwd);
        await options.beforeActivate({ ...candidate });
        activationOptions.preparedCandidate = candidate;
    }
    const activation = await service.activate(target, activationOptions);
    return { action: "launch", cwd: activation.record.cwd, session: activation.record.session, args: parsed.piArgs };
}

async function main(): Promise<void> {
    try {
        const plan = await resolveLaunch(process.argv.slice(2));
        process.stdout.write(JSON.stringify(plan));
    } catch (error) {
        process.stderr.write(`piw: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    void main();
}
