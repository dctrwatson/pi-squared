import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WorkspaceError } from "./process.ts";
import { WorkspaceService, parseCommandWords, parseNewWorkspace, parseWorkspaceTarget } from "./core.ts";
import { sessionHasAutomaticWorkspaceName, WORKSPACE_SESSION_NAME_TYPE, WORKSPACE_SESSION_TYPE } from "./sessions.ts";
import type { PruneResult, PullRequestDivergenceChoice, WorkspaceStatus } from "./types.ts";

export const WORKSPACE_PM_SKILL_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "skills",
    "workspace-pm",
    "SKILL.md",
);

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

function pullRequestNumber(status: WorkspaceStatus): number | undefined {
    if (status.record.pr) return status.record.pr.number;
    const match = status.record.prUrl?.match(/\/pull\/(\d+)$/i);
    return match?.[1] ? Number(match[1]) : undefined;
}

function workspaceLabel(status: WorkspaceStatus): string {
    const parts = [status.record.branch];
    const number = pullRequestNumber(status);
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
        const number = pullRequestNumber(status);
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

export default function workspaceExtension(pi: ExtensionAPI): void {
    pi.registerCommand("workspace", {
        description: "Open or switch a branch workspace",
        handler: handleWorkspace,
    });
    pi.registerCommand("ws", {
        description: "Open or switch a branch workspace",
        handler: handleWorkspace,
    });

    let owned: { branch: string; session: string } | undefined;
    let pmPath: string | undefined;
    pi.on("resources_discover", () => pmPath ? { skillPaths: [WORKSPACE_PM_SKILL_PATH] } : { skillPaths: [] });
    pi.on("before_agent_start", (event) => pmPath ? {
        systemPrompt: `${event.systemPrompt}\n\nActive workspace PM: \`../pm\`. Load \`workspace-pm\` for durable project records.`,
    } : undefined);
    pi.on("session_start", async (_event, ctx) => {
        pmPath = undefined;
        const service = new WorkspaceService(ctx.cwd);
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
            const state = await new WorkspaceService(ctx.cwd).state();
            await state.releaseLease(owned);
        } finally {
            owned = undefined;
            pmPath = undefined;
        }
    });
}
