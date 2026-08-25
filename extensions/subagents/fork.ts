import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
        throw new Error("Cannot safely fork without a parent user request; use fresh context");
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
    if (!header) throw new Error("Cannot safely fork a parent session without a header; use fresh context");
    const entries = selectForkSnapshotEntries(sessionManager.getBranch());
    fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    const snapshotPath = path.join(snapshotDirectory, `${Date.now()}_${randomUUID()}.jsonl`);
    const content = [snapshotHeader(header, parentSessionFile), ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
    fs.writeFileSync(snapshotPath, `${content}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

    return {
        mode: "fork",
        parentSessionFile: snapshotPath,
        inheritedEntryIds: entries.map((entry) => entry.id),
    };
}
