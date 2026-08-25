import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    buildSubagentProcessArgs,
    normalizePersonaContextRequirements,
    SUBAGENT_LIFETIMES,
    type SubagentContextMode,
    type SubagentPersona,
    type SubagentScopedModel,
    type SubagentThinkingLevel,
    type SubagentLifetime,
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
    runSubagentDialog,
    type SubagentPromptAttribution,
    type SubagentPromptCompletion,
} from "./ui.ts";

const REGISTRY_ENTRY_TYPE = "persistent-subagents";
export const SUBAGENT_REGISTRY_TOOL_DETAILS_KEY = "persistentSubagentRegistry";
const LEGACY_REGISTRY_VERSION = 1;
const REGISTRY_VERSION = 2;
const PROMPT_ATTRIBUTION_VERSION = 1;
export const MAX_PERSISTENT_SUBAGENTS = 4;
export const MAX_RETAINED_STOPPED_SUBAGENTS = 20;
const MAX_PURPOSE_CHARS = 240;
const SUBAGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const THINKING_LEVELS = new Set<SubagentThinkingLevel>([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const LIFETIMES = new Set<SubagentLifetime>(SUBAGENT_LIFETIMES);

export type PersistentSubagentStatus = "dormant" | "starting" | "idle" | "running" | "blocked" | "error" | "stopped";

export interface PersistentSubagentSummary {
    id: string;
    name: string;
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
    purpose: string;
    persona?: SubagentPersona;
    lifetime?: SubagentLifetime;
    mode: SubagentContextMode;
    parentSessionFile?: string;
    skills?: readonly string[];
    model?: string;
    thinking?: SubagentThinkingLevel;
}

export interface PromptPersistentSubagentOptions {
    signal?: AbortSignal;
    onStateChange?: (summary: PersistentSubagentSummary) => void;
    parentContextProvided?: boolean;
}

export interface PromptPersistentSubagentResult extends SubagentPromptCompletion {
    summary: PersistentSubagentSummary;
}

interface StoredPersistentSubagent {
    id: string;
    name: string;
    purpose: string;
    persona?: SubagentPersona;
    selectedSkillPaths: string[];
    lifetime: SubagentLifetime;
    mode: SubagentContextMode;
    parentSessionFile?: string;
    sessionFile?: string;
    sessionDir: string;
    cwd: string;
    model?: string;
    thinking: SubagentThinkingLevel;
    scopedModels: SubagentScopedModel[];
    createdAt: number;
    lastActiveAt: number;
    parentContextProvided?: boolean;
    activeBlocker?: ActiveSubagentBlocker;
    stopped?: boolean;
}

interface LegacyRegistrySnapshot {
    version: typeof LEGACY_REGISTRY_VERSION;
    ownerSessionId: string;
    subagents: StoredPersistentSubagent[];
}

interface RegistryMutation {
    version: typeof REGISTRY_VERSION;
    ownerSessionId: string;
    upserts: StoredPersistentSubagent[];
    removedIds: string[];
}

interface RuntimePersistentSubagent {
    stored: StoredPersistentSubagent;
    controller?: SubagentSessionController;
    unsubscribe?: () => void;
    promptAttributions?: SubagentPromptAttribution[];
    contextPromptFingerprints?: Set<string>;
    observedSettlementRevision?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
        ...(typeof persona.contextRequirements === "string" && persona.contextRequirements.trim()
            ? { contextRequirements: normalizePersonaContextRequirements(persona.contextRequirements) }
            : {}),
        ...(persona.preferredLifetime && LIFETIMES.has(persona.preferredLifetime)
            ? { preferredLifetime: persona.preferredLifetime }
            : {}),
        extensions: Array.isArray(persona.extensions)
            ? persona.extensions.filter((extension): extension is string => typeof extension === "string")
            : [],
        skills: Array.isArray(persona.skills)
            ? persona.skills.filter((skill): skill is string => typeof skill === "string")
            : [],
        ...(persona.model ? { model: persona.model } : {}),
        ...(persona.thinking ? { thinking: persona.thinking } : {}),
        filePath: persona.filePath,
    };
}

function cloneStoredSubagent(stored: StoredPersistentSubagent): StoredPersistentSubagent {
    return {
        ...stored,
        persona: clonePersona(stored.persona),
        selectedSkillPaths: [...stored.selectedSkillPaths],
        ...(stored.activeBlocker ? { activeBlocker: { ...stored.activeBlocker } } : {}),
        scopedModels: stored.scopedModels.map((model) => ({ ...model })),
    };
}

function storedFingerprint(stored: StoredPersistentSubagent): string {
    return JSON.stringify(cloneStoredSubagent(stored));
}

function parseStoredSubagent(value: unknown): StoredPersistentSubagent | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.id !== "string" || typeof value.name !== "string") return undefined;
    if (value.mode !== "fresh" && value.mode !== "fork") return undefined;
    if (typeof value.sessionDir !== "string" || typeof value.cwd !== "string") return undefined;
    if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking as SubagentThinkingLevel)) return undefined;
    if (!Array.isArray(value.scopedModels)) return undefined;
    if (typeof value.createdAt !== "number" || typeof value.lastActiveAt !== "number") return undefined;

    const persona = isRecord(value.persona) && typeof value.persona.name === "string"
        && typeof value.persona.description === "string" && typeof value.persona.systemPrompt === "string"
        && typeof value.persona.filePath === "string"
        ? value.persona as unknown as SubagentPersona
        : undefined;

    const purpose = normalizeSubagentPurpose(
        typeof value.purpose === "string" && value.purpose.trim()
            ? value.purpose
            : persona?.description ?? `Existing subagent ${value.name}; purpose was not recorded`,
    );
    const activeBlocker = parseStoredSubagentBlocker(value.activeBlocker);

    return {
        id: value.id,
        name: value.name,
        purpose,
        ...(persona ? { persona: clonePersona(persona) } : {}),
        selectedSkillPaths: Array.isArray(value.selectedSkillPaths)
            ? [...new Set(value.selectedSkillPaths.filter((skill): skill is string => typeof skill === "string"))]
            : [],
        lifetime: typeof value.lifetime === "string" && LIFETIMES.has(value.lifetime as SubagentLifetime)
            ? value.lifetime as SubagentLifetime
            : "persistent",
        mode: value.mode,
        ...(typeof value.parentSessionFile === "string" ? { parentSessionFile: value.parentSessionFile } : {}),
        ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
        sessionDir: value.sessionDir,
        cwd: value.cwd,
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
        createdAt: value.createdAt,
        lastActiveAt: value.lastActiveAt,
        ...(value.parentContextProvided === true ? { parentContextProvided: true } : {}),
        ...(activeBlocker ? { activeBlocker } : {}),
        ...(value.stopped === true ? { stopped: true } : {}),
    };
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
            const parsed = parseStoredSubagent(subagent);
            return parsed ? [parsed] : [];
        }),
    };
}

function parseRegistryMutation(value: unknown): RegistryMutation | undefined {
    if (!isRecord(value)
        || value.version !== REGISTRY_VERSION
        || typeof value.ownerSessionId !== "string"
        || !Array.isArray(value.upserts)
        || !Array.isArray(value.removedIds)) return undefined;
    return {
        version: REGISTRY_VERSION,
        ownerSessionId: value.ownerSessionId,
        upserts: value.upserts.flatMap((subagent) => {
            const parsed = parseStoredSubagent(subagent);
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
    private ownerSessionId: string | undefined;
    private readonly persistedFingerprints = new Map<string, string>();
    private deferredPersistenceDepth = 0;
    private deferredMutation: RegistryMutation | undefined;
    private shuttingDown = false;

    constructor(pi: ExtensionAPI) {
        this.pi = pi;
    }

    restore(ctx: ExtensionContext): void {
        this.ownerSessionId = ctx.sessionManager.getSessionId();
        this.shuttingDown = false;
        this.deferredPersistenceDepth = 0;
        this.deferredMutation = undefined;
        this.records.clear();
        this.persistedFingerprints.clear();

        const restored = new Map<string, StoredPersistentSubagent>();
        const applyMutation = (mutation: RegistryMutation | undefined) => {
            if (!mutation || mutation.ownerSessionId !== this.ownerSessionId) return;
            for (const id of mutation.removedIds) restored.delete(id);
            for (const stored of mutation.upserts) restored.set(stored.id, stored);
        };
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === REGISTRY_ENTRY_TYPE) {
                const snapshot = parseLegacySnapshot(entry.data);
                if (snapshot?.ownerSessionId === this.ownerSessionId) {
                    restored.clear();
                    for (const stored of snapshot.subagents) restored.set(stored.id, stored);
                    continue;
                }
                applyMutation(parseRegistryMutation(entry.data));
                continue;
            }
            if (entry.type === "message" && entry.message.role === "toolResult") {
                const details = isRecord(entry.message.details) ? entry.message.details : undefined;
                applyMutation(parseRegistryMutation(details?.[SUBAGENT_REGISTRY_TOOL_DETAILS_KEY]));
            }
        }

        for (const stored of restored.values()) {
            const persistedFingerprint = storedFingerprint(stored);
            if (stored.stopped) stored.activeBlocker = undefined;
            else if (stored.activeBlocker && stored.lifetime === "one-shot") stored.lifetime = "task";
            this.records.set(stored.id, { stored });
            this.persistedFingerprints.set(stored.id, persistedFingerprint);
        }
        this.pruneStoppedRecords();
        this.persist();
    }

    validateCreate(ctx: ExtensionContext, options: CreatePersistentSubagentOptions): void {
        this.ensureOwner(ctx);
        const name = options.name?.trim() || this.nextName(options.persona?.name ?? "subagent");
        if (name.length > 64 || !SUBAGENT_NAME_PATTERN.test(name)) {
            throw new Error(`Invalid subagent name "${name}"; use at most 64 lowercase letters, digits, and internal hyphens`);
        }
        if ([...this.records.values()].some((record) => record.stored.name === name)) {
            throw new Error(`A subagent named "${name}" already exists`);
        }
        const activeCount = [...this.records.values()].filter((record) => !record.stored.stopped).length;
        if (activeCount >= MAX_PERSISTENT_SUBAGENTS) {
            throw new Error(`Subagent limit reached (${MAX_PERSISTENT_SUBAGENTS}). List and reuse a matching purpose, or stop one before creating another`);
        }
        if (options.mode === "fork") {
            const parentSessionFile = options.parentSessionFile ?? ctx.sessionManager.getSessionFile();
            if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
                throw new Error("Cannot fork a parent session that has not been persisted yet");
            }
        }
    }

    create(ctx: ExtensionContext, options: CreatePersistentSubagentOptions): PersistentSubagentSummary {
        this.validateCreate(ctx, options);
        const name = options.name?.trim() || this.nextName(options.persona?.name ?? "subagent");
        const parentSessionFile = options.mode === "fork"
            ? options.parentSessionFile ?? ctx.sessionManager.getSessionFile() ?? undefined
            : undefined;

        const id = `sa_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        const sessionDir = this.sessionDir(ctx);
        fs.mkdirSync(sessionDir, { recursive: true });
        const now = Date.now();
        const stored: StoredPersistentSubagent = {
            id,
            name,
            purpose: normalizeSubagentPurpose(options.purpose),
            ...(options.persona ? { persona: clonePersona(options.persona) } : {}),
            selectedSkillPaths: [...new Set(options.skills ?? [])],
            lifetime: options.lifetime ?? "persistent",
            mode: options.mode,
            ...(parentSessionFile ? { parentSessionFile } : {}),
            sessionDir,
            cwd: ctx.cwd,
            ...(options.persona?.model
                ? { model: options.persona.model }
                : options.model
                    ? { model: options.model }
                    : ctx.model
                        ? { model: `${ctx.model.provider}/${ctx.model.id}` }
                        : {}),
            thinking: options.persona?.thinking ?? options.thinking ?? this.pi.getThinkingLevel() as SubagentThinkingLevel,
            scopedModels: ctx.scopedModels.map(({ model, thinkingLevel }) => ({
                provider: model.provider,
                id: model.id,
                ...(thinkingLevel ? { thinkingLevel: thinkingLevel as SubagentThinkingLevel } : {}),
            })),
            createdAt: now,
            lastActiveAt: now,
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
        if (record.stored.stopped) throw new Error(`Subagent ${record.stored.name} has been stopped`);
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
        try {
            const controller = this.ensureController(ctx, record);
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
            this.persist();
            return { summary: this.summary(record), ...result };
        } finally {
            if (contextFingerprint) record.contextPromptFingerprints?.delete(contextFingerprint);
            unsubscribe?.();
        }
    }

    async open(
        ctx: ExtensionContext,
        target: string,
        initialPrompt = "",
    ): Promise<{ action: "return"; text: string } | { action: "cancel" } | undefined> {
        const record = this.resolve(target);
        if (record.stored.stopped) throw new Error(`Subagent ${record.stored.name} has been stopped`);
        const controller = this.ensureController(ctx, record);
        const persona = record.stored.persona ? ` · ${record.stored.persona.name}` : "";
        const result = await runSubagentDialog(ctx, controller, `Subagent · ${record.stored.name}${persona}`, initialPrompt);
        record.stored.lastActiveAt = Date.now();
        this.captureRuntimeState(record);
        this.persist();
        return result;
    }

    async setLifetime(
        target: string,
        lifetime: SubagentLifetime,
    ): Promise<PersistentSubagentSummary> {
        const record = this.resolve(target);
        if (record.stored.stopped) throw new Error(`Subagent ${record.stored.name} has been stopped`);
        const previous = record.stored.lifetime;
        record.stored.lifetime = lifetime;
        record.stored.lastActiveAt = Date.now();

        // Lifetime guidance is part of the subagent system prompt. Restart an idle
        // promoted subagent so its next request cannot keep one-shot instructions.
        if (previous !== lifetime && record.controller) {
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
    }

    async stop(target: string): Promise<PersistentSubagentSummary> {
        const record = this.resolve(target);
        record.unsubscribe?.();
        record.unsubscribe = undefined;
        if (record.controller) {
            await record.controller.stop();
            this.captureRuntimeState(record);
            record.controller = undefined;
        }
        record.promptAttributions = undefined;
        record.stored.activeBlocker = undefined;
        record.stored.stopped = true;
        record.stored.lastActiveAt = Date.now();
        const summary = this.summary(record);
        this.pruneStoppedRecords();
        this.persist();
        return summary;
    }

    summaryFor(target: string): PersistentSubagentSummary {
        return this.summary(this.resolve(target));
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        const stops: Promise<void>[] = [];
        for (const record of this.records.values()) {
            record.unsubscribe?.();
            record.unsubscribe = undefined;
            if (record.controller) stops.push(record.controller.stop());
        }
        await Promise.allSettled(stops);
        this.records.clear();
    }

    private ensureController(ctx: ExtensionContext, record: RuntimePersistentSubagent): SubagentSessionController {
        if (record.controller) {
            const state = record.controller.state;
            if (state.connected || state.phase === "Starting subagent Pi…") return record.controller;
            record.unsubscribe?.();
            record.unsubscribe = undefined;
            record.controller = undefined;
        }
        const stored = record.stored;
        const sessionFile = stored.sessionFile && fs.existsSync(stored.sessionFile)
            ? stored.sessionFile
            : undefined;
        if (stored.sessionFile && !sessionFile) stored.sessionFile = undefined;
        const args = buildSubagentProcessArgs({
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
        });
        const promptAttributions = record.promptAttributions ?? this.readPromptAttributions(stored);
        record.promptAttributions = promptAttributions;
        const controller = new SubagentSessionController(ctx, {
            args,
            cwd: stored.cwd,
            mode: stored.mode,
            persona: stored.persona,
            initialPrompt: "",
            scopedModels: stored.scopedModels,
            promptAttributions,
            onPromptAccepted: (attribution) => {
                promptAttributions.push({ ...attribution });
                this.writePromptAttributions(stored, promptAttributions);
            },
            onPromptDelivered: (fingerprint) => {
                if (!record.contextPromptFingerprints?.delete(fingerprint)) return;
                stored.parentContextProvided = true;
                this.persist();
            },
        });
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
        if (typeof revision === "number") {
            if (record.observedSettlementRevision === revision) return;
            record.observedSettlementRevision = revision;
        }
        this.updateBlocker(record, response);
    }

    private updateBlocker(record: RuntimePersistentSubagent, response: string): void {
        record.stored.activeBlocker = parseSubagentBlockerResponse(response);
    }

    private captureRuntimeState(record: RuntimePersistentSubagent): boolean {
        const state = record.controller?.state;
        if (!state) return false;
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
        const state = record.controller?.state;
        let status: PersistentSubagentStatus;
        if (record.stored.stopped) status = "stopped";
        else if (state?.connected && state.busy) status = "running";
        else if (state?.phase === "Starting subagent Pi…") status = "starting";
        else if (record.stored.activeBlocker) status = "blocked";
        else if (!record.controller) status = "dormant";
        else if (state?.connected) status = "idle";
        else status = "error";
        const model = state?.model
            ? `${state.model.provider}/${state.model.id}`
            : record.stored.model;
        return {
            id: record.stored.id,
            name: record.stored.name,
            purpose: record.stored.purpose,
            ...(record.stored.persona ? { persona: record.stored.persona.name } : {}),
            lifetime: record.stored.lifetime,
            ...(record.stored.activeBlocker ? { blocker: { ...record.stored.activeBlocker } } : {}),
            status,
            ...(model ? { model } : {}),
            thinking: state?.connected ? state.thinking : record.stored.thinking,
            ...(record.stored.sessionFile ? { sessionFile: record.stored.sessionFile } : {}),
            createdAt: record.stored.createdAt,
            lastActiveAt: record.stored.lastActiveAt,
        };
    }

    private promptAttributionPath(stored: StoredPersistentSubagent): string {
        return path.join(stored.sessionDir, `${stored.id}-prompt-attributions.json`);
    }

    private readPromptAttributions(stored: StoredPersistentSubagent): SubagentPromptAttribution[] {
        try {
            const value = JSON.parse(fs.readFileSync(this.promptAttributionPath(stored), "utf8")) as unknown;
            return parsePromptAttributions(value);
        } catch {
            return [];
        }
    }

    private writePromptAttributions(
        stored: StoredPersistentSubagent,
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

    private pruneStoppedRecords(): void {
        const stopped = [...this.records.values()]
            .filter((record) => record.stored.stopped)
            .reverse()
            .sort((left, right) => right.stored.lastActiveAt - left.stored.lastActiveAt);
        for (const record of stopped.slice(MAX_RETAINED_STOPPED_SUBAGENTS)) {
            this.records.delete(record.stored.id);
        }
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

    private currentMutation(): RegistryMutation | undefined {
        if (!this.ownerSessionId) return undefined;
        const upserts: StoredPersistentSubagent[] = [];
        const currentFingerprints = new Map<string, string>();
        for (const { stored } of this.records.values()) {
            const fingerprint = storedFingerprint(stored);
            currentFingerprints.set(stored.id, fingerprint);
            if (this.persistedFingerprints.get(stored.id) !== fingerprint) {
                upserts.push(cloneStoredSubagent(stored));
            }
        }
        const removedIds = [...this.persistedFingerprints.keys()].filter((id) => !currentFingerprints.has(id));
        if (upserts.length === 0 && removedIds.length === 0) return undefined;
        return {
            version: REGISTRY_VERSION,
            ownerSessionId: this.ownerSessionId,
            upserts,
            removedIds,
        };
    }

    private markPersisted(): void {
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
    return `${summary.name} (${summary.id}) · ${summary.status} · ${summary.lifetime} · purpose: ${summary.purpose}${persona}${model}${blocker}`;
}

export function registryErrorMessage(error: unknown): string {
    return errorMessage(error);
}
