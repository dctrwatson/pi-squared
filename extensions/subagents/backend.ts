import type { Usage } from "@earendil-works/pi-ai";
import type { CursorCloudBackendConfiguration } from "./cursor-backend.ts";

/** The runtime that owns a subagent session. */
export type SubagentRuntime = "pi" | "cursor-cloud";

export type SubagentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SubagentBackendCapability =
    | "extension-ui"
    | "steering"
    | "queued-follow-up"
    | "settled-follow-up"
    | "model-controls"
    | "thinking-controls"
    | "session-history"
    | "session-file"
    | "usage"
    | "tool-output";

export interface SubagentBackendCapabilities {
    readonly extensionUi: boolean;
    /** Send steering text while the current run is active. */
    readonly steering: boolean;
    /** Queue a follow-up while the current run is active. */
    readonly queuedFollowUp: boolean;
    /** Send a normal follow-up after an observed run settles. */
    readonly settledFollowUp: boolean;
    readonly modelControls: boolean;
    readonly thinkingControls: boolean;
    readonly sessionHistory: boolean;
    readonly sessionFile: boolean;
    readonly usage: boolean;
    readonly toolOutput: boolean;
}

export interface SubagentBackendConnection {
    readonly runtime: SubagentRuntime;
    readonly id: string;
}

export interface SubagentRun {
    readonly id: string;
    readonly runtime: SubagentRuntime;
    /** False for external work that cannot return to the parent. Omitted means true. */
    readonly parentOwned?: boolean;
}

export interface SubagentModel {
    readonly provider: string;
    readonly id: string;
    readonly name?: string;
    readonly contextWindow?: number;
    readonly reasoning?: boolean;
}

/**
 * Cloud telemetry can omit fields until billing and final usage settle. Omitted
 * values are unknown; a reported zero is retained as zero.
 */
export interface SubagentUsage {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly totalTokens?: number;
    readonly reasoningTokens?: number;
    readonly cost?: Partial<Usage["cost"]>;
}

export interface SubagentArtifact {
    readonly id: string;
    readonly name: string;
    readonly path?: string;
    readonly url?: string;
    readonly sizeBytes?: number;
    readonly updatedAt?: string;
}

/** Bounded repository provenance for the expanded subagent panel. */
export interface SubagentRepositoryDetails {
    readonly url: string;
    readonly startingRef?: string;
}

/**
 * Backend-neutral expanded-panel data. Adapters must sanitize and bound this
 * data before they return it. Omitted values are not available for a runtime.
 */
export interface SubagentBackendPanelDetails {
    readonly agent?: { readonly id: string };
    readonly run?: { readonly id: string };
    readonly repositories?: readonly SubagentRepositoryDetails[];
    readonly artifacts?: readonly SubagentArtifact[];
    readonly runtimeWarnings?: readonly string[];
    readonly policyWarnings?: readonly string[];
}

/** Runtime-specific availability for controls that the shared panel can render. */
export interface SubagentBackendControlAvailability {
    readonly model?: boolean;
    readonly thinking?: boolean;
}

export interface SubagentBackendState {
    readonly connection: SubagentBackendConnection;
    readonly run?: SubagentRun;
    /** Optional bounded data for the panel details view. */
    readonly details?: SubagentBackendPanelDetails;
    /** Optional selected-model control availability. */
    readonly controlAvailability?: SubagentBackendControlAvailability;
    /** A durable terminal result that has not returned to the parent yet. */
    readonly pendingResult?: SubagentRun;
    readonly model?: SubagentModel;
    readonly thinkingLevel: SubagentThinkingLevel;
    readonly isStreaming: boolean;
    readonly isCompacting: boolean;
    readonly sessionFile?: string;
}

export interface SubagentSessionStats {
    readonly contextUsage?: {
        readonly tokens: number | null;
        readonly contextWindow: number;
    };
}

export type SubagentPromptRequestResult =
    | { readonly run: SubagentRun; readonly handledWithoutRun?: false }
    | { readonly handledWithoutRun: true; readonly run?: never };

export const MAX_AUTHORITATIVE_COMPLETION_BYTES = 1_024 * 1_024;
export const AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE = "\n\n[Full response is limited to 1 MiB. Open the subagent session for the remaining content.]";
/** Reject implausible remote durations before they reach shared panel state. */
export const MAX_SUBAGENT_RUN_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;

export function normalizeSubagentRunDurationMs(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SUBAGENT_RUN_DURATION_MS
        ? value
        : undefined;
}

export function capAuthoritativeCompletionText(text: string): { readonly text: string; readonly truncated: boolean } {
    if (Buffer.byteLength(text, "utf8") <= MAX_AUTHORITATIVE_COMPLETION_BYTES) return { text, truncated: false };
    const contentBytes = MAX_AUTHORITATIVE_COMPLETION_BYTES - Buffer.byteLength(AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE, "utf8");
    let usedBytes = 0;
    let end = 0;
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, "utf8");
        if (usedBytes + characterBytes > contentBytes) break;
        usedBytes += characterBytes;
        end += character.length;
    }
    return { text: `${text.slice(0, end)}${AUTHORITATIVE_COMPLETION_TRUNCATION_NOTICE}`, truncated: true };
}

export interface SubagentPromptCompletion {
    readonly text: string;
    readonly usage: SubagentUsage;
    readonly responseProduced: boolean;
    readonly handledWithoutAgent: boolean;
    readonly stopReason?: string;
    /** Bounded metadata only. Artifact content is never downloaded here. */
    readonly artifacts?: readonly SubagentArtifact[];
    /** Bounded policy warnings that apply to this completed run. */
    readonly policyWarnings?: readonly string[];
    /** Bounded runtime warnings, such as a dirty repository worktree. */
    readonly runtimeWarnings?: readonly string[];
    /** The retained completion reached its content cap. */
    readonly truncated?: true;
}

/** This is final response data outside the bounded event telemetry channel. */
export interface SubagentRunCompletion {
    /** This text has no more than MAX_AUTHORITATIVE_COMPLETION_BYTES UTF-8 bytes. */
    readonly text: string;
    readonly responseProduced: boolean;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    /** Reported run usage. Omitted fields remain unknown. */
    readonly usage?: SubagentUsage;
    /** Valid authoritative duration reported by the backend for this run. */
    readonly durationMs?: number;
    /** Bounded metadata only. Artifact content is never downloaded here. */
    readonly artifacts?: readonly SubagentArtifact[];
    /** Bounded policy warnings that apply to this completed run. */
    readonly policyWarnings?: readonly string[];
    /** Bounded runtime warnings, such as a dirty repository worktree. */
    readonly runtimeWarnings?: readonly string[];
    /** The subagent session has response content beyond text. */
    readonly truncated?: true;
}

export interface SubagentUserMessage {
    readonly role: "user";
    readonly text: string;
    /** SHA-256 of the full delivered text before event normalization truncates it. */
    readonly fullTextFingerprint?: string;
    readonly truncated?: true;
}

export interface SubagentAssistantMessage {
    readonly role: "assistant";
    readonly text: string;
    readonly thinking: string;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly usage?: SubagentUsage;
    readonly truncated?: true;
}

export type SubagentHistoryMessage = SubagentUserMessage | SubagentAssistantMessage;

export type SubagentExtensionUiRequest = (
    | { readonly method: "select"; readonly id: string; readonly title: string; readonly options: readonly string[]; readonly timeout?: number }
    | { readonly method: "confirm"; readonly id: string; readonly title: string; readonly message: string; readonly timeout?: number }
    | { readonly method: "input"; readonly id: string; readonly title: string; readonly placeholder?: string; readonly timeout?: number }
    | { readonly method: "editor"; readonly id: string; readonly title: string; readonly prefill?: string }
    | { readonly method: "notify"; readonly message: string; readonly notifyType?: "info" | "warning" | "error" }
    | { readonly method: "setStatus"; readonly statusKey: string; readonly statusText?: string }
    | { readonly method: "setWidget"; readonly widgetKey: string; readonly widgetLines?: readonly string[] }
    | { readonly method: "set_editor_text"; readonly text: string }
    | { readonly method: "setTitle" }
) & {
    /** The adapter reduced this request to its documented UI payload limit. */
    readonly truncated?: true;
};

export type SubagentExtensionUiResponse =
    | { readonly id: string; readonly value: string }
    | { readonly id: string; readonly cancelled: true }
    | { readonly id: string; readonly confirmed: boolean };

export type SubagentBackendEvent =
    | { readonly type: "run_started"; readonly run: SubagentRun }
    | { readonly type: "run_ended"; readonly run: SubagentRun; readonly willRetry: boolean }
    | { readonly type: "run_settled"; readonly run: SubagentRun }
    | { readonly type: "message_started"; readonly run: SubagentRun; readonly message: SubagentUserMessage | SubagentAssistantMessage }
    | { readonly type: "message_delta"; readonly run: SubagentRun; readonly textDelta?: string; readonly thinkingDelta?: string; readonly toolCallStarted?: true; readonly truncated?: true }
    | { readonly type: "message_completed"; readonly run: SubagentRun; readonly message: SubagentAssistantMessage }
    | { readonly type: "turn_completed"; readonly run: SubagentRun }
    | { readonly type: "tool_started"; readonly run: SubagentRun; readonly toolCallId: string; readonly name: string; readonly args: string; readonly truncated?: true }
    | { readonly type: "tool_updated"; readonly run: SubagentRun; readonly toolCallId: string; readonly output: string; readonly truncated?: true }
    | { readonly type: "tool_completed"; readonly run: SubagentRun; readonly toolCallId: string; readonly output: string; readonly isError: boolean; readonly truncated?: true }
    | { readonly type: "queue_changed"; readonly run: SubagentRun; readonly steering: number; readonly followUp: number }
    | { readonly type: "compaction_started"; readonly run: SubagentRun; readonly reason: string; readonly truncated?: true }
    | { readonly type: "compaction_completed"; readonly run: SubagentRun; readonly usage?: SubagentUsage; readonly errorMessage?: string; readonly aborted: boolean; readonly willRetry: boolean; readonly tokensBefore: number; readonly estimatedTokensAfter: number; readonly truncated?: true }
    | { readonly type: "retry_started"; readonly run: SubagentRun; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number; readonly errorMessage: string; readonly truncated?: true }
    | { readonly type: "retry_completed"; readonly run: SubagentRun; readonly success: boolean; readonly finalError?: string; readonly truncated?: true }
    | { readonly type: "summary_retry_scheduled"; readonly run: SubagentRun; readonly errorMessage?: string; readonly truncated?: true }
    | { readonly type: "summary_retry_started"; readonly run: SubagentRun }
    | { readonly type: "summary_retry_completed"; readonly run: SubagentRun }
    | { readonly type: "extension_error"; readonly run?: SubagentRun; readonly extensionPath?: string; readonly error: string; readonly truncated?: true }
    | { readonly type: "usage_update"; readonly run: SubagentRun; readonly usage: SubagentUsage }
    | { readonly type: "status_update"; readonly run: SubagentRun; readonly status: string; readonly truncated?: true }
    | { readonly type: "runtime_warning"; readonly run: SubagentRun; readonly warning: string; readonly truncated?: true }
    | { readonly type: "policy_warning"; readonly run: SubagentRun; readonly warning: string; readonly truncated?: true }
    | { readonly type: "thinking_changed"; readonly level: SubagentThinkingLevel }
    | { readonly type: "extension_ui_request"; readonly run?: SubagentRun; readonly request: SubagentExtensionUiRequest };

export interface SubagentBackendExit {
    readonly description?: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly diagnostics: string;
    readonly intentional: boolean;
}

export interface SubagentBackendOptions {
    readonly cwd: string;
    readonly args: readonly string[];
    /** Cursor-only state and durable persistence callbacks. */
    readonly cursor?: CursorCloudBackendConfiguration;
    readonly onEvent: (event: SubagentBackendEvent) => void;
    readonly onExit: (details: SubagentBackendExit) => void;
}

export interface SubagentBackend {
    readonly runtime: SubagentRuntime;
    readonly displayName: string;
    readonly capabilities: SubagentBackendCapabilities;
    start(): Promise<void>;
    stop(): Promise<void>;
    getDiagnostics(): string;
    prompt(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult>;
    steer(message: string): Promise<void>;
    followUp(message: string, signal?: AbortSignal): Promise<SubagentPromptRequestResult>;
    abort(): Promise<void>;
    getState(): Promise<SubagentBackendState>;
    getRunCompletion?(run: SubagentRun): Promise<SubagentRunCompletion | undefined>;
    /** Clear a durable result only after a parent receives it. */
    markRunCompletionDelivered?(run: SubagentRun): Promise<void>;
    /** Stop local observation but do not stop remote work. */
    disposeObservation?(): Promise<void>;
    getArtifacts?(): Promise<readonly SubagentArtifact[]>;
    getHistory(): Promise<readonly SubagentHistoryMessage[]>;
    getSessionStats(): Promise<SubagentSessionStats>;
    getAvailableModels(): Promise<readonly SubagentModel[]>;
    setModel(provider: string, modelId: string): Promise<SubagentModel>;
    cycleModel(): Promise<{ readonly model: SubagentModel; readonly thinkingLevel: SubagentThinkingLevel } | null>;
    setThinkingLevel(level: SubagentThinkingLevel): Promise<void>;
    cycleThinkingLevel(): Promise<{ readonly level: SubagentThinkingLevel } | null>;
    respondToExtensionUI(response: SubagentExtensionUiResponse): void;
}

export type SubagentBackendFactory = (options: SubagentBackendOptions) => SubagentBackend;

export type SubagentBackendErrorCode =
    | "AUTH_REQUIRED"
    | "GIT_PRECONDITION"
    | "REPOSITORY_UNAVAILABLE"
    | "MODEL_UNAVAILABLE"
    | "BUSY"
    | "REMOTE_NOT_FOUND"
    | "POLICY_VIOLATION"
    | "CANCELLED"
    | "BACKEND_FAILED";

export class SubagentBackendError extends Error {
    readonly code: SubagentBackendErrorCode;
    readonly runtime: SubagentRuntime;
    /** A Cursor run was accepted before this request failed or was cancelled. */
    readonly acceptedRun?: SubagentRun;

    constructor(
        code: SubagentBackendErrorCode,
        message: string,
        runtime: SubagentRuntime,
        acceptedRun?: SubagentRun,
    ) {
        super(message);
        this.name = "SubagentBackendError";
        this.code = code;
        this.runtime = runtime;
        this.acceptedRun = acceptedRun;
    }
}
