import { createHash, randomUUID } from "node:crypto";
import {
    capAuthoritativeCompletionText,
    normalizeSubagentRunDurationMs,
    SubagentBackendError,
    type SubagentArtifact,
    type SubagentBackend,
    type SubagentBackendCapabilities,
    type SubagentBackendOptions,
    type SubagentBackendPanelDetails,
    type SubagentBackendState,
    type SubagentHistoryMessage,
    type SubagentModel,
    type SubagentPromptRequestResult,
    type SubagentRun,
    type SubagentRunCompletion,
    type SubagentSessionStats,
    type SubagentThinkingLevel,
    type SubagentUsage,
} from "./backend.ts";
import {
    buildCursorCloudFollowUp,
    MAX_CURSOR_BOOTSTRAP_BYTES,
    MAX_CURSOR_FOLLOW_UP_BYTES,
    redactCursorHandoffCredentials,
} from "./cursor-context.ts";
import {
    CursorModelCatalog,
    persistableCursorModelSelection,
    type CursorCatalogParameterValue,
    type CursorExecutionProfile,
    type CursorPanelModel,
} from "./cursor-models.ts";
import { buildCursorRepositoryList, detectCursorPrimaryRepository, type GitCommandPort } from "./cursor-repositories.ts";
import {
    CursorSdkGateway,
    mapCursorSdkError,
    type CursorSdkAgent,
    type CursorSdkRun,
    type CursorSdkRunList,
} from "./cursor-sdk.ts";
import type {
    CursorPendingOperationKind,
    CursorSubagentLifecyclePort,
    CursorSubagentReconciliation,
    CursorSubagentStopOutcome,
    StoredCursorSubagent,
} from "./registry.ts";

export const MAX_CURSOR_EVENT_TEXT_CHARS = 16 * 1024;
export const MAX_CURSOR_EVENT_THINKING_CHARS = 16 * 1024;
export const MAX_CURSOR_EVENT_TOOL_ARGS_CHARS = 4 * 1024;
export const MAX_CURSOR_EVENT_TOOL_OUTPUT_CHARS = 16 * 1024;
export const MAX_CURSOR_EVENT_STATUS_CHARS = 1_024;
export const MAX_CURSOR_ARTIFACTS = 50;
export const MAX_CURSOR_ARTIFACT_NAME_CHARS = 512;
export const MAX_CURSOR_RETAINED_COMPLETIONS = 8;
export const MAX_CURSOR_RECOVERY_CANDIDATES = 8;
export const MAX_CURSOR_ARTIFACT_METADATA_CHARS = 8 * 1024;
export const MAX_CURSOR_RUNTIME_WARNINGS = 4;
export const DEFAULT_CURSOR_ARTIFACT_LIST_TIMEOUT_MS = 2_000;
export const DEFAULT_CURSOR_USAGE_TIMEOUT_MS = 2_000;
const MAX_CURSOR_RUN_METADATA_CHARS = 256;

const CURSOR_CAPABILITIES: SubagentBackendCapabilities = {
    extensionUi: false,
    steering: false,
    queuedFollowUp: false,
    settledFollowUp: true,
    modelControls: true,
    thinkingControls: true,
    sessionHistory: false,
    sessionFile: false,
    usage: true,
    toolOutput: true,
};

export interface CursorCloudBackendConfiguration {
    /** The registry owns this state and persists every update synchronously. */
    readonly stored: Readonly<StoredCursorSubagent>;
    readonly persist: (next: StoredCursorSubagent) => void;
    readonly sdk?: CursorSdkGateway;
    readonly catalog?: CursorModelCatalog;
    /** Optional Git command port for repository discovery. */
    readonly git?: GitCommandPort;
    /** Build the first prompt. This can add the ephemeral fork handoff. */
    readonly buildInitialPrompt?: (request: string, signal?: AbortSignal) => Promise<string>;
    /** Serialize the short send-acceptance section for this registry record. */
    readonly runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
    /** False after the registry stops or replaces this local observer. */
    readonly isCurrent?: () => boolean;
    /** Read current durable registry state before a local Cloud decision. */
    readonly readStored?: () => Readonly<StoredCursorSubagent>;
    /** Bound optional terminal artifact lookup; tests can use a short value. */
    readonly artifactListTimeoutMs?: number;
    /** Bound optional terminal usage lookup; tests can use a short value. */
    readonly usageTimeoutMs?: number;
}

interface CursorBackendOptions extends SubagentBackendOptions {
    readonly cursor: CursorCloudBackendConfiguration;
}

interface CursorRunResult {
    readonly id?: string;
    readonly requestId?: string;
    readonly status?: string;
    readonly result?: string;
    readonly error?: unknown;
    readonly usage?: unknown;
    readonly durationMs?: number;
    readonly git?: unknown;
}

type PendingRunSearch =
    | { readonly state: "found"; readonly run: CursorSdkRun }
    /** A unique running candidate requires a same-key retry when not cancelled. */
    | { readonly state: "retry-running" }
    | { readonly state: "not-found" | "ambiguous" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bound before redaction so unstable SDK payloads cannot grow panel state. */
function bounded(value: unknown, maximum: number): { readonly text: string; readonly truncated: boolean } {
    const raw = typeof value === "string" ? value : "";
    const rawTruncated = raw.length > maximum;
    const text = redactCursorHandoffCredentials(raw.slice(0, maximum)).replace(/[\u0000-\u001f\u007f]/g, " ");
    return text.length <= maximum
        ? { text, truncated: rawTruncated }
        : { text: text.slice(0, maximum), truncated: true };
}

function boundedAuthoritative(value: unknown): { readonly text: string; readonly truncated: boolean } {
    const raw = typeof value === "string" ? value : "";
    // A JS character can need four UTF-8 bytes. This bounds redaction input while
    // still allowing capAuthoritativeCompletionText to apply its byte cap.
    const sourceLimit = 1_024 * 1_024;
    const sourceTruncated = raw.length > sourceLimit;
    const capped = capAuthoritativeCompletionText(redactCursorHandoffCredentials(raw.slice(0, sourceLimit)));
    if (!sourceTruncated) return capped;
    const withNotice = capAuthoritativeCompletionText(`${capped.text}\n\n[Full response is limited to 1 MiB.]`);
    return { text: withNotice.text, truncated: true };
}

function opaqueId(value: unknown, prefix: string): string {
    const text = typeof value === "string" ? redactCursorHandoffCredentials(value.slice(0, 256)) : "";
    if (text && text.length <= 256 && !/[\u0000-\u001f\u007f]/.test(text)) return text;
    return `${prefix}${createHash("sha256").update(text || randomUUID()).digest("hex")}`;
}

/** Serialize only a small, non-throwing projection of unstable tool data. */
function safeJson(value: unknown, maximum: number): { readonly text: string; readonly truncated: boolean } {
    let remaining = maximum;
    let truncated = false;
    const append = (text: string): string => {
        const safe = redactCursorHandoffCredentials(text.slice(0, Math.max(0, remaining))).replace(/[\u0000-\u001f\u007f]/g, " ");
        if (text.length > remaining || safe.length > remaining) truncated = true;
        remaining -= safe.length;
        return safe.slice(0, Math.max(0, remaining + safe.length));
    };
    const visit = (input: unknown, depth: number): string => {
        if (remaining <= 0) {
            truncated = true;
            return "";
        }
        if (typeof input === "string") return append(JSON.stringify(input.slice(0, Math.min(input.length, remaining))));
        if (typeof input === "number" || typeof input === "boolean" || input === null) return append(JSON.stringify(input));
        if (depth >= 4) {
            truncated = true;
            return append('"[Nested tool data limited]"');
        }
        if (Array.isArray(input)) {
            const items = input.slice(0, 16).map((item) => visit(item, depth + 1));
            if (input.length > 16) truncated = true;
            return append("[") + items.join(",") + append("]");
        }
        if (isRecord(input)) {
            const keys: string[] = [];
            try {
                // for...in permits an early exit. Do not allocate an untrusted
                // object's complete key list with Object.keys or Reflect.ownKeys.
                for (const key in input) {
                    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
                    if (keys.length >= 16) {
                        truncated = true;
                        break;
                    }
                    keys.push(key);
                }
            } catch {
                return append('"[Tool data unavailable]"');
            }
            const entries: string[] = [];
            for (const key of keys) {
                // Property keys can be untrusted and arbitrarily large. Bound before
                // JSON.stringify so escaping cannot allocate an oversized string.
                const keyLimit = Math.min(256, Math.max(0, remaining));
                const safeKey = key.slice(0, keyLimit).replace(/[\u0000-\u001f\u007f]/g, " ");
                if (key.length > keyLimit) truncated = true;
                const encodedKey = JSON.stringify(safeKey);
                try {
                    entries.push(`${append(encodedKey)}:${visit(input[key], depth + 1)}`);
                } catch {
                    entries.push(`${append(encodedKey)}:${append('"[Tool data unavailable]"')}`);
                }
            }
            return append("{") + entries.join(",") + append("}");
        }
        return append('"[Tool data unavailable]"');
    };
    const text = visit(value, 0);
    return { text: text.slice(0, maximum), truncated: truncated || text.length > maximum };
}

function asRunResult(value: unknown): CursorRunResult {
    if (!isRecord(value)) return {};
    const durationMs = normalizeSubagentRunDurationMs(value.durationMs);
    return {
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.result === "string" ? { result: value.result } : {}),
        ...(value.error !== undefined ? { error: value.error } : {}),
        ...(value.usage !== undefined ? { usage: value.usage } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(value.git !== undefined ? { git: value.git } : {}),
    };
}

function runStatus(value: string | undefined): "running" | "finished" | "error" | "cancelled" {
    switch (value?.toLowerCase()) {
        case "finished":
        case "finished_successfully":
            return "finished";
        case "cancelled":
        case "canceled":
            return "cancelled";
        case "error":
        case "expired":
            return "error";
        default:
            return "running";
    }
}

function stopReason(status: "running" | "finished" | "error" | "cancelled"): "stop" | "error" | "aborted" | undefined {
    if (status === "finished") return "stop";
    if (status === "error") return "error";
    if (status === "cancelled") return "aborted";
    return undefined;
}

/** Map terminal run errors without exposing server-controlled message text. */
function terminalRunErrorMessage(value: unknown): string {
    if (!isRecord(value)) return "Cursor Cloud run failed.";
    let code = "";
    let name = "";
    let status: number | undefined;
    try {
        code = typeof value.code === "string" ? value.code.toLowerCase().slice(0, 128) : "";
        name = typeof value.name === "string" ? value.name.toLowerCase().slice(0, 128) : "";
        status = typeof value.status === "number" ? value.status : undefined;
    } catch {
        return "Cursor Cloud run failed.";
    }
    const identity = `${name} ${code}`;
    if (status === 401 || status === 403 || /auth|api.?key|credential/.test(identity)) {
        return "Cursor Cloud run authentication failed.";
    }
    if (/repo|integration|repository_access/.test(identity)) {
        return "Cursor Cloud could not access the repository for this run.";
    }
    if (/model/.test(identity)) return "The Cursor Cloud run model was unavailable.";
    return "Cursor Cloud run failed.";
}

function finite(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Keep omitted SDK fields omitted. Zero means reported zero, not unknown. */
function usageFrom(value: unknown): SubagentUsage | undefined {
    if (!isRecord(value)) return undefined;
    const source = isRecord(value.usage) ? value.usage : value;
    const cost = isRecord(value.cost) ? value.cost : isRecord(source.cost) ? source.cost : undefined;
    const input = finite(source.inputTokens);
    const output = finite(source.outputTokens);
    const cacheRead = finite(source.cacheReadTokens);
    const cacheWrite = finite(source.cacheWriteTokens);
    const totalTokens = finite(source.totalTokens);
    const reasoningTokens = finite(source.reasoningTokens);
    const cents = finite(cost?.chargedCents) ?? finite(cost?.rawCostCents);
    if ([input, output, cacheRead, cacheWrite, totalTokens, reasoningTokens, cents].every((item) => item === undefined)) return undefined;
    return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        ...(cents !== undefined ? { cost: { total: cents / 100 } } : {}),
    };
}

function mergeUsage(first: SubagentUsage | undefined, second: SubagentUsage | undefined): SubagentUsage | undefined {
    if (!first) return second;
    if (!second) return first;
    return {
        ...(second.input !== undefined ? { input: second.input } : first.input !== undefined ? { input: first.input } : {}),
        ...(second.output !== undefined ? { output: second.output } : first.output !== undefined ? { output: first.output } : {}),
        ...(second.cacheRead !== undefined ? { cacheRead: second.cacheRead } : first.cacheRead !== undefined ? { cacheRead: first.cacheRead } : {}),
        ...(second.cacheWrite !== undefined ? { cacheWrite: second.cacheWrite } : first.cacheWrite !== undefined ? { cacheWrite: first.cacheWrite } : {}),
        ...(second.totalTokens !== undefined ? { totalTokens: second.totalTokens } : first.totalTokens !== undefined ? { totalTokens: first.totalTokens } : {}),
        ...(second.reasoningTokens !== undefined ? { reasoningTokens: second.reasoningTokens } : first.reasoningTokens !== undefined ? { reasoningTokens: first.reasoningTokens } : {}),
        ...(second.cost?.total !== undefined ? { cost: { total: second.cost.total } } : first.cost?.total !== undefined ? { cost: { total: first.cost.total } } : {}),
    };
}

function sumUsage(first: SubagentUsage | undefined, second: SubagentUsage): SubagentUsage {
    const sum = (left: number | undefined, right: number | undefined): number | undefined =>
        left === undefined ? right : right === undefined ? left : left + right;
    return {
        ...(sum(first?.input, second.input) !== undefined ? { input: sum(first?.input, second.input) } : {}),
        ...(sum(first?.output, second.output) !== undefined ? { output: sum(first?.output, second.output) } : {}),
        ...(sum(first?.cacheRead, second.cacheRead) !== undefined ? { cacheRead: sum(first?.cacheRead, second.cacheRead) } : {}),
        ...(sum(first?.cacheWrite, second.cacheWrite) !== undefined ? { cacheWrite: sum(first?.cacheWrite, second.cacheWrite) } : {}),
        ...(sum(first?.totalTokens, second.totalTokens) !== undefined ? { totalTokens: sum(first?.totalTokens, second.totalTokens) } : {}),
        ...(sum(first?.reasoningTokens, second.reasoningTokens) !== undefined ? { reasoningTokens: sum(first?.reasoningTokens, second.reasoningTokens) } : {}),
        ...(sum(first?.cost?.total, second.cost?.total) !== undefined ? { cost: { total: sum(first?.cost?.total, second.cost?.total) } } : {}),
    };
}

/** Return only the unreported part of an authoritative cumulative run total. */
function remainingUsage(cumulative: SubagentUsage, streamed: SubagentUsage | undefined): SubagentUsage | undefined {
    const remaining = (total: number | undefined, reported: number | undefined): number | undefined => {
        if (total === undefined) return undefined;
        // An authoritative zero is data. Suppress it only when live telemetry already
        // reported that same field, because the cumulative total adds no new value.
        if (total === 0 && reported === undefined) return 0;
        const value = total - (reported ?? 0);
        return value > 0 ? value : undefined;
    };
    const input = remaining(cumulative.input, streamed?.input);
    const output = remaining(cumulative.output, streamed?.output);
    const cacheRead = remaining(cumulative.cacheRead, streamed?.cacheRead);
    const cacheWrite = remaining(cumulative.cacheWrite, streamed?.cacheWrite);
    const totalTokens = remaining(cumulative.totalTokens, streamed?.totalTokens);
    const reasoningTokens = remaining(cumulative.reasoningTokens, streamed?.reasoningTokens);
    const total = remaining(cumulative.cost?.total, streamed?.cost?.total);
    if ([input, output, cacheRead, cacheWrite, totalTokens, reasoningTokens, total].every((item) => item === undefined)) return undefined;
    return {
        ...(input !== undefined ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        ...(total !== undefined ? { cost: { total } } : {}),
    };
}

function isSupportedThinkingLevel(value: string): value is SubagentThinkingLevel {
    return value === "off" || value === "minimal" || value === "low" || value === "medium"
        || value === "high" || value === "xhigh" || value === "max";
}

function thinkingLevel(parameters: readonly { readonly id: string; readonly value: string }[]): SubagentThinkingLevel {
    const parameter = parameters.find((item) => /thinking|reasoning/i.test(item.id));
    return parameter && isSupportedThinkingLevel(parameter.value) ? parameter.value : "off";
}

type UsableCursorThinkingValue = Omit<CursorCatalogParameterValue, "value"> & {
    readonly value: SubagentThinkingLevel;
};

/** Return distinct catalog choices that the backend can apply to the selected model. */
function usableThinkingValues(model: CursorPanelModel | undefined): readonly UsableCursorThinkingValue[] {
    const values = model?.thinking?.values ?? [];
    const seen = new Set<string>();
    const usable: UsableCursorThinkingValue[] = [];
    for (const value of values) {
        const level = value.value;
        if (!isSupportedThinkingLevel(level) || seen.has(level)) continue;
        seen.add(level);
        usable.push({ ...value, value: level });
    }
    return usable;
}

function cloneStored(stored: Readonly<StoredCursorSubagent>): StoredCursorSubagent {
    return {
        ...stored,
        repositories: stored.repositories.map((repository) => ({ ...repository })),
        ...(stored.currentModel ? {
            currentModel: {
                ...stored.currentModel,
                parameters: stored.currentModel.parameters.map((parameter) => ({ ...parameter })),
            },
        } : {}),
        pendingOperations: stored.pendingOperations.map((operation) => ({ ...operation })),
        pendingResult: stored.pendingResult.state === "none" ? { state: "none" } : { ...stored.pendingResult },
    };
}

function deterministicOperationKey(stored: StoredCursorSubagent, kind: CursorPendingOperationKind, nonce?: string): string {
    const predecessor = nonce ?? (kind === "start-run"
        ? "initial"
        : kind === "follow-up"
            ? stored.currentRunId ?? "first-follow-up"
            : stored.currentRunId ?? stored.agentId ?? "local");
    return `pi-cursor-${createHash("sha256").update(`${stored.id}:${kind}:${predecessor}`).digest("hex")}`;
}

function cursorRequestHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function cursorCorrelationMarker(nonce: string): string {
    return `pi-correlation-${createHash("sha256").update(nonce).digest("hex").slice(0, 32)}`;
}

/** Append one fixed marker without exceeding the Cloud prompt byte limit. */
function appendCursorCorrelationMarker(text: string, marker: string, maximumBytes: number): string {
    const suffix = `\n\n[Pi request correlation: ${marker}]`;
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const source = Buffer.from(text, "utf8");
    if (source.length + suffixBytes <= maximumBytes) return `${text}${suffix}`;
    let end = Math.max(0, maximumBytes - suffixBytes);
    while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
    return `${source.subarray(0, end).toString("utf8")}${suffix}`;
}

function storedModelSelection(resolved: ReturnType<typeof persistableCursorModelSelection>): StoredCursorSubagent["currentModel"] {
    return {
        id: resolved.id,
        parameters: resolved.parameters.map((parameter) => ({ ...parameter })),
        resolvedAt: resolved.resolvedAt,
    };
}

function lazyCloudOptions(stored: StoredCursorSubagent): Record<string, unknown> {
    return {
        name: stored.name,
        ...(stored.currentModel ? {
            model: {
                id: stored.currentModel.id,
                ...(stored.currentModel.parameters.length ? { params: stored.currentModel.parameters.map((parameter) => ({ ...parameter })) } : {}),
            },
        } : {}),
        mode: "plan",
        cloud: {
            repos: stored.repositories.map((repository) => ({ ...repository })),
            workOnCurrentBranch: false,
            autoCreatePR: false,
            metadata: {
                "pi-subagent-id": stored.id,
                "pi-subagent-lifetime": stored.lifetime,
            },
        },
    };
}

function isArchivedAgent(value: unknown): boolean {
    return isRecord(value) && value.archived === true;
}

/** Agent.get exposes the latest server run status without paginating history. */
function latestAgentRunStatus(value: unknown): "running" | "finished" | "error" | "cancelled" | undefined {
    if (!isRecord(value) || typeof value.status !== "string") return undefined;
    switch (value.status.toLowerCase()) {
        case "running": return "running";
        case "finished":
        case "finished_successfully": return "finished";
        case "error":
        case "expired": return "error";
        case "cancelled":
        case "canceled": return "cancelled";
        default: return undefined;
    }
}

/** Return the latest user turn by reverse early exit without copying other turns. */
function latestConversationUserText(turns: readonly unknown[]): string | undefined {
    for (let index = turns.length - 1; index >= 0; index--) {
        const entry = turns[index];
        if (!isRecord(entry)) continue;
        const turn = isRecord(entry.turn) ? entry.turn : entry;
        const userMessage = isRecord(turn.userMessage) ? turn.userMessage : undefined;
        if (typeof userMessage?.text === "string") return userMessage.text;
    }
    return undefined;
}

/** A terminal candidate must expose the exact marked delivered user turn. */
async function candidateRequestMatch(
    run: CursorSdkRun,
    requestHash: string,
    marker: string,
): Promise<"match" | "mismatch" | "unknown"> {
    try {
        if (runStatus(run.status) === "running" || !run.supports("conversation")) return "unknown";
        const text = latestConversationUserText(await run.conversation());
        // User prompts have a 24 KiB maximum after marker insertion. Do not hash a
        // larger server response or process unrelated conversation turns.
        if (text === undefined) return "unknown";
        if (Buffer.byteLength(text, "utf8") > MAX_CURSOR_BOOTSTRAP_BYTES) return "mismatch";
        return text.includes(`[Pi request correlation: ${marker}]`) && cursorRequestHash(text) === requestHash
            ? "match"
            : "mismatch";
    } catch {
        return "unknown";
    }
}

/** Return the latest SDK assistant step without copying unrelated conversation data. */
function latestConversationAssistantText(turns: readonly unknown[]): string | undefined {
    const assistantText = (value: unknown): string | undefined => {
        if (!isRecord(value)) return undefined;
        if ((value.type === "assistantMessage" || value.type === "assistant")
            && isRecord(value.message) && typeof value.message.text === "string") {
            return boundedAuthoritative(value.message.text).text;
        }
        return undefined;
    };
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
        const entry = turns[turnIndex];
        if (!isRecord(entry)) continue;
        const turn = isRecord(entry.turn) ? entry.turn : entry;
        const steps = Array.isArray(turn.steps) ? turn.steps : undefined;
        if (steps) {
            for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex--) {
                const text = assistantText(steps[stepIndex]);
                if (text !== undefined) return text;
            }
        }
        // Accept the direct shape used by older SDK versions and injected ports.
        const text = assistantText(turn);
        if (text !== undefined) return text;
    }
    return undefined;
}

function pendingSend(stored: Readonly<StoredCursorSubagent>) {
    return stored.pendingOperations.find((operation) => operation.kind === "start-run" || operation.kind === "follow-up");
}

/** The bounded list retains only data needed to select documented getRun calls. */
interface CursorRunMetadata {
    readonly id: string;
    readonly agentId: string;
    readonly status: string;
    readonly createdAt?: number;
}

interface BoundedCursorRunList {
    readonly runs: readonly CursorRunMetadata[];
    readonly complete: boolean;
}

function isBoundedRunMetadataValue(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_RUN_METADATA_CHARS
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedRunList(value: CursorSdkRunList | readonly CursorSdkRun[]): BoundedCursorRunList {
    // Array support retains compatibility with injected test ports from before the
    // bounded gateway result. Production calls always use CursorSdkRunList.
    const result = value as CursorSdkRunList;
    const source = Array.isArray(value) ? value : result.runs;
    let complete = Array.isArray(value) ? true : result.complete === true;
    const runs: CursorRunMetadata[] = [];
    const ids = new Set<string>();
    for (const run of source) {
        try {
            const id = run.id;
            const agentId = run.agentId;
            const status = run.status;
            if (!isBoundedRunMetadataValue(id) || !isBoundedRunMetadataValue(agentId)
                || typeof status !== "string" || status.length > MAX_CURSOR_RUN_METADATA_CHARS) {
                complete = false;
                continue;
            }
            if (ids.has(id)) continue;
            ids.add(id);
            const createdAt = validServerRunTime(run);
            if (run.createdAt !== undefined && createdAt === undefined) complete = false;
            runs.push({
                id,
                agentId,
                status: status.slice(0, MAX_CURSOR_RUN_METADATA_CHARS),
                ...(createdAt !== undefined ? { createdAt } : {}),
            });
        } catch {
            complete = false;
        }
    }
    return { runs, complete };
}

function validServerRunTime(run: { readonly createdAt?: number }): number | undefined {
    return typeof run.createdAt === "number" && Number.isFinite(run.createdAt) ? run.createdAt : undefined;
}

/**
 * The public SDK has no idempotency-key lookup. Candidate attribution needs both
 * server ordering and the SHA-256 of the exact delivered user turn. Raw request
 * text is intentionally unavailable after restore.
 */
async function findAcceptedPendingRun(
    sdk: CursorSdkGateway,
    stored: Readonly<StoredCursorSubagent>,
): Promise<PendingRunSearch> {
    const operation = pendingSend(stored);
    if (!stored.agentId || !operation) return { state: "not-found" };
    let agent: unknown;
    try {
        agent = await sdk.getAgent(stored.agentId);
    } catch (error) {
        // The lazy initial ID exists only locally until its first accepted run.
        // A Cloud 404 therefore proves this initial send did not create an agent.
        if (operation.kind === "start-run" && !stored.remoteCreated && mapCursorSdkError(error).code === "REMOTE_NOT_FOUND") {
            return { state: "not-found" };
        }
        throw error;
    }
    if (isArchivedAgent(agent)) return { state: "not-found" };
    const listed = boundedRunList(await sdk.listRuns(stored.agentId));

    let baselineTime: number | undefined;
    let baselineRunId: string | undefined;
    if (operation.kind === "follow-up") {
        const completeBaseline = operation.baselineComplete ?? Boolean(operation.baselineRunId && operation.baselineCreatedAt !== undefined);
        if (completeBaseline) {
            baselineRunId = operation.baselineRunId;
            baselineTime = operation.baselineCreatedAt;
            if (!baselineRunId || baselineTime === undefined || !Number.isFinite(baselineTime)) return { state: "ambiguous" };
            const baseline = await sdk.getRun(baselineRunId, stored.agentId);
            if (baseline.id !== baselineRunId || baseline.agentId !== stored.agentId || validServerRunTime(baseline) !== baselineTime) {
                return { state: "ambiguous" };
            }
        }
    }

    const candidates: CursorRunMetadata[] = [];
    let uncertain = false;
    for (const run of listed.runs) {
        if (run.agentId !== stored.agentId) continue;
        if (!run.id) {
            uncertain = true;
            continue;
        }
        if (baselineRunId && run.id === baselineRunId) continue;
        const createdAt = validServerRunTime(run);
        if (createdAt === undefined) {
            uncertain = true;
            continue;
        }
        // A complete follow-up baseline excludes older external runs. An incomplete
        // baseline relies on request hashes for candidates visible in this scan.
        if (baselineTime === undefined || createdAt > baselineTime) candidates.push(run);
    }
    if (candidates.length === 0) return uncertain || !listed.complete ? { state: "ambiguous" } : { state: "not-found" };
    // A legacy record can prove no candidate exists, but it cannot safely claim an
    // existing run without the nonce-derived marker and final-text hash.
    if (!operation.nonce || !operation.requestHash) return { state: "ambiguous" };
    if (candidates.length > MAX_CURSOR_RECOVERY_CANDIDATES) return { state: "ambiguous" };
    const marker = cursorCorrelationMarker(operation.nonce);

    const matches: CursorSdkRun[] = [];
    const running: CursorSdkRun[] = [];
    for (const candidate of candidates) {
        const run = await sdk.getRun(candidate.id, stored.agentId);
        const createdAt = validServerRunTime(run);
        if (run.id !== candidate.id || run.agentId !== stored.agentId || createdAt === undefined
            || (baselineTime !== undefined && createdAt <= baselineTime)) {
            uncertain = true;
            continue;
        }
        if (runStatus(run.status) === "running") {
            // The SDK stream is a shared single-consumer queue. Do not consume it for
            // recovery. A running candidate remains uncertain during cancellation.
            running.push(run);
            continue;
        }
        const match = await candidateRequestMatch(run, operation.requestHash, marker);
        if (match === "match") matches.push(run);
        else if (match === "unknown") uncertain = true;
    }
    if (matches.length === 1 && !uncertain) return { state: "found", run: matches[0]! };
    if (matches.length > 1 || uncertain || !listed.complete) return { state: "ambiguous" };
    // A unique live candidate can only be recovered by retrying the identical SDK
    // idempotency key when the caller is not cancelled. Do not inspect its stream.
    if (running.length === 1) return { state: "retry-running" };
    // Complete history and inspected non-matching terminal candidates prove that this
    // exact request was not accepted. A live caller can retry with its saved key.
    return { state: "not-found" };
}

function reconciliationForRun(run: CursorSdkRun, retainTerminalResult: boolean): CursorSubagentReconciliation {
    return runStatus(run.status) === "running"
        ? {
            remoteLifecycle: "running",
            currentRunId: run.id,
            ...(run.requestId ? { currentRequestId: run.requestId } : {}),
        }
        : {
            remoteLifecycle: "idle",
            currentRunId: run.id,
            ...(run.requestId ? { currentRequestId: run.requestId } : {}),
            ...(retainTerminalResult ? { pendingResult: { state: "available" as const, runId: run.id } } : {}),
        };
}

/** A result is deliverable only when this record owns its requested run. */
function retainsTerminalResult(
    stored: Readonly<StoredCursorSubagent>,
    runId: string,
    correlatedPendingSend = false,
): boolean {
    return correlatedPendingSend || (stored.pendingResult.state !== "none" && stored.pendingResult.runId === runId);
}

/** Identify the one live run that Agent.get().status says exists. */
async function findAuthoritativeActiveRun(
    sdk: CursorSdkGateway,
    stored: Readonly<StoredCursorSubagent>,
): Promise<CursorSdkRun | undefined> {
    if (!stored.agentId) return undefined;
    const listed = boundedRunList(await sdk.listRuns(stored.agentId));
    const ids = new Set(listed.runs
        .filter((run) => run.agentId === stored.agentId && Boolean(run.id) && runStatus(run.status) === "running")
        .map((run) => run.id));
    // A current durable ID can be outside a bounded page. It is a candidate only
    // when no listed run is active, because an agent has one latest active run.
    if (ids.size === 0 && stored.currentRunId) ids.add(stored.currentRunId);
    if (ids.size !== 1) return undefined;
    const runId = ids.values().next().value;
    if (!runId) return undefined;
    const run = await sdk.getRun(runId, stored.agentId);
    return run.id === runId && run.agentId === stored.agentId && runStatus(run.status) === "running"
        ? run
        : undefined;
}

/** Normalize public SDK telemetry. This data is live-only and has no replay ID. */
export class CursorCloudBackend implements SubagentBackend {
    readonly runtime = "cursor-cloud" as const;
    readonly displayName = "Cursor Cloud";
    readonly capabilities = CURSOR_CAPABILITIES;
    private readonly options: CursorBackendOptions;
    private readonly configuration: CursorCloudBackendConfiguration;
    private readonly sdk: CursorSdkGateway;
    private readonly catalog: CursorModelCatalog;
    /** Retry catalog discovery only after an unavailable panel state. */
    private controlAvailabilityNeedsRefresh = false;
    private stored: StoredCursorSubagent;
    private agent: CursorSdkAgent | undefined;
    private activeRun: SubagentRun | undefined;
    private accepting = false;
    /** Set by panel interrupt while a send has not yet returned a run identity. */
    private acceptanceCancelled = false;
    private readonly runs = new Map<string, CursorSdkRun>();
    private readonly completions = new Map<string, SubagentRunCompletion>();
    /** A terminal result can arrive through wait, abort, attach, and recovery. */
    private readonly finishingRuns = new Set<string>();
    private readonly finishedRuns = new Set<string>();
    /** Live usage messages are per-turn increments, not cumulative snapshots. */
    private readonly streamedUsageByRun = new Map<string, SubagentUsage>();
    private readonly finalizedUsageRuns = new Set<string>();
    private readonly liveAssistantText = new Map<string, string>();
    /** Prevent concurrent state refreshes from attaching duplicate observers. */
    private readonly attachingObserverRuns = new Set<string>();
    private observing = true;
    private readonly artifactListTimeoutMs: number;
    private readonly usageTimeoutMs: number;
    /** Invalidates delayed restored-run attachment after local observer disposal. */
    private observationGeneration = 0;
    private diagnostics = "";
    private readonly runtimeWarnings: string[] = [];

    constructor(options: CursorBackendOptions) {
        this.options = options;
        this.configuration = options.cursor;
        this.stored = cloneStored(options.cursor.stored);
        this.sdk = options.cursor.sdk ?? new CursorSdkGateway();
        this.catalog = options.cursor.catalog ?? new CursorModelCatalog(this.sdk);
        const configuredArtifactTimeout = options.cursor.artifactListTimeoutMs;
        this.artifactListTimeoutMs = typeof configuredArtifactTimeout === "number"
            && Number.isFinite(configuredArtifactTimeout) && configuredArtifactTimeout > 0
            ? Math.min(configuredArtifactTimeout, 60_000)
            : DEFAULT_CURSOR_ARTIFACT_LIST_TIMEOUT_MS;
        const configuredUsageTimeout = options.cursor.usageTimeoutMs;
        this.usageTimeoutMs = typeof configuredUsageTimeout === "number"
            && Number.isFinite(configuredUsageTimeout) && configuredUsageTimeout > 0
            ? Math.min(configuredUsageTimeout, 60_000)
            : DEFAULT_CURSOR_USAGE_TIMEOUT_MS;
    }

    async start(): Promise<void> {
        this.observing = true;
        this.observationGeneration++;
        await this.runExclusive(async () => {
            this.syncStored();
            if (!this.isCurrent()) return;
            if (this.stored.remoteCreated && this.stored.agentId && !this.agent) {
                await this.ensureProvisioning();
                try {
                    this.agent = await this.sdk.resumeAgent(this.stored.agentId, lazyCloudOptions(this.stored));
                } catch (error) {
                    throw mapCursorSdkError(error);
                }
                return;
            }
            await this.ensureLazyHandle();
        });
        await this.attachDurableObserver();
    }

    async stop(): Promise<void> {
        await this.disposeObservation();
    }

    async disposeObservation(): Promise<void> {
        this.observing = false;
        this.observationGeneration++;
        try {
            this.agent?.close();
        } catch {
            // Closing a local observer must not affect remote lifecycle state.
        }
        this.agent = undefined;
        this.runs.clear();
    }

    getDiagnostics(): string {
        return this.diagnostics;
    }

    async prompt(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult> {
        return { run: await this.send(message, false, signal) };
    }

    async steer(): Promise<void> {
        throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud does not support steering an active run.", "cursor-cloud");
    }

    async followUp(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult> {
        return { run: await this.send(message, true, signal, true) };
    }

    async abort(): Promise<void> {
        // A panel interrupt can arrive after the controller marks its turn busy but
        // before Agent.send returns. Keep this flag through acceptance.
        if (this.accepting) this.acceptanceCancelled = true;
        const run = this.activeRun;
        if (!run || !this.stored.agentId) return;
        this.setPending("cancel-run");
        try {
            await this.sdk.cancelRun(run.id, this.stored.agentId);
        } catch (error) {
            const mapped = mapCursorSdkError(error);
            try {
                const authoritative = await this.sdk.getRun(run.id, this.stored.agentId);
                if (authoritative.id === run.id && authoritative.agentId === this.stored.agentId
                    && runStatus(authoritative.status) !== "running") {
                    // wait() can remain unresolved after a lost cancellation response.
                    // A terminal getRun is authoritative and must settle the panel.
                    await this.finishRun(run, asRunResult(authoritative));
                    return;
                }
            } catch {
                this.setRemoteUnknown();
            }
            throw mapped;
        }
    }

    async getState(): Promise<SubagentBackendState> {
        this.syncStored();
        await this.attachDurableObserver();
        const model = this.stored.currentModel;
        const controlAvailability = await this.controlAvailability();
        const durableRun = this.stored.remoteLifecycle === "running" && this.stored.currentRunId
            ? {
                id: this.stored.currentRunId,
                runtime: "cursor-cloud" as const,
                parentOwned: this.storedRunIsParentOwned(this.stored.currentRunId),
            }
            : undefined;
        const pendingResult = this.stored.pendingResult.state === "available"
            ? { id: this.stored.pendingResult.runId, runtime: "cursor-cloud" as const, parentOwned: true }
            : undefined;
        return {
            connection: { runtime: "cursor-cloud", id: this.stored.agentId ?? `cursor-local-${this.stored.id}` },
            ...(this.activeRun ?? durableRun ? { run: this.activeRun ?? durableRun } : {}),
            ...(pendingResult ? { pendingResult } : {}),
            details: this.panelDetails(),
            controlAvailability,
            ...(model ? { model: { provider: "cursor", id: model.id, name: model.id, reasoning: model.parameters.some((item) => /thinking|reasoning/i.test(item.id)) } } : {}),
            thinkingLevel: model ? thinkingLevel(model.parameters) : "off",
            isStreaming: this.activeRun !== undefined || durableRun !== undefined,
            isCompacting: false,
        };
    }

    async getRunCompletion(run: SubagentRun): Promise<SubagentRunCompletion | undefined> {
        return this.completions.get(run.id);
    }

    async markRunCompletionDelivered(run: SubagentRun): Promise<void> {
        this.syncStored();
        if (this.stored.pendingResult.state !== "available" || this.stored.pendingResult.runId !== run.id) return;
        this.stored.pendingResult = { state: "none" };
        this.persist();
    }

    /** Resolve selected-model controls without making catalog failure fatal. */
    private async controlAvailability(): Promise<{ readonly model: boolean; readonly thinking: boolean }> {
        try {
            const models = this.controlAvailabilityNeedsRefresh
                ? await this.catalog.refreshPanelModels()
                : await this.catalog.panelModels();
            if (models.length === 0) {
                this.controlAvailabilityNeedsRefresh = true;
                return { model: false, thinking: false };
            }
            this.controlAvailabilityNeedsRefresh = false;
            const modelId = this.stored.currentModel?.id;
            const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined;
            return { model: true, thinking: usableThinkingValues(model).length >= 2 };
        } catch {
            // A later explicit state refresh retries this lookup. Normal ready states
            // continue to use the cached catalog and do not refresh it repeatedly.
            this.controlAvailabilityNeedsRefresh = true;
            return { model: false, thinking: false };
        }
    }

    /** Return only the bounded metadata that the shared panel can render. */
    private panelDetails(): SubagentBackendPanelDetails {
        const runId = this.activeRun?.id ?? this.stored.currentRunId;
        const completion = runId ? this.completions.get(runId) : undefined;
        return {
            ...(this.stored.agentId ? { agent: { id: this.stored.agentId } } : {}),
            ...(runId ? { run: { id: runId } } : {}),
            lifecycle: this.stored.remoteLifecycle,
            ...(this.stored.repositories.length ? {
                repositories: this.stored.repositories.map(({ url, startingRef }) => ({
                    url,
                    ...(startingRef ? { startingRef } : {}),
                })),
            } : {}),
            ...(completion?.artifacts?.length ? { artifacts: completion.artifacts } : {}),
            ...(completion?.runtimeWarnings?.length
                ? { runtimeWarnings: completion.runtimeWarnings }
                : this.runtimeWarnings.length ? { runtimeWarnings: this.boundedRuntimeWarnings() } : {}),
            ...(completion?.policyWarnings?.length ? { policyWarnings: completion.policyWarnings } : {}),
        };
    }

    async getArtifacts(): Promise<readonly SubagentArtifact[]> {
        return this.runExclusive(async () => {
            try {
                this.syncStored();
                await this.ensureHandle();
                return this.normalizeArtifacts(await this.agent!.listArtifacts());
            } catch (error) {
                throw mapCursorSdkError(error);
            }
        });
    }

    async getHistory(): Promise<readonly SubagentHistoryMessage[]> {
        return [];
    }

    async getSessionStats(): Promise<SubagentSessionStats> {
        return {};
    }

    async getAvailableModels(): Promise<readonly SubagentModel[]> {
        const models = await this.catalog.panelModels();
        return models.map((model) => ({ provider: "cursor", id: model.id, name: model.name, reasoning: usableThinkingValues(model).length > 0 }));
    }

    async setModel(provider: string, modelId: string): Promise<SubagentModel> {
        return this.runExclusive(async () => {
            this.syncStored();
            this.assertIdleForModelChange();
            if (provider !== "cursor") {
                throw new SubagentBackendError("MODEL_UNAVAILABLE", "Cursor Cloud requires a Cursor catalog model.", "cursor-cloud");
            }
            const resolved = await this.catalog.resolveSelection(modelId);
            this.stored.currentModel = storedModelSelection(persistableCursorModelSelection(resolved));
            this.persist();
            return { provider: "cursor", id: resolved.selection.id, name: resolved.model.name, reasoning: resolved.model.parameters.length > 0 };
        });
    }

    async cycleModel(): Promise<{ readonly model: SubagentModel; readonly thinkingLevel: SubagentThinkingLevel } | null> {
        return this.runExclusive(async () => {
            this.syncStored();
            this.assertIdleForModelChange();
            const models = await this.catalog.panelModels();
            if (models.length < 2) return null;
            const index = models.findIndex((model) => model.id === this.stored.currentModel?.id);
            const selected = models[(index + 1 + models.length) % models.length]!;
            const resolved = await this.catalog.resolveSelection(selected.id);
            this.stored.currentModel = storedModelSelection(persistableCursorModelSelection(resolved));
            this.persist();
            return {
                model: { provider: "cursor", id: selected.id, name: selected.name, reasoning: Boolean(selected.thinking) },
                thinkingLevel: thinkingLevel(resolved.selection.parameters),
            };
        });
    }

    async setThinkingLevel(level: SubagentThinkingLevel): Promise<void> {
        return this.runExclusive(async () => {
            this.syncStored();
            this.assertIdleForModelChange();
            await this.setThinkingLevelNow(level);
        });
    }

    async cycleThinkingLevel(): Promise<{ readonly level: SubagentThinkingLevel } | null> {
        return this.runExclusive(async () => {
            this.syncStored();
            this.assertIdleForModelChange();
            const modelId = this.stored.currentModel?.id;
            if (!modelId) return null;
            const model = (await this.catalog.panelModels()).find((candidate) => candidate.id === modelId);
            const values = usableThinkingValues(model);
            if (values.length < 2) return null;
            const current = thinkingLevel(this.stored.currentModel?.parameters ?? []);
            const index = values.findIndex((value) => value.value === current);
            const next = values[(index + 1 + values.length) % values.length]!;
            await this.setThinkingLevelNow(next.value);
            return { level: next.value };
        });
    }

    respondToExtensionUI(): void {
        // Cursor Cloud does not expose Pi extension UI requests.
    }

    private async setThinkingLevelNow(level: SubagentThinkingLevel): Promise<void> {
        const modelId = this.stored.currentModel?.id;
        if (!modelId) throw new SubagentBackendError("MODEL_UNAVAILABLE", "Select a Cursor model before setting thinking.", "cursor-cloud");
        const model = (await this.catalog.panelModels()).find((candidate) => candidate.id === modelId);
        const selected = usableThinkingValues(model).find((value) => value.value === level);
        if (!selected) throw new SubagentBackendError("MODEL_UNAVAILABLE", "The selected Cursor model does not support that thinking level.", "cursor-cloud");
        const parameters = selected.parameters ?? [{ id: model!.thinking!.parameterId, value: selected.value }];
        const resolved = await this.catalog.resolveSelection(modelId, parameters);
        this.stored.currentModel = storedModelSelection(persistableCursorModelSelection(resolved));
        this.persist();
        this.options.onEvent({ type: "thinking_changed", level: thinkingLevel(resolved.selection.parameters) });
    }

    private async send(
        request: string,
        requestedFollowUp: boolean,
        signal?: AbortSignal,
        supersedeSettledResult = false,
    ): Promise<SubagentRun> {
        return this.runExclusive(async () => {
            this.syncStored();
            signal?.throwIfAborted();
            if (!this.isCurrent()) throw new SubagentBackendError("BUSY", "Cursor Cloud is stopping. Wait for stop confirmation before retrying.", "cursor-cloud");
            if (this.stored.pendingResult.state !== "none" && !supersedeSettledResult) {
                throw new SubagentBackendError("BUSY", "Cursor Cloud has an undelivered result. Return or receive it before sending another prompt.", "cursor-cloud");
            }
            if (this.stored.pendingResult.state === "pending") {
                throw new SubagentBackendError("BUSY", "Cursor Cloud already has an active run. Wait for it to settle, then retry.", "cursor-cloud");
            }
            if (this.accepting || this.activeRun || this.stored.remoteLifecycle === "running"
                || this.stored.remoteLifecycle === "stopping" || this.stored.remoteLifecycle === "archive-started"
                || this.stored.remoteLifecycle === "archive-pending" || this.stored.remoteLifecycle === "remote-state-unknown") {
                throw new SubagentBackendError("BUSY", "Cursor Cloud already has an active or unreconciled run. Wait for it to settle, then retry.", "cursor-cloud");
            }
            const firstSend = !this.stored.remoteCreated;
            if (requestedFollowUp && firstSend) {
                throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud has no confirmed initial run. Submit an initial prompt or reconcile remote state first.", "cursor-cloud");
            }
            this.accepting = true;
            this.acceptanceCancelled = false;
            try {
                await this.ensureHandle();
                this.throwIfAcceptanceCancelled(signal);
                const kind: CursorPendingOperationKind = firstSend ? "start-run" : "follow-up";
                // Save the nonce before prompt construction. A retry later uses this
                // same durable nonce, marker, request hash, and idempotency key.
                this.setPending(kind);
                let text: string;
                try {
                    const marker = this.pendingMarker(kind);
                    const source = firstSend
                        ? this.configuration.buildInitialPrompt
                            ? await this.configuration.buildInitialPrompt(request, signal)
                            : request
                        : buildCursorCloudFollowUp(request, this.stored.lifetime);
                    // Bootstrap can be asynchronous. Do not persist or send after it
                    // returns if its caller cancelled in the meantime.
                    this.throwIfAcceptanceCancelled(signal);
                    text = appendCursorCorrelationMarker(
                        source,
                        marker,
                        firstSend ? MAX_CURSOR_BOOTSTRAP_BYTES : MAX_CURSOR_FOLLOW_UP_BYTES,
                    );
                    this.setPendingRequestHash(kind, text);
                    if (kind === "follow-up") await this.setFollowUpPending();
                    // This is the final cancellation check before the SDK call.
                    this.throwIfAcceptanceCancelled(signal);
                } catch (error) {
                    this.clearPending(kind);
                    throw error;
                }
                const options = {
                    mode: "plan" as const,
                    model: {
                        id: this.stored.currentModel!.id,
                        ...(this.stored.currentModel!.parameters.length ? { params: this.stored.currentModel!.parameters.map((parameter) => ({ ...parameter })) } : {}),
                    },
                    idempotencyKey: this.pendingKey(kind),
                };
                this.sdk.assertAuthenticated?.();
                let abortedDuringAcceptance = signal?.aborted ?? false;
                const onAbort = () => { abortedDuringAcceptance = true; };
                signal?.addEventListener("abort", onAbort, { once: true });
                try {
                    let sdkRun: CursorSdkRun;
                    try {
                        sdkRun = await this.agent!.send(text, options);
                    } catch (error) {
                        const mapped = mapCursorSdkError(error);
                        const recovered = await this.recoverLostSend(
                            kind,
                            text,
                            options,
                            () => this.wasAcceptanceCancelled(signal, abortedDuringAcceptance),
                        );
                        if (typeof recovered === "object" && "terminalCancelledRun" in recovered) {
                            throw new SubagentBackendError(
                                "CANCELLED",
                                "The Cursor Cloud operation was cancelled.",
                                "cursor-cloud",
                                recovered.terminalCancelledRun,
                            );
                        }
                        if (recovered && recovered !== "initial-absent" && recovered !== "follow-up-absent") {
                            if (this.wasAcceptanceCancelled(signal, abortedDuringAcceptance)) {
                                await this.cancelAcceptedRun(recovered);
                                throw new SubagentBackendError("CANCELLED", "The Cursor Cloud operation was cancelled.", "cursor-cloud", recovered);
                            }
                            return recovered;
                        }
                        if (recovered === "initial-absent" || recovered === "follow-up-absent") {
                            if (this.wasAcceptanceCancelled(signal, abortedDuringAcceptance)) {
                                throw new SubagentBackendError("CANCELLED", "The Cursor Cloud operation was cancelled.", "cursor-cloud");
                            }
                            throw mapped;
                        }
                        if (mapped.code === "BUSY" && !this.wasAcceptanceCancelled(signal, abortedDuringAcceptance)) {
                            this.clearPending(kind);
                            throw mapped;
                        }
                        // A lost response during cancellation remains an uncertain
                        // remote send. Do not claim cancellation without its run ID.
                        this.setRemoteUnknown();
                        if (this.wasAcceptanceCancelled(signal, abortedDuringAcceptance)) {
                            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud send state could not be reconciled. Refresh status before retrying.", "cursor-cloud");
                        }
                        throw mapped;
                    }
                    // acceptRun persists agent, run, and request identities before
                    // cancellation. Keep the abort listener through this boundary.
                    const accepted = this.acceptRun(kind, sdkRun);
                    if (this.wasAcceptanceCancelled(signal, abortedDuringAcceptance)) {
                        await this.cancelAcceptedRun(accepted);
                        throw new SubagentBackendError("CANCELLED", "The Cursor Cloud operation was cancelled.", "cursor-cloud", accepted);
                    }
                    return accepted;
                } finally {
                    signal?.removeEventListener("abort", onAbort);
                }
            } finally {
                this.accepting = false;
                this.acceptanceCancelled = false;
            }
        });
    }

    /** Recover a lost response and recheck cancellation before one same-key retry. */
    private async recoverLostSend(
        kind: CursorPendingOperationKind,
        text: string,
        options: Record<string, unknown>,
        isCancelled: () => boolean,
    ): Promise<SubagentRun | "initial-absent" | "follow-up-absent" | { readonly terminalCancelledRun: SubagentRun } | undefined> {
        let search: PendingRunSearch;
        try {
            search = await findAcceptedPendingRun(this.sdk, this.stored);
        } catch {
            return undefined;
        }
        // A terminal candidate can be attributed by conversation. During cancellation,
        // settle it without starting the shared SDK stream or sending cancel again.
        if (search.state === "found") {
            return isCancelled()
                ? await this.acceptTerminalCancelledSend(kind, search.run)
                : this.acceptRun(kind, search.run);
        }
        if (search.state === "ambiguous") return undefined;
        // Never retry or consume SDK telemetry after cancellation. A live candidate
        // cannot be safely attributed through the public API, so preserve uncertainty.
        if (search.state === "retry-running" && isCancelled()) return undefined;
        if (isCancelled()) return this.settleAbsentPendingSend(kind);

        // This check is immediately before the only retry dispatch. A retry against a
        // unique live candidate reuses the exact key and can return its run handle.
        if (isCancelled()) return this.settleAbsentPendingSend(kind);
        try {
            const retried = await this.agent!.send(text, options);
            const accepted = this.acceptRun(kind, retried);
            // The caller observes this state and cancels the persisted exact run.
            if (isCancelled()) return accepted;
            return accepted;
        } catch {
            try {
                search = await findAcceptedPendingRun(this.sdk, this.stored);
            } catch {
                return undefined;
            }
            if (search.state === "found") {
                return isCancelled()
                    ? await this.acceptTerminalCancelledSend(kind, search.run)
                    : this.acceptRun(kind, search.run);
            }
            if (search.state === "retry-running" && isCancelled()) return undefined;
            if (search.state === "not-found" && isCancelled()) return this.settleAbsentPendingSend(kind);
            if (search.state === "not-found" && kind === "start-run") {
                this.settleInitialSendAbsent();
                return "initial-absent";
            }
            return undefined;
        }
    }

    /** Persist a run before observation. Terminal cancellation can skip shared stream use. */
    private acceptRun(kind: CursorPendingOperationKind, sdkRun: CursorSdkRun, observe = true): SubagentRun {
        if (!this.isCurrent() || !sdkRun.id || !this.stored.agentId || sdkRun.agentId !== this.stored.agentId) {
            this.setRemoteUnknown();
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud did not return a valid run identity. Refresh status before retrying.", "cursor-cloud");
        }
        const run = { id: sdkRun.id, runtime: "cursor-cloud" as const, parentOwned: true };
        this.stored.remoteCreated = true;
        this.stored.currentRunId = sdkRun.id;
        if (sdkRun.requestId) this.stored.currentRequestId = sdkRun.requestId;
        else delete this.stored.currentRequestId;
        this.stored.remoteLifecycle = "running";
        this.stored.localLifecycle = "available";
        // This run came from a local requested send. Keep ownership durable until its
        // terminal result reaches the parent or the panel explicitly returns it.
        this.stored.pendingResult = { state: "pending", runId: sdkRun.id };
        this.clearPending(kind, false);
        this.persist();
        this.activeRun = run;
        this.runs.set(run.id, sdkRun);
        this.options.onEvent({ type: "run_started", run });
        for (const warning of this.runtimeWarnings) this.options.onEvent({ type: "runtime_warning", run, warning });
        if (observe) void this.observeRun(run, sdkRun);
        return run;
    }

    /** Settle a terminal matched request without consuming the SDK shared stream. */
    private async acceptTerminalCancelledSend(
        kind: CursorPendingOperationKind,
        sdkRun: CursorSdkRun,
    ): Promise<{ readonly terminalCancelledRun: SubagentRun }> {
        const run = this.acceptRun(kind, sdkRun, false);
        await this.finishRun(run, await this.recoverAfterTransport(run));
        return { terminalCancelledRun: run };
    }

    /** Cancel only the run whose durable identity was persisted after send. */
    private async cancelAcceptedRun(run: SubagentRun): Promise<void> {
        if (this.activeRun?.id !== run.id || !this.stored.agentId) {
            this.setRemoteUnknown();
            return;
        }
        try {
            await this.abort();
        } catch {
            // abort() leaves its cancel operation durable. The caller is already
            // cancelled, so do not retry a send or start archival cleanup here.
        }
    }

    private async ensureLazyHandle(): Promise<void> {
        if (this.agent) return;
        if (!this.stored.agentId) {
            this.stored.agentId = `bc-${randomUUID()}`;
            this.setPending("create-agent");
        }
        const hadPendingCreate = this.stored.pendingOperations.some((operation) => operation.kind === "create-agent");
        // The installed SDK validates Cloud credentials at Agent.create. Check the
        // explicit environment key first so it cannot load or use browser state.
        this.sdk.assertAuthenticated?.();
        await this.ensureRepositories();
        await this.ensureModel();
        try {
            this.agent = await this.sdk.createAgent({
                ...lazyCloudOptions(this.stored),
                agentId: this.stored.agentId,
                ...(hadPendingCreate ? { idempotencyKey: this.pendingKey("create-agent") } : {}),
            });
        } catch (error) {
            throw mapCursorSdkError(error);
        }
        if (hadPendingCreate) {
            this.clearPending("create-agent", false);
            this.persist();
        }
    }

    private async ensureProvisioning(): Promise<void> {
        this.sdk.assertAuthenticated?.();
        await this.ensureRepositories();
        await this.ensureModel();
    }

    private async ensureHandle(): Promise<void> {
        await this.ensureLazyHandle();
    }

    private async ensureRepositories(): Promise<void> {
        if (this.stored.repositories.length > 0) return;
        const primary = await detectCursorPrimaryRepository(this.options.cwd, this.configuration.git);
        this.stored.repositories = buildCursorRepositoryList(primary, this.stored.persona?.cursorRepos ?? []);
        this.persist();
        if (primary.warnings.length) {
            this.addRuntimeWarnings(primary.warnings);
        }
    }

    private async ensureModel(): Promise<void> {
        if (this.stored.currentModel) return;
        const resolved = await this.catalog.resolveCreation(
            this.stored.requestedProfile as CursorExecutionProfile | undefined,
        );
        this.stored.currentModel = storedModelSelection(persistableCursorModelSelection(resolved));
        this.persist();
    }

    private async observeRun(run: SubagentRun, sdkRun: CursorSdkRun): Promise<void> {
        const unsubscribe = sdkRun.onDidChangeStatus((status) => {
            if (!this.observing || !this.isActive(run) || !this.isCurrent()) return;
            const text = bounded(`Cursor Cloud run ${status}`, MAX_CURSOR_EVENT_STATUS_CHARS);
            this.options.onEvent({ type: "status_update", run, status: text.text, ...(text.truncated ? { truncated: true } : {}) });
        });
        try {
            if (sdkRun.supports("stream")) void this.streamRun(run, sdkRun);
            const result = sdkRun.supports("wait")
                ? await sdkRun.wait()
                : await this.authoritativeRunResult(sdkRun, run.id);
            if (!this.observing || !this.isCurrent()) return;
            await this.finishRun(run, asRunResult(result));
        } catch {
            if (!this.observing || !this.isCurrent()) return;
            try {
                await this.finishRun(run, await this.recoverAfterTransport(run));
            } catch {
                // Do not settle this run. The saved run and operation identities
                // remain the only durable authority until later reconciliation.
                this.setRemoteUnknown();
                this.options.onExit({
                    code: null,
                    signal: null,
                    diagnostics: "Cursor Cloud run transport could not be reconciled.",
                    intentional: false,
                });
            }
        } finally {
            unsubscribe();
        }
    }

    private async authoritativeRunResult(run: CursorSdkRun, expectedRunId = run.id): Promise<CursorRunResult> {
        if (!this.stored.agentId) throw new SubagentBackendError("REMOTE_NOT_FOUND", "The Cursor Cloud agent was not found. Refresh status before retrying.", "cursor-cloud");
        const current = await this.sdk.getRun(expectedRunId, this.stored.agentId);
        if (current.id !== expectedRunId || current.agentId !== this.stored.agentId) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud returned a run with a different identity. Refresh status before retrying.", "cursor-cloud");
        }
        const durationMs = normalizeSubagentRunDurationMs(current.durationMs);
        return {
            id: current.id,
            requestId: current.requestId,
            status: current.status,
            result: current.result,
            error: current.error,
            usage: current.usage,
            ...(durationMs !== undefined ? { durationMs } : {}),
            git: current.git,
        };
    }

    private async recoverAfterTransport(run: SubagentRun): Promise<CursorRunResult> {
        if (!this.stored.agentId) throw new SubagentBackendError("REMOTE_NOT_FOUND", "The Cursor Cloud agent was not found. Refresh status before retrying.", "cursor-cloud");
        const remote = await this.sdk.getRun(run.id, this.stored.agentId);
        if (remote.id !== run.id || remote.agentId !== this.stored.agentId) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud returned a run with a different identity. Refresh status before retrying.", "cursor-cloud");
        }
        let result: CursorRunResult;
        if (runStatus(remote.status) === "running" && remote.supports("wait")) {
            result = asRunResult(await remote.wait());
        } else {
            result = await this.authoritativeRunResult(remote, run.id);
        }
        if (result.id && result.id !== run.id) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud returned a run with a different identity. Refresh status before retrying.", "cursor-cloud");
        }
        if (this.isParentOwned(run) && !result.result && remote.supports("conversation")) {
            try {
                const text = latestConversationAssistantText(await remote.conversation());
                if (text) result = { ...result, result: text };
            } catch {
                // The final run result is the supported fallback when conversation is unavailable.
            }
        }
        return result;
    }

    private async streamRun(run: SubagentRun, sdkRun: CursorSdkRun): Promise<void> {
        try {
            for await (const message of sdkRun.stream()) {
                if (!this.observing || !this.isActive(run) || !this.isCurrent()) return;
                this.normalizeLiveMessage(run, message);
            }
        } catch {
            // wait() or getRun() decides completion. A stream loss is telemetry-only.
            this.diagnostics = "Cursor Cloud live telemetry disconnected; run status is being reconciled.";
        }
    }

    private normalizeLiveMessage(run: SubagentRun, value: unknown): void {
        if (!isRecord(value) || typeof value.type !== "string") return;
        // SDK stream messages have mandatory snake_case agent and run identities.
        // Do not let an interleaved foreign event affect this local observer.
        if (value.agent_id !== this.stored.agentId || value.run_id !== run.id) return;
        if (!this.isParentOwned(run)) {
            // External runs are observation-only. Keep bounded numeric telemetry and a
            // fixed status, but never place their response or tool content in the panel.
            if (value.type === "usage") {
                const usage = usageFrom(value.usage);
                if (usage) this.emitStreamUsage(run, usage);
            } else if (value.type === "status") {
                this.options.onEvent({ type: "status_update", run, status: "Cursor Cloud external run status updated." });
            }
            return;
        }
        switch (value.type) {
            case "assistant": {
                let content = "";
                const blocks = isRecord(value.message) && Array.isArray(value.message.content) ? value.message.content : [];
                for (const item of blocks.slice(0, 64)) {
                    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
                    const remaining = MAX_CURSOR_EVENT_TEXT_CHARS - content.length;
                    if (remaining <= 0) break;
                    content += bounded(item.text, remaining).text;
                }
                const previous = this.liveAssistantText.get(run.id) ?? "";
                const delta = content.startsWith(previous) ? content.slice(previous.length) : content;
                this.liveAssistantText.set(run.id, content);
                const text = bounded(delta, MAX_CURSOR_EVENT_TEXT_CHARS);
                if (text.text) this.options.onEvent({ type: "message_delta", run, textDelta: text.text, ...(text.truncated || blocks.length > 64 ? { truncated: true } : {}) });
                return;
            }
            case "thinking": {
                const text = bounded(value.text, MAX_CURSOR_EVENT_THINKING_CHARS);
                if (text.text) this.options.onEvent({ type: "message_delta", run, thinkingDelta: text.text, ...(text.truncated ? { truncated: true } : {}) });
                return;
            }
            case "tool_call": {
                const toolCallId = opaqueId(value.call_id, "cursor-tool-");
                const name = bounded(value.name, 256);
                const args = safeJson(value.args, MAX_CURSOR_EVENT_TOOL_ARGS_CHARS);
                const output = safeJson(value.result, MAX_CURSOR_EVENT_TOOL_OUTPUT_CHARS);
                const truncated = name.truncated || args.truncated || output.truncated || (isRecord(value.truncated) && (value.truncated.args === true || value.truncated.result === true));
                if (value.status === "running") {
                    this.options.onEvent({ type: "tool_started", run, toolCallId, name: name.text || "tool", args: args.text, ...(truncated ? { truncated: true } : {}) });
                } else if (value.status === "completed" || value.status === "error") {
                    this.options.onEvent({ type: "tool_completed", run, toolCallId, output: output.text, isError: value.status === "error", ...(truncated ? { truncated: true } : {}) });
                } else {
                    this.options.onEvent({ type: "tool_updated", run, toolCallId, output: output.text, ...(truncated ? { truncated: true } : {}) });
                }
                return;
            }
            case "status": {
                const status = bounded(typeof value.message === "string" ? value.message : `Cursor Cloud ${String(value.status ?? "status").toLowerCase()}`, MAX_CURSOR_EVENT_STATUS_CHARS);
                this.options.onEvent({ type: "status_update", run, status: status.text, ...(status.truncated ? { truncated: true } : {}) });
                return;
            }
            case "request":
                if (typeof value.request_id === "string" && value.request_id !== this.stored.currentRequestId) {
                    this.stored.currentRequestId = bounded(value.request_id, 256).text;
                    this.persist();
                }
                this.options.onEvent({ type: "status_update", run, status: "Cursor Cloud accepted the request." });
                return;
            case "task": {
                const text = bounded(typeof value.text === "string" ? value.text : `Cursor Cloud task ${String(value.status ?? "updated")}.`, MAX_CURSOR_EVENT_STATUS_CHARS);
                this.options.onEvent({ type: "status_update", run, status: text.text, ...(text.truncated ? { truncated: true } : {}) });
                return;
            }
            case "usage": {
                const usage = usageFrom(value.usage);
                if (usage) this.emitStreamUsage(run, usage);
                return;
            }
            case "system":
            case "user":
                return;
        }
    }

    private async finishRun(run: SubagentRun, result: CursorRunResult): Promise<void> {
        // Take the per-run guard before any await. wait(), abort(), restored attach,
        // and transport recovery can observe the same terminal Cloud run together.
        if (!this.isActive(run) || !this.isCurrent() || this.finishingRuns.has(run.id) || this.finishedRuns.has(run.id)) return;
        this.finishingRuns.add(run.id);
        try {
            if (result.id && result.id !== run.id) {
                this.setRemoteUnknown();
                return;
            }
            if (runStatus(result.status) === "running") result = await this.authoritativeRunResult(this.runs.get(run.id)!, run.id);
            if (!this.isActive(run) || !this.isCurrent()) return;
            const finalStatus = runStatus(result.status);
            if (finalStatus === "running" || (result.id && result.id !== run.id)) {
                this.setRemoteUnknown();
                return;
            }
            const parentOwned = this.isParentOwned(run);
            let completion: SubagentRunCompletion | undefined;
            if (parentOwned) {
                const text = boundedAuthoritative(result.result ?? "");
                const policyWarnings = this.policyWarningsFor(result.git);
                const runtimeWarnings = this.boundedRuntimeWarnings();
                const artifacts = await this.completionArtifacts();
                if (!this.isActive(run) || !this.isCurrent()) return;
                const usage = await this.emitFinalUsage(run, result.usage);
                if (!this.isActive(run) || !this.isCurrent()) return;
                completion = {
                    text: text.text,
                    responseProduced: Boolean(text.text.trim()),
                    ...(stopReason(finalStatus) ? { stopReason: stopReason(finalStatus) } : {}),
                    ...(finalStatus === "error" ? { errorMessage: terminalRunErrorMessage(result.error) } : {}),
                    ...(usage ? { usage } : {}),
                    ...(normalizeSubagentRunDurationMs(result.durationMs) !== undefined
                        ? { durationMs: normalizeSubagentRunDurationMs(result.durationMs) }
                        : {}),
                    ...(artifacts.length ? { artifacts } : {}),
                    ...(policyWarnings.length ? { policyWarnings } : {}),
                    ...(runtimeWarnings.length ? { runtimeWarnings } : {}),
                    ...(text.truncated ? { truncated: true } : {}),
                };
                this.rememberCompletion(run, completion);
                this.reportPolicyWarnings(run, policyWarnings);
            } else {
                // Preserve lifecycle and numeric telemetry, but never retain external
                // response, error, artifact, or warning content for parent delivery.
                await this.emitFinalUsage(run, result.usage);
                if (!this.isActive(run) || !this.isCurrent()) return;
            }
            this.clearPending("cancel-run", false);
            const retainedArchivedResult = this.stored.remoteLifecycle === "archived" || this.stored.localLifecycle === "stopped";
            if (!retainedArchivedResult) {
                this.stored.remoteLifecycle = "idle";
                this.stored.localLifecycle = "available";
            }
            if (parentOwned && retainsTerminalResult(this.stored, run.id)) {
                this.stored.pendingResult = {
                    state: "available",
                    runId: run.id,
                    ...(this.stored.pendingResult.state !== "none"
                        && this.stored.pendingResult.runId === run.id
                        && this.stored.pendingResult.archiveAfterDelivery === true
                        ? { archiveAfterDelivery: true }
                        : {}),
                };
            }
            this.persist();
            this.rememberFinishedRun(run.id);
            if (completion) {
                // Event payloads are panel telemetry. The retained completion is available
                // only through getRunCompletion and can be larger than this event cap.
                const eventText = bounded(completion.text, MAX_CURSOR_EVENT_TEXT_CHARS);
                this.options.onEvent({ type: "message_completed", run, message: {
                    role: "assistant",
                    text: eventText.text,
                    thinking: "",
                    ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
                    ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
                    ...(completion.truncated || eventText.truncated ? { truncated: true } : {}),
                } });
            } else {
                const status = finalStatus === "error"
                    ? "Cursor Cloud external run ended with an error."
                    : finalStatus === "cancelled"
                        ? "Cursor Cloud external run was cancelled."
                        : "Cursor Cloud external run settled.";
                this.options.onEvent({ type: "status_update", run, status });
            }
            this.options.onEvent({ type: "run_settled", run });
            this.activeRun = undefined;
            this.runs.delete(run.id);
            this.liveAssistantText.delete(run.id);
        } finally {
            this.finishingRuns.delete(run.id);
        }
    }

    /** Project artifact metadata without downloading artifact content. */
    private normalizeArtifacts(values: readonly unknown[]): readonly SubagentArtifact[] {
        const artifacts: SubagentArtifact[] = [];
        let remaining = MAX_CURSOR_ARTIFACT_METADATA_CHARS;
        for (const value of values.slice(0, MAX_CURSOR_ARTIFACTS)) {
            if (!isRecord(value) || typeof value.path !== "string" || remaining < 3) continue;
            const sizeBytes = typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)
                ? value.sizeBytes
                : undefined;
            const sizeChars = sizeBytes === undefined ? 0 : String(sizeBytes).length;
            // name and path intentionally contain the same bounded server path.
            const pathLimit = Math.min(MAX_CURSOR_ARTIFACT_NAME_CHARS, Math.floor(Math.max(0, remaining - sizeChars) / 3));
            const name = bounded(value.path, pathLimit);
            if (!name.text) break;
            const id = opaqueId(name.text, "cursor-artifact-");
            const fixedChars = id.length + name.text.length * 2 + sizeChars;
            if (fixedChars > remaining) break;
            const updatedAt = typeof value.updatedAt === "string"
                ? bounded(value.updatedAt, Math.min(MAX_CURSOR_EVENT_STATUS_CHARS, remaining - fixedChars)).text
                : undefined;
            const used = fixedChars + (updatedAt?.length ?? 0);
            if (used > remaining) break;
            artifacts.push({
                id,
                name: name.text,
                path: name.text,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
                ...(updatedAt ? { updatedAt } : {}),
            });
            remaining -= used;
        }
        return artifacts;
    }

    /** Artifact lookup is optional and must never prevent terminal settlement. */
    private async completionArtifacts(): Promise<readonly SubagentArtifact[]> {
        if (!this.agent) return [];
        // Attach rejection handling before the timeout race. A late SDK rejection must
        // not become an unhandled failure after terminal settlement has continued.
        let listed: Promise<readonly SubagentArtifact[]>;
        try {
            listed = Promise.resolve(this.agent.listArtifacts())
                .then((values) => this.normalizeArtifacts(values))
                .catch(() => [] as readonly SubagentArtifact[]);
        } catch {
            return [];
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const timedOut = new Promise<readonly SubagentArtifact[]>((resolve) => {
                timer = setTimeout(() => resolve([]), this.artifactListTimeoutMs);
            });
            return await Promise.race([listed, timedOut]);
        } catch {
            return [];
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async emitFinalUsage(run: SubagentRun, resultUsage: unknown): Promise<SubagentUsage | undefined> {
        let usage = usageFrom(resultUsage) ?? usageFrom(this.runs.get(run.id)?.usage);
        const agent = this.agent;
        if (agent) {
            // Usage is optional. Bound it so a billing lookup cannot delay authoritative
            // terminal settlement. The handled promise also absorbs a late SDK rejection.
            let lookup: Promise<unknown>;
            try {
                lookup = Promise.resolve(agent.getUsage({ runId: run.id })).catch(() => undefined);
            } catch {
                lookup = Promise.resolve(undefined);
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const timedOut = new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => resolve(undefined), this.usageTimeoutMs);
                });
                const raw = await Promise.race([lookup, timedOut]);
                if (isRecord(raw) && Array.isArray(raw.runs)) {
                    const runUsage = raw.runs.find((entry) => isRecord(entry) && entry.runId === run.id);
                    usage = mergeUsage(usage, usageFrom(runUsage));
                } else {
                    usage = mergeUsage(usage, usageFrom(raw));
                }
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        if (this.finalizedUsageRuns.has(run.id)) return usage;
        this.finalizedUsageRuns.add(run.id);
        while (this.finalizedUsageRuns.size > MAX_CURSOR_RETAINED_COMPLETIONS) {
            const first = this.finalizedUsageRuns.values().next().value;
            if (first === undefined) break;
            this.finalizedUsageRuns.delete(first);
        }
        if (!usage) return undefined;
        const delta = remainingUsage(usage, this.streamedUsageByRun.get(run.id));
        if (delta) this.options.onEvent({ type: "usage_update", run, usage: delta });
        return usage;
    }

    private emitStreamUsage(run: SubagentRun, usage: SubagentUsage): void {
        this.streamedUsageByRun.set(run.id, sumUsage(this.streamedUsageByRun.get(run.id), usage));
        while (this.streamedUsageByRun.size > MAX_CURSOR_RETAINED_COMPLETIONS) {
            const first = this.streamedUsageByRun.keys().next().value;
            if (first === undefined) break;
            this.streamedUsageByRun.delete(first);
            this.finalizedUsageRuns.delete(first);
        }
        this.options.onEvent({ type: "usage_update", run, usage });
    }

    /** Retain a small, deduplicated warning set for the authoritative completion. */
    private addRuntimeWarnings(warnings: readonly string[]): void {
        for (const warning of warnings) {
            const safe = bounded(warning, MAX_CURSOR_EVENT_STATUS_CHARS).text.trim();
            if (!safe || this.runtimeWarnings.includes(safe) || this.runtimeWarnings.length >= MAX_CURSOR_RUNTIME_WARNINGS) continue;
            this.runtimeWarnings.push(safe);
        }
        this.diagnostics = this.runtimeWarnings.join(" ");
    }

    private boundedRuntimeWarnings(): readonly string[] {
        return [...new Set(this.runtimeWarnings)].slice(0, MAX_CURSOR_RUNTIME_WARNINGS);
    }

    private policyWarningsFor(value: unknown): readonly string[] {
        if (!isRecord(value)) return [];
        const branches = Array.isArray(value.branches) ? value.branches : [value];
        const unexpected = branches.some((branch) => isRecord(branch) && (
            typeof branch.prUrl === "string" || typeof branch.branch === "string"
        ));
        return unexpected
            ? ["Cursor Cloud reported branch or pull-request metadata despite the no-change policy."]
            : [];
    }

    private reportPolicyWarnings(run: SubagentRun, warnings: readonly string[]): void {
        for (const warning of [...new Set(warnings)].slice(0, 4)) {
            const safe = bounded(warning, MAX_CURSOR_EVENT_STATUS_CHARS);
            if (!safe.text) continue;
            this.options.onEvent({ type: "policy_warning", run, warning: safe.text, ...(safe.truncated ? { truncated: true } : {}) });
        }
    }

    private async attachDurableObserver(): Promise<void> {
        const runId = this.stored.currentRunId;
        const generation = this.observationGeneration;
        const hasPendingTerminalResult = this.stored.pendingResult.state === "available"
            && this.stored.pendingResult.runId === runId;
        const alreadyRetained = Boolean(runId) && hasPendingTerminalResult
            && (this.finishedRuns.has(runId) || this.completions.has(runId));
        if (!this.canAttachDurableObserver(generation) || !this.stored.remoteCreated
            || (this.stored.remoteLifecycle !== "running" && !hasPendingTerminalResult)
            || !runId || !this.stored.agentId || alreadyRetained
            || this.activeRun?.id === runId || this.attachingObserverRuns.has(runId)) return;
        this.attachingObserverRuns.add(runId);
        try {
            const sdkRun = await this.sdk.getRun(runId, this.stored.agentId);
            if (!this.canAttachDurableObserver(generation)) return;
            const stillPendingTerminalResult = this.stored.pendingResult.state === "available"
                && this.stored.pendingResult.runId === sdkRun.id;
            if (sdkRun.id !== this.stored.currentRunId || sdkRun.agentId !== this.stored.agentId
                || (this.stored.remoteLifecycle !== "running" && !stillPendingTerminalResult)
                || this.activeRun?.id === sdkRun.id) return;
            const run = {
                id: sdkRun.id,
                runtime: "cursor-cloud" as const,
                parentOwned: this.storedRunIsParentOwned(sdkRun.id),
            };
            if (!this.canAttachDurableObserver(generation)) return;
            this.activeRun = run;
            this.runs.set(run.id, sdkRun);
            this.options.onEvent({ type: "run_started", run });
            if (!run.parentOwned) {
                this.options.onEvent({ type: "status_update", run, status: "Observing an external Cursor Cloud run." });
            }
            if (runStatus(sdkRun.status) !== "running") {
                // A restored running record can race with remote settlement. A pending
                // terminal result can also be restored while idle. Do not attach wait().
                const result = await this.recoverAfterTransport(run);
                if (!this.canAttachDurableObserver(generation)) return;
                await this.finishRun(run, result);
                return;
            }
            if (!this.canAttachDurableObserver(generation)) return;
            void this.observeRun(run, sdkRun);
        } catch (error) {
            if (!this.canAttachDurableObserver(generation)) return;
            this.setRemoteUnknown();
            throw mapCursorSdkError(error);
        } finally {
            this.attachingObserverRuns.delete(runId);
        }
    }

    private canAttachDurableObserver(generation: number): boolean {
        return this.observing && this.isCurrent() && this.observationGeneration === generation;
    }

    private isActive(run: SubagentRun): boolean {
        return this.activeRun?.id === run.id;
    }

    private storedRunIsParentOwned(runId: string): boolean {
        return this.stored.pendingResult.state !== "none" && this.stored.pendingResult.runId === runId;
    }

    private isParentOwned(run: SubagentRun): boolean {
        return run.parentOwned !== false;
    }

    private syncStored(): void {
        const latest = this.configuration.readStored?.();
        if (!latest || latest.id !== this.stored.id) return;
        this.stored = cloneStored(latest);
        if (this.activeRun && (this.stored.remoteLifecycle !== "running" || this.stored.currentRunId !== this.activeRun.id)) {
            this.runs.delete(this.activeRun.id);
            this.liveAssistantText.delete(this.activeRun.id);
            this.activeRun = undefined;
        }
    }

    private isCurrent(): boolean {
        return this.configuration.isCurrent?.() ?? true;
    }

    private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return this.configuration.runExclusive ? this.configuration.runExclusive(operation) : operation();
    }

    private rememberCompletion(run: SubagentRun, completion: SubagentRunCompletion): void {
        this.completions.set(run.id, completion);
        while (this.completions.size > MAX_CURSOR_RETAINED_COMPLETIONS) {
            const first = this.completions.keys().next().value;
            if (first === undefined) return;
            this.completions.delete(first);
        }
    }

    private rememberFinishedRun(runId: string): void {
        this.finishedRuns.add(runId);
        while (this.finishedRuns.size > MAX_CURSOR_RETAINED_COMPLETIONS) {
            const first = this.finishedRuns.values().next().value;
            if (first === undefined) return;
            this.finishedRuns.delete(first);
        }
    }

    private assertIdleForModelChange(): void {
        if (this.activeRun || this.stored.remoteLifecycle === "running" || this.stored.remoteLifecycle === "stopping"
            || this.stored.remoteLifecycle === "archive-started" || this.stored.remoteLifecycle === "archive-pending"
            || this.stored.remoteLifecycle === "remote-state-unknown") {
            throw new SubagentBackendError("BUSY", "Wait for the Cursor Cloud run to settle before changing its model.", "cursor-cloud");
        }
    }

    /** Save a complete baseline when bounded history permits one. */
    private async setFollowUpPending(): Promise<void> {
        if (!this.stored.agentId) {
            throw new SubagentBackendError("REMOTE_NOT_FOUND", "The Cursor Cloud agent was not found. Refresh status before retrying.", "cursor-cloud");
        }
        const listed = boundedRunList(await this.sdk.listRuns(this.stored.agentId));
        // A bounded listing must not block normal follow-ups. Its incomplete marker
        // prevents later absence claims when a lost response cannot be located.
        if (!listed.complete) {
            this.updatePending("follow-up", { baselineComplete: false });
            return;
        }
        let latest: CursorRunMetadata | undefined;
        for (const run of listed.runs) {
            if (run.agentId !== this.stored.agentId) continue;
            const createdAt = validServerRunTime(run);
            if (createdAt === undefined) {
                throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud run history has no usable server timestamp. Refresh status before retrying.", "cursor-cloud");
            }
            if (!latest || createdAt > latest.createdAt!) {
                latest = run;
            } else if (createdAt === latest.createdAt && run.id !== latest.id) {
                throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud run history has an ambiguous latest run. Refresh status before retrying.", "cursor-cloud");
            }
        }
        if (!latest || validServerRunTime(latest) === undefined) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud has no usable server run baseline. Refresh status before retrying.", "cursor-cloud");
        }
        const authoritative = await this.sdk.getRun(latest.id, this.stored.agentId);
        const createdAt = validServerRunTime(authoritative);
        if (authoritative.id !== latest.id || authoritative.agentId !== this.stored.agentId
            || createdAt === undefined || createdAt !== latest.createdAt) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud could not confirm the follow-up baseline. Refresh status before retrying.", "cursor-cloud");
        }
        this.updatePending("follow-up", {
            baselineComplete: true,
            baselineRunId: authoritative.id,
            baselineCreatedAt: createdAt,
        });
    }

    private settleInitialSendAbsent(): void {
        this.clearPending("start-run", false);
        this.stored.remoteCreated = false;
        this.stored.remoteLifecycle = "local";
        this.stored.localLifecycle = "available";
        this.stored.pendingResult = { state: "none" };
        delete this.stored.currentRunId;
        delete this.stored.currentRequestId;
        this.persist();
    }

    private settleAbsentPendingSend(kind: CursorPendingOperationKind): "initial-absent" | "follow-up-absent" {
        if (kind === "start-run") {
            this.settleInitialSendAbsent();
            return "initial-absent";
        }
        this.clearPending(kind, false);
        this.stored.remoteLifecycle = "idle";
        this.stored.localLifecycle = "available";
        this.stored.pendingResult = { state: "none" };
        this.persist();
        return "follow-up-absent";
    }

    private setPending(kind: CursorPendingOperationKind): void {
        if (!this.stored.pendingOperations.some((operation) => operation.kind === kind)) {
            const nonce = kind === "start-run" || kind === "follow-up" ? `send-${randomUUID()}` : undefined;
            this.stored.pendingOperations = [...this.stored.pendingOperations, {
                kind,
                idempotencyKey: deterministicOperationKey(this.stored, kind, nonce),
                createdAt: Date.now(),
                ...(nonce ? { nonce } : {}),
            }];
        }
        this.persist();
    }

    private pendingMarker(kind: CursorPendingOperationKind): string {
        const nonce = this.stored.pendingOperations.find((operation) => operation.kind === kind)?.nonce;
        if (!nonce) throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud could not prepare a request identity. Retry the operation.", "cursor-cloud");
        return cursorCorrelationMarker(nonce);
    }

    private setPendingRequestHash(kind: CursorPendingOperationKind, text: string): void {
        const operation = this.stored.pendingOperations.find((candidate) => candidate.kind === kind);
        if (!operation?.nonce) throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud could not prepare a request identity. Retry the operation.", "cursor-cloud");
        operation.requestHash = cursorRequestHash(text);
        this.persist();
    }

    private updatePending(
        kind: CursorPendingOperationKind,
        values: Pick<NonNullable<StoredCursorSubagent["pendingOperations"]>[number], "baselineComplete" | "baselineRunId" | "baselineCreatedAt">,
    ): void {
        const operation = this.stored.pendingOperations.find((candidate) => candidate.kind === kind);
        if (!operation?.nonce || !operation.requestHash) {
            throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud could not prepare a request identity. Retry the operation.", "cursor-cloud");
        }
        Object.assign(operation, values);
        this.persist();
    }

    private pendingKey(kind: CursorPendingOperationKind): string {
        return this.stored.pendingOperations.find((operation) => operation.kind === kind)?.idempotencyKey
            ?? deterministicOperationKey(this.stored, kind);
    }

    private wasAcceptanceCancelled(signal?: AbortSignal, abortedDuringAcceptance = false): boolean {
        return this.acceptanceCancelled || abortedDuringAcceptance || signal?.aborted === true;
    }

    private throwIfAcceptanceCancelled(signal?: AbortSignal): void {
        if (this.wasAcceptanceCancelled(signal)) {
            throw new SubagentBackendError("CANCELLED", "The Cursor Cloud operation was cancelled.", "cursor-cloud");
        }
    }

    private clearPending(kind: CursorPendingOperationKind, persist = true): void {
        this.stored.pendingOperations = this.stored.pendingOperations.filter((operation) => operation.kind !== kind);
        if (persist) this.persist();
    }

    private setRemoteUnknown(): void {
        if (!this.isCurrent()) return;
        this.stored.remoteLifecycle = "remote-state-unknown";
        this.stored.localLifecycle = "unavailable";
        this.persist();
    }

    private persist(): void {
        if (!this.isCurrent()) return;
        this.configuration.persist(cloneStored(this.stored));
    }
}

async function terminalAfterCancel(sdk: CursorSdkGateway, run: Pick<CursorSdkRun, "id">, agentId: string): Promise<boolean> {
    try {
        await sdk.cancelRun(run.id, agentId);
    } catch {
        // A lost cancellation response can still be successful. Read the run next.
    }
    let current: CursorSdkRun;
    try {
        current = await sdk.getRun(run.id, agentId);
    } catch {
        return false;
    }
    if (current.id !== run.id || current.agentId !== agentId) return false;
    // Do not await wait(). Cancellation must not block on remote completion. A later
    // stop retry can archive only after a terminal authoritative getRun response.
    return runStatus(current.status) !== "running";
}

/** Reconcile stored lifecycle state through documented agent and run operations. */
export function createCursorSubagentLifecyclePort(sdk = new CursorSdkGateway()): CursorSubagentLifecyclePort {
    return {
        async reconcile(stored): Promise<CursorSubagentReconciliation | undefined> {
            if (!stored.agentId) return { remoteLifecycle: "local" };
            try {
                let agent: unknown;
                try {
                    agent = await sdk.getAgent(stored.agentId);
                } catch (error) {
                    const pendingInitial = pendingSend(stored)?.kind === "start-run" && !stored.remoteCreated;
                    if (pendingInitial && mapCursorSdkError(error).code === "REMOTE_NOT_FOUND") {
                        return { remoteLifecycle: "local", clearPendingSend: true };
                    }
                    throw error;
                }
                if (isArchivedAgent(agent)) return { remoteLifecycle: "archived" };
                if (stored.remoteLifecycle === "archive-started" || stored.remoteLifecycle === "archive-pending") {
                    return { remoteLifecycle: "archive-pending" };
                }
                const agentStatus = latestAgentRunStatus(agent);
                const pending = pendingSend(stored);
                const ownedResultRunId = stored.pendingResult.state !== "none"
                    && stored.pendingResult.runId === stored.currentRunId
                    ? stored.pendingResult.runId
                    : undefined;
                // A locally owned result is parent-deliverable authority. Reconcile it
                // before an Agent.get status can adopt a newer external active run.
                if (ownedResultRunId) {
                    const run = await sdk.getRun(ownedResultRunId, stored.agentId);
                    if (run.id !== ownedResultRunId || run.agentId !== stored.agentId
                        || (stored.pendingResult.state === "available" && runStatus(run.status) === "running")) {
                        return { remoteLifecycle: "remote-state-unknown" };
                    }
                    return reconciliationForRun(run, true);
                }
                if (agentStatus === "running") {
                    const active = await findAuthoritativeActiveRun(sdk, stored);
                    if (!active) return { remoteLifecycle: "remote-state-unknown" };
                    if (pending) {
                        const found = await findAcceptedPendingRun(sdk, stored);
                        // Do not discard an uncertain send just because another live
                        // run exists. Only the matching request hash can clear it.
                        if (found.state !== "found" || found.run.id !== active.id) {
                            return { remoteLifecycle: "remote-state-unknown" };
                        }
                    }
                    return reconciliationForRun(active, retainsTerminalResult(stored, active.id, Boolean(pending)));
                }
                if (pending) {
                    const found = await findAcceptedPendingRun(sdk, stored);
                    if (found.state === "found") {
                        const reconciliation = reconciliationForRun(found.run, retainsTerminalResult(stored, found.run.id, true));
                        if (agentStatus !== undefined && reconciliation.remoteLifecycle === "running") {
                            return { remoteLifecycle: "remote-state-unknown" };
                        }
                        return reconciliation;
                    }
                    if (found.state === "not-found") {
                        // Complete inspected history proved this exact saved request
                        // absent. Raw request text is never persisted.
                        return {
                            remoteLifecycle: pending.kind === "start-run" ? "local" : "idle",
                            clearPendingSend: true,
                        };
                    }
                    return { remoteLifecycle: "remote-state-unknown" };
                }
                if (stored.currentRunId) {
                    const run = await sdk.getRun(stored.currentRunId, stored.agentId);
                    if (run.id !== stored.currentRunId || run.agentId !== stored.agentId) {
                        return { remoteLifecycle: "remote-state-unknown" };
                    }
                    // Agent.get says no current running run. A contrary saved-run
                    // response is inconsistent and must not make the record busy.
                    if (agentStatus !== undefined && runStatus(run.status) === "running") {
                        return { remoteLifecycle: "remote-state-unknown" };
                    }
                    return reconciliationForRun(run, retainsTerminalResult(stored, run.id));
                }
                if (agentStatus !== undefined) return { remoteLifecycle: "idle" };
                if (stored.remoteLifecycle === "remote-state-unknown") return { remoteLifecycle: "remote-state-unknown" };
                const listed = boundedRunList(await sdk.listRuns(stored.agentId));
                return listed.complete ? { remoteLifecycle: "idle" } : { remoteLifecycle: "remote-state-unknown" };
            } catch (error) {
                throw mapCursorSdkError(error);
            }
        },
        async stop(stored, progress): Promise<CursorSubagentStopOutcome> {
            if (!stored.agentId) return { state: "stopped" };
            let archiveStarted = stored.remoteLifecycle === "archive-started" || stored.remoteLifecycle === "archive-pending";
            try {
                const pending = pendingSend(stored);
                let confirmedPendingRun: CursorSdkRun | undefined;
                // A lazy ID and its unsent initial request are local-only. A Cloud
                // 404 is a complete answer: there is nothing remote to archive.
                if (!archiveStarted && !stored.remoteCreated) {
                    if (pending?.kind !== "start-run") return { state: "stopped" };
                    const found = await findAcceptedPendingRun(sdk, stored);
                    if (found.state === "not-found") return { state: "stopped" };
                    if (found.state !== "found") return { state: "remote-state-unknown" };
                    confirmedPendingRun = found.run;
                }
                if (!archiveStarted) {
                    const listed = boundedRunList(await sdk.listRuns(stored.agentId));
                    if (pending && !confirmedPendingRun) {
                        const found = await findAcceptedPendingRun(sdk, stored);
                        // Do not archive after an uncertain send if no unique run can
                        // be cancelled and confirmed terminal.
                        if (found.state !== "found") return { state: "remote-state-unknown" };
                        confirmedPendingRun = found.run;
                    }
                    if (confirmedPendingRun && !(await terminalAfterCancel(sdk, confirmedPendingRun, stored.agentId))) {
                        return { state: "remote-state-unknown" };
                    }
                    // Agent.get is authoritative for the latest remote status. Read it
                    // even after a complete history listing, because a page can be stale.
                    const agent = await sdk.getAgent(stored.agentId);
                    if (isArchivedAgent(agent)) return { state: "stopped" };
                    const status = latestAgentRunStatus(agent);
                    if (status === "running") {
                        // A running agent status must identify one currently running run.
                        // Never archive from a complete but contradictory run list.
                        const active = await findAuthoritativeActiveRun(sdk, stored);
                        if (!active || !(await terminalAfterCancel(sdk, active, stored.agentId))) {
                            return { state: "remote-state-unknown" };
                        }
                        const afterCancel = await sdk.getAgent(stored.agentId);
                        if (latestAgentRunStatus(afterCancel) === "running" || latestAgentRunStatus(afterCancel) === undefined) {
                            return { state: "remote-state-unknown" };
                        }
                    } else if (!listed.complete) {
                        if (status === undefined) return { state: "remote-state-unknown" };
                        // A terminal Agent.get status is authoritative even when the
                        // bounded history contains more completed pages.
                    } else {
                        const active = listed.runs.filter((run) => runStatus(run.status) === "running");
                        if (!pending && stored.currentRunId && !active.some((run) => run.id === stored.currentRunId)) {
                            const current = await sdk.getRun(stored.currentRunId, stored.agentId);
                            if (current.id !== stored.currentRunId || current.agentId !== stored.agentId) {
                                return { state: "remote-state-unknown" };
                            }
                            if (runStatus(current.status) === "running") active.push(current);
                        }
                        for (const listedRun of active) {
                            const run = await sdk.getRun(listedRun.id, stored.agentId);
                            if (run.id !== listedRun.id || run.agentId !== stored.agentId) {
                                return { state: "remote-state-unknown" };
                            }
                            if (runStatus(run.status) === "running" && !(await terminalAfterCancel(sdk, run, stored.agentId))) {
                                return { state: "remote-state-unknown" };
                            }
                        }
                        const remaining = boundedRunList(await sdk.listRuns(stored.agentId));
                        if (remaining.complete) {
                            if (remaining.runs.some((run) => runStatus(run.status) === "running")) return { state: "remote-state-unknown" };
                        } else {
                            const refreshed = await sdk.getAgent(stored.agentId);
                            if (latestAgentRunStatus(refreshed) === "running" || latestAgentRunStatus(refreshed) === undefined) {
                                return { state: "remote-state-unknown" };
                            }
                        }
                    }
                }
                progress.persistArchiveStarted();
                archiveStarted = true;
                await sdk.archiveAgent(stored.agentId);
                return { state: "stopped" };
            } catch (error) {
                const mapped = mapCursorSdkError(error);
                if (mapped.code === "REMOTE_NOT_FOUND") {
                    if (!stored.remoteCreated && pendingSend(stored)?.kind === "start-run") return { state: "stopped" };
                    throw mapped;
                }
                return archiveStarted ? { state: "archive-pending" } : { state: "remote-state-unknown" };
            }
        },
        async disposeObservers(): Promise<void> {
            // The registry has no local handle after restore. There is no remote action.
        },
    };
}
