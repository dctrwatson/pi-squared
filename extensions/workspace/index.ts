import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { registerArgumentCommand } from "../support/command-support.ts";
import { WorkspaceError } from "./process.ts";
import { WorkspaceService, parseCommandWords, parseNewWorkspace, parseWorkspaceTarget } from "./core.ts";
import { sessionHasAutomaticWorkspaceName, WORKSPACE_SESSION_NAME_TYPE, WORKSPACE_SESSION_TYPE } from "./sessions.ts";
import type { PruneResult, PullRequestDivergenceChoice, WorkspaceRecord, WorkspaceStatus } from "./types.ts";

export const WORKSPACE_PM_SKILL_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "skills",
    "workspace-pm",
    "SKILL.md",
);

export interface WorkspaceExtensionOptions {
    createService?: (cwd: string) => WorkspaceService;
    completionCwd?: () => string;
}

interface WorkspaceCompletionCandidates {
    branches: readonly string[];
    refs: readonly string[];
    pullRequests: readonly number[];
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function managedWorkspacePmPath(service: WorkspaceService, cwd: string): Promise<string | undefined> {
    const path = join(dirname(cwd), "pm");
    try {
        const result = await service.git.tryRun(["rev-parse", "--is-inside-work-tree"], path);
        return result.ok && result.stdout.trim() === "true" ? path : undefined;
    } catch {
        return undefined;
    }
}

function recency(timestamp: number | undefined): string {
    if (!timestamp) return "no session";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
    if (seconds < 60) return "now";
    if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
    return `${Math.round(seconds / 86_400)}d`;
}

function pullRequestNumber(record: Pick<WorkspaceRecord, "pr" | "prUrl">): number | undefined {
    if (record.pr) return record.pr.number;
    const match = record.prUrl?.match(/\/pull\/(\d+)$/i);
    return match?.[1] ? Number(match[1]) : undefined;
}

function workspaceLabel(status: WorkspaceStatus): string {
    const parts = [status.record.branch];
    const number = pullRequestNumber(status.record);
    if (number) parts.push(`#${number}`);
    parts.push(status.placement === "primary" ? "primary" : "worktree");
    parts.push(recency(status.recency));
    if (status.dirty) parts.push("dirty");
    if (status.stale) parts.push("stale");
    return parts.join(" • ");
}

function activeWorkspaceText(statuses: WorkspaceStatus[]): string {
    return statuses.map((status) => `${status.record.branch} (PID ${status.activeLease?.pid ?? "unknown"}, ${status.record.cwd})`).join("; ");
}

function pruneText(result: PruneResult): string {
    const pruned = result.pruned.length > 0 ? `Pruned: ${result.pruned.join(", ")}.` : "No workspace was pruned.";
    const skipped = result.skipped.map((entry) => `${entry.branch} (${entry.reason})`);
    return skipped.length > 0 ? `${pruned} Skipped: ${skipped.join("; ")}.` : pruned;
}

const WORKSPACE_HELP_TEXT = `Usage: /workspace or /ws [target] [--worktree]
       /workspace or /ws new
       /workspace or /ws new <branch> [--from <ref|current>] [--worktree]
       /workspace or /ws prune

No argument: Open the workspace picker.
target: Local branch, pull request number, or GitHub pull request URL.
branch:<name>: Force a local branch target.
new: Start a fresh session for the current branch, or create a branch workspace.
--from: Select the new branch base; current uses the current commit.
--worktree: Use a managed worktree.
prune: Remove inactive managed workspaces.
--help, -h: Show this help.`;
const WORKSPACE_TOP_LEVEL_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "new", label: "new", description: "Create a workspace" },
    { value: "prune", label: "prune", description: "Remove inactive managed workspaces" },
    { value: "--worktree", label: "--worktree", description: "Use a managed worktree" },
];
const WORKSPACE_NEW_OPTION_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "--from", label: "--from", description: "Select the base ref" },
    { value: "--worktree", label: "--worktree", description: "Use a managed worktree" },
];
const WORKSPACE_WORKTREE_COMPLETION: readonly AutocompleteItem[] = [
    { value: "--worktree", label: "--worktree", description: "Use a managed worktree" },
];

function completionValue(words: readonly string[], value: string): string {
    return [...words, value].join(" ");
}

function prefixedCompletions(
    words: readonly string[],
    prefix: string,
    candidates: readonly AutocompleteItem[],
): AutocompleteItem[] {
    return candidates
        .filter((candidate) => candidate.value.startsWith(prefix))
        .map((candidate) => ({ ...candidate, value: completionValue(words, candidate.value) }));
}

function requiresBranchTargetPrefix(branch: string): boolean {
    return branch === "new" || branch === "prune" || /^#?\d+$/.test(branch) || branch.startsWith("branch:");
}

function branchTargetValue(branch: string): string {
    return requiresBranchTargetPrefix(branch) ? `branch:${branch}` : branch;
}

function branchCompletionValue(branch: string, prefix: string): string {
    if (prefix.startsWith("branch:") && !requiresBranchTargetPrefix(branch)) return `branch:${branch}`;
    return branchTargetValue(branch);
}

function workspaceTargetCompletions(
    words: readonly string[],
    prefix: string,
    candidates: WorkspaceCompletionCandidates,
): AutocompleteItem[] {
    const branches = candidates.branches.flatMap((branch) => {
        const value = branchCompletionValue(branch, prefix);
        if (!branch.startsWith(prefix) && !value.startsWith(prefix)) return [];
        return [{
            value: completionValue(words, value),
            label: branch,
            description: "Local branch",
        }];
    });
    const pullRequests = candidates.pullRequests
        .filter((number) => {
            const value = String(number);
            return value.startsWith(prefix) || `#${value}`.startsWith(prefix);
        })
        .map((number) => ({
            value: completionValue(words, `#${number}`),
            label: `#${number}`,
            description: "Known pull request",
        }));
    return [...branches, ...pullRequests];
}

function isKnownWorkspaceTarget(value: string, candidates: WorkspaceCompletionCandidates): boolean {
    let target: ReturnType<typeof parseWorkspaceTarget>;
    try {
        target = parseWorkspaceTarget(value);
    } catch {
        return false;
    }
    if (!target) return false;
    if (target.type === "branch") {
        return candidates.branches.includes(target.branch)
            && (value.startsWith("branch:") || !requiresBranchTargetPrefix(target.branch));
    }
    return candidates.pullRequests.includes(target.number);
}

function completionTokens(argumentPrefix: string): { words: string[]; prefix: string } | undefined {
    try {
        const words = parseCommandWords(argumentPrefix);
        if (/\s$/.test(argumentPrefix)) return { words, prefix: "" };
        return { words: words.slice(0, -1), prefix: words.at(-1) ?? "" };
    } catch {
        return undefined;
    }
}

function newCompletionState(words: readonly string[]): {
    awaitingRef: boolean;
    hasFrom: boolean;
    hasWorktree: boolean;
} | undefined {
    let awaitingRef = false;
    let hasFrom = false;
    let hasWorktree = false;
    let hasBranch = false;
    for (const word of words) {
        if (awaitingRef) {
            awaitingRef = false;
            hasFrom = true;
            continue;
        }
        if (word === "--from") {
            if (hasFrom) return undefined;
            awaitingRef = true;
            continue;
        }
        if (word === "--worktree") {
            if (hasWorktree) return undefined;
            hasWorktree = true;
            continue;
        }
        if (word.startsWith("--") || hasBranch) return undefined;
        hasBranch = true;
    }
    return { awaitingRef, hasFrom, hasWorktree };
}

function newWorkspaceCompletions(
    words: readonly string[],
    prefix: string,
    candidates: WorkspaceCompletionCandidates,
): AutocompleteItem[] {
    const state = newCompletionState(words.slice(1));
    if (!state) return [];
    if (state.awaitingRef) {
        const refs: AutocompleteItem[] = [
            { value: "current", label: "current", description: "Current checkout" },
            ...candidates.refs
                .filter((ref) => ref !== "current")
                .map((ref) => ({ value: ref, label: ref, description: "Local Git ref" })),
        ];
        return prefixedCompletions(words, prefix, refs);
    }
    if (prefix && !prefix.startsWith("--")) return [];

    const options = WORKSPACE_NEW_OPTION_COMPLETIONS.filter((option) =>
        (option.value !== "--from" || !state.hasFrom)
        && (option.value !== "--worktree" || !state.hasWorktree));
    return prefixedCompletions(words, prefix, options);
}

function getWorkspaceArgumentCompletions(
    argumentPrefix: string,
    candidates: WorkspaceCompletionCandidates,
): AutocompleteItem[] | null {
    const tokens = completionTokens(argumentPrefix);
    if (!tokens) return null;
    const { words, prefix } = tokens;
    let completions: AutocompleteItem[];
    if (words.length === 0) {
        completions = [
            ...prefixedCompletions(words, prefix, WORKSPACE_TOP_LEVEL_COMPLETIONS),
            ...workspaceTargetCompletions(words, prefix, candidates),
        ];
    } else if (words[0] === "new") {
        completions = newWorkspaceCompletions(words, prefix, candidates);
    } else if (words.length === 1 && words[0] === "--worktree") {
        completions = workspaceTargetCompletions(words, prefix, candidates);
    } else if (words.length === 1 && isKnownWorkspaceTarget(words[0]!, candidates)) {
        completions = prefixedCompletions(words, prefix, WORKSPACE_WORKTREE_COMPLETION);
    } else {
        completions = [];
    }
    return completions.length > 0 ? completions : null;
}

async function discoverWorkspaceCompletionCandidates(service: WorkspaceService): Promise<WorkspaceCompletionCandidates> {
    const [state, branches, refs] = await Promise.all([
        service.state(),
        service.git.localBranches(),
        service.git.localRefs(),
    ]);
    const records = await state.listWorkspaces();
    const pullRequests = [...new Set(
        records
            .map(pullRequestNumber)
            .filter((number): number is number => number !== undefined && Number.isSafeInteger(number)),
    )].sort((left, right) => left - right);
    return { branches, refs, pullRequests };
}

function isTui(ctx: ExtensionCommandContext): boolean {
    if (ctx.mode === "tui") return true;
    if (ctx.hasUI) ctx.ui.notify("/ws requires TUI mode", "error");
    return false;
}

async function choosePullRequestDivergence(ctx: ExtensionCommandContext, branch: string, canFastForward: boolean): Promise<PullRequestDivergenceChoice> {
    const keep = "Keep local";
    const fastForward = "Fast-forward";
    const reset = "Reset to PR head";
    const cancel = "Cancel";
    const selected = await ctx.ui.select("Pull request changed", [keep, ...(canFastForward ? [fastForward] : []), reset, cancel]);
    if (selected === keep) return "keep-local";
    if (selected === fastForward) return "fast-forward";
    if (selected !== reset) return "cancel";
    const confirmed = await ctx.ui.confirm("Reset pull request branch", `Reset ${branch} to the PR head? A recovery ref will be created.`);
    return confirmed ? "reset" : "cancel";
}

function switchWorkspaceSession(ctx: ExtensionCommandContext, session: string): Promise<{ cancelled: boolean }> {
    return ctx.switchSession(session, {
        withSession: async (replacement) => {
            replacement.ui.notify("Workspace ready", "info");
        },
    });
}

async function switchWorkspace(service: WorkspaceService, ctx: ExtensionCommandContext, target: NonNullable<ReturnType<typeof parseWorkspaceTarget>>, parallel: boolean): Promise<void> {
    await service.activate(target, {
        parallel,
        resolvePullRequestDivergence: (divergence) => choosePullRequestDivergence(ctx, divergence.branch, divergence.canFastForward),
        switchSession: (session) => switchWorkspaceSession(ctx, session),
    });
}

async function replaceCurrentWorkspaceSession(service: WorkspaceService, ctx: ExtensionCommandContext): Promise<void> {
    await service.replaceCurrentSession({
        switchSession: (session) => switchWorkspaceSession(ctx, session),
    });
}

export function staleWorkspaceTarget(status: WorkspaceStatus): NonNullable<ReturnType<typeof parseWorkspaceTarget>> {
    const pr = status.record.pr;
    if (pr) {
        const target = parseWorkspaceTarget(pr.url);
        if (target?.type === "pr" && target.number === pr.number) return target;
    }
    return { type: "branch", branch: status.record.branch };
}

export async function picker(service: WorkspaceService, ctx: ExtensionCommandContext): Promise<void> {
    const statuses = await service.list();
    const active = statuses.filter((status) => status.active);
    const selectable: WorkspaceStatus[] = [];
    for (const status of statuses) {
        if (status.active) continue;
        if (status.stale || !await service.activationBlocker(status.record.branch, false)) selectable.push(status);
    }
    if (active.length > 0) ctx.ui.notify(`Active workspaces: ${activeWorkspaceText(active)}`, "info");
    const newAction = "New workspace…";
    const promoteAction = "Promote current workspace…";
    const labels = [...selectable.map(workspaceLabel), newAction, promoteAction];
    const selected = await ctx.ui.select("Workspaces", labels);
    if (!selected) return;
    if (selected === newAction) {
        const branch = await ctx.ui.input("New workspace branch", "feature/name");
        if (!branch?.trim()) return;
        const parallel = await ctx.ui.confirm("New workspace", "Use a managed worktree?");
        await service.create({ branch: branch.trim(), parallel }, {
            parallel,
            switchSession: (session) => ctx.switchSession(session),
        });
        return;
    }
    if (selected === promoteAction) {
        const branch = await service.git.branch(ctx.cwd);
        await switchWorkspace(service, ctx, { type: "branch", branch }, true);
        return;
    }
    const status = selectable.find((candidate) => workspaceLabel(candidate) === selected);
    if (!status) return;
    if (status.stale) {
        const number = pullRequestNumber(status.record);
        if (number) {
            ctx.ui.notify(`Workspace #${number} is stale. Run /ws #${number} to repair it.`, "info");
            return;
        }
        const repair = await ctx.ui.confirm("Repair workspace", `Create a new session for ${status.record.branch}?`);
        if (!repair) return;
        await service.repair(status.record.branch);
    }
    await switchWorkspace(service, ctx, { type: "branch", branch: status.record.branch }, false);
}

export async function handleWorkspace(args: string, ctx: ExtensionCommandContext, service = new WorkspaceService(ctx.cwd)): Promise<void> {
    if (!isTui(ctx)) return;
    try {
        const words = parseCommandWords(args);
        if (words.length === 0) {
            await picker(service, ctx);
            return;
        }
        if (words[0] === "prune") {
            if (words.length !== 1) throw new WorkspaceError("/ws prune accepts no arguments");
            const result = await service.prune();
            ctx.ui.notify(pruneText(result), "info");
            return;
        }
        if (words[0] === "new") {
            const withoutCommand = words.slice(1);
            if (withoutCommand.length === 0) {
                await replaceCurrentWorkspaceSession(service, ctx);
                return;
            }
            const options = parseNewWorkspace(withoutCommand);
            await service.create(options, {
                parallel: options.parallel,
                switchSession: (session) => ctx.switchSession(session, {
                    withSession: async (replacement) => {
                        replacement.ui.notify("Workspace ready", "info");
                    },
                }),
            });
            return;
        }
        let parallel = false;
        const targets: string[] = [];
        for (const word of words) {
            if (word === "--worktree") parallel = true;
            else if (word.startsWith("--")) throw new WorkspaceError(`Unknown workspace option: ${word}`);
            else targets.push(word);
        }
        if (targets.length > 1) throw new WorkspaceError("/ws accepts one workspace target");
        if (targets.length === 0) {
            if (!parallel) {
                await picker(service, ctx);
                return;
            }
            const branch = await service.git.branch(ctx.cwd);
            await switchWorkspace(service, ctx, { type: "branch", branch }, true);
            return;
        }
        const target = parseWorkspaceTarget(targets[0] ?? "");
        if (!target) throw new WorkspaceError("A workspace target is required");
        await switchWorkspace(service, ctx, target, parallel);
    } catch (error) {
        ctx.ui.notify(errorText(error), "error");
    }
}

export default function workspaceExtension(
    pi: ExtensionAPI,
    options: WorkspaceExtensionOptions = {},
): void {
    const createService = options.createService ?? ((cwd: string) => new WorkspaceService(cwd));
    let workspaceCwd: string | undefined;
    let completionCandidates: Promise<WorkspaceCompletionCandidates> | undefined;
    const loadCompletionCandidates = (): Promise<WorkspaceCompletionCandidates> => {
        if (!completionCandidates) {
            completionCandidates = Promise.resolve()
                .then(() => discoverWorkspaceCompletionCandidates(createService(options.completionCwd?.() ?? workspaceCwd ?? process.cwd())));
        }
        return completionCandidates;
    };
    const getArgumentCompletions = async (argumentPrefix: string): Promise<AutocompleteItem[] | null> =>
        getWorkspaceArgumentCompletions(argumentPrefix, await loadCompletionCandidates());
    const handleCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> =>
        handleWorkspace(args, ctx, createService(ctx.cwd));

    registerArgumentCommand(pi, "workspace", {
        description: "Open or switch a branch workspace",
        helpText: WORKSPACE_HELP_TEXT,
        getArgumentCompletions,
        handler: handleCommand,
    });
    registerArgumentCommand(pi, "ws", {
        description: "Open or switch a branch workspace",
        helpText: WORKSPACE_HELP_TEXT,
        getArgumentCompletions,
        handler: handleCommand,
    });

    let owned: { branch: string; session: string } | undefined;
    let pmPath: string | undefined;
    pi.on("resources_discover", () => pmPath ? { skillPaths: [WORKSPACE_PM_SKILL_PATH] } : { skillPaths: [] });
    pi.on("before_agent_start", (event) => pmPath ? {
        systemPrompt: `${event.systemPrompt}\n\nActive workspace PM: \`../pm\`. Load \`workspace-pm\` for durable project records.`,
    } : undefined);
    pi.on("session_start", async (_event, ctx) => {
        workspaceCwd = ctx.cwd;
        pmPath = undefined;
        const service = createService(ctx.cwd);
        try {
            const session = ctx.sessionManager.getSessionFile();
            if (!session) return;
            const state = await service.state();
            const lease = await state.readLease(session);
            if (!lease || lease.pid !== process.pid || lease.hostname !== hostname() || lease.session !== session) return;
            const metadata = await service.currentMetadata(session);
            const name = ctx.sessionManager.getSessionName();
            if (!name || sessionHasAutomaticWorkspaceName(ctx.sessionManager.getEntries(), name)) {
                pi.setSessionName(metadata.branch);
                pi.appendEntry(WORKSPACE_SESSION_NAME_TYPE, { branch: metadata.branch });
            }
            pi.appendEntry(WORKSPACE_SESSION_TYPE, metadata);
            const record = await service.registerCurrent(session, true);
            if (!record) return;
            owned = { branch: record.branch, session: record.session };
            if (await service.git.isManagedWorktree(record.cwd)) {
                pmPath = await managedWorkspacePmPath(service, record.cwd);
                if (!pmPath) ctx.ui.notify("Workspace PM repository is unavailable; PM guidance is disabled.", "warning");
            }
        } catch (error) {
            ctx.ui.notify(`Workspace unavailable: ${errorText(error)}`, "error");
            ctx.shutdown();
        }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        if (!owned) return;
        try {
            const state = await createService(ctx.cwd).state();
            await state.releaseLease(owned);
        } finally {
            owned = undefined;
            pmPath = undefined;
        }
    });
}
