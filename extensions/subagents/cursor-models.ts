import { SubagentBackendError } from "./backend.ts";
import type { CursorSdkGateway } from "./cursor-sdk.ts";
import type { SubagentThinkingLevel } from "./personas.ts";

const MAX_CATALOG_MODELS = 100;
const MAX_MODEL_ALIASES = 16;
const MAX_MODEL_PARAMETERS = 16;
const MAX_PARAMETER_VALUES = 32;
const MAX_MODEL_TEXT_CHARS = 256;

export const CURSOR_PROFILE_TARGETS = {
    fast: {
        target: "GPT-5.6 Luna",
        ids: ["gpt-5.6-luna"],
        thinking: "high",
        parameters: [
            { id: "context", value: "272k" },
            { id: "reasoning", value: "high" },
            { id: "fast", value: "false" },
        ],
    },
    balanced: {
        target: "GPT-5.6 Terra",
        ids: ["gpt-5.6-terra"],
        thinking: "xhigh",
        parameters: [
            { id: "context", value: "272k" },
            { id: "reasoning", value: "xhigh" },
            { id: "fast", value: "false" },
        ],
    },
    deep: {
        target: "GPT-5.6 Sol",
        ids: ["gpt-5.6-sol"],
        thinking: "xhigh",
        parameters: [
            { id: "context", value: "272k" },
            { id: "reasoning", value: "xhigh" },
            { id: "fast", value: "false" },
        ],
    },
} as const;

export type CursorExecutionProfile = keyof typeof CURSOR_PROFILE_TARGETS;

export interface CursorCatalogParameterValue {
    readonly value: string;
    readonly name: string;
    /** Present when this thinking value selects a canonical SDK variant. */
    readonly parameters?: readonly CursorModelParameterSelection[];
}

export interface CursorCatalogParameter {
    readonly id: string;
    readonly name: string;
    readonly values: readonly CursorCatalogParameterValue[];
}

/** A bounded model form that is safe for panel state and persistence. */
export interface CursorCatalogVariant {
    readonly name: string;
    /** Canonical SDK parameters for this selectable variant. */
    readonly parameters: readonly CursorModelParameterSelection[];
}

export interface CursorCatalogModel {
    readonly id: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly parameters: readonly CursorCatalogParameter[];
    /** Raw SDK variants exist, so generic parameter selection is not canonical. */
    readonly variantsPresent: boolean;
    /** Every raw SDK variant was within bounds and normalized. */
    readonly variantsComplete: boolean;
    readonly variants: readonly CursorCatalogVariant[];
}

export interface CursorModelParameterSelection {
    readonly id: string;
    readonly value: string;
}

export interface CursorResolvedModel {
    readonly requested: string;
    readonly model: CursorCatalogModel;
    readonly selection: {
        readonly id: string;
        readonly parameters: readonly CursorModelParameterSelection[];
    };
    readonly resolvedAt: number;
}

/** This value has the same shape as the registry currentModel field. */
export interface PersistedCursorModelSelection {
    readonly id: string;
    readonly parameters: readonly CursorModelParameterSelection[];
    readonly resolvedAt: number;
}

export interface CursorPanelModel {
    readonly id: string;
    readonly name: string;
    readonly thinking?: {
        readonly parameterId: string;
        readonly values: readonly CursorCatalogParameterValue[];
    };
}

export interface CursorModelCatalogClient {
    listModels(): Promise<readonly unknown[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxChars = MAX_MODEL_TEXT_CHARS): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    return text && text.length <= maxChars ? text : undefined;
}

function exactKey(value: string): string {
    return value.toLowerCase();
}

function normalizeVariant(value: unknown): CursorCatalogVariant | undefined {
    if (!isRecord(value) || !Array.isArray(value.params) || value.params.length > MAX_MODEL_PARAMETERS) return undefined;
    const parameters: CursorModelParameterSelection[] = [];
    const seen = new Set<string>();
    for (const parameter of value.params) {
        if (!isRecord(parameter)) continue;
        const id = safeText(parameter.id);
        const parameterValue = safeText(parameter.value);
        if (!id || !parameterValue || seen.has(id)) return undefined;
        seen.add(id);
        parameters.push({ id, value: parameterValue });
    }
    if (parameters.length === 0) return undefined;
    return {
        name: safeText(value.displayName, MAX_MODEL_TEXT_CHARS) ?? parameters.map(({ id, value: parameterValue }) => `${id}=${parameterValue}`).join(", "),
        parameters,
    };
}

function normalizeParameter(value: unknown): CursorCatalogParameter | undefined {
    if (!isRecord(value)) return undefined;
    const id = safeText(value.id);
    if (!id || !Array.isArray(value.values)) return undefined;
    const values = new Map<string, CursorCatalogParameterValue>();
    for (const item of value.values.slice(0, MAX_PARAMETER_VALUES)) {
        if (!isRecord(item)) continue;
        const parameterValue = safeText(item.value);
        if (!parameterValue) continue;
        const name = safeText(item.displayName, MAX_MODEL_TEXT_CHARS) ?? parameterValue;
        values.set(exactKey(parameterValue), { value: parameterValue, name });
    }
    if (values.size === 0) return undefined;
    return {
        id,
        name: safeText(value.displayName, MAX_MODEL_TEXT_CHARS) ?? id,
        values: [...values.values()],
    };
}

/** Normalize unstable SDK catalog data before it reaches the panel or registry. */
export function normalizeCursorModelCatalog(values: readonly unknown[]): CursorCatalogModel[] {
    const models = new Map<string, CursorCatalogModel>();
    for (const value of values.slice(0, MAX_CATALOG_MODELS)) {
        if (!isRecord(value)) continue;
        const id = safeText(value.id);
        if (!id || models.has(exactKey(id))) continue;
        const aliases = Array.isArray(value.aliases)
            ? [...new Map(value.aliases.slice(0, MAX_MODEL_ALIASES)
                .map((alias) => safeText(alias))
                .filter((alias): alias is string => Boolean(alias))
                .map((alias) => [exactKey(alias), alias])).values()]
            : [];
        const parameters = Array.isArray(value.parameters)
            ? value.parameters.slice(0, MAX_MODEL_PARAMETERS)
                .map(normalizeParameter)
                .filter((parameter): parameter is CursorCatalogParameter => Boolean(parameter))
            : [];
        const rawVariants = value.variants;
        const variantsPresent = Array.isArray(rawVariants) ? rawVariants.length > 0 : rawVariants !== undefined;
        let variantsComplete = !variantsPresent;
        let variants: CursorCatalogVariant[] = [];
        if (Array.isArray(rawVariants) && rawVariants.length > 0 && rawVariants.length <= MAX_PARAMETER_VALUES) {
            const normalized = rawVariants.map(normalizeVariant);
            if (normalized.every((variant): variant is CursorCatalogVariant => Boolean(variant))) {
                variantsComplete = true;
                variants = [...new Map(normalized
                    .map((variant) => [variant.parameters.map(({ id: parameterId, value: parameterValue }) => `${parameterId}=${parameterValue}`).join("\u0000"), variant])).values()];
            }
        }
        models.set(exactKey(id), {
            id,
            name: safeText(value.displayName, MAX_MODEL_TEXT_CHARS) ?? id,
            aliases,
            parameters,
            variantsPresent,
            variantsComplete,
            variants,
        });
    }
    return [...models.values()];
}

function targetMatches(model: CursorCatalogModel, targets: readonly string[]): boolean {
    const modelNames = [model.id, model.name, ...model.aliases].map(exactKey);
    return targets.some((target) => modelNames.includes(exactKey(target)));
}

function isThinkingParameter(id: string, name = id): boolean {
    return /(?:^|[-_\s])(thinking|reasoning)(?:$|[-_\s])|^(thinking|reasoning)/i.test(`${id} ${name}`);
}

function thinkingParameter(model: CursorCatalogModel): CursorCatalogParameter | undefined {
    const candidates = model.parameters.filter((parameter) => isThinkingParameter(parameter.id, parameter.name));
    return candidates.length === 1 ? candidates[0] : undefined;
}

function variantThinkingValues(model: CursorCatalogModel): { readonly parameterId: string; readonly values: readonly CursorCatalogParameterValue[] } | undefined {
    if (!model.variantsPresent || !model.variantsComplete) return undefined;
    const candidates = model.variants.flatMap((variant) => variant.parameters
        .filter((parameter) => isThinkingParameter(parameter.id))
        .map((parameter) => ({ variant, parameter })));
    if (candidates.length === 0) return undefined;
    const parameterIds = new Set(candidates.map(({ parameter }) => parameter.id));
    if (parameterIds.size !== 1) return undefined;
    const parameterId = candidates[0]!.parameter.id;
    const values = new Map<string, CursorCatalogParameterValue>();
    for (const { variant, parameter } of candidates) {
        const key = exactKey(parameter.value);
        const existing = values.get(key);
        if (existing && JSON.stringify(existing.parameters) !== JSON.stringify(variant.parameters)) return undefined;
        values.set(key, { value: parameter.value, name: parameter.value, parameters: variant.parameters });
    }
    return { parameterId, values: [...values.values()] };
}

function resolveThinking(
    model: CursorCatalogModel,
    requested: SubagentThinkingLevel | undefined,
): readonly CursorModelParameterSelection[] | undefined {
    if (!requested) return [];
    if (model.variantsPresent) {
        if (!model.variantsComplete) return undefined;
        const variants = variantThinkingValues(model);
        return variants?.values.find((candidate) => exactKey(candidate.value) === exactKey(requested))?.parameters;
    }
    const parameter = thinkingParameter(model);
    const value = parameter?.values.find((candidate) => exactKey(candidate.value) === exactKey(requested));
    return parameter && value ? [{ id: parameter.id, value: value.value }] : undefined;
}

function panelModelsFrom(models: readonly CursorCatalogModel[]): readonly CursorPanelModel[] {
    return models.map((model) => {
        const variants = variantThinkingValues(model);
        const parameter = model.variantsPresent ? undefined : thinkingParameter(model);
        return {
            id: model.id,
            name: model.name,
            ...(variants
                ? { thinking: { parameterId: variants.parameterId, values: variants.values } }
                : parameter ? { thinking: { parameterId: parameter.id, values: parameter.values } } : {}),
        };
    });
}

function safeDetail(value: string): string {
    return value.replace(/\b(?:CURSOR_API_KEY|api[_-]?key|access[_-]?token|secret)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "credential$1[redacted]");
}

function modelUnavailable(requested: string, models: readonly CursorCatalogModel[]): SubagentBackendError {
    const requestedText = safeDetail(safeText(requested, 80) ?? "requested model");
    const choices = models.slice(0, 12).map((model) => safeDetail(model.name)).join(", ") || "none";
    return new SubagentBackendError(
        "MODEL_UNAVAILABLE",
        `Cursor model "${requestedText}" is unavailable. Available models: ${choices}.`,
        "cursor-cloud",
    );
}

/** Cache the model catalog and refresh it once when a requested lookup misses. */
export class CursorModelCatalog {
    private readonly client: CursorModelCatalogClient;
    private catalogPromise: Promise<readonly CursorCatalogModel[]> | undefined;

    constructor(client: CursorModelCatalogClient | Pick<CursorSdkGateway, "listModels">) {
        this.client = client;
    }

    async list(): Promise<readonly CursorCatalogModel[]> {
        this.catalogPromise ??= this.load();
        return this.catalogPromise;
    }

    async refresh(): Promise<readonly CursorCatalogModel[]> {
        this.catalogPromise = this.load();
        return this.catalogPromise;
    }

    async resolveProfile(profile: CursorExecutionProfile): Promise<CursorResolvedModel> {
        const target = CURSOR_PROFILE_TARGETS[profile];
        return this.resolveMappedTarget(target, target.thinking);
    }

    /** Apply the selected creation profile or the balanced default. */
    async resolveCreation(profile: CursorExecutionProfile | undefined): Promise<CursorResolvedModel> {
        return this.resolveProfile(profile ?? "balanced");
    }

    /** Resolve a panel selection only when the catalog supports every parameter. */
    async resolveSelection(
        modelId: string,
        parameters: readonly CursorModelParameterSelection[] = [],
    ): Promise<CursorResolvedModel> {
        return this.resolveTarget(modelId, [], undefined, parameters);
    }

    async panelModels(): Promise<readonly CursorPanelModel[]> {
        return panelModelsFrom(await this.list());
    }

    /** Refresh panel choices after an unavailable catalog state. */
    async refreshPanelModels(): Promise<readonly CursorPanelModel[]> {
        return panelModelsFrom(await this.refresh());
    }

    private resolveMappedTarget(
        target: typeof CURSOR_PROFILE_TARGETS[CursorExecutionProfile],
        thinking: SubagentThinkingLevel,
    ): Promise<CursorResolvedModel> {
        const parameters = target.parameters.map((parameter) =>
            isThinkingParameter(parameter.id) ? { ...parameter, value: thinking } : parameter);
        return this.resolveTarget(target.target, target.ids, thinking, parameters, true);
    }

    private async resolveTarget(
        requested: string,
        alternateIds: readonly string[],
        thinking: SubagentThinkingLevel | undefined,
        requestedParameters?: readonly CursorModelParameterSelection[],
        fallbackToThinking = false,
    ): Promise<CursorResolvedModel> {
        const resolve = (models: readonly CursorCatalogModel[]): CursorResolvedModel | undefined =>
            this.resolveFrom(models, requested, alternateIds, thinking, requestedParameters)
            ?? (fallbackToThinking && requestedParameters
                ? this.resolveFrom(models, requested, alternateIds, thinking, undefined)
                : undefined);
        let models = await this.list();
        let resolved = resolve(models);
        if (!resolved) {
            models = await this.refresh();
            resolved = resolve(models);
        }
        if (!resolved) throw modelUnavailable(requested, models);
        return resolved;
    }

    private resolveFrom(
        models: readonly CursorCatalogModel[],
        requested: string,
        alternateIds: readonly string[],
        thinking: SubagentThinkingLevel | undefined,
        requestedParameters: readonly CursorModelParameterSelection[] | undefined,
    ): CursorResolvedModel | undefined {
        const targets = [requested, ...alternateIds];
        const matches = models.filter((model) => targetMatches(model, targets));
        if (matches.length !== 1) return undefined;
        const model = matches[0]!;
        const parameters = requestedParameters === undefined
            ? resolveThinking(model, thinking)
            : this.validateParameters(model, requestedParameters);
        if (!parameters) return undefined;
        return {
            requested,
            model,
            selection: { id: model.id, parameters },
            resolvedAt: Date.now(),
        };
    }

    private validateParameters(
        model: CursorCatalogModel,
        requested: readonly CursorModelParameterSelection[],
    ): readonly CursorModelParameterSelection[] | undefined {
        if (requested.length === 0) return [];
        if (requested.length > MAX_MODEL_PARAMETERS) return undefined;
        const requestedKeys = new Set(requested.map(({ id, value }) => `${id}\u0000${value}`));
        if (requestedKeys.size !== requested.length) return undefined;
        if (model.variantsPresent) {
            if (!model.variantsComplete) return undefined;
            const matchingVariants = model.variants.filter((variant) =>
                requested.every(({ id, value }) => variant.parameters.some((parameter) => parameter.id === id && parameter.value === value)));
            return matchingVariants.length === 1 ? matchingVariants[0]!.parameters : undefined;
        }
        const result: CursorModelParameterSelection[] = [];
        for (const selection of requested) {
            const parameter = model.parameters.find((candidate) => candidate.id === selection.id);
            const value = parameter?.values.find((candidate) => candidate.value === selection.value);
            if (!parameter || !value) return undefined;
            result.push({ id: parameter.id, value: value.value });
        }
        return result;
    }

    private async load(): Promise<readonly CursorCatalogModel[]> {
        try {
            const values = await this.client.listModels();
            return normalizeCursorModelCatalog(values);
        } catch (error) {
            if (error instanceof SubagentBackendError) throw error;
            throw new SubagentBackendError(
                "BACKEND_FAILED",
                "Cursor model catalog could not be loaded. Retry the operation.",
                "cursor-cloud",
            );
        }
    }
}

export function persistableCursorModelSelection(resolved: CursorResolvedModel): PersistedCursorModelSelection {
    return {
        id: resolved.selection.id,
        parameters: resolved.selection.parameters.map((parameter) => ({ ...parameter })),
        resolvedAt: resolved.resolvedAt,
    };
}
