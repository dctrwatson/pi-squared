import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const SCAN_CHUNK_BYTES = 64 * 1024;
// A per-entry bound, not a session-lifetime cap: total history remains uncapped.
const MAX_PARSED_LINE_BYTES = 16 * 1024 * 1024;
const IDENTITY_CUSTOM_TYPE = "hari-manager-identity";

export type HariManagerSessionIdentity = {
  coordinationDir: string;
  projectId: string;
  managerId: string;
};

export type SessionIdentityInspection = {
  identity?: HariManagerSessionIdentity;
  /** A public pi-squared create_workspace/piw-new placeholder with no conversation or other role state. */
  pristineWorkspace?: true;
  uncertain?: string;
};

type JsonRecord = Record<string, unknown>;

type PristineWorkspaceState = {
  next: 0 | 1 | 2 | 3 | 4;
  cwd?: string;
  name?: string;
  branch?: string;
  disqualified: boolean;
};

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): HariManagerSessionIdentity | undefined {
  if (!record(value) || value.type !== "custom" || value.customType !== IDENTITY_CUSTOM_TYPE || !record(value.data)) return undefined;
  const data = value.data;
  if (typeof data.coordinationDir !== "string" || typeof data.projectId !== "string" || typeof data.managerId !== "string") return undefined;
  return { coordinationDir: data.coordinationDir, projectId: data.projectId, managerId: data.managerId };
}

function sameIdentity(left: HariManagerSessionIdentity, right: HariManagerSessionIdentity): boolean {
  return left.coordinationDir === right.coordinationDir && left.projectId === right.projectId && left.managerId === right.managerId;
}

/**
 * Accept only the exact four-entry public Pi workspace placeholder format:
 * session header, automatic session name, workspace-name marker, workspace
 * metadata. Any conversation, manager-identity, or unknown entry
 * disqualifies it. The workspace seam separately validates its metadata.
 */
function observePristineWorkspaceEntry(state: PristineWorkspaceState, entry: JsonRecord): void {
  if (state.disqualified) return;
  const data = entry.data;
  if (state.next === 0) {
    if (entry.type === "session" && typeof entry.cwd === "string") {
      state.cwd = entry.cwd;
      state.next = 1;
    }
    else state.disqualified = true;
    return;
  }
  if (state.next === 1) {
    if (entry.type === "session_info" && typeof entry.name === "string") {
      state.name = entry.name;
      state.next = 2;
    }
    else state.disqualified = true;
    return;
  }
  if (state.next === 2) {
    if (entry.type === "custom" && entry.customType === "pi-workspace-session-name" && record(data) && typeof data.branch === "string" && data.branch === state.name) {
      state.branch = data.branch;
      state.next = 3;
    }
    else state.disqualified = true;
    return;
  }
  if (state.next === 3) {
    if (
      entry.type === "custom" && entry.customType === "pi-workspace" && record(data)
      && typeof data.repository === "string" && typeof data.branch === "string" && typeof data.cwd === "string"
      && data.branch === state.branch && data.cwd === state.cwd
    ) state.next = 4;
    else state.disqualified = true;
    return;
  }
  state.disqualified = true;
}

function createIdentityObserver() {
  const pristine: PristineWorkspaceState = { next: 0, disqualified: false };
  let identity: HariManagerSessionIdentity | undefined;
  let uncertainty: string | undefined;
  return {
    get uncertain(): boolean { return uncertainty !== undefined; },
    refuse(reason: string): void { uncertainty ??= reason; },
    observe(entry: unknown): void {
      if (uncertainty) return;
      if (!record(entry)) {
        pristine.disqualified = true;
        return;
      }
      if (entry.customType === IDENTITY_CUSTOM_TYPE) {
        const parsed = parseIdentity(entry);
        if (!parsed) {
          uncertainty = `Native session has malformed ${IDENTITY_CUSTOM_TYPE} data; refusing uncertain identity`;
          return;
        }
        if (identity && !sameIdentity(identity, parsed)) {
          uncertainty = `Native session has conflicting ${IDENTITY_CUSTOM_TYPE} entries; refusing uncertain identity`;
          return;
        }
        identity = parsed;
        pristine.disqualified = true;
        return;
      }
      observePristineWorkspaceEntry(pristine, entry);
    },
    result(): SessionIdentityInspection {
      if (uncertainty) return { uncertain: uncertainty };
      if (identity) return { identity };
      if (!pristine.disqualified && pristine.next === 4) return { pristineWorkspace: true };
      return {};
    },
  };
}

/** Inspect parsed native entries without I/O. The caller must validate and bound its input. */
export function inspectHariManagerSessionEntries(entries: Iterable<unknown>): SessionIdentityInspection {
  const observer = createIdentityObserver();
  for (const entry of entries) observer.observe(entry);
  return observer.result();
}

/**
 * Stream native session JSONL from source with bounded memory. Conversation text
 * is never assembled into a prompt: ordinary lines are discarded after parsing.
 * Identity entries are small custom records appended by the harness; malformed,
 * conflicting, or over-16-MiB JSONL entries are uncertainty rather than a
 * recovery path. This caps memory per entry while leaving total history uncapped.
 */
export async function inspectHariManagerSession(sessionPath: string): Promise<SessionIdentityInspection> {
  await stat(sessionPath);
  const observer = createIdentityObserver();
  let line = "";
  let lineBytes = 0;
  let oversized = false;

  const observeLine = (raw: string, wasOversized: boolean): void => {
    if (observer.uncertain) return;
    if (wasOversized) {
      observer.refuse(`Native session has a JSONL entry over the ${MAX_PARSED_LINE_BYTES}-byte line limit; refusing uncertain identity`);
      return;
    }
    if (raw.length === 0) return;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      observer.refuse("Native session contains malformed JSONL; refusing uncertain identity");
      return;
    }
    observer.observe(entry);
  };

  const appendPart = (part: string, complete: boolean): void => {
    if (!oversized) {
      const partBytes = Buffer.byteLength(part);
      if (lineBytes + partBytes <= MAX_PARSED_LINE_BYTES) {
        line += part;
        lineBytes += partBytes;
      } else {
        oversized = true;
        line = "";
        lineBytes = 0;
      }
    }
    if (!complete) return;
    observeLine(line, oversized);
    line = "";
    lineBytes = 0;
    oversized = false;
  };

  const stream = createReadStream(sessionPath, { encoding: "utf8", highWaterMark: SCAN_CHUNK_BYTES });
  for await (const chunk of stream) {
    const text = String(chunk);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) {
        appendPart(text.slice(start), false);
        break;
      }
      appendPart(text.slice(start, newline), true);
      start = newline + 1;
    }
  }
  if (line.length > 0 || oversized) appendPart("", true);
  return observer.result();
}
