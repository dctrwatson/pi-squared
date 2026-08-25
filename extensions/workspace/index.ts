import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerArgumentCommand } from "../support/command-support.ts";
import { WorkspaceError } from "./process.ts";
import { WorkspaceService, parseCommandWords, parseNewWorkspace, parseWorkspaceMerge, parseWorkspaceTarget } from "./core.ts";
import { sessionHasAutomaticWorkspaceName, WORKSPACE_SESSION_NAME_TYPE, WORKSPACE_SESSION_TYPE } from "./sessions.ts";
import type { PruneResult, PullRequestDivergenceChoice, WorkspaceMergeCleanup, WorkspaceMergePlan, WorkspaceRecord, WorkspaceStatus } from "./types.ts";

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
       /workspace or /ws merge <base-branch> [--squash]
       /workspace or /ws prune

No argument: Open the workspace picker.
target: Local branch, pull request number, or GitHub pull request URL.
branch:<name>: Force a local branch target.
new: Start a fresh session for the current branch, or create a branch workspace.
--from: Select the new branch base; current uses the current commit.
--worktree: Use a managed worktree.
merge: Prepare, merge, and remove the current managed workspace.
--squash: Create one commit on the base branch.
prune: Remove inactive managed workspaces.
--help, -h: Show this help.`;
const WORKSPACE_TOP_LEVEL_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "new", label: "new", description: "Create a workspace" },
    { value: "merge", label: "merge", description: "Merge and remove this workspace" },
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
const WORKSPACE_MERGE_OPTION_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "--squash", label: "--squash", description: "Create one commit on the base" },
];
export const WORKSPACE_MERGE_FINALIZE_TOOL = "workspace_merge_finalize";

function workspaceMergePrompt(plan: WorkspaceMergePlan): string {
    const mergePreparation = plan.mode === "ff"
        ? `Rebase ${plan.source} onto ${plan.base} if necessary so ${plan.base} can fast-forward.`
        : `Do not modify ${plan.base}. The finalizer will create the squash commit.`;
    return `Prepare workspace ${plan.source} for a ${plan.mode === "ff" ? "fast-forward" : "squash"} merge into ${plan.base}.

Review all source changes and commits relative to ${plan.base}. Group the work into logical commits. You can rewrite commits on ${plan.source}. Run the relevant checks. Make both the source repository and ../pm clean. The finalizer deletes the PM repository. ${mergePreparation}

Do not update ${plan.base}, remove the worktree, or delete branches yourself. When the workspace is ready, call ${WORKSPACE_MERGE_FINALIZE_TOOL} as the only tool call. The finalizer asks for confirmation, merges the branch, removes the workspace and source branch, preserves this Pi session file, and shuts down Pi.`;
}

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
    return branch === "new" || branch === "merge" || branch === "prune" || /^#?\d+$/.test(branch) || branch.startsWith("branch:");
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

function mergeWorkspaceCompletions(
    words: readonly string[],
    prefix: string,
    candidates: WorkspaceCompletionCandidates,
): AutocompleteItem[] {
    const mergeWords = words.slice(1);
    const hasSquash = mergeWords.includes("--squash");
    const baseWords = mergeWords.filter((word) => word !== "--squash");
    if (baseWords.length > 1 || mergeWords.some((word) => word.startsWith("--") && word !== "--squash")) return [];
    const branches = baseWords.length === 0 && !prefix.startsWith("--")
        ? workspaceTargetCompletions(words, prefix, { ...candidates, pullRequests: [] })
        : [];
    const options = !hasSquash && (!prefix || prefix.startsWith("--"))
        ? prefixedCompletions(words, prefix, WORKSPACE_MERGE_OPTION_COMPLETIONS)
        : [];
    return [...branches, ...options];
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
    } else if (words[0] === "merge") {
        completions = mergeWorkspaceCompletions(words, prefix, candidates);
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

export interface WorkspaceCommandActions {
    startMerge?: (plan: WorkspaceMergePlan) => Promise<void>;
    resumeCleanup?: (cleanup: WorkspaceMergeCleanup) => Promise<void>;
}

export async function handleWorkspace(
    args: string,
    ctx: ExtensionCommandContext,
    service = new WorkspaceService(ctx.cwd),
    actions: WorkspaceCommandActions = {},
): Promise<void> {
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
        if (words[0] === "merge") {
            if (!actions.startMerge || !actions.resumeCleanup) throw new WorkspaceError("The workspace merge workflow is unavailable");
            const options = parseWorkspaceMerge(words.slice(1));
            const session = ctx.sessionManager.getSessionFile();
            const cleanup = await service.pendingMergeCleanup(options.base, session);
            if (cleanup) {
                const confirmed = await ctx.ui.confirm(
                    "Resume workspace cleanup",
                    `Delete ${cleanup.source}, its worktree, and its PM repository? The merge into ${cleanup.base} is complete.`,
                );
                if (!confirmed) return;
                await actions.resumeCleanup(cleanup);
                ctx.shutdown();
                return;
            }
            const plan = await service.prepareMerge(options, session);
            await actions.startMerge(plan);
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
    let owned: { branch: string; session: string } | undefined;
    let pendingMerge: WorkspaceMergePlan | undefined;
    let pendingMergeCleanup: WorkspaceMergeCleanup | undefined;
    let pmPath: string | undefined;

    const deactivateMergeFinalizer = (): void => {
        if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== WORKSPACE_MERGE_FINALIZE_TOOL));
    };
    if (typeof pi.registerTool === "function") {
        pi.registerTool({
            name: WORKSPACE_MERGE_FINALIZE_TOOL,
            label: "Merge workspace",
            description: "Finalize the pending workspace merge after the source commits and checks are ready",
            parameters: Type.Object({}),
            executionMode: "sequential",
            async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
                const plan = pendingMerge;
                if (!plan) throw new WorkspaceError("No workspace merge is pending");
                const session = ctx.sessionManager.getSessionFile();
                if (!session || resolve(session) !== resolve(plan.session)) throw new WorkspaceError("The pending merge belongs to another Pi session");
                const confirmed = await ctx.ui.confirm(
                    "Merge and remove workspace",
                    `Merge ${plan.source} into ${plan.base}, delete the source branch, worktree, and PM repository, then exit Pi? The Pi session file is preserved.`,
                );
                const service = createService(plan.sourceCwd);
                if (!confirmed) {
                    await service.cancelMerge(plan);
                    pendingMerge = undefined;
                    deactivateMergeFinalizer();
                    return {
                        content: [{ type: "text", text: "Workspace merge cancelled." }],
                        details: { cancelled: true },
                        terminate: true,
                    };
                }
                const cleanup = await service.mergeWorkspace(plan);
                pendingMergeCleanup = cleanup;
                pendingMerge = undefined;
                deactivateMergeFinalizer();
                ctx.shutdown();
                return {
                    content: [{
                        type: "text",
                        text: `Merged ${cleanup.source} into ${cleanup.base}. Pi will remove the workspace and source branch during shutdown. The Pi session file is preserved.`,
                    }],
                    details: cleanup,
                    terminate: true,
                };
            },
        });
    }

    const startMerge = async (plan: WorkspaceMergePlan): Promise<void> => {
        if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function"
            || typeof pi.sendUserMessage !== "function") {
            await createService(plan.sourceCwd).cancelMerge(plan);
            throw new WorkspaceError("The workspace merge workflow is unavailable");
        }
        if (pendingMerge || pendingMergeCleanup) {
            await createService(plan.sourceCwd).cancelMerge(plan);
            throw new WorkspaceError("A workspace merge is already in progress");
        }
        pendingMerge = plan;
        pi.setActiveTools([...new Set([...pi.getActiveTools(), WORKSPACE_MERGE_FINALIZE_TOOL])]);
        try {
            pi.sendUserMessage(workspaceMergePrompt(plan));
        } catch (error) {
            pendingMerge = undefined;
            deactivateMergeFinalizer();
            await createService(plan.sourceCwd).cancelMerge(plan);
            throw error;
        }
    };
    const resumeCleanup = async (cleanup: WorkspaceMergeCleanup): Promise<void> => {
        if (pendingMerge || pendingMergeCleanup) throw new WorkspaceError("A workspace merge is already in progress");
        pendingMergeCleanup = await createService(cleanup.primaryCwd).resumeMergeCleanup(cleanup);
    };
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
        handleWorkspace(args, ctx, createService(ctx.cwd), { startMerge, resumeCleanup });

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
    pi.on("resources_discover", () => pmPath ? { skillPaths: [WORKSPACE_PM_SKILL_PATH] } : { skillPaths: [] });
    pi.on("before_agent_start", (event) => pmPath ? {
        systemPrompt: `${event.systemPrompt}\n\nActive workspace PM: \`../pm\`. Load \`workspace-pm\` for durable project records.`,
    } : undefined);
    pi.on("session_start", async (_event, ctx) => {
        workspaceCwd = ctx.cwd;
        pendingMerge = undefined;
        pendingMergeCleanup = undefined;
        deactivateMergeFinalizer();
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
        if (pendingMergeCleanup) {
            const cleanup = pendingMergeCleanup;
            pendingMergeCleanup = undefined;
            try {
                process.chdir(cleanup.primaryCwd);
                await createService(cleanup.primaryCwd).cleanupMergedWorkspace(cleanup);
            } catch (error) {
                ctx.ui.notify(`Workspace merged, but cleanup failed: ${errorText(error)}`, "error");
            } finally {
                owned = undefined;
                pmPath = undefined;
            }
            return;
        }
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
