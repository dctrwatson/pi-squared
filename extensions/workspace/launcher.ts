import { WorkspaceService, parseNewWorkspace, parseWorkspaceTarget } from "./core.ts";
import type { ActivationOptions } from "./core.ts";
import { WorkspaceError } from "./process.ts";
import type { NewWorkspaceOptions, WorkspaceLaunchCandidate, WorkspaceStatus } from "./types.ts";

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

type LaunchPlan = WorkspaceLaunchPlan | PrunePlan | ListPlan;

export type LaunchCandidate = Readonly<WorkspaceLaunchCandidate>;

export const WORKSPACE_LAUNCH_CAPABILITIES = { beforeActivate: true } as const;

/** Options for programmatic workspace launch resolution. */
export interface ResolveLaunchOptions {
    /** Validate an explicit prepared branch binding before activation can change workspace state. */
    beforeActivate?: (candidate: LaunchCandidate) => Promise<void>;
}

function usage(): string {
    return "Usage: piw [--profile <name>] [--expect-session <path>] [--worktree] [branch|PR] [-- pi arguments] | piw [--profile <name>] new <branch> [--from <ref>] [--worktree] [-- pi arguments] | piw prune | piw --list";
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

export function formatWorkspaceList(statuses: WorkspaceStatus[]): string {
    if (statuses.length === 0) return "No workspaces.\n";
    const rows = statuses.map((status) => {
        const pr = pullRequestNumber(status);
        return [
            status.record.branch,
            pr ? `#${pr}` : "-",
            status.placement === "primary" ? "primary" : "worktree",
            workspaceState(status),
            recency(status.recency),
            status.record.cwd,
        ];
    });
    const headings = ["BRANCH", "PR", "PLACEMENT", "STATE", "RECENT", "PATH"];
    const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)));
    return [headings, ...rows]
        .map((row) => row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
        .join("\n") + "\n";
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
    profile?: string;
    expectedSession?: string;
    prune?: true;
    list?: true;
    target?: string;
    create?: NewWorkspaceOptions;
    piArgs: string[];
}

export function parseLauncherArguments(args: string[]): LauncherArguments {
    let parallel = false;
    let profile: string | undefined;
    let expectedSession: string | undefined;
    let prune = false;
    let list = false;
    let target: string | undefined;
    let createWords: string[] | undefined;
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
        if (arg === "new") {
            if (prune) throw new WorkspaceError("piw prune accepts no arguments");
            if (list) throw new WorkspaceError("piw --list accepts no arguments");
            if (target || createWords) throw new WorkspaceError("piw accepts one workspace target");
            createWords = [];
            continue;
        }
        if (createWords) {
            createWords.push(arg ?? "");
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
        if (arg === "--help" || arg === "-h") throw new WorkspaceError(usage());
        if (arg?.startsWith("-")) throw new WorkspaceError(`Unknown piw option: ${arg}`);
        if (target) throw new WorkspaceError("piw accepts one workspace target");
        target = arg;
    }
    if (prune && (parallel || profile || expectedSession || list || target || createWords || piArgs.length > 0)) {
        throw new WorkspaceError("piw prune accepts no arguments");
    }
    if (list && (parallel || profile || expectedSession || target || createWords || piArgs.length > 0)) {
        throw new WorkspaceError("piw --list accepts no arguments");
    }
    if (createWords) {
        if (expectedSession) throw new WorkspaceError("--expect-session cannot be used with piw new");
        const create = parseNewWorkspace([...(parallel ? ["--worktree"] : []), ...createWords], "piw new");
        return { parallel: create.parallel, ...(profile ? { profile } : {}), create, piArgs };
    }
    if (expectedSession && !target) throw new WorkspaceError("--expect-session requires an explicit local branch target");
    return {
        parallel,
        ...(profile ? { profile } : {}),
        ...(expectedSession ? { expectedSession } : {}),
        ...(prune ? { prune: true as const } : {}),
        ...(list ? { list: true as const } : {}),
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
    validateForwardedPiArguments(parsed.piArgs, parsed.profile);
    if (options.beforeActivate && (parsed.list || parsed.prune || parsed.create)) {
        throw new WorkspaceError("beforeActivate requires an explicit existing local branch target");
    }
    const service = new WorkspaceService(cwd);
    if (parsed.list) {
        return { action: "list", output: formatWorkspaceList(await service.list()) };
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
