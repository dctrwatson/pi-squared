import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "./git.ts";
import { WorkspaceError } from "./process.ts";
import type { PullRequest, WorkspaceMetadata } from "./types.ts";

export const WORKSPACE_SESSION_TYPE = "pi-workspace";
export const WORKSPACE_SESSION_NAME_TYPE = "pi-workspace-session-name";

export interface SessionHeader {
    type: "session";
    version?: number;
    id: string;
    timestamp: string;
    cwd: string;
}

interface ParsedWorkspaceMetadata {
    repository?: unknown;
    branch?: unknown;
    cwd?: unknown;
    pr?: {
        number?: unknown;
        url?: unknown;
        baseRepository?: unknown;
        headRepository?: unknown;
        headRef?: unknown;
        headOid?: unknown;
    };
}

export interface SessionStore {
    create(metadata: WorkspaceMetadata): Promise<string>;
    fork(source: string, metadata: WorkspaceMetadata): Promise<string>;
    bind(session: string, metadata: WorkspaceMetadata): Promise<boolean>;
    rebind?(session: string, metadata: WorkspaceMetadata): Promise<boolean>;
    validate(session: string, metadata: WorkspaceMetadata): Promise<boolean>;
}

async function writeHeader(path: string, header: SessionHeader | null): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const content = header ?? {
        type: "session" as const,
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
    };
    await writeFile(path, `${JSON.stringify(content)}\n`, { flag: "wx" });
}

async function ensurePersisted(manager: SessionManager): Promise<string> {
    const session = manager.getSessionFile();
    if (!session) throw new WorkspaceError("Pi session storage is disabled");
    try {
        await writeHeader(session, manager.getHeader());
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return session;
}

function toPullRequest(value: ParsedWorkspaceMetadata["pr"]): PullRequest | undefined {
    if (!value || typeof value.number !== "number" || typeof value.url !== "string"
        || typeof value.baseRepository !== "string" || typeof value.headRepository !== "string"
        || typeof value.headRef !== "string") return undefined;
    return {
        number: value.number,
        url: value.url,
        baseRepository: value.baseRepository,
        headRepository: value.headRepository,
        headRef: value.headRef,
        ...(typeof value.headOid === "string" ? { headOid: value.headOid } : {}),
    };
}

function toMetadata(value: ParsedWorkspaceMetadata): WorkspaceMetadata | undefined {
    if (typeof value.repository !== "string" || typeof value.branch !== "string" || typeof value.cwd !== "string") return undefined;
    if (value.pr !== undefined && !toPullRequest(value.pr)) return undefined;
    const pr = toPullRequest(value.pr);
    return { repository: value.repository, branch: value.branch, cwd: value.cwd, ...(pr ? { pr } : {}) };
}

function sameRepository(left: string, right: string): boolean {
    return left.toLowerCase() === right.toLowerCase();
}

export function samePullRequest(left: PullRequest | undefined, right: PullRequest | undefined): boolean {
    if (!left || !right) return left === right;
    return left.number === right.number
        && left.url.toLowerCase() === right.url.toLowerCase()
        && sameRepository(left.baseRepository, right.baseRepository)
        && sameRepository(left.headRepository, right.headRepository)
        && left.headRef === right.headRef;
}

export async function workspaceMetadataMatches(left: WorkspaceMetadata, right: WorkspaceMetadata): Promise<boolean> {
    return await canonicalPath(left.repository) === await canonicalPath(right.repository)
        && left.branch === right.branch
        && await canonicalPath(left.cwd) === await canonicalPath(right.cwd)
        && samePullRequest(left.pr, right.pr);
}

export async function readWorkspaceSession(session: string): Promise<{ header: SessionHeader; metadata?: WorkspaceMetadata } | undefined> {
    try {
        const content = await readFile(session, "utf8");
        const entries = content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
            type?: string;
            cwd?: unknown;
            customType?: unknown;
            data?: ParsedWorkspaceMetadata;
        });
        const header = entries[0];
        if (header?.type !== "session" || typeof header.cwd !== "string") return undefined;
        const metadata = entries
            .filter((entry) => entry.type === "custom" && entry.customType === WORKSPACE_SESSION_TYPE)
            .map((entry) => toMetadata(entry.data ?? {}))
            .filter((entry): entry is WorkspaceMetadata => entry !== undefined)
            .at(-1);
        return { header: header as SessionHeader, ...(metadata ? { metadata } : {}) };
    } catch {
        return undefined;
    }
}

export function sessionHasAutomaticWorkspaceName(entries: ReadonlyArray<{ type: string; customType?: unknown; data?: unknown; name?: unknown }>, name: string | undefined): boolean {
    if (!name) return false;
    let nameIndex = -1;
    let markerIndex = -1;
    for (const [index, entry] of entries.entries()) {
        if (entry.type === "session_info") nameIndex = index;
        if (entry.type === "custom" && entry.customType === WORKSPACE_SESSION_NAME_TYPE
            && entry.data && typeof entry.data === "object" && (entry.data as { branch?: unknown }).branch === name) {
            markerIndex = index;
        }
    }
    return markerIndex > nameIndex;
}

function setDefaultSessionName(manager: SessionManager, branch: string): void {
    const name = manager.getSessionName();
    if (name && !sessionHasAutomaticWorkspaceName(manager.getEntries(), name)) return;
    manager.appendSessionInfo(branch);
    manager.appendCustomEntry(WORKSPACE_SESSION_NAME_TYPE, { branch });
}

export class PiSessionStore implements SessionStore {
    readonly sessionDir: string | undefined;

    constructor(sessionDir?: string) {
        this.sessionDir = sessionDir;
    }

    async create(metadata: WorkspaceMetadata): Promise<string> {
        const manager = SessionManager.create(metadata.cwd, this.sessionDir);
        const path = await ensurePersisted(manager);
        const persisted = SessionManager.open(path);
        setDefaultSessionName(persisted, metadata.branch);
        persisted.appendCustomEntry(WORKSPACE_SESSION_TYPE, metadata);
        if (!await this.validate(path, metadata)) throw new WorkspaceError("Could not bind workspace metadata to the new Pi session");
        return path;
    }

    async fork(source: string, metadata: WorkspaceMetadata): Promise<string> {
        const manager = SessionManager.forkFrom(source, metadata.cwd, this.sessionDir);
        const path = await ensurePersisted(manager);
        const persisted = SessionManager.open(path);
        setDefaultSessionName(persisted, metadata.branch);
        persisted.appendCustomEntry(WORKSPACE_SESSION_TYPE, metadata);
        if (!await this.validate(path, metadata)) throw new WorkspaceError("Could not bind workspace metadata to the forked Pi session");
        return path;
    }

    async bind(session: string, expected: WorkspaceMetadata): Promise<boolean> {
        const current = await readWorkspaceSession(session);
        if (!current || await canonicalPath(current.header.cwd) !== await canonicalPath(expected.cwd)) return false;
        if (current.metadata) {
            if (!await workspaceMetadataMatches(current.metadata, expected)) return false;
            try {
                setDefaultSessionName(SessionManager.open(session), expected.branch);
            } catch {
                return false;
            }
            return true;
        }
        try {
            const manager = SessionManager.open(session);
            setDefaultSessionName(manager, expected.branch);
            manager.appendCustomEntry(WORKSPACE_SESSION_TYPE, expected);
        } catch {
            return false;
        }
        return this.validate(session, expected);
    }

    async rebind(session: string, expected: WorkspaceMetadata): Promise<boolean> {
        const current = await readWorkspaceSession(session);
        if (!current?.metadata || await canonicalPath(current.header.cwd) !== await canonicalPath(expected.cwd)) return false;
        if (await canonicalPath(current.metadata.repository) !== await canonicalPath(expected.repository)
            || await canonicalPath(current.metadata.cwd) !== await canonicalPath(expected.cwd)
            || !samePullRequest(current.metadata.pr, expected.pr)) return false;
        try {
            SessionManager.open(session).appendCustomEntry(WORKSPACE_SESSION_TYPE, expected);
        } catch {
            return false;
        }
        return this.validate(session, expected);
    }

    async validate(session: string, expected: WorkspaceMetadata): Promise<boolean> {
        const current = await readWorkspaceSession(session);
        if (!current?.metadata) return false;
        if (await canonicalPath(current.header.cwd) !== await canonicalPath(expected.cwd)) return false;
        return workspaceMetadataMatches(current.metadata, expected);
    }
}

export function workspaceMetadata(repository: string, branch: string, cwd: string, pr?: PullRequest): WorkspaceMetadata {
    return {
        repository: resolve(repository),
        branch,
        cwd: resolve(cwd),
        ...(pr ? { pr } : {}),
    };
}
