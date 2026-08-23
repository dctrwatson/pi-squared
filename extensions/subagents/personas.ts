import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type ChildContextMode = "fresh" | "fork";
export type ChildThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const SUBAGENT_LIFETIMES = ["one-shot", "task", "persistent"] as const;
export type SubagentLifetime = typeof SUBAGENT_LIFETIMES[number];

export interface ChildScopedModel {
    provider: string;
    id: string;
    thinkingLevel?: ChildThinkingLevel;
}

export interface ChildPersona {
    name: string;
    description: string;
    systemPrompt: string;
    contextRequirements?: string;
    preferredLifetime?: SubagentLifetime;
    extensions: string[];
    skills: string[];
    model?: string;
    thinking?: ChildThinkingLevel;
    filePath: string;
}

export interface ChildPersonaDiscovery {
    personas: ChildPersona[];
    diagnostics: string[];
}

export interface ParsedChildCommand {
    mode: ChildContextMode;
    prompt: string;
    error?: string;
}

export interface ChildProcessOptions {
    mode: ChildContextMode;
    parentSessionFile?: string;
    sessionFile?: string;
    sessionDir?: string;
    sessionName?: string;
    purpose?: string;
    lifetime?: SubagentLifetime;
    persona?: ChildPersona;
    model?: string;
    thinking?: ChildThinkingLevel;
    scopedModels?: readonly ChildScopedModel[];
}

const PERSONA_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_PERSONA_NAME_CHARS = 64;
const THINKING_LEVELS = new Set<ChildThinkingLevel>([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);
export const BUNDLED_PERSONA_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "personas");
const MAX_CONTEXT_REQUIREMENTS_CHARS = 240;
const MAX_PERSONA_DESCRIPTION_CHARS = 240;

interface PersonaFrontmatter extends Record<string, unknown> {
    name?: unknown;
    description?: unknown;
    "context-requirements"?: unknown;
    "preferred-lifetime"?: unknown;
    extension?: unknown;
    extensions?: unknown;
    skill?: unknown;
    skills?: unknown;
    model?: unknown;
    thinking?: unknown;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    return values
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

export function normalizePersonaDescription(value: string): string {
    const description = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!description) throw new Error("description is empty");
    if (description.length <= MAX_PERSONA_DESCRIPTION_CHARS) return description;
    let prefix = description.slice(0, MAX_PERSONA_DESCRIPTION_CHARS - 1);
    const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
    return `${prefix.trimEnd()}…`;
}

export function normalizePersonaContextRequirements(value: string): string {
    const requirements = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!requirements) throw new Error("context-requirements is empty");
    if (requirements.length > MAX_CONTEXT_REQUIREMENTS_CHARS) {
        throw new Error(`context-requirements exceeds ${MAX_CONTEXT_REQUIREMENTS_CHARS} characters`);
    }
    return requirements;
}

function resolvePersonaPath(value: string, personaFile: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) {
        return path.join(os.homedir(), value.slice(2));
    }
    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(path.dirname(personaFile), value);
}

function loadPersona(filePath: string): ChildPersona {
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(content);
    const fallbackName = path.basename(filePath, path.extname(filePath));
    const name = stringValue(frontmatter.name) ?? fallbackName;
    if (name.length > MAX_PERSONA_NAME_CHARS || !PERSONA_NAME_PATTERN.test(name)) {
        throw new Error(`invalid name "${name}"; use at most ${MAX_PERSONA_NAME_CHARS} lowercase letters, digits, and internal hyphens`);
    }
    if (!body.trim()) throw new Error("system prompt body is empty");

    const contextRequirementsValue = stringValue(frontmatter["context-requirements"]);
    const contextRequirements = contextRequirementsValue
        ? normalizePersonaContextRequirements(contextRequirementsValue)
        : undefined;
    const thinkingValue = stringValue(frontmatter.thinking);
    if (thinkingValue && !THINKING_LEVELS.has(thinkingValue as ChildThinkingLevel)) {
        throw new Error(`invalid thinking level "${thinkingValue}"`);
    }
    const preferredLifetimeValue = stringValue(frontmatter["preferred-lifetime"]);
    if (preferredLifetimeValue && !SUBAGENT_LIFETIMES.includes(preferredLifetimeValue as SubagentLifetime)) {
        throw new Error(`invalid preferred-lifetime "${preferredLifetimeValue}"; use one-shot, task, or persistent`);
    }

    const extensionValues = unique([
        ...stringList(frontmatter.extension),
        ...stringList(frontmatter.extensions),
    ]);
    const skillValues = unique([
        ...stringList(frontmatter.skill),
        ...stringList(frontmatter.skills),
    ]);
    const extensions = extensionValues.map((value) => resolvePersonaPath(value, filePath));
    const missingExtension = extensions.find((extension) => !fs.existsSync(extension));
    if (missingExtension) throw new Error(`extension path does not exist: ${missingExtension}`);
    const skills = skillValues.map((value) => resolvePersonaPath(value, filePath));
    const missingSkill = skills.find((skill) => !fs.existsSync(skill));
    if (missingSkill) throw new Error(`skill path does not exist: ${missingSkill}`);

    return {
        name,
        description: normalizePersonaDescription(
            stringValue(frontmatter.description) ?? `Run the ${name} child persona`,
        ),
        systemPrompt: body.trim(),
        ...(contextRequirements ? { contextRequirements } : {}),
        ...(preferredLifetimeValue ? { preferredLifetime: preferredLifetimeValue as SubagentLifetime } : {}),
        extensions,
        skills,
        ...(stringValue(frontmatter.model) ? { model: stringValue(frontmatter.model) } : {}),
        ...(thinkingValue ? { thinking: thinkingValue as ChildThinkingLevel } : {}),
        filePath,
    };
}

export function loadChildPersonas(directory: string): ChildPersonaDiscovery {
    const personas: ChildPersona[] = [];
    const diagnostics: string[] = [];
    if (!fs.existsSync(directory)) return { personas, diagnostics };

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        return {
            personas,
            diagnostics: [`Could not read child persona directory ${directory}: ${error instanceof Error ? error.message : String(error)}`],
        };
    }

    const seen = new Map<string, string>();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        const filePath = path.join(directory, entry.name);
        try {
            const persona = loadPersona(filePath);
            const previous = seen.get(persona.name);
            if (previous) {
                diagnostics.push(`Ignored duplicate child persona "${persona.name}" in ${filePath}; already defined by ${previous}`);
                continue;
            }
            seen.set(persona.name, filePath);
            personas.push(persona);
        } catch (error) {
            diagnostics.push(`Ignored child persona ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return { personas, diagnostics };
}

export function loadChildPersonasFromDirectories(directories: readonly string[]): ChildPersonaDiscovery {
    const personas = new Map<string, ChildPersona>();
    const diagnostics: string[] = [];
    for (const directory of [...new Set(directories)]) {
        const discovery = loadChildPersonas(directory);
        diagnostics.push(...discovery.diagnostics);
        for (const persona of discovery.personas) personas.set(persona.name, persona);
    }
    return {
        personas: [...personas.values()].sort((left, right) => left.name.localeCompare(right.name)),
        diagnostics,
    };
}

export function parseChildCommandArgs(args: string): ParsedChildCommand {
    const trimmed = args.trim();
    if (!trimmed) return { mode: "fresh", prompt: "" };
    if (trimmed === "--fork") return { mode: "fork", prompt: "" };
    if (trimmed.startsWith("--fork ") || trimmed.startsWith("--fork\t") || trimmed.startsWith("--fork\n")) {
        return { mode: "fork", prompt: trimmed.slice("--fork".length).trim() };
    }
    if (trimmed.startsWith("--")) {
        const flag = trimmed.split(/\s+/, 1)[0] ?? trimmed;
        return { mode: "fresh", prompt: "", error: `Unknown child option: ${flag}` };
    }
    return { mode: "fresh", prompt: trimmed };
}

export function formatChildModelScope(scopedModels: readonly ChildScopedModel[]): string {
    return scopedModels
        .map(({ provider, id, thinkingLevel }) => `${provider}/${id}${thinkingLevel ? `:${thinkingLevel}` : ""}`)
        .join(",");
}

export function formatSubagentContinuityPrompt(
    name: string | undefined,
    purpose: string,
    lifetime: SubagentLifetime = "persistent",
): string {
    const safeName = name?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() || "subagent";
    const safePurpose = purpose.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const blockerProtocol = [
        "Treat the current request as a hard scope boundary. Inspect supporting context as needed, but do not add adjacent objectives, analysis, or findings.",
        "If missing context, capability, access, or data prevents completion, stop retrying and lead with exactly:",
        "BLOCKED: <reason>",
        "NEEDS: <minimum requirement>",
        "Do not bypass explicit task, project, or user constraints.",
    ];
    if (lifetime === "one-shot") {
        return [
            `You are the one-shot subagent "${safeName}".`,
            `Purpose: ${safePurpose}`,
            "Return a complete, concise answer in this response.",
            "Do not defer details to a follow-up; keep the response bounded.",
            "Cite file paths and line ranges so the caller can inspect source material.",
            ...blockerProtocol,
        ].join("\n");
    }
    return [
        `You are the ${lifetime === "task" ? "task-scoped" : "persistent"} subagent "${safeName}".`,
        `Purpose: ${safePurpose}`,
        lifetime === "task"
            ? "Preserve continuity through follow-up and validation prompts for this objective."
            : "Preserve continuity across prompts within this purpose.",
        "Make each response decision-complete for the current request: include concise conclusions and all required findings or deliverables.",
        "For long supplemental detail, include a numbered section index and provide those sections on follow-up.",
        "Cite file paths and line ranges so the caller can inspect source material.",
        ...blockerProtocol,
    ].join("\n");
}

export function buildChildProcessArgs(options: ChildProcessOptions): string[] {
    if (options.mode === "fork" && !options.parentSessionFile) {
        throw new Error("Fork mode requires a persisted parent session file");
    }

    if (options.mode === "fork" && options.sessionFile) {
        throw new Error("Fork mode cannot restore an existing child session file");
    }

    const persona = options.persona;
    const args = [
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
    ];

    const modelScope = options.scopedModels?.length ? formatChildModelScope(options.scopedModels) : undefined;
    if (modelScope) args.push("--models", modelScope);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.sessionName) args.push("--name", options.sessionName);

    // A restored session owns its model and thinking history. Model settings are
    // initial defaults only when creating a fresh or forked subagent.
    if (!options.sessionFile) {
        const model = persona?.model ?? options.model;
        const thinking = persona?.thinking ?? options.thinking;
        if (model) args.push("--model", model);
        if (thinking) args.push("--thinking", thinking);
    }

    if (persona) {
        // A trailing newline prevents a one-line persona body from being mistaken
        // for a file path by Pi's system-prompt resolver.
        args.push("--system-prompt", `${persona.systemPrompt}\n`);
        for (const extension of persona.extensions) args.push("--extension", extension);
        for (const skill of persona.skills) args.push("--skill", skill);
    }
    // Leave --tools unset so the child uses Pi's normal configured tool set.
    // Ambient resources stay disabled to prevent recursive subagent loading.
    if (options.purpose?.trim()) {
        args.push("--append-system-prompt", formatSubagentContinuityPrompt(
            options.sessionName,
            options.purpose,
            options.lifetime,
        ));
    }

    if (options.mode === "fork") args.push("--fork", options.parentSessionFile!);
    else if (options.sessionFile) args.push("--session", options.sessionFile);

    return args;
}
