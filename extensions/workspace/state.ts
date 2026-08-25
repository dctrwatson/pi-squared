import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GitRepository } from "./git.ts";
import { WorkspaceError } from "./process.ts";
import { readWorkspaceSession } from "./sessions.ts";
import type { LeaseRecord, WorkspaceRecord } from "./types.ts";

const CONFIG_PREFIX = "pi-workspace";
const MUTATION_LOCK_REF = "refs/pi-workspace/mutation-lock";

interface MutationLockOwner {
    version: 1;
    pid: number;
    hostname: string;
    token: string;
    startedAt: string;
}

function now(): string {
    return new Date().toISOString();
}

export function stableHash(value: string, length = 12): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function processIsLive(pid: number, ownerHost: string): boolean {
    if (ownerHost !== hostname() || !Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
}

function sameUrl(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export class WorkspaceState {
    readonly git: GitRepository;
    readonly commonDir: string;
    readonly primaryCwd: string;

    constructor(git: GitRepository, commonDir: string, primaryCwd: string) {
        this.git = git;
        this.commonDir = commonDir;
        this.primaryCwd = primaryCwd;
    }

    get root(): string {
        return join(this.primaryCwd, ".ws");
    }

    get stateRoot(): string {
        return join(this.commonDir, "pi-workspaces", ".state");
    }

    get leasesRoot(): string {
        return join(this.stateRoot, "leases");
    }

    get mutationLockRef(): string {
        return MUTATION_LOCK_REF;
    }

    workspacePath(branch: string): string {
        return join(this.root, stableHash(branch));
    }

    worktreePath(branch: string): string {
        return join(this.workspacePath(branch), "src");
    }

    workspacePmPath(branch: string): string {
        return join(this.workspacePath(branch), "pm");
    }

    sessionKey(branch: string): string {
        return `branch.${branch}.pi-workspace-session`;
    }

    prKey(branch: string): string {
        return `branch.${branch}.pi-workspace-pr`;
    }

    get lastKey(): string {
        return `${CONFIG_PREFIX}.last`;
    }

    async getConfig(key: string): Promise<string | undefined> {
        const result = await this.git.tryRun(["config", "--local", "--get", key]);
        return result.ok ? result.stdout.trim() : undefined;
    }

    async setConfig(key: string, value: string): Promise<void> {
        await this.git.run(["config", "--local", key, value]);
    }

    async unsetConfig(key: string): Promise<void> {
        const result = await this.git.tryRun(["config", "--local", "--unset-all", key]);
        if (!result.ok && result.stderr.trim() && !/no such section|no such key/i.test(result.stderr)) {
            throw new WorkspaceError(`Could not clear workspace state: ${result.stderr.trim()}`);
        }
    }

    async getWorkspace(branch: string): Promise<WorkspaceRecord | undefined> {
        const session = await this.getConfig(this.sessionKey(branch));
        if (!session) return undefined;
        const stored = await readWorkspaceSession(session);
        const prUrl = await this.getConfig(this.prKey(branch));
        const metadata = stored?.metadata;
        const pr = metadata?.pr && prUrl && sameUrl(metadata.pr.url, prUrl) ? metadata.pr : undefined;
        return {
            version: 2,
            repository: metadata?.repository ?? this.commonDir,
            branch,
            session,
            cwd: metadata?.cwd ?? stored?.header.cwd ?? this.commonDir,
            ...(pr ? { pr } : {}),
            ...(prUrl ? { prUrl } : {}),
            updatedAt: now(),
        };
    }

    async listWorkspaces(): Promise<WorkspaceRecord[]> {
        const result = await this.git.tryRun(["config", "--local", "--get-regexp", "^branch\\..*\\.pi-workspace-session$"]);
        if (!result.ok) return [];
        const records: WorkspaceRecord[] = [];
        for (const line of result.stdout.split("\n")) {
            const separator = line.indexOf("\t") === -1 ? line.indexOf(" ") : line.indexOf("\t");
            if (separator === -1) continue;
            const key = line.slice(0, separator);
            const prefix = "branch.";
            const suffix = ".pi-workspace-session";
            if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
            const branch = key.slice(prefix.length, -suffix.length);
            if (!branch) continue;
            const record = await this.getWorkspace(branch);
            if (record) records.push(record);
        }
        return records;
    }

    async putWorkspace(record: WorkspaceRecord): Promise<void> {
        const current: WorkspaceRecord = { ...record, version: 2 };
        await this.setConfig(this.sessionKey(current.branch), current.session);
        const prUrl = current.pr?.url ?? current.prUrl;
        if (prUrl) await this.setConfig(this.prKey(current.branch), prUrl);
        else await this.unsetConfig(this.prKey(current.branch));
    }

    async putLast(record: WorkspaceRecord): Promise<void> {
        await this.setConfig(this.lastKey, record.branch);
    }

    async removeWorkspace(branch: string): Promise<void> {
        await this.unsetConfig(this.sessionKey(branch));
        await this.unsetConfig(this.prKey(branch));
        if (await this.getLast() === branch) await this.unsetConfig(this.lastKey);
    }

    async getLast(): Promise<string | undefined> {
        return this.getConfig(this.lastKey);
    }

    async snapshot(keys: string[]): Promise<Map<string, string | undefined>> {
        const snapshot = new Map<string, string | undefined>();
        for (const key of keys) snapshot.set(key, await this.getConfig(key));
        return snapshot;
    }

    async restore(snapshot: ReadonlyMap<string, string | undefined>): Promise<void> {
        for (const [key, value] of snapshot) {
            if (value === undefined) await this.unsetConfig(key);
            else await this.setConfig(key, value);
        }
    }

    leasePath(session: string): string {
        return join(this.leasesRoot, `${stableHash(session, 32)}.json`);
    }

    async readLease(session: string): Promise<LeaseRecord | undefined> {
        try {
            return JSON.parse(await readFile(this.leasePath(session), "utf8")) as LeaseRecord;
        } catch {
            return undefined;
        }
    }

    async processIsLive(lease: LeaseRecord): Promise<boolean> {
        return processIsLive(lease.pid, lease.hostname);
    }

    async removeKnownStaleLease(session: string): Promise<boolean> {
        const lease = await this.readLease(session);
        if (!lease || await this.processIsLive(lease)) return false;
        try {
            await unlink(this.leasePath(session));
            return true;
        } catch {
            return false;
        }
    }

    private async acquireLeaseUnsafe(record: WorkspaceRecord, ownerPid: number): Promise<LeaseRecord> {
        if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new WorkspaceError("Workspace lease owner is invalid");
        await mkdir(this.leasesRoot, { recursive: true });
        const path = this.leasePath(record.session);
        const existing = await this.readLease(record.session);
        if (existing) {
            if (existing.pid === ownerPid && existing.hostname === hostname() && existing.session === record.session) {
                const refreshed: LeaseRecord = { ...existing, repository: record.repository, branch: record.branch, updatedAt: now() };
                await writeFile(path, JSON.stringify(refreshed), { mode: 0o600 });
                return refreshed;
            }
            if (await this.processIsLive(existing)) {
                throw new WorkspaceError(`Workspace ${record.branch} is active in another Pi session`);
            }
            if (!await this.removeKnownStaleLease(record.session)) {
                throw new WorkspaceError(`Could not repair stale workspace lease for ${record.branch}`);
            }
        }
        const lease: LeaseRecord = {
            version: 1,
            repository: record.repository,
            branch: record.branch,
            session: record.session,
            pid: ownerPid,
            hostname: hostname(),
            startedAt: now(),
            updatedAt: now(),
        };
        try {
            const handle = await open(path, "wx", 0o600);
            await handle.writeFile(JSON.stringify(lease));
            await handle.close();
            return lease;
        } catch {
            const concurrent = await this.readLease(record.session);
            if (concurrent) throw new WorkspaceError(`Workspace ${record.branch} is active in another Pi session`);
            throw new WorkspaceError(`Could not acquire workspace lease for ${record.branch}`);
        }
    }

    async acquireLease(record: WorkspaceRecord, ownerPid = process.pid): Promise<LeaseRecord> {
        return this.withMutationLock(() => this.acquireLeaseUnsafe(record, ownerPid));
    }

    async acquireLeaseLocked(record: WorkspaceRecord, ownerPid = process.pid): Promise<LeaseRecord> {
        return this.acquireLeaseUnsafe(record, ownerPid);
    }

    async releaseLease(record: Pick<WorkspaceRecord, "branch" | "session">, ownerPid = process.pid): Promise<void> {
        const lease = await this.readLease(record.session);
        if (!lease || lease.pid !== ownerPid || lease.hostname !== hostname() || lease.session !== record.session) return;
        try {
            await unlink(this.leasePath(record.session));
        } catch {
            // Another process can repair a known stale lease.
        }
    }

    private mutationLockOwner(value: string | undefined): MutationLockOwner | undefined {
        try {
            const owner = value ? JSON.parse(value) as Partial<MutationLockOwner> : undefined;
            if (!owner || owner.version !== 1 || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
                || typeof owner.hostname !== "string" || !owner.hostname || typeof owner.token !== "string" || !owner.token
                || typeof owner.startedAt !== "string") return undefined;
            return owner as MutationLockOwner;
        } catch {
            return undefined;
        }
    }

    private async acquireProcessMutationLock(): Promise<() => Promise<void>> {
        const owner: MutationLockOwner = {
            version: 1,
            pid: process.pid,
            hostname: hostname(),
            token: randomUUID(),
            startedAt: now(),
        };
        const ownerOid = await this.git.writeBlob(JSON.stringify(owner));
        const zeroOid = "0".repeat(ownerOid.length);
        for (let attempt = 0; attempt < 4; attempt++) {
            if (await this.git.updateRef(this.mutationLockRef, ownerOid, zeroOid)) {
                return async () => {
                    await this.git.updateRef(this.mutationLockRef, undefined, ownerOid);
                };
            }
            const currentOid = await this.git.refOid(this.mutationLockRef);
            if (!currentOid) continue;
            const currentOwner = this.mutationLockOwner(await this.git.readBlob(currentOid));
            if (!currentOwner || processIsLive(currentOwner.pid, currentOwner.hostname)) {
                throw new WorkspaceError("Another workspace operation is in progress");
            }
            await this.git.updateRef(this.mutationLockRef, undefined, currentOid);
        }
        throw new WorkspaceError("Another workspace operation is in progress");
    }

    async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
        const release = await this.acquireProcessMutationLock();
        try {
            return await operation();
        } finally {
            await release();
        }
    }

    async sessionRecency(session: string): Promise<number | undefined> {
        try {
            return (await stat(session)).mtimeMs;
        } catch {
            return undefined;
        }
    }
}
