import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState, SessionStats } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
    Input,
    Markdown,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Focusable,
    type KeybindingsManager,
    type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildContextMode, ChildPersona, ChildScopedModel, ChildThinkingLevel } from "./personas.ts";
import { ChildRpcClient, type ChildModelInfo, type ChildRpcClientOptions, type ChildRpcOutput } from "./rpc.ts";

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_TOOL_OUTPUT_LINES = 10;
const MAX_ERROR_CHARS = 2_000;
const MAX_TRANSCRIPT_TEXT_CHARS = 100_000;
const MAX_TRANSCRIPT_TOTAL_CHARS = 500_000;
export const MAX_CHILD_TRANSCRIPT_ITEMS = 200;

type Theme = ExtensionContext["ui"]["theme"];
type InputMode = "prompt" | "steer" | "followUp";
type StatusLevel = "info" | "warning" | "error" | "success";
export type SubagentPromptSource = "human" | "parent";
type TranscriptPromptSource = SubagentPromptSource | "context" | "unknown";

export interface SubagentPromptAttribution {
    source: SubagentPromptSource;
    fingerprint: string;
}

export function promptFingerprint(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

interface UsageTotals extends Usage {
    turns: number;
}

interface UserItem {
    kind: "user";
    text: string;
    mode: InputMode;
    source: TranscriptPromptSource;
}

interface AssistantItem {
    kind: "assistant";
    text: string;
    thinking: string;
    streaming: boolean;
    stopReason?: string;
    errorMessage?: string;
}

interface ToolItem {
    kind: "tool";
    toolCallId: string;
    name: string;
    args: string;
    output: string;
    status: "running" | "done" | "error";
}

interface StatusItem {
    kind: "status";
    text: string;
    level: StatusLevel;
}

type TranscriptItem = UserItem | AssistantItem | ToolItem | StatusItem;

interface ChildViewState {
    revision: number;
    connected: boolean;
    busy: boolean;
    phase: string;
    sessionFile?: string;
    model?: ChildModelInfo;
    thinking: ChildThinkingLevel;
    items: TranscriptItem[];
    omittedItems: number;
    lastCompletedAssistantText?: string;
    usage: UsageTotals;
    stats?: SessionStats;
    extensionStatuses: Map<string, string>;
    extensionWidgets: Map<string, string[]>;
}

export interface RunChildDialogOptions {
    args: string[];
    cwd: string;
    mode: ChildContextMode;
    persona?: ChildPersona;
    initialPrompt: string;
    scopedModels: readonly ChildScopedModel[];
    promptAttributions?: readonly SubagentPromptAttribution[];
    onPromptAccepted?: (attribution: SubagentPromptAttribution) => void;
    onPromptDelivered?: (fingerprint: string) => void;
}

type ChildRpcFactory = (options: ChildRpcClientOptions) => ChildRpcClient;

export type ChildDialogResult =
    | { action: "return"; text: string }
    | { action: "cancel" };

export interface SubagentPromptCompletion {
    text: string;
    usage: Usage;
    responseProduced: boolean;
    handledWithoutAgent: boolean;
    stopReason?: string;
}

export function getChildPanelWidths(width: number): { dialogWidth: number; innerWidth: number } | undefined {
    if (width < 3) return undefined;
    return { dialogWidth: width, innerWidth: width - 2 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundedError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.length <= MAX_ERROR_CHARS) return new Error(message);
    return new Error(`Subagent error: …${message.slice(-(MAX_ERROR_CHARS - 18))}`);
}

function boundedTranscriptText(text: string): string {
    if (text.length <= MAX_TRANSCRIPT_TEXT_CHARS) return text;
    const notice = "\n\n[Panel display truncated; full content remains in the child session.]";
    return `${text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS - notice.length)}${notice}`;
}

function formatTokens(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
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

function visibleAssistantText(message: Record<string, unknown>): string {
    return message.role === "assistant" ? messageText(message) : "";
}

function assistantThinking(message: Record<string, unknown>): string {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
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

function usageFrom(value: unknown): Omit<UsageTotals, "turns"> | undefined {
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

function formatToolArgs(name: string, args: unknown): string {
    if (!isRecord(args)) return "";
    const pathValue = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
    switch (name) {
        case "read":
        case "ls":
        case "write":
        case "edit":
            return pathValue ?? "";
        case "grep": {
            const pattern = typeof args.pattern === "string" ? args.pattern : "";
            return `${pattern ? `/${pattern}/` : ""}${pathValue ? ` in ${pathValue}` : ""}`;
        }
        case "find": {
            const pattern = typeof args.pattern === "string" ? args.pattern : "*";
            return `${pattern}${pathValue ? ` in ${pathValue}` : ""}`;
        }
        case "bash":
            return typeof args.command === "string" ? (args.command.split("\n")[0] ?? "") : "";
        default: {
            const json = JSON.stringify(args);
            return json.length > 100 ? `${json.slice(0, 99)}…` : json;
        }
    }
}

function modelFrom(value: unknown): ChildModelInfo | undefined {
    if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
    return {
        provider: value.provider,
        id: value.id,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
        ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    };
}

function wrapPlain(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    for (const line of text.split("\n")) {
        if (!line) {
            lines.push("");
            continue;
        }
        lines.push(...wrapTextWithAnsi(line, safeWidth));
    }
    return lines;
}

function formatUsageLine(state: ChildViewState): string {
    const parts: string[] = [];
    if (state.usage.turns) parts.push(`${state.usage.turns} turn${state.usage.turns === 1 ? "" : "s"}`);
    if (state.usage.input) parts.push(`↑${formatTokens(state.usage.input)}`);
    if (state.usage.output) parts.push(`↓${formatTokens(state.usage.output)}`);
    if (state.usage.cacheRead) parts.push(`R${formatTokens(state.usage.cacheRead)}`);
    if (state.usage.cacheWrite) parts.push(`W${formatTokens(state.usage.cacheWrite)}`);
    if (state.usage.cost.total) parts.push(`$${state.usage.cost.total.toFixed(4)}`);
    const context = state.stats?.contextUsage;
    if (context) {
        const current = context.tokens === null ? "?" : formatTokens(context.tokens);
        parts.push(`ctx:${current}/${formatTokens(context.contextWindow)}`);
    }
    return parts.join(" ");
}

function renderTranscript(
    state: ChildViewState,
    width: number,
    theme: Theme,
    showThinking: boolean,
    showToolOutput: boolean,
): string[] {
    const lines: string[] = [];
    const markdownTheme = getMarkdownTheme();
    const safeWidth = Math.max(1, width);
    const addSpacer = () => {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    };

    if (state.omittedItems > 0) {
        lines.push(theme.fg(
            "dim",
            `[${state.omittedItems} earlier transcript item${state.omittedItems === 1 ? "" : "s"} omitted from this panel; full history remains in the child session.]`,
        ));
    }

    for (const item of state.items) {
        switch (item.kind) {
            case "user": {
                addSpacer();
                const actor = item.source === "human"
                    ? "You"
                    : item.source === "parent"
                        ? "Parent agent"
                        : item.source === "context"
                            ? "Parent context"
                            : "Previous prompt";
                const qualifier = item.mode === "prompt" ? "" : item.mode === "steer" ? " · steer" : " · follow-up";
                lines.push(theme.fg("accent", theme.bold(`${actor}${qualifier}`)));
                lines.push(...wrapPlain(item.text, safeWidth));
                break;
            }
            case "assistant": {
                addSpacer();
                const suffix = item.streaming
                    ? " · streaming"
                    : item.stopReason && item.stopReason !== "stop"
                        ? ` · ${item.stopReason}`
                        : "";
                lines.push(theme.fg("success", theme.bold(`Subagent${suffix}`)));
                if (item.thinking) {
                    if (showThinking) {
                        lines.push(theme.fg("dim", "Thinking:"));
                        lines.push(...wrapPlain(theme.fg("dim", item.thinking), safeWidth));
                    } else {
                        lines.push(theme.fg("dim", "Thinking hidden"));
                    }
                }
                if (item.text) {
                    try {
                        lines.push(...new Markdown(item.text, 0, 0, markdownTheme).render(safeWidth));
                    } catch {
                        lines.push(...wrapPlain(item.text, safeWidth));
                    }
                } else if (!item.thinking) {
                    lines.push(theme.fg("dim", item.streaming ? "…" : "(no visible text)"));
                }
                if (item.errorMessage) lines.push(...wrapPlain(theme.fg("error", item.errorMessage), safeWidth));
                break;
            }
            case "tool": {
                const icon = item.status === "running" ? "⚙" : item.status === "error" ? "✗" : "✓";
                const color = item.status === "error" ? "error" : item.status === "done" ? "success" : "warning";
                const label = `${theme.fg(color, `${icon} `)}${theme.fg("toolTitle", item.name)}${item.args ? theme.fg("dim", ` ${item.args}`) : ""}`;
                lines.push(...wrapPlain(label, safeWidth));
                if (showToolOutput && item.output) {
                    const outputLines = wrapPlain(theme.fg(item.status === "error" ? "error" : "toolOutput", item.output), safeWidth);
                    const omitted = Math.max(0, outputLines.length - MAX_TOOL_OUTPUT_LINES);
                    if (omitted) lines.push(theme.fg("dim", `  … ${omitted} earlier output lines`));
                    for (const outputLine of outputLines.slice(-MAX_TOOL_OUTPUT_LINES)) lines.push(`  ${outputLine}`);
                }
                break;
            }
            case "status": {
                const icon = item.level === "error" ? "✗" : item.level === "warning" ? "!" : item.level === "success" ? "✓" : "·";
                const color = item.level === "info" ? "dim" : item.level;
                lines.push(...wrapPlain(theme.fg(color, `${icon} ${item.text}`), safeWidth));
                break;
            }
        }
    }

    if (state.extensionStatuses.size > 0 || state.extensionWidgets.size > 0) {
        addSpacer();
        lines.push(theme.fg("muted", theme.bold("Subagent extension UI")));
        for (const [key, value] of state.extensionStatuses) {
            lines.push(...wrapPlain(theme.fg("dim", `${key}: ${value}`), safeWidth));
        }
        for (const [key, widgetLines] of state.extensionWidgets) {
            lines.push(theme.fg("dim", `${key}:`));
            for (const line of widgetLines) lines.push(...wrapPlain(line, safeWidth));
        }
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > 0 ? lines : [theme.fg("dim", "No subagent messages yet. Type a prompt below.")];
}

export class ChildSessionController {
    readonly state: ChildViewState;
    private readonly rpc: ChildRpcClient;
    private readonly refreshCallbacks = new Set<() => void>();
    private setInputCallback: ((text: string) => void) | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private commandPending = false;
    private stopping = false;
    private startPromise: Promise<void> | undefined;
    private settledRevision = 0;
    private parentRequestCount = 0;
    private latestRunAssistantText = "";
    private latestRunStopReason: string | undefined;
    private latestRunHadAssistant = false;
    private latestRunHandledWithoutAgent = false;
    private latestRunFailure: Error | undefined;
    private lastSubmissionError: Error | undefined;
    private readonly settledWaiters = new Set<{
        after: number;
        resolve: (settlement: Omit<SubagentPromptCompletion, "usage">) => void;
        reject: (error: Error) => void;
    }>();
    private promptTail: Promise<void> = Promise.resolve();
    private activeAssistant: AssistantItem | undefined;
    private readonly toolsById = new Map<string, ToolItem>();
    private toolSequence = 0;
    private readonly promptAttributions: SubagentPromptAttribution[];
    private ctx: ExtensionContext;
    private readonly options: RunChildDialogOptions;

    constructor(
        ctx: ExtensionContext,
        options: RunChildDialogOptions,
        rpcFactory: ChildRpcFactory = (rpcOptions) => new ChildRpcClient(rpcOptions),
    ) {
        this.ctx = ctx;
        this.options = options;
        this.promptAttributions = [...(options.promptAttributions ?? [])];
        this.state = {
            revision: 0,
            connected: false,
            busy: false,
            phase: "Starting subagent Pi…",
            thinking: "off",
            items: [],
            omittedItems: 0,
            usage: {
                turns: 0,
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            extensionStatuses: new Map(),
            extensionWidgets: new Map(),
        };
        this.rpc = rpcFactory({
            cwd: options.cwd,
            args: options.args,
            onOutput: (output) => this.handleOutput(output),
            onExit: (details) => {
                if (details.intentional || this.stopping) return;
                this.state.connected = false;
                this.state.busy = false;
                this.state.phase = "Subagent process exited";
                const detail = details.stderr.trim() || `code=${details.code ?? "none"}, signal=${details.signal ?? "none"}`;
                const error = boundedError(`Subagent process exited: ${detail}`);
                this.rejectSettledWaiters(error);
                this.addStatus(error.message, "error");
            },
        });
    }

    attach(ctx: ExtensionCommandContext, refresh: () => void, setInput: (text: string) => void): () => void {
        this.ctx = ctx;
        this.refreshCallbacks.add(refresh);
        this.setInputCallback = setInput;
        return () => {
            this.refreshCallbacks.delete(refresh);
            this.setInputCallback = undefined;
        };
    }

    subscribe(refresh: () => void): () => void {
        this.refreshCallbacks.add(refresh);
        return () => this.refreshCallbacks.delete(refresh);
    }

    get settlementRevision(): number {
        return this.settledRevision;
    }

    get latestSettledAssistantText(): string | undefined {
        return this.latestRunFailure || !this.latestRunHadAssistant || !this.latestRunAssistantText.trim()
            ? undefined
            : this.latestRunAssistantText;
    }

    async start(): Promise<void> {
        if (this.state.connected) return;
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.startInternal();
        return this.startPromise;
    }

    private async startInternal(): Promise<void> {
        try {
            await this.rpc.start();
            const state = await this.rpc.getState();
            this.applyRpcState(state);
            await this.hydrateMessages();
            this.state.stats = await this.rpc.getSessionStats();
            this.state.connected = true;
            this.state.phase = "Ready";
            this.touch();
            const startupDiagnostics = this.rpc.getStderr().trim();
            if (startupDiagnostics) this.addStatus(`Subagent startup diagnostics: ${startupDiagnostics.slice(-8_000)}`, "warning");
            if (this.options.initialPrompt.trim()) await this.submit(this.options.initialPrompt, "prompt", "human");
        } catch (error) {
            this.state.connected = false;
            this.state.busy = false;
            this.state.phase = "Failed to start";
            const failure = boundedError(error);
            await this.rpc.stop().catch(() => {});
            this.addStatus(failure.message, "error");
            this.rejectSettledWaiters(failure);
            throw failure;
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.setInputCallback = undefined;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        const error = new Error("Subagent process stopped");
        this.rejectSettledWaiters(error);
        await this.rpc.stop();
        this.state.connected = false;
        this.state.busy = false;
        this.state.phase = "Stopped";
        this.touch();
    }

    async promptAndWait(text: string, signal?: AbortSignal): Promise<SubagentPromptCompletion> {
        let releasePrompt!: () => void;
        const previousPrompt = this.promptTail;
        this.promptTail = new Promise<void>((resolve) => {
            releasePrompt = resolve;
        });

        let queueAcquired = false;
        try {
            await this.waitForQueuedPrompt(previousPrompt, signal);
            queueAcquired = true;
            this.parentRequestCount++;
            try {
                signal?.throwIfAborted();
                await this.start();
                const usageBefore = this.usageSnapshot();
                const after = this.settledRevision;
                const completion = this.waitForSettlement(after, signal);
                const accepted = await this.submit(text, this.state.busy ? "followUp" : "prompt", "parent");
                if (!accepted) {
                    const error = this.lastSubmissionError ?? new Error("Subagent prompt was not accepted");
                    this.rejectWaitersAfter(after, error);
                    try {
                        await completion;
                    } catch {
                        throw error;
                    }
                    throw error;
                }
                const result = await completion;
                return { ...result, usage: this.usageSince(usageBefore) };
            } finally {
                this.parentRequestCount--;
            }
        } finally {
            if (queueAcquired) releasePrompt();
            else void previousPrompt.then(releasePrompt);
        }
    }

    private usageSnapshot(): Usage {
        const { input, output, cacheRead, cacheWrite, totalTokens, cost } = this.state.usage;
        return { input, output, cacheRead, cacheWrite, totalTokens, cost: { ...cost } };
    }

    private usageSince(before: Usage): Usage {
        const current = this.usageSnapshot();
        return {
            input: Math.max(0, current.input - before.input),
            output: Math.max(0, current.output - before.output),
            cacheRead: Math.max(0, current.cacheRead - before.cacheRead),
            cacheWrite: Math.max(0, current.cacheWrite - before.cacheWrite),
            totalTokens: Math.max(0, current.totalTokens - before.totalTokens),
            cost: {
                input: Math.max(0, current.cost.input - before.cost.input),
                output: Math.max(0, current.cost.output - before.cost.output),
                cacheRead: Math.max(0, current.cost.cacheRead - before.cost.cacheRead),
                cacheWrite: Math.max(0, current.cost.cacheWrite - before.cost.cacheWrite),
                total: Math.max(0, current.cost.total - before.cost.total),
            },
        };
    }

    async submit(text: string, requestedMode?: InputMode, source: SubagentPromptSource = "human"): Promise<boolean> {
        this.lastSubmissionError = undefined;
        const message = text.trim();
        if (!message) {
            this.setTransientStatus("Enter a subagent prompt first.", "warning");
            return false;
        }
        if (!this.state.connected) {
            this.setTransientStatus("The subagent process is not connected.", "error");
            return false;
        }
        if (this.commandPending) {
            this.setTransientStatus("A subagent command is still being accepted.", "warning");
            return false;
        }

        const mode = requestedMode ?? (this.state.busy ? "steer" : "prompt");
        const wasBusy = this.state.busy;
        if (mode === "prompt" && wasBusy) {
            this.setTransientStatus("The subagent is busy; steer it or queue a follow-up instead.", "warning");
            return false;
        }
        if (mode === "followUp" && !wasBusy) {
            this.setTransientStatus("The subagent is idle; submit this as a normal prompt.", "warning");
            return false;
        }
        const sendAsPrompt = mode === "prompt" || (mode === "steer" && !wasBusy);

        this.commandPending = true;
        this.appendItem({
            kind: "user",
            text: boundedTranscriptText(message),
            mode: sendAsPrompt ? "prompt" : mode,
            source,
        });
        if (sendAsPrompt) {
            this.state.busy = true;
            this.state.phase = "Starting turn…";
        } else if (mode === "steer") {
            this.state.phase = "Steering queued";
        } else {
            this.state.phase = "Follow-up queued";
        }
        this.touch();

        try {
            if (mode === "followUp") await this.rpc.followUp(message);
            else if (sendAsPrompt) {
                const settlementBeforePrompt = this.settledRevision;
                await this.rpc.prompt(message);
                void this.reconcileAfterPrompt(settlementBeforePrompt);
            } else await this.rpc.steer(message);
            const attribution = { source, fingerprint: promptFingerprint(message) };
            this.promptAttributions.push(attribution);
            try {
                this.options.onPromptAccepted?.(attribution);
            } catch (error) {
                this.addStatus(`Could not persist prompt attribution: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            return true;
        } catch (error) {
            this.lastSubmissionError = boundedError(error);
            if (sendAsPrompt) {
                this.state.busy = wasBusy;
                this.state.phase = "Prompt was not accepted";
            }
            this.addStatus(this.lastSubmissionError.message, "error");
            return false;
        } finally {
            this.commandPending = false;
        }
    }

    async interrupt(): Promise<void> {
        if (!this.state.busy || !this.state.connected) return;
        this.state.phase = "Aborting…";
        this.touch();
        try {
            await this.rpc.abort();
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    returnText(): string | undefined {
        if (this.parentRequestCount > 0) {
            this.setTransientStatus("This response will return to the parent agent automatically.", "info");
            return undefined;
        }
        if (this.state.busy) {
            this.setTransientStatus("Wait for the subagent to settle before returning a response.", "warning");
            return undefined;
        }
        if (!this.state.lastCompletedAssistantText?.trim()) {
            this.setTransientStatus("The subagent has no normally completed visible response to return.", "warning");
            return undefined;
        }
        return this.state.lastCompletedAssistantText;
    }

    async selectModel(): Promise<void> {
        if (!this.canChangeRuntime("model")) return;
        try {
            const availableModels = await this.rpc.getAvailableModels();
            const scope = this.options.scopedModels;
            const models = scope.length === 0
                ? availableModels
                : scope.flatMap((scoped) => {
                    const model = availableModels.find(
                        (candidate) => candidate.provider === scoped.provider && candidate.id === scoped.id,
                    );
                    return model ? [model] : [];
                });
            if (models.length === 0) {
                this.setTransientStatus("No subagent model is available in the parent model scope.", "warning");
                return;
            }

            const choices = models.map((model) => `${model.name ? `${model.name} — ` : ""}${model.provider}/${model.id}`);
            const selected = await this.ctx.ui.select("Select subagent model", choices);
            if (!selected) return;
            const index = choices.indexOf(selected);
            const model = models[index];
            if (!model) return;
            this.state.phase = "Changing model…";
            this.touch();
            this.state.model = await this.rpc.setModel(model.provider, model.id);
            const scoped = scope.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
            if (scoped?.thinkingLevel) {
                await this.rpc.setThinkingLevel(scoped.thinkingLevel);
                this.state.thinking = scoped.thinkingLevel;
            }
            await this.refreshState();
            this.addStatus(`Subagent model: ${model.provider}/${model.id}`, "info");
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    async cycleModel(): Promise<void> {
        if (!this.canChangeRuntime("model")) return;
        try {
            const result = await this.rpc.cycleModel();
            if (!result) {
                this.setTransientStatus("No other subagent model is available.", "info");
                return;
            }
            this.state.model = result.model;
            this.state.thinking = result.thinkingLevel;
            this.addStatus(`Subagent model: ${result.model.provider}/${result.model.id}`, "info");
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    async cycleThinking(): Promise<void> {
        if (!this.canChangeRuntime("thinking level")) return;
        try {
            const result = await this.rpc.cycleThinkingLevel();
            if (!result) {
                this.setTransientStatus("The subagent model has no additional thinking levels.", "info");
                return;
            }
            this.state.thinking = result.level;
            this.addStatus(`Subagent thinking: ${result.level}`, "info");
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    setTransientStatus(text: string, level: StatusLevel): void {
        this.state.phase = text;
        if (level === "error") this.appendItem({ kind: "status", text: boundedTranscriptText(text), level });
        this.touch();
    }

    private canChangeRuntime(label: string): boolean {
        if (!this.state.connected) {
            this.setTransientStatus("The subagent process is not connected.", "error");
            return false;
        }
        if (this.state.busy) {
            this.setTransientStatus(`Wait for the subagent to settle before changing its ${label}.`, "warning");
            return false;
        }
        return true;
    }

    private async waitForQueuedPrompt(previousPrompt: Promise<void>, signal?: AbortSignal): Promise<void> {
        if (!signal) {
            await previousPrompt;
            return;
        }
        signal.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
            await Promise.race([
                previousPrompt,
                new Promise<never>((_resolve, reject) => {
                    abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted"));
                    signal.addEventListener("abort", abort, { once: true });
                }),
            ]);
        } finally {
            if (abort) signal.removeEventListener("abort", abort);
        }
    }

    private waitForSettlement(
        after: number,
        signal?: AbortSignal,
    ): Promise<Omit<SubagentPromptCompletion, "usage">> {
        return new Promise<Omit<SubagentPromptCompletion, "usage">>((resolve, reject) => {
            let waiter: {
                after: number;
                resolve: (settlement: Omit<SubagentPromptCompletion, "usage">) => void;
                reject: (error: Error) => void;
            };
            const abort = () => {
                this.settledWaiters.delete(waiter);
                void this.interrupt();
                reject(signal?.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted"));
            };
            waiter = {
                after,
                resolve: (value) => {
                    signal?.removeEventListener("abort", abort);
                    resolve(value);
                },
                reject: (error) => {
                    signal?.removeEventListener("abort", abort);
                    reject(error);
                },
            };
            if (signal?.aborted) {
                abort();
                return;
            }
            if (signal) signal.addEventListener("abort", abort, { once: true });
            this.settledWaiters.add(waiter);
        });
    }

    private resolveSettledWaiters(): void {
        for (const waiter of [...this.settledWaiters]) {
            if (waiter.after >= this.settledRevision) continue;
            this.settledWaiters.delete(waiter);
            if (this.latestRunFailure) {
                waiter.reject(this.latestRunFailure);
                continue;
            }
            waiter.resolve({
                text: this.latestRunAssistantText,
                responseProduced: this.latestRunHadAssistant,
                handledWithoutAgent: this.latestRunHandledWithoutAgent,
                ...(this.latestRunStopReason ? { stopReason: this.latestRunStopReason } : {}),
            });
        }
    }

    private rejectWaitersAfter(after: number, error: Error): void {
        for (const waiter of [...this.settledWaiters]) {
            if (waiter.after !== after) continue;
            this.settledWaiters.delete(waiter);
            waiter.reject(error);
        }
    }

    private rejectSettledWaiters(error: Error): void {
        for (const waiter of this.settledWaiters) waiter.reject(error);
        this.settledWaiters.clear();
    }

    private async hydrateMessages(): Promise<void> {
        const messages = await this.rpc.getMessages();
        if (messages.length === 0 || this.state.items.length > 0) return;

        const hydratedUsers = messages.flatMap((value, messageIndex) => {
            if (!isRecord(value) || value.role !== "user") return [];
            const text = typeof value.content === "string"
                ? value.content
                : Array.isArray(value.content)
                    ? value.content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("")
                    : "";
            return text ? [{ messageIndex, text }] : [];
        });
        const sourceByMessageIndex = new Map<number, TranscriptPromptSource>();
        let attributionCursor = this.promptAttributions.length - 1;
        for (let index = hydratedUsers.length - 1; index >= 0; index--) {
            const user = hydratedUsers[index]!;
            const fingerprint = promptFingerprint(user.text);
            let matchedAttribution = -1;
            for (let candidate = attributionCursor; candidate >= 0; candidate--) {
                if (this.promptAttributions[candidate]?.fingerprint === fingerprint) {
                    matchedAttribution = candidate;
                    break;
                }
            }
            if (matchedAttribution >= 0) {
                sourceByMessageIndex.set(user.messageIndex, this.promptAttributions[matchedAttribution]!.source);
                attributionCursor = matchedAttribution - 1;
            } else {
                sourceByMessageIndex.set(user.messageIndex, this.options.mode === "fork" ? "context" : "unknown");
            }
        }

        for (const [messageIndex, value] of messages.entries()) {
            if (!isRecord(value)) continue;
            if (value.role === "user") {
                const text = typeof value.content === "string"
                    ? value.content
                    : Array.isArray(value.content)
                        ? value.content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("")
                        : "";
                if (text) this.appendItem({
                    kind: "user",
                    text: boundedTranscriptText(text),
                    mode: "prompt",
                    source: sourceByMessageIndex.get(messageIndex) ?? (this.options.mode === "fork" ? "context" : "unknown"),
                });
                continue;
            }
            if (value.role !== "assistant") continue;
            const fullText = visibleAssistantText(value);
            const item: AssistantItem = {
                kind: "assistant",
                text: boundedTranscriptText(fullText),
                thinking: boundedTranscriptText(assistantThinking(value)),
                streaming: false,
                stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
                errorMessage: typeof value.errorMessage === "string" ? boundedError(value.errorMessage).message : undefined,
            };
            this.appendItem(item);
            if (item.stopReason === "stop" && fullText.trim()) this.state.lastCompletedAssistantText = fullText;
        }
    }

    private async reconcileAfterPrompt(settlementBeforePrompt: number): Promise<void> {
        // RPC acknowledges an ordinary prompt immediately before starting the
        // agent. A prompt handled by an extension command/input hook starts no
        // run and therefore emits no agent_settled event.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        try {
            const state = await this.rpc.getState();
            this.applyRpcState(state);
            if (!state.isStreaming && !state.isCompacting) {
                this.state.phase = "Ready for another prompt";
                if (this.settledRevision === settlementBeforePrompt) {
                    this.latestRunAssistantText = "";
                    this.latestRunStopReason = undefined;
                    this.latestRunHadAssistant = false;
                    this.latestRunHandledWithoutAgent = true;
                    this.latestRunFailure = undefined;
                    this.settledRevision++;
                    this.resolveSettledWaiters();
                }
                void this.refreshStats();
            }
            this.touch();
        } catch (error) {
            if (!this.stopping) this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    private async refreshState(): Promise<void> {
        const state = await this.rpc.getState();
        this.applyRpcState(state);
        this.touch();
    }

    private applyRpcState(state: RpcSessionState): void {
        const model = modelFrom(state.model);
        if (model) this.state.model = model;
        this.state.sessionFile = state.sessionFile ?? undefined;
        this.state.thinking = state.thinkingLevel as ChildThinkingLevel;
        this.state.busy = state.isStreaming || state.isCompacting;
    }

    private handleOutput(output: ChildRpcOutput): void {
        if (output.type === "extension_ui_request" && typeof output.method === "string") {
            void this.handleExtensionUi(output as unknown as RpcExtensionUIRequest);
            return;
        }
        const type = typeof output.type === "string" ? output.type : "";
        switch (type) {
            case "agent_start":
                this.latestRunAssistantText = "";
                this.latestRunStopReason = undefined;
                this.latestRunHadAssistant = false;
                this.latestRunHandledWithoutAgent = false;
                this.latestRunFailure = undefined;
                this.state.busy = true;
                this.state.phase = "Subagent is working…";
                this.touch();
                return;
            case "agent_end":
                this.state.phase = output.willRetry === true ? "Turn ended; retrying…" : "Finishing…";
                this.touch();
                return;
            case "agent_settled":
                this.state.busy = false;
                this.state.phase = "Ready for another prompt";
                this.settledRevision++;
                this.resolveSettledWaiters();
                this.touch();
                void this.refreshStats();
                return;
            case "message_start":
                this.handleMessageStart(output.message);
                return;
            case "message_update":
                this.handleMessageUpdate(output);
                return;
            case "message_end":
                this.handleMessageEnd(output.message);
                return;
            case "turn_end":
                this.state.phase = "Turn complete";
                this.touch();
                return;
            case "tool_execution_start":
                this.handleToolStart(output);
                return;
            case "tool_execution_update":
                this.handleToolUpdate(output);
                return;
            case "tool_execution_end":
                this.handleToolEnd(output);
                return;
            case "queue_update": {
                const steering = Array.isArray(output.steering) ? output.steering.length : 0;
                const followUp = Array.isArray(output.followUp) ? output.followUp.length : 0;
                if (steering || followUp) this.state.phase = `Queued: ${steering} steer, ${followUp} follow-up`;
                this.touch();
                return;
            }
            case "compaction_start":
                this.state.busy = true;
                this.state.phase = `Compacting (${typeof output.reason === "string" ? output.reason : "automatic"})…`;
                this.addStatus(this.state.phase, "warning");
                return;
            case "compaction_end":
                this.handleCompactionEnd(output);
                return;
            case "auto_retry_start":
                this.state.phase = `Retry ${numberOrZero(output.attempt)}/${numberOrZero(output.maxAttempts)} in ${Math.round(numberOrZero(output.delayMs) / 1000)}s`;
                this.addStatus(`${this.state.phase}: ${typeof output.errorMessage === "string" ? output.errorMessage : "transient error"}`, "warning");
                return;
            case "auto_retry_end":
                this.addStatus(output.success === true ? "Automatic retry succeeded" : `Automatic retry failed${typeof output.finalError === "string" ? `: ${output.finalError}` : ""}`, output.success === true ? "success" : "error");
                return;
            case "summarization_retry_scheduled":
                this.addStatus(`Summary retry scheduled${typeof output.errorMessage === "string" ? `: ${output.errorMessage}` : ""}`, "warning");
                return;
            case "summarization_retry_attempt_start":
                this.state.phase = "Retrying summary…";
                this.touch();
                return;
            case "summarization_retry_finished":
                this.addStatus("Summary retry finished", "info");
                return;
            case "extension_error":
                this.addStatus(`Subagent extension error${typeof output.extensionPath === "string" ? ` (${output.extensionPath})` : ""}: ${typeof output.error === "string" ? output.error : "unknown error"}`, "error");
                return;
            case "thinking_level_changed":
                if (typeof output.level === "string") this.state.thinking = output.level as ChildThinkingLevel;
                this.touch();
                return;
            default:
                return;
        }
    }

    private handleMessageStart(value: unknown): void {
        if (!isRecord(value)) return;
        if (value.role === "user") {
            const text = messageText(value);
            if (text) {
                try {
                    this.options.onPromptDelivered?.(promptFingerprint(text));
                } catch (error) {
                    this.addStatus(`Could not persist delivered prompt state: ${error instanceof Error ? error.message : String(error)}`, "warning");
                }
            }
            return;
        }
        if (value.role !== "assistant") return;
        const item: AssistantItem = {
            kind: "assistant",
            text: visibleAssistantText(value),
            thinking: assistantThinking(value),
            streaming: true,
        };
        this.activeAssistant = item;
        this.appendItem(item);
        this.state.phase = "Streaming response…";
        this.touch();
    }

    private handleMessageUpdate(output: ChildRpcOutput): void {
        const deltaEvent = isRecord(output.assistantMessageEvent) ? output.assistantMessageEvent : undefined;
        if (!deltaEvent) return;
        if (!this.activeAssistant) {
            this.activeAssistant = { kind: "assistant", text: "", thinking: "", streaming: true };
            this.appendItem(this.activeAssistant);
        }
        if (deltaEvent.type === "text_delta" && typeof deltaEvent.delta === "string") {
            this.activeAssistant.text = boundedTranscriptText(this.activeAssistant.text + deltaEvent.delta);
            this.state.phase = "Streaming response…";
        } else if (deltaEvent.type === "thinking_delta" && typeof deltaEvent.delta === "string") {
            this.activeAssistant.thinking = boundedTranscriptText(this.activeAssistant.thinking + deltaEvent.delta);
            this.state.phase = "Thinking…";
        } else if (deltaEvent.type === "toolcall_start") {
            this.state.phase = "Preparing tool call…";
        }
        this.touch(true);
    }

    private handleMessageEnd(value: unknown): void {
        if (!isRecord(value) || value.role !== "assistant") return;
        const item = this.activeAssistant ?? { kind: "assistant" as const, text: "", thinking: "", streaming: false };
        if (!this.activeAssistant || !this.state.items.includes(item)) this.appendItem(item);
        const fullText = visibleAssistantText(value);
        item.text = boundedTranscriptText(fullText);
        item.thinking = boundedTranscriptText(assistantThinking(value));
        item.streaming = false;
        item.stopReason = typeof value.stopReason === "string" ? value.stopReason : undefined;
        item.errorMessage = typeof value.errorMessage === "string" ? boundedError(value.errorMessage).message : undefined;
        this.activeAssistant = undefined;

        this.addUsage(usageFrom(value.usage), true);
        this.latestRunAssistantText = fullText;
        this.latestRunStopReason = item.stopReason;
        this.latestRunHadAssistant = true;
        this.latestRunHandledWithoutAgent = false;
        this.trimTranscript();
        if (item.stopReason === "stop" && fullText.trim()) this.state.lastCompletedAssistantText = fullText;
        if (item.stopReason === "error") {
            this.latestRunFailure = boundedError(item.errorMessage || "Subagent response failed");
            this.state.phase = "Response failed";
        } else if (item.stopReason === "aborted") {
            this.latestRunFailure = new Error("Subagent response aborted");
            this.state.phase = "Response aborted";
        } else this.state.phase = "Finalizing turn…";
        this.touch();
    }

    private handleToolStart(output: ChildRpcOutput): void {
        const id = typeof output.toolCallId === "string" ? output.toolCallId : `tool-${++this.toolSequence}`;
        const name = typeof output.toolName === "string" ? output.toolName : "unknown";
        const item: ToolItem = {
            kind: "tool",
            toolCallId: id,
            name,
            args: formatToolArgs(name, output.args),
            output: "",
            status: "running",
        };
        this.toolsById.set(id, item);
        this.appendItem(item);
        this.state.phase = `Running ${name}…`;
        this.touch();
    }

    private handleToolUpdate(output: ChildRpcOutput): void {
        if (typeof output.toolCallId !== "string") return;
        const item = this.toolsById.get(output.toolCallId);
        if (!item) return;
        const text = resultText(output.partialResult);
        if (text) item.output = text.slice(-MAX_TOOL_OUTPUT_CHARS);
        this.trimTranscript();
        this.touch(true);
    }

    private handleToolEnd(output: ChildRpcOutput): void {
        if (typeof output.toolCallId !== "string") return;
        const item = this.toolsById.get(output.toolCallId);
        if (!item) return;
        const text = resultText(output.result);
        if (text) item.output = text.slice(-MAX_TOOL_OUTPUT_CHARS);
        item.status = output.isError === true ? "error" : "done";
        this.toolsById.delete(output.toolCallId);
        this.trimTranscript();
        this.state.phase = output.isError === true ? `${item.name} failed` : "Streaming response…";
        this.touch();
    }

    private handleCompactionEnd(output: ChildRpcOutput): void {
        const result = isRecord(output.result) ? output.result : undefined;
        this.addUsage(usageFrom(result?.usage), false);
        const error = typeof output.errorMessage === "string" ? output.errorMessage : undefined;
        if (error) this.addStatus(`Compaction failed: ${error}`, "error");
        else if (output.aborted === true) this.addStatus("Compaction aborted", "warning");
        else {
            const before = result ? numberOrZero(result.tokensBefore) : 0;
            const after = result ? numberOrZero(result.estimatedTokensAfter) : 0;
            this.addStatus(`Compaction complete${before || after ? ` (${formatTokens(before)} → ~${formatTokens(after)})` : ""}`, "success");
        }
        this.state.phase = output.willRetry === true ? "Compacted; retrying turn…" : "Ready";
        this.touch();
    }

    private addUsage(usage: Omit<UsageTotals, "turns"> | undefined, countTurn: boolean): void {
        if (!usage) return;
        if (countTurn) this.state.usage.turns++;
        this.state.usage.input += usage.input;
        this.state.usage.output += usage.output;
        this.state.usage.cacheRead += usage.cacheRead;
        this.state.usage.cacheWrite += usage.cacheWrite;
        this.state.usage.totalTokens += usage.totalTokens;
        this.state.usage.cost.input += usage.cost.input;
        this.state.usage.cost.output += usage.cost.output;
        this.state.usage.cost.cacheRead += usage.cost.cacheRead;
        this.state.usage.cost.cacheWrite += usage.cost.cacheWrite;
        this.state.usage.cost.total += usage.cost.total;
    }

    private async refreshStats(): Promise<void> {
        try {
            this.state.stats = await this.rpc.getSessionStats();
            const rpcState = await this.rpc.getState();
            this.applyRpcState(rpcState);
            this.state.phase = "Ready for another prompt";
            this.touch();
        } catch (error) {
            if (!this.stopping) this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    private async handleExtensionUi(request: RpcExtensionUIRequest): Promise<void> {
        try {
            switch (request.method) {
                case "select": {
                    const value = await this.ctx.ui.select(request.title, request.options, request.timeout ? { timeout: request.timeout } : undefined);
                    this.respondValue(request.id, value);
                    return;
                }
                case "confirm": {
                    const confirmed = await this.ctx.ui.confirm(request.title, request.message, request.timeout ? { timeout: request.timeout } : undefined);
                    this.rpc.respondToExtensionUI({ type: "extension_ui_response", id: request.id, confirmed });
                    return;
                }
                case "input": {
                    const value = await this.ctx.ui.input(request.title, request.placeholder, request.timeout ? { timeout: request.timeout } : undefined);
                    this.respondValue(request.id, value);
                    return;
                }
                case "editor": {
                    const value = await this.ctx.ui.editor(request.title, request.prefill);
                    this.respondValue(request.id, value);
                    return;
                }
                case "notify":
                    this.addStatus(request.message, request.notifyType === "error" ? "error" : request.notifyType === "warning" ? "warning" : "info");
                    return;
                case "setStatus":
                    if (request.statusText) this.state.extensionStatuses.set(request.statusKey, request.statusText);
                    else this.state.extensionStatuses.delete(request.statusKey);
                    this.touch();
                    return;
                case "setWidget":
                    if (request.widgetLines) this.state.extensionWidgets.set(request.widgetKey, request.widgetLines);
                    else this.state.extensionWidgets.delete(request.widgetKey);
                    this.touch();
                    return;
                case "set_editor_text":
                    this.setInputCallback?.(request.text);
                    return;
                case "setTitle":
                    // Keep the parent terminal title unchanged.
                    return;
            }
        } catch (error) {
            if (!this.stopping) this.addStatus(`Subagent extension UI failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    }

    private respondValue(id: string, value: string | undefined): void {
        const response: RpcExtensionUIResponse = value === undefined
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value };
        this.rpc.respondToExtensionUI(response);
    }

    private appendItem(item: TranscriptItem): void {
        this.state.items.push(item);
        this.trimTranscript();
    }

    private trimTranscript(): void {
        let totalChars = this.state.items.reduce((total, item) => {
            switch (item.kind) {
                case "user":
                    return total + item.text.length;
                case "assistant":
                    return total + item.text.length + item.thinking.length + (item.errorMessage?.length ?? 0);
                case "tool":
                    return total + item.args.length + item.output.length;
                case "status":
                    return total + item.text.length;
            }
        }, 0);
        while (
            this.state.items.length > 1
            && (this.state.items.length > MAX_CHILD_TRANSCRIPT_ITEMS || totalChars > MAX_TRANSCRIPT_TOTAL_CHARS)
        ) {
            const removed = this.state.items.shift();
            if (!removed) break;
            this.state.omittedItems++;
            switch (removed.kind) {
                case "user":
                    totalChars -= removed.text.length;
                    break;
                case "assistant":
                    totalChars -= removed.text.length + removed.thinking.length + (removed.errorMessage?.length ?? 0);
                    break;
                case "tool":
                    totalChars -= removed.args.length + removed.output.length;
                    break;
                case "status":
                    totalChars -= removed.text.length;
                    break;
            }
        }
    }

    private addStatus(text: string, level: StatusLevel): void {
        this.appendItem({ kind: "status", text: boundedTranscriptText(text), level });
        this.touch();
    }

    private touch(throttled = false): void {
        this.state.revision++;
        if (!throttled) {
            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = undefined;
            }
            for (const refresh of this.refreshCallbacks) refresh();
            return;
        }
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            for (const refresh of this.refreshCallbacks) refresh();
        }, 16);
    }
}

export class ChildPanel implements Focusable {
    private readonly input = new Input();
    private _focused = false;
    private showThinking = true;
    private showToolOutput = true;
    private scrollFromBottom = 0;
    private lastTranscriptHeight = 10;
    private cachedWidth: number | undefined;
    private cachedRevision = -1;
    private cachedThinking = true;
    private cachedToolOutput = true;
    private cachedTranscript: string[] | undefined;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly controller: ChildSessionController;
    private readonly title: string;
    private readonly onReturn: (text: string) => void;
    private readonly onCancel: () => void;

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.input.focused = value;
    }

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        controller: ChildSessionController,
        title: string,
        onReturn: (text: string) => void,
        onCancel: () => void,
    ) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.controller = controller;
        this.title = title;
        this.onReturn = onReturn;
        this.onCancel = onCancel;
        this.input.onSubmit = (value) => {
            void this.submitInput(value);
        };
        this.input.onEscape = () => {
            if (this.controller.state.busy) void this.controller.interrupt();
            else this.onCancel();
        };
    }

    setInput(text: string): void {
        this.input.setValue(text);
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, "app.message.copy")) {
            const text = this.controller.returnText();
            if (text !== undefined) this.onReturn(text);
            return;
        }
        if (this.keybindings.matches(data, "app.interrupt")) {
            if (this.controller.state.busy) void this.controller.interrupt();
            else this.onCancel();
            return;
        }
        if (this.keybindings.matches(data, "app.exit") && !this.input.getValue()) {
            this.onCancel();
            return;
        }
        if (this.keybindings.matches(data, "app.message.followUp")) {
            void this.submitInput(this.input.getValue(), "followUp");
            return;
        }
        if (this.keybindings.matches(data, "app.model.select")) {
            void this.controller.selectModel();
            return;
        }
        if (this.keybindings.matches(data, "app.model.cycleForward")) {
            void this.controller.cycleModel();
            return;
        }
        if (this.keybindings.matches(data, "app.model.cycleBackward")) {
            void this.controller.selectModel();
            return;
        }
        if (this.keybindings.matches(data, "app.thinking.cycle")) {
            void this.controller.cycleThinking();
            return;
        }
        if (this.keybindings.matches(data, "app.thinking.toggle")) {
            this.showThinking = !this.showThinking;
            this.invalidate();
            return;
        }
        if (this.keybindings.matches(data, "app.tools.expand")) {
            this.showToolOutput = !this.showToolOutput;
            this.invalidate();
            return;
        }
        if (this.keybindings.matches(data, "tui.select.pageUp")) {
            this.scrollFromBottom += Math.max(1, this.lastTranscriptHeight - 2);
            this.tui.requestRender();
            return;
        }
        if (this.keybindings.matches(data, "tui.select.pageDown")) {
            this.scrollFromBottom = Math.max(0, this.scrollFromBottom - Math.max(1, this.lastTranscriptHeight - 2));
            this.tui.requestRender();
            return;
        }
        this.input.handleInput(data);
        this.tui.requestRender();
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedTranscript = undefined;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const widths = getChildPanelWidths(width);
        if (!widths) return [this.theme.fg("borderMuted", "·".repeat(width))];

        const { innerWidth } = widths;
        const terminalRows = process.stdout.rows ?? 32;
        const transcriptHeight = Math.max(8, Math.min(42, terminalRows - 11));
        this.lastTranscriptHeight = transcriptHeight;

        const transcript = this.getTranscript(innerWidth);
        const maxScroll = Math.max(0, transcript.length - transcriptHeight);
        this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
        const end = Math.max(transcriptHeight, transcript.length - this.scrollFromBottom);
        const visible = transcript.slice(Math.max(0, end - transcriptHeight), end);
        const padding = Math.max(0, transcriptHeight - visible.length);

        const state = this.controller.state;
        const model = state.model ? `${state.model.provider}/${state.model.id}` : "no model";
        const usage = formatUsageLine(state);
        const status = `${model} · thinking ${state.thinking} · ${state.phase}${usage ? ` · ${usage}` : ""}`;
        const scroll = this.scrollFromBottom > 0 ? ` · ${this.scrollFromBottom} lines below` : "";

        const previousFocus = this.input.focused;
        this.input.focused = false;
        const inputLine = this.input.render(innerWidth)[0] ?? "";
        this.input.focused = previousFocus;

        const lines = [
            this.border(innerWidth, "top"),
            this.frame(this.theme.fg("accent", this.theme.bold(` ${this.title} `)), innerWidth),
            this.frame(this.theme.fg("dim", `${status}${scroll}`), innerWidth),
            this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
        ];
        for (const line of visible) lines.push(this.frame(line, innerWidth));
        for (let index = 0; index < padding; index++) lines.push(this.frame("", innerWidth));
        lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
        lines.push(this.frame(inputLine, innerWidth));
        const detachHint = state.busy ? ` · ${keyHint("app.exit", "detach")}` : "";
        lines.push(this.frame(
            `${keyHint("tui.input.submit", state.busy ? "steer" : "send")} · ${keyHint("app.message.followUp", "follow-up")} · ${keyHint("app.interrupt", state.busy ? "abort" : "close")}${detachHint} · ${keyHint("app.message.copy", "return")}`,
            innerWidth,
        ));
        lines.push(this.frame(
            `${keyHint("app.model.select", "model")} · ${keyHint("app.thinking.cycle", "thinking")} · ${keyHint("app.thinking.toggle", "thoughts")} · ${keyHint("app.tools.expand", "tools")} · ${keyHint("tui.select.pageUp", "scroll")}`,
            innerWidth,
        ));
        lines.push(this.border(innerWidth, "bottom"));
        return lines;
    }

    private async submitInput(rawValue: string, mode?: InputMode): Promise<void> {
        const value = rawValue.trim();
        if (!value) {
            this.controller.setTransientStatus("Enter a subagent prompt first.", "warning");
            return;
        }
        this.input.setValue("");
        this.tui.requestRender();
        const accepted = await this.controller.submit(value, mode);
        if (!accepted && !this.input.getValue()) this.input.setValue(rawValue);
        this.tui.requestRender();
    }

    private getTranscript(width: number): string[] {
        const state = this.controller.state;
        if (
            this.cachedTranscript &&
            this.cachedWidth === width &&
            this.cachedRevision === state.revision &&
            this.cachedThinking === this.showThinking &&
            this.cachedToolOutput === this.showToolOutput
        ) {
            return this.cachedTranscript;
        }
        this.cachedTranscript = renderTranscript(state, width, this.theme, this.showThinking, this.showToolOutput);
        this.cachedWidth = width;
        this.cachedRevision = state.revision;
        this.cachedThinking = this.showThinking;
        this.cachedToolOutput = this.showToolOutput;
        return this.cachedTranscript;
    }

    private frame(content: string, width: number): string {
        const truncated = truncateToWidth(content, width, "");
        return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${this.theme.fg("borderMuted", "│")}`;
    }

    private border(width: number, edge: "top" | "bottom"): string {
        return this.theme.fg("borderMuted", `${edge === "top" ? "┌" : "└"}${"─".repeat(width)}${edge === "top" ? "┐" : "┘"}`);
    }
}

export async function runChildDialog(
    ctx: ExtensionCommandContext,
    controller: ChildSessionController,
    title: string,
    initialPrompt = "",
): Promise<ChildDialogResult | undefined> {
    let detach: (() => void) | undefined;
    try {
        return await ctx.ui.custom<ChildDialogResult>((tui, theme, keybindings, done) => {
            let finished = false;
            const finish = (result: ChildDialogResult) => {
                if (finished) return;
                finished = true;
                done(result);
            };
            const panel = new ChildPanel(
                tui,
                theme,
                keybindings,
                controller,
                title,
                (text) => finish({ action: "return", text }),
                () => finish({ action: "cancel" }),
            );
            panel.focused = true;
            detach = controller.attach(ctx, () => {
                panel.invalidate();
            }, (text) => panel.setInput(text));
            queueMicrotask(() => {
                void controller.start()
                    .then(async () => {
                        if (initialPrompt.trim()) await controller.submit(initialPrompt, "prompt", "human");
                    })
                    .catch(() => {});
            });
            return panel;
        }, {
            overlay: true,
            overlayOptions: {
                width: "94%",
                minWidth: 72,
                maxHeight: "94%",
                anchor: "top-center",
                margin: { top: 1, left: 1, right: 1 },
            },
        });
    } finally {
        detach?.();
    }
}
