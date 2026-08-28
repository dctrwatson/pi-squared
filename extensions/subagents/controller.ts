import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentContextMode, SubagentPersona, SubagentScopedModel } from "./personas.ts";
import {
    capAuthoritativeCompletionText,
    normalizeSubagentRunDurationMs,
    SubagentBackendError,
    type SubagentBackend,
    type SubagentBackendEvent,
    type SubagentBackendFactory,
    type SubagentBackendPanelDetails,
    type SubagentBackendState,
    type SubagentBackendConnection,
    type SubagentExtensionUiRequest,
    type SubagentExtensionUiResponse,
    type SubagentModel,
    type SubagentPromptCompletion as BackendPromptCompletion,
    type SubagentPromptRequestResult,
    type SubagentRun,
    type SubagentRunCompletion,
    type SubagentSessionStats,
    type SubagentThinkingLevel,
    type SubagentUsage,
} from "./backend.ts";
import { createPiRpcBackend } from "./pi-backend.ts";
import type { CursorCloudBackendConfiguration } from "./cursor-backend.ts";

const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;
export const MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS = 100_000;
export const MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS = 500_000;
export const MAX_SUBAGENT_PANEL_DETAILS_CHARS = 24_000;
/** Retry unavailable Cursor panel controls only while an idle panel is open. */
export const CURSOR_CONTROL_AVAILABILITY_RETRY_MS = 30_000;
const MAX_SUBAGENT_PANEL_DETAIL_ITEMS = 50;
const MAX_SUBAGENT_PANEL_DETAIL_TEXT_CHARS = 2_000;
const MAX_REMEMBERED_SETTLED_RUNS = 8;
export const MAX_SUBAGENT_TRANSCRIPT_ITEMS = 200;

export type InputMode = "prompt" | "steer" | "followUp";
export type SubagentStatusLevel = "info" | "warning" | "error" | "success";
export type SubagentPromptSource = "human" | "parent";
export type SubagentControllerLifecycle = "starting" | "ready" | "stopped" | "failed";
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
    reasoningTokens?: number;
}

interface UsageSnapshot {
    readonly values: Omit<UsageTotals, "turns">;
    readonly revisions: Readonly<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "reasoningTokens" | "costInput" | "costOutput" | "costCacheRead" | "costCacheWrite" | "costTotal", number>>;
}

export interface UserItem {
    kind: "user";
    text: string;
    mode: InputMode;
    source: TranscriptPromptSource;
}

export interface AssistantItem {
    kind: "assistant";
    text: string;
    thinking: string;
    streaming: boolean;
    stopReason?: string;
    errorMessage?: string;
}

export interface ToolItem {
    kind: "tool";
    toolCallId: string;
    name: string;
    args: string;
    output: string;
    status: "running" | "done" | "error";
}

export interface StatusItem {
    kind: "status";
    text: string;
    level: SubagentStatusLevel;
}

export type TranscriptItem = UserItem | AssistantItem | ToolItem | StatusItem;

type PanelAttachment = {
    readonly ctx: ExtensionContext;
    readonly refresh: () => void;
    readonly setInput: (text: string) => void;
};

export interface SubagentPanelControlAvailability {
    model: boolean;
    thinking: boolean;
}

export interface SubagentViewState {
    revision: number;
    connected: boolean;
    busy: boolean;
    lifecycle: SubagentControllerLifecycle;
    phase: string;
    /** The active backend connection, if the backend has completed startup. */
    connection?: SubagentBackendConnection;
    /** Bounded backend-neutral data for the expandable details view. */
    details?: SubagentBackendPanelDetails;
    /** The duration of the most recently settled run. */
    durationMs?: number;
    /** A retained completion can return text but cannot accept a new request. */
    readOnly: boolean;
    /** This backend can continue the observed settled run with a normal follow-up. */
    canFollowUp: boolean;
    /** Dynamic idle control availability for the panel. */
    controls: SubagentPanelControlAvailability;
    sessionFile?: string;
    run?: SubagentRun;
    /** The active or most recently observed run for backend-neutral details. */
    lastRun?: SubagentRun;
    model?: SubagentModel;
    thinking: SubagentThinkingLevel;
    items: TranscriptItem[];
    omittedItems: number;
    lastCompletedAssistantText?: string;
    usage: UsageTotals;
    stats?: SubagentSessionStats;
    /** Render extension data only for a backend that advertises extension UI. */
    extensionUi: boolean;
    extensionStatuses: Map<string, string>;
    extensionWidgets: Map<string, string[]>;
}

export interface RunSubagentDialogOptions {
    args: string[];
    cwd: string;
    mode: SubagentContextMode;
    persona?: SubagentPersona;
    initialPrompt: string;
    scopedModels: readonly SubagentScopedModel[];
    promptAttributions?: readonly SubagentPromptAttribution[];
    onPromptAccepted?: (attribution: SubagentPromptAttribution) => void;
    onPromptDelivered?: (fingerprint: string) => void;
    /** Present only when the registry selected the Cursor Cloud runtime. */
    cursor?: CursorCloudBackendConfiguration;
}

/** Controller totals are complete local values even when Cloud events omit fields. */
export interface SubagentPromptCompletion extends Omit<BackendPromptCompletion, "usage"> {
    /** Omitted fields were not reported for this prompt. */
    readonly usage: SubagentUsage;
}

/** A terminal Cursor completion that this controller has exposed to its caller. */
export interface CursorCompletionDelivery {
    readonly run: SubagentRun;
    readonly completion?: SubagentPromptCompletion;
}

type SettledRun = Omit<SubagentPromptCompletion, "usage"> | Error;

interface RunAccumulator {
    started: boolean;
    assistantText: string;
    assistantStopReason: string | undefined;
    hadAssistant: boolean;
    failure: Error | undefined;
    activeAssistant: AssistantItem | undefined;
    readonly toolsById: Map<string, ToolItem>;
    readonly policyWarnings: string[];
    truncationReported: boolean;
    compactionStarted: boolean;
}

interface SettlementWaiter {
    after: number;
    run?: SubagentRun;
    resolve: (settlement: Omit<SubagentPromptCompletion, "usage">) => void;
    reject: (error: Error) => void;
}

interface SubagentSubmission {
    accepted: boolean;
    runResult?: SubagentPromptRequestResult;
    /** Cursor accepted this parent run before reporting cancellation. */
    acceptedRun?: SubagentRun;
}

function boundedError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.length <= MAX_ERROR_CHARS) return new Error(message);
    return new Error(`Subagent error: …${message.slice(-(MAX_ERROR_CHARS - 18))}`);
}

function boundedTranscriptText(text: string): string {
    if (text.length <= MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS) return text;
    const notice = "\n\n[Panel display truncated; full content remains in the subagent session.]";
    return `${text.slice(0, MAX_SUBAGENT_TRANSCRIPT_ITEM_CHARS - notice.length)}${notice}`;
}

/** Defend the panel from an adapter that returns oversized optional metadata. */
function boundedPanelDetails(details: SubagentBackendPanelDetails | undefined): SubagentBackendPanelDetails | undefined {
    if (!details) return undefined;
    let remaining = MAX_SUBAGENT_PANEL_DETAILS_CHARS;
    const text = (value: unknown): string | undefined => {
        if (typeof value !== "string" || remaining <= 0) return undefined;
        const bounded = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, Math.min(MAX_SUBAGENT_PANEL_DETAIL_TEXT_CHARS, remaining));
        if (!bounded) return undefined;
        remaining -= bounded.length;
        return bounded;
    };
    const agentId = text(details.agent?.id);
    const runId = text(details.run?.id);
    const lifecycle = text(details.lifecycle);
    const warnings = (values: readonly string[] | undefined): readonly string[] =>
        (values ?? []).slice(0, MAX_SUBAGENT_PANEL_DETAIL_ITEMS).flatMap((value) => {
            const bounded = text(value);
            return bounded ? [bounded] : [];
        });
    // Keep warning categories ahead of long repository or artifact lists. They
    // describe a delivery constraint and must not be starved by optional data.
    const runtimeWarnings = warnings(details.runtimeWarnings);
    const policyWarnings = warnings(details.policyWarnings);
    const repositories = (details.repositories ?? []).slice(0, MAX_SUBAGENT_PANEL_DETAIL_ITEMS).flatMap((repository) => {
        const url = text(repository.url);
        if (!url) return [];
        const startingRef = text(repository.startingRef);
        return [{ url, ...(startingRef ? { startingRef } : {}) }];
    });
    const artifacts = (details.artifacts ?? []).slice(0, MAX_SUBAGENT_PANEL_DETAIL_ITEMS).flatMap((artifact) => {
        const id = text(artifact.id);
        const name = text(artifact.name);
        if (!id || !name) return [];
        const path = text(artifact.path);
        const url = text(artifact.url);
        const updatedAt = text(artifact.updatedAt);
        const sizeBytes = typeof artifact.sizeBytes === "number" && Number.isFinite(artifact.sizeBytes)
            ? artifact.sizeBytes
            : undefined;
        return [{
            id,
            name,
            ...(path ? { path } : {}),
            ...(url ? { url } : {}),
            ...(sizeBytes === undefined ? {} : { sizeBytes }),
            ...(updatedAt ? { updatedAt } : {}),
        }];
    });
    return {
        ...(agentId ? { agent: { id: agentId } } : {}),
        ...(runId ? { run: { id: runId } } : {}),
        ...(lifecycle ? { lifecycle } : {}),
        ...(repositories.length ? { repositories } : {}),
        ...(artifacts.length ? { artifacts } : {}),
        ...(runtimeWarnings.length ? { runtimeWarnings } : {}),
        ...(policyWarnings.length ? { policyWarnings } : {}),
    };
}

export function formatSubagentTokens(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}

export class SubagentSessionController {
    readonly state: SubagentViewState;
    private readonly backend: SubagentBackend;
    private readonly refreshCallbacks = new Set<() => void>();
    /** Panel attachments exclude registry and persistence subscribers. */
    private readonly panelAttachments = new Map<symbol, PanelAttachment>();
    private panelObservationDisposePromise: Promise<void> | undefined;
    /** A terminal Cursor run that this attached panel observed live. */
    private panelObservedCursorTerminalRunKey: string | undefined;
    /** A retained Cursor result discovered before or after panel observation. */
    private retainedCursorResultRunKey: string | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private controlAvailabilityRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private controlAvailabilityRecoveryEpoch = 0;
    private commandPending = false;
    private stopping = false;
    /** Backend startup can replay durable history before this panel observes live work. */
    private startingBackend = false;
    private startPromise: Promise<void> | undefined;
    private settledRevision = 0;
    private parentRequestCount = 0;
    private latestSettled: SettledRun | undefined;
    private lastSubmissionError: Error | undefined;
    private readonly settledWaiters = new Set<SettlementWaiter>();
    private readonly settledRuns = new Map<string, SettledRun>();
    private readonly settlingRuns = new Set<string>();
    private readonly runAccumulators = new Map<string, RunAccumulator>();
    private settlementSequence = 0;
    private latestSettledSequence = 0;
    private settlementEpoch = 0;
    private activeRun: SubagentRun | undefined;
    private readonly runStartedAt = new Map<string, number>();
    /** Cursor durable result that must return before the next parent dispatch. */
    private pendingCursorResult: SubagentRun | undefined;
    /** The complete Cursor result that the registry must mark as delivered. */
    private cursorResultAwaitingDelivery: SubagentRun | undefined;
    /** Delivery calls are keyed by run to prevent stale acknowledgement races. */
    private readonly cursorResultDeliveryPromises = new Map<string, Promise<void>>();
    /** Terminal Cursor completions read from the authoritative remote completion path. */
    private readonly authoritativeCursorSettlements = new Map<string, SettledRun>();
    /** Parent cancellation can discard only a confirmed aborted terminal run. */
    private readonly cancelledCursorParentRuns = new Set<string>();
    private backendControlAvailability = { model: true, thinking: true };
    private readonly usageRevisions = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal: 0,
    };
    private promptTail: Promise<void> = Promise.resolve();
    private readonly promptAttributions: SubagentPromptAttribution[];
    private ctx: ExtensionContext;
    private readonly options: RunSubagentDialogOptions;

    constructor(
        ctx: ExtensionContext,
        options: RunSubagentDialogOptions,
        backendFactory: SubagentBackendFactory = createPiRpcBackend,
    ) {
        this.ctx = ctx;
        this.options = options;
        const retainedCursorResult = options.cursor?.stored.pendingResult;
        if (retainedCursorResult?.state === "available") {
            this.retainedCursorResultRunKey = `cursor-cloud:${retainedCursorResult.runId}`;
        }
        this.promptAttributions = [...(options.promptAttributions ?? [])];
        this.state = {
            revision: 0,
            connected: false,
            busy: false,
            lifecycle: "starting",
            phase: "Starting subagent…",
            readOnly: false,
            canFollowUp: false,
            controls: { model: false, thinking: false },
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
            extensionUi: false,
            extensionStatuses: new Map(),
            extensionWidgets: new Map(),
        };
        this.backend = backendFactory({
            cwd: options.cwd,
            args: options.args,
            ...(options.cursor ? { cursor: options.cursor } : {}),
            onEvent: (event) => this.handleEvent(event),
            onExit: (details) => {
                this.clearRefreshTimers();
                if (details.intentional || this.stopping) return;
                this.settlementEpoch++;
                this.settlingRuns.clear();
                this.state.connected = false;
                this.state.busy = false;
                this.state.lifecycle = "failed";
                this.state.phase = `${details.description ?? "Subagent backend"} exited`;
                const detail = details.diagnostics.trim() || `code=${details.code ?? "none"}, signal=${details.signal ?? "none"}`;
                const error = boundedError(`${details.description ?? "Subagent backend"} exited: ${detail}`);
                this.rejectSettledWaiters(error);
                this.addStatus(error.message, "error");
            },
        });
        this.state.extensionUi = this.backend.capabilities.extensionUi;
        this.state.phase = `Starting ${this.backend.displayName} subagent…`;
    }

    attach(ctx: ExtensionContext, refresh: () => void, setInput: (text: string) => void): () => void {
        const attachment = Symbol("subagent-panel");
        let detached = false;
        this.panelAttachments.set(attachment, { ctx, refresh, setInput });
        this.refreshCallbacks.add(refresh);
        this.reconcileControlAvailabilityRecovery();
        return () => {
            if (detached) return;
            detached = true;
            this.panelAttachments.delete(attachment);
            this.refreshCallbacks.delete(refresh);
            if (this.panelAttachments.size === 0) {
                this.clearPanelObservedCursorResult();
                this.cancelControlAvailabilityRecovery();
            }
            if (this.refreshCallbacks.size === 0) this.clearRefreshTimers();
        };
    }

    subscribe(refresh: () => void): () => void {
        this.refreshCallbacks.add(refresh);
        return () => {
            this.refreshCallbacks.delete(refresh);
            if (this.refreshCallbacks.size === 0) this.clearRefreshTimers();
        };
    }

    /** Return the newest live panel so interactive requests never target a closed panel. */
    private latestPanelAttachment(): PanelAttachment | undefined {
        let latest: PanelAttachment | undefined;
        for (const attachment of this.panelAttachments.values()) latest = attachment;
        return latest;
    }

    get settlementRevision(): number {
        return this.settledRevision;
    }

    get latestSettledAssistantText(): string | undefined {
        if (!this.latestSettled || this.latestSettled instanceof Error) return undefined;
        return !this.latestSettled.responseProduced || !this.latestSettled.text.trim()
            ? undefined
            : this.latestSettled.text;
    }

    /** Return the Cursor completion that the current parent outcome has exposed. */
    cursorDeliveryForOutcome(): CursorCompletionDelivery | undefined {
        const run = this.cursorResultAwaitingDelivery;
        return run ? this.cursorDeliveryCandidate(run) : undefined;
    }

    /** Expose an authoritative completed Cursor result when the panel returns it. */
    prepareCursorPanelDelivery(run: SubagentRun): CursorCompletionDelivery | undefined {
        const candidate = this.cursorDeliveryCandidate(run);
        if (!candidate?.completion) return undefined;
        this.cursorResultAwaitingDelivery = run;
        return candidate;
    }

    get capabilities() {
        return this.backend.capabilities;
    }

    async start(): Promise<void> {
        // A deferred last-panel disposal is published before its grace microtask.
        // Wait for either outcome before checking the old connection state.
        const panelDisposal = this.panelObservationDisposePromise;
        if (panelDisposal) await panelDisposal;
        if (this.stopping || this.state.connected) return;
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.startInternal();
        return this.startPromise;
    }

    private async startInternal(): Promise<void> {
        if (this.stopping) return;
        this.startingBackend = true;
        try {
            if (this.stopping) return;
            await this.backend.start();
            if (this.stopping) return;
            const state = await this.backend.getState();
            if (this.stopping) return;
            this.applyBackendState(state);
            if (this.backend.capabilities.sessionHistory) {
                await this.hydrateMessages();
                if (this.stopping) return;
            }
            if (this.backend.capabilities.usage) {
                const stats = await this.backend.getSessionStats();
                if (this.stopping) return;
                this.state.stats = stats;
            }
            if (this.stopping) return;
            this.state.connected = true;
            this.state.lifecycle = "ready";
            this.state.phase = "Ready";
            this.touch();
            const startupDiagnostics = this.backend.getDiagnostics().trim();
            if (startupDiagnostics) this.addStatus(`Subagent startup diagnostics: ${startupDiagnostics.slice(-8_000)}`, "warning");
            if (this.options.initialPrompt.trim() && !this.stopping) {
                await this.submit(this.options.initialPrompt, "prompt", "human");
            }
        } catch (error) {
            if (this.stopping) return;
            this.clearRefreshTimers();
            this.state.connected = false;
            this.state.busy = false;
            this.state.lifecycle = "failed";
            this.state.phase = "Failed to start";
            const failure = boundedError(error);
            await this.backend.stop().catch(() => {});
            if (this.stopping) return;
            this.addStatus(failure.message, "error");
            this.rejectSettledWaiters(failure);
            throw failure;
        } finally {
            this.startingBackend = false;
        }
    }

    /** Read reconciled durable Cursor state before the panel accepts an action. */
    async synchronizeCursorState(): Promise<void> {
        if (this.backend.runtime !== "cursor-cloud") return;
        if (!this.state.connected) {
            await this.start();
            return;
        }
        await this.refreshState();
    }

    /** Dispose a Cloud observer only after the last attached panel closes. */
    async disposePanelObservation(): Promise<void> {
        if (this.stopping || this.panelAttachments.size > 0) return;
        if (this.panelObservationDisposePromise) return this.panelObservationDisposePromise;
        const disposal = (async () => {
            // Let another dialog attach in the same turn before closing shared observation.
            await Promise.resolve();
            if (this.stopping || this.panelAttachments.size > 0) return;
            await this.disposeObservation();
        })();
        this.panelObservationDisposePromise = disposal;
        try {
            await disposal;
        } finally {
            if (this.panelObservationDisposePromise === disposal) {
                this.panelObservationDisposePromise = undefined;
            }
        }
    }

    /** Force observer disposal during shutdown or explicit controller cleanup. */
    async disposeObservation(): Promise<void> {
        this.clearPanelObservedCursorResult();
        this.clearRefreshTimers();
        if (!this.backend.disposeObservation) return;
        await this.backend.disposeObservation();
        // A detached Cloud observer has no local completion channel. Recreate it
        // through registry reconciliation before the next prompt or panel open.
        this.startPromise = undefined;
        this.state.connected = false;
        this.state.busy = false;
        this.state.lifecycle = "stopped";
        this.state.phase = "Detached";
        this.state.canFollowUp = false;
        this.touch();
    }

    /** Clear a Cursor completion only after the registry has a complete delivery path. */
    async markCursorRunCompletionDelivered(run?: SubagentRun): Promise<void> {
        if (this.backend.runtime !== "cursor-cloud") return;
        const target = run ?? this.cursorResultAwaitingDelivery;
        if (!target || !this.backend.markRunCompletionDelivered) return;
        const key = this.runKey(target);
        const inFlight = this.cursorResultDeliveryPromises.get(key);
        if (inFlight) return inFlight;
        const acknowledgesRetainedResult = this.pendingCursorResult !== undefined
            && this.runKey(this.pendingCursorResult) === key;
        const delivery = (async () => {
            await this.backend.markRunCompletionDelivered!(target);
            if (this.cursorResultAwaitingDelivery && this.runKey(this.cursorResultAwaitingDelivery) === key) {
                this.cursorResultAwaitingDelivery = undefined;
            }
            if (acknowledgesRetainedResult && this.pendingCursorResult
                && this.runKey(this.pendingCursorResult) === key) {
                this.pendingCursorResult = undefined;
                if (this.panelObservedCursorTerminalRunKey === key) this.panelObservedCursorTerminalRunKey = undefined;
                if (this.retainedCursorResultRunKey === key) this.retainedCursorResultRunKey = undefined;
                this.state.readOnly = false;
                this.state.canFollowUp = !this.activeRun && this.backend.capabilities.settledFollowUp;
                this.touch();
            }
            this.authoritativeCursorSettlements.delete(key);
        })();
        this.cursorResultDeliveryPromises.set(key, delivery);
        try {
            await delivery;
        } finally {
            if (this.cursorResultDeliveryPromises.get(key) === delivery) this.cursorResultDeliveryPromises.delete(key);
        }
    }

    private rememberAuthoritativeCursorSettlement(run: SubagentRun, settled: SettledRun): void {
        if (this.backend.runtime !== "cursor-cloud") return;
        this.authoritativeCursorSettlements.set(this.runKey(run), settled);
        while (this.authoritativeCursorSettlements.size > MAX_REMEMBERED_SETTLED_RUNS) {
            const oldest = this.authoritativeCursorSettlements.keys().next().value;
            if (oldest === undefined) break;
            this.authoritativeCursorSettlements.delete(oldest);
        }
    }

    private cursorDeliveryCandidate(run: SubagentRun): CursorCompletionDelivery | undefined {
        if (this.backend.runtime !== "cursor-cloud") return undefined;
        const settled = this.authoritativeCursorSettlements.get(this.runKey(run));
        if (!settled) return undefined;
        return {
            run,
            ...(settled instanceof Error ? {} : { completion: { ...settled, usage: {} } }),
        };
    }

    private exposeCursorCompletionForDelivery(run: SubagentRun): CursorCompletionDelivery | undefined {
        const candidate = this.cursorDeliveryCandidate(run);
        if (!candidate) return undefined;
        this.cursorResultAwaitingDelivery = run;
        return candidate;
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.settlementEpoch++;
        this.clearRefreshTimers();
        const error = new Error("Subagent process stopped");
        this.rejectSettledWaiters(error);
        this.settlingRuns.clear();
        this.runAccumulators.clear();
        await this.backend.stop();
        this.state.connected = false;
        this.state.busy = false;
        this.state.lifecycle = "stopped";
        this.state.phase = "Stopped";
        this.state.canFollowUp = false;
        this.touch();
    }

    async promptAndWait(text: string, signal?: AbortSignal): Promise<SubagentPromptCompletion> {
        if (this.backend.runtime === "cursor-cloud") return this.promptAndWaitCursor(text, signal);
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
                const settlement = this.waitForSettlement(after, signal);
                const submission = await this.submitInternal(text, this.state.busy ? "followUp" : "prompt", "parent", signal);
                if (!submission.accepted || !submission.runResult) {
                    const error = this.lastSubmissionError ?? new Error("Subagent prompt was not accepted");
                    this.rejectWaitersAfter(after, error);
                    try {
                        await settlement.promise;
                    } catch {
                        throw error;
                    }
                    throw error;
                }
                this.bindSettlementWaiter(settlement.waiter, submission.runResult);
                const result = await settlement.promise;
                return { ...result, usage: this.usageSince(usageBefore) };
            } finally {
                this.parentRequestCount--;
            }
        } finally {
            if (queueAcquired) releasePrompt();
            else void previousPrompt.then(releasePrompt);
        }
    }

    private cursorParentPromptInFlight = false;

    /** Cursor rejects concurrent parent prompts instead of entering Pi's local queue. */
    private async promptAndWaitCursor(text: string, signal?: AbortSignal): Promise<SubagentPromptCompletion> {
        if (this.cursorParentPromptInFlight || this.commandPending) {
            throw new SubagentBackendError("BUSY", "Cursor Cloud already has an active run. Wait for it to settle, then retry.", "cursor-cloud");
        }
        this.cursorParentPromptInFlight = true;
        try {
            this.parentRequestCount++;
            try {
                signal?.throwIfAborted();
                await this.start();
                // A Cursor registry status reconciliation can update durable state
                // while this controller stays connected. Refresh before accepting.
                await this.refreshState();
                // A durable Cursor result remains available until an explicit delivery
                // acknowledgement. A later request must return it instead of clearing it.
                const pendingResult = await this.consumeCursorPendingResult(signal);
                if (pendingResult) {
                    this.exposeCursorCompletionForDelivery(pendingResult.run);
                    return pendingResult.completion;
                }
                if (this.state.busy) {
                    throw new SubagentBackendError("BUSY", "Cursor Cloud already has an active run. Wait for it to settle, then retry.", "cursor-cloud");
                }
                const usageBefore = this.usageSnapshot();
                const after = this.settledRevision;
                const settlement = this.waitForSettlement(after, signal);
                const submission = await this.submitInternal(text, "prompt", "parent", signal);
                if (!submission.accepted || !submission.runResult) {
                    const error = this.lastSubmissionError ?? new Error("Subagent prompt was not accepted");
                    this.rejectWaitersAfter(after, error);
                    try {
                        await settlement.promise;
                    } catch {
                        throw error;
                    }
                    throw error;
                }
                this.bindSettlementWaiter(settlement.waiter, submission.runResult);
                try {
                    const result = await settlement.promise;
                    if (!submission.runResult.handledWithoutRun) {
                        this.exposeCursorCompletionForDelivery(submission.runResult.run);
                    }
                    return { ...result, usage: this.usageSince(usageBefore) };
                } catch (error) {
                    // A terminal Cursor error is a delivered parent outcome only when
                    // it came from an authoritative completion. A cancellation has no
                    // delivery receipt unless that completion is confirmed aborted.
                    if (!submission.runResult.handledWithoutRun) {
                        if (signal?.aborted) {
                            this.cancelledCursorParentRuns.add(this.runKey(submission.runResult.run));
                            await this.discardCancelledCursorCompletionIfAborted(submission.runResult.run).catch(() => {});
                        } else {
                            this.exposeCursorCompletionForDelivery(submission.runResult.run);
                        }
                    }
                    throw error;
                }
            } finally {
                this.parentRequestCount--;
            }
        } finally {
            this.cursorParentPromptInFlight = false;
        }
    }

    private usageSnapshot(): UsageSnapshot {
        const { input, output, cacheRead, cacheWrite, totalTokens, reasoningTokens, cost } = this.state.usage;
        return {
            values: { input, output, cacheRead, cacheWrite, totalTokens, ...(reasoningTokens !== undefined ? { reasoningTokens } : {}), cost: { ...cost } },
            revisions: { ...this.usageRevisions },
        };
    }

    private usageSince(before: UsageSnapshot): SubagentUsage {
        const current = this.usageSnapshot();
        if (this.backend.runtime === "pi") {
            // Pi tool accounting requires complete Usage values. Keep the historic
            // zero-valued shape when Pi emitted no usage event for this response.
            return {
                input: Math.max(0, current.values.input - before.values.input),
                output: Math.max(0, current.values.output - before.values.output),
                cacheRead: Math.max(0, current.values.cacheRead - before.values.cacheRead),
                cacheWrite: Math.max(0, current.values.cacheWrite - before.values.cacheWrite),
                totalTokens: Math.max(0, current.values.totalTokens - before.values.totalTokens),
                cost: {
                    input: Math.max(0, current.values.cost.input - before.values.cost.input),
                    output: Math.max(0, current.values.cost.output - before.values.cost.output),
                    cacheRead: Math.max(0, current.values.cost.cacheRead - before.values.cost.cacheRead),
                    cacheWrite: Math.max(0, current.values.cost.cacheWrite - before.values.cost.cacheWrite),
                    total: Math.max(0, current.values.cost.total - before.values.cost.total),
                },
            };
        }
        const changed = <T extends keyof UsageSnapshot["revisions"]>(field: T): boolean =>
            current.revisions[field] !== before.revisions[field];
        return {
            ...(changed("input") ? { input: Math.max(0, current.values.input - before.values.input) } : {}),
            ...(changed("output") ? { output: Math.max(0, current.values.output - before.values.output) } : {}),
            ...(changed("cacheRead") ? { cacheRead: Math.max(0, current.values.cacheRead - before.values.cacheRead) } : {}),
            ...(changed("cacheWrite") ? { cacheWrite: Math.max(0, current.values.cacheWrite - before.values.cacheWrite) } : {}),
            ...(changed("totalTokens") ? { totalTokens: Math.max(0, current.values.totalTokens - before.values.totalTokens) } : {}),
            ...(changed("reasoningTokens") ? { reasoningTokens: Math.max(0, (current.values.reasoningTokens ?? 0) - (before.values.reasoningTokens ?? 0)) } : {}),
            ...((changed("costInput") || changed("costOutput") || changed("costCacheRead") || changed("costCacheWrite") || changed("costTotal")) ? {
                cost: {
                    ...(changed("costInput") ? { input: Math.max(0, current.values.cost.input - before.values.cost.input) } : {}),
                    ...(changed("costOutput") ? { output: Math.max(0, current.values.cost.output - before.values.cost.output) } : {}),
                    ...(changed("costCacheRead") ? { cacheRead: Math.max(0, current.values.cost.cacheRead - before.values.cost.cacheRead) } : {}),
                    ...(changed("costCacheWrite") ? { cacheWrite: Math.max(0, current.values.cost.cacheWrite - before.values.cost.cacheWrite) } : {}),
                    ...(changed("costTotal") ? { total: Math.max(0, current.values.cost.total - before.values.cost.total) } : {}),
                },
            } : {}),
        };
    }

    async submit(text: string, requestedMode?: InputMode, source: SubagentPromptSource = "human"): Promise<boolean> {
        return (await this.submitInternal(text, requestedMode, source)).accepted;
    }

    private async submitInternal(
        text: string,
        requestedMode?: InputMode,
        source: SubagentPromptSource = "human",
        signal?: AbortSignal,
    ): Promise<SubagentSubmission> {
        this.lastSubmissionError = undefined;
        const message = text.trim();
        if (!message) {
            this.setTransientStatus("Enter a subagent prompt first.", "warning");
            return { accepted: false };
        }
        if (!this.state.connected) {
            this.setTransientStatus("The subagent process is not connected.", "error");
            return { accepted: false };
        }
        if (this.commandPending) {
            this.setTransientStatus("A subagent command is still being accepted.", "warning");
            return { accepted: false };
        }
        if (this.state.readOnly) {
            this.setTransientStatus("This completed result is read-only. Return it before sending another prompt.", "warning");
            return { accepted: false };
        }

        const mode = requestedMode ?? (this.state.busy ? "steer" : this.state.canFollowUp ? "followUp" : "prompt");
        const wasBusy = this.state.busy;
        if (mode === "prompt" && wasBusy) {
            const message = "The subagent is busy; steer it or queue a follow-up instead.";
            if (this.state.phase === "Aborting…" || this.state.phase === "Finishing…") {
                this.addStatus(message, "warning");
            } else {
                this.setTransientStatus(message, "warning");
            }
            return { accepted: false };
        }
        if (mode === "followUp" && !wasBusy && !this.backend.capabilities.settledFollowUp) {
            this.setTransientStatus("The subagent is idle; submit this as a normal prompt.", "warning");
            return { accepted: false };
        }
        const sendAsPrompt = mode === "prompt" || (mode === "steer" && !wasBusy);
        if (!sendAsPrompt && mode === "steer" && !this.backend.capabilities.steering) {
            this.setTransientStatus("The subagent backend does not support steering.", "warning");
            return { accepted: false };
        }
        if (mode === "followUp" && wasBusy && !this.backend.capabilities.queuedFollowUp) {
            this.setTransientStatus("The subagent backend does not support queued follow-ups.", "warning");
            return { accepted: false };
        }

        this.commandPending = true;
        this.appendItem({
            kind: "user",
            text: boundedTranscriptText(message),
            mode: sendAsPrompt ? "prompt" : mode,
            source,
        });
        if (sendAsPrompt || (mode === "followUp" && !wasBusy)) {
            this.state.busy = true;
            this.state.canFollowUp = false;
            this.state.phase = "Starting turn…";
        } else if (mode === "steer") {
            this.state.phase = "Steering queued";
        } else {
            this.state.phase = "Follow-up queued";
        }
        this.touch();

        try {
            let runResult: SubagentPromptRequestResult | undefined;
            if (mode === "followUp") runResult = await this.backend.followUp(message, signal);
            else if (sendAsPrompt) runResult = await this.backend.prompt(message, signal);
            else await this.backend.steer(message);
            if (runResult?.handledWithoutRun) this.completeHandledPrompt();
            else if (runResult?.run && !this.isSettlingOrSettled(runResult.run)) this.activateRun(runResult.run);
            const attribution = { source, fingerprint: promptFingerprint(message) };
            this.promptAttributions.push(attribution);
            try {
                this.options.onPromptAccepted?.(attribution);
            } catch (error) {
                this.addStatus(`Could not persist prompt attribution: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            return { accepted: true, ...(runResult ? { runResult } : {}) };
        } catch (error) {
            const acceptedRun = error instanceof SubagentBackendError && error.acceptedRun?.runtime === "cursor-cloud"
                ? error.acceptedRun
                : undefined;
            // Agent.send can accept and emit a run before the cancellation check makes
            // backend.prompt reject. Retain that run identity for terminal inspection.
            if (acceptedRun && !this.isSettlingOrSettled(acceptedRun)) this.activateRun(acceptedRun);
            if (acceptedRun && (error instanceof SubagentBackendError && error.code === "CANCELLED")) {
                this.cancelledCursorParentRuns.add(this.runKey(acceptedRun));
                await this.discardCancelledCursorCompletionIfAborted(acceptedRun).catch(() => {});
            }
            this.lastSubmissionError = boundedError(error);
            if (sendAsPrompt || (mode === "followUp" && !wasBusy)) {
                if (this.activeRun) {
                    this.state.busy = true;
                    this.state.phase = signal?.aborted ? "Aborting…" : "Finishing…";
                } else {
                    this.state.busy = wasBusy;
                    this.state.phase = "Prompt was not accepted";
                }
            }
            this.addStatus(this.lastSubmissionError.message, "error");
            return { accepted: false, ...(acceptedRun ? { acceptedRun } : {}) };
        } finally {
            this.commandPending = false;
        }
    }

    async interrupt(): Promise<void> {
        if (!this.state.busy || !this.state.connected) return;
        this.state.phase = "Aborting…";
        this.touch();
        try {
            await this.backend.abort();
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
        if (!this.canChangeRuntime("model", "model", this.backend.capabilities.modelControls)) return;
        try {
            const availableModels = await this.backend.getAvailableModels();
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
            const selected = await (this.latestPanelAttachment()?.ctx ?? this.ctx).ui.select("Select subagent model", choices);
            if (!selected) return;
            const index = choices.indexOf(selected);
            const model = models[index];
            if (!model) return;
            this.state.phase = "Changing model…";
            this.touch();
            this.state.model = await this.backend.setModel(model.provider, model.id);
            const scoped = scope.find((candidate) => candidate.provider === model.provider && candidate.id === model.id);
            if (scoped?.thinkingLevel && this.backend.capabilities.thinkingControls) {
                await this.backend.setThinkingLevel(scoped.thinkingLevel);
                this.state.thinking = scoped.thinkingLevel;
            }
            await this.refreshState();
            this.addStatus(`Subagent model: ${model.provider}/${model.id}`, "info");
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    async cycleModel(): Promise<void> {
        if (!this.canChangeRuntime("model", "model", this.backend.capabilities.modelControls)) return;
        try {
            const result = await this.backend.cycleModel();
            if (!result) {
                this.setTransientStatus("No other subagent model is available.", "info");
                return;
            }
            this.state.model = result.model;
            this.state.thinking = result.thinkingLevel;
            await this.refreshState();
            this.addStatus(`Subagent model: ${result.model.provider}/${result.model.id}`, "info");
        } catch (error) {
            this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    async cycleThinking(): Promise<void> {
        if (!this.canChangeRuntime("thinking", "thinking level", this.backend.capabilities.thinkingControls)) return;
        try {
            const result = await this.backend.cycleThinkingLevel();
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

    setTransientStatus(text: string, level: SubagentStatusLevel): void {
        this.state.phase = text;
        if (level === "error") this.appendItem({ kind: "status", text: boundedTranscriptText(text), level });
        this.touch();
    }

    private canChangeRuntime(
        control: keyof SubagentPanelControlAvailability,
        label: string,
        supported: boolean,
    ): boolean {
        if (!supported) {
            this.setTransientStatus(`The subagent backend does not support ${label} changes.`, "warning");
            return false;
        }
        if (!this.state.connected) {
            this.setTransientStatus("The subagent process is not connected.", "error");
            return false;
        }
        if (this.state.readOnly) {
            this.setTransientStatus(`This completed result is read-only. Return it before changing its ${label}.`, "warning");
            return false;
        }
        if (this.state.busy) {
            this.setTransientStatus(`Wait for the subagent to settle before changing its ${label}.`, "warning");
            return false;
        }
        if (!this.state.controls[control]) {
            this.setTransientStatus(`The selected subagent model does not support ${label} changes.`, "warning");
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
    ): { waiter: SettlementWaiter; promise: Promise<Omit<SubagentPromptCompletion, "usage">> } {
        let waiter!: SettlementWaiter;
        const promise = new Promise<Omit<SubagentPromptCompletion, "usage">>((resolve, reject) => {
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
        return { waiter, promise };
    }

    private bindSettlementWaiter(waiter: SettlementWaiter, result: SubagentPromptRequestResult): void {
        if (!this.settledWaiters.has(waiter)) return;
        if (result.handledWithoutRun) {
            this.settledWaiters.delete(waiter);
            waiter.resolve({ text: "", responseProduced: false, handledWithoutAgent: true });
            return;
        }
        waiter.run = result.run;
        const settled = this.settledRuns.get(this.runKey(result.run));
        if (settled) {
            this.settleWaiter(waiter, settled);
            return;
        }
        if (this.settlingRuns.has(this.runKey(result.run))) return;
        this.activateRun(result.run);
    }

    private resolveSettledWaiters(run: SubagentRun, settled: SettledRun): void {
        for (const waiter of [...this.settledWaiters]) {
            if (!waiter.run || this.runKey(waiter.run) !== this.runKey(run)) continue;
            this.settleWaiter(waiter, settled);
        }
    }

    private resolveResponseWaiters(run: SubagentRun): void {
        const accumulator = this.getActiveRunAccumulator(run);
        if (!accumulator?.hadAssistant) return;
        const waiters = [...this.settledWaiters].filter(
            (waiter) => waiter.run && this.runKey(waiter.run) === this.runKey(run),
        );
        if (waiters.length === 0) return;

        const fallback: SettledRun = accumulator.failure ?? {
            text: accumulator.assistantText,
            responseProduced: true,
            handledWithoutAgent: false,
            ...(accumulator.assistantStopReason ? { stopReason: accumulator.assistantStopReason } : {}),
        };
        void this.resolveResponseWaitersInternal(run, waiters, fallback);
    }

    private async resolveResponseWaitersInternal(
        run: SubagentRun,
        waiters: readonly SettlementWaiter[],
        fallback: SettledRun,
    ): Promise<void> {
        let response = fallback;
        try {
            const completion = this.backend.getRunCompletion
                ? await this.backend.getRunCompletion(run)
                : undefined;
            if (completion) response = this.settlementFromCompletion(completion, fallback);
        } catch {
            // The normalized response remains available when authoritative retrieval fails.
        }
        for (const waiter of waiters) {
            if (!this.settledWaiters.has(waiter)) continue;
            if (!waiter.run || this.runKey(waiter.run) !== this.runKey(run)) continue;
            this.settleWaiter(waiter, response);
        }
    }

    private settleWaiter(waiter: SettlementWaiter, settled: SettledRun): void {
        this.settledWaiters.delete(waiter);
        if (settled instanceof Error) waiter.reject(settled);
        else waiter.resolve(settled);
    }

    private rememberSettledRun(run: SubagentRun, settled: SettledRun): void {
        const key = this.runKey(run);
        this.settledRuns.set(key, settled);
        while (this.settledRuns.size > MAX_REMEMBERED_SETTLED_RUNS) {
            const first = this.settledRuns.keys().next().value;
            if (first === undefined) break;
            this.settledRuns.delete(first);
        }
    }

    private runKey(run: SubagentRun): string {
        return `${run.runtime}:${run.id}`;
    }

    private isSettlingOrSettled(run: SubagentRun): boolean {
        const key = this.runKey(run);
        return this.settledRuns.has(key) || this.settlingRuns.has(key);
    }

    private activateRun(run: SubagentRun): void {
        if (this.isSettlingOrSettled(run)) return;
        if (this.activeRun && this.runKey(this.activeRun) !== this.runKey(run)) return;
        const isNewRun = !this.activeRun;
        this.activeRun = run;
        this.state.run = run;
        this.state.lastRun = run;
        this.state.canFollowUp = false;
        if (isNewRun) {
            this.state.durationMs = undefined;
            if (this.backend.runtime === "cursor-cloud") this.panelObservedCursorTerminalRunKey = undefined;
            this.replaceCursorRunDetails(run, "running");
        }
        const key = this.runKey(run);
        if (!this.runStartedAt.has(key)) this.runStartedAt.set(key, Date.now());
        if (!this.isParentOwned(run)) this.clearObservationOnlyReturnState();
        this.getRunAccumulator(run);
    }

    /** Replace terminal Cursor metadata before a new run can render stale values. */
    private replaceCursorRunDetails(
        run: SubagentRun,
        lifecycle: string,
        completion?: SubagentRunCompletion,
    ): void {
        if (this.backend.runtime !== "cursor-cloud") return;
        const previous = this.state.details;
        this.state.details = boundedPanelDetails({
            ...(previous?.agent ? { agent: previous.agent } : {}),
            run: { id: run.id },
            lifecycle,
            ...(previous?.repositories?.length ? { repositories: previous.repositories } : {}),
            ...(completion?.artifacts?.length ? { artifacts: completion.artifacts } : {}),
            ...(completion?.runtimeWarnings?.length
                ? { runtimeWarnings: completion.runtimeWarnings }
                : previous?.runtimeWarnings?.length ? { runtimeWarnings: previous.runtimeWarnings } : {}),
            ...(completion?.policyWarnings?.length ? { policyWarnings: completion.policyWarnings } : {}),
        });
    }

    private isParentOwned(run: SubagentRun): boolean {
        return run.parentOwned !== false;
    }

    /** Retain a live terminal Cursor observation only for the attached panel that saw it. */
    private observeCursorTerminalRunInPanel(run: SubagentRun): void {
        if (this.backend.runtime !== "cursor-cloud" || this.startingBackend
            || !this.isParentOwned(run) || this.panelAttachments.size === 0) return;
        const key = this.runKey(run);
        if (this.retainedCursorResultRunKey === key) return;
        this.panelObservedCursorTerminalRunKey = key;
    }

    /** Apply durable delivery safety unless this panel observed the exact terminal run. */
    private reconcileCursorReadOnly(pendingResult: SubagentRun | undefined): void {
        if (this.backend.runtime !== "cursor-cloud") return;
        if (!pendingResult) {
            this.retainedCursorResultRunKey = undefined;
            this.state.readOnly = false;
            return;
        }
        const key = this.runKey(pendingResult);
        const observedInPanel = this.panelAttachments.size > 0
            && this.panelObservedCursorTerminalRunKey === key
            && this.retainedCursorResultRunKey !== key;
        if (!observedInPanel) this.retainedCursorResultRunKey = key;
        this.state.readOnly = !observedInPanel;
        if (this.state.readOnly) this.state.canFollowUp = false;
    }

    /** Drop a panel-only observation so a later open must deliver the durable result. */
    private clearPanelObservedCursorResult(): void {
        if (!this.panelObservedCursorTerminalRunKey) return;
        const observedKey = this.panelObservedCursorTerminalRunKey;
        this.panelObservedCursorTerminalRunKey = undefined;
        this.retainedCursorResultRunKey = observedKey;
        this.state.readOnly = true;
        this.state.canFollowUp = false;
        this.touch();
    }

    /** An external observation must never reuse a prior local panel return value. */
    private clearObservationOnlyReturnState(): void {
        this.state.lastCompletedAssistantText = undefined;
        this.state.canFollowUp = false;
        this.latestSettled = undefined;
    }

    private beginRun(run: SubagentRun): RunAccumulator | undefined {
        if (this.isSettlingOrSettled(run)) return undefined;
        if (this.activeRun && this.runKey(this.activeRun) !== this.runKey(run)) return undefined;
        this.activateRun(run);
        const accumulator = this.getRunAccumulator(run);
        if (!accumulator.started) {
            accumulator.started = true;
            accumulator.assistantText = "";
            accumulator.assistantStopReason = undefined;
            accumulator.hadAssistant = false;
            accumulator.failure = undefined;
            accumulator.activeAssistant = undefined;
            accumulator.toolsById.clear();
            accumulator.policyWarnings.length = 0;
            accumulator.truncationReported = false;
            accumulator.compactionStarted = false;
        }
        return accumulator;
    }

    private isActiveRun(run: SubagentRun): boolean {
        return this.activeRun !== undefined && this.runKey(this.activeRun) === this.runKey(run);
    }

    private getActiveRunAccumulator(run: SubagentRun): RunAccumulator | undefined {
        return this.isActiveRun(run) ? this.getRunAccumulator(run) : undefined;
    }

    private getRunAccumulator(run: SubagentRun): RunAccumulator {
        const key = this.runKey(run);
        let accumulator = this.runAccumulators.get(key);
        if (!accumulator) {
            accumulator = {
                started: false,
                assistantText: "",
                assistantStopReason: undefined,
                hadAssistant: false,
                failure: undefined,
                activeAssistant: undefined,
                toolsById: new Map(),
                policyWarnings: [],
                truncationReported: false,
                compactionStarted: false,
            };
            this.runAccumulators.set(key, accumulator);
        }
        return accumulator;
    }

    private reportRunTruncation(accumulator: RunAccumulator): void {
        if (accumulator.truncationReported) return;
        accumulator.truncationReported = true;
        this.addStatus("Subagent event content was truncated for panel state.", "warning");
    }

    private completeHandledPrompt(): void {
        this.latestSettled = { text: "", responseProduced: false, handledWithoutAgent: true };
        this.state.busy = false;
        this.state.canFollowUp = false;
        this.state.phase = "Ready for another prompt";
        this.settledRevision++;
        this.touch();
        void this.refreshStats();
    }

    private settlementFromCompletion(completion: SubagentRunCompletion, fallback: SettledRun): SettledRun {
        const fallbackCompletion = fallback instanceof Error ? undefined : fallback;
        const stopReason = completion.stopReason ?? fallbackCompletion?.stopReason;
        if (stopReason === "error") {
            return boundedError(completion.errorMessage || (fallback instanceof Error ? fallback.message : "Subagent response failed"));
        }
        if (stopReason === "aborted") return new Error("Subagent response aborted");
        if (fallback instanceof Error && completion.stopReason === undefined) return fallback;
        const text = capAuthoritativeCompletionText(completion.text);
        return {
            text: text.text,
            responseProduced: completion.responseProduced,
            handledWithoutAgent: false,
            ...(stopReason ? { stopReason } : {}),
            ...(completion.artifacts?.length ? { artifacts: completion.artifacts } : {}),
            ...(completion.policyWarnings?.length ? { policyWarnings: [...new Set(completion.policyWarnings)].slice(0, 4) } : {}),
            ...(completion.runtimeWarnings?.length ? { runtimeWarnings: [...new Set(completion.runtimeWarnings)].slice(0, 4) } : {}),
            ...(completion.truncated || text.truncated ? { truncated: true as const } : {}),
        };
    }

    /** Clear only a confirmed aborted Cursor completion after parent cancellation. */
    private async discardCancelledCursorCompletionIfAborted(run: SubagentRun): Promise<void> {
        if (this.backend.runtime !== "cursor-cloud" || !this.backend.getRunCompletion) return;
        const completion = await this.backend.getRunCompletion(run);
        if (completion?.stopReason !== "aborted") return;
        await this.markCursorRunCompletionDelivered(run);
    }

    /** Return a durable Cursor result before a new parent prompt can dispatch. */
    private async consumeCursorPendingResult(
        signal?: AbortSignal,
    ): Promise<{ readonly run: SubagentRun; readonly completion: SubagentPromptCompletion } | undefined> {
        const run = this.pendingCursorResult;
        if (this.backend.runtime !== "cursor-cloud" || !run || !this.backend.getRunCompletion) return undefined;
        const completion = await this.backend.getRunCompletion(run);
        if (!completion) {
            throw new SubagentBackendError(
                "BACKEND_FAILED",
                "Cursor Cloud has an undelivered result that could not be recovered. Open the subagent or refresh status before retrying.",
                "cursor-cloud",
            );
        }
        const settled = this.settlementFromCompletion(completion, {
            text: "",
            responseProduced: false,
            handledWithoutAgent: false,
        });
        this.state.durationMs = normalizeSubagentRunDurationMs(completion.durationMs);
        this.rememberAuthoritativeCursorSettlement(run, settled);
        if (signal?.aborted) {
            if (completion.stopReason === "aborted") await this.markCursorRunCompletionDelivered(run);
            throw signal.reason instanceof Error ? signal.reason : new Error("Subagent prompt aborted");
        }
        if (settled instanceof Error) {
            // A terminal Cursor error still needs a post-persistence receipt. Keep its
            // durable completion until the caller returns the failure ToolResult.
            this.exposeCursorCompletionForDelivery(run);
            throw settled;
        }
        return { run, completion: { ...settled, usage: completion.usage ?? {} } };
    }

    private async finalizeRunSettlement(
        run: SubagentRun,
        fallback: SettledRun,
        sequence: number,
        epoch: number,
    ): Promise<void> {
        const parentOwned = this.isParentOwned(run);
        let settled = parentOwned ? fallback : {
            text: "",
            responseProduced: false,
            handledWithoutAgent: false,
        };
        let completion: SubagentRunCompletion | undefined;
        try {
            completion = parentOwned && this.backend.getRunCompletion
                ? await this.backend.getRunCompletion(run)
                : undefined;
            if (completion) {
                settled = this.settlementFromCompletion(completion, fallback);
                this.rememberAuthoritativeCursorSettlement(run, settled);
            }
        } catch (error) {
            const failure = boundedError(error);
            if (!this.stopping && epoch === this.settlementEpoch && !this.activeRun) {
                this.addStatus(boundedError(`Could not read full subagent completion: ${failure.message}`).message, "warning");
            }
        }
        if (this.stopping || epoch !== this.settlementEpoch) return;

        const runKey = this.runKey(run);
        const startedAt = this.runStartedAt.get(runKey);
        this.runStartedAt.delete(runKey);
        if (this.backend.runtime === "cursor-cloud") {
            this.state.durationMs = normalizeSubagentRunDurationMs(completion?.durationMs);
            this.replaceCursorRunDetails(run, "idle", completion);
        } else if (startedAt !== undefined) {
            this.state.durationMs = Math.max(0, Date.now() - startedAt);
        } else {
            this.state.durationMs = undefined;
        }
        if (this.cancelledCursorParentRuns.has(runKey)) {
            this.cancelledCursorParentRuns.delete(runKey);
            // Parent cancellation is not a result delivery. It can clear only an
            // authoritative aborted completion, which makes task and persistent
            // agents reusable without replaying a cancellation as a follow-up.
            if (completion?.stopReason === "aborted") {
                try {
                    await this.markCursorRunCompletionDelivered(run);
                } catch {
                    // Keep the durable completion if local persistence did not finish.
                }
            }
        }

        this.settlingRuns.delete(runKey);
        this.rememberSettledRun(run, settled);
        this.resolveSettledWaiters(run, settled);
        const isLatestSettlement = sequence >= this.latestSettledSequence;
        if (isLatestSettlement) {
            this.latestSettledSequence = sequence;
            this.latestSettled = settled;
        }
        if (!this.activeRun) {
            this.state.busy = false;
            this.state.canFollowUp = parentOwned && !this.state.readOnly && this.backend.capabilities.settledFollowUp;
            this.state.phase = "Ready for another prompt";
            if (!parentOwned) {
                this.clearObservationOnlyReturnState();
            } else if (isLatestSettlement && !(settled instanceof Error)
                && settled.stopReason === "stop" && settled.text.trim()) {
                this.state.lastCompletedAssistantText = settled.text;
            }
            void this.refreshStats();
        }
        this.settledRevision++;
        this.touch();
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
        const messages = await this.backend.getHistory();
        if (this.stopping || messages.length === 0 || this.state.items.length > 0) return;

        const hydratedUsers = messages.flatMap((message, messageIndex) =>
            message.role === "user" && message.text ? [{ messageIndex, text: message.text }] : []);
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

        for (const [messageIndex, message] of messages.entries()) {
            if (message.role === "user") {
                this.appendItem({
                    kind: "user",
                    text: boundedTranscriptText(message.text),
                    mode: "prompt",
                    source: sourceByMessageIndex.get(messageIndex) ?? (this.options.mode === "fork" ? "context" : "unknown"),
                });
                continue;
            }
            const item: AssistantItem = {
                kind: "assistant",
                text: boundedTranscriptText(message.text),
                thinking: boundedTranscriptText(message.thinking),
                streaming: false,
                ...(message.stopReason ? { stopReason: message.stopReason } : {}),
                ...(message.errorMessage ? { errorMessage: boundedError(message.errorMessage).message } : {}),
            };
            this.appendItem(item);
            if (item.stopReason === "stop" && message.text.trim()) this.state.lastCompletedAssistantText = message.text;
        }
    }

    private async refreshState(): Promise<void> {
        const state = await this.backend.getState();
        this.applyBackendState(state);
        this.touch();
    }

    private applyBackendState(state: SubagentBackendState): void {
        this.pendingCursorResult = state.pendingResult;
        this.state.connection = state.connection;
        this.state.details = boundedPanelDetails(state.details);
        this.backendControlAvailability = {
            model: state.controlAvailability?.model ?? true,
            thinking: state.controlAvailability?.thinking ?? true,
        };
        if (state.run) this.activateRun(state.run);
        if (this.backend.runtime === "cursor-cloud" && state.pendingResult && this.activeRun
            && this.runKey(this.activeRun) === this.runKey(state.pendingResult)) {
            this.observeCursorTerminalRunInPanel(state.pendingResult);
        }
        this.reconcileCursorReadOnly(state.pendingResult);
        if (this.backend.runtime === "cursor-cloud" && this.activeRun
            && this.state.details?.run?.id !== this.activeRun.id) {
            this.replaceCursorRunDetails(this.activeRun, "running");
        }
        // Cursor durable reconciliation is authoritative. It can settle a run while
        // this connected controller still has a stale local observer. Do not only
        // clear the active run: a parent waiter still needs the retained completion.
        if (!state.run && this.backend.runtime === "cursor-cloud" && this.activeRun) {
            const activeRun = this.activeRun;
            if (state.pendingResult && this.runKey(state.pendingResult) === this.runKey(activeRun)) {
                const accumulator = this.runAccumulators.get(this.runKey(activeRun));
                const fallback: SettledRun = this.isParentOwned(activeRun)
                    ? accumulator?.failure ?? {
                        text: accumulator?.assistantText ?? "",
                        responseProduced: accumulator?.hadAssistant ?? false,
                        handledWithoutAgent: false,
                        ...(accumulator?.assistantStopReason ? { stopReason: accumulator.assistantStopReason } : {}),
                        ...(accumulator?.policyWarnings.length ? { policyWarnings: [...accumulator.policyWarnings] } : {}),
                    }
                    : { text: "", responseProduced: false, handledWithoutAgent: false };
                this.activeRun = undefined;
                this.state.run = undefined;
                this.state.busy = true;
                this.state.phase = "Finalizing turn…";
                this.settlingRuns.add(this.runKey(activeRun));
                this.runAccumulators.delete(this.runKey(activeRun));
                const sequence = ++this.settlementSequence;
                const epoch = this.settlementEpoch;
                void this.finalizeRunSettlement(activeRun, fallback, sequence, epoch);
            } else {
                this.runAccumulators.delete(this.runKey(activeRun));
                this.activeRun = undefined;
                this.state.run = undefined;
            }
        }
        if (state.model) this.state.model = state.model;
        this.state.sessionFile = this.backend.capabilities.sessionFile ? state.sessionFile : undefined;
        this.state.thinking = state.thinkingLevel;
        // A state refresh for a settled run must not clear a newer active run.
        if (!this.activeRun || (state.run && this.isActiveRun(state.run))) {
            this.state.busy = state.isStreaming || state.isCompacting;
        }
    }

    private handleEvent(event: SubagentBackendEvent): void {
        switch (event.type) {
            case "extension_ui_request":
                if (!this.backend.capabilities.extensionUi) {
                    this.addStatus("The subagent backend sent unsupported extension UI data.", "warning");
                    return;
                }
                if (event.run && !this.isActiveRun(event.run)) return;
                void this.handleExtensionUi(event.request);
                return;
            case "run_started": {
                if (!this.beginRun(event.run)) return;
                this.state.busy = true;
                this.state.phase = "Subagent is working…";
                this.touch();
                return;
            }
            case "run_ended":
                if (!this.isActiveRun(event.run)) return;
                this.state.phase = event.willRetry ? "Turn ended; retrying…" : "Finishing…";
                this.touch();
                return;
            case "run_settled": {
                const accumulator = this.getActiveRunAccumulator(event.run);
                if (!accumulator) return;
                this.observeCursorTerminalRunInPanel(event.run);
                const fallback: SettledRun = this.isParentOwned(event.run)
                    ? accumulator.failure ?? {
                        text: accumulator.assistantText,
                        responseProduced: accumulator.hadAssistant,
                        handledWithoutAgent: false,
                        ...(accumulator.assistantStopReason ? { stopReason: accumulator.assistantStopReason } : {}),
                        ...(accumulator.policyWarnings.length ? { policyWarnings: [...accumulator.policyWarnings] } : {}),
                    }
                    : { text: "", responseProduced: false, handledWithoutAgent: false };
                this.activeRun = undefined;
                this.state.run = undefined;
                this.state.busy = true;
                this.state.phase = "Finalizing turn…";
                this.settlingRuns.add(this.runKey(event.run));
                this.runAccumulators.delete(this.runKey(event.run));
                const sequence = ++this.settlementSequence;
                const epoch = this.settlementEpoch;
                this.touch();
                void this.finalizeRunSettlement(event.run, fallback, sequence, epoch);
                return;
            }
            case "message_started":
                this.handleMessageStart(event);
                return;
            case "message_delta":
                this.handleMessageUpdate(event);
                return;
            case "message_completed":
                this.handleMessageEnd(event);
                return;
            case "turn_completed":
                if (!this.isActiveRun(event.run)) return;
                this.state.phase = "Turn complete";
                this.touch();
                return;
            case "tool_started":
                this.handleToolStart(event);
                return;
            case "tool_updated":
                this.handleToolUpdate(event);
                return;
            case "tool_completed":
                this.handleToolEnd(event);
                return;
            case "queue_changed":
                if (!this.isActiveRun(event.run)) return;
                if (event.steering || event.followUp) this.state.phase = `Queued: ${event.steering} steer, ${event.followUp} follow-up`;
                this.touch();
                return;
            case "compaction_started": {
                const accumulator = this.getActiveRunAccumulator(event.run);
                if (!accumulator) return;
                accumulator.compactionStarted = true;
                this.state.busy = true;
                this.state.phase = `Compacting (${event.reason})…`;
                this.addStatus(this.state.phase, "warning");
                if (this.backend.runtime === "pi") this.resolveResponseWaiters(event.run);
                return;
            }
            case "compaction_completed":
                this.handleCompactionEnd(event);
                return;
            case "retry_started":
                if (!this.isActiveRun(event.run)) return;
                this.state.phase = `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s`;
                this.addStatus(`${this.state.phase}: ${event.errorMessage}`, "warning");
                return;
            case "retry_completed":
                if (!this.isActiveRun(event.run)) return;
                this.addStatus(event.success ? "Automatic retry succeeded" : `Automatic retry failed${event.finalError ? `: ${event.finalError}` : ""}`, event.success ? "success" : "error");
                return;
            case "summary_retry_scheduled":
                if (!this.isActiveRun(event.run)) return;
                this.addStatus(`Summary retry scheduled${event.errorMessage ? `: ${event.errorMessage}` : ""}`, "warning");
                return;
            case "summary_retry_started":
                if (!this.isActiveRun(event.run)) return;
                this.state.phase = "Retrying summary…";
                this.touch();
                return;
            case "summary_retry_completed":
                if (!this.isActiveRun(event.run)) return;
                this.addStatus("Summary retry finished", "info");
                return;
            case "extension_error":
                if (event.run && !this.isActiveRun(event.run)) return;
                this.addStatus(`Subagent extension error${event.extensionPath ? ` (${event.extensionPath})` : ""}: ${event.error}`, "error");
                return;
            case "usage_update":
                if (!this.isActiveRun(event.run)) return;
                this.addUsage(event.usage, false);
                this.touch();
                return;
            case "status_update":
                if (!this.isActiveRun(event.run)) return;
                this.setTransientStatus(event.status, "info");
                return;
            case "runtime_warning":
                if (!this.isParentOwned(event.run) || !this.isActiveRun(event.run)) return;
                this.addStatus(event.warning, "warning");
                return;
            case "policy_warning": {
                if (!this.isParentOwned(event.run)) return;
                const accumulator = this.getActiveRunAccumulator(event.run);
                if (!accumulator) return;
                const warning = event.warning.slice(0, MAX_ERROR_CHARS);
                if (!accumulator.policyWarnings.includes(warning) && accumulator.policyWarnings.length < 4) {
                    accumulator.policyWarnings.push(warning);
                }
                this.addStatus(`Cursor Cloud policy warning: ${warning}`, "warning");
                return;
            }
            case "thinking_changed":
                this.state.thinking = event.level;
                this.touch();
                return;
        }
    }

    private handleMessageStart(event: Extract<SubagentBackendEvent, { type: "message_started" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        if (!accumulator) return;
        const { message } = event;
        if (message.role === "user") {
            try {
                this.options.onPromptDelivered?.(message.fullTextFingerprint ?? promptFingerprint(message.text));
            } catch (error) {
                this.addStatus(`Could not persist delivered prompt state: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            if (message.truncated) this.reportRunTruncation(accumulator);
            return;
        }
        const item: AssistantItem = {
            kind: "assistant",
            text: boundedTranscriptText(message.text),
            thinking: boundedTranscriptText(message.thinking),
            streaming: true,
        };
        accumulator.activeAssistant = item;
        this.appendItem(item);
        if (message.truncated) this.reportRunTruncation(accumulator);
        this.state.phase = "Streaming response…";
        this.touch();
    }

    private handleMessageUpdate(event: Extract<SubagentBackendEvent, { type: "message_delta" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        if (!accumulator) return;
        if (!accumulator.activeAssistant) {
            accumulator.activeAssistant = { kind: "assistant", text: "", thinking: "", streaming: true };
            this.appendItem(accumulator.activeAssistant);
        }
        if (event.textDelta) {
            accumulator.activeAssistant.text = boundedTranscriptText(accumulator.activeAssistant.text + event.textDelta);
            this.state.phase = "Streaming response…";
        } else if (event.thinkingDelta) {
            accumulator.activeAssistant.thinking = boundedTranscriptText(accumulator.activeAssistant.thinking + event.thinkingDelta);
            this.state.phase = "Thinking…";
        } else if (event.toolCallStarted) {
            this.state.phase = "Preparing tool call…";
        }
        if (event.truncated) this.reportRunTruncation(accumulator);
        // A stream can grow an existing item after appendItem performed its trim.
        this.trimTranscript();
        this.touch(true);
    }

    private handleMessageEnd(event: Extract<SubagentBackendEvent, { type: "message_completed" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        if (!accumulator) return;
        const { message } = event;
        const item = accumulator.activeAssistant ?? { kind: "assistant" as const, text: "", thinking: "", streaming: false };
        if (!accumulator.activeAssistant || !this.state.items.includes(item)) this.appendItem(item);
        item.text = boundedTranscriptText(message.text);
        item.thinking = boundedTranscriptText(message.thinking);
        item.streaming = false;
        item.stopReason = message.stopReason;
        item.errorMessage = message.errorMessage ? boundedError(message.errorMessage).message : undefined;
        accumulator.activeAssistant = undefined;

        this.addUsage(message.usage, true);
        accumulator.assistantText = message.text;
        accumulator.assistantStopReason = item.stopReason;
        accumulator.hadAssistant = true;
        this.trimTranscript();
        if (message.truncated) this.reportRunTruncation(accumulator);
        if (item.stopReason === "stop" && message.text.trim()) this.state.lastCompletedAssistantText = message.text;
        if (item.stopReason === "error") {
            accumulator.failure = boundedError(item.errorMessage || "Subagent response failed");
            this.state.phase = "Response failed";
        } else if (item.stopReason === "aborted") {
            accumulator.failure = new Error("Subagent response aborted");
            this.state.phase = "Response aborted";
        } else this.state.phase = "Finalizing turn…";
        this.touch();
        if (this.backend.runtime === "pi" && accumulator.compactionStarted) {
            this.resolveResponseWaiters(event.run);
        }
    }

    private handleToolStart(event: Extract<SubagentBackendEvent, { type: "tool_started" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        if (!accumulator) return;
        const item: ToolItem = {
            kind: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args,
            output: "",
            status: "running",
        };
        accumulator.toolsById.set(event.toolCallId, item);
        this.appendItem(item);
        if (event.truncated) this.reportRunTruncation(accumulator);
        this.state.phase = `Running ${event.name}…`;
        this.touch();
    }

    private handleToolUpdate(event: Extract<SubagentBackendEvent, { type: "tool_updated" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        const item = accumulator?.toolsById.get(event.toolCallId);
        if (!accumulator || !item) return;
        if (event.output) item.output = event.output.slice(-MAX_TOOL_OUTPUT_CHARS);
        if (event.truncated) this.reportRunTruncation(accumulator);
        this.trimTranscript();
        this.touch(true);
    }

    private handleToolEnd(event: Extract<SubagentBackendEvent, { type: "tool_completed" }>): void {
        if (!this.isParentOwned(event.run)) return;
        const accumulator = this.getActiveRunAccumulator(event.run);
        const item = accumulator?.toolsById.get(event.toolCallId);
        if (!accumulator || !item) return;
        if (event.output) item.output = event.output.slice(-MAX_TOOL_OUTPUT_CHARS);
        item.status = event.isError ? "error" : "done";
        accumulator.toolsById.delete(event.toolCallId);
        if (event.truncated) this.reportRunTruncation(accumulator);
        this.trimTranscript();
        this.state.phase = event.isError ? `${item.name} failed` : "Streaming response…";
        this.touch();
    }

    private handleCompactionEnd(event: Extract<SubagentBackendEvent, { type: "compaction_completed" }>): void {
        const accumulator = this.getActiveRunAccumulator(event.run);
        if (!accumulator) return;
        this.addUsage(event.usage, false);
        if (event.truncated) this.reportRunTruncation(accumulator);
        if (event.errorMessage) this.addStatus(`Compaction failed: ${event.errorMessage}`, "error");
        else if (event.aborted) this.addStatus("Compaction aborted", "warning");
        else this.addStatus(`Compaction complete${event.tokensBefore || event.estimatedTokensAfter ? ` (${formatSubagentTokens(event.tokensBefore)} → ~${formatSubagentTokens(event.estimatedTokensAfter)})` : ""}`, "success");
        this.state.phase = event.willRetry ? "Compacted; retrying turn…" : "Ready";
        this.touch();
    }

    private addUsage(usage: SubagentUsage | undefined, countTurn: boolean): void {
        // Cursor can complete without a usage event. Pi retains its historic behavior:
        // a turn exists only when Pi supplied complete usage for that assistant message.
        if (!usage) {
            if (countTurn && this.backend.runtime === "cursor-cloud") this.state.usage.turns++;
            return;
        }
        if (countTurn) this.state.usage.turns++;
        if (usage.input !== undefined) { this.state.usage.input += usage.input; this.usageRevisions.input++; }
        if (usage.output !== undefined) { this.state.usage.output += usage.output; this.usageRevisions.output++; }
        if (usage.cacheRead !== undefined) { this.state.usage.cacheRead += usage.cacheRead; this.usageRevisions.cacheRead++; }
        if (usage.cacheWrite !== undefined) { this.state.usage.cacheWrite += usage.cacheWrite; this.usageRevisions.cacheWrite++; }
        if (usage.totalTokens !== undefined) { this.state.usage.totalTokens += usage.totalTokens; this.usageRevisions.totalTokens++; }
        if (usage.reasoningTokens !== undefined) {
            this.state.usage.reasoningTokens = (this.state.usage.reasoningTokens ?? 0) + usage.reasoningTokens;
            this.usageRevisions.reasoningTokens++;
        }
        if (usage.cost?.input !== undefined) { this.state.usage.cost.input += usage.cost.input; this.usageRevisions.costInput++; }
        if (usage.cost?.output !== undefined) { this.state.usage.cost.output += usage.cost.output; this.usageRevisions.costOutput++; }
        if (usage.cost?.cacheRead !== undefined) { this.state.usage.cost.cacheRead += usage.cost.cacheRead; this.usageRevisions.costCacheRead++; }
        if (usage.cost?.cacheWrite !== undefined) { this.state.usage.cost.cacheWrite += usage.cost.cacheWrite; this.usageRevisions.costCacheWrite++; }
        if (usage.cost?.total !== undefined) { this.state.usage.cost.total += usage.cost.total; this.usageRevisions.costTotal++; }
    }

    private async refreshStats(): Promise<void> {
        try {
            if (this.backend.capabilities.usage) this.state.stats = await this.backend.getSessionStats();
            const backendState = await this.backend.getState();
            this.applyBackendState(backendState);
            this.state.phase = "Ready for another prompt";
            this.touch();
        } catch (error) {
            if (!this.stopping) this.addStatus(error instanceof Error ? error.message : String(error), "error");
        }
    }

    private async handleExtensionUi(request: SubagentExtensionUiRequest): Promise<void> {
        if (!this.backend.capabilities.extensionUi) return;
        try {
            if (request.truncated) this.addStatus("Subagent extension UI request was truncated for panel state.", "warning");
            const panel = this.latestPanelAttachment();
            const ui = panel?.ctx.ui ?? this.ctx.ui;
            switch (request.method) {
                case "select": {
                    const value = await ui.select(request.title, [...request.options], request.timeout ? { timeout: request.timeout } : undefined);
                    this.respondValue(request.id, value);
                    return;
                }
                case "confirm": {
                    const confirmed = await ui.confirm(request.title, request.message, request.timeout ? { timeout: request.timeout } : undefined);
                    this.backend.respondToExtensionUI({ id: request.id, confirmed });
                    return;
                }
                case "input": {
                    const value = await ui.input(request.title, request.placeholder, request.timeout ? { timeout: request.timeout } : undefined);
                    this.respondValue(request.id, value);
                    return;
                }
                case "editor": {
                    const value = await ui.editor(request.title, request.prefill);
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
                    if (request.widgetLines) this.state.extensionWidgets.set(request.widgetKey, [...request.widgetLines]);
                    else this.state.extensionWidgets.delete(request.widgetKey);
                    this.touch();
                    return;
                case "set_editor_text":
                    if (panel) panel.setInput(request.text);
                    else this.ctx.ui.setEditorText(request.text);
                    return;
                case "setTitle":
                    return;
            }
        } catch (error) {
            if (!this.stopping) this.addStatus(`Subagent extension UI failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    }

    private respondValue(id: string, value: string | undefined): void {
        if (!this.backend.capabilities.extensionUi) return;
        const response: SubagentExtensionUiResponse = value === undefined
            ? { id, cancelled: true }
            : { id, value };
        this.backend.respondToExtensionUI(response);
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
        const protectedItems = new Set<TranscriptItem>(
            [...this.runAccumulators.values()].flatMap((accumulator) => accumulator.activeAssistant ? [accumulator.activeAssistant] : []),
        );
        while (
            this.state.items.length > 1
            && (this.state.items.length > MAX_SUBAGENT_TRANSCRIPT_ITEMS || totalChars > MAX_SUBAGENT_TRANSCRIPT_TOTAL_CHARS)
        ) {
            const index = this.state.items.findIndex((item) => !protectedItems.has(item));
            if (index < 0) break;
            const [removed] = this.state.items.splice(index, 1);
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

    private addStatus(text: string, level: SubagentStatusLevel): void {
        this.appendItem({ kind: "status", text: boundedTranscriptText(text), level });
        this.touch();
    }

    private updatePanelControls(): void {
        const idle = this.state.connected && !this.state.busy && !this.state.readOnly;
        this.state.controls.model = idle && this.backend.capabilities.modelControls && this.backendControlAvailability.model;
        this.state.controls.thinking = idle && this.backend.capabilities.thinkingControls && this.backendControlAvailability.thinking;
    }

    private shouldRecoverControlAvailability(): boolean {
        return !this.stopping
            && this.backend.runtime === "cursor-cloud"
            && this.backend.capabilities.modelControls
            && this.state.connected
            && !this.state.busy
            && !this.state.readOnly
            && !this.state.controls.model
            && this.panelAttachments.size > 0;
    }

    private reconcileControlAvailabilityRecovery(): void {
        if (!this.shouldRecoverControlAvailability()) {
            this.cancelControlAvailabilityRecovery();
            return;
        }
        if (this.controlAvailabilityRetryTimer) return;
        const epoch = this.controlAvailabilityRecoveryEpoch;
        let timer: ReturnType<typeof setTimeout>;
        timer = setTimeout(() => {
            if (this.controlAvailabilityRetryTimer !== timer) return;
            this.controlAvailabilityRetryTimer = undefined;
            if (epoch !== this.controlAvailabilityRecoveryEpoch || !this.shouldRecoverControlAvailability()) return;
            void this.refreshControlAvailability(epoch);
        }, CURSOR_CONTROL_AVAILABILITY_RETRY_MS);
        this.controlAvailabilityRetryTimer = timer;
    }

    private async refreshControlAvailability(epoch: number): Promise<void> {
        try {
            const state = await this.backend.getState();
            if (epoch !== this.controlAvailabilityRecoveryEpoch || !this.shouldRecoverControlAvailability()) return;
            this.applyBackendState(state);
            this.touch();
        } catch {
            if (epoch === this.controlAvailabilityRecoveryEpoch) this.reconcileControlAvailabilityRecovery();
        }
    }

    private cancelControlAvailabilityRecovery(): void {
        this.controlAvailabilityRecoveryEpoch++;
        if (!this.controlAvailabilityRetryTimer) return;
        clearTimeout(this.controlAvailabilityRetryTimer);
        this.controlAvailabilityRetryTimer = undefined;
    }

    private clearRefreshTimers(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.cancelControlAvailabilityRecovery();
    }

    private touch(throttled = false): void {
        this.updatePanelControls();
        this.reconcileControlAvailabilityRecovery();
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
