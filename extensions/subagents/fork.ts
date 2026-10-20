import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

interface ForkableParentSession {
    getSessionFile(): string | undefined;
    getHeader(): SessionHeader | null;
    getBranch(): SessionEntry[];
}

export interface ParentForkSnapshot {
    mode: "fork";
    parentSessionFile: string;
    inheritedEntryIds: string[];
}

export interface FreshForkFallback {
    mode: "fresh";
    fallback: "parent-session-not-persisted";
}

export type ModelForkContext = ParentForkSnapshot | FreshForkFallback;

const MAX_FORK_HEADER_INSPECTION_BYTES = 1024 * 1024;
export type ForkSourceFailureCategory = "unavailable" | "stale" | "unreadable" | "over_limit";

const FORK_SOURCE_RECOVERY: Record<ForkSourceFailureCategory, string> = {
    unavailable: 'Restore or save the parent session, or retry with mode "fresh" and concise context.',
    stale: 'Create a new fork from the current parent state, or retry with mode "fresh".',
    unreadable: 'Check that the source session is readable and valid and the snapshot directory is writable, or retry with mode "fresh".',
    over_limit: 'Reduce the source to fit the host loader\'s existing limit, or retry with mode "fresh".',
};

/** Cross-realm host error fields; host code need not import the runtime error class. */
export interface ForkSourceValidationFailureProtocol {
    readonly name: "ForkSourceValidationError";
    readonly category: ForkSourceFailureCategory;
    readonly recoveryAction: string;
    readonly message: string;
}

const MAX_FORK_FAILURE_MESSAGE_BYTES = 2_048;
const MAX_FORK_RECOVERY_ACTION_BYTES = 512;

function hasUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) return true;
    }
    return false;
}

function isBoundedProtocolText(value: unknown, maxBytes: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxBytes
        && Buffer.byteLength(value, "utf8") <= maxBytes
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
        && !hasUnpairedSurrogate(value);
}

/** Classify shared errors across module realms or from a plain host error object. */
export function getForkSourceFailureDetails(value: unknown): ForkSourceValidationFailureProtocol | undefined {
    try {
        if (typeof value !== "object" || value === null) return undefined;
        const candidate = value as Record<string, unknown>;
        if (candidate.name !== "ForkSourceValidationError" || typeof candidate.category !== "string"
            || !Object.hasOwn(FORK_SOURCE_RECOVERY, candidate.category)) return undefined;
        if (!isBoundedProtocolText(candidate.message, MAX_FORK_FAILURE_MESSAGE_BYTES)
            || !isBoundedProtocolText(candidate.recoveryAction, MAX_FORK_RECOVERY_ACTION_BYTES)) return undefined;
        return {
            name: "ForkSourceValidationError",
            category: candidate.category as ForkSourceFailureCategory,
            recoveryAction: candidate.recoveryAction,
            message: candidate.message,
        };
    } catch {
        return undefined;
    }
}

export class ForkSourceValidationError extends Error implements ForkSourceValidationFailureProtocol {
    readonly name = "ForkSourceValidationError";
    readonly category: ForkSourceFailureCategory;
    readonly recoveryAction: string;

    constructor(category: ForkSourceFailureCategory, reason: string) {
        const recoveryAction = FORK_SOURCE_RECOVERY[category];
        super(`Fork source ${category.replaceAll("_", " ")}: ${reason}. ${recoveryAction} No child was launched.`);
        this.category = category;
        this.recoveryAction = recoveryAction;
    }
}

function ioFailureCategory(error: unknown): ForkSourceFailureCategory {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "unavailable" : "unreadable";
}

/** Check a stable source and its bounded session-header prefix before child startup. */
export function validateForkSourceFile(filePath: string): { bytes: number } {
    type BigIntFileStat = { size: bigint; dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint; isFile(): boolean };
    let before: BigIntFileStat;
    try {
        before = fs.lstatSync(filePath, { bigint: true }) as unknown as BigIntFileStat;
    } catch (error) {
        throw new ForkSourceValidationError(ioFailureCategory(error), "the session file is not available");
    }
    if (!before.isFile()) throw new ForkSourceValidationError("unreadable", "the source is not a regular file");

    let fileDescriptor: number;
    try {
        fileDescriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        throw new ForkSourceValidationError(ioFailureCategory(error), "the session file cannot be opened");
    }
    const inspectedBytes = Number(before.size < BigInt(MAX_FORK_HEADER_INSPECTION_BYTES)
        ? before.size
        : BigInt(MAX_FORK_HEADER_INSPECTION_BYTES));
    const content = Buffer.alloc(inspectedBytes);
    try {
        const openedBefore = fs.fstatSync(fileDescriptor, { bigint: true }) as unknown as BigIntFileStat;
        if (!openedBefore.isFile()) throw new ForkSourceValidationError("unreadable", "the source is not a regular file");
        if (openedBefore.dev !== before.dev || openedBefore.ino !== before.ino || openedBefore.size !== before.size
            || openedBefore.mtimeNs !== before.mtimeNs || openedBefore.ctimeNs !== before.ctimeNs) {
            throw new ForkSourceValidationError("stale", "the session file changed before it could be read");
        }
        let offset = 0;
        while (offset < content.length) {
            let count: number;
            try {
                count = fs.readSync(fileDescriptor, content, offset, content.length - offset, offset);
            } catch {
                throw new ForkSourceValidationError("unreadable", "the session file cannot be read");
            }
            if (count === 0) throw new ForkSourceValidationError("stale", "the session file changed during validation");
            offset += count;
        }
        const openedAfter = fs.fstatSync(fileDescriptor, { bigint: true }) as unknown as BigIntFileStat;
        let after: BigIntFileStat;
        try {
            after = fs.lstatSync(filePath, { bigint: true }) as unknown as BigIntFileStat;
        } catch {
            throw new ForkSourceValidationError("stale", "the session file disappeared during validation");
        }
        if (openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino || openedBefore.size !== openedAfter.size
            || openedBefore.mtimeNs !== openedAfter.mtimeNs || openedBefore.ctimeNs !== openedAfter.ctimeNs
            || after.dev !== openedAfter.dev || after.ino !== openedAfter.ino || after.size !== openedAfter.size
            || after.mtimeNs !== openedAfter.mtimeNs || after.ctimeNs !== openedAfter.ctimeNs || offset !== inspectedBytes) {
            throw new ForkSourceValidationError("stale", "the session file changed during validation");
        }
    } catch (error) {
        if (error instanceof ForkSourceValidationError) throw error;
        throw new ForkSourceValidationError("unreadable", "the session file could not be validated");
    } finally {
        fs.closeSync(fileDescriptor);
    }

    const inspectedToEof = BigInt(inspectedBytes) === before.size;
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(content);
    if (inspectedToEof) text += decoder.end();
    let headerFound = false;
    let lineStart = 0;
    while (lineStart <= text.length) {
        const newline = text.indexOf("\n", lineStart);
        if (newline < 0 && !inspectedToEof) break;
        const lineEnd = newline < 0 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if (line.trim()) {
            let entry: unknown;
            try {
                entry = JSON.parse(line);
            } catch {
                entry = undefined;
            }
            // Pi's session loader skips malformed and falsy JSONL entries.
            if (entry) {
                if (typeof entry !== "object" || Array.isArray(entry)) {
                    throw new ForkSourceValidationError("unreadable", "the session file has no valid session header");
                }
                const header = entry as Record<string, unknown>;
                if (header.type !== "session" || typeof header.id !== "string") {
                    throw new ForkSourceValidationError("unreadable", "the session file has no valid session header");
                }
                headerFound = true;
                break;
            }
        }
        if (newline < 0) break;
        lineStart = newline + 1;
    }
    if (!headerFound && inspectedToEof) throw new ForkSourceValidationError("unreadable", "the session file has no session header");
    // A larger source with no header in this prefix is left to Pi's authoritative loader.
    return { bytes: Number(before.size) };
}

/** Select the active parent history through the newest user request. */
export function selectForkSnapshotEntries(branch: readonly SessionEntry[]): SessionEntry[] {
    let latestUserIndex = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry?.type === "message" && entry.message.role === "user") {
            latestUserIndex = index;
            break;
        }
    }
    if (latestUserIndex < 0) {
        throw new ForkSourceValidationError("unavailable", "the parent branch has no user request to inherit");
    }
    // An edit after the cut could change earlier context. Do not copy stale source content.
    if (branch.slice(latestUserIndex + 1).some((entry) => entry.type === "context_edit")) {
        throw new ForkSourceValidationError("stale", "the parent branch changed after its latest user request");
    }
    return branch.slice(0, latestUserIndex + 1);
}

function snapshotHeader(header: SessionHeader, parentSessionFile: string): SessionHeader {
    return {
        type: "session",
        version: header.version ?? 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: header.cwd,
        parentSession: parentSessionFile,
    };
}

/**
 * Copy only complete parent context into an immutable fork source. The parent
 * session manager remains unchanged while the parent tool call is active.
 */
export function createActiveTurnForkSnapshot(
    sessionManager: ForkableParentSession,
    snapshotDirectory: string,
): ModelForkContext {
    const parentSessionFile = sessionManager.getSessionFile();
    if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
        return { mode: "fresh", fallback: "parent-session-not-persisted" };
    }

    const header = sessionManager.getHeader();
    if (!header) throw new ForkSourceValidationError("unreadable", "the persisted parent session has no readable header");
    const entries = selectForkSnapshotEntries(sessionManager.getBranch());
    const snapshotDirectoryPath = snapshotDirectory;
    const snapshotPath = path.join(snapshotDirectoryPath, `${Date.now()}_${randomUUID()}.jsonl`);
    let content: string;
    try {
        content = `${[snapshotHeader(header, parentSessionFile), ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    } catch {
        throw new ForkSourceValidationError("unreadable", "the selected parent branch cannot be serialized as JSONL");
    }
    try {
        fs.mkdirSync(snapshotDirectoryPath, { recursive: true, mode: 0o700 });
        fs.writeFileSync(snapshotPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
        throw new ForkSourceValidationError(ioFailureCategory(error), "the active-turn snapshot could not be written");
    }
    try {
        validateForkSourceFile(snapshotPath);
    } catch (error) {
        fs.rmSync(snapshotPath, { force: true });
        throw error;
    }

    return {
        mode: "fork",
        parentSessionFile: snapshotPath,
        inheritedEntryIds: entries.map((entry) => entry.id),
    };
}
