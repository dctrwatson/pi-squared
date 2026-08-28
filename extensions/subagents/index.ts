/**
 * Persistent Pi subagents.
 *
 * Personas are reusable templates. Each subagent instance owns an isolated,
 * persisted Pi RPC session that the parent model and user can both revisit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    parseFrontmatter,
    truncateHead,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { registerArgumentCommand } from "../support/command-support.ts";
import type { ToolFailureDetails } from "../codex-tools/tool-result.ts";
import type { SubagentBackendFactory, SubagentUsage } from "./backend.ts";
import {
    BUNDLED_PERSONA_DIRECTORY,
    getSubagentCommandArgumentCompletions,
    loadSubagentPersonas,
    loadSubagentPersonasFromDirectories,
    parseSubagentCommandArgs,
    SUBAGENT_COMMAND_HELP_TEXT,
    SUBAGENT_LIFETIMES,
    SUBAGENT_PROFILES,
    type SubagentPersona,
    type SubagentLifetime,
    type SubagentProfile,
} from "./personas.ts";
import {
    formatSubagentSummary,
    MAX_CONCURRENT_SUBAGENTS,
    MAX_RETAINED_SUBAGENTS,
    normalizeSubagentPurpose,
    PersistentSubagentRegistry,
    registryErrorMessage,
    CURSOR_DELIVERY_RECEIPT_VERSION,
    SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY,
    SUBAGENT_REGISTRY_TOOL_DETAILS_KEY,
    SubagentCursorPromptFailure,
    type CursorSubagentLifecyclePort,
    type CursorDeliveryReceipt,
    type PersistentSubagentSummary,
} from "./registry.ts";

export {
    BUNDLED_PERSONA_DIRECTORY,
    buildSubagentProcessArgs,
    formatSubagentModelScope,
    formatSubagentContinuityPrompt,
    getSubagentCommandArgumentCompletions,
    loadSubagentPersonas,
    loadSubagentPersonasFromDirectories,
    parseSubagentCommandArgs,
    SUBAGENT_COMMAND_HELP_TEXT,
    SUBAGENT_EXTENSION_PATHS,
    type CursorPersonaRepository,
    type SubagentContextMode,
    type SubagentPersona,
    type SubagentPersonaDiscovery,
    type SubagentProcessOptions,
    type SubagentScopedModel,
    SUBAGENT_LIFETIMES,
    type SubagentThinkingLevel,
    type SubagentLifetime,
} from "./personas.ts";
export {
    parseSubagentBlockerResponse,
    type ActiveSubagentBlocker,
    type ParsedSubagentBlocker,
} from "./blockers.ts";
export { getPiInvocation } from "./rpc.ts";
export {
    SubagentBackendError,
    type SubagentBackend,
    type SubagentBackendCapabilities,
    type SubagentBackendErrorCode,
    type SubagentBackendEvent,
    type SubagentBackendFactory,
    type SubagentBackendState,
    type SubagentModel,
    type SubagentPromptRequestResult,
    type SubagentRun,
    type SubagentRunCompletion,
    type SubagentRuntime,
} from "./backend.ts";
export { getSubagentPanelWidths } from "./ui.ts";
export {
    CursorCloudBackend,
    createCursorSubagentLifecyclePort,
    type CursorCloudBackendConfiguration,
} from "./cursor-backend.ts";
export { createSubagentBackend } from "./backend-factory.ts";
export {
    CursorSdkGateway,
    loadCursorSdkPort,
    mapCursorSdkError,
    requireCursorApiKey,
    type CursorSdkGatewayOptions,
    type CursorSdkLoader,
    type CursorSdkPort,
    type CursorSdkAgent,
    type CursorSdkRun,
} from "./cursor-sdk.ts";
export {
    buildCursorRepositoryList,
    CursorConnectedRepositoryLookup,
    detectCursorPrimaryRepository,
    normalizeCursorGitHubUrl,
    normalizeCursorStartingRef,
    systemGitCommandPort,
    type CursorPrimaryRepository,
    type CursorRepository,
    type GitCommandPort,
    type GitCommandResult,
} from "./cursor-repositories.ts";
export {
    CURSOR_PROFILE_TARGETS,
    CursorModelCatalog,
    normalizeCursorModelCatalog,
    persistableCursorModelSelection,
    type CursorCatalogModel,
    type CursorCatalogParameter,
    type CursorCatalogVariant,
    type CursorExecutionProfile,
    type CursorModelCatalogClient,
    type CursorModelParameterSelection,
    type CursorPanelModel,
    type CursorResolvedModel,
    type PersistedCursorModelSelection,
} from "./cursor-models.ts";
export {
    buildCursorCloudBootstrap,
    buildCursorCloudFollowUp,
    createCursorForkHandoff,
    createCursorForkHandoffFromSession,
    createCursorForkHandoffWithPiSummary,
    createPiCursorForkSummaryGenerator,
    omitCursorRepositorySource,
    persistableCursorForkHandoff,
    prepareCursorForkSummarySource,
    redactCursorHandoffCredentials,
    type CursorBootstrapOptions,
    type CursorBranchSummaryPrimitive,
    type CursorForkHandoff,
    type CursorForkHandoffMetadata,
    type CursorForkParentSession,
    type CursorForkSummaryGenerator,
    type CursorPiForkContext,
    type CursorPiForkSummaryGeneratorOptions,
    type PersistedCursorForkHandoff,
} from "./cursor-context.ts";
export {
    createActiveTurnForkSnapshot,
    selectForkSnapshotEntries,
    type FreshForkFallback,
    type ModelForkContext,
    type ParentForkSnapshot,
} from "./fork.ts";
export {
    formatSubagentSummary,
    MAX_CONCURRENT_SUBAGENTS,
    MAX_PERSISTENT_SUBAGENTS,
    MAX_RETAINED_SUBAGENTS,
    MAX_RETAINED_STOPPED_SUBAGENTS,
    CURSOR_DELIVERY_RECEIPT_VERSION,
    SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY,
    SUBAGENT_REGISTRY_TOOL_DETAILS_KEY,
    SUBAGENT_REGISTRY_VERSION,
    PersistentSubagentRegistry,
    SubagentCursorPromptFailure,
    type CursorSubagentLifecyclePort,
    type CursorSubagentReconciliation,
    type CursorSubagentStopOutcome,
    type CursorSubagentStopProgress,
    type StoredCursorSubagent,
    type StoredPiSubagent,
    type StoredSubagent,
    type PersistentSubagentStatus,
    type PersistentSubagentSummary,
    type SubagentRuntimeMetadata,
    type CursorRemoteMetadata,
    type CursorDeliveryReceipt,
} from "./registry.ts";

const MAX_PARENT_CONTEXT_CHARS = 8_000;
export const MAX_SUBAGENT_RESPONSE_BYTES = 16 * 1_024;
export const MAX_SUBAGENT_RESPONSE_LINES = 400;
const MAX_SUBAGENT_ERROR_BYTES = 2_000;
export const SUBAGENT_EXECUTION_PROFILES = {
    fast: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
    balanced: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
    deep: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
} as const;

export function resolveSubagentCreationProfile(
    persona: SubagentPersona | undefined,
    requestedProfile: SubagentProfile | undefined,
): SubagentProfile {
    return requestedProfile ?? persona?.preferredProfile ?? "balanced";
}

type SubagentErrorCode = "INVALID_INPUT" | "CANCELLED" | "SUBAGENT_FAILED";

const SubagentParameters = Type.Object({
    action: StringEnum(["create", "list", "prompt", "status", "stop"] as const),
    id: Type.Optional(Type.String({ maxLength: 64, description: "Subagent name or ID for prompt, status, or stop" })),
    name: Type.Optional(Type.String({ maxLength: 64, description: "New subagent name" })),
    purpose: Type.Optional(Type.String({ maxLength: 240, description: "Task domain" })),
    persona: Type.Optional(Type.String({
        maxLength: 64,
        description: "Required for Pi; optional for Cursor Cloud",
    })),
    profile: Type.Optional(StringEnum(SUBAGENT_PROFILES, {
        description: "fast=Luna; balanced=Terra default; deep=Sol escalation",
    })),
    runtime: Type.Optional(StringEnum(["pi", "cursor-cloud"] as const, {
        description: "Pi default; persona-less requires explicit Cursor Cloud",
    })),
    lifetime: Type.Optional(StringEnum(SUBAGENT_LIFETIMES, {
        description: "Create lifetime; task default; one-shot needs prompt",
    })),
    mode: Type.Optional(StringEnum(["fresh", "fork"] as const, {
        description: "Fresh default; fork parent history",
    })),
    skills: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), {
        maxItems: 20,
        description: "Exact parent skill names",
    })),
    prompt: Type.Optional(Type.String({ description: "Initial or follow-up prompt" })),
    context: Type.Optional(Type.String({
        maxLength: MAX_PARENT_CONTEXT_CHARS,
        description: "Concise background",
    })),
    kind: Type.Optional(StringEnum(["subagents", "personas"] as const, {
        description: "List target; default: subagents",
    })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Persona-list offset" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Persona-list count; default: 20" })),
});

type SubagentToolInput = Static<typeof SubagentParameters>;

function prepareSubagentArguments(rawInput: unknown): SubagentToolInput {
    if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
        return { action: "list", context: "invalid input" };
    }
    const prepared = { ...rawInput } as Record<string, unknown>;
    const stringFields = ["id", "name", "purpose", "persona", "prompt", "context"] as const;
    const invalidString = stringFields.some((field) => prepared[field] !== undefined && typeof prepared[field] !== "string");
    const maximumLengths = { id: 64, name: 64, purpose: 240, persona: 64, context: MAX_PARENT_CONTEXT_CHARS } as const;
    const invalidLength = Object.entries(maximumLengths).some(([field, maximum]) => (
        typeof prepared[field] === "string" && prepared[field].length > maximum
    ));
    const invalidAction = !["create", "list", "prompt", "status", "stop"].includes(prepared.action as string);
    const invalidProfile = prepared.profile !== undefined && !["fast", "balanced", "deep"].includes(prepared.profile as string);
    const invalidRuntime = prepared.runtime !== undefined && !["pi", "cursor-cloud"].includes(prepared.runtime as string);
    const invalidLifetime = prepared.lifetime !== undefined && !SUBAGENT_LIFETIMES.includes(prepared.lifetime as SubagentLifetime);
    const invalidMode = prepared.mode !== undefined && !["fresh", "fork"].includes(prepared.mode as string);
    const invalidSkills = prepared.skills !== undefined && (!Array.isArray(prepared.skills)
        || prepared.skills.length > 20
        || prepared.skills.some((skill) => typeof skill !== "string" || skill.length > 64));
    const invalidKind = prepared.kind !== undefined && !["subagents", "personas"].includes(prepared.kind as string);
    const invalidOffset = prepared.offset !== undefined && (!Number.isInteger(prepared.offset) || (prepared.offset as number) < 0 || (prepared.offset as number) > 10_000);
    const invalidLimit = prepared.limit !== undefined && (!Number.isInteger(prepared.limit) || (prepared.limit as number) < 1 || (prepared.limit as number) > 50);
    if (invalidString || invalidLength || invalidAction || invalidProfile || invalidRuntime || invalidLifetime || invalidMode || invalidSkills || invalidKind || invalidOffset || invalidLimit) {
        return { action: "list", context: "invalid input" };
    }
    return prepared as SubagentToolInput;
}

function subagentFailure(error: unknown, signal: AbortSignal | undefined): {
    content: [{ type: "text"; text: string }];
    details: ToolFailureDetails<"subagent", SubagentErrorCode>;
} {
    const message = error instanceof Error ? error.message : String(error);
    const code: SubagentErrorCode = signal?.aborted
        ? "CANCELLED"
        : /(^context |^profile |^runtime |^lifetime |^mode |^skills? |^offset |^persona |^purpose |^one-shot |^id |^prompt |^No subagent personas|^Unknown subagent (?:persona|skill)|^Ambiguous subagent skill|^Selected skill|^Persona-less|is not valid|requires an accompanying)/.test(message)
            ? "INVALID_INPUT"
            : "SUBAGENT_FAILED";
    const bounded = Buffer.byteLength(message) <= MAX_SUBAGENT_ERROR_BYTES
        ? message
        : `${utf8Prefix(message, MAX_SUBAGENT_ERROR_BYTES - 3)}...`;
    const display = bounded.replace(/[\u0000-\u001f\u007f-\u009f\[\]]/g, (character) => {
        if (character === "\n") return "\\n";
        if (character === "\r") return "\\r";
        if (character === "\t") return "\\t";
        if (character === "[") return "\\[";
        if (character === "]") return "\\]";
        return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
    });
    const prefix = `[subagent error: ${code}; `;
    const displayBytes = MAX_SUBAGENT_ERROR_BYTES - Buffer.byteLength(prefix, "utf8") - 1;
    const safeDisplay = Buffer.byteLength(display, "utf8") <= displayBytes
        ? display
        : `${utf8Prefix(display, displayBytes - 3)}...`;
    return {
        content: [{ type: "text", text: `${prefix}${safeDisplay}]` }],
        details: { ok: false, tool: "subagent", error: { code, message: bounded } },
    };
}

function personaByName(personas: readonly SubagentPersona[], name: string | undefined): SubagentPersona {
    if (personas.length === 0) {
        throw new Error("No subagent personas are configured; create requires an existing persona");
    }
    const requested = name?.trim();
    if (!requested) {
        throw new Error('persona is required for create; list personas with action "list" and kind "personas"');
    }
    const persona = personas.find((candidate) => candidate.name === requested);
    if (persona) return persona;
    throw new Error(`Unknown subagent persona "${requested}"; list personas with action "list" and kind "personas"`);
}

export interface ParentDiscoveredSkill {
    name: string;
    filePath: string;
}

interface SkillFrontmatter extends Record<string, unknown> {
    name?: unknown;
}

function declaredSkillName(filePath: string): string | undefined {
    try {
        const { frontmatter } = parseFrontmatter<SkillFrontmatter>(fs.readFileSync(filePath, "utf8"));
        return typeof frontmatter.name === "string" && frontmatter.name.trim()
            ? frontmatter.name.trim()
            : undefined;
    } catch {
        return undefined;
    }
}

function canonicalPath(filePath: string): string {
    try {
        return fs.realpathSync.native(filePath);
    } catch {
        return path.resolve(filePath);
    }
}

export function validateSelectedPersonaSkills(
    persona: SubagentPersona | undefined,
    requestedNames: readonly string[] | undefined,
    discoveredSkills: readonly ParentDiscoveredSkill[],
): void {
    if (!persona || !requestedNames?.length) return;

    const selectedByName = new Map(
        discoveredSkills
            .filter((skill) => requestedNames.includes(skill.name))
            .map((skill) => [skill.name, canonicalPath(skill.filePath)]),
    );
    for (const personaSkillPath of persona.skills) {
        const name = declaredSkillName(personaSkillPath);
        const selectedPath = name ? selectedByName.get(name) : undefined;
        if (!name || !selectedPath || selectedPath === canonicalPath(personaSkillPath)) continue;
        throw new Error(
            `Selected skill "${name}" conflicts with persona "${persona.name}", which declares the same skill name from a different path; omit the selected skill or use a different persona`,
        );
    }
}

export function resolveSelectedSubagentSkills(
    requestedNames: readonly string[] | undefined,
    discoveredSkills: readonly ParentDiscoveredSkill[],
): string[] {
    const resolved: string[] = [];
    const names = new Set<string>();
    for (const name of requestedNames ?? []) {
        if (names.has(name)) continue;
        names.add(name);
        const matches = discoveredSkills.filter((skill) => skill.name === name);
        if (matches.length === 0) {
            throw new Error(`Unknown subagent skill "${name}"; use an exact parent skill name`);
        }
        if (matches.length > 1) {
            throw new Error(`Ambiguous subagent skill "${name}"; use a unique exact parent skill name`);
        }
        const filePath = matches[0]!.filePath;
        if (!resolved.includes(filePath)) resolved.push(filePath);
    }
    return resolved;
}

function validatePersonaLessModelCreate(params: SubagentToolInput): void {
    if (params.runtime !== "cursor-cloud") {
        throw new Error('Persona-less Pi create is not valid; use persona "worker" for general execution work');
    }
    if (!params.purpose?.trim()) {
        throw new Error("Persona-less Cursor Cloud create requires an explicit purpose");
    }
}

function utf8Prefix(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && bytes[end] !== undefined && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
}

function boundedText(text: string, truncationNotice: string): string {
    const maxBytes = MAX_SUBAGENT_RESPONSE_BYTES;
    const maxLines = MAX_SUBAGENT_RESPONSE_LINES;
    const truncated = truncateHead(text, { maxBytes, maxLines });
    if (!truncated.truncated) return truncated.content;

    const suffix = `\n\n[${truncationNotice}]`;
    const contentBytes = Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf8"));
    const bounded = truncateHead(text, {
        maxBytes: contentBytes,
        maxLines: Math.max(1, maxLines - 2),
    });
    const content = bounded.firstLineExceedsLimit
        ? utf8Prefix(text, contentBytes)
        : bounded.content;
    return `${content}${suffix}`;
}

function responseTruncationNotice(name: string): string {
    return `Response truncated. Full response retained by ${name}; use action "prompt" to request a numbered section or continuation.`;
}

function responseWouldTruncate(text: string): boolean {
    return truncateHead(text, {
        maxBytes: MAX_SUBAGENT_RESPONSE_BYTES,
        maxLines: MAX_SUBAGENT_RESPONSE_LINES,
    }).truncated;
}

export function boundedSubagentResponse(text: string, name: string): string {
    return boundedText(text.trim() || "(no visible response)", responseTruncationNotice(name));
}

function requireText(value: string | undefined, field: string): string {
    const text = value?.trim();
    if (!text) throw new Error(`${field} is required`);
    return text;
}

function parentContext(value: string | undefined): string | undefined {
    const context = value?.trim();
    if (!context) return undefined;
    if (context.length > MAX_PARENT_CONTEXT_CHARS) {
        throw new Error(`context exceeds ${MAX_PARENT_CONTEXT_CHARS} characters`);
    }
    return context;
}

export function formatSubagentRequest(prompt: string, context?: string): string {
    const request = prompt.trim();
    const background = context?.trim();
    if (!background) return request;
    return `## Parent-provided context\n\n${background}\n\n## Request\n\n${request}`;
}

function requiredContextError(persona: SubagentPersona): Error {
    return new Error(
        `${persona.name} requires context before its first parent prompt: ${persona.contextRequirements}. Retry with context.`,
    );
}

function formatSubagentStopResult(summary: PersistentSubagentSummary): string {
    switch (summary.status) {
        case "stopped":
            return `Stopped ${summary.name}.`;
        case "archive-pending":
            return `Cancellation was confirmed for ${summary.name}, but archival is pending. Retry action "stop".`;
        case "remote-state-unknown":
            return `Stop for ${summary.name} is not confirmed because remote state is unknown. Use action "status", then retry action "stop".`;
        case "stopping":
            return `Stopping ${summary.name}. Use action "status" to confirm completion.`;
        default:
            return `Stop for ${summary.name} is not complete (${summary.status}). Use action "status", then retry action "stop".`;
    }
}

function formatSubagentForModel(summary: PersistentSubagentSummary, includeRuntime = false): string {
    const blocker = summary.blocker
        ? `; blocked: ${summary.blocker.reason}; needs: ${summary.blocker.need}`
        : "";
    const runtime = includeRuntime ? `${summary.runtime}, ` : "";
    return `${summary.name} [${runtime}${summary.status}, ${summary.lifetime}]: ${summary.purpose}${blocker}`;
}

export function formatPersonaForModel(persona: SubagentPersona): string {
    const profilePreference = persona.preferredProfile ? ` [prefers ${persona.preferredProfile} profile]` : "";
    const requirement = persona.contextRequirements
        ? ` [context required: ${persona.contextRequirements}]`
        : "";
    return `${persona.name} [${persona.runtime}]: ${normalizeSubagentPurpose(persona.description)}${profilePreference}${requirement}`;
}

export type SubagentsCommandArgs =
    | { action: "open" | "stop"; target: string }
    | { action: "enable" | "disable"; target: "" }
    | { action: "open"; target: ""; error: string };

const SUBAGENT_ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
    create: new Set(["action", "name", "purpose", "persona", "profile", "runtime", "lifetime", "mode", "skills", "prompt", "context"]),
    list: new Set(["action", "kind", "offset", "limit"]),
    prompt: new Set(["action", "id", "prompt", "context"]),
    status: new Set(["action", "id"]),
    stop: new Set(["action", "id"]),
};

function validateSubagentActionFields(params: Record<string, unknown>): void {
    const action = typeof params.action === "string" ? params.action : "";
    const allowed = SUBAGENT_ACTION_FIELDS[action];
    if (!allowed) return;
    const invalid = Object.entries(params)
        .filter(([key, value]) => value !== undefined && !allowed.has(key))
        .map(([key]) => key);
    if (invalid.length > 0) {
        throw new Error(`${invalid.join(", ")} ${invalid.length === 1 ? "is" : "are"} not valid for subagent action "${action}"`);
    }
}

function deferredRegistryDetails(mutation: unknown): Record<string, unknown> {
    return mutation === undefined ? {} : { [SUBAGENT_REGISTRY_TOOL_DETAILS_KEY]: mutation };
}

/** The Pi tool protocol has no representation for partial usage. Omit it rather
 * than turn unreported Cloud fields into confirmed zero values. */
function completeToolUsage(usage: SubagentUsage): Usage | undefined {
    if (usage.input === undefined || usage.output === undefined || usage.cacheRead === undefined
        || usage.cacheWrite === undefined || usage.totalTokens === undefined
        || usage.cost?.input === undefined || usage.cost.output === undefined
        || usage.cost.cacheRead === undefined || usage.cost.cacheWrite === undefined || usage.cost.total === undefined) return undefined;
    return {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
            total: usage.cost.total,
        },
    };
}

/** Keep reported partial Cloud fields in details without inventing accounting values. */
function partialToolUsage(usage: SubagentUsage): SubagentUsage | undefined {
    const cost = usage.cost;
    const partialCost = cost && (cost.input !== undefined || cost.output !== undefined
        || cost.cacheRead !== undefined || cost.cacheWrite !== undefined || cost.total !== undefined)
        ? {
            ...(cost.input !== undefined ? { input: cost.input } : {}),
            ...(cost.output !== undefined ? { output: cost.output } : {}),
            ...(cost.cacheRead !== undefined ? { cacheRead: cost.cacheRead } : {}),
            ...(cost.cacheWrite !== undefined ? { cacheWrite: cost.cacheWrite } : {}),
            ...(cost.total !== undefined ? { total: cost.total } : {}),
        }
        : undefined;
    const partial = {
        ...(usage.input !== undefined ? { input: usage.input } : {}),
        ...(usage.output !== undefined ? { output: usage.output } : {}),
        ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
        ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(partialCost ? { cost: partialCost } : {}),
    };
    return Object.keys(partial).length > 0 ? partial : undefined;
}

function incompleteResponseReason(result: {
    text: string;
    responseProduced?: boolean;
    handledWithoutAgent?: boolean;
    stopReason?: string;
    truncated?: true;
}): string | undefined {
    if (result.handledWithoutAgent) return "the prompt was handled without an agent response";
    const responseProduced = result.responseProduced ?? Boolean(result.text.trim());
    if (!responseProduced || !result.text.trim()) return "the subagent produced no visible response";
    if (result.truncated) return "the retained completion reached its size limit";
    if (result.stopReason === "length") return "the model reached its output limit";
    if (result.stopReason && result.stopReason !== "stop") {
        return `the model stopped with reason ${result.stopReason}`;
    }
    return undefined;
}

export function parseSubagentsCommandArgs(args: string): SubagentsCommandArgs {
    const trimmed = args.trim();
    if (!trimmed) return { action: "open", target: "" };
    const [first, ...rest] = trimmed.split(/\s+/);
    if (first === "--stop") return { action: "stop", target: rest.join(" ") };
    if (first === "--enable" || first === "--disable") {
        if (rest.length > 0) {
            return { action: "open", target: "", error: `${first} does not accept a target` };
        }
        return { action: first === "--enable" ? "enable" : "disable", target: "" };
    }
    if (first?.startsWith("--")) {
        return { action: "open", target: "", error: `Unknown subagents option: ${first}` };
    }
    return { action: "open", target: trimmed };
}

const SUBAGENTS_HELP_TEXT = `Usage: /subagents [name-or-id]
       /subagents --stop [name-or-id]
       /subagents --enable | --disable

name-or-id: Open an active subagent.
--stop: Stop an active subagent.
--enable, --disable: Enable or disable the model subagent tool.
--help, -h: Show this help.`;
const SUBAGENTS_COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
    { value: "--stop", label: "--stop", description: "Stop an active subagent" },
    { value: "--enable", label: "--enable", description: "Enable the model subagent tool" },
    { value: "--disable", label: "--disable", description: "Disable the model subagent tool" },
];
const MAX_SUBAGENT_COMPLETION_DESCRIPTION_CHARS = 80;

function subagentCompletionDescription(subagent: PersistentSubagentSummary): string {
    const purpose = subagent.purpose.trim();
    if (!purpose) return subagent.status;
    const abbreviatedPurpose = purpose.length <= MAX_SUBAGENT_COMPLETION_DESCRIPTION_CHARS
        ? purpose
        : `${purpose.slice(0, MAX_SUBAGENT_COMPLETION_DESCRIPTION_CHARS - 3)}...`;
    return `${subagent.status}: ${abbreviatedPurpose}`;
}

function subagentTargetCompletions(
    targetPrefix: string,
    valuePrefix: string,
    subagents: readonly PersistentSubagentSummary[],
): AutocompleteItem[] {
    return subagents
        .filter((subagent) => subagent.status !== "stopped")
        .slice(0, MAX_RETAINED_SUBAGENTS)
        .flatMap((subagent) => {
            const target = subagent.name.startsWith(targetPrefix)
                ? subagent.name
                : subagent.id.startsWith(targetPrefix)
                    ? subagent.id
                    : undefined;
            if (!target) return [];
            return [{
                value: `${valuePrefix}${target}`,
                label: target === subagent.name ? subagent.name : `${subagent.name} (${subagent.id})`,
                description: subagentCompletionDescription(subagent),
            }];
        });
}

function getSubagentsArgumentCompletions(
    argumentPrefix: string,
    subagents: readonly PersistentSubagentSummary[],
): AutocompleteItem[] | null {
    const stopMatch = argumentPrefix.match(/^--stop\s+(.*)$/);
    if (stopMatch) {
        const targetPrefix = stopMatch[1] ?? "";
        if (/\s/.test(targetPrefix)) return null;
        const completions = subagentTargetCompletions(targetPrefix, "--stop ", subagents);
        return completions.length > 0 ? completions : null;
    }
    if (/\s/.test(argumentPrefix)) return null;

    const commandCompletions = SUBAGENTS_COMMAND_COMPLETIONS.filter((item) =>
        item.value.startsWith(argumentPrefix));
    const targetCompletions = argumentPrefix.startsWith("--")
        ? []
        : subagentTargetCompletions(argumentPrefix, "", subagents);
    const completions = [...commandCompletions, ...targetCompletions];
    return completions.length > 0 ? completions : null;
}

export interface SubagentExtensionTestSeam {
    /** Replace backend construction for isolated extension integration tests. */
    readonly backendFactory?: SubagentBackendFactory;
    /** Replace Cursor lifecycle transport for isolated extension integration tests. */
    readonly cursorLifecycle?: CursorSubagentLifecyclePort;
}

export default function (
    pi: ExtensionAPI,
    options: { personaDirectory?: string } & SubagentExtensionTestSeam = {},
) {
    const discovery = options.personaDirectory
        ? loadSubagentPersonas(options.personaDirectory)
        : loadSubagentPersonasFromDirectories([
            BUNDLED_PERSONA_DIRECTORY,
            path.join(getAgentDir(), "personas"),
        ]);
    const registry = new PersistentSubagentRegistry(pi, options.backendFactory, options.cursorLifecycle);
    let parentDiscoveredSkills: ParentDiscoveredSkill[] = [];
    let diagnosticsShown = false;
    const runtimeDetailsFor = (summary: PersistentSubagentSummary) => {
        try {
            return registry.runtimeMetadataFor(summary.id);
        } catch {
            // Test seams and older registry implementations can provide only a summary.
            return { kind: summary.runtime };
        }
    };

    const finalizeModelPrompt = async (
        result: Awaited<ReturnType<PersistentSubagentRegistry["prompt"]>>,
        action: "create" | "prompt",
    ) => {
        const policyWarnings = [...new Set(result.policyWarnings ?? [])]
            .map((warning) => warning.trim())
            .filter(Boolean)
            .slice(0, 4);
        const runtimeWarnings = [...new Set(result.runtimeWarnings ?? [])]
            .map((warning) => warning.trim())
            .filter(Boolean)
            .slice(0, 4);
        const warningPrefix = [
            ...(policyWarnings.length ? [`Policy warning: ${policyWarnings.join(" ")}`] : []),
            ...(runtimeWarnings.length ? [`Runtime warning: ${runtimeWarnings.join(" ")}`] : []),
        ].join("\n");
        const visibleResponse = result.text.trim() || "(no visible response)";
        const visible = warningPrefix ? `${warningPrefix}\n\n${visibleResponse}` : visibleResponse;
        const partialUsage = result.summary.runtime === "cursor-cloud"
            ? partialToolUsage(result.usage)
            : undefined;
        const usage = completeToolUsage(result.usage);
        const incomplete = incompleteResponseReason(result);
        const oneShot = result.summary.lifetime === "one-shot" || result.delivery?.archiveAfterDelivery === true;
        const receiptFor = (
            summary: PersistentSubagentSummary,
            archiveAfterDelivery: boolean,
        ): CursorDeliveryReceipt | undefined => result.delivery
            ? {
                version: CURSOR_DELIVERY_RECEIPT_VERSION,
                subagentId: summary.id,
                runId: result.delivery.runId,
                ...(archiveAfterDelivery ? { archiveAfterDelivery: true } : {}),
            }
            : undefined;
        const detailsFor = (summary: PersistentSubagentSummary, receipt?: CursorDeliveryReceipt) => ({
            // Keep runtime and remote identifiers in structured details. Concise
            // parent text contains only the requested result and warnings.
            runtime: runtimeDetailsFor(summary),
            ...(result.artifacts?.length ? { artifacts: result.artifacts } : {}),
            ...(policyWarnings.length ? { policyWarnings } : {}),
            ...(runtimeWarnings.length ? { runtimeWarnings } : {}),
            ...(partialUsage ? { usage: partialUsage } : {}),
            ...(receipt ? { [SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY]: receipt } : {}),
        });
        const retainedResult = async (reason: string) => {
            // Persist this lifetime decision before the ToolResult receipt. If this
            // fails, the durable result remains available for a later delivery attempt.
            const retained = await registry.setLifetime(result.summary.id, "task");
            const text = boundedText(
                `Retained ${retained.name} as a task because ${reason}.\n\n${visible}`,
                responseTruncationNotice(retained.name),
            );
            const receipt = receiptFor(retained, false);
            return {
                content: [{ type: "text" as const, text }],
                details: { ok: true, tool: "subagent", action, subagent: retained, ...detailsFor(retained, receipt) },
                ...(usage ? { usage } : {}),
            };
        };

        if (oneShot && result.summary.blocker) return retainedResult("it is blocked");
        if (oneShot && incomplete) return retainedResult(incomplete);
        const completed = `Completed one-shot ${result.summary.name}.\n\n${visible}`;
        const cursorCompleted = `Completed one-shot ${result.summary.name}. Cursor cleanup starts after this result is recorded.\n\n${visible}`;
        const potentialPiCleanup = `\n\n${formatSubagentStopResult({ ...result.summary, status: "remote-state-unknown" })}`;
        // Decide before delivery or cleanup. Reserve each runtime's complete parent-visible
        // text so a one-shot stays reusable instead of truncating its final result.
        const oneShotVisible = result.summary.runtime === "cursor-cloud"
            ? cursorCompleted
            : `${completed}${potentialPiCleanup}`;
        if (oneShot && responseWouldTruncate(oneShotVisible)) return retainedResult("its response was truncated");

        if (oneShot) {
            if (result.summary.runtime === "cursor-cloud") {
                const receipt = receiptFor(result.summary, true);
                return {
                    content: [{
                        type: "text" as const,
                        text: cursorCompleted,
                    }],
                    details: { ok: true, tool: "subagent", action, subagent: result.summary, ...detailsFor(result.summary, receipt) },
                    ...(usage ? { usage } : {}),
                };
            }
            // Pi has no durable Cursor result. Its existing one-shot cleanup remains
            // local to this completed execution.
            const stopped = await registry.stop(result.summary.id);
            const cleanupNotice = stopped.status === "stopped"
                ? ""
                : `\n\n${formatSubagentStopResult(stopped)}`;
            return {
                content: [{ type: "text" as const, text: `${completed}${cleanupNotice}` }],
                details: { ok: stopped.status === "stopped", tool: "subagent", action, subagent: stopped, ...detailsFor(stopped) },
                ...(usage ? { usage } : {}),
            };
        }

        const response = incomplete
            ? `Incomplete subagent response: ${incomplete}. Reprompt ${result.summary.name} for continuation.\n\n${visible}`
            : visible;
        const text = action === "create"
            ? boundedText(`Saved as ${result.summary.name}.\n\n${response}`, responseTruncationNotice(result.summary.name))
            : boundedSubagentResponse(response, result.summary.name);
        const receipt = receiptFor(result.summary, false);
        return {
            content: [{ type: "text" as const, text }],
            details: { ok: true, tool: "subagent", action, subagent: result.summary, ...detailsFor(result.summary, receipt) },
            ...(usage ? { usage } : {}),
        };
    };

    const stopFailedOneShot = async (summary: PersistentSubagentSummary): Promise<void> => {
        if (summary.lifetime !== "one-shot") return;
        await registry.stop(summary.id).catch(() => undefined);
    };
    const receiptForCursorFailure = (error: unknown): { readonly failure: SubagentCursorPromptFailure; readonly receipt?: CursorDeliveryReceipt } | undefined => {
        if (!(error instanceof SubagentCursorPromptFailure)) return undefined;
        const { delivery } = error;
        return {
            failure: error,
            ...(delivery ? {
                receipt: {
                    version: CURSOR_DELIVERY_RECEIPT_VERSION,
                    subagentId: error.summary.id,
                    runId: delivery.runId,
                    ...(delivery.archiveAfterDelivery ? { archiveAfterDelivery: true } : {}),
                },
            } : {}),
        };
    };

    const showDiagnostics = (ctx: ExtensionContext): void => {
        if (diagnosticsShown || discovery.diagnostics.length === 0) return;
        diagnosticsShown = true;
        for (const diagnostic of discovery.diagnostics) ctx.ui.notify(diagnostic, "warning");
    };

    const handoffPanelReturn = async (
        ctx: ExtensionContext,
        result: { action: "return"; text: string; summary: PersistentSubagentSummary; delivery?: {
            archiveAfterDelivery: boolean;
            completion?: { text: string; responseProduced?: boolean; handledWithoutAgent?: boolean; stopReason?: string; truncated?: true };
            acknowledge(): Promise<{ acknowledged: boolean; archiveAfterDelivery: boolean }>;
        } },
    ): Promise<void> => {
        // Place text in the editor before acknowledgement. A thrown editor handoff
        // leaves the Cursor result durable for a later return attempt.
        ctx.ui.setEditorText(result.text);
        const delivery = result.delivery;
        if (delivery) {
            const completion = delivery.completion
                ? { ...delivery.completion, text: result.text }
                : { text: result.text };
            const incomplete = incompleteResponseReason(completion);
            const retain = delivery.archiveAfterDelivery && (Boolean(result.summary.blocker) || Boolean(incomplete));
            if (retain) await registry.setLifetime(result.summary.id, "task");
            const acknowledgement = await delivery.acknowledge();
            if (acknowledgement.acknowledged && acknowledgement.archiveAfterDelivery && !retain) {
                try {
                    const stopped = await registry.stop(result.summary.id);
                    if (stopped.status !== "stopped") ctx.ui.notify(formatSubagentStopResult(stopped), "warning");
                } catch {
                    ctx.ui.notify(formatSubagentStopResult(registry.summaryFor(result.summary.id)), "warning");
                }
            }
        }
        ctx.ui.notify("Subagent response placed in the parent editor. Review and submit when ready.", "info");
    };

    const createAndOpen = async (
        args: string,
        ctx: ExtensionCommandContext,
        persona?: SubagentPersona,
    ): Promise<void> => {
        if (ctx.mode !== "tui") {
            if (ctx.hasUI) ctx.ui.notify("/subagent requires TUI mode", "error");
            return;
        }
        showDiagnostics(ctx);
        const parsed = parseSubagentCommandArgs(args);
        if (parsed.error) {
            ctx.ui.notify(`${parsed.error}. Usage: /subagent${persona ? `:${persona.name}` : ""} [--fork] [prompt]`, "error");
            return;
        }
        if (parsed.mode === "fork") {
            if (!ctx.isIdle()) {
                ctx.ui.notify("Forked subagents can only be created while the parent agent is idle.", "error");
                return;
            }
            const parentSessionFile = ctx.sessionManager.getSessionFile();
            if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
                ctx.ui.notify("Cannot fork a parent session that has not been persisted yet. Use /subagent without --fork.", "error");
                return;
            }
        }

        try {
            const purpose = parsed.prompt
                || persona?.description
                || (parsed.mode === "fork"
                    ? "Analysis using inherited parent-session context"
                    : "General project research");
            const profileName = persona ? resolveSubagentCreationProfile(persona, undefined) : undefined;
            const profile = profileName ? SUBAGENT_EXECUTION_PROFILES[profileName] : undefined;
            const summary = await registry.create(ctx, {
                mode: parsed.mode,
                purpose,
                persona,
                ...(persona?.runtime === "pi" && profile ? { model: profile.model, thinking: profile.thinking } : {}),
                ...(persona?.runtime === "cursor-cloud" && profileName ? { cursorProfile: profileName } : {}),
            });
            const result = await registry.open(ctx, summary.id, parsed.prompt);
            if (result?.action === "return") await handoffPanelReturn(ctx, result);
        } catch (error) {
            ctx.ui.notify(`Could not create subagent: ${registryErrorMessage(error)}`, "error");
        }
    };

    const manageExisting = async (args: string, ctx: ExtensionContext): Promise<void> => {
        if (ctx.mode !== "tui") {
            if (ctx.hasUI) ctx.ui.notify("/subagents requires TUI mode", "error");
            return;
        }
        showDiagnostics(ctx);
        const parsed = parseSubagentsCommandArgs(args);
        if ("error" in parsed) {
            ctx.ui.notify(`${parsed.error}. Usage: /subagents [--enable|--disable|--stop] [name-or-id]`, "error");
            return;
        }
        try {
            if (parsed.action === "enable" || parsed.action === "disable") {
                const activeTools = pi.getActiveTools();
                const enabled = activeTools.includes("subagent");
                if (parsed.action === "enable" && !enabled) {
                    pi.setActiveTools([...activeTools, "subagent"]);
                } else if (parsed.action === "disable" && enabled) {
                    pi.setActiveTools(activeTools.filter((name) => name !== "subagent"));
                }
                ctx.ui.notify(
                    `Model subagent tool ${parsed.action === "enable" ? "enabled" : "disabled"}.`,
                    "info",
                );
                return;
            }
            let target = parsed.target;
            if (!target) {
                const available = registry.list().filter((subagent) => subagent.status !== "stopped");
                if (available.length === 0) {
                    ctx.ui.notify("No subagents yet. Use /subagent to create one.", "info");
                    return;
                }
                const choices = available.map(formatSubagentSummary);
                const selected = await ctx.ui.select(
                    parsed.action === "stop" ? "Stop subagent" : "Open subagent",
                    choices,
                );
                if (!selected) return;
                const index = choices.indexOf(selected);
                target = available[index]?.id ?? "";
            }
            if (parsed.action === "stop") {
                const summary = registry.summaryFor(target);
                if (summary.status === "stopped") {
                    ctx.ui.notify(`${summary.name} is already stopped.`, "info");
                    return;
                }
                const confirmed = await ctx.ui.confirm(
                    "Stop subagent",
                    `Stop ${summary.name} (${summary.id})? Its session will be retained, but it cannot be prompted again.`,
                );
                if (!confirmed) return;
                const stopped = await registry.stop(summary.id);
                ctx.ui.notify(
                    `${formatSubagentStopResult(stopped)} (${stopped.id})`,
                    stopped.status === "stopped" ? "info" : "warning",
                );
                return;
            }
            const result = await registry.open(ctx, target);
            if (result?.action === "return") await handoffPanelReturn(ctx, result);
        } catch (error) {
            const operation = parsed.action === "stop"
                ? "stop subagent"
                : parsed.action === "enable" || parsed.action === "disable"
                    ? `${parsed.action} model subagent tool`
                    : "open subagent";
            ctx.ui.notify(`Could not ${operation}: ${registryErrorMessage(error)}`, "error");
        }
    };

    registerArgumentCommand(pi, "subagent", {
        description: "Create and open a persistent subagent; add --fork for parent context",
        helpText: SUBAGENT_COMMAND_HELP_TEXT,
        getArgumentCompletions: getSubagentCommandArgumentCompletions,
        handler: async (args, ctx) => createAndOpen(args, ctx),
    });

    for (const persona of discovery.personas) {
        registerArgumentCommand(pi, `subagent:${persona.name}`, {
            description: `${persona.description} (persistent subagent)`,
            helpText: SUBAGENT_COMMAND_HELP_TEXT,
            getArgumentCompletions: getSubagentCommandArgumentCompletions,
            handler: async (args, ctx) => createAndOpen(args, ctx, persona),
        });
    }

    registerArgumentCommand(pi, "subagents", {
        description: "Manage named subagents or toggle model access with --enable/--disable",
        helpText: SUBAGENTS_HELP_TEXT,
        getArgumentCompletions: (argumentPrefix) =>
            getSubagentsArgumentCompletions(argumentPrefix, registry.list()),
        handler: manageExisting,
    });
    pi.registerShortcut("ctrl+shift+a", {
        description: "Show subagents",
        handler: async (ctx) => manageExisting("", ctx),
    });
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: `Retain up to ${MAX_RETAINED_SUBAGENTS}; run up to ${MAX_CONCURRENT_SUBAGENTS} subagents at once. Pi shares local authority; Cursor Cloud inspects pushed repositories with MCPs.`,
        promptSnippet: "Delegate isolated work",
        promptGuidelines: [
            "Before subagent create, list unknown options and provide context. Use worker for general Pi execution; persona-less create is Cursor Cloud only. Keep persona profile defaults; otherwise use balanced, fast for bounded lookup, deep only after cheaper failure or unsafe ambiguity.",
            `Default to task subagents. Use one-shot only when continuity cannot help; use persistent for open-ended work. Run at most ${MAX_CONCURRENT_SUBAGENTS}; idle subagents do not count. Satisfy NEEDS; stop complete subagents.`,
            "Give subagent objective, scope, and output; avoid adjacent work.",
            "Delegate substantive isolated work to subagents; keep only coordination and necessary integration in the parent context.",
            "Prefer fresh context. Fork only when parent history is material. Inspect only enough to partition work by shared context and specialty, then delegate. Avoid duplicate investigation. Reuse subagents for related work. Parallelize only separate contexts or specialties.",
        ],
        parameters: SubagentParameters,
        prepareArguments: prepareSubagentArguments,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            let deferredMutation: unknown;
            let fallbackDetails: Record<string, unknown> = {};
            let fallbackText = "";
            try {
                const context = parentContext(params.context);
            if (context && params.action !== "create" && params.action !== "prompt") {
                throw new Error("context is only valid with create or prompt");
            }
            if (params.profile && params.action !== "create") {
                throw new Error("profile is only valid with create");
            }
            if (params.lifetime && params.action !== "create") {
                throw new Error("lifetime is only valid with create");
            }
            validateSubagentActionFields(params as Record<string, unknown>);
            switch (params.action) {
                case "create": {
                    const hasPersona = Boolean(params.persona?.trim());
                    if (!hasPersona) validatePersonaLessModelCreate(params);
                    const persona = hasPersona ? personaByName(discovery.personas, params.persona) : undefined;
                    const runtime = params.runtime ?? persona?.runtime ?? "pi";
                    if (params.runtime && persona && params.runtime !== persona.runtime) {
                        throw new Error(`runtime "${params.runtime}" does not match persona "${persona.name}" runtime "${persona.runtime}"`);
                    }
                    if (runtime === "cursor-cloud" && params.skills?.length) {
                        throw new Error("skills are not valid for runtime cursor-cloud");
                    }
                    const selectedSkillPaths = resolveSelectedSubagentSkills(params.skills, parentDiscoveredSkills);
                    validateSelectedPersonaSkills(persona, params.skills, parentDiscoveredSkills);
                    const initialPrompt = params.prompt?.trim();
                    const lifetime: SubagentLifetime = params.lifetime ?? "task";
                    if (context && !initialPrompt) throw new Error("context requires an accompanying prompt");
                    if (lifetime === "one-shot" && !initialPrompt) {
                        throw new Error("one-shot subagents require an initial prompt");
                    }
                    const purpose = persona
                        ? params.purpose?.trim() || initialPrompt || persona.description
                        : requireText(params.purpose, "purpose");
                    const normalizedPurpose = normalizeSubagentPurpose(purpose);
                    const reusable = registry.list().find((candidate) =>
                        candidate.runtime === runtime
                        && candidate.status !== "stopped"
                        && candidate.purpose.toLowerCase() === normalizedPurpose.toLowerCase());
                    if (reusable) {
                        throw new Error(
                            `${reusable.name} already retains context for this purpose; reuse it with action "prompt"`,
                        );
                    }
                    const profileName = resolveSubagentCreationProfile(persona, params.profile);
                    const profile = SUBAGENT_EXECUTION_PROFILES[profileName];
                    const requestedMode = params.mode ?? "fresh";
                    const createOptions = {
                        runtime,
                        mode: "fresh" as const,
                        purpose: normalizedPurpose,
                        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
                        ...(persona ? { persona } : {}),
                        skills: selectedSkillPaths,
                        lifetime,
                        ...(runtime === "pi" ? { model: profile.model, thinking: profile.thinking } : {}),
                        ...(runtime === "cursor-cloud" ? { cursorProfile: profileName } : {}),
                    };
                    // Validate before a fork snapshot copies parent history.
                    registry.validateCreate(ctx, createOptions);
                    const forkContext = requestedMode === "fork" && runtime === "pi"
                        ? registry.createActiveTurnForkSnapshot(ctx)
                        : { mode: requestedMode };
                    if (initialPrompt && persona?.contextRequirements && !context && forkContext.mode !== "fork") {
                        throw requiredContextError(persona);
                    }
                    const finishDeferredPersistence = requestedMode === "fork"
                        ? registry.deferPersistence()
                        : undefined;
                    const finishForkPersistence = () => {
                        const mutation = finishDeferredPersistence?.();
                        if (mutation !== undefined) deferredMutation = mutation;
                        return deferredRegistryDetails(mutation);
                    };
                    const fallback = forkContext.mode === "fresh" && "fallback" in forkContext
                        ? forkContext.fallback
                        : undefined;
                    let summary: PersistentSubagentSummary;
                    try {
                        summary = await registry.create(ctx, {
                            ...createOptions,
                            mode: forkContext.mode,
                            ...(forkContext.mode === "fork" && "parentSessionFile" in forkContext
                                ? { parentSessionFile: forkContext.parentSessionFile }
                                : {}),
                        });
                    } catch (error) {
                        finishForkPersistence();
                        if (forkContext.mode === "fork" && "parentSessionFile" in forkContext
                            && typeof forkContext.parentSessionFile === "string") {
                            fs.rmSync(forkContext.parentSessionFile, { force: true });
                        }
                        throw error;
                    }
                    fallbackDetails = fallback
                        ? { fork: { requested: "fork", mode: "fresh", fallback } }
                        : {};
                    fallbackText = fallback
                        ? "Parent session was not persisted; created with fresh context.\n\n"
                        : "";
                    if (!initialPrompt) {
                        const persistenceDetails = finishForkPersistence();
                        return {
                            content: [{ type: "text", text: `${fallbackText}Created ${summary.name}.` }],
                            details: {
                                ok: true,
                                tool: "subagent",
                                action: "create",
                                subagent: summary,
                                runtime: runtimeDetailsFor(summary),
                                ...fallbackDetails,
                                ...persistenceDetails,
                            },
                        };
                    }
                    let lastProgress = "";
                    let promptReturned = false;
                    try {
                        const result = await registry.prompt(
                            ctx,
                            summary.id,
                            formatSubagentRequest(initialPrompt, context),
                            {
                                signal,
                                parentContextProvided: context !== undefined,
                                onStateChange: (current) => {
                                    const progress = `${current.name} · ${current.status}`;
                                    if (progress === lastProgress) return;
                                    lastProgress = progress;
                                    onUpdate?.({
                                        content: [{ type: "text", text: progress }],
                                        details: { ok: true, tool: "subagent", action: "prompt", subagent: current },
                                    });
                                },
                            },
                        );
                        promptReturned = true;
                        const finalized = await finalizeModelPrompt(result, "create");
                        const persistenceDetails = finishForkPersistence();
                        if (!fallback) {
                            return {
                                ...finalized,
                                details: { ...finalized.details, ...persistenceDetails },
                            };
                        }
                        return {
                            ...finalized,
                            content: [{
                                type: "text" as const,
                                text: boundedText(
                                    `${fallbackText}${finalized.content[0]?.text ?? "(no visible response)"}`,
                                    responseTruncationNotice(summary.name),
                                ),
                            }],
                            details: { ...finalized.details, ...fallbackDetails, ...persistenceDetails },
                        };
                    } catch (error) {
                        // A returned Cursor result can still be pending acknowledgement.
                        // Do not archive it when output preparation fails, but retry Pi
                        // one-shot cleanup when finalization or stop itself rejects.
                        if ((!promptReturned || summary.runtime === "pi") && !(error instanceof SubagentCursorPromptFailure)) {
                            await stopFailedOneShot(summary);
                        }
                        finishForkPersistence();
                        throw error;
                    }
                }
                case "list": {
                    if (params.kind === "personas") {
                        const offset = params.offset ?? 0;
                        const limit = params.limit ?? 20;
                        const page: SubagentPersona[] = [];
                        let nextOffset = offset;
                        while (nextOffset < discovery.personas.length && page.length < limit) {
                            const persona = discovery.personas[nextOffset]!;
                            const candidate = [...page, persona].map(formatPersonaForModel).join("\n");
                            const candidateNextOffset = nextOffset + 1;
                            const candidateText = candidateNextOffset < discovery.personas.length
                                ? `${candidate}\nMore personas available: repeat list with offset ${candidateNextOffset}.`
                                : candidate;
                            if (truncateHead(candidateText, {
                                maxBytes: MAX_SUBAGENT_RESPONSE_BYTES,
                                maxLines: MAX_SUBAGENT_RESPONSE_LINES,
                            }).truncated) break;
                            page.push(persona);
                            nextOffset = candidateNextOffset;
                        }
                        const remaining = Math.max(0, discovery.personas.length - nextOffset);
                        const pageText = page.length > 0
                            ? page.map(formatPersonaForModel).join("\n")
                            : discovery.personas.length === 0
                                ? "No subagent personas are configured."
                                : offset >= discovery.personas.length
                                    ? "No subagent personas at this offset."
                                    : "No subagent persona fits in one result page.";
                        const text = remaining > 0 && page.length > 0
                            ? `${pageText}\nMore personas available: repeat list with offset ${nextOffset}.`
                            : pageText;
                        const personas = page.map(({
                            name,
                            description,
                            runtime,
                            contextRequirements,
                            preferredProfile,
                        }) => ({
                            name,
                            description,
                            runtime,
                            ...(preferredProfile ? { preferredProfile } : {}),
                            ...(contextRequirements ? { contextRequirements } : {}),
                        }));
                        return {
                            content: [{ type: "text", text: boundedText(text, "Persona page truncated") }],
                            details: { ok: true, tool: "subagent", action: "list", kind: "personas", personas, omitted: remaining },
                        };
                    }
                    if (params.offset !== undefined || params.limit !== undefined) {
                        throw new Error("offset and limit are only valid for persona lists");
                    }
                    const subagents = registry.list();
                    const reusable = subagents.filter((subagent) => subagent.status !== "stopped");
                    const text = reusable.length > 0
                        ? reusable.map((subagent) => formatSubagentForModel(subagent, true)).join("\n")
                        : "No reusable subagents.";
                    return {
                        content: [{ type: "text", text: boundedText(text, "Subagent list truncated") }],
                        details: { ok: true, tool: "subagent", action: "list", kind: "subagents", subagents: subagents.slice(0, 100), omitted: Math.max(0, subagents.length - 100) },
                    };
                }
                case "prompt": {
                    const id = requireText(params.id, "id");
                    const prompt = requireText(params.prompt, "prompt");
                    const summary = registry.summaryFor(id);
                    let lastProgress = "";
                    let promptReturned = false;
                    try {
                        const result = await registry.prompt(
                            ctx,
                            id,
                            formatSubagentRequest(prompt, context),
                            {
                                signal,
                                parentContextProvided: context !== undefined,
                                onStateChange: (current) => {
                                    const progress = `${current.name} · ${current.status}`;
                                    if (progress === lastProgress) return;
                                    lastProgress = progress;
                                    onUpdate?.({
                                        content: [{ type: "text", text: progress }],
                                        details: { ok: true, tool: "subagent", action: "prompt", subagent: current },
                                    });
                                },
                            },
                        );
                        promptReturned = true;
                        return await finalizeModelPrompt(result, "prompt");
                    } catch (error) {
                        // A returned Cursor result can still be pending acknowledgement.
                        // Do not archive it when output preparation fails, but retry Pi
                        // one-shot cleanup when finalization or stop itself rejects.
                        if ((!promptReturned || summary.runtime === "pi") && !(error instanceof SubagentCursorPromptFailure)) {
                            await stopFailedOneShot(summary);
                        }
                        throw error;
                    }
                }
                case "status": {
                    const summary = await registry.status(requireText(params.id, "id"));
                    return {
                        content: [{ type: "text", text: formatSubagentForModel(summary) }],
                        details: {
                            ok: true,
                            tool: "subagent",
                            action: "status",
                            subagent: summary,
                            runtime: runtimeDetailsFor(summary),
                        },
                    };
                }
                case "stop": {
                    const summary = await registry.stop(requireText(params.id, "id"));
                    return {
                        content: [{ type: "text", text: formatSubagentStopResult(summary) }],
                        details: {
                            ok: summary.status === "stopped",
                            tool: "subagent",
                            action: "stop",
                            subagent: summary,
                            runtime: runtimeDetailsFor(summary),
                        },
                    };
                }
            }
            } catch (error) {
                const failure = subagentFailure(error, signal);
                const cursorFailure = receiptForCursorFailure(error);
                return {
                    ...failure,
                    content: fallbackText
                        ? [{ type: "text" as const, text: `${fallbackText}${failure.content[0].text}` }]
                        : failure.content,
                    details: {
                        ...failure.details,
                        ...(cursorFailure ? {
                            subagent: cursorFailure.failure.summary,
                            runtime: cursorFailure.failure.metadata,
                            ...(cursorFailure.receipt ? { [SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY]: cursorFailure.receipt } : {}),
                        } : {}),
                        ...fallbackDetails,
                        ...deferredRegistryDetails(deferredMutation),
                    },
                };
            }
        },
    });

    pi.on("before_agent_start", (event) => {
        parentDiscoveredSkills = (event.systemPromptOptions.skills ?? [])
            .filter((skill) => !skill.disableModelInvocation)
            .map(({ name, filePath }) => ({ name, filePath }));
    });

    pi.on("turn_end", async (event) => {
        for (const toolResult of event.toolResults) {
            if (toolResult.toolName !== "subagent") continue;
            const details = toolResult.details;
            if (!details || typeof details !== "object" || Array.isArray(details)) continue;
            await registry.processCursorDeliveryReceipt((details as Record<string, unknown>)[SUBAGENT_CURSOR_DELIVERY_RECEIPT_KEY]);
        }
    });

    pi.on("session_start", (_event, ctx) => {
        registry.restore(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        await registry.shutdown();
        registry.restore(ctx);
    });

    pi.on("session_shutdown", async () => {
        await registry.shutdown();
    });
}
