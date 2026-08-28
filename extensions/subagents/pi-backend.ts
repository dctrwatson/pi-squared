import { createHash, randomUUID } from "node:crypto";
import type {
    RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import {
    SubagentRpcClient,
    type SubagentRpcClientOptions,
    type SubagentRpcOutput,
} from "./rpc.ts";
import {
    AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE,
    capAuthoritativeCompletionText,
    MAX_AUTHORITATIVE_COMPLETION_BYTES,
    SubagentBackendError,
    type SubagentBackend,
    type SubagentBackendEvent,
    type SubagentBackendFactory,
    type SubagentBackendOptions,
    type SubagentBackendState,
    type SubagentExtensionUiRequest,
    type SubagentExtensionUiResponse,
    type SubagentHistoryMessage,
    type SubagentModel,
    type SubagentPromptRequestResult,
    type SubagentRun,
    type SubagentRunCompletion,
    type SubagentSessionStats,
    type SubagentThinkingLevel,
    type SubagentUsage,
} from "./backend.ts";

const PI_CAPABILITIES = {
    extensionUi: true,
    steering: true,
    queuedFollowUp: true,
    settledFollowUp: false,
    modelControls: true,
    thinkingControls: true,
    sessionHistory: true,
    sessionFile: true,
    usage: true,
    toolOutput: true,
} as const;

/** Pi acknowledges prompts before it starts ordinary agent runs. */
export const PI_PROMPT_RECONCILIATION_DELAY_MS = 25;
export const MAX_NORMALIZED_MESSAGE_TEXT_CHARS = 64 * 1024;
export const MAX_NORMALIZED_THINKING_CHARS = 32 * 1024;
export const MAX_NORMALIZED_DELTA_CHARS = 16 * 1024;
export const MAX_NORMALIZED_TOOL_OUTPUT_CHARS = 64 * 1024;
export const MAX_NORMALIZED_TOOL_ARGS_CHARS = 8 * 1024;
export const MAX_NORMALIZED_ID_CHARS = 512;
export const MAX_NORMALIZED_ERROR_CHARS = 4 * 1024;
export const MAX_NORMALIZED_EXTENSION_UI_ITEMS = 500;
export const MAX_NORMALIZED_EXTENSION_UI_STRING_CHARS = 256 * 1024;
export const MAX_NORMALIZED_EXTENSION_UI_TOTAL_CHARS = 512 * 1024;
export const MAX_RETAINED_RUN_COMPLETIONS = 8;
export const MAX_RETAINED_RUN_COMPLETION_BYTES = MAX_AUTHORITATIVE_COMPLETION_BYTES;
export const RUN_COMPLETION_TRUNCATION_NOTICE = AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE;

// Normalized event limits protect controller state. getHistory keeps the full
// Pi session content for hydration and prompt attribution.

interface PiRpcClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    getStderr(): string;
    prompt(message: string, signal?: AbortSignal): Promise<void>;
    steer(message: string): Promise<void>;
    followUp(message: string, signal?: AbortSignal): Promise<void>;
    abort(): Promise<void>;
    getState(): Promise<unknown>;
    getMessages(): Promise<unknown>;
    getSessionStats(): Promise<unknown>;
    getAvailableModels(): Promise<unknown>;
    setModel(provider: string, modelId: string): Promise<unknown>;
    cycleModel(): Promise<unknown>;
    setThinkingLevel(level: SubagentThinkingLevel): Promise<void>;
    cycleThinkingLevel(): Promise<unknown>;
    respondToExtensionUI(response: RpcExtensionUIResponse): void;
}

type PiRpcFactory = (options: SubagentRpcClientOptions) => PiRpcClient;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isThinkingLevel(value: unknown): value is SubagentThinkingLevel {
    return value === "off"
        || value === "minimal"
        || value === "low"
        || value === "medium"
        || value === "high"
        || value === "xhigh"
        || value === "max";
}

function boundedText(value: string, maximum: number): { readonly text: string; readonly truncated: boolean } {
    return value.length <= maximum
        ? { text: value, truncated: false }
        : { text: value.slice(0, maximum), truncated: true };
}

function fullTextFingerprint(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function opaqueIdentifier(value: string, namespace: string): string {
    if (value.length <= MAX_NORMALIZED_ID_CHARS) return value;
    return `${namespace}${createHash("sha256").update(value).digest("hex")}`;
}

function messageText(message: Record<string, unknown>): string {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content
        .filter(isRecord)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
}

function assistantThinking(message: Record<string, unknown>): string {
    if (!Array.isArray(message.content)) return "";
    return message.content
        .filter(isRecord)
        .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
        .map((part) => part.thinking as string)
        .join("\n");
}

function resultText(result: unknown): string {
    if (!isRecord(result) || !Array.isArray(result.content)) return "";
    return result.content
        .filter(isRecord)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
}

function usageFrom(value: unknown): SubagentUsage | undefined {
    if (!isRecord(value)) return undefined;
    const cost = isRecord(value.cost) ? value.cost : {};
    return {
        input: numberOrZero(value.input),
        output: numberOrZero(value.output),
        cacheRead: numberOrZero(value.cacheRead),
        cacheWrite: numberOrZero(value.cacheWrite),
        totalTokens: numberOrZero(value.totalTokens),
        cost: {
            input: numberOrZero(cost.input),
            output: numberOrZero(cost.output),
            cacheRead: numberOrZero(cost.cacheRead),
            cacheWrite: numberOrZero(cost.cacheWrite),
            total: numberOrZero(cost.total),
        },
    };
}

function modelFrom(value: unknown): SubagentModel | undefined {
    if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
    return {
        provider: value.provider,
        id: value.id,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) ? { contextWindow: value.contextWindow } : {}),
        ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    };
}

function formatToolArgs(name: string, args: unknown): string {
    if (!isRecord(args)) return "";
    const pathValue = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
    let text: string;
    switch (name) {
        case "read":
        case "ls":
        case "write":
        case "edit":
            text = pathValue ?? "";
            break;
        case "grep": {
            const pattern = typeof args.pattern === "string" ? args.pattern : "";
            text = `${pattern ? `/${pattern}/` : ""}${pathValue ? ` in ${pathValue}` : ""}`;
            break;
        }
        case "find": {
            const pattern = typeof args.pattern === "string" ? args.pattern : "*";
            text = `${pattern}${pathValue ? ` in ${pathValue}` : ""}`;
            break;
        }
        case "bash":
            text = typeof args.command === "string" ? (args.command.split("\n")[0] ?? "") : "";
            break;
        default: {
            const json = JSON.stringify(args);
            text = json.length > 100 ? `${json.slice(0, 99)}…` : json;
            break;
        }
    }
    return text;
}

function historyMessage(value: unknown): SubagentHistoryMessage | undefined {
    if (!isRecord(value)) return undefined;
    if (value.role === "user") {
        const text = messageText(value);
        return text ? { role: "user", text } : undefined;
    }
    if (value.role !== "assistant") return undefined;
    return {
        role: "assistant",
        text: messageText(value),
        thinking: assistantThinking(value),
        ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
        ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
        ...(usageFrom(value.usage) ? { usage: usageFrom(value.usage) } : {}),
    };
}

function extensionUiRequest(
    output: SubagentRpcOutput,
    normalizeExtensionUiId: (id: string) => string,
): SubagentExtensionUiRequest | undefined {
    if (output.type !== "extension_ui_request" || typeof output.method !== "string") return undefined;
    let remaining = MAX_NORMALIZED_EXTENSION_UI_TOTAL_CHARS;
    let truncated = false;
    const take = (value: string, maximum = MAX_NORMALIZED_EXTENSION_UI_STRING_CHARS): string => {
        const limit = Math.min(maximum, remaining);
        const bounded = boundedText(value, limit);
        remaining -= bounded.text.length;
        truncated ||= bounded.truncated;
        return bounded.text;
    };
    const requiresResponse = output.method === "select" || output.method === "confirm"
        || output.method === "input" || output.method === "editor";
    const id = requiresResponse && typeof output.id === "string"
        ? take(normalizeExtensionUiId(output.id), MAX_NORMALIZED_ID_CHARS)
        : undefined;
    const withTruncation = <T extends object>(request: T): T | (T & { readonly truncated: true }) =>
        truncated ? { ...request, truncated: true } : request;
    const stringItems = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        const items: string[] = [];
        for (const item of value) {
            if (typeof item !== "string") continue;
            if (items.length >= MAX_NORMALIZED_EXTENSION_UI_ITEMS || remaining === 0) {
                truncated = true;
                break;
            }
            items.push(take(item));
        }
        return items;
    };
    const timeout = typeof output.timeout === "number" && Number.isFinite(output.timeout)
        ? { timeout: output.timeout }
        : {};

    switch (output.method) {
        case "select":
            return typeof output.title === "string" && id !== undefined
                ? withTruncation({ method: "select" as const, id, title: take(output.title), options: stringItems(output.options), ...timeout })
                : undefined;
        case "confirm":
            return typeof output.title === "string" && typeof output.message === "string" && id !== undefined
                ? withTruncation({ method: "confirm" as const, id, title: take(output.title), message: take(output.message), ...timeout })
                : undefined;
        case "input":
            return typeof output.title === "string" && id !== undefined
                ? withTruncation({
                    method: "input" as const,
                    id,
                    title: take(output.title),
                    ...(typeof output.placeholder === "string" ? { placeholder: take(output.placeholder) } : {}),
                    ...timeout,
                })
                : undefined;
        case "editor":
            return typeof output.title === "string" && id !== undefined
                ? withTruncation({
                    method: "editor" as const,
                    id,
                    title: take(output.title),
                    ...(typeof output.prefill === "string" ? { prefill: take(output.prefill) } : {}),
                })
                : undefined;
        case "notify": {
            const notifyType = output.notifyType === "info" || output.notifyType === "warning" || output.notifyType === "error"
                ? output.notifyType as "info" | "warning" | "error"
                : undefined;
            return typeof output.message === "string"
                ? withTruncation({
                    method: "notify" as const,
                    message: take(output.message),
                    ...(notifyType ? { notifyType } : {}),
                })
                : undefined;
        }
        case "setStatus":
            return typeof output.statusKey === "string"
                ? withTruncation({
                    method: "setStatus" as const,
                    statusKey: take(opaqueIdentifier(output.statusKey, "pi-status-"), MAX_NORMALIZED_ID_CHARS),
                    ...(typeof output.statusText === "string" ? { statusText: take(output.statusText) } : {}),
                })
                : undefined;
        case "setWidget":
            return typeof output.widgetKey === "string"
                ? withTruncation({
                    method: "setWidget" as const,
                    widgetKey: take(opaqueIdentifier(output.widgetKey, "pi-widget-"), MAX_NORMALIZED_ID_CHARS),
                    ...(Array.isArray(output.widgetLines) ? { widgetLines: stringItems(output.widgetLines) } : {}),
                })
                : undefined;
        case "set_editor_text":
            return typeof output.text === "string"
                ? withTruncation({ method: "set_editor_text" as const, text: take(output.text) })
                : undefined;
        case "setTitle":
            return { method: "setTitle" };
        default:
            return undefined;
    }
}

function eventMessage(value: unknown): SubagentHistoryMessage | undefined {
    const message = historyMessage(value);
    if (!message) return undefined;
    if (message.role === "user") {
        const text = boundedText(message.text, MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
        return {
            role: "user",
            text: text.text,
            fullTextFingerprint: fullTextFingerprint(message.text),
            ...(text.truncated ? { truncated: true as const } : {}),
        };
    }
    const text = boundedText(message.text, MAX_NORMALIZED_MESSAGE_TEXT_CHARS);
    const thinking = boundedText(message.thinking, MAX_NORMALIZED_THINKING_CHARS);
    const errorMessage = message.errorMessage === undefined
        ? undefined
        : boundedText(message.errorMessage, MAX_NORMALIZED_ERROR_CHARS);
    const stopReason = message.stopReason === undefined
        ? undefined
        : boundedText(message.stopReason, MAX_NORMALIZED_ID_CHARS);
    const truncated = text.truncated || thinking.truncated || errorMessage?.truncated === true || stopReason?.truncated === true;
    return {
        role: "assistant",
        text: text.text,
        thinking: thinking.text,
        ...(stopReason ? { stopReason: stopReason.text } : {}),
        ...(errorMessage ? { errorMessage: errorMessage.text } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
        ...(truncated ? { truncated: true as const } : {}),
    };
}

function normalizeOutput(output: SubagentRpcOutput, run: SubagentRun | undefined): SubagentBackendEvent | undefined {
    if (output.type === "thinking_level_changed") {
        return isThinkingLevel(output.level) ? { type: "thinking_changed", level: output.level } : undefined;
    }
    if (output.type === "extension_error") {
        const extensionPath = typeof output.extensionPath === "string"
            ? boundedText(output.extensionPath, MAX_NORMALIZED_ID_CHARS)
            : undefined;
        const error = boundedText(typeof output.error === "string" ? output.error : "unknown error", MAX_NORMALIZED_ERROR_CHARS);
        return {
            type: "extension_error",
            ...(run ? { run } : {}),
            ...(extensionPath ? { extensionPath: extensionPath.text } : {}),
            error: error.text,
            ...(extensionPath?.truncated || error.truncated ? { truncated: true as const } : {}),
        };
    }
    if (!run) return undefined;

    switch (output.type) {
        case "message_start": {
            const message = eventMessage(output.message);
            return message ? { type: "message_started", run, message } : undefined;
        }
        case "message_update": {
            const delta = isRecord(output.assistantMessageEvent) ? output.assistantMessageEvent : undefined;
            if (!delta) return undefined;
            if (delta.type === "text_delta" && typeof delta.delta === "string") {
                const text = boundedText(delta.delta, MAX_NORMALIZED_DELTA_CHARS);
                return { type: "message_delta", run, textDelta: text.text, ...(text.truncated ? { truncated: true as const } : {}) };
            }
            if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
                const thinking = boundedText(delta.delta, MAX_NORMALIZED_DELTA_CHARS);
                return { type: "message_delta", run, thinkingDelta: thinking.text, ...(thinking.truncated ? { truncated: true as const } : {}) };
            }
            return delta.type === "toolcall_start" ? { type: "message_delta", run, toolCallStarted: true } : undefined;
        }
        case "message_end": {
            const message = eventMessage(output.message);
            return message?.role === "assistant" ? { type: "message_completed", run, message } : undefined;
        }
        case "turn_end":
            return { type: "turn_completed", run };
        case "tool_execution_start": {
            const name = boundedText(typeof output.toolName === "string" ? output.toolName : "unknown", MAX_NORMALIZED_ID_CHARS);
            const toolCallId = boundedText(
                opaqueIdentifier(typeof output.toolCallId === "string" ? output.toolCallId : `pi-tool-${randomUUID()}`, "pi-tool-"),
                MAX_NORMALIZED_ID_CHARS,
            );
            const args = boundedText(formatToolArgs(name.text, output.args), MAX_NORMALIZED_TOOL_ARGS_CHARS);
            return {
                type: "tool_started",
                run,
                toolCallId: toolCallId.text,
                name: name.text,
                args: args.text,
                ...(name.truncated || toolCallId.truncated || args.truncated ? { truncated: true as const } : {}),
            };
        }
        case "tool_execution_update": {
            if (typeof output.toolCallId !== "string") return undefined;
            const toolCallId = boundedText(opaqueIdentifier(output.toolCallId, "pi-tool-"), MAX_NORMALIZED_ID_CHARS);
            const text = boundedText(resultText(output.partialResult), MAX_NORMALIZED_TOOL_OUTPUT_CHARS);
            return {
                type: "tool_updated",
                run,
                toolCallId: toolCallId.text,
                output: text.text,
                ...(toolCallId.truncated || text.truncated ? { truncated: true as const } : {}),
            };
        }
        case "tool_execution_end": {
            if (typeof output.toolCallId !== "string") return undefined;
            const toolCallId = boundedText(opaqueIdentifier(output.toolCallId, "pi-tool-"), MAX_NORMALIZED_ID_CHARS);
            const text = boundedText(resultText(output.result), MAX_NORMALIZED_TOOL_OUTPUT_CHARS);
            return {
                type: "tool_completed",
                run,
                toolCallId: toolCallId.text,
                output: text.text,
                isError: output.isError === true,
                ...(toolCallId.truncated || text.truncated ? { truncated: true as const } : {}),
            };
        }
        case "queue_update":
            return {
                type: "queue_changed",
                run,
                steering: Array.isArray(output.steering) ? output.steering.length : 0,
                followUp: Array.isArray(output.followUp) ? output.followUp.length : 0,
            };
        case "compaction_start": {
            const reason = boundedText(typeof output.reason === "string" ? output.reason : "automatic", MAX_NORMALIZED_ERROR_CHARS);
            return { type: "compaction_started", run, reason: reason.text, ...(reason.truncated ? { truncated: true as const } : {}) };
        }
        case "compaction_end": {
            const result = isRecord(output.result) ? output.result : undefined;
            const errorMessage = typeof output.errorMessage === "string"
                ? boundedText(output.errorMessage, MAX_NORMALIZED_ERROR_CHARS)
                : undefined;
            return {
                type: "compaction_completed",
                run,
                ...(usageFrom(result?.usage) ? { usage: usageFrom(result?.usage) } : {}),
                ...(errorMessage ? { errorMessage: errorMessage.text } : {}),
                aborted: output.aborted === true,
                willRetry: output.willRetry === true,
                tokensBefore: numberOrZero(result?.tokensBefore),
                estimatedTokensAfter: numberOrZero(result?.estimatedTokensAfter),
                ...(errorMessage?.truncated ? { truncated: true as const } : {}),
            };
        }
        case "auto_retry_start": {
            const errorMessage = boundedText(typeof output.errorMessage === "string" ? output.errorMessage : "transient error", MAX_NORMALIZED_ERROR_CHARS);
            return {
                type: "retry_started",
                run,
                attempt: numberOrZero(output.attempt),
                maxAttempts: numberOrZero(output.maxAttempts),
                delayMs: numberOrZero(output.delayMs),
                errorMessage: errorMessage.text,
                ...(errorMessage.truncated ? { truncated: true as const } : {}),
            };
        }
        case "auto_retry_end": {
            const finalError = typeof output.finalError === "string"
                ? boundedText(output.finalError, MAX_NORMALIZED_ERROR_CHARS)
                : undefined;
            return {
                type: "retry_completed",
                run,
                success: output.success === true,
                ...(finalError ? { finalError: finalError.text } : {}),
                ...(finalError?.truncated ? { truncated: true as const } : {}),
            };
        }
        case "summarization_retry_scheduled": {
            const errorMessage = typeof output.errorMessage === "string"
                ? boundedText(output.errorMessage, MAX_NORMALIZED_ERROR_CHARS)
                : undefined;
            return {
                type: "summary_retry_scheduled",
                run,
                ...(errorMessage ? { errorMessage: errorMessage.text } : {}),
                ...(errorMessage?.truncated ? { truncated: true as const } : {}),
            };
        }
        case "summarization_retry_attempt_start":
            return { type: "summary_retry_started", run };
        case "summarization_retry_finished":
            return { type: "summary_retry_completed", run };
        default:
            return undefined;
    }
}

function sessionStats(value: unknown): SubagentSessionStats {
    if (!isRecord(value) || !isRecord(value.contextUsage)) return {};
    const contextWindow = value.contextUsage.contextWindow;
    const tokens = value.contextUsage.tokens;
    if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) return {};
    return {
        contextUsage: {
            contextWindow,
            tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
        },
    };
}

function backendError(error: unknown): SubagentBackendError {
    if (error instanceof SubagentBackendError) return error;
    return new SubagentBackendError(
        "BACKEND_FAILED",
        error instanceof Error ? error.message : String(error),
        "pi",
    );
}

export class PiRpcBackend implements SubagentBackend {
    readonly runtime = "pi" as const;
    readonly displayName = "Pi";
    readonly capabilities = PI_CAPABILITIES;
    private readonly connection = { id: `pi-connection-${randomUUID()}`, runtime: "pi" } as const;
    private activeRun: { readonly id: string; readonly runtime: "pi" } | undefined;
    private lastRun: { readonly id: string; readonly runtime: "pi" } | undefined;
    private readonly extensionUiResponseIds = new Map<string, string>();
    private readonly runCompletions = new Map<string, SubagentRunCompletion>();
    private runCount = 0;
    private readonly rpc: PiRpcClient;
    private readonly options: SubagentBackendOptions;

    constructor(options: SubagentBackendOptions, rpcFactory: PiRpcFactory = (rpcOptions) => new SubagentRpcClient(rpcOptions)) {
        this.options = options;
        this.rpc = rpcFactory({
            cwd: options.cwd,
            args: [...options.args],
            onOutput: (output) => this.handleOutput(output),
            onExit: (details) => {
                this.extensionUiResponseIds.clear();
                this.runCompletions.clear();
                this.options.onExit({
                    description: "Subagent process",
                    code: details.code,
                    signal: details.signal,
                    diagnostics: details.stderr,
                    intentional: details.intentional,
                });
            },
        });
    }

    async start(): Promise<void> {
        await this.call(() => this.rpc.start());
    }

    async stop(): Promise<void> {
        try {
            await this.call(() => this.rpc.stop());
        } finally {
            this.extensionUiResponseIds.clear();
            this.runCompletions.clear();
        }
    }

    getDiagnostics(): string {
        return this.rpc.getStderr();
    }

    async prompt(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult> {
        const runCount = this.runCount;
        return await this.withPromptCancellation(signal, async () => {
            await this.callWithSignal(() => this.rpc.prompt(message, signal), signal);
            // Pi accepts ordinary prompts before agent_start. Keep this Pi-only
            // reconciliation here so backend-neutral controllers do not use timing.
            await this.delayWithSignal(PI_PROMPT_RECONCILIATION_DELAY_MS, signal);
            return await this.promptResult(runCount, true, signal);
        });
    }

    async steer(message: string): Promise<void> {
        await this.call(() => this.rpc.steer(message));
    }

    async followUp(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult> {
        const runCount = this.runCount;
        return await this.withPromptCancellation(signal, async () => {
            await this.callWithSignal(() => this.rpc.followUp(message, signal), signal);
            return await this.promptResult(runCount, false, signal);
        });
    }

    async abort(): Promise<void> {
        await this.call(() => this.rpc.abort());
    }

    async getState(): Promise<SubagentBackendState> {
        return this.stateFrom(await this.call(() => this.rpc.getState()));
    }

    async getRunCompletion(run: SubagentRun): Promise<SubagentRunCompletion | undefined> {
        return this.runCompletions.get(this.runKey(run));
    }

    async getHistory(): Promise<readonly SubagentHistoryMessage[]> {
        const value = await this.call(() => this.rpc.getMessages());
        const messages = isRecord(value) && Array.isArray(value.messages)
            ? value.messages
            : Array.isArray(value)
                ? value
                : [];
        return messages.flatMap((message) => {
            const normalized = historyMessage(message);
            return normalized ? [normalized] : [];
        });
    }

    async getSessionStats(): Promise<SubagentSessionStats> {
        return sessionStats(await this.call(() => this.rpc.getSessionStats()));
    }

    async getAvailableModels(): Promise<readonly SubagentModel[]> {
        const value = await this.call(() => this.rpc.getAvailableModels());
        const models = Array.isArray(value)
            ? value
            : isRecord(value) && Array.isArray(value.models)
                ? value.models
                : [];
        return models.flatMap((model) => {
            const normalized = modelFrom(model);
            return normalized ? [normalized] : [];
        });
    }

    async setModel(provider: string, modelId: string): Promise<SubagentModel> {
        const model = modelFrom(await this.call(() => this.rpc.setModel(provider, modelId)));
        if (!model) throw new SubagentBackendError("MODEL_UNAVAILABLE", "Subagent Pi did not return the selected model", "pi");
        return model;
    }

    async cycleModel(): Promise<{ readonly model: SubagentModel; readonly thinkingLevel: SubagentThinkingLevel } | null> {
        const value = await this.call(() => this.rpc.cycleModel());
        if (value === null) return null;
        if (!isRecord(value)) throw new SubagentBackendError("MODEL_UNAVAILABLE", "Subagent Pi did not return a model", "pi");
        const model = modelFrom(value.model);
        if (!model || !isThinkingLevel(value.thinkingLevel)) {
            throw new SubagentBackendError("MODEL_UNAVAILABLE", "Subagent Pi returned an invalid model", "pi");
        }
        return { model, thinkingLevel: value.thinkingLevel };
    }

    async setThinkingLevel(level: SubagentThinkingLevel): Promise<void> {
        await this.call(() => this.rpc.setThinkingLevel(level));
    }

    async cycleThinkingLevel(): Promise<{ readonly level: SubagentThinkingLevel } | null> {
        const value = await this.call(() => this.rpc.cycleThinkingLevel());
        if (value === null) return null;
        if (!isRecord(value) || !isThinkingLevel(value.level)) {
            throw new SubagentBackendError("MODEL_UNAVAILABLE", "Subagent Pi returned an invalid thinking level", "pi");
        }
        return { level: value.level };
    }

    respondToExtensionUI(response: SubagentExtensionUiResponse): void {
        const id = this.extensionUiResponseIds.get(response.id) ?? response.id;
        this.extensionUiResponseIds.delete(response.id);
        if ("confirmed" in response) {
            this.rpc.respondToExtensionUI({ type: "extension_ui_response", id, confirmed: response.confirmed });
            return;
        }
        this.rpc.respondToExtensionUI("cancelled" in response
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value: response.value });
    }

    private handleOutput(output: SubagentRpcOutput): void {
        if (output.type === "agent_start") {
            this.options.onEvent({ type: "run_started", run: this.ensureActiveRun() });
            return;
        }
        if (output.type === "agent_end") {
            const run = this.activeRun;
            if (!run) return;
            this.options.onEvent({ type: "run_ended", run, willRetry: output.willRetry === true });
            return;
        }
        if (output.type === "agent_settled") {
            const run = this.activeRun;
            if (!run) return;
            this.options.onEvent({ type: "run_settled", run });
            this.activeRun = undefined;
            return;
        }
        const request = extensionUiRequest(output, (id) => this.normalizeExtensionUiId(id));
        if (request) {
            if ("id" in request && typeof output.id === "string") this.registerExtensionUiId(request.id, output.id);
            this.options.onEvent({ type: "extension_ui_request", ...(this.activeRun ? { run: this.activeRun } : {}), request });
            return;
        }
        const run = this.isRunScopedOutput(output) ? this.ensureOutputRun() : this.activeRun;
        if (output.type === "message_end" && run) this.rememberRunCompletion(run, output.message);
        const event = normalizeOutput(output, run);
        if (event) this.options.onEvent(event);
    }

    private isRunScopedOutput(output: SubagentRpcOutput): boolean {
        return output.type === "message_start"
            || output.type === "message_update"
            || output.type === "message_end"
            || output.type === "turn_end"
            || output.type === "tool_execution_start"
            || output.type === "tool_execution_update"
            || output.type === "tool_execution_end"
            || output.type === "queue_update"
            || output.type === "compaction_start"
            || output.type === "compaction_end"
            || output.type === "auto_retry_start"
            || output.type === "auto_retry_end"
            || output.type === "summarization_retry_scheduled"
            || output.type === "summarization_retry_attempt_start"
            || output.type === "summarization_retry_finished";
    }

    private ensureOutputRun(): { readonly id: string; readonly runtime: "pi" } {
        const hadActiveRun = this.activeRun !== undefined;
        const run = this.ensureActiveRun();
        if (!hadActiveRun) this.options.onEvent({ type: "run_started", run });
        return run;
    }

    private ensureActiveRun(): { readonly id: string; readonly runtime: "pi" } {
        if (this.activeRun) return this.activeRun;
        const run = { id: `pi-run-${++this.runCount}-${randomUUID()}`, runtime: "pi" } as const;
        this.activeRun = run;
        this.lastRun = run;
        return run;
    }

    private normalizeExtensionUiId(originalId: string): string {
        let normalizedId = opaqueIdentifier(originalId, "pi-ui-");
        let collision = 0;
        while (true) {
            const existing = this.extensionUiResponseIds.get(normalizedId);
            if (!existing || existing === originalId) return normalizedId;
            normalizedId = `pi-ui-${createHash("sha256").update(`${originalId}:${++collision}`).digest("hex")}`;
        }
    }

    private registerExtensionUiId(normalizedId: string, originalId: string): void {
        this.extensionUiResponseIds.set(normalizedId, originalId);
    }

    private cancelPromptAcceptance(): void {
        const originalIds = new Set(this.extensionUiResponseIds.values());
        this.extensionUiResponseIds.clear();
        for (const id of originalIds) {
            try {
                this.rpc.respondToExtensionUI({ type: "extension_ui_response", id, cancelled: true });
            } catch {
                // The abort below is still useful when the response channel is closed.
            }
        }
        void this.call(() => this.rpc.abort()).catch(() => {});
    }

    private async withPromptCancellation<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
        if (!signal) return await operation();
        let cancelled = false;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            this.cancelPromptAcceptance();
        };
        if (signal.aborted) {
            cancel();
            throw backendError(signal.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted"));
        }
        signal.addEventListener("abort", cancel, { once: true });
        try {
            return await operation();
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    }

    private async callWithSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (!signal) return await this.call(operation);
        if (signal.aborted) throw backendError(signal.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted"));
        return await new Promise<T>((resolve, reject) => {
            const abort = () => reject(backendError(signal.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted")));
            signal.addEventListener("abort", abort, { once: true });
            void this.call(operation).then(
                (value) => {
                    signal.removeEventListener("abort", abort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener("abort", abort);
                    reject(error);
                },
            );
        });
    }

    private async delayWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
        await this.callWithSignal(() => new Promise<void>((resolve) => setTimeout(resolve, delayMs)), signal);
    }

    private rememberRunCompletion(run: SubagentRun, value: unknown): void {
        if (!isRecord(value) || value.role !== "assistant") return;
        const text = capAuthoritativeCompletionText(messageText(value));
        const key = this.runKey(run);
        this.runCompletions.set(key, {
            text: text.text,
            responseProduced: true,
            ...(typeof value.stopReason === "string" ? { stopReason: boundedText(value.stopReason, MAX_NORMALIZED_ID_CHARS).text } : {}),
            ...(typeof value.errorMessage === "string" ? { errorMessage: boundedText(value.errorMessage, MAX_NORMALIZED_ERROR_CHARS).text } : {}),
            ...(text.truncated ? { truncated: true as const } : {}),
        });
        while (this.runCompletions.size > MAX_RETAINED_RUN_COMPLETIONS) {
            const first = this.runCompletions.keys().next().value;
            if (first === undefined) break;
            this.runCompletions.delete(first);
        }
    }

    private runKey(run: SubagentRun): string {
        return `${run.runtime}:${run.id}`;
    }

    private async promptResult(
        runCount: number,
        allowHandledWithoutRun: boolean,
        signal?: AbortSignal,
    ): Promise<SubagentPromptRequestResult> {
        try {
            const state = this.stateFrom(await this.callWithSignal(() => this.rpc.getState(), signal));
            if (state.run) return { run: state.run };
            if (this.runCount > runCount && this.lastRun) return { run: this.lastRun };
            if (allowHandledWithoutRun) return { handledWithoutRun: true };
            return { run: this.ensureActiveRun() };
        } catch (error) {
            if (signal?.aborted) {
                throw backendError(signal.reason instanceof Error ? signal.reason : error);
            }
            // Prompt acceptance is authoritative. If state refresh fails, wait for
            // the run instead of treating an asynchronous prompt as handled.
            return { run: this.ensureActiveRun() };
        }
    }

    private stateFrom(value: unknown): SubagentBackendState {
        const state = isRecord(value) ? value : {};
        const isActive = state.isStreaming === true || state.isCompacting === true;
        const run = isActive ? this.ensureActiveRun() : undefined;
        return {
            connection: this.connection,
            ...(run ? { run } : {}),
            ...(modelFrom(state.model) ? { model: modelFrom(state.model) } : {}),
            thinkingLevel: isThinkingLevel(state.thinkingLevel) ? state.thinkingLevel : "off",
            isStreaming: state.isStreaming === true,
            isCompacting: state.isCompacting === true,
            ...(typeof state.sessionFile === "string" ? { sessionFile: state.sessionFile } : {}),
        };
    }

    private async call<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            throw backendError(error);
        }
    }
}

export const createPiRpcBackend: SubagentBackendFactory = (options) => new PiRpcBackend(options);
