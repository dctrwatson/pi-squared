import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    buildSubagentProcessArgs,
    normalizePersonaContextRequirements,
    SUBAGENT_LIFETIMES,
    SUBAGENT_PROFILES,
    type SubagentContextMode,
    type SubagentPersona,
    type SubagentScopedModel,
    type SubagentThinkingLevel,
    type SubagentLifetime,
    type SubagentProfile,
} from "./personas.ts";
import { createActiveTurnForkSnapshot, type ModelForkContext } from "./fork.ts";
import {
    parseStoredSubagentBlocker,
    parseSubagentBlockerResponse,
    type ActiveSubagentBlocker,
} from "./blockers.ts";
import {
    SubagentSessionController,
    promptFingerprint,
    type SubagentPromptAttribution,
    type SubagentPromptCompletion,
} from "./controller.ts";
import { createSubagentBackend } from "./backend-factory.ts";
import { createCursorSubagentLifecyclePort, type CursorCloudBackendConfiguration } from "./cursor-backend.ts";
import { buildCursorCloudBootstrap, createCursorForkHandoffWithPiSummary } from "./cursor-context.ts";
import {
    buildCursorRepositoryList,
    isCursorCommitSha,
    normalizeCursorGitHubUrl,
    normalizeCursorStartingRef,
} from "./cursor-repositories.ts";
import { runSubagentDialog } from "./ui.ts";
import type { SubagentBackendFactory, SubagentRuntime } from "./backend.ts";
import type { CursorExecutionProfile } from "./cursor-models.ts";

const REGISTRY_ENTRY_TYPE = "persistent-subagents";
export const SUBAGENT_REGISTRY_TOOL_DETAILS_KEY = "persistentSubagentRegistry";
export const SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY = "cursorDeliveryReceipt";
export const CURSOR_DELIVERY_RECEIPT_VERSION = 1;
const LEGACY_REGISTRY_VERSION = 1;
const PI_REGISTRY_VERSION = 2;
export const SUBAGENT_REGISTRY_VERSION = 3;
const PROMPT_ATTRIBUTION_VERSION = 1;
export const MAX_CONCURRENT_SUBAGENTS = 4;
export const MAX_RETAINED_SUBAGENTS = 20;
/** @deprecated Use MAX_CONCURRENT_SUBAGENTS. */
export const MAX_PERSISTENT_SUBAGENTS = MAX_CONCURRENT_SUBAGENTS;
export const MAX_RETAINED_STOPPED_SUBAGENTS = 20;
const MAX_PURPOSE_CHARS = 240;
const MAX_CURSOR_ID_CHARS = 256;
const MAX_CURSOR_REPOSITORIES = 20;
const MAX_CURSOR_MODEL_PARAMETERS = 16;
const MAX_CURSOR_PENDING_OPERATIONS = 8;
const SUBAGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SAFE_CURSOR_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const THINKING_LEVELS = new Set<SubagentThinkingLevel>([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const LIFETIMES = new Set<SubagentLifetime>(SUBAGENT_LIFETIMES);
const PROFILES = new Set<SubagentProfile>(SUBAGENT_PROFILES);

export type PersistentSubagentStatus =
    | "dormant"
    | "starting"
    | "idle"
    | "running"
    | "blocked"
    | "error"
    | "stopping"
    | "archive-pending"
    | "remote-state-unknown"
    | "stopped";
export type StoredSubagentLocalLifecycle = "available" | "unavailable" | "stopped";
export type CursorRemoteLifecycle =
    | "local"
    | "idle"
    | "running"
    | "stopping"
    | "archive-started"
    | "archive-pending"
    | "remote-state-unknown"
    | "archived";
export type CursorPendingOperationKind = "create-agent" | "start-run" | "follow-up" | "cancel-run" | "archive";

export interface PersistentSubagentSummary {
    id: string;
    name: string;
    runtime: SubagentRuntime;
    purpose: string;
    persona?: string;
    lifetime: SubagentLifetime;
    blocker?: ActiveSubagentBlocker;
    status: PersistentSubagentStatus;
    model?: string;
    thinking?: SubagentThinkingLevel;
    sessionFile?: string;
    createdAt: number;
    lastActiveAt: number;
}

export interface CreatePersistentSubagentOptions {
    name?: string;
    runtime?: SubagentRuntime;
    purpose: string;
    persona?: SubagentPersona;
    lifetime?: SubagentLifetime;
    mode: SubagentContextMode;
    parentSessionFile?: string;
    skills?: readonly string[];
    model?: string;
    thinking?: SubagentThinkingLevel;
    /** Cursor profile resolution happens lazily before the first Cloud send. */
    cursorProfile?: CursorExecutionProfile;
}

export interface PromptPersistentSubagentOptions {
    signal?: AbortSignal;
    onStateChange?: (summary: PersistentSubagentSummary) => void;
    parentContextProvided?: boolean;
}

export interface CursorRemoteMetadata {
    readonly agentId?: string;
    readonly runId?: string;
    readonly requestId?: string;
    readonly remoteCreated: boolean;
    readonly lifecycle: CursorRemoteLifecycle;
    readonly pendingResult: CursorPendingResult["state"];
    readonly model?: string;
    readonly repositories: readonly CursorStoredRepository[];
}

/** Structured runtime state for details. It is not included in concise parent text. */
export interface SubagentRuntimeMetadata {
    readonly kind: SubagentRuntime;
    readonly remote?: CursorRemoteMetadata;
}

/** A bounded receipt that authorizes post-persistence Cursor cleanup. */
export interface CursorDeliveryReceipt {
    readonly version: typeof CURSOR_DELIVERY_RECEIPT_VERSION;
    readonly subagentId: string;
    readonly runId: string;
    readonly archiveAfterDelivery?: true;
}

export interface CursorResultDeliveryAcknowledgement {
    readonly runId: string;
    readonly acknowledged: boolean;
    readonly archiveAfterDelivery: boolean;
    readonly summary: PersistentSubagentSummary;
}

/** An ephemeral, run-scoped acknowledgement for one durable Cursor result. */
export interface CursorResultDelivery {
    readonly runId: string;
    /** Archive this one-shot only after acknowledgement succeeds. */
    readonly archiveAfterDelivery: boolean;
    /** The retained result metadata for panel lifetime decisions. */
    readonly completion?: SubagentPromptCompletion;
    acknowledge(): Promise<CursorResultDeliveryAcknowledgement>;
}

export interface PromptPersistentSubagentResult extends SubagentPromptCompletion {
    summary: PersistentSubagentSummary;
    metadata: SubagentRuntimeMetadata;
    delivery?: CursorResultDelivery;
}

export type OpenPersistentSubagentResult =
    | { action: "return"; text: string; summary: PersistentSubagentSummary; delivery?: CursorResultDelivery }
    | { action: "cancel" }
    | undefined;

/** A Cursor request failed after durable state may have reached a terminal result. */
export class SubagentCursorPromptFailure extends Error {
    readonly summary: PersistentSubagentSummary;
    readonly metadata: SubagentRuntimeMetadata;
    readonly delivery?: CursorResultDelivery;

    constructor(
        error: unknown,
        summary: PersistentSubagentSummary,
        metadata: SubagentRuntimeMetadata,
        delivery?: CursorResultDelivery,
    ) {
        super(error instanceof Error ? error.message : String(error));
        this.name = "SubagentCursorPromptFailure";
        this.summary = summary;
        this.metadata = metadata;
        this.delivery = delivery;
    }
}

export interface StoredSubagentBase {
    id: string;
    name: string;
    runtime: SubagentRuntime;
    purpose: string;
    persona?: SubagentPersona;
    lifetime: SubagentLifetime;
    mode: SubagentContextMode;
    cwd: string;
    createdAt: number;
    lastActiveAt: number;
    localLifecycle: StoredSubagentLocalLifecycle;
    parentContextProvided?: boolean;
    activeBlocker?: ActiveSubagentBlocker;
}

export interface StoredPiSubagent extends StoredSubagentBase {
    runtime: "pi";
    selectedSkillPaths: string[];
    parentSessionFile?: string;
    sessionFile?: string;
    sessionDir: string;
    model?: string;
    thinking: SubagentThinkingLevel;
    scopedModels: SubagentScopedModel[];
}

export interface CursorStoredRepository {
    url: string;
    startingRef?: string;
}

export interface CursorStoredModelParameter {
    id: string;
    value: string;
}

export interface CursorPendingOperation {
    kind: CursorPendingOperationKind;
    idempotencyKey: string;
    /** A unique durable nonce for one logical Cursor send. */
    nonce?: string;
    /** SHA-256 of the delivered text. Raw prompt text is never durable. */
    requestHash?: string;
    createdAt: number;
    /** Whether the pre-send follow-up scan reached the end of server history. */
    baselineComplete?: boolean;
    /** Latest run from a complete server scan immediately before a follow-up send. */
    baselineRunId?: string;
    baselineCreatedAt?: number;
}

export type CursorPendingResult =
    | { state: "none" }
    | {
        state: "pending" | "available";
        runId: string;
        /** A restored one-shot must archive only after this result is retrieved. */
        archiveAfterDelivery?: boolean;
    };

export interface StoredCursorSubagent extends StoredSubagentBase {
    runtime: "cursor-cloud";
    agentId?: string;
    remoteCreated: boolean;
    currentRunId?: string;
    currentRequestId?: string;
    repositories: CursorStoredRepository[];
    requestedProfile?: "fast" | "balanced" | "deep";
    currentModel?: {
        id: string;
        parameters: CursorStoredModelParameter[];
        resolvedAt: number;
    };
    pendingOperations: CursorPendingOperation[];
    remoteLifecycle: CursorRemoteLifecycle;
    pendingResult: CursorPendingResult;
}

export type StoredSubagent = StoredPiSubagent | StoredCursorSubagent;

export interface CursorSubagentReconciliation {
    remoteLifecycle: CursorRemoteLifecycle;
    /** An authoritative empty run list proved the saved send was not accepted. */
    clearPendingSend?: boolean;
    pendingResult?: CursorPendingResult;
    currentRunId?: string;
    currentRequestId?: string;
}

export type CursorSubagentStopOutcome =
    | { state: "stopped" }
    | { state: "archive-pending" }
    | { state: "remote-state-unknown" };

export interface CursorSubagentStopProgress {
    /** Persist cancellation confirmation and the archive operation before archive starts. */
    persistArchiveStarted(): void;
}

/** This port has no SDK dependency. The Cursor backend supplies it in a later work package. */
export interface CursorSubagentLifecyclePort {
    reconcile?(stored: Readonly<StoredCursorSubagent>): Promise<CursorSubagentReconciliation | undefined>;
    /** Call progress after cancellation is confirmed and before archive starts. */
    stop?(
        stored: Readonly<StoredCursorSubagent>,
        progress: CursorSubagentStopProgress,
    ): Promise<CursorSubagentStopOutcome>;
    disposeObservers?(stored: Readonly<StoredCursorSubagent>): Promise<void>;
}

interface LegacyRegistrySnapshot {
    version: typeof LEGACY_REGISTRY_VERSION;
    ownerSessionId: string;
    subagents: StoredSubagent[];
}

interface RegistryMutation {
    version: typeof SUBAGENT_REGISTRY_VERSION;
    ownerSessionId: string;
    upserts: StoredSubagent[];
    removedIds: string[];
}

interface ParsedRegistryMutation {
    version: typeof PI_REGISTRY_VERSION | typeof SUBAGENT_REGISTRY_VERSION;
    ownerSessionId: string;
    upserts: StoredSubagent[];
    removedIds: string[];
}

interface RuntimePersistentSubagent {
    stored: StoredSubagent;
    controller?: SubagentSessionController;
    unsubscribe?: () => void;
    promptAttributions?: SubagentPromptAttribution[];
    contextPromptFingerprints?: Set<string>;
    observedSettlementRevision?: number;
    /** Invalidates stale local Cursor observers before stop or replacement. */
    cursorLease?: number;
    /** A restored one-shot promotes only after reconciliation finds its result. */
    cursorOneShotRecovery?: boolean;
    runSlotHeld?: boolean;
    operationTail?: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCursorValue(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_CURSOR_ID_CHARS && SAFE_CURSOR_VALUE_PATTERN.test(value);
}

export function normalizeSubagentPurpose(value: string): string {
    const purpose = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!purpose) throw new Error("Subagent purpose is required");
    if (purpose.length <= MAX_PURPOSE_CHARS) return purpose;
    return `${purpose.slice(0, MAX_PURPOSE_CHARS - 1).trimEnd()}…`;
}

function clonePersona(persona: SubagentPersona | undefined): SubagentPersona | undefined {
    if (!persona) return undefined;
    return {
        name: persona.name,
        description: persona.description,
        systemPrompt: persona.systemPrompt,
        runtime: persona.runtime ?? "pi",
        ...(typeof persona.contextRequirements === "string" && persona.contextRequirements.trim()
            ? { contextRequirements: normalizePersonaContextRequirements(persona.contextRequirements) }
            : {}),
        ...(persona.preferredProfile && PROFILES.has(persona.preferredProfile)
            ? { preferredProfile: persona.preferredProfile }
            : {}),
        extensions: Array.isArray(persona.extensions)
            ? persona.extensions.filter((extension): extension is string => typeof extension === "string")
            : [],
        skills: Array.isArray(persona.skills)
            ? persona.skills.filter((skill): skill is string => typeof skill === "string")
            : [],
        ...(persona.cursorMcps?.length ? { cursorMcps: [...persona.cursorMcps] } : {}),
        ...(persona.cursorRepos?.length ? {
            cursorRepos: persona.cursorRepos.map((repository) => ({ ...repository })),
        } : {}),
        filePath: persona.filePath,
    };
}

function cloneCursorPendingResult(pendingResult: CursorPendingResult): CursorPendingResult {
    return pendingResult.state === "none" ? { state: "none" } : { ...pendingResult };
}

function cloneStoredSubagent(stored: StoredSubagent): StoredSubagent {
    const base = {
        ...stored,
        ...(stored.persona ? { persona: clonePersona(stored.persona) } : {}),
        ...(stored.activeBlocker ? { activeBlocker: { ...stored.activeBlocker } } : {}),
    };
    if (stored.runtime === "pi") {
        return {
            ...base,
            runtime: "pi",
            selectedSkillPaths: [...stored.selectedSkillPaths],
            scopedModels: stored.scopedModels.map((model) => ({ ...model })),
        } as StoredPiSubagent;
    }
    return {
        ...base,
        runtime: "cursor-cloud",
        repositories: stored.repositories.map((repository) => ({ ...repository })),
        ...(stored.currentModel ? {
            currentModel: {
                ...stored.currentModel,
                parameters: stored.currentModel.parameters.map((parameter) => ({ ...parameter })),
            },
        } : {}),
        pendingOperations: stored.pendingOperations.map((operation) => ({ ...operation })),
        pendingResult: cloneCursorPendingResult(stored.pendingResult),
    } as StoredCursorSubagent;
}

function storedFingerprint(stored: StoredSubagent): string {
    return JSON.stringify(cloneStoredSubagent(stored));
}

/** Validate saved persona repository hints before lazy Cloud provisioning uses them. */
function parseStoredCursorRepositoryHints(value: unknown): CursorStoredRepository[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_CURSOR_REPOSITORIES) return undefined;
    const repositories: CursorStoredRepository[] = [];
    for (const [index, repository] of value.entries()) {
        if (!isRecord(repository) || !isSafeCursorValue(repository.url)
            || (repository.startingRef !== undefined && !isSafeCursorValue(repository.startingRef))) return undefined;
        try {
            const url = normalizeCursorGitHubUrl(repository.url, `saved persona repository ${index + 1} URL`);
            const startingRef = repository.startingRef === undefined
                ? undefined
                : normalizeCursorStartingRef(repository.startingRef, `saved persona repository ${index + 1} startingRef`);
            repositories.push({ url, ...(startingRef ? { startingRef } : {}) });
        } catch {
            return undefined;
        }
    }
    return repositories;
}

function parseStoredPersona(value: unknown, runtime: SubagentRuntime): SubagentPersona | undefined {
    if (!isRecord(value)
        || typeof value.name !== "string"
        || typeof value.description !== "string"
        || typeof value.systemPrompt !== "string"
        || typeof value.filePath !== "string"
        || (value.contextRequirements !== undefined
            && (typeof value.contextRequirements !== "string" || !value.contextRequirements.trim()))
        || (value.runtime !== undefined && value.runtime !== runtime)) return undefined;
    const cursorRepos = value.cursorRepos === undefined ? undefined : parseStoredCursorRepositoryHints(value.cursorRepos);
    if (value.cursorRepos !== undefined && !cursorRepos) return undefined;
    return clonePersona({
        name: value.name,
        description: value.description,
        systemPrompt: value.systemPrompt,
        runtime,
        extensions: Array.isArray(value.extensions)
            ? value.extensions.filter((entry): entry is string => typeof entry === "string")
            : [],
        skills: Array.isArray(value.skills)
            ? value.skills.filter((entry): entry is string => typeof entry === "string")
            : [],
        ...(typeof value.contextRequirements === "string" ? { contextRequirements: value.contextRequirements } : {}),
        ...(typeof value.preferredProfile === "string" && PROFILES.has(value.preferredProfile as SubagentProfile)
            ? { preferredProfile: value.preferredProfile as SubagentProfile }
            : {}),
        ...(Array.isArray(value.cursorMcps) ? {
            cursorMcps: value.cursorMcps.filter((entry): entry is string => isSafeCursorValue(entry)),
        } : {}),
        ...(cursorRepos?.length ? { cursorRepos } : {}),
        filePath: value.filePath,
    });
}

function parseStoredBase(value: Record<string, unknown>, runtime: SubagentRuntime): StoredSubagentBase | undefined {
    if (typeof value.id !== "string" || typeof value.name !== "string") return undefined;
    if (value.mode !== "fresh" && value.mode !== "fork") return undefined;
    if (typeof value.cwd !== "string") return undefined;
    if (typeof value.createdAt !== "number" || typeof value.lastActiveAt !== "number") return undefined;
    const persona = parseStoredPersona(value.persona, runtime);
    if (value.persona !== undefined && !persona) return undefined;
    const purpose = normalizeSubagentPurpose(
        typeof value.purpose === "string" && value.purpose.trim()
            ? value.purpose
            : persona?.description ?? `Existing subagent ${value.name}; purpose was not recorded`,
    );
    const localLifecycle: StoredSubagentLocalLifecycle = value.localLifecycle === "available"
        || value.localLifecycle === "unavailable" || value.localLifecycle === "stopped"
        ? value.localLifecycle
        : value.stopped === true ? "stopped" : "available";
    const activeBlocker = parseStoredSubagentBlocker(value.activeBlocker);
    return {
        id: value.id,
        name: value.name,
        runtime,
        purpose,
        ...(persona ? { persona } : {}),
        lifetime: typeof value.lifetime === "string" && LIFETIMES.has(value.lifetime as SubagentLifetime)
            ? value.lifetime as SubagentLifetime
            : "persistent",
        mode: value.mode,
        cwd: value.cwd,
        createdAt: value.createdAt,
        lastActiveAt: value.lastActiveAt,
        localLifecycle,
        ...(value.parentContextProvided === true ? { parentContextProvided: true } : {}),
        ...(activeBlocker ? { activeBlocker } : {}),
    };
}

function parseStoredPiSubagent(value: Record<string, unknown>): StoredPiSubagent | undefined {
    const base = parseStoredBase(value, "pi");
    if (!base || typeof value.sessionDir !== "string") return undefined;
    if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking as SubagentThinkingLevel)) return undefined;
    if (!Array.isArray(value.scopedModels)) return undefined;
    return {
        ...base,
        runtime: "pi",
        selectedSkillPaths: Array.isArray(value.selectedSkillPaths)
            ? [...new Set(value.selectedSkillPaths.filter((skill): skill is string => typeof skill === "string"))]
            : [],
        ...(typeof value.parentSessionFile === "string" ? { parentSessionFile: value.parentSessionFile } : {}),
        ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
        sessionDir: value.sessionDir,
        ...(typeof value.model === "string" ? { model: value.model } : {}),
        thinking: value.thinking as SubagentThinkingLevel,
        scopedModels: value.scopedModels.filter(isRecord).flatMap((model) =>
            typeof model.provider === "string" && typeof model.id === "string"
                ? [{
                    provider: model.provider,
                    id: model.id,
                    ...(typeof model.thinkingLevel === "string" && THINKING_LEVELS.has(model.thinkingLevel as SubagentThinkingLevel)
                        ? { thinkingLevel: model.thinkingLevel as SubagentThinkingLevel }
                        : {}),
                }]
                : []),
    };
}

function isCursorCloudAgentId(value: unknown): value is string {
    return isSafeCursorValue(value) && value.startsWith("bc-") && value.length > "bc-".length;
}

function isCursorCloudRunId(value: unknown): value is string {
    return isSafeCursorValue(value) && value.startsWith("run-") && value.length > "run-".length;
}

export function parseCursorDeliveryReceipt(value: unknown): CursorDeliveryReceipt | undefined {
    if (!isRecord(value) || value.version !== CURSOR_DELIVERY_RECEIPT_VERSION
        || !isSafeCursorValue(value.subagentId) || value.subagentId.length > MAX_CURSOR_ID_CHARS
        || !isCursorCloudRunId(value.runId)
        || (value.archiveAfterDelivery !== undefined && value.archiveAfterDelivery !== true)) return undefined;
    return {
        version: CURSOR_DELIVERY_RECEIPT_VERSION,
        subagentId: value.subagentId,
        runId: value.runId,
        ...(value.archiveAfterDelivery === true ? { archiveAfterDelivery: true } : {}),
    };
}

function parseCursorPendingResult(value: unknown): CursorPendingResult | undefined {
    if (!isRecord(value) || typeof value.state !== "string") return undefined;
    if (value.state === "none") return { state: "none" };
    if ((value.state === "pending" || value.state === "available") && isCursorCloudRunId(value.runId)
        && (value.archiveAfterDelivery === undefined || typeof value.archiveAfterDelivery === "boolean")) {
        return {
            state: value.state,
            runId: value.runId,
            ...(value.archiveAfterDelivery === true ? { archiveAfterDelivery: true } : {}),
        };
    }
    return undefined;
}

/** Reject malformed saved repository state before it can route an SDK operation. */
function parseStoredCursorRepositories(value: unknown): CursorStoredRepository[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_CURSOR_REPOSITORIES) return undefined;
    const repositories: CursorStoredRepository[] = [];
    for (const [index, repository] of value.entries()) {
        if (!isRecord(repository) || !isSafeCursorValue(repository.url)) return undefined;
        if (repository.startingRef !== undefined && !isSafeCursorValue(repository.startingRef)) return undefined;
        try {
            const url = normalizeCursorGitHubUrl(repository.url, `saved repository ${index + 1} URL`);
            const startingRef = repository.startingRef === undefined
                ? undefined
                : normalizeCursorStartingRef(repository.startingRef, `saved repository ${index + 1} startingRef`);
            if (index === 0 && (!startingRef || !isCursorCommitSha(startingRef))) return undefined;
            const primary = repositories[0];
            if (primary && url.toLowerCase() === primary.url.toLowerCase()
                && startingRef !== undefined && startingRef !== primary.startingRef) return undefined;
            repositories.push({ url, ...(startingRef ? { startingRef } : {}) });
        } catch {
            return undefined;
        }
    }
    if (repositories.length === 0) return repositories;
    try {
        // Use the same duplicate and starting-ref rules as fresh Cloud creation.
        return buildCursorRepositoryList(repositories[0]!, repositories.slice(1));
    } catch {
        return undefined;
    }
}

function parseStoredCursorSubagent(value: Record<string, unknown>): StoredCursorSubagent | undefined {
    const base = parseStoredBase(value, "cursor-cloud");
    if (!base || typeof value.remoteCreated !== "boolean" || !Array.isArray(value.repositories)
        || !Array.isArray(value.pendingOperations)) return undefined;
    if (value.remoteLifecycle !== "local" && value.remoteLifecycle !== "idle" && value.remoteLifecycle !== "running"
        && value.remoteLifecycle !== "stopping" && value.remoteLifecycle !== "archive-started"
        && value.remoteLifecycle !== "archive-pending" && value.remoteLifecycle !== "remote-state-unknown"
        && value.remoteLifecycle !== "archived") return undefined;
    const pendingResult = parseCursorPendingResult(value.pendingResult);
    if (!pendingResult) return undefined;
    const agentId = value.agentId === undefined ? undefined : isCursorCloudAgentId(value.agentId) ? value.agentId : undefined;
    const currentRunId = value.currentRunId === undefined ? undefined : isCursorCloudRunId(value.currentRunId) ? value.currentRunId : undefined;
    const currentRequestId = value.currentRequestId === undefined ? undefined : isSafeCursorValue(value.currentRequestId) ? value.currentRequestId : undefined;
    if ((value.agentId !== undefined && !agentId) || (value.currentRunId !== undefined && !currentRunId)
        || (value.currentRequestId !== undefined && !currentRequestId)) return undefined;
    const localLifecycle: StoredSubagentLocalLifecycle = value.remoteLifecycle === "archived"
        ? "stopped"
        : value.remoteLifecycle === "local" && !value.remoteCreated
            ? base.localLifecycle
            : value.remoteLifecycle === "stopping" || value.remoteLifecycle === "archive-started"
                || value.remoteLifecycle === "archive-pending" || value.remoteLifecycle === "remote-state-unknown"
                ? "unavailable"
                : base.localLifecycle === "stopped" ? "unavailable" : base.localLifecycle;
    const repositories = parseStoredCursorRepositories(value.repositories);
    if (!repositories) return undefined;
    const pendingOperations = value.pendingOperations.filter(isRecord).flatMap((operation) => {
        const supportedKind = operation.kind === "create-agent" || operation.kind === "start-run" || operation.kind === "follow-up"
            || operation.kind === "cancel-run" || operation.kind === "archive";
        const nonce = isSafeCursorValue(operation.nonce) ? operation.nonce : undefined;
        const requestHash = typeof operation.requestHash === "string" && /^[a-f0-9]{64}$/.test(operation.requestHash)
            ? operation.requestHash
            : undefined;
        const baselineComplete = typeof operation.baselineComplete === "boolean" ? operation.baselineComplete : undefined;
        const baselineRunId = isCursorCloudRunId(operation.baselineRunId) ? operation.baselineRunId : undefined;
        const baselineCreatedAt = typeof operation.baselineCreatedAt === "number" && Number.isFinite(operation.baselineCreatedAt)
            ? operation.baselineCreatedAt
            : undefined;
        const baselineValid = operation.baselineRunId === undefined && operation.baselineCreatedAt === undefined
            || baselineRunId !== undefined && baselineCreatedAt !== undefined;
        const sendKind = operation.kind === "start-run" || operation.kind === "follow-up";
        if (!supportedKind || !isSafeCursorValue(operation.idempotencyKey)
            || typeof operation.createdAt !== "number" || !Number.isFinite(operation.createdAt) || !baselineValid
            || (operation.nonce !== undefined && !nonce)
            || (operation.requestHash !== undefined && !requestHash)
            || (operation.baselineComplete !== undefined && baselineComplete === undefined)) return [];
        // Only a follow-up can have a server pre-send correlation baseline. A send
        // nonce persists before prompt construction. Its final-text hash is added
        // before Agent.send, so restore treats a nonce-only operation as uncertain.
        if (operation.kind !== "follow-up" && (baselineRunId !== undefined || baselineCreatedAt !== undefined || baselineComplete !== undefined)) return [];
        if (!sendKind && (nonce !== undefined || requestHash !== undefined)) return [];
        if (requestHash !== undefined && nonce === undefined) return [];
        if (baselineComplete === true && (baselineRunId === undefined || baselineCreatedAt === undefined)) return [];
        return [{
            kind: operation.kind as CursorPendingOperationKind,
            idempotencyKey: operation.idempotencyKey,
            createdAt: operation.createdAt,
            ...(nonce !== undefined ? { nonce } : {}),
            ...(requestHash !== undefined ? { requestHash } : {}),
            ...(baselineComplete !== undefined ? { baselineComplete } : {}),
            ...(baselineRunId !== undefined && baselineCreatedAt !== undefined ? {
                baselineRunId,
                baselineCreatedAt,
            } : {}),
        }];
    });
    if (pendingOperations.length !== value.pendingOperations.length || pendingOperations.length > MAX_CURSOR_PENDING_OPERATIONS) return undefined;
    const currentModel = isRecord(value.currentModel) && isSafeCursorValue(value.currentModel.id)
        && typeof value.currentModel.resolvedAt === "number" && Array.isArray(value.currentModel.parameters)
        ? {
            id: value.currentModel.id,
            resolvedAt: value.currentModel.resolvedAt,
            parameters: value.currentModel.parameters.filter(isRecord).flatMap((parameter) =>
                isSafeCursorValue(parameter.id) && isSafeCursorValue(parameter.value)
                    ? [{ id: parameter.id, value: parameter.value }]
                    : []),
        }
        : undefined;
    if (isRecord(value.currentModel)
        && (!currentModel || currentModel.parameters.length !== (value.currentModel.parameters as unknown[]).length
            || currentModel.parameters.length > MAX_CURSOR_MODEL_PARAMETERS)) return undefined;
    if (value.requestedProfile !== undefined && value.requestedProfile !== "fast"
        && value.requestedProfile !== "balanced" && value.requestedProfile !== "deep") return undefined;

    const remoteLifecycle = value.remoteLifecycle;
    const isUncertainFirstSend = !value.remoteCreated && remoteLifecycle === "remote-state-unknown"
        && Boolean(agentId) && !currentRunId && !currentRequestId && pendingResult.state === "none"
        && pendingOperations.length === 1 && pendingOperations[0]?.kind === "start-run";
    const requiresConfirmedRemoteAgent = value.remoteCreated
        || (remoteLifecycle !== "local" && remoteLifecycle !== "remote-state-unknown");
    if (requiresConfirmedRemoteAgent && (!value.remoteCreated || !agentId)) return undefined;
    if (remoteLifecycle === "remote-state-unknown" && !value.remoteCreated && !isUncertainFirstSend) return undefined;
    if (remoteLifecycle === "local" && (value.remoteCreated || currentRunId || currentRequestId || pendingResult.state !== "none")) return undefined;
    if (remoteLifecycle === "local" && pendingOperations.some((operation) => operation.kind === "start-run") && !agentId) return undefined;
    // The public SDK documents requestId as optional. A run ID remains the durable authority.
    if (remoteLifecycle === "running" && !currentRunId) return undefined;
    if (pendingResult.state !== "none" && (!currentRunId || pendingResult.runId !== currentRunId)) return undefined;
    if (remoteLifecycle === "stopping" && !pendingOperations.some((operation) => operation.kind === "cancel-run")) return undefined;
    if ((remoteLifecycle === "archive-started" || remoteLifecycle === "archive-pending")
        && !pendingOperations.some((operation) => operation.kind === "archive")) return undefined;
    if (!value.remoteCreated && pendingOperations.some((operation) =>
        operation.kind !== "create-agent" && operation.kind !== "start-run")) return undefined;

    return {
        ...base,
        runtime: "cursor-cloud",
        localLifecycle,
        ...(agentId ? { agentId } : {}),
        remoteCreated: value.remoteCreated,
        ...(currentRunId ? { currentRunId } : {}),
        ...(currentRequestId ? { currentRequestId } : {}),
        repositories,
        ...(value.requestedProfile ? { requestedProfile: value.requestedProfile } : {}),
        ...(currentModel ? { currentModel } : {}),
        pendingOperations,
        remoteLifecycle,
        pendingResult,
    };
}

function parseStoredSubagent(value: unknown, allowCursor = true): StoredSubagent | undefined {
    try {
        if (!isRecord(value)) return undefined;
        if (value.runtime === "cursor-cloud") return allowCursor ? parseStoredCursorSubagent(value) : undefined;
        if (value.runtime !== undefined && value.runtime !== "pi") return undefined;
        return parseStoredPiSubagent(value);
    } catch {
        return undefined;
    }
}

function parseLegacySnapshot(value: unknown): LegacyRegistrySnapshot | undefined {
    if (!isRecord(value)
        || value.version !== LEGACY_REGISTRY_VERSION
        || typeof value.ownerSessionId !== "string"
        || !Array.isArray(value.subagents)) return undefined;
    return {
        version: LEGACY_REGISTRY_VERSION,
        ownerSessionId: value.ownerSessionId,
        subagents: value.subagents.flatMap((subagent) => {
            const parsed = parseStoredSubagent(subagent, false);
            return parsed ? [parsed] : [];
        }),
    };
}

function parseRegistryMutation(value: unknown): ParsedRegistryMutation | undefined {
    if (!isRecord(value)
        || (value.version !== PI_REGISTRY_VERSION && value.version !== SUBAGENT_REGISTRY_VERSION)
        || typeof value.ownerSessionId !== "string"
        || !Array.isArray(value.upserts)
        || !Array.isArray(value.removedIds)) return undefined;
    const allowCursor = value.version === SUBAGENT_REGISTRY_VERSION;
    return {
        version: value.version,
        ownerSessionId: value.ownerSessionId,
        upserts: value.upserts.flatMap((subagent) => {
            const parsed = parseStoredSubagent(subagent, allowCursor);
            return parsed ? [parsed] : [];
        }),
        removedIds: value.removedIds.filter((id): id is string => typeof id === "string"),
    };
}

function parsePromptAttributions(value: unknown): SubagentPromptAttribution[] {
    if (!isRecord(value) || value.version !== PROMPT_ATTRIBUTION_VERSION || !Array.isArray(value.entries)) return [];
    return value.entries.flatMap((entry) =>
        isRecord(entry)
            && (entry.source === "human" || entry.source === "parent")
            && typeof entry.fingerprint === "string"
            && /^[a-f0-9]{64}$/.test(entry.fingerprint)
            ? [{ source: entry.source, fingerprint: entry.fingerprint }]
            : []);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class PersistentSubagentRegistry {
    private readonly records = new Map<string, RuntimePersistentSubagent>();
    private readonly pi: ExtensionAPI;
    private readonly backendFactory: SubagentBackendFactory;
    private readonly cursorLifecycle: CursorSubagentLifecyclePort;
    private ownerSessionId: string | undefined;
    private readonly persistedFingerprints = new Map<string, string>();
    private readonly pendingRestoreRemovedIds = new Set<string>();
    private deferredPersistenceDepth = 0;
    private deferredMutation: RegistryMutation | undefined;
    private shuttingDown = false;

    constructor(
        pi: ExtensionAPI,
        backendFactory: SubagentBackendFactory = createSubagentBackend,
        cursorLifecycle: CursorSubagentLifecyclePort = createCursorSubagentLifecyclePort(),
    ) {
        this.pi = pi;
        this.backendFactory = backendFactory;
        this.cursorLifecycle = cursorLifecycle;
    }

    restore(ctx: ExtensionContext): void {
        this.ownerSessionId = ctx.sessionManager.getSessionId();
        this.shuttingDown = false;
        this.deferredPersistenceDepth = 0;
        this.deferredMutation = undefined;
        this.records.clear();
        this.persistedFingerprints.clear();
        this.pendingRestoreRemovedIds.clear();

        const restored = new Map<string, { stored: StoredSubagent; sourceVersion: number }>();
        const deliveryReceipts = new Map<string, CursorDeliveryReceipt>();
        const applyMutation = (mutation: ParsedRegistryMutation | undefined) => {
            if (!mutation || mutation.ownerSessionId !== this.ownerSessionId) return;
            for (const id of mutation.removedIds) restored.delete(id);
            for (const stored of mutation.upserts) {
                restored.set(stored.id, { stored, sourceVersion: mutation.version });
            }
        };
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === REGISTRY_ENTRY_TYPE) {
                const snapshot = parseLegacySnapshot(entry.data);
                if (snapshot?.ownerSessionId === this.ownerSessionId) {
                    restored.clear();
                    for (const stored of snapshot.subagents) {
                        restored.set(stored.id, { stored, sourceVersion: LEGACY_REGISTRY_VERSION });
                    }
                    continue;
                }
                applyMutation(parseRegistryMutation(entry.data));
                continue;
            }
            if (entry.type === "message" && entry.message.role === "toolResult") {
                const details = isRecord(entry.message.details) ? entry.message.details : undefined;
                applyMutation(parseRegistryMutation(details?.[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY]));
                if (entry.message.toolName !== "subagent") continue;
                const receipt = parseCursorDeliveryReceipt(details?.[SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY]);
                if (receipt) deliveryReceipts.set(`${receipt.subagentId}:${receipt.runId}`, receipt);
            }
        }

        for (const { stored, sourceVersion } of restored.values()) {
            let normalized = false;
            let cursorOneShotRecovery = false;
            if (stored.localLifecycle === "stopped" && stored.activeBlocker) {
                stored.activeBlocker = undefined;
                normalized = true;
            } else if (stored.activeBlocker && stored.lifetime === "one-shot") {
                stored.lifetime = "task";
                normalized = true;
            }
            if (stored.runtime === "cursor-cloud" && stored.lifetime === "one-shot") {
                if (stored.pendingResult.state === "available") {
                    stored.lifetime = "task";
                    stored.pendingResult = { ...stored.pendingResult, archiveAfterDelivery: true };
                    normalized = true;
                } else {
                    // The remote run can settle while Pi is offline. Keep this local
                    // marker until reconciliation confirms whether it has a result.
                    cursorOneShotRecovery = true;
                }
            }
            this.records.set(stored.id, { stored, ...(cursorOneShotRecovery ? { cursorOneShotRecovery } : {}) });
            if (sourceVersion === SUBAGENT_REGISTRY_VERSION && !normalized) {
                this.persistedFingerprints.set(stored.id, storedFingerprint(stored));
            }
        }
        for (const id of this.pruneStoppedRecords()) {
            this.pendingRestoreRemovedIds.add(id);
        }
        this.persist();
        // A persisted ToolResult can survive before turn_end performs cleanup. Replay
        // its receipt after restore so an already delivered Cursor result cannot replay.
        for (const receipt of deliveryReceipts.values()) {
            void this.processCursorDeliveryReceipt(receipt);
        }
    }

    validateCreate(ctx: ExtensionContext, options: CreatePersistentSubagentOptions): void {
        this.ensureOwner(ctx);
        const runtime = options.runtime ?? options.persona?.runtime ?? "pi";
        if (options.persona && options.runtime && options.runtime !== options.persona.runtime) {
            throw new Error(`runtime "${options.runtime}" does not match persona "${options.persona.name}" runtime "${options.persona.runtime}"`);
        }
        const name = options.name?.trim() || this.nextName(options.persona?.name ?? "subagent");
        if (name.length > 64 || !SUBAGENT_NAME_PATTERN.test(name)) {
            throw new Error(`Invalid subagent name "${name}"; use at most 64 lowercase letters, digits, and internal hyphens`);
        }
        if ([...this.records.values()].some((record) => record.stored.name === name)) {
            throw new Error(`A subagent named "${name}" already exists`);
        }
        const retainedCount = [...this.records.values()].filter((record) => record.stored.localLifecycle !== "stopped").length;
        if (retainedCount >= MAX_RETAINED_SUBAGENTS) {
            throw new Error(`Retained subagent limit reached (${MAX_RETAINED_SUBAGENTS}). List and reuse a matching purpose, or stop one before creating another`);
        }
        if (runtime === "pi" && options.mode === "fork") {
            const parentSessionFile = options.parentSessionFile ?? ctx.sessionManager.getSessionFile();
            if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
                throw new Error("Cannot fork a parent session that has not been persisted yet");
            }
        }
    }

    create(ctx: ExtensionContext, options: CreatePersistentSubagentOptions): PersistentSubagentSummary | Promise<PersistentSubagentSummary> {
        this.validateCreate(ctx, options);
        const name = options.name?.trim() || this.nextName(options.persona?.name ?? "subagent");
        const parentSessionFile = options.mode === "fork"
            ? options.parentSessionFile ?? ctx.sessionManager.getSessionFile() ?? undefined
            : undefined;

        const id = `sa_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        const now = Date.now();
        const runtime = options.runtime ?? options.persona?.runtime ?? "pi";
        if (runtime === "cursor-cloud") {
            // Agent.create accepts a client-generated Cloud ID. Save it before a
            // handle or send can make a remote side effect.
            const agentId = `bc-${randomUUID()}`;
            const createAgentOperation: CursorPendingOperation = {
                kind: "create-agent",
                idempotencyKey: `pi-cursor-${createHash("sha256").update(`${id}:create-agent:${agentId}`).digest("hex")}`,
                createdAt: now,
            };
            const stored: StoredCursorSubagent = {
                id,
                name,
                runtime: "cursor-cloud",
                purpose: normalizeSubagentPurpose(options.purpose),
                ...(options.persona ? { persona: clonePersona(options.persona) } : {}),
                lifetime: options.lifetime ?? "persistent",
                mode: options.mode,
                cwd: ctx.cwd,
                createdAt: now,
                lastActiveAt: now,
                localLifecycle: "available",
                agentId,
                remoteCreated: false,
                repositories: [],
                ...(options.cursorProfile ? { requestedProfile: options.cursorProfile } : {}),
                pendingOperations: [createAgentOperation],
                remoteLifecycle: "local",
                pendingResult: { state: "none" },
                ...(options.mode === "fork" && options.persona?.contextRequirements
                    ? { parentContextProvided: true }
                    : {}),
            };
            const record = { stored };
            this.records.set(id, record);
            // Keep prompt-less creation local. The first prompt builds the lazy SDK
            // handle and starts the only remote side effect, Agent.send.
            this.persist();
            return this.summary(record);
        }
        const sessionDir = this.sessionDir(ctx);
        fs.mkdirSync(sessionDir, { recursive: true });
        const stored: StoredPiSubagent = {
            id,
            name,
            runtime: "pi",
            purpose: normalizeSubagentPurpose(options.purpose),
            ...(options.persona ? { persona: clonePersona(options.persona) } : {}),
            selectedSkillPaths: [...new Set(options.skills ?? [])],
            lifetime: options.lifetime ?? "persistent",
            mode: options.mode,
            ...(parentSessionFile ? { parentSessionFile } : {}),
            sessionDir,
            cwd: ctx.cwd,
            ...(options.model
                ? { model: options.model }
                : ctx.model
                    ? { model: `${ctx.model.provider}/${ctx.model.id}` }
                    : {}),
            thinking: options.thinking ?? this.pi.getThinkingLevel() as SubagentThinkingLevel,
            scopedModels: ctx.scopedModels.map(({ model, thinkingLevel }) => ({
                provider: model.provider,
                id: model.id,
                ...(thinkingLevel ? { thinkingLevel: thinkingLevel as SubagentThinkingLevel } : {}),
            })),
            createdAt: now,
            lastActiveAt: now,
            localLifecycle: "available",
            ...(options.mode === "fork" && options.persona?.contextRequirements
                ? { parentContextProvided: true }
                : {}),
        };
        const record = { stored };
        this.records.set(id, record);
        this.persist();
        return this.summary(record);
    }

    createActiveTurnForkSnapshot(ctx: ExtensionContext): ModelForkContext {
        this.ensureOwner(ctx);
        return createActiveTurnForkSnapshot(ctx.sessionManager, path.join(this.sessionDir(ctx), "fork-snapshots"));
    }

    deferPersistence(): () => RegistryMutation | undefined {
        this.deferredPersistenceDepth++;
        let finished = false;
        return () => {
            if (finished) return undefined;
            finished = true;
            this.deferredPersistenceDepth--;
            if (this.deferredPersistenceDepth > 0) return undefined;
            const mutation = this.deferredMutation;
            this.deferredMutation = undefined;
            if (mutation) this.markPersisted();
            return mutation;
        };
    }

    list(): PersistentSubagentSummary[] {
        return [...this.records.values()]
            .map((record) => this.summary(record))
            .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    }

    private resolve(value: string): RuntimePersistentSubagent {
        const query = value.trim();
        if (!query) throw new Error("A subagent id or name is required");
        const exact = this.records.get(query)
            ?? [...this.records.values()].find((record) => record.stored.name === query);
        if (exact) return exact;
        const matches = [...this.records.values()].filter((record) =>
            record.stored.id.startsWith(query) || record.stored.name.startsWith(query));
        if (matches.length === 1) return matches[0]!;
        if (matches.length > 1) throw new Error(`Ambiguous subagent id or name: ${query}`);
        throw new Error(`Unknown subagent: ${query}`);
    }

    async prompt(
        ctx: ExtensionContext,
        target: string,
        prompt: string,
        options: PromptPersistentSubagentOptions = {},
    ): Promise<PromptPersistentSubagentResult> {
        const record = this.resolve(target);
        await this.reconcileForAction(record);
        this.assertAvailable(record);
        const requirements = record.stored.persona?.contextRequirements;
        if (requirements && !record.stored.parentContextProvided && !options.parentContextProvided) {
            throw new Error(
                `${record.stored.persona?.name ?? record.stored.name} requires context before its first parent prompt: ${requirements}. Retry with context.`,
            );
        }
        const contextFingerprint = requirements && !record.stored.parentContextProvided && options.parentContextProvided
            ? promptFingerprint(prompt)
            : undefined;
        if (contextFingerprint) (record.contextPromptFingerprints ??= new Set()).add(contextFingerprint);
        let unsubscribe: (() => void) | undefined;
        let controller: SubagentSessionController | undefined;
        try {
            controller = this.ensureController(ctx, record);
            unsubscribe = options.onStateChange
                ? controller.subscribe(() => options.onStateChange!(this.summary(record)))
                : undefined;
            const result = await controller.promptAndWait(prompt, options.signal);
            record.stored.lastActiveAt = Date.now();
            // Prompt delivery normally persists this at message_start. Keep the
            // post-settlement assignment for injected controllers and old runtimes.
            if (requirements && options.parentContextProvided && !result.handledWithoutAgent) {
                record.stored.parentContextProvided = true;
            }
            this.captureRuntimeState(record);
            const responseProduced = result.responseProduced ?? Boolean(result.text.trim());
            if (responseProduced && result.text.trim()) {
                this.processSettledBlocker(record, controller, result.text);
            }
            // Return an acknowledgement token only for the authoritative completion
            // that this parent prompt exposed. Tool finalization decides retention and
            // prepares output before acknowledgement.
            const delivery = this.cursorResultDelivery(record, controller);
            this.persist();
            return {
                summary: this.summary(record),
                metadata: this.runtimeMetadata(record),
                ...result,
                ...(delivery ? { delivery } : {}),
            };
        } catch (error) {
            if (controller && record.stored.runtime === "cursor-cloud") {
                // Pending or uncertain Cursor state is not evidence of delivery. Only
                // the controller can attach a receipt after it surfaced an authoritative
                // terminal completion to this parent outcome.
                const delivery = this.cursorResultDelivery(record, controller);
                if (delivery) {
                    this.persist();
                    throw new SubagentCursorPromptFailure(
                        error,
                        this.summary(record),
                        this.runtimeMetadata(record),
                        delivery,
                    );
                }
            }
            throw error;
        } finally {
            if (contextFingerprint) record.contextPromptFingerprints?.delete(contextFingerprint);
            unsubscribe?.();
        }
    }

    async open(
        ctx: ExtensionContext,
        target: string,
        initialPrompt = "",
    ): Promise<OpenPersistentSubagentResult> {
        const record = this.resolve(target);
        const retainedResult = this.hasRetainedCursorResult(record);
        if (!retainedResult) this.assertAvailable(record);
        const controller = this.ensureController(ctx, record);
        if (record.stored.runtime === "cursor-cloud") controller.beginCursorPanelReconnect();
        const beforeStart = record.stored.runtime === "cursor-cloud"
            ? async () => {
                // An archived result is already terminal authority. Reconciliation can
                // only replace its delivery state, so open it directly as read-only.
                if (!(this.hasRetainedCursorResult(record) && record.stored.localLifecycle === "stopped")) {
                    await this.reconcileForAction(record);
                }
                if (!this.hasRetainedCursorResult(record)) this.assertAvailable(record);
            }
            : undefined;
        const persona = record.stored.persona ? ` · ${record.stored.persona.name}` : "";
        const result = await runSubagentDialog(ctx, controller, `Subagent · ${record.stored.name}${persona}`, initialPrompt, beforeStart);
        record.stored.lastActiveAt = Date.now();
        this.captureRuntimeState(record);
        if (result?.action !== "return") {
            this.persist();
            return result;
        }
        const pending = record.stored.runtime === "cursor-cloud" && record.stored.pendingResult.state === "available"
            ? { id: record.stored.pendingResult.runId, runtime: "cursor-cloud" as const, parentOwned: true }
            : undefined;
        if (pending) controller.prepareCursorPanelDelivery(pending);
        const delivery = this.cursorResultDelivery(record, controller);
        this.persist();
        return { ...result, summary: this.summary(record), ...(delivery ? { delivery } : {}) };
    }

    async setLifetime(
        target: string,
        lifetime: SubagentLifetime,
    ): Promise<PersistentSubagentSummary> {
        const record = this.resolve(target);
        const update = async () => {
            this.assertAvailable(record);
            const previous = record.stored.lifetime;
            record.stored.lifetime = lifetime;
            record.stored.lastActiveAt = Date.now();

            // Pi lifetime guidance is part of its process prompt. Cursor keeps its
            // observer through delivery so the run-scoped acknowledgement stays valid.
            if (previous !== lifetime && record.controller && record.stored.runtime === "pi") {
                record.unsubscribe?.();
                record.unsubscribe = undefined;
                this.captureRuntimeState(record);
                await record.controller.stop();
                this.captureRuntimeState(record);
                record.controller = undefined;
                record.observedSettlementRevision = undefined;
            }

            this.persist();
            return this.summary(record);
        };
        return record.stored.runtime === "cursor-cloud"
            ? this.serializeRecord(record, update)
            : update();
    }

    async stop(target: string): Promise<PersistentSubagentSummary> {
        const record = this.resolve(target);
        if (record.stored.runtime === "cursor-cloud") return this.stopCursor(record);
        record.unsubscribe?.();
        record.unsubscribe = undefined;
        if (record.controller) {
            await record.controller.stop();
            this.captureRuntimeState(record);
            record.controller = undefined;
        }
        record.promptAttributions = undefined;
        record.stored.activeBlocker = undefined;
        record.stored.localLifecycle = "stopped";
        record.stored.lastActiveAt = Date.now();
        const summary = this.summary(record);
        this.pruneStoppedRecords();
        this.persist();
        return summary;
    }

    summaryFor(target: string): PersistentSubagentSummary {
        return this.summary(this.resolve(target));
    }

    runtimeMetadataFor(target: string): SubagentRuntimeMetadata {
        return this.runtimeMetadata(this.resolve(target));
    }

    /** Settle a persisted ToolResult receipt after turn_end or session restore. */
    async processCursorDeliveryReceipt(receiptValue: unknown): Promise<void> {
        const receipt = parseCursorDeliveryReceipt(receiptValue);
        if (!receipt) return;
        const record = this.records.get(receipt.subagentId);
        if (!record || record.stored.runtime !== "cursor-cloud") return;
        let delivered = false;
        try {
            await this.serializeRecord(record, async () => {
                const stored = record.stored;
                if (stored.runtime !== "cursor-cloud" || stored.localLifecycle === "stopped"
                    || stored.currentRunId !== receipt.runId) return;
                if (stored.pendingResult.state === "available" && stored.pendingResult.runId === receipt.runId) {
                    const run = { id: receipt.runId, runtime: "cursor-cloud" as const, parentOwned: true };
                    await record.controller?.markCursorRunCompletionDelivered(run);
                    if (record.stored.runtime === "cursor-cloud"
                        && record.stored.pendingResult.state === "available"
                        && record.stored.pendingResult.runId === receipt.runId) {
                        record.stored.pendingResult = { state: "none" };
                    }
                    this.persist();
                    delivered = true;
                    return;
                }
                delivered = stored.pendingResult.state === "none";
            });
        } catch {
            // Keep the durable result and receipt for a later turn_end or restore.
            return;
        }
        if (!delivered || receipt.archiveAfterDelivery !== true) return;
        const current = record.stored;
        if (current.runtime !== "cursor-cloud" || current.localLifecycle === "stopped"
            || current.currentRunId !== receipt.runId || current.pendingResult.state !== "none") return;
        // stopCursor persists stopping and archive operations before remote cleanup.
        await this.stopCursor(record).catch(() => undefined);
    }

    async status(target: string): Promise<PersistentSubagentSummary> {
        const record = this.resolve(target);
        await this.reconcileForAction(record);
        return this.summary(record);
    }

    /**
     * Serialize a Cursor operation and persist a durable update before its next
     * remote side effect. The Cursor backend uses this seam in a later package.
     */
    async runCursorOperation<T>(
        target: string,
        operation: (
            stored: Readonly<StoredCursorSubagent>,
            persist: (next: StoredCursorSubagent) => void,
        ) => Promise<T>,
    ): Promise<T> {
        if (this.shuttingDown) throw new Error("Persistent subagent registry is shutting down");
        const record = this.resolve(target);
        if (record.stored.runtime !== "cursor-cloud") {
            throw new Error(`Subagent ${record.stored.name} does not use Cursor Cloud`);
        }
        return this.serializeRecord(record, async () => {
            this.assertAvailable(record);
            return operation(cloneStoredSubagent(record.stored) as StoredCursorSubagent, (next) => {
                const parsed = parseStoredSubagent(next);
                if (!parsed || parsed.runtime !== "cursor-cloud" || parsed.id !== record.stored.id) {
                    throw new Error("Invalid Cursor subagent persistence update");
                }
                record.stored = parsed;
                this.persistDurable(true);
            });
        });
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        const disposals: Promise<void>[] = [];
        for (const record of this.records.values()) {
            record.unsubscribe?.();
            record.unsubscribe = undefined;
            if (record.stored.runtime === "pi" && record.controller) {
                disposals.push(record.controller.stop());
                continue;
            }
            if (record.stored.runtime === "cursor-cloud") {
                disposals.push(this.serializeRecord(record, async () => {
                    // Wait for a short send-acceptance section, then invalidate any
                    // stale backend before disposal. Do not wait for remote runs.
                    record.cursorLease = (record.cursorLease ?? 0) + 1;
                    if (record.controller) {
                        const controller = record.controller;
                        record.controller = undefined;
                        record.observedSettlementRevision = undefined;
                        await controller.stop();
                    }
                    await this.cursorLifecycle.disposeObservers?.(cloneStoredSubagent(record.stored) as StoredCursorSubagent);
                }));
            }
        }
        await Promise.allSettled(disposals);
        this.records.clear();
    }

    private hasRetainedCursorResult(record: RuntimePersistentSubagent): boolean {
        return record.stored.runtime === "cursor-cloud" && record.stored.pendingResult.state === "available";
    }

    private usesConcurrentSlot(record: RuntimePersistentSubagent): boolean {
        if (record.runSlotHeld) return true;
        const { stored } = record;
        if (stored.localLifecycle === "stopped" || stored.runtime !== "cursor-cloud") return false;
        return stored.remoteLifecycle === "running"
            || stored.remoteLifecycle === "stopping"
            || stored.remoteLifecycle === "remote-state-unknown"
            || stored.pendingOperations.some((operation) => operation.kind === "start-run" || operation.kind === "follow-up");
    }

    private acquireConcurrentSlot(record: RuntimePersistentSubagent): void {
        if (record.runSlotHeld) return;
        const concurrentCount = [...this.records.values()].filter((candidate) => this.usesConcurrentSlot(candidate)).length;
        if (concurrentCount >= MAX_CONCURRENT_SUBAGENTS) {
            throw new Error(`Concurrent subagent limit reached (${MAX_CONCURRENT_SUBAGENTS}). Wait for a running subagent to settle, then retry`);
        }
        record.runSlotHeld = true;
    }

    private releaseConcurrentSlot(record: RuntimePersistentSubagent): void {
        record.runSlotHeld = false;
    }

    private assertAvailable(record: RuntimePersistentSubagent): void {
        const { stored } = record;
        if (stored.localLifecycle === "stopped") {
            throw new Error(`Subagent ${stored.name} has been stopped`);
        }
        if (stored.localLifecycle === "unavailable") {
            const state = stored.runtime === "cursor-cloud" ? stored.remoteLifecycle : "stopping";
            throw new Error(`Subagent ${stored.name} is not available while remote state is ${state}`);
        }
    }

    private serializeRecord<T>(record: RuntimePersistentSubagent, operation: () => Promise<T>): Promise<T> {
        const previous = record.operationTail ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        record.operationTail = current.then(() => undefined, () => undefined);
        return current;
    }

    private needsReconciliation(stored: StoredCursorSubagent): boolean {
        return stored.localLifecycle !== "stopped" && (stored.remoteCreated || stored.remoteLifecycle !== "local"
            || stored.pendingOperations.some((operation) => operation.kind !== "create-agent"));
    }

    private async reconcileForAction(record: RuntimePersistentSubagent): Promise<void> {
        if (record.stored.runtime !== "cursor-cloud" || !this.needsReconciliation(record.stored)) return;
        await this.serializeRecord(record, async () => this.reconcileCursorNow(record));
    }

    private async reconcileCursorNow(record: RuntimePersistentSubagent): Promise<boolean> {
        const stored = record.stored;
        if (stored.runtime !== "cursor-cloud" || !this.needsReconciliation(stored)) return false;
        if (!this.cursorLifecycle.reconcile) {
            throw new Error("Cursor Cloud subagent reconciliation is not available until the Cursor backend is configured");
        }
        const reconciliation = await this.cursorLifecycle.reconcile(cloneStoredSubagent(stored) as StoredCursorSubagent);
        if (!reconciliation) return false;
        this.applyCursorReconciliation(record, stored, reconciliation);
        this.persistDurable(this.shuttingDown);
        return true;
    }

    private applyCursorReconciliation(
        record: RuntimePersistentSubagent,
        stored: StoredCursorSubagent,
        reconciliation: CursorSubagentReconciliation,
    ): void {
        const clearsInitialSend = reconciliation.clearPendingSend
            && stored.pendingOperations.some((operation) => operation.kind === "start-run");
        stored.remoteLifecycle = reconciliation.remoteLifecycle;
        if (reconciliation.clearPendingSend) {
            // A lifecycle port can clear only after authoritative absence. Initial
            // lazy IDs can also be absent from Agent.get before remote creation.
            stored.pendingOperations = stored.pendingOperations.filter((operation) =>
                operation.kind !== "start-run" && operation.kind !== "follow-up");
            if (clearsInitialSend) {
                stored.remoteCreated = false;
                delete stored.currentRunId;
                delete stored.currentRequestId;
            }
        } else if ((stored.remoteLifecycle === "running" || stored.remoteLifecycle === "idle")
            && reconciliation.currentRunId !== undefined) {
            // A uniquely reconciled run proves send acceptance. Its persisted
            // idempotency key is no longer pending, but remains in old entries.
            stored.pendingOperations = stored.pendingOperations.filter((operation) =>
                operation.kind !== "start-run" && operation.kind !== "follow-up");
        }
        if (stored.remoteLifecycle !== "local" && stored.remoteLifecycle !== "remote-state-unknown") {
            stored.remoteCreated = true;
        }
        if (reconciliation.pendingResult) {
            const pendingResult = parseCursorPendingResult(reconciliation.pendingResult);
            if (!pendingResult) throw new Error("Invalid Cursor pending result from reconciliation");
            stored.pendingResult = {
                ...pendingResult,
                ...(pendingResult.state === "available"
                    && stored.pendingResult.state !== "none"
                    && stored.pendingResult.runId === pendingResult.runId
                    && stored.pendingResult.archiveAfterDelivery === true
                    ? { archiveAfterDelivery: true }
                    : {}),
            };
        }
        if (reconciliation.currentRunId !== undefined) {
            if (!isCursorCloudRunId(reconciliation.currentRunId)) throw new Error("Invalid Cursor run identity from reconciliation");
            stored.currentRunId = reconciliation.currentRunId;
        }
        if (reconciliation.currentRequestId !== undefined) {
            if (!isSafeCursorValue(reconciliation.currentRequestId)) throw new Error("Invalid Cursor request identity from reconciliation");
            stored.currentRequestId = reconciliation.currentRequestId;
        }
        if (stored.pendingResult.state !== "none" && stored.pendingResult.runId !== stored.currentRunId) {
            throw new Error("Cursor pending result does not match the saved run identity");
        }
        if (record.cursorOneShotRecovery && stored.pendingResult.state === "available") {
            // A restored one-shot completed while Pi was absent. Keep its result as a
            // task until a parent or panel retrieves it, then apply normal archival.
            stored.lifetime = "task";
            stored.pendingResult = { ...stored.pendingResult, archiveAfterDelivery: true };
            record.cursorOneShotRecovery = false;
        }
        switch (stored.remoteLifecycle) {
            case "archived":
                stored.localLifecycle = "stopped";
                stored.activeBlocker = undefined;
                stored.pendingOperations = [];
                return;
            case "stopping":
                stored.localLifecycle = "unavailable";
                if (!stored.pendingOperations.some((operation) => operation.kind === "cancel-run")) {
                    stored.pendingOperations = [{ kind: "cancel-run", idempotencyKey: randomUUID(), createdAt: Date.now() }];
                }
                return;
            case "archive-started":
            case "archive-pending":
                stored.localLifecycle = "unavailable";
                if (!stored.pendingOperations.some((operation) => operation.kind === "archive")) {
                    stored.pendingOperations = [{ kind: "archive", idempotencyKey: randomUUID(), createdAt: Date.now() }];
                }
                return;
            case "remote-state-unknown":
                stored.localLifecycle = "unavailable";
                return;
            case "local":
                if (stored.remoteCreated) {
                    stored.remoteLifecycle = "remote-state-unknown";
                    stored.localLifecycle = "unavailable";
                    return;
                }
                stored.localLifecycle = "available";
                return;
            case "idle":
                stored.localLifecycle = "available";
                return;
            case "running":
                if (!stored.currentRunId) {
                    stored.remoteLifecycle = "remote-state-unknown";
                    stored.localLifecycle = "unavailable";
                    return;
                }
                stored.localLifecycle = "available";
                return;
        }
    }

    private async stopCursor(record: RuntimePersistentSubagent): Promise<PersistentSubagentSummary> {
        if (this.shuttingDown) throw new Error("Persistent subagent registry is shutting down");
        return this.serializeRecord(record, async () => {
            const pending = record.stored.runtime === "cursor-cloud" ? record.stored.pendingResult : undefined;
            if (pending?.state === "available") {
                throw new Error("Cursor Cloud has an undelivered result. Return or receive it before stopping the subagent");
            }
            // This starts after any send acceptance persisted run/request identity.
            // Older observers cannot overwrite the stopping lifecycle afterwards.
            record.cursorLease = (record.cursorLease ?? 0) + 1;
            record.unsubscribe?.();
            record.unsubscribe = undefined;
            if (record.controller) {
                await record.controller.stop();
                record.controller = undefined;
                record.observedSettlementRevision = undefined;
            }
            const initial = record.stored;
            if (initial.runtime !== "cursor-cloud") throw new Error("Cursor subagent state changed during stop");
            if (this.isLocalOnlyCursor(initial)) return this.stopLocalOnlyCursor(record, initial);
            const reconciled = await this.reconcileCursorNow(record);
            const stored = record.stored;
            if (stored.runtime !== "cursor-cloud") throw new Error("Cursor subagent state changed during stop");
            if (stored.pendingResult.state === "available") {
                throw new Error("Cursor Cloud has an undelivered result. Return or receive it before stopping the subagent");
            }
            if (stored.localLifecycle === "stopped") return this.summary(record);
            if (reconciled && !stored.remoteCreated && stored.remoteLifecycle === "local") {
                return this.stopLocalOnlyCursor(record, stored);
            }
            if (!stored.remoteCreated && (stored.remoteLifecycle === "local" || stored.remoteLifecycle === "remote-state-unknown")) {
                stored.remoteLifecycle = "remote-state-unknown";
                stored.localLifecycle = "unavailable";
                stored.activeBlocker = undefined;
                stored.lastActiveAt = Date.now();
                const summary = this.summary(record);
                this.persistDurable(true);
                return summary;
            }
            if (!this.cursorLifecycle.stop) {
                throw new Error("Cursor Cloud subagent stop is not available until the Cursor backend is configured");
            }

            let archiveStarted = stored.remoteLifecycle === "archive-started" || stored.remoteLifecycle === "archive-pending";
            const persistArchiveStarted = () => {
                const archive = stored.pendingOperations.find((operation) => operation.kind === "archive") ?? {
                    kind: "archive" as const,
                    idempotencyKey: randomUUID(),
                    createdAt: Date.now(),
                };
                stored.pendingOperations = [archive];
                stored.remoteLifecycle = "archive-started";
                stored.localLifecycle = "unavailable";
                stored.activeBlocker = undefined;
                stored.lastActiveAt = Date.now();
                archiveStarted = true;
                this.persistDurable(true);
            };

            if (archiveStarted) {
                persistArchiveStarted();
            } else {
                const cancellation = stored.pendingOperations.find((operation) => operation.kind === "cancel-run") ?? {
                    kind: "cancel-run" as const,
                    idempotencyKey: randomUUID(),
                    createdAt: Date.now(),
                };
                stored.pendingOperations = [cancellation];
                stored.localLifecycle = "unavailable";
                stored.remoteLifecycle = "stopping";
                stored.activeBlocker = undefined;
                stored.lastActiveAt = Date.now();
                this.persistDurable(true);
            }

            let outcome: CursorSubagentStopOutcome;
            try {
                outcome = await this.cursorLifecycle.stop(cloneStoredSubagent(stored) as StoredCursorSubagent, {
                    persistArchiveStarted,
                });
            } catch (error) {
                stored.remoteLifecycle = archiveStarted ? "archive-pending" : "remote-state-unknown";
                stored.localLifecycle = "unavailable";
                this.persistDurable(true);
                throw error;
            }
            stored.lastActiveAt = Date.now();
            switch (outcome.state) {
                case "stopped":
                    stored.pendingOperations = [];
                    stored.remoteLifecycle = "archived";
                    stored.localLifecycle = "stopped";
                    stored.activeBlocker = undefined;
                    this.pruneStoppedRecords();
                    break;
                case "archive-pending":
                    if (!archiveStarted) persistArchiveStarted();
                    stored.remoteLifecycle = "archive-pending";
                    stored.localLifecycle = "unavailable";
                    break;
                case "remote-state-unknown":
                    stored.remoteLifecycle = archiveStarted ? "archive-pending" : "remote-state-unknown";
                    stored.localLifecycle = "unavailable";
                    break;
            }
            const summary = this.summary(record);
            this.persistDurable(true);
            return summary;
        });
    }

    private isLocalOnlyCursor(stored: StoredCursorSubagent): boolean {
        return !stored.remoteCreated && stored.remoteLifecycle === "local"
            && !stored.currentRunId && !stored.currentRequestId && stored.pendingResult.state === "none"
            && stored.pendingOperations.every((operation) => operation.kind === "create-agent");
    }

    private stopLocalOnlyCursor(
        record: RuntimePersistentSubagent,
        stored: StoredCursorSubagent,
    ): PersistentSubagentSummary {
        delete stored.agentId;
        delete stored.currentRunId;
        delete stored.currentRequestId;
        stored.pendingOperations = [];
        stored.localLifecycle = "stopped";
        stored.activeBlocker = undefined;
        stored.lastActiveAt = Date.now();
        this.pruneStoppedRecords();
        const summary = this.summary(record);
        this.persistDurable(true);
        return summary;
    }

    private cursorBackendConfiguration(
        ctx: ExtensionContext,
        record: RuntimePersistentSubagent,
    ): CursorCloudBackendConfiguration {
        if (record.stored.runtime !== "cursor-cloud") throw new Error("Cursor backend configuration requires Cursor state");
        const initialStored = cloneStoredSubagent(record.stored) as StoredCursorSubagent;
        const lease = (record.cursorLease ?? 0) + 1;
        record.cursorLease = lease;
        return {
            stored: initialStored,
            // A connected backend reads this after status reconciliation. It never
            // obtains a mutable registry reference or overwrites newer state.
            readStored: () => cloneStoredSubagent(record.stored) as StoredCursorSubagent,
            // Shutdown rejects new work but lets an already accepted send persist
            // its run identity before the shutdown operation obtains this record.
            isCurrent: () => record.cursorLease === lease,
            runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => this.serializeRecord(record, async () => {
                const retainedResult = record.stored.runtime === "cursor-cloud"
                    && record.stored.pendingResult.state === "available";
                if (this.shuttingDown || record.cursorLease !== lease
                    || (record.stored.localLifecycle !== "available" && !retainedResult)) {
                    throw new Error("Cursor Cloud observer is no longer available for send acceptance");
                }
                return operation();
            }),
            persist: (next) => {
                // A detached or stopped controller can finish late. It must not
                // replace registry state that a newer observer or stop owns.
                if (record.cursorLease !== lease) return;
                const parsed = parseStoredSubagent(next);
                if (!parsed || parsed.runtime !== "cursor-cloud" || parsed.id !== record.stored.id) {
                    throw new Error("Invalid Cursor subagent persistence update");
                }
                record.stored = parsed;
                this.persistDurable(true);
            },
            buildInitialPrompt: async (request, signal) => {
                const current = record.stored;
                if (current.runtime !== "cursor-cloud") throw new Error("Cursor subagent state changed during prompt preparation");
                const forkHandoff = current.mode === "fork"
                    ? await createCursorForkHandoffWithPiSummary({
                        context: {
                            model: ctx.model,
                            modelRegistry: ctx.modelRegistry,
                            sessionManager: ctx.sessionManager,
                        },
                        signal: signal ?? new AbortController().signal,
                    })
                    : undefined;
                return buildCursorCloudBootstrap({
                    mode: current.mode,
                    persona: current.persona,
                    purpose: current.purpose,
                    lifetime: current.lifetime,
                    request,
                    ...(forkHandoff ? { forkHandoff } : {}),
                });
            },
        };
    }

    private ensureController(ctx: ExtensionContext, record: RuntimePersistentSubagent): SubagentSessionController {
        if (record.controller) {
            const state = record.controller.state;
            if (state.connected || state.lifecycle === "starting") return record.controller;
            record.unsubscribe?.();
            record.unsubscribe = undefined;
            record.controller = undefined;
        }
        const stored = record.stored;
        const isPi = stored.runtime === "pi";
        const sessionFile = isPi && stored.sessionFile && fs.existsSync(stored.sessionFile)
            ? stored.sessionFile
            : undefined;
        if (isPi && stored.sessionFile && !sessionFile) stored.sessionFile = undefined;
        const args = isPi ? buildSubagentProcessArgs({
            mode: sessionFile ? "fresh" : stored.mode,
            parentSessionFile: sessionFile ? undefined : stored.parentSessionFile,
            sessionFile,
            sessionDir: stored.sessionDir,
            sessionName: stored.name,
            purpose: stored.purpose,
            lifetime: stored.lifetime,
            persona: stored.persona,
            model: stored.model,
            thinking: stored.thinking,
            scopedModels: stored.scopedModels,
            skills: stored.selectedSkillPaths,
        }) : [];
        const promptAttributions = isPi
            ? record.promptAttributions ?? this.readPromptAttributions(stored)
            : [];
        if (isPi) record.promptAttributions = promptAttributions;
        const controller = new SubagentSessionController(ctx, {
            args,
            cwd: stored.cwd,
            mode: stored.mode,
            persona: stored.persona,
            initialPrompt: "",
            scopedModels: isPi ? stored.scopedModels : [],
            promptAttributions,
            runSlot: {
                acquire: () => this.acquireConcurrentSlot(record),
                release: () => this.releaseConcurrentSlot(record),
            },
            ...(isPi ? {
                onPromptAccepted: (attribution: SubagentPromptAttribution) => {
                    promptAttributions.push({ ...attribution });
                    this.writePromptAttributions(stored, promptAttributions);
                },
                onPromptDelivered: (fingerprint: string) => {
                    if (!record.contextPromptFingerprints?.delete(fingerprint)) return;
                    stored.parentContextProvided = true;
                    this.persist();
                },
            } : { cursor: this.cursorBackendConfiguration(ctx, record) }),
        }, this.backendFactory);
        record.controller = controller;
        record.observedSettlementRevision = controller.settlementRevision;
        record.unsubscribe = controller.subscribe(() => {
            let changed = this.captureRuntimeState(record);
            if (controller.settlementRevision > (record.observedSettlementRevision ?? 0)) {
                record.observedSettlementRevision = controller.settlementRevision;
                const response = controller.latestSettledAssistantText;
                if (response !== undefined) {
                    this.updateBlocker(record, response);
                    changed = true;
                }
            }
            if (changed) this.persist();
        });
        return controller;
    }

    private processSettledBlocker(
        record: RuntimePersistentSubagent,
        controller: SubagentSessionController,
        response: string,
    ): void {
        const revision = controller.settlementRevision;
        if (typeof revision === "number") record.observedSettlementRevision = revision;
        this.updateBlocker(record, response);
    }

    private updateBlocker(record: RuntimePersistentSubagent, response: string): void {
        record.stored.activeBlocker = parseSubagentBlockerResponse(response);
    }

    /** Create an ephemeral token only for an authoritative exposed Cursor completion. */
    private cursorResultDelivery(
        record: RuntimePersistentSubagent,
        controller: SubagentSessionController,
    ): CursorResultDelivery | undefined {
        const stored = record.stored;
        if (stored.runtime !== "cursor-cloud" || stored.pendingResult.state !== "available") return undefined;
        const exposed = controller.cursorDeliveryForOutcome();
        if (!exposed || exposed.run.id !== stored.pendingResult.runId) return undefined;
        const runId = stored.pendingResult.runId;
        const archiveAfterDelivery = stored.pendingResult.archiveAfterDelivery === true || stored.lifetime === "one-shot";
        return {
            runId,
            archiveAfterDelivery,
            ...(exposed.completion ? { completion: exposed.completion } : {}),
            acknowledge: async () => this.acknowledgeCursorResult(record.stored.id, controller, runId, archiveAfterDelivery),
        };
    }

    /** Acknowledge one Cursor result after a parent response or editor handoff exists. */
    private async acknowledgeCursorResult(
        target: string,
        controller: SubagentSessionController,
        runId: string,
        archiveAfterDelivery: boolean,
    ): Promise<CursorResultDeliveryAcknowledgement> {
        const record = this.resolve(target);
        return this.serializeRecord(record, async () => {
            const stored = record.stored;
            if (stored.runtime !== "cursor-cloud" || record.controller !== controller
                || stored.pendingResult.state !== "available" || stored.pendingResult.runId !== runId) {
                return { runId, acknowledged: false, archiveAfterDelivery, summary: this.summary(record) };
            }
            const run = { id: runId, runtime: "cursor-cloud" as const, parentOwned: true };
            await controller.markCursorRunCompletionDelivered(run);
            // A stale observer or an explicit stop can replace state while delivery is in
            // progress. Never clear a different result or cleanup state.
            if (record.stored.runtime === "cursor-cloud"
                && record.stored.pendingResult.state === "available"
                && record.stored.pendingResult.runId === runId) {
                record.stored.pendingResult = { state: "none" };
            }
            this.persist();
            return { runId, acknowledged: true, archiveAfterDelivery, summary: this.summary(record) };
        });
    }

    private runtimeMetadata(record: RuntimePersistentSubagent): SubagentRuntimeMetadata {
        const { stored } = record;
        if (stored.runtime === "pi") return { kind: "pi" };
        return {
            kind: "cursor-cloud",
            remote: {
                ...(stored.agentId ? { agentId: stored.agentId } : {}),
                ...(stored.currentRunId ? { runId: stored.currentRunId } : {}),
                ...(stored.currentRequestId ? { requestId: stored.currentRequestId } : {}),
                remoteCreated: stored.remoteCreated,
                lifecycle: stored.remoteLifecycle,
                pendingResult: stored.pendingResult.state,
                ...(stored.currentModel ? { model: stored.currentModel.id } : {}),
                repositories: stored.repositories.map((repository) => ({ ...repository })),
            },
        };
    }

    private captureRuntimeState(record: RuntimePersistentSubagent): boolean {
        const state = record.controller?.state;
        if (!state || record.stored.runtime !== "pi") return false;
        let changed = false;
        if (state.sessionFile && fs.existsSync(state.sessionFile) && state.sessionFile !== record.stored.sessionFile) {
            record.stored.sessionFile = state.sessionFile;
            changed = true;
        }
        if (state.connected && state.model) {
            const model = `${state.model.provider}/${state.model.id}`;
            if (model !== record.stored.model) {
                record.stored.model = model;
                changed = true;
            }
        }
        if (state.connected && state.thinking !== record.stored.thinking) {
            record.stored.thinking = state.thinking;
            changed = true;
        }
        return changed;
    }

    private summary(record: RuntimePersistentSubagent): PersistentSubagentSummary {
        const { stored } = record;
        const state = record.controller?.state;
        let status: PersistentSubagentStatus;
        if (stored.localLifecycle === "stopped") status = "stopped";
        else if (stored.runtime === "cursor-cloud") {
            switch (stored.remoteLifecycle) {
                case "stopping":
                case "archive-started":
                    status = "stopping";
                    break;
                case "archive-pending":
                    status = "archive-pending";
                    break;
                case "remote-state-unknown":
                    status = "remote-state-unknown";
                    break;
                case "running":
                    status = "running";
                    break;
                case "idle":
                    status = stored.activeBlocker ? "blocked" : "idle";
                    break;
                case "local":
                    status = stored.activeBlocker ? "blocked" : "dormant";
                    break;
                case "archived":
                    status = "stopped";
                    break;
            }
        } else if (state?.connected && state.busy) status = "running";
        else if (state?.lifecycle === "starting") status = "starting";
        else if (stored.activeBlocker) status = "blocked";
        else if (!record.controller) status = "dormant";
        else if (state?.connected) status = "idle";
        else status = "error";
        const model = stored.runtime === "pi"
            ? state?.model ? `${state.model.provider}/${state.model.id}` : stored.model
            : stored.currentModel?.id;
        return {
            id: stored.id,
            name: stored.name,
            runtime: stored.runtime,
            purpose: stored.purpose,
            ...(stored.persona ? { persona: stored.persona.name } : {}),
            lifetime: stored.lifetime,
            ...(stored.activeBlocker ? { blocker: { ...stored.activeBlocker } } : {}),
            status,
            ...(model ? { model } : {}),
            ...(stored.runtime === "pi" ? {
                thinking: state?.connected ? state.thinking : stored.thinking,
                ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
            } : {}),
            createdAt: stored.createdAt,
            lastActiveAt: stored.lastActiveAt,
        };
    }

    private promptAttributionPath(stored: StoredPiSubagent): string {
        return path.join(stored.sessionDir, `${stored.id}-prompt-attributions.json`);
    }

    private readPromptAttributions(stored: StoredPiSubagent): SubagentPromptAttribution[] {
        try {
            const value = JSON.parse(fs.readFileSync(this.promptAttributionPath(stored), "utf8")) as unknown;
            return parsePromptAttributions(value);
        } catch {
            return [];
        }
    }

    private writePromptAttributions(
        stored: StoredPiSubagent,
        attributions: readonly SubagentPromptAttribution[],
    ): void {
        fs.mkdirSync(stored.sessionDir, { recursive: true });
        const target = this.promptAttributionPath(stored);
        const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
        try {
            fs.writeFileSync(temporary, `${JSON.stringify({
                version: PROMPT_ATTRIBUTION_VERSION,
                entries: attributions,
            })}\n`, { mode: 0o600 });
            fs.renameSync(temporary, target);
        } finally {
            if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
        }
    }

    private pruneStoppedRecords(): string[] {
        const removedIds: string[] = [];
        const stopped = [...this.records.values()]
            .filter((record) => record.stored.localLifecycle === "stopped")
            .reverse()
            .sort((left, right) => right.stored.lastActiveAt - left.stored.lastActiveAt);
        for (const record of stopped.slice(MAX_RETAINED_STOPPED_SUBAGENTS)) {
            this.records.delete(record.stored.id);
            removedIds.push(record.stored.id);
        }
        return removedIds;
    }

    private persist(): void {
        if (this.shuttingDown || !this.ownerSessionId) return;
        const mutation = this.currentMutation();
        if (!mutation) return;
        if (this.deferredPersistenceDepth > 0) {
            this.deferredMutation = mutation;
            return;
        }
        this.pi.appendEntry(REGISTRY_ENTRY_TYPE, mutation);
        this.markPersisted();
    }

    private persistDurable(allowDuringShutdown = false): void {
        if ((this.shuttingDown && !allowDuringShutdown) || !this.ownerSessionId) return;
        const mutation = this.currentMutation();
        if (!mutation) return;
        this.pi.appendEntry(REGISTRY_ENTRY_TYPE, mutation);
        this.markPersisted();
        this.deferredMutation = undefined;
    }

    private currentMutation(): RegistryMutation | undefined {
        if (!this.ownerSessionId) return undefined;
        const upserts: StoredSubagent[] = [];
        const currentFingerprints = new Map<string, string>();
        for (const { stored } of this.records.values()) {
            const fingerprint = storedFingerprint(stored);
            currentFingerprints.set(stored.id, fingerprint);
            if (this.persistedFingerprints.get(stored.id) !== fingerprint) {
                upserts.push(cloneStoredSubagent(stored));
            }
        }
        const removedIds = [...new Set([
            ...[...this.persistedFingerprints.keys()].filter((id) => !currentFingerprints.has(id)),
            ...this.pendingRestoreRemovedIds,
        ])];
        if (upserts.length === 0 && removedIds.length === 0) return undefined;
        return {
            version: SUBAGENT_REGISTRY_VERSION,
            ownerSessionId: this.ownerSessionId,
            upserts,
            removedIds,
        };
    }

    private markPersisted(): void {
        this.pendingRestoreRemovedIds.clear();
        this.persistedFingerprints.clear();
        for (const { stored } of this.records.values()) {
            this.persistedFingerprints.set(stored.id, storedFingerprint(stored));
        }
    }

    private ensureOwner(ctx: ExtensionContext): void {
        const ownerSessionId = ctx.sessionManager.getSessionId();
        if (!this.ownerSessionId) this.ownerSessionId = ownerSessionId;
        if (this.ownerSessionId !== ownerSessionId) {
            throw new Error("Persistent subagent registry belongs to a different parent session");
        }
    }

    private nextName(base: string): string {
        const normalized = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "subagent";
        const used = new Set([...this.records.values()].map((record) => record.stored.name));
        if (!used.has(normalized)) return normalized;
        for (let index = 2; index < 10_000; index++) {
            const candidate = `${normalized}-${index}`;
            if (!used.has(candidate)) return candidate;
        }
        throw new Error(`Could not allocate a unique subagent name for ${base}`);
    }

    private sessionDir(ctx: ExtensionContext): string {
        const owner = this.ownerSessionId ?? ctx.sessionManager.getSessionId();
        const parentSessionFile = ctx.sessionManager.getSessionFile();
        const base = parentSessionFile
            ? path.dirname(parentSessionFile)
            : path.join(getAgentDir(), "sessions", "subagents");
        return path.join(base, "persistent-subagents", owner);
    }
}

export function formatSubagentSummary(summary: PersistentSubagentSummary): string {
    const persona = summary.persona ? ` · ${summary.persona}` : "";
    const model = summary.model ? ` · ${summary.model}` : "";
    const blocker = summary.blocker ? ` · needs: ${summary.blocker.need}` : "";
    return `${summary.name} (${summary.id}) · ${summary.runtime} · ${summary.status} · ${summary.lifetime} · purpose: ${summary.purpose}${persona}${model}${blocker}`;
}

export function registryErrorMessage(error: unknown): string {
    return errorMessage(error);
}
