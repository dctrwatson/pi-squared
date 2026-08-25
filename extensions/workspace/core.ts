import { access, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { GitRepository, canonicalPath } from "./git.ts";
import { WorkspaceError } from "./process.ts";
import { PiSessionStore, readWorkspaceSession, samePullRequest, type SessionStore, workspaceMetadata } from "./sessions.ts";
import { WorkspaceState, stableHash } from "./state.ts";
import type {
    Activation,
    LeaseRecord,
    NewWorkspaceOptions,
    Placement,
    PruneResult,
    PullRequest,
    PullRequestDetails,
    PullRequestDivergence,
    PullRequestDivergenceChoice,
    WorkspaceMergeCleanup,
    WorkspaceMergeOptions,
    WorkspaceMergePlan,
    WorkspaceMergeResult,
    WorkspaceMetadata,
    WorkspaceRecord,
    WorkspaceStatus,
    WorkspaceTarget,
} from "./types.ts";

export interface WorkspaceServiceOptions {
    git?: GitRepository;
    sessions?: SessionStore;
}

export interface ActivationOptions {
    parallel: boolean;
    switchSession: (session: string) => Promise<{ cancelled: boolean }>;
    resolvePullRequestDivergence?: (divergence: PullRequestDivergence) => Promise<PullRequestDivergenceChoice>;
    leasePid?: number;
}

interface BranchMutation {
    branch: string;
    oldOid: string;
    newOid: string;
}

interface Rollback {
    record?: WorkspaceRecord;
    branchMutation?: BranchMutation;
    config?: Map<string, string | undefined>;
    createdSession?: string;
    createdWorktree?: string;
    createdWorkspace?: string;
    primary?: string;
    previousPrimaryBranch?: string;
    createdBranch?: string;
}

function now(): string {
    return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function sameRepository(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

function sameUrl(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

function repositoryName(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const nameWithOwner = (value as { nameWithOwner?: unknown }).nameWithOwner;
    return typeof nameWithOwner === "string" && nameWithOwner.includes("/") ? nameWithOwner : undefined;
}

function canonicalPullRequestUrl(value: string): string | undefined {
    const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks|conversation))?\/?(?:[?#].*)?$/i);
    if (!match?.[1] || !match[2] || !match[3]) return undefined;
    return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${Number(match[3])}`;
}

function pullRequestBaseRepository(url: string): string | undefined {
    const canonical = canonicalPullRequestUrl(url);
    const match = canonical?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/i);
    if (!match?.[1] || !match[2]) return undefined;
    return `${match[1]}/${match[2]}`;
}

function isPullRequest(value: unknown): value is PullRequest {
    if (!value || typeof value !== "object") return false;
    const pr = value as Partial<PullRequest>;
    return typeof pr.number === "number" && Number.isSafeInteger(pr.number)
        && typeof pr.url === "string" && canonicalPullRequestUrl(pr.url) !== undefined
        && typeof pr.baseRepository === "string" && typeof pr.headRepository === "string"
        && typeof pr.headRef === "string";
}

async function samePath(left: string, right: string): Promise<boolean> {
    return await canonicalPath(left) === await canonicalPath(right);
}

export function parseWorkspaceTarget(input: string): WorkspaceTarget | undefined {
    const value = input.trim();
    if (!value) return undefined;
    if (value.startsWith("branch:")) {
        const branch = value.slice("branch:".length);
        if (!branch) throw new WorkspaceError("branch: requires a branch name");
        return { type: "branch", branch };
    }
    const url = canonicalPullRequestUrl(value);
    if (url) {
        const number = Number(url.slice(url.lastIndexOf("/") + 1));
        return { type: "pr", number, url };
    }
    const number = value.match(/^#?(\d+)$/);
    if (number?.[1]) return { type: "pr", number: Number(number[1]) };
    return { type: "branch", branch: value };
}

export function parseCommandWords(input: string): string[] {
    const words: string[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    for (const character of input.trim()) {
        if (escaped) {
            current += character;
            escaped = false;
        } else if (character === "\\" && quote !== "'") {
            escaped = true;
        } else if ((character === "'" || character === '"')) {
            if (quote === character) quote = undefined;
            else if (!quote) quote = character;
            else current += character;
        } else if (/\s/.test(character) && !quote) {
            if (current) words.push(current);
            current = "";
        } else {
            current += character;
        }
    }
    if (escaped || quote) throw new WorkspaceError("Unclosed quote in workspace command");
    if (current) words.push(current);
    return words;
}

export function parseNewWorkspace(words: string[], command = "/ws new"): NewWorkspaceOptions {
    let branch: string | undefined;
    let from: string | undefined;
    let parallel = false;
    for (let index = 0; index < words.length; index++) {
        const word = words[index];
        if (!word) continue;
        if (word === "--worktree") {
            parallel = true;
            continue;
        }
        if (word === "--from") {
            const next = words[++index];
            if (!next) throw new WorkspaceError("--from requires a ref");
            from = next;
            continue;
        }
        if (word.startsWith("--")) throw new WorkspaceError(`Unknown workspace option: ${word}`);
        if (branch) throw new WorkspaceError(`${command} accepts one branch name`);
        branch = word;
    }
    if (!branch) throw new WorkspaceError(`${command} requires a branch name`);
    return { branch, ...(from ? { from } : {}), parallel };
}

export function parseWorkspaceMerge(words: string[], command = "/ws merge"): WorkspaceMergeOptions {
    let base: string | undefined;
    let mode: WorkspaceMergeOptions["mode"] = "ff";
    for (const word of words) {
        if (word === "--squash") {
            mode = "squash";
            continue;
        }
        if (word.startsWith("--")) throw new WorkspaceError(`Unknown workspace merge option: ${word}`);
        if (base) throw new WorkspaceError(`${command} accepts one base branch`);
        const target = parseWorkspaceTarget(word);
        if (!target || target.type !== "branch") throw new WorkspaceError(`${command} requires a local base branch`);
        base = target.branch;
    }
    if (!base) throw new WorkspaceError(`${command} requires a base branch`);
    return { base, mode };
}

export class WorkspaceService {
    readonly git: GitRepository;
    readonly sessions: SessionStore;

    constructor(cwd: string, options: WorkspaceServiceOptions = {}) {
        this.git = options.git ?? new GitRepository(cwd);
        this.sessions = options.sessions ?? new PiSessionStore();
    }

    async state(): Promise<WorkspaceState> {
        const paths = await this.git.paths();
        return new WorkspaceState(this.git, paths.commonDir, paths.primaryCwd);
    }

    async pullRequest(target: Extract<WorkspaceTarget, { type: "pr" }>): Promise<PullRequestDetails> {
        const baseResult = await this.git.runner.run("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: this.git.cwd });
        if (baseResult.code !== 0) throw new WorkspaceError(`gh repo view failed: ${(baseResult.stderr || baseResult.stdout).trim().slice(0, 300)}`);
        const baseRepository = repositoryName(this.parseGhJson(baseResult.stdout, "gh repo view"));
        if (!baseRepository) throw new WorkspaceError("gh repo view returned no repository identity");

        const identifier = target.url ?? String(target.number);
        const result = await this.git.runner.run("gh", [
            "pr",
            "view",
            identifier,
            "--json",
            "number,url,headRefName,headRefOid,headRepository",
        ], { cwd: this.git.cwd });
        if (result.code !== 0) throw new WorkspaceError(`gh pr view failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
        const parsed = this.parseGhJson(result.stdout, "gh pr view") as {
            number?: unknown;
            url?: unknown;
            headRefName?: unknown;
            headRefOid?: unknown;
            headRepository?: unknown;
        };
        const number = parsed.number;
        const url = typeof parsed.url === "string" ? canonicalPullRequestUrl(parsed.url) : undefined;
        const headRepository = repositoryName(parsed.headRepository);
        const resolvedBase = url ? pullRequestBaseRepository(url) : undefined;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || !url || typeof parsed.headRefName !== "string"
            || !headRepository || !resolvedBase || typeof parsed.headRefOid !== "string" || !parsed.headRefOid) {
            throw new WorkspaceError("gh pr view returned incomplete pull request data");
        }
        if (number !== target.number || !sameRepository(resolvedBase, baseRepository)) {
            throw new WorkspaceError("Pull request does not belong to this repository");
        }
        if (target.url && canonicalPullRequestUrl(target.url) !== url) {
            throw new WorkspaceError("Pull request URL does not match the selected pull request");
        }
        return {
            number,
            url,
            baseRepository: resolvedBase,
            headRepository,
            headRef: parsed.headRefName,
            headOid: parsed.headRefOid,
            branch: parsed.headRefName,
        };
    }

    private parseGhJson(output: string, command: string): Record<string, unknown> {
        try {
            const value = JSON.parse(output) as unknown;
            if (!value || typeof value !== "object") throw new Error("not an object");
            return value as Record<string, unknown>;
        } catch {
            throw new WorkspaceError(`${command} returned invalid JSON`);
        }
    }

    async checkoutPullRequest(pr: PullRequestDetails, cwd: string): Promise<string> {
        await this.git.assertClean(cwd);
        const result = await this.git.runner.run("gh", ["pr", "checkout", pr.url], { cwd });
        if (result.code !== 0) throw new WorkspaceError(`gh pr checkout failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
        const branch = await this.git.branch(cwd);
        if (branch !== pr.branch) throw new WorkspaceError(`gh pr checkout selected ${branch}, not ${pr.branch}`);
        if (pr.headOid && await this.git.branchOid(cwd) !== pr.headOid) {
            throw new WorkspaceError("gh pr checkout did not select the pull request head commit");
        }
        return branch;
    }

    private async recordMatchesRepository(record: WorkspaceRecord | undefined, state: WorkspaceState): Promise<boolean> {
        return Boolean(record && record.version === 2 && await canonicalPath(record.repository) === state.commonDir);
    }

    private async recordIsValid(record: WorkspaceRecord, state: WorkspaceState): Promise<boolean> {
        if (!await this.recordMatchesRepository(record, state)) return false;
        if (record.pr && !isPullRequest(record.pr)) return false;
        if (record.prUrl && (!record.pr || !sameUrl(record.pr.url, record.prUrl))) return false;
        if (!await pathExists(record.cwd) || !await this.git.localBranchOid(record.branch)) return false;
        try {
            const paths = await this.git.paths();
            if (!await samePath(record.cwd, paths.primaryCwd) && await this.git.branch(record.cwd) !== record.branch) return false;
            await this.git.branch(record.cwd);
        } catch {
            return false;
        }
        const metadata = workspaceMetadata(record.repository, record.branch, record.cwd, record.pr);
        if (await this.sessions.validate(record.session, metadata)) return true;
        return this.isRenamedBranchBinding(record, state);
    }

    private async isRenamedBranchBinding(record: WorkspaceRecord, state: WorkspaceState): Promise<boolean> {
        const stored = await readWorkspaceSession(record.session);
        const metadata = stored?.metadata;
        if (!metadata || metadata.branch === record.branch
            || await canonicalPath(metadata.repository) !== state.commonDir
            || !await samePath(metadata.cwd, record.cwd)
            || !samePullRequest(metadata.pr, record.pr)
            || await this.git.localBranchOid(metadata.branch)
            || !await this.git.localBranchOid(record.branch)) return false;
        return true;
    }

    private async sessionMatches(record: WorkspaceRecord, metadata: WorkspaceMetadata, state?: WorkspaceState): Promise<boolean> {
        if (await this.sessions.validate(record.session, metadata)) return true;
        if (state && await this.isRenamedBranchBinding(record, state) && this.sessions.rebind) {
            return this.sessions.rebind(record.session, metadata);
        }
        return this.sessions.bind(record.session, metadata);
    }

    private async liveWorkspaceAt(state: WorkspaceState, cwd: string, ownerPid: number): Promise<{ record: WorkspaceRecord; lease: LeaseRecord } | undefined> {
        for (const record of await state.listWorkspaces()) {
            if (!await samePath(record.cwd, cwd)) continue;
            const lease = await state.readLease(record.session);
            if (!lease || !await state.processIsLive(lease)) continue;
            if (lease.pid === ownerPid && lease.hostname === hostname()) continue;
            return { record, lease };
        }
        return undefined;
    }

    private async assertCheckoutAvailable(state: WorkspaceState, cwd: string, ownerPid: number): Promise<void> {
        const active = await this.liveWorkspaceAt(state, cwd, ownerPid);
        if (active) throw new WorkspaceError(`Workspace ${active.record.branch} is active in another Pi session`);
    }

    private async assertMergeBaseAvailable(state: WorkspaceState, cwd: string, sourceSession: string): Promise<void> {
        for (const record of await state.listWorkspaces()) {
            if (resolve(record.session) === resolve(sourceSession) || !await samePath(record.cwd, cwd)) continue;
            const lease = await state.readLease(record.session);
            if (lease && await state.processIsLive(lease)) {
                throw new WorkspaceError(`Workspace ${record.branch} is active in another Pi session`);
            }
        }
    }

    private async mutableCheckoutForActivation(branch: string, parallel: boolean): Promise<string | undefined> {
        const paths = await this.git.paths();
        const worktree = await this.git.findWorktree(branch);
        if (worktree) return worktree.cwd;
        return parallel ? undefined : paths.primaryCwd;
    }

    async activationBlocker(branch: string, parallel: boolean, ownerPid = process.pid): Promise<{ record: WorkspaceRecord; lease: LeaseRecord } | undefined> {
        const state = await this.state();
        const cwd = await this.mutableCheckoutForActivation(branch, parallel);
        return cwd ? this.liveWorkspaceAt(state, cwd, ownerPid) : undefined;
    }

    async placement(record: WorkspaceRecord): Promise<Placement> {
        const paths = await this.git.paths();
        if (await canonicalPath(record.cwd) === paths.primaryCwd) return "primary";
        return "managed";
    }

    async list(): Promise<WorkspaceStatus[]> {
        const state = await this.state();
        const records = await state.listWorkspaces();
        const result: WorkspaceStatus[] = [];
        for (const record of records) {
            const stale = !await this.recordIsValid(record, state);
            let dirty = false;
            if (!stale) {
                const status = await this.git.tryRun(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], record.cwd);
                dirty = !status.ok || Boolean(status.stdout);
            }
            const lease = await state.readLease(record.session);
            const active = lease !== undefined && await state.processIsLive(lease);
            result.push({
                record,
                placement: await this.placement(record),
                recency: await state.sessionRecency(record.session),
                dirty,
                stale,
                active,
                ...(active && lease ? { activeLease: lease } : {}),
            });
        }
        return result.sort((left, right) => (right.recency ?? 0) - (left.recency ?? 0));
    }

    async prune(): Promise<PruneResult> {
        const state = await this.state();
        const currentCwd = (await this.git.paths()).currentCwd;
        return state.withMutationLock(async () => {
            const result: PruneResult = { pruned: [], skipped: [] };
            for (const record of await state.listWorkspaces()) {
                if (!await this.git.isManagedWorktree(record.cwd)) continue;
                if (await samePath(record.cwd, currentCwd)) {
                    result.skipped.push({ branch: record.branch, reason: "workspace is the current checkout" });
                    continue;
                }
                const worktree = await this.git.findWorktree(record.branch);
                if (worktree && !await samePath(worktree.cwd, record.cwd)) {
                    result.skipped.push({ branch: record.branch, reason: "branch is checked out elsewhere" });
                    continue;
                }
                if (!worktree && await pathExists(record.cwd)) {
                    result.skipped.push({ branch: record.branch, reason: "managed worktree is unavailable" });
                    continue;
                }
                const lease = await state.readLease(record.session);
                if (lease && await state.processIsLive(lease)) {
                    result.skipped.push({ branch: record.branch, reason: "workspace is active" });
                    continue;
                }
                if (lease) await state.removeKnownStaleLease(record.session);
                let integrated = false;
                if (record.baseBranch && record.baseBranch !== record.branch) {
                    try {
                        const [sourceOid, baseOid] = await Promise.all([
                            this.git.localBranchOid(record.branch),
                            this.git.localBranchOid(record.baseBranch),
                        ]);
                        integrated = Boolean(sourceOid && baseOid && record.baseOid && sourceOid !== record.baseOid
                            && await this.git.integrationIntoBase(sourceOid, baseOid));
                    } catch {
                        // A remote deletion can still prove that the workspace is ready to prune.
                    }
                }
                if (!integrated) {
                    let remote: string | undefined;
                    let remoteExists: boolean;
                    try {
                        remote = await this.git.remoteForBranch(record.branch);
                        if (!remote) {
                            const base = record.baseBranch ? ` and is not integrated into ${record.baseBranch}` : " and has no recorded base branch";
                            result.skipped.push({ branch: record.branch, reason: `no remote is configured${base}` });
                            continue;
                        }
                        remoteExists = await this.git.remoteBranchExists(remote, record.branch);
                    } catch (error) {
                        result.skipped.push({ branch: record.branch, reason: `could not verify remote: ${error instanceof Error ? error.message : String(error)}` });
                        continue;
                    }
                    if (remoteExists) {
                        const base = record.baseBranch ? ` and branch is not integrated into ${record.baseBranch}` : "";
                        result.skipped.push({ branch: record.branch, reason: `remote branch exists on ${remote}${base}` });
                        continue;
                    }
                }
                const workspace = dirname(record.cwd);
                const workspacePm = join(workspace, "pm");
                try {
                    if (worktree) await this.git.assertClean(record.cwd);
                    if (await pathExists(workspacePm)) await this.git.assertClean(workspacePm);
                    if (worktree) await this.git.removeWorktree(record.cwd);
                    await rm(workspace, { recursive: true, force: true });
                    await state.removeWorkspace(record.branch);
                    result.pruned.push(record.branch);
                } catch (error) {
                    result.skipped.push({ branch: record.branch, reason: error instanceof Error ? error.message : String(error) });
                }
            }
            return result;
        });
    }

    async pendingMergeCleanup(
        base: string,
        session: string | undefined,
    ): Promise<WorkspaceMergeCleanup | undefined> {
        if (!session) return undefined;
        const state = await this.state();
        const paths = await this.git.paths();
        const source = await this.git.branch(paths.currentCwd);
        const cleanup = await state.getMergeCleanup(source);
        if (!cleanup) return undefined;
        if (cleanup.base !== base) throw new WorkspaceError(`Workspace cleanup is pending for base branch ${cleanup.base}`);
        if (resolve(cleanup.session) !== resolve(session) || !await samePath(cleanup.sourceCwd, paths.currentCwd)) {
            throw new WorkspaceError("The pending workspace cleanup belongs to another Pi session");
        }
        const [sourceOid, baseOid] = await Promise.all([
            this.git.localBranchOid(source),
            this.git.localBranchOid(base),
        ]);
        if (sourceOid !== cleanup.sourceOid) throw new WorkspaceError("The source branch changed after the pending workspace merge");
        const expectedBaseOids = cleanup.phase === "merged"
            ? [cleanup.baseOid]
            : [cleanup.preMergeBaseOid, cleanup.baseOid];
        if (!baseOid || !expectedBaseOids.includes(baseOid)) {
            throw new WorkspaceError("The base branch changed after the pending workspace merge");
        }
        return cleanup;
    }

    async resumeMergeCleanup(cleanup: WorkspaceMergeCleanup, ownerPid = process.pid): Promise<WorkspaceMergeCleanup> {
        const git = new GitRepository(cleanup.primaryCwd, this.git.runner);
        const paths = await git.paths();
        const state = new WorkspaceState(git, paths.commonDir, paths.primaryCwd);
        return state.withMutationLock(async () => {
            const record = await state.getWorkspace(cleanup.source);
            if (!record || resolve(record.session) !== resolve(cleanup.session)) {
                throw new WorkspaceError("The pending workspace cleanup is stale");
            }
            const lease = await state.readLease(record.session);
            if (!lease || lease.pid !== ownerPid || lease.hostname !== hostname() || lease.session !== record.session) {
                throw new WorkspaceError("The current Pi process does not own this workspace");
            }
            const baseWorktree = await git.findWorktree(cleanup.base);
            if (!baseWorktree || !await samePath(baseWorktree.cwd, paths.primaryCwd)) {
                throw new WorkspaceError(`Base branch ${cleanup.base} must be checked out in the primary checkout`);
            }
            await this.assertMergeBaseAvailable(state, baseWorktree.cwd, record.session);
            const [sourceOid, baseOid] = await Promise.all([
                git.localBranchOid(cleanup.source),
                git.localBranchOid(cleanup.base),
            ]);
            if (sourceOid !== cleanup.sourceOid) throw new WorkspaceError("The source branch changed before workspace cleanup");
            if (baseOid === cleanup.preMergeBaseOid) {
                await git.assertClean(baseWorktree.cwd);
                await git.fastForward(baseWorktree.cwd, cleanup.baseOid);
            } else if (baseOid !== cleanup.baseOid) {
                throw new WorkspaceError("The base branch changed before workspace cleanup");
            }
            const merged = { ...cleanup, phase: "merged" as const };
            await state.putMergeCleanup(merged);
            return merged;
        });
    }

    async prepareMerge(
        options: WorkspaceMergeOptions,
        session: string | undefined,
        ownerPid = process.pid,
    ): Promise<WorkspaceMergePlan> {
        if (!session) throw new WorkspaceError("The current Pi session is not persisted");
        const state = await this.state();
        return state.withMutationLock(async () => {
            const paths = await this.git.paths();
            const source = await this.git.branch(paths.currentCwd);
            if (source === options.base) throw new WorkspaceError("A workspace cannot merge into itself");
            const record = await state.getWorkspace(source);
            if (!record || !await samePath(record.cwd, paths.currentCwd) || !await this.git.isManagedWorktree(record.cwd)) {
                throw new WorkspaceError("/ws merge requires the current managed workspace");
            }
            if (resolve(record.session) !== resolve(session)) throw new WorkspaceError("The current session does not own this workspace");
            const lease = await state.readLease(record.session);
            if (!lease || lease.pid !== ownerPid || lease.hostname !== hostname() || lease.session !== record.session) {
                throw new WorkspaceError("The current Pi process does not own this workspace");
            }
            const [sourceOid, baseOid] = await Promise.all([
                this.git.localBranchOid(source),
                this.git.localBranchOid(options.base),
            ]);
            if (!sourceOid) throw new WorkspaceError(`Local branch does not exist: ${source}`);
            if (!baseOid) throw new WorkspaceError(`Local base branch does not exist: ${options.base}`);
            const baseWorktree = await this.git.findWorktree(options.base);
            if (!baseWorktree || !await samePath(baseWorktree.cwd, paths.primaryCwd)) {
                throw new WorkspaceError(`Base branch ${options.base} must be checked out in the primary checkout`);
            }
            await this.assertMergeBaseAvailable(state, baseWorktree.cwd, record.session);
            await this.git.assertClean(baseWorktree.cwd);
            if (!record.baseBranch || (record.baseBranch === options.base && !record.baseOid)) {
                const recordedBaseOid = record.baseOid ?? await this.git.mergeBase(sourceOid, baseOid) ?? baseOid;
                await state.putWorkspace({ ...record, baseBranch: options.base, baseOid: recordedBaseOid, updatedAt: now() });
            }
            const operationId = randomUUID();
            const recoveryRef = `refs/pi-workspace/recovery/${stableHash(source, 32)}/${Date.now()}-${operationId}`;
            if (!await this.git.updateRef(recoveryRef, sourceOid, "0".repeat(sourceOid.length))) {
                throw new WorkspaceError("Could not create a workspace merge recovery ref");
            }
            return {
                ...options,
                operationId,
                source,
                sourceCwd: record.cwd,
                sourceOid,
                primaryCwd: paths.primaryCwd,
                session: record.session,
                baseOid,
                recoveryRef,
            };
        });
    }

    private async createSquashCommit(
        git: GitRepository,
        state: WorkspaceState,
        plan: WorkspaceMergePlan,
        sourceOid: string,
    ): Promise<string> {
        const temporary = join(state.root, `.merge-${plan.operationId}`);
        let worktreeAdded = false;
        try {
            await git.addDetachedWorktree(temporary, plan.baseOid);
            worktreeAdded = true;
            await git.run(["merge", "--squash", "--no-commit", sourceOid], temporary);
            await git.run(["commit", "-m", `Merge branch '${plan.source}' into ${plan.base}`], temporary);
            return git.branchOid(temporary);
        } finally {
            if (worktreeAdded) {
                try {
                    await git.removeWorktreeForce(temporary);
                } catch {
                    // The temporary checkout contains no unique source commits.
                }
            }
            await rm(temporary, { recursive: true, force: true });
        }
    }

    async cancelMerge(plan: WorkspaceMergePlan): Promise<void> {
        const git = new GitRepository(plan.primaryCwd, this.git.runner);
        await git.updateRef(plan.recoveryRef, undefined, plan.sourceOid);
    }

    async mergeWorkspace(plan: WorkspaceMergePlan, ownerPid = process.pid): Promise<WorkspaceMergeCleanup> {
        const git = new GitRepository(plan.primaryCwd, this.git.runner);
        const paths = await git.paths();
        if (!await samePath(paths.primaryCwd, plan.primaryCwd)) throw new WorkspaceError("The merge repository changed");
        const state = new WorkspaceState(git, paths.commonDir, paths.primaryCwd);
        return state.withMutationLock(async () => {
            const record = await state.getWorkspace(plan.source);
            if (!record || resolve(record.session) !== resolve(plan.session) || !await samePath(record.cwd, plan.sourceCwd)) {
                throw new WorkspaceError("The pending workspace merge is stale");
            }
            const lease = await state.readLease(record.session);
            if (!lease || lease.pid !== ownerPid || lease.hostname !== hostname() || lease.session !== record.session) {
                throw new WorkspaceError("The current Pi process does not own this workspace");
            }
            const baseWorktree = await git.findWorktree(plan.base);
            if (!baseWorktree || !await samePath(baseWorktree.cwd, paths.primaryCwd)) {
                throw new WorkspaceError(`Base branch ${plan.base} must be checked out in the primary checkout`);
            }
            await this.assertMergeBaseAvailable(state, baseWorktree.cwd, record.session);
            const [sourceOid, baseOid, recoveryOid] = await Promise.all([
                git.localBranchOid(plan.source),
                git.localBranchOid(plan.base),
                git.refOid(plan.recoveryRef),
            ]);
            if (!sourceOid || !baseOid) throw new WorkspaceError("A merge branch no longer exists");
            if (recoveryOid !== plan.sourceOid) throw new WorkspaceError("The workspace merge recovery ref changed");
            if (baseOid !== plan.baseOid) throw new WorkspaceError(`Base branch ${plan.base} changed; run /ws merge again`);
            if (await git.branch(record.cwd) !== plan.source) throw new WorkspaceError("The source worktree changed branches");
            const workspacePm = join(dirname(record.cwd), "pm");
            await git.assertClean(record.cwd);
            if (await pathExists(workspacePm)) await git.assertClean(workspacePm);
            await git.assertClean(baseWorktree.cwd);

            let mergedOid: string;
            if (plan.mode === "ff") {
                if (!await git.isAncestor(baseOid, sourceOid)) {
                    throw new WorkspaceError(`Branch ${plan.source} must be rebased onto ${plan.base} before a fast-forward merge`);
                }
                mergedOid = sourceOid;
            } else {
                mergedOid = await this.createSquashCommit(git, state, plan, sourceOid);
            }
            let finalRecoveryRef: string | undefined;
            if (sourceOid !== plan.sourceOid) {
                finalRecoveryRef = `${plan.recoveryRef}-final`;
                if (!await git.updateRef(finalRecoveryRef, sourceOid, "0".repeat(sourceOid.length))) {
                    throw new WorkspaceError("Could not create the final workspace merge recovery ref");
                }
            }
            const cleanup: WorkspaceMergeCleanup = {
                phase: "prepared",
                source: plan.source,
                base: plan.base,
                baseOid: mergedOid,
                session: plan.session,
                sourceCwd: plan.sourceCwd,
                sourceOid,
                initialSourceOid: plan.sourceOid,
                primaryCwd: plan.primaryCwd,
                preMergeBaseOid: baseOid,
                recoveryRef: plan.recoveryRef,
                ...(finalRecoveryRef ? { finalRecoveryRef } : {}),
            };
            await state.putMergeCleanup(cleanup);
            try {
                await git.fastForward(baseWorktree.cwd, mergedOid);
            } catch (error) {
                await state.removeMergeCleanup(plan.source);
                throw error;
            }
            const merged = { ...cleanup, phase: "merged" as const };
            await state.putMergeCleanup(merged);
            return merged;
        });
    }

    async cleanupMergedWorkspace(
        cleanup: WorkspaceMergeCleanup,
        options: { ownerPid?: number; beforeRemove?: () => void } = {},
    ): Promise<WorkspaceMergeResult> {
        const ownerPid = options.ownerPid ?? process.pid;
        if (cleanup.phase !== "merged") throw new WorkspaceError("The base merge is not complete");
        const git = new GitRepository(cleanup.primaryCwd, this.git.runner);
        const paths = await git.paths();
        const state = new WorkspaceState(git, paths.commonDir, paths.primaryCwd);
        return state.withMutationLock(async () => {
            const record = await state.getWorkspace(cleanup.source);
            if (!record || resolve(record.session) !== resolve(cleanup.session) || !await samePath(record.cwd, cleanup.sourceCwd)) {
                throw new WorkspaceError("The merged workspace cleanup is stale");
            }
            const lease = await state.readLease(record.session);
            if (!lease || lease.pid !== ownerPid || lease.hostname !== hostname() || lease.session !== record.session) {
                throw new WorkspaceError("The current Pi process does not own this workspace");
            }
            const [sourceOid, baseOid] = await Promise.all([
                git.localBranchOid(cleanup.source),
                git.localBranchOid(cleanup.base),
            ]);
            if (sourceOid !== cleanup.sourceOid || baseOid !== cleanup.baseOid) {
                throw new WorkspaceError("A merge branch changed before workspace cleanup");
            }
            if (await git.branch(record.cwd) !== cleanup.source) throw new WorkspaceError("The source worktree changed branches");
            const workspace = dirname(record.cwd);
            const workspacePm = join(workspace, "pm");
            await git.assertClean(record.cwd);
            if (await pathExists(workspacePm)) await git.assertClean(workspacePm);
            options.beforeRemove?.();
            if (await samePath(process.cwd(), record.cwd)) {
                throw new WorkspaceError("Workspace cleanup requires Pi to leave the source checkout");
            }
            await git.detach(record.cwd, cleanup.sourceOid);
            if (!await git.updateRef(`refs/heads/${cleanup.source}`, undefined, cleanup.sourceOid)) {
                try {
                    await git.run(["checkout", cleanup.source], record.cwd);
                } catch {
                    // The source recovery refs retain both known source tips.
                }
                throw new WorkspaceError(`Could not delete merged branch ${cleanup.source}`);
            }
            try {
                await git.removeWorktree(record.cwd);
            } catch (error) {
                if (await git.updateRef(`refs/heads/${cleanup.source}`, cleanup.sourceOid, "0".repeat(cleanup.sourceOid.length))) {
                    try {
                        await git.run(["checkout", cleanup.source], record.cwd);
                    } catch {
                        // The detached worktree and recovery refs retain the source.
                    }
                }
                throw error;
            }
            await state.releaseLease(record, ownerPid);
            await rm(workspace, { recursive: true, force: true });
            await state.removeWorkspace(cleanup.source);
            await git.removeBranchConfig(cleanup.source);
            await git.updateRef(cleanup.recoveryRef, undefined, cleanup.initialSourceOid);
            if (cleanup.finalRecoveryRef) await git.updateRef(cleanup.finalRecoveryRef, undefined, cleanup.sourceOid);
            return {
                source: cleanup.source,
                base: cleanup.base,
                baseOid: cleanup.baseOid,
                session: cleanup.session,
            };
        });
    }

    async finalizeMerge(
        plan: WorkspaceMergePlan,
        options: { ownerPid?: number; beforeRemove?: () => void } = {},
    ): Promise<WorkspaceMergeResult> {
        const cleanup = await this.mergeWorkspace(plan, options.ownerPid);
        return this.cleanupMergedWorkspace(cleanup, options);
    }

    async currentMetadata(session?: string): Promise<WorkspaceMetadata> {
        const paths = await this.git.paths();
        const state = new WorkspaceState(this.git, paths.commonDir, paths.primaryCwd);
        const branch = await this.git.branch(paths.currentCwd);
        const current = await canonicalPath(paths.currentCwd);
        const existing = await state.getWorkspace(branch);
        const pr = existing && session && await this.recordMatchesRepository(existing, state)
            && isPullRequest(existing.pr) && await samePath(existing.cwd, current)
            && resolve(existing.session) === resolve(session)
            ? existing.pr
            : undefined;
        return workspaceMetadata(state.commonDir, branch, current, pr);
    }

    async registerCurrent(session: string | undefined, metadataAlreadyBound = false): Promise<WorkspaceRecord | undefined> {
        if (!session) return undefined;
        const state = await this.state();
        const currentMetadata = await this.currentMetadata(session);
        const currentRecord: WorkspaceRecord = {
            version: 2,
            repository: currentMetadata.repository,
            branch: currentMetadata.branch,
            session: resolve(session),
            cwd: currentMetadata.cwd,
            ...(currentMetadata.pr ? { pr: currentMetadata.pr, prUrl: currentMetadata.pr.url } : {}),
            updatedAt: now(),
        };
        const existingLease = await state.readLease(currentRecord.session);
        const ownsExistingLease = existingLease?.pid === process.pid
            && existingLease.hostname === hostname()
            && existingLease.session === currentRecord.session;
        if (ownsExistingLease) return currentRecord;
        return state.withMutationLock(async () => {
            const metadata = await this.currentMetadata(session);
            const record: WorkspaceRecord = {
                version: 2,
                repository: metadata.repository,
                branch: metadata.branch,
                session: resolve(session),
                cwd: metadata.cwd,
                ...(metadata.pr ? { pr: metadata.pr, prUrl: metadata.pr.url } : {}),
                updatedAt: now(),
            };
            if (!metadataAlreadyBound && !await this.sessions.bind(record.session, metadata)) {
                throw new WorkspaceError("Could not bind workspace metadata to the current Pi session");
            }
            await this.assertCheckoutAvailable(state, record.cwd, process.pid);
            const active = await state.readLease(record.session);
            const ownLease = active?.pid === process.pid && active.hostname === hostname() && active.session === record.session;
            if (active && await state.processIsLive(active) && !ownLease) {
                throw new WorkspaceError(`Workspace ${record.branch} is active in another Pi session`);
            }
            await state.putWorkspace(record);
            await state.putLast(record);
            await state.acquireLeaseLocked(record);
            return record;
        });
    }

    async replaceCurrentSession(options: Pick<ActivationOptions, "switchSession" | "leasePid">): Promise<Activation> {
        const state = await this.state();
        return state.withMutationLock(async () => {
            const paths = await this.git.paths();
            const cwd = await canonicalPath(paths.currentCwd);
            const branch = await this.git.branch(cwd);
            const ownerPid = options.leasePid ?? process.pid;
            await this.assertCheckoutAvailable(state, cwd, ownerPid);
            const stored = await state.getWorkspace(branch);
            const existing = stored?.branch === branch && await this.recordMatchesRepository(stored, state) ? stored : undefined;
            const pr = existing && await samePath(existing.cwd, cwd) && isPullRequest(existing.pr) ? existing.pr : undefined;
            const rollback: Rollback = {};
            try {
                const record = await this.createRecord(state, branch, cwd, pr);
                rollback.record = record;
                rollback.createdSession = record.session;
                rollback.config = await state.snapshot([
                    state.sessionKey(branch),
                    state.prKey(branch),
                    state.lastKey,
                ]);
                await state.putWorkspace(record);
                await state.putLast(record);
                await state.acquireLeaseLocked(record, ownerPid);
                const switched = await options.switchSession(record.session);
                if (switched.cancelled) throw new WorkspaceError("Workspace session replacement was cancelled");
                return { record, createdSession: true };
            } catch (error) {
                if (rollback.record) await state.releaseLease(rollback.record, ownerPid);
                await this.rollback(state, rollback);
                throw error;
            }
        });
    }

    async repair(branch: string): Promise<WorkspaceRecord> {
        const state = await this.state();
        return state.withMutationLock(async () => {
            const existing = await state.getWorkspace(branch);
            const lease = existing ? await state.readLease(existing.session) : undefined;
            if (lease && await state.processIsLive(lease)) {
                throw new WorkspaceError(`Workspace ${branch} is active in another Pi session`);
            }
            if (existing) await state.removeKnownStaleLease(existing.session);
            if (!existing || !await this.recordMatchesRepository(existing, state)) {
                throw new WorkspaceError(`No workspace state exists for ${branch}`);
            }
            const paths = await this.git.paths();
            if (!await pathExists(existing.cwd) || !await this.git.localBranchOid(branch)
                || (!await samePath(existing.cwd, paths.primaryCwd) && await this.git.branch(existing.cwd) !== branch)) {
                throw new WorkspaceError(`Workspace ${branch} has no usable checkout`);
            }
            await this.assertCheckoutAvailable(state, existing.cwd, process.pid);
            const pr = isPullRequest(existing.pr) ? existing.pr : undefined;
            const record: WorkspaceRecord = {
                version: 2,
                repository: state.commonDir,
                branch,
                cwd: await canonicalPath(existing.cwd),
                session: await this.sessions.create(workspaceMetadata(state.commonDir, branch, existing.cwd, pr)),
                ...(pr ? { pr, prUrl: pr.url } : {}),
                updatedAt: now(),
            };
            await state.putWorkspace(record);
            await state.putLast(record);
            return record;
        });
    }

    async activate(target: WorkspaceTarget, options: ActivationOptions): Promise<Activation> {
        const state = await this.state();
        return state.withMutationLock(async () => {
            const detail = target.type === "pr" ? await this.pullRequest(target) : undefined;
            const branch = detail?.branch ?? (target.type === "branch" ? target.branch : undefined);
            if (!branch) throw new WorkspaceError("Pull request has no branch");
            const pr = detail ? this.pullRequestIdentity(detail) : undefined;
            const stored = await state.getWorkspace(branch);
            const existing = stored?.branch === branch && await this.recordMatchesRepository(stored, state) ? stored : undefined;
            if (pr && existing && (!existing.prUrl || !sameUrl(existing.prUrl, pr.url)
                || !isPullRequest(existing.pr) || !samePullRequest(existing.pr, pr))) {
                throw new WorkspaceError(`Branch ${branch} is already bound to a different pull request`);
            }
            const trustedPullRequest = Boolean(pr && existing && isPullRequest(existing.pr)
                && samePullRequest(existing.pr, pr) && await this.recordIsValid(existing, state));
            const ownerPid = options.leasePid ?? process.pid;
            const lease = existing ? await state.readLease(existing.session) : undefined;
            const ownLease = lease?.pid === ownerPid && lease.hostname === hostname() && lease.session === existing?.session;
            if (lease && await state.processIsLive(lease) && !ownLease) {
                throw new WorkspaceError(`Workspace ${branch} is active in another Pi session`);
            }
            const paths = await this.git.paths();
            const mutableCheckout = await this.mutableCheckoutForActivation(branch, options.parallel);
            if (mutableCheckout) await this.assertCheckoutAvailable(state, mutableCheckout, ownerPid);
            const rollback: Rollback = { primary: paths.primaryCwd, previousPrimaryBranch: await this.git.branch(paths.primaryCwd) };
            let activation: { result: Activation; rollback: Rollback } | undefined;
            try {
                if (trustedPullRequest && detail && existing) {
                    await this.resolvePullRequestDivergence(branch, detail, existing, options, rollback);
                }
                activation = await this.prepareActivationBranch(state, branch, pr, existing, options.parallel, detail, trustedPullRequest, rollback);
                await state.acquireLeaseLocked(activation.result.record, ownerPid);
                const switched = await options.switchSession(activation.result.record.session);
                if (switched.cancelled) throw new WorkspaceError("Workspace switch was cancelled");
                return activation.result;
            } catch (error) {
                if (activation) await state.releaseLease(activation.result.record, ownerPid);
                await this.rollback(state, rollback);
                throw error;
            }
        });
    }

    async create(options: NewWorkspaceOptions, activation: ActivationOptions): Promise<Activation> {
        const state = await this.state();
        return state.withMutationLock(async () => {
            const paths = await this.git.paths();
            const primary = paths.primaryCwd;
            const from = options.from === undefined
                ? await this.git.assertRef("refs/heads/main")
                : options.from === "current"
                    ? await this.git.assertRef("HEAD")
                    : await this.git.assertRef(options.from);
            const baseBranch = options.from === undefined
                ? "main"
                : options.from === "current"
                    ? await this.git.branch(paths.currentCwd)
                    : await this.git.localBranchForRef(options.from);
            await this.git.assertNewBranch(options.branch);
            const rollback: Rollback = {
                primary,
                previousPrimaryBranch: await this.git.branch(primary),
                createdBranch: options.branch,
            };
            const ownerPid = activation.leasePid ?? process.pid;
            if (!options.parallel) await this.assertCheckoutAvailable(state, primary, ownerPid);
            let cwd: string;
            try {
                if (options.parallel) {
                    cwd = await this.createManagedWorktree(state, options.branch, rollback, from);
                } else {
                    await this.git.createBranch(options.branch, from, primary);
                    cwd = primary;
                }
                const record = await this.createRecord(state, options.branch, cwd, undefined, baseBranch, from);
                rollback.record = record;
                rollback.createdSession = record.session;
                rollback.config = await state.snapshot([
                    state.sessionKey(options.branch),
                    state.baseKey(options.branch),
                    state.baseOidKey(options.branch),
                    state.lastKey,
                ]);
                await state.putWorkspace(record);
                await state.putLast(record);
                const result: Activation = {
                    record,
                    createdSession: true,
                    ...(rollback.createdWorktree ? { createdWorktree: rollback.createdWorktree } : {}),
                    ...(!options.parallel ? { previousPrimaryBranch: rollback.previousPrimaryBranch } : {}),
                };
                await state.acquireLeaseLocked(record, ownerPid);
                const switched = await activation.switchSession(record.session);
                if (switched.cancelled) throw new WorkspaceError("Workspace switch was cancelled");
                return result;
            } catch (error) {
                if (rollback.record) await state.releaseLease(rollback.record, activation.leasePid ?? process.pid);
                await this.rollback(state, rollback);
                throw error;
            }
        });
    }

    private pullRequestIdentity(detail: PullRequestDetails): PullRequest {
        return {
            number: detail.number,
            url: detail.url,
            baseRepository: detail.baseRepository,
            headRepository: detail.headRepository,
            headRef: detail.headRef,
            ...(detail.headOid ? { headOid: detail.headOid } : {}),
        };
    }

    private async resolvePullRequestDivergence(
        branch: string,
        detail: PullRequestDetails,
        existing: WorkspaceRecord,
        options: ActivationOptions,
        rollback: Rollback,
    ): Promise<void> {
        const localOid = await this.git.localBranchOid(branch);
        const remoteOid = detail.headOid;
        if (!localOid || !remoteOid) throw new WorkspaceError("Trusted pull request branch has no commit");
        if (localOid === remoteOid) return;
        if (!await this.git.hasCommit(remoteOid)) {
            await this.git.fetchCommit(`https://github.com/${detail.headRepository}.git`, remoteOid);
        }
        const canFastForward = await this.git.isAncestor(localOid, remoteOid);
        if (!options.resolvePullRequestDivergence) {
            throw new WorkspaceError(`Pull request #${detail.number} differs from the local branch. Run /ws #${detail.number} in Pi to choose an update.`);
        }
        const choice = await options.resolvePullRequestDivergence({
            branch,
            number: detail.number,
            url: detail.url,
            localOid,
            remoteOid,
            canFastForward,
        });
        if (choice === "cancel") throw new WorkspaceError("Pull request activation was cancelled");
        if (choice === "keep-local") return;
        if (choice === "fast-forward" && !canFastForward) {
            throw new WorkspaceError("The local pull request branch cannot fast-forward to the remote head");
        }
        if (choice !== "fast-forward" && choice !== "reset") {
            throw new WorkspaceError("Pull request update choice is invalid");
        }
        await this.git.assertClean(existing.cwd);
        if (choice === "reset") {
            const recovery = `refs/pi-workspace/recovery/${stableHash(branch, 32)}/${Date.now()}-${randomUUID()}`;
            if (!await this.git.updateRef(recovery, localOid, "0".repeat(localOid.length))) {
                throw new WorkspaceError("Could not create a pull request recovery ref");
            }
        }
        const checkedOut = await this.git.branch(existing.cwd) === branch;
        if (checkedOut) {
            if (choice === "fast-forward") await this.git.fastForward(existing.cwd, remoteOid);
            else await this.git.resetHard(existing.cwd, remoteOid);
            rollback.branchMutation = { branch, oldOid: localOid, newOid: remoteOid };
        } else {
            await this.git.updateBranch(branch, remoteOid, localOid);
            rollback.branchMutation = { branch, oldOid: localOid, newOid: remoteOid };
        }
    }

    private async sessionForWorkspace(
        state: WorkspaceState,
        branch: string,
        cwd: string,
        pr: PullRequest | undefined,
        existing: WorkspaceRecord | undefined,
    ): Promise<{ metadata: WorkspaceMetadata; session: string; created: boolean }> {
        const workspacePr = pr ?? (isPullRequest(existing?.pr) ? existing.pr : undefined);
        const metadata = workspaceMetadata(state.commonDir, branch, cwd, workspacePr);
        if (existing && !await samePath(existing.cwd, cwd)) {
            const sourceMetadata = workspaceMetadata(state.commonDir, branch, existing.cwd, workspacePr);
            if (await this.sessionMatches(existing, sourceMetadata, state)) {
                return { metadata, session: await this.sessions.fork(existing.session, metadata), created: true };
            }
        }
        const session = existing && await this.sessionMatches(existing, metadata, state)
            ? existing.session
            : await this.sessions.create(metadata);
        return { metadata, session, created: !existing || session !== existing.session };
    }

    private async prepareActivationBranch(
        state: WorkspaceState,
        branch: string,
        pr: PullRequest | undefined,
        existing: WorkspaceRecord | undefined,
        parallel: boolean,
        detail: PullRequestDetails | undefined,
        trustedPullRequest: boolean,
        rollback: Rollback,
    ): Promise<{ result: Activation; rollback: Rollback }> {
        const primary = rollback.primary;
        if (!primary) throw new WorkspaceError("Git did not report a primary checkout");
        const current = (await this.git.paths()).currentCwd;
        const worktree = await this.git.findWorktree(branch);
        let cwd: string;
        let needsPrCheckout = detail !== undefined && !trustedPullRequest;
        let createdSession = false;

        if (worktree?.cwd && await this.git.isManagedWorktree(worktree.cwd)) {
            if (!existing || !await samePath(existing.cwd, worktree.cwd)) {
                if (!detail || !existing) {
                    throw new WorkspaceError(`Branch ${branch} is already checked out in another worktree`);
                }
            }
            cwd = worktree.cwd;
            if (trustedPullRequest) needsPrCheckout = false;
        } else if (worktree?.cwd === primary) {
            if (parallel) {
                if (branch === "main") throw new WorkspaceError("The main workspace cannot be promoted to a worktree");
                if (detail && !trustedPullRequest) await this.checkoutPullRequest(detail, primary);
                return this.promotePrimary(state, branch, pr, existing, rollback);
            }
            cwd = primary;
            if (trustedPullRequest && existing && await samePath(existing.cwd, cwd)) needsPrCheckout = false;
        } else if (worktree?.cwd) {
            if (existing && await samePath(existing.cwd, worktree.cwd)) {
                cwd = worktree.cwd;
                if (trustedPullRequest) needsPrCheckout = false;
            } else if (worktree.cwd === current) {
                cwd = worktree.cwd;
            } else {
                throw new WorkspaceError(`Branch ${branch} is already checked out in another worktree`);
            }
        } else if (parallel) {
            if (detail && !trustedPullRequest) {
                cwd = await this.createManagedWorktree(state, branch, rollback, await this.git.assertRef("HEAD"), true);
            } else {
                await this.git.assertLocalBranch(branch);
                cwd = await this.createManagedWorktree(state, branch, rollback);
            }
        } else {
            if (!detail || trustedPullRequest) {
                await this.git.assertLocalBranch(branch);
                await this.git.checkout(branch, primary);
            }
            cwd = primary;
        }

        if (detail && needsPrCheckout) await this.checkoutPullRequest(detail, cwd);
        const resolvedSession = await this.sessionForWorkspace(state, branch, cwd, pr, existing);
        const { metadata, session } = resolvedSession;
        createdSession = resolvedSession.created;
        if (createdSession) rollback.createdSession = session;
        const record: WorkspaceRecord = {
            version: 2,
            repository: state.commonDir,
            branch,
            session,
            cwd: await canonicalPath(cwd),
            ...(metadata.pr ? { pr: metadata.pr, prUrl: metadata.pr.url } : {}),
            updatedAt: now(),
        };
        rollback.record = record;
        rollback.config = await state.snapshot([
            state.sessionKey(branch),
            state.prKey(branch),
            state.lastKey,
        ]);
        await state.putWorkspace(record);
        await state.putLast(record);
        return {
            result: {
                record,
                createdSession,
                ...(rollback.createdWorktree ? { createdWorktree: rollback.createdWorktree } : {}),
                ...(rollback.previousPrimaryBranch !== branch ? { previousPrimaryBranch: rollback.previousPrimaryBranch } : {}),
            },
            rollback,
        };
    }

    private async promotePrimary(
        state: WorkspaceState,
        branch: string,
        pr: PullRequest | undefined,
        existing: WorkspaceRecord | undefined,
        rollback: Rollback,
    ): Promise<{ result: Activation; rollback: Rollback }> {
        const primary = rollback.primary;
        if (!primary) throw new WorkspaceError("Git did not report a primary checkout");
        await this.git.assertLocalBranch("main");
        await this.git.assertClean(primary);
        await this.git.checkout("main", primary);
        const cwd = await this.createManagedWorktree(state, branch, rollback);
        const resolvedSession = await this.sessionForWorkspace(state, branch, cwd, pr, existing);
        const { metadata, session } = resolvedSession;
        if (!resolvedSession.created) throw new WorkspaceError("Could not relocate the workspace session");
        rollback.createdSession = session;
        const record: WorkspaceRecord = {
            version: 2,
            repository: state.commonDir,
            branch,
            session,
            cwd,
            ...(metadata.pr ? { pr: metadata.pr, prUrl: metadata.pr.url } : {}),
            updatedAt: now(),
        };
        rollback.record = record;
        rollback.config = await state.snapshot([
            state.sessionKey(branch),
            state.prKey(branch),
            state.lastKey,
        ]);
        await state.putWorkspace(record);
        await state.putLast(record);
        return {
            result: {
                record,
                createdSession: true,
                createdWorktree: cwd,
                previousPrimaryBranch: branch,
            },
            rollback,
        };
    }

    private async createManagedWorktree(
        state: WorkspaceState,
        branch: string,
        rollback: Rollback,
        from?: string,
        detached = false,
    ): Promise<string> {
        const workspace = state.workspacePath(branch);
        if (await pathExists(workspace)) throw new WorkspaceError("Managed workspace path already exists and is not reusable");
        await this.git.excludeWorkspaceRoot(state.commonDir);
        const path = state.worktreePath(branch);
        if (detached) {
            if (!from) throw new WorkspaceError("Managed detached worktree requires a ref");
            await this.git.addDetachedWorktree(path, from);
        } else {
            await this.git.addWorktree(path, branch, from);
        }
        const cwd = await canonicalPath(path);
        rollback.createdWorktree = cwd;
        rollback.createdWorkspace = workspace;
        await this.git.initializeWorkspacePm(state.workspacePmPath(branch));
        return cwd;
    }

    private async createRecord(
        state: WorkspaceState,
        branch: string,
        cwd: string,
        pr: PullRequest | undefined,
        baseBranch?: string,
        baseOid?: string,
    ): Promise<WorkspaceRecord> {
        const canonicalCwd = await canonicalPath(cwd);
        const session = await this.sessions.create(workspaceMetadata(state.commonDir, branch, canonicalCwd, pr));
        return {
            version: 2,
            repository: state.commonDir,
            branch,
            ...(baseBranch ? { baseBranch } : {}),
            ...(baseOid ? { baseOid } : {}),
            session,
            cwd: canonicalCwd,
            ...(pr ? { pr, prUrl: pr.url } : {}),
            updatedAt: now(),
        };
    }

    private async rollback(state: WorkspaceState, rollback: Rollback): Promise<void> {
        if (rollback.config) {
            try {
                await state.restore(rollback.config);
            } catch {
                // Preserve the original failure. The remaining state is safe to repair.
            }
        }
        if (rollback.branchMutation) {
            try {
                const mutation = rollback.branchMutation;
                if (await this.git.localBranchOid(mutation.branch) === mutation.newOid) {
                    const worktree = await this.git.findWorktree(mutation.branch);
                    if (worktree) {
                        await this.git.assertClean(worktree.cwd);
                        await this.git.resetHard(worktree.cwd, mutation.oldOid);
                    } else {
                        await this.git.updateBranch(mutation.branch, mutation.oldOid, mutation.newOid);
                    }
                }
            } catch {
                // Keep the recovery ref when branch rollback is not safe.
            }
        }
        let removedWorktree = !rollback.createdWorktree;
        if (rollback.createdWorktree) {
            try {
                await this.git.removeWorktree(rollback.createdWorktree);
                removedWorktree = true;
            } catch {
                // A non-clean worktree is retained for manual inspection.
            }
        }
        if (rollback.createdWorkspace && removedWorktree) {
            try {
                await rm(rollback.createdWorkspace, { recursive: true, force: true });
            } catch {
                // A failed workspace cleanup does not make the operation unsafe.
            }
        }
        if (rollback.primary && rollback.previousPrimaryBranch) {
            try {
                if (await this.git.branch(rollback.primary) !== rollback.previousPrimaryBranch) {
                    await this.git.checkout(rollback.previousPrimaryBranch, rollback.primary);
                }
            } catch {
                // Do not force a checkout during rollback.
            }
        }
        if (rollback.createdBranch) {
            try {
                await this.git.deleteBranch(rollback.createdBranch);
            } catch {
                // A branch that is not safely deletable is retained.
            }
        }
        if (rollback.createdSession) {
            try {
                await rm(rollback.createdSession, { force: true });
            } catch {
                // The session contains no new user work before a failed switch.
            }
        }
    }
}
