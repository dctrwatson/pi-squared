import { createHash } from "node:crypto";
import type { AssistantMessage, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import {
    generateBranchSummary,
    prepareBranchEntries,
    type ExtensionContext,
    type GenerateBranchSummaryOptions,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SubagentBackendError } from "./backend.ts";
import { selectForkSnapshotEntries } from "./fork.ts";
import type { SubagentContextMode, SubagentLifetime, SubagentPersona } from "./personas.ts";

export const MAX_CURSOR_BOOTSTRAP_BYTES = 24 * 1024;
export const MAX_CURSOR_FOLLOW_UP_BYTES = 6 * 1024;
export const MAX_CURSOR_FORK_SUMMARY_BYTES = 8 * 1024;
export const MAX_CURSOR_FORK_SOURCE_ENTRIES = 96;
export const MAX_CURSOR_FORK_SOURCE_BLOCKS = 128;
export const MAX_CURSOR_FORK_SOURCE_BYTES = 24 * 1024;
export const MAX_CURSOR_FORK_SOURCE_IDS = MAX_CURSOR_FORK_SOURCE_ENTRIES;
const MAX_PERSONA_BODY_BYTES = 6 * 1024;
const MAX_PARENT_CONTEXT_BYTES = 4 * 1024;
const MAX_REQUEST_BYTES = 6 * 1024;
const MAX_FORK_SOURCE_TOKENS = 6_000;
const MIN_FORK_SOURCE_TOKENS = 512;
const MIN_FORK_SUMMARY_OVERHEAD_TOKENS = 16_384;
const MAX_FORK_TEXT_BLOCKS_PER_ENTRY = 4;
const MAX_FORK_TEXT_BLOCK_BYTES = 2 * 1024;
const MAX_FORK_ENTRY_ID_CHARS = 128;
const EPOCH_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const EMPTY_USAGE: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface CursorForkHandoffMetadata {
    readonly mode: "fork";
    readonly inheritedEntryIds: readonly string[];
    readonly latestUserEntryId: string;
    readonly summarySha256: string;
    readonly summaryBytes: number;
}

/** The summary is ephemeral. Persist only metadata from this object. */
export interface CursorForkHandoff {
    readonly summary: string;
    readonly metadata: CursorForkHandoffMetadata;
}

export interface PersistedCursorForkHandoff {
    readonly mode: "fork";
    readonly inheritedEntryIds: readonly string[];
    readonly latestUserEntryId: string;
    readonly summarySha256: string;
    readonly summaryBytes: number;
}

export interface CursorForkSummarySource {
    /** Sanitized and bounded entries through the latest parent user request. */
    readonly entries: readonly SessionEntry[];
    /** Pi branch-summary preparation gives the generator bounded source messages. */
    readonly messages: readonly unknown[];
    readonly entryIds: readonly string[];
    readonly latestUserEntryId: string;
    readonly entryCount: number;
    readonly blockCount: number;
    readonly textBytes: number;
    readonly instructions: string;
}

export interface CursorForkSummaryGenerator {
    generate(source: CursorForkSummarySource): Promise<string>;
}

export interface CursorForkParentSession {
    getBranch(): SessionEntry[];
}

/** The Pi data that an operational in-memory fork summary needs. */
export interface CursorPiForkContext {
    readonly model: ExtensionContext["model"];
    readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;
    readonly sessionManager: CursorForkParentSession;
}

export type CursorBranchSummaryPrimitive = (
    entries: SessionEntry[],
    options: GenerateBranchSummaryOptions,
) => Promise<{ readonly summary?: string; readonly error?: string; readonly aborted?: boolean }>;

export interface CursorPiForkSummaryGeneratorOptions {
    readonly context: CursorPiForkContext;
    readonly signal: AbortSignal;
    readonly generate?: CursorBranchSummaryPrimitive;
}

export interface CursorBootstrapOptions {
    readonly mode: SubagentContextMode;
    readonly persona?: Pick<SubagentPersona, "name" | "systemPrompt" | "cursorMcps">;
    readonly purpose: string;
    readonly lifetime: SubagentLifetime;
    readonly request: string;
    readonly parentContext?: string;
    readonly forkHandoff?: CursorForkHandoff;
}

export const CURSOR_FORK_SUMMARY_INSTRUCTIONS = [
    "Create a bounded standalone handoff for a Cursor Cloud analysis agent.",
    "Preserve the goal, current request, constraints, decisions, progress, relevant paths, Git state, blockers, and next steps.",
    "Do not include credentials, raw tool output, or repository source content that Cursor can inspect from the repository.",
    "Do not include hidden reasoning, tool arguments, tool results, or the in-progress subagent call.",
    "Use concise sections and facts only.",
].join("\n");

function utf8Prefix(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
}

function boundedText(text: string, maxBytes: number): string {
    const normalized = text.replace(/\u0000/g, "").trim();
    if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return normalized;
    const suffix = "\n[Content limited]";
    return `${utf8Prefix(normalized, maxBytes - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

/** Remove credential forms before any parent context reaches Cursor or a summary generator. */
export function redactCursorHandoffCredentials(text: string): string {
    return text
        .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/gi, "[Private key omitted]")
        .replace(/(['\"`])(?:cookie|set-cookie)[ \t]*:[^\r\n]*?\1/gi, "$1[Cookie omitted]$1")
        .replace(/\b(?:cookie|set-cookie)[ \t]*:[^\r\n'\"`]+/gi, "[Cookie omitted]")
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, "$1[credential omitted]@")
        .replace(/([?&;](?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|oauth[_-]?token|token|api[_-]?key|key|client[_-]?secret|password|passwd|secret)=)([^&#\s]*)/gi, "$1[redacted]")
        .replace(/\b(session(?:id|[_-]?(?:id|token|key))?|connect\.sid|jsessionid|phpsessid|jwt(?:[_-]?(?:token|session))?)[ \t]*([:=])[ \t]*(?:\"[^\"]*\"|'[^']*'|`[^`]*`|[^\s;,\r\n]+)/gi, "$1$2[redacted]")
        .replace(/\b(CURSOR_API_KEY|(?:api[_-]?key)|(?:access|refresh|id|session|oauth)[_-]?token|token|authorization|auth|client[_-]?secret|password|passwd|pwd|private[_-]?key|secret)[ \t]*([:=])[ \t]*(?:\"[^\"]*\"|'[^']*'|`[^`]*`|[^\s]+)/gi, "$1$2[redacted]")
        .replace(/\b(Authorization)[ \t]*:[ \t]*[^\s]+(?:[ \t]+[^\s]+)?/gi, "$1: [redacted]")
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[redacted]");
}

/** Remove repository source only from generated fork material. */
export function omitCursorRepositorySource(text: string): string {
    return text
        .replace(/```[\s\S]*?(?:```|$)/g, "[Repository source omitted]")
        .replace(/<code>[\s\S]*?<\/code>/gi, "[Repository source omitted]");
}

function sanitizeCloudText(text: string, maxBytes: number): string {
    return boundedText(redactCursorHandoffCredentials(text), maxBytes);
}

function sanitizeForkText(text: string, maxBytes: number): string {
    return boundedText(omitCursorRepositorySource(redactCursorHandoffCredentials(text)), maxBytes);
}

function sourceId(value: string): string {
    if (/^[A-Za-z0-9_-]+$/.test(value) && value.length <= MAX_FORK_ENTRY_ID_CHARS
        && !/(?:secret|token|key|password|credential)/i.test(value)) return value;
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function timestamp(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function forkTextBlocks(content: unknown): TextContent[] {
    const values = typeof content === "string"
        ? [content]
        : Array.isArray(content)
            ? content.slice(0, MAX_FORK_TEXT_BLOCKS_PER_ENTRY).flatMap((block) =>
                typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
                    && typeof (block as { text?: unknown }).text === "string"
                    ? [(block as { text: string }).text]
                    : [])
            : [];
    return values.slice(0, MAX_FORK_TEXT_BLOCKS_PER_ENTRY)
        .map((text) => ({ type: "text" as const, text: sanitizeForkText(text, MAX_FORK_TEXT_BLOCK_BYTES) }))
        .filter((block) => Boolean(block.text));
}

function entryBase(entry: SessionEntry): { readonly id: string; readonly parentId: null; readonly timestamp: string } {
    return { id: sourceId(entry.id), parentId: null, timestamp: EPOCH_TIMESTAMP };
}

/** Exclude tool results, tool calls, thinking, images, custom data, and error fields. */
function sanitizeForkEntry(entry: SessionEntry): SessionEntry | undefined {
    const base = entryBase(entry);
    if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "toolResult" || !("content" in message)) return undefined;
        const content = forkTextBlocks(message.content);
        if (content.length === 0) return undefined;
        if (message.role === "user") {
            const user: UserMessage = { role: "user", content, timestamp: timestamp(message.timestamp) };
            return { type: "message", ...base, message: user };
        }
        if (message.role === "assistant") {
            const assistant: AssistantMessage = {
                role: "assistant",
                content,
                api: "unknown",
                provider: "unknown",
                model: "unknown",
                usage: EMPTY_USAGE,
                stopReason: "stop",
                timestamp: timestamp(message.timestamp),
            };
            return { type: "message", ...base, message: assistant };
        }
        return undefined;
    }
    if (entry.type === "compaction") {
        return {
            type: "compaction",
            ...base,
            summary: sanitizeForkText(entry.summary, MAX_FORK_TEXT_BLOCK_BYTES),
            firstKeptEntryId: "",
            tokensBefore: 0,
        };
    }
    if (entry.type === "branch_summary") {
        return { type: "branch_summary", ...base, fromId: "", summary: sanitizeForkText(entry.summary, MAX_FORK_TEXT_BLOCK_BYTES) };
    }
    return undefined;
}

function forkEntryStats(entry: SessionEntry): { readonly blocks: number; readonly bytes: number } {
    if (entry.type === "message" && "content" in entry.message) {
        const content = entry.message.content;
        const texts = typeof content === "string"
            ? [content]
            : Array.isArray(content)
                ? content.flatMap((block) => typeof block === "object" && block !== null && block.type === "text"
                    ? [block.text]
                    : [])
                : [];
        return {
            blocks: texts.length,
            bytes: texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0),
        };
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
        return { blocks: 1, bytes: Buffer.byteLength(entry.summary, "utf8") };
    }
    return { blocks: 0, bytes: 0 };
}

function contextFailure(): SubagentBackendError {
    return new SubagentBackendError(
        "BACKEND_FAILED",
        "Cursor Cloud fork context could not be created. Retry with mode \"fresh\" or resolve the Pi summary error.",
        "cursor-cloud",
    );
}

/**
 * Build fully bounded, sanitized input for a Pi branch-summary generator. The
 * source comes from the effective in-memory branch, so ephemeral sessions work.
 */
export function prepareCursorForkSummarySource(branch: readonly SessionEntry[]): CursorForkSummarySource {
    let selected: SessionEntry[];
    try {
        selected = selectForkSnapshotEntries(branch).slice(-MAX_CURSOR_FORK_SOURCE_ENTRIES);
    } catch {
        throw contextFailure();
    }
    const latestUser = selected.at(-1);
    if (!latestUser || latestUser.type !== "message" || latestUser.message.role !== "user") throw contextFailure();

    const entries: SessionEntry[] = [];
    let blockCount = 0;
    let textBytes = 0;
    for (let index = selected.length - 1; index >= 0; index--) {
        const candidate = sanitizeForkEntry(selected[index]!);
        if (!candidate) continue;
        const stats = forkEntryStats(candidate);
        if (entries.length >= MAX_CURSOR_FORK_SOURCE_ENTRIES
            || blockCount + stats.blocks > MAX_CURSOR_FORK_SOURCE_BLOCKS
            || textBytes + stats.bytes > MAX_CURSOR_FORK_SOURCE_BYTES) continue;
        entries.unshift(candidate);
        blockCount += stats.blocks;
        textBytes += stats.bytes;
    }
    const latestUserEntryId = sourceId(latestUser.id);
    if (!entries.some((entry) => entry.id === latestUserEntryId)) throw contextFailure();
    const preparation = prepareBranchEntries(entries, MAX_FORK_SOURCE_TOKENS);
    const entryIds = entries.map((entry) => entry.id).slice(-MAX_CURSOR_FORK_SOURCE_IDS);
    return {
        entries,
        messages: preparation.messages,
        entryIds,
        latestUserEntryId,
        entryCount: entries.length,
        blockCount,
        textBytes,
        instructions: CURSOR_FORK_SUMMARY_INSTRUCTIONS,
    };
}

/** Generate an ephemeral fork handoff. The caller can persist metadata only. */
export async function createCursorForkHandoff(
    branch: readonly SessionEntry[],
    generator: CursorForkSummaryGenerator,
): Promise<CursorForkHandoff> {
    let source: CursorForkSummarySource;
    let summary: string;
    try {
        source = prepareCursorForkSummarySource(branch);
        summary = await generator.generate(source);
    } catch {
        throw contextFailure();
    }
    const text = sanitizeForkText(summary, MAX_CURSOR_FORK_SUMMARY_BYTES);
    if (!text) throw contextFailure();
    return {
        summary: text,
        metadata: {
            mode: "fork",
            inheritedEntryIds: [...source.entryIds],
            latestUserEntryId: source.latestUserEntryId,
            summarySha256: createHash("sha256").update(text, "utf8").digest("hex"),
            summaryBytes: Buffer.byteLength(text, "utf8"),
        },
    };
}

/** Build a handoff directly from Pi's effective in-memory branch. */
export async function createCursorForkHandoffFromSession(
    session: CursorForkParentSession,
    generator: CursorForkSummaryGenerator,
): Promise<CursorForkHandoff> {
    return createCursorForkHandoff(session.getBranch(), generator);
}

/** Create an operational Pi branch-summary generator with no Cursor dependency. */
export function createPiCursorForkSummaryGenerator(options: CursorPiForkSummaryGeneratorOptions): CursorForkSummaryGenerator {
    const primitive = options.generate ?? generateBranchSummary;
    return {
        async generate(source) {
            const model = options.context.model;
            if (!model || options.signal.aborted) throw contextFailure();
            let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
            try {
                auth = await options.context.modelRegistry.getApiKeyAndHeaders(model);
            } catch {
                throw contextFailure();
            }
            if (!auth.ok) throw contextFailure();
            const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0
                ? model.contextWindow
                : 128_000;
            if (contextWindow < MIN_FORK_SUMMARY_OVERHEAD_TOKENS + MIN_FORK_SOURCE_TOKENS) throw contextFailure();
            const sourceBudget = Math.min(MAX_FORK_SOURCE_TOKENS, contextWindow - MIN_FORK_SUMMARY_OVERHEAD_TOKENS);
            if (sourceBudget <= 0) throw contextFailure();
            const reserveTokens = contextWindow - sourceBudget;
            const headers = auth.headers
                ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
                : undefined;
            let result: { readonly summary?: string; readonly error?: string; readonly aborted?: boolean };
            try {
                result = await primitive([...source.entries], {
                    model,
                    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
                    ...(headers ? { headers } : {}),
                    ...(auth.env ? { env: auth.env } : {}),
                    signal: options.signal,
                    customInstructions: source.instructions,
                    reserveTokens,
                });
            } catch {
                throw contextFailure();
            }
            if (options.signal.aborted || result.aborted || result.error || !result.summary?.trim()) throw contextFailure();
            return result.summary;
        },
    };
}

/** Generate a fork handoff with the active Pi model and in-memory session branch. */
export async function createCursorForkHandoffWithPiSummary(
    options: CursorPiForkSummaryGeneratorOptions,
): Promise<CursorForkHandoff> {
    return createCursorForkHandoff(
        options.context.sessionManager.getBranch(),
        createPiCursorForkSummaryGenerator(options),
    );
}

/** Return the only fork handoff data that may enter persisted Cursor state. */
export function persistableCursorForkHandoff(handoff: CursorForkHandoff): PersistedCursorForkHandoff {
    const hash = /^[a-f0-9]{64}$/i.test(handoff.metadata.summarySha256)
        ? handoff.metadata.summarySha256.toLowerCase()
        : createHash("sha256").update(handoff.metadata.summarySha256, "utf8").digest("hex");
    return {
        mode: "fork",
        inheritedEntryIds: handoff.metadata.inheritedEntryIds
            .slice(0, MAX_CURSOR_FORK_SOURCE_IDS)
            .map(sourceId),
        latestUserEntryId: sourceId(handoff.metadata.latestUserEntryId),
        summarySha256: hash,
        summaryBytes: Number.isFinite(handoff.metadata.summaryBytes)
            ? Math.max(0, Math.min(MAX_CURSOR_FORK_SUMMARY_BYTES, handoff.metadata.summaryBytes))
            : 0,
    };
}

/** Build the first Cloud prompt. Persona MCP names remain text-only metadata. */
export function buildCursorCloudBootstrap(options: CursorBootstrapOptions): string {
    if (options.mode === "fork" && !options.forkHandoff) throw contextFailure();
    const personaBody = options.persona?.systemPrompt
        ? sanitizeCloudText(options.persona.systemPrompt, MAX_PERSONA_BODY_BYTES)
        : "Inspect the requested scope and return concise evidence.";
    const personaName = sanitizeCloudText(options.persona?.name ?? "Cursor Cloud subagent", 128) || "Cursor Cloud subagent";
    const purpose = sanitizeCloudText(options.purpose, 512) || "Investigate the requested scope.";
    const request = sanitizeCloudText(options.request, MAX_REQUEST_BYTES);
    if (!request) throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud requires a request before it can start.", "cursor-cloud");
    const expectedMcps = (options.persona?.cursorMcps ?? [])
        .map((name) => sanitizeCloudText(name, 64))
        .filter(Boolean)
        .slice(0, 8);
    const sections = [
        "## Agent role",
        "",
        personaBody,
        "",
        "## Purpose and operating instructions",
        "",
        `Name: ${personaName}`,
        `Purpose: ${purpose}`,
        `Lifetime: ${options.lifetime}`,
        "Inspect and plan only. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations.",
        "If an expected capability or required data is unavailable, stop and lead with exactly:",
        "BLOCKED: <reason>",
        "NEEDS: <minimum requirement>",
        "",
        "## Cursor Cloud capabilities",
        "",
        expectedMcps.length ? `Expected MCP servers: ${expectedMcps.join(", ")}.` : "Expected MCP servers: none specified.",
    ];
    if (options.mode === "fork") {
        sections.push("", "## Inherited Pi context", "", sanitizeForkText(options.forkHandoff!.summary, MAX_CURSOR_FORK_SUMMARY_BYTES));
    }
    const parentContext = options.parentContext ? sanitizeCloudText(options.parentContext, MAX_PARENT_CONTEXT_BYTES) : "";
    if (parentContext) sections.push("", "## Parent-provided context", "", parentContext);
    sections.push("", "## Request", "", request);
    const bootstrap = sections.join("\n");
    if (Buffer.byteLength(bootstrap, "utf8") > MAX_CURSOR_BOOTSTRAP_BYTES) {
        throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud bootstrap exceeds its context limit. Reduce persona context or the request.", "cursor-cloud");
    }
    return bootstrap;
}

/** Repeat bounded operating constraints because Cloud follow-ups share remote context. */
export function buildCursorCloudFollowUp(text: string, lifetime: SubagentLifetime = "persistent"): string {
    const guidance = [
        "## Current operating constraints",
        `Lifetime: ${lifetime}`,
        "Inspect and plan only. Do not edit, commit, push, create branches, create pull requests, or use mutating MCP operations.",
        "## Follow-up request",
    ].join("\n");
    const requestLimit = MAX_CURSOR_FOLLOW_UP_BYTES - Buffer.byteLength(guidance, "utf8") - 2;
    const prompt = sanitizeCloudText(text, Math.max(1, requestLimit));
    if (!prompt) throw new SubagentBackendError("BACKEND_FAILED", "Cursor Cloud follow-up requires a request.", "cursor-cloud");
    return `${guidance}\n${prompt}`;
}
