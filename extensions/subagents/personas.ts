import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { SubagentRuntime, SubagentThinkingLevel } from "./backend.ts";

export type { SubagentRuntime, SubagentThinkingLevel } from "./backend.ts";
export type SubagentContextMode = "fresh" | "fork";
export const SUBAGENT_LIFETIMES = ["one-shot", "task", "persistent"] as const;
export type SubagentLifetime = typeof SUBAGENT_LIFETIMES[number];
export const SUBAGENT_PROFILES = ["fast", "balanced", "deep"] as const;
export type SubagentProfile = typeof SUBAGENT_PROFILES[number];
export const SUBAGENT_COMMAND_HELP_TEXT = `Usage: /subagent [--fork] [prompt]
       /subagent:<persona> [--fork] [prompt]

--fork: Start with parent-session context.
prompt: Free-text initial request.
--help, -h: Show this help.`;
const SUBAGENT_COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
    {
        value: "--fork",
        label: "--fork",
        description: "Start with parent-session context",
    },
];

export interface SubagentScopedModel {
    provider: string;
    id: string;
    thinkingLevel?: SubagentThinkingLevel;
}

export interface CursorPersonaRepository {
    url: string;
    startingRef?: string;
}

export interface SubagentPersona {
    name: string;
    description: string;
    systemPrompt: string;
    runtime: SubagentRuntime;
    contextRequirements?: string;
    preferredLifetime?: SubagentLifetime;
    preferredProfile?: SubagentProfile;
    extensions: string[];
    skills: string[];
    cursorMcps?: string[];
    cursorRepos?: CursorPersonaRepository[];
    filePath: string;
}

export interface SubagentPersonaDiscovery {
    personas: SubagentPersona[];
    diagnostics: string[];
}

export interface ParsedSubagentCommand {
    mode: SubagentContextMode;
    prompt: string;
    error?: string;
}

export interface SubagentProcessOptions {
    mode: SubagentContextMode;
    parentSessionFile?: string;
    sessionFile?: string;
    sessionDir?: string;
    sessionName?: string;
    purpose?: string;
    lifetime?: SubagentLifetime;
    persona?: SubagentPersona;
    model?: string;
    thinking?: SubagentThinkingLevel;
    scopedModels?: readonly SubagentScopedModel[];
    skills?: readonly string[];
}

const PERSONA_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_PERSONA_NAME_CHARS = 64;
const SUBAGENT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_PERSONA_DIRECTORY = path.resolve(SUBAGENT_DIRECTORY, "personas");
export const SUBAGENT_EXTENSION_PATHS = [
    path.resolve(SUBAGENT_DIRECTORY, "../codex-tools/index.ts"),
    path.resolve(SUBAGENT_DIRECTORY, "../prevent-idle.ts"),
] as const;
const MAX_CONTEXT_REQUIREMENTS_CHARS = 240;
const MAX_PERSONA_DESCRIPTION_CHARS = 240;
export const MAX_CURSOR_PERSONA_MCPS = 8;
export const MAX_CURSOR_PERSONA_MCP_ENTRIES = 64;
export const MAX_CURSOR_PERSONA_MCP_NAME_CHARS = 64;
export const MAX_CURSOR_PERSONA_REPOS = 20;
export const MAX_CURSOR_PERSONA_REPO_ENTRIES = 100;
export const MAX_CURSOR_PERSONA_REF_CHARS = 255;
// The Cursor backend enforces the final 20-repository total after primary-repository deduplication.
const CURSOR_MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GITHUB_REPOSITORY_PATH_PATTERN = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

interface PersonaFrontmatter extends Record<string, unknown> {
    name?: unknown;
    description?: unknown;
    "context-requirements"?: unknown;
    "preferred-lifetime"?: unknown;
    "preferred-profile"?: unknown;
    extension?: unknown;
    extensions?: unknown;
    skill?: unknown;
    skills?: unknown;
    runtime?: unknown;
    "cursor-mcps"?: unknown;
    "cursor-repos"?: unknown;
}

const CURSOR_PERSONA_TOP_LEVEL_FIELDS = new Set<string>([
    "name",
    "description",
    "context-requirements",
    "preferred-lifetime",
    "preferred-profile",
    "extension",
    "extensions",
    "skill",
    "skills",
    "runtime",
    "cursor-mcps",
    "cursor-repos",
]);
const CURSOR_PERSONA_SHARED_STRING_FIELDS = [
    "name",
    "description",
    "context-requirements",
    "preferred-lifetime",
    "preferred-profile",
] as const;

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

function requiredFrontmatterString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function hasFrontmatterField(frontmatter: PersonaFrontmatter, field: string): boolean {
    return Object.prototype.hasOwnProperty.call(frontmatter, field);
}

function validateCursorSharedFrontmatter(frontmatter: PersonaFrontmatter): void {
    const unknown = Object.keys(frontmatter)
        .filter((field) => !CURSOR_PERSONA_TOP_LEVEL_FIELDS.has(field))
        .sort()[0];
    if (unknown) throw new Error(`${unknown} is not valid for runtime cursor-cloud`);
    for (const field of CURSOR_PERSONA_SHARED_STRING_FIELDS) {
        if (hasFrontmatterField(frontmatter, field)) {
            requiredFrontmatterString(frontmatter[field], field);
        }
    }
}

function parseCursorMcpNames(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("cursor-mcps must be a list of names");
    if (value.length > MAX_CURSOR_PERSONA_MCP_ENTRIES) {
        throw new Error(`cursor-mcps exceeds ${MAX_CURSOR_PERSONA_MCP_ENTRIES} entries before deduplication`);
    }
    const names = unique(value.map((entry, index) => {
        const name = requiredFrontmatterString(entry, `cursor-mcps[${index}]`);
        if (name.length > MAX_CURSOR_PERSONA_MCP_NAME_CHARS || !CURSOR_MCP_NAME_PATTERN.test(name)) {
            throw new Error(`invalid cursor-mcps[${index}] name "${name}"`);
        }
        return name;
    }));
    if (names.length > MAX_CURSOR_PERSONA_MCPS) {
        throw new Error(`cursor-mcps exceeds ${MAX_CURSOR_PERSONA_MCPS} names after deduplication`);
    }
    return names;
}

function normalizeCursorRepositoryUrl(value: string, field: string): string {
    const scpMatch = value.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
    if (scpMatch) return `https://github.com/${scpMatch[1]}/${scpMatch[2]}`;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${field} must be a supported GitHub repository URL`);
    }
    const isHttps = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const isSsh = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
    const pathMatch = parsed.pathname.match(GITHUB_REPOSITORY_PATH_PATTERN);
    if ((isHttps || isSsh)
        && parsed.hostname.toLowerCase() === "github.com"
        && !parsed.port
        && !parsed.search
        && !parsed.hash
        && !value.includes("?")
        && !value.includes("#")
        && pathMatch) {
        return `https://github.com/${pathMatch[1]}/${pathMatch[2]}`;
    }
    throw new Error(`${field} must be a credential-free GitHub repository URL without a query or fragment`);
}

function normalizeCursorStartingRef(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    const ref = requiredFrontmatterString(value, field);
    if (ref.length > MAX_CURSOR_PERSONA_REF_CHARS
        || /[\u0000-\u001f\u007f\s~^:?*\[\\]/.test(ref)
        || ref === "@"
        || ref.startsWith("-")
        || ref.startsWith("/")
        || ref.endsWith("/")
        || ref.split("/").some((component) => component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))
        || ref.includes("..")
        || ref.includes("//")
        || ref.includes("@{")) {
        throw new Error(`invalid ${field}`);
    }
    return ref;
}

function parseCursorRepositories(value: unknown): CursorPersonaRepository[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("cursor-repos must be a list of repositories");
    if (value.length > MAX_CURSOR_PERSONA_REPO_ENTRIES) {
        throw new Error(`cursor-repos exceeds ${MAX_CURSOR_PERSONA_REPO_ENTRIES} entries before deduplication`);
    }
    const repositories = new Map<string, CursorPersonaRepository>();
    for (const [index, entry] of value.entries()) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new Error(`cursor-repos[${index}] must be an object`);
        }
        const fields = Object.keys(entry);
        const unknown = fields.find((field) => field !== "url" && field !== "starting-ref");
        if (unknown) throw new Error(`cursor-repos[${index}].${unknown} is not valid`);
        const repository = entry as Record<string, unknown>;
        const url = normalizeCursorRepositoryUrl(
            requiredFrontmatterString(repository.url, `cursor-repos[${index}].url`),
            `cursor-repos[${index}].url`,
        );
        const startingRef = normalizeCursorStartingRef(repository["starting-ref"], `cursor-repos[${index}].starting-ref`);
        const key = url.toLowerCase();
        const existing = repositories.get(key);
        if (existing) {
            if (existing.startingRef !== startingRef) {
                throw new Error(`cursor-repos[${index}].starting-ref conflicts with the duplicate repository URL`);
            }
            continue;
        }
        repositories.set(key, { url, ...(startingRef ? { startingRef } : {}) });
    }
    const normalized = [...repositories.values()];
    if (normalized.length > MAX_CURSOR_PERSONA_REPOS) {
        throw new Error(`cursor-repos exceeds ${MAX_CURSOR_PERSONA_REPOS} repositories after deduplication`);
    }
    return normalized;
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

function loadPersona(filePath: string): SubagentPersona {
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(content);
    const fallbackName = path.basename(filePath, path.extname(filePath));
    const name = stringValue(frontmatter.name) ?? fallbackName;
    if (name.length > MAX_PERSONA_NAME_CHARS || !PERSONA_NAME_PATTERN.test(name)) {
        throw new Error(`invalid name "${name}"; use at most ${MAX_PERSONA_NAME_CHARS} lowercase letters, digits, and internal hyphens`);
    }
    if (!body.trim()) throw new Error("system prompt body is empty");

    const runtimeValue = frontmatter.runtime === undefined
        ? "pi"
        : requiredFrontmatterString(frontmatter.runtime, "runtime");
    if (runtimeValue !== "pi" && runtimeValue !== "cursor-cloud") {
        throw new Error(`invalid runtime "${runtimeValue}"; use pi or cursor-cloud`);
    }
    const runtime = runtimeValue as SubagentRuntime;
    if (hasFrontmatterField(frontmatter, "model")) {
        throw new Error("model is not valid in a persona; use a creation profile");
    }
    if (hasFrontmatterField(frontmatter, "thinking")) {
        throw new Error("thinking is not valid in a persona; use a creation profile");
    }
    if (runtime === "cursor-cloud") validateCursorSharedFrontmatter(frontmatter);
    const cursorMcps = parseCursorMcpNames(frontmatter["cursor-mcps"]);
    const cursorRepos = parseCursorRepositories(frontmatter["cursor-repos"]);
    if (runtime === "pi" && cursorMcps !== undefined) {
        throw new Error("cursor-mcps is only valid for runtime cursor-cloud");
    }
    if (runtime === "pi" && cursorRepos !== undefined) {
        throw new Error("cursor-repos is only valid for runtime cursor-cloud");
    }

    const contextRequirementsValue = stringValue(frontmatter["context-requirements"]);
    const contextRequirements = contextRequirementsValue
        ? normalizePersonaContextRequirements(contextRequirementsValue)
        : undefined;
    const preferredLifetimeValue = stringValue(frontmatter["preferred-lifetime"]);
    if (preferredLifetimeValue && !SUBAGENT_LIFETIMES.includes(preferredLifetimeValue as SubagentLifetime)) {
        throw new Error(`invalid preferred-lifetime "${preferredLifetimeValue}"; use one-shot, task, or persistent`);
    }
    const preferredProfileValue = frontmatter["preferred-profile"] === undefined
        ? undefined
        : requiredFrontmatterString(frontmatter["preferred-profile"], "preferred-profile");
    if (preferredProfileValue && !SUBAGENT_PROFILES.includes(preferredProfileValue as SubagentProfile)) {
        throw new Error(`invalid preferred-profile "${preferredProfileValue}"; use fast, balanced, or deep`);
    }

    const extensionValues = unique([
        ...stringList(frontmatter.extension),
        ...stringList(frontmatter.extensions),
    ]);
    const skillValues = unique([
        ...stringList(frontmatter.skill),
        ...stringList(frontmatter.skills),
    ]);
    if (runtime === "cursor-cloud" && (hasFrontmatterField(frontmatter, "extension") || hasFrontmatterField(frontmatter, "extensions"))) {
        throw new Error("extensions is not valid for runtime cursor-cloud");
    }
    if (runtime === "cursor-cloud" && (hasFrontmatterField(frontmatter, "skill") || hasFrontmatterField(frontmatter, "skills"))) {
        throw new Error("skills is not valid for runtime cursor-cloud");
    }
    const extensions = extensionValues.map((value) => resolvePersonaPath(value, filePath));
    const missingExtension = extensions.find((extension) => !fs.existsSync(extension));
    if (missingExtension) throw new Error(`extension path does not exist: ${missingExtension}`);
    const skills = skillValues.map((value) => resolvePersonaPath(value, filePath));
    const missingSkill = skills.find((skill) => !fs.existsSync(skill));
    if (missingSkill) throw new Error(`skill path does not exist: ${missingSkill}`);

    return {
        name,
        description: normalizePersonaDescription(
            stringValue(frontmatter.description) ?? `Run the ${name} subagent persona`,
        ),
        systemPrompt: body.trim(),
        runtime,
        ...(contextRequirements ? { contextRequirements } : {}),
        ...(preferredLifetimeValue ? { preferredLifetime: preferredLifetimeValue as SubagentLifetime } : {}),
        ...(preferredProfileValue ? { preferredProfile: preferredProfileValue as SubagentProfile } : {}),
        extensions,
        skills,
        ...(cursorMcps?.length ? { cursorMcps } : {}),
        ...(cursorRepos?.length ? { cursorRepos } : {}),
        filePath,
    };
}

export function loadSubagentPersonas(directory: string): SubagentPersonaDiscovery {
    const personas: SubagentPersona[] = [];
    const diagnostics: string[] = [];
    if (!fs.existsSync(directory)) return { personas, diagnostics };

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        return {
            personas,
            diagnostics: [`Could not read subagent persona directory ${directory}: ${error instanceof Error ? error.message : String(error)}`],
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
                diagnostics.push(`Ignored duplicate subagent persona "${persona.name}" in ${filePath}; already defined by ${previous}`);
                continue;
            }
            seen.set(persona.name, filePath);
            personas.push(persona);
        } catch (error) {
            diagnostics.push(`Ignored subagent persona ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return { personas, diagnostics };
}

export function loadSubagentPersonasFromDirectories(directories: readonly string[]): SubagentPersonaDiscovery {
    const personas = new Map<string, SubagentPersona>();
    const diagnostics: string[] = [];
    for (const directory of [...new Set(directories)]) {
        const discovery = loadSubagentPersonas(directory);
        diagnostics.push(...discovery.diagnostics);
        for (const persona of discovery.personas) personas.set(persona.name, persona);
    }
    return {
        personas: [...personas.values()].sort((left, right) => left.name.localeCompare(right.name)),
        diagnostics,
    };
}

export function parseSubagentCommandArgs(args: string): ParsedSubagentCommand {
    const trimmed = args.trim();
    if (!trimmed) return { mode: "fresh", prompt: "" };
    if (trimmed === "--fork") return { mode: "fork", prompt: "" };
    if (trimmed.startsWith("--fork ") || trimmed.startsWith("--fork\t") || trimmed.startsWith("--fork\n")) {
        return { mode: "fork", prompt: trimmed.slice("--fork".length).trim() };
    }
    if (trimmed.startsWith("--")) {
        const flag = trimmed.split(/\s+/, 1)[0] ?? trimmed;
        return { mode: "fresh", prompt: "", error: `Unknown subagent option: ${flag}` };
    }
    return { mode: "fresh", prompt: trimmed };
}

export function getSubagentCommandArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    if (/\s/.test(argumentPrefix)) return null;

    const completions = SUBAGENT_COMMAND_COMPLETIONS.filter((item) =>
        item.value.startsWith(argumentPrefix));
    return completions.length > 0 ? completions : null;
}

export function formatSubagentModelScope(scopedModels: readonly SubagentScopedModel[]): string {
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

export function buildSubagentProcessArgs(options: SubagentProcessOptions): string[] {
    if (options.mode === "fork" && !options.parentSessionFile) {
        throw new Error("Fork mode requires a persisted parent session file");
    }

    if (options.mode === "fork" && options.sessionFile) {
        throw new Error("Fork mode cannot restore an existing subagent session file");
    }

    const persona = options.persona;
    if (persona?.runtime === "cursor-cloud") {
        throw new Error(`Pi process arguments require runtime pi; persona "${persona.name}" uses ${persona.runtime}`);
    }
    const args = [
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
    ];

    for (const extension of SUBAGENT_EXTENSION_PATHS) args.push("--extension", extension);

    const modelScope = options.scopedModels?.length ? formatSubagentModelScope(options.scopedModels) : undefined;
    if (modelScope) args.push("--models", modelScope);
    if (options.sessionDir) args.push("--session-dir", options.sessionDir);
    if (options.sessionName) args.push("--name", options.sessionName);

    // A restored session owns its model and thinking history. Model settings are
    // initial defaults only when creating a fresh or forked subagent.
    if (!options.sessionFile) {
        if (options.model) args.push("--model", options.model);
        if (options.thinking) args.push("--thinking", options.thinking);
    }

    if (persona) {
        // A trailing newline prevents a one-line persona body from being mistaken
        // for a file path by Pi's system-prompt resolver.
        args.push("--system-prompt", `${persona.systemPrompt}\n`);
        for (const extension of persona.extensions) {
            if (!SUBAGENT_EXTENSION_PATHS.some((defaultExtension) => defaultExtension === extension)) {
                args.push("--extension", extension);
            }
        }
    }
    const skillPaths = new Set<string>();
    // Persona skills take priority for restored records created before same-name
    // conflicts were rejected at creation.
    for (const skill of persona?.skills ?? []) skillPaths.add(skill);
    for (const skill of options.skills ?? []) skillPaths.add(skill);
    for (const skill of skillPaths) args.push("--skill", skill);
    // Leave --tools unset so the subagent uses Pi's normal configured tool set.
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
