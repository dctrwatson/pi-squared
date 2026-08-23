/**
 * Persistent Pi subagents.
 *
 * Personas are reusable templates. Each subagent instance owns an isolated,
 * persisted Pi RPC session that the parent model and user can both revisit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    truncateHead,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    BUNDLED_PERSONA_DIRECTORY,
    loadChildPersonas,
    loadChildPersonasFromDirectories,
    parseChildCommandArgs,
    SUBAGENT_LIFETIMES,
    type ChildPersona,
    type SubagentLifetime,
} from "./personas.ts";
import {
    formatSubagentSummary,
    normalizeSubagentPurpose,
    PersistentSubagentRegistry,
    registryErrorMessage,
    type PersistentSubagentSummary,
} from "./registry.ts";

export {
    BUNDLED_PERSONA_DIRECTORY,
    buildChildProcessArgs,
    formatChildModelScope,
    formatSubagentContinuityPrompt,
    loadChildPersonas,
    loadChildPersonasFromDirectories,
    parseChildCommandArgs,
    type ChildContextMode,
    type ChildPersona,
    type ChildPersonaDiscovery,
    type ChildProcessOptions,
    type ChildScopedModel,
    SUBAGENT_LIFETIMES,
    type ChildThinkingLevel,
    type SubagentLifetime,
} from "./personas.ts";
export {
    parseSubagentBlockerResponse,
    type ActiveSubagentBlocker,
    type ParsedSubagentBlocker,
} from "./blockers.ts";
export { getPiInvocation } from "./rpc.ts";
export { getChildPanelWidths } from "./ui.ts";
export {
    formatSubagentSummary,
    MAX_PERSISTENT_SUBAGENTS,
    MAX_RETAINED_STOPPED_SUBAGENTS,
    PersistentSubagentRegistry,
    type PersistentSubagentStatus,
    type PersistentSubagentSummary,
} from "./registry.ts";

const MAX_PARENT_CONTEXT_CHARS = 8_000;
export const MAX_SUBAGENT_RESPONSE_BYTES = 16 * 1_024;
export const MAX_SUBAGENT_RESPONSE_LINES = 400;
export const SUBAGENT_EXECUTION_PROFILES = {
    fast: { model: "openai-codex/gpt-5.6-luna", thinking: "high" },
    balanced: { model: "openai-codex/gpt-5.6-terra", thinking: "xhigh" },
    deep: { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" },
} as const;
const SubagentParameters = Type.Object({
    action: StringEnum(["create", "list", "prompt", "status", "stop"] as const),
    id: Type.Optional(Type.String({ maxLength: 64, description: "Subagent name or ID for prompt, status, or stop" })),
    name: Type.Optional(Type.String({ maxLength: 64, description: "New subagent name" })),
    purpose: Type.Optional(Type.String({ maxLength: 240, description: "Stable context domain for create" })),
    persona: Type.Optional(Type.String({
        maxLength: 64,
        description: "Existing persona required for create; list personas",
    })),
    profile: Type.Optional(StringEnum(["fast", "balanced", "deep"] as const, {
        description: "Create profile: fast=Luna, balanced=Terra, deep=Sol",
    })),
    lifetime: Type.Optional(StringEnum(SUBAGENT_LIFETIMES, {
        description: "Create lifetime; one-shot needs prompt; overrides persona default",
    })),
    prompt: Type.Optional(Type.String({ description: "Initial or follow-up prompt" })),
    context: Type.Optional(Type.String({
        maxLength: MAX_PARENT_CONTEXT_CHARS,
        description: "Concise persona-required background; do not paste source or diffs",
    })),
    kind: Type.Optional(StringEnum(["subagents", "personas"] as const, {
        description: "List target; default: subagents",
    })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Persona-list offset" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Persona-list count; default: 20" })),
});

function personaByName(personas: readonly ChildPersona[], name: string | undefined): ChildPersona {
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

function requiredContextError(persona: ChildPersona): Error {
    return new Error(
        `${persona.name} requires context before its first parent prompt: ${persona.contextRequirements}. Retry with context.`,
    );
}

function formatSubagentForModel(summary: PersistentSubagentSummary): string {
    const blocker = summary.blocker
        ? `; blocked: ${summary.blocker.reason}; needs: ${summary.blocker.need}`
        : "";
    return `${summary.name} [${summary.status}, ${summary.lifetime}]: ${summary.purpose}${blocker}`;
}

export function formatPersonaForModel(persona: ChildPersona): string {
    const preference = persona.preferredLifetime ? ` [prefers ${persona.preferredLifetime}]` : "";
    const requirement = persona.contextRequirements
        ? ` [context required: ${persona.contextRequirements}]`
        : "";
    return `${persona.name}: ${normalizeSubagentPurpose(persona.description)}${preference}${requirement}`;
}

export type SubagentsCommandArgs =
    | { action: "open" | "stop"; target: string }
    | { action: "enable" | "disable"; target: "" }
    | { action: "open"; target: ""; error: string };

const SUBAGENT_ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
    create: new Set(["action", "name", "purpose", "persona", "profile", "lifetime", "prompt", "context"]),
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

function incompleteResponseReason(result: {
    text: string;
    responseProduced?: boolean;
    handledWithoutAgent?: boolean;
    stopReason?: string;
}): string | undefined {
    if (result.handledWithoutAgent) return "the prompt was handled without an agent response";
    const responseProduced = result.responseProduced ?? Boolean(result.text.trim());
    if (!responseProduced || !result.text.trim()) return "the subagent produced no visible response";
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

export default function (
    pi: ExtensionAPI,
    options: { personaDirectory?: string } = {},
) {
    const discovery = options.personaDirectory
        ? loadChildPersonas(options.personaDirectory)
        : loadChildPersonasFromDirectories([
            BUNDLED_PERSONA_DIRECTORY,
            path.join(getAgentDir(), "personas"),
        ]);
    const registry = new PersistentSubagentRegistry(pi);
    let diagnosticsShown = false;

    const finalizeModelPrompt = async (
        result: Awaited<ReturnType<PersistentSubagentRegistry["prompt"]>>,
        action: "create" | "prompt",
    ) => {
        const visible = result.text.trim() || "(no visible response)";
        const incomplete = incompleteResponseReason(result);
        if (result.summary.lifetime === "one-shot") {
            if (result.summary.blocker) {
                const retained = await registry.setLifetime(result.summary.id, "task");
                return {
                    content: [{
                        type: "text" as const,
                        text: boundedText(
                            `Retained ${retained.name} as a task because it is blocked.\n\n${visible}`,
                            responseTruncationNotice(retained.name),
                        ),
                    }],
                    details: { action, subagent: retained },
                    usage: result.usage,
                };
            }
            if (incomplete) {
                const retained = await registry.setLifetime(result.summary.id, "task");
                return {
                    content: [{
                        type: "text" as const,
                        text: boundedText(
                            `Retained ${retained.name} as a task because ${incomplete}.\n\n${visible}`,
                            responseTruncationNotice(retained.name),
                        ),
                    }],
                    details: { action, subagent: retained },
                    usage: result.usage,
                };
            }
            const completed = `Completed one-shot ${result.summary.name}.\n\n${visible}`;
            if (responseWouldTruncate(completed)) {
                const retained = await registry.setLifetime(result.summary.id, "task");
                return {
                    content: [{
                        type: "text" as const,
                        text: boundedText(
                            `Retained ${retained.name} as a task because its response was truncated.\n\n${visible}`,
                            responseTruncationNotice(retained.name),
                        ),
                    }],
                    details: { action, subagent: retained },
                    usage: result.usage,
                };
            }
            const stopped = await registry.stop(result.summary.id);
            return {
                content: [{ type: "text" as const, text: completed }],
                details: { action, subagent: stopped },
                usage: result.usage,
            };
        }
        const response = incomplete
            ? `Incomplete subagent response: ${incomplete}. Reprompt ${result.summary.name} for continuation.\n\n${visible}`
            : visible;
        const text = action === "create"
            ? boundedText(`Saved as ${result.summary.name}.\n\n${response}`, responseTruncationNotice(result.summary.name))
            : boundedSubagentResponse(response, result.summary.name);
        return {
            content: [{ type: "text" as const, text }],
            details: { action, subagent: result.summary },
            usage: result.usage,
        };
    };

    const stopFailedOneShot = async (summary: PersistentSubagentSummary): Promise<void> => {
        if (summary.lifetime !== "one-shot") return;
        await registry.stop(summary.id).catch(() => undefined);
    };

    const showDiagnostics = (ctx: ExtensionCommandContext): void => {
        if (diagnosticsShown || discovery.diagnostics.length === 0) return;
        diagnosticsShown = true;
        for (const diagnostic of discovery.diagnostics) ctx.ui.notify(diagnostic, "warning");
    };

    const createAndOpen = async (
        args: string,
        ctx: ExtensionCommandContext,
        persona?: ChildPersona,
    ): Promise<void> => {
        if (ctx.mode !== "tui") {
            if (ctx.hasUI) ctx.ui.notify("/child requires TUI mode", "error");
            return;
        }
        showDiagnostics(ctx);
        const parsed = parseChildCommandArgs(args);
        if (parsed.error) {
            ctx.ui.notify(`${parsed.error}. Usage: /child${persona ? `:${persona.name}` : ""} [--fork] [prompt]`, "error");
            return;
        }
        if (parsed.mode === "fork") {
            if (!ctx.isIdle()) {
                ctx.ui.notify("Forked subagents can only be created while the parent agent is idle.", "error");
                return;
            }
            const parentSessionFile = ctx.sessionManager.getSessionFile();
            if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
                ctx.ui.notify("Cannot fork a parent session that has not been persisted yet. Use /child without --fork.", "error");
                return;
            }
        }

        try {
            const purpose = parsed.prompt
                || persona?.description
                || (parsed.mode === "fork"
                    ? "Analysis using inherited parent-session context"
                    : "General project research");
            const summary = registry.create(ctx, { mode: parsed.mode, purpose, persona });
            const result = await registry.open(ctx, summary.id, parsed.prompt);
            if (result?.action === "return") {
                ctx.ui.setEditorText(result.text);
                ctx.ui.notify("Subagent response placed in the parent editor. Review and submit when ready.", "info");
            }
        } catch (error) {
            ctx.ui.notify(`Could not create subagent: ${registryErrorMessage(error)}`, "error");
        }
    };

    const manageExisting = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
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
                    ctx.ui.notify("No subagents yet. Use /child to create one.", "info");
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
                ctx.ui.notify(`Stopped ${stopped.name} (${stopped.id}).`, "info");
                return;
            }
            const result = await registry.open(ctx, target);
            if (result?.action === "return") {
                ctx.ui.setEditorText(result.text);
                ctx.ui.notify("Subagent response placed in the parent editor. Review and submit when ready.", "info");
            }
        } catch (error) {
            const operation = parsed.action === "stop"
                ? "stop subagent"
                : parsed.action === "enable" || parsed.action === "disable"
                    ? `${parsed.action} model subagent tool`
                    : "open subagent";
            ctx.ui.notify(`Could not ${operation}: ${registryErrorMessage(error)}`, "error");
        }
    };

    pi.registerCommand("child", {
        description: "Create and open a persistent subagent; add --fork for parent context",
        handler: async (args, ctx) => createAndOpen(args, ctx),
    });

    for (const persona of discovery.personas) {
        pi.registerCommand(`child:${persona.name}`, {
            description: `${persona.description} (persistent subagent)`,
            handler: async (args, ctx) => createAndOpen(args, ctx, persona),
        });
    }

    pi.registerCommand("subagents", {
        description: "Manage named subagents or toggle model access with --enable/--disable",
        handler: manageExisting,
    });
    pi.registerCommand("children", {
        description: "Alias for /subagents",
        handler: manageExisting,
    });

    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: "Create, reuse, prompt, inspect, or stop up to 4 isolated subagents.",
        promptSnippet: "Delegate isolated work; list and reuse by purpose",
        promptGuidelines: [
            "Before subagent create, list personas or reusable subagents when options are unknown and provide required context; choose the cheapest sufficient profile, and reserve deep for high-risk work, ambiguous work that needs cross-system analysis, or when a cheaper profile was insufficient.",
            "Use subagent one-shot for one-response work, task through validation, and persistent across objectives; satisfy a blocked subagent's NEEDS before reprompting, and stop completed ones.",
            "Give each subagent the exact objective, scope, and requested output; do not add adjacent work.",
        ],
        parameters: SubagentParameters,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
                    const persona = personaByName(discovery.personas, params.persona);
                    const initialPrompt = params.prompt?.trim();
                    const lifetime: SubagentLifetime = params.lifetime ?? persona.preferredLifetime ?? "persistent";
                    if (context && !initialPrompt) throw new Error("context requires an accompanying prompt");
                    if (lifetime === "one-shot" && !initialPrompt) {
                        throw new Error("one-shot subagents require an initial prompt");
                    }
                    const purpose = params.purpose?.trim()
                        || initialPrompt
                        || persona.description;
                    const normalizedPurpose = normalizeSubagentPurpose(purpose);
                    const reusable = registry.list().find((candidate) =>
                        candidate.status !== "stopped"
                        && candidate.purpose.toLowerCase() === normalizedPurpose.toLowerCase());
                    if (reusable) {
                        throw new Error(
                            `${reusable.name} already retains context for this purpose; reuse it with action "prompt"`,
                        );
                    }
                    if (initialPrompt && persona.contextRequirements && !context) {
                        throw requiredContextError(persona);
                    }
                    const profile = params.profile ? SUBAGENT_EXECUTION_PROFILES[params.profile] : undefined;
                    const selectedPersona: ChildPersona = profile
                        ? { ...persona, model: profile.model, thinking: profile.thinking }
                        : persona;
                    const summary = registry.create(ctx, {
                        mode: "fresh",
                        purpose: normalizedPurpose,
                        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
                        persona: selectedPersona,
                        lifetime,
                    });
                    if (!initialPrompt) {
                        return {
                            content: [{ type: "text", text: `Created ${summary.name}.` }],
                            details: { action: "create", subagent: summary },
                        };
                    }
                    let lastProgress = "";
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
                                        details: { action: "prompt", subagent: current },
                                    });
                                },
                            },
                        );
                        return await finalizeModelPrompt(result, "create");
                    } catch (error) {
                        await stopFailedOneShot(summary);
                        throw error;
                    }
                }
                case "list": {
                    if (params.kind === "personas") {
                        const offset = params.offset ?? 0;
                        const limit = params.limit ?? 20;
                        const page: ChildPersona[] = [];
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
                            contextRequirements,
                            preferredLifetime,
                        }) => ({
                            name,
                            description,
                            ...(preferredLifetime ? { preferredLifetime } : {}),
                            ...(contextRequirements ? { contextRequirements } : {}),
                        }));
                        return {
                            content: [{ type: "text", text: boundedText(text, "Persona page truncated") }],
                            details: { action: "list", kind: "personas", personas, omitted: remaining },
                        };
                    }
                    if (params.offset !== undefined || params.limit !== undefined) {
                        throw new Error("offset and limit are only valid for persona lists");
                    }
                    const subagents = registry.list();
                    const reusable = subagents.filter((subagent) => subagent.status !== "stopped");
                    const text = reusable.length > 0
                        ? reusable.map(formatSubagentForModel).join("\n")
                        : "No reusable subagents.";
                    return {
                        content: [{ type: "text", text: boundedText(text, "Subagent list truncated") }],
                        details: { action: "list", kind: "subagents", subagents: subagents.slice(0, 100), omitted: Math.max(0, subagents.length - 100) },
                    };
                }
                case "prompt": {
                    const id = requireText(params.id, "id");
                    const prompt = requireText(params.prompt, "prompt");
                    const summary = registry.summaryFor(id);
                    let lastProgress = "";
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
                                        details: { action: "prompt", subagent: current },
                                    });
                                },
                            },
                        );
                        return await finalizeModelPrompt(result, "prompt");
                    } catch (error) {
                        await stopFailedOneShot(summary);
                        throw error;
                    }
                }
                case "status": {
                    const summary = registry.summaryFor(requireText(params.id, "id"));
                    return {
                        content: [{ type: "text", text: formatSubagentForModel(summary) }],
                        details: { action: "status", subagent: summary },
                    };
                }
                case "stop": {
                    const summary = await registry.stop(requireText(params.id, "id"));
                    return {
                        content: [{ type: "text", text: `Stopped ${summary.name}.` }],
                        details: { action: "stop", subagent: summary },
                    };
                }
            }
        },
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
