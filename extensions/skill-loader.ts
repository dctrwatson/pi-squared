/**
 * Skill Loader
 *
 * Discovers skills under roots configured in ~/.pi/agent/skill-loader.json and
 * lets the user choose which ones to load for the current runtime. Selections
 * are intentionally not persisted: run /skill-loader to choose again without
 * restarting Pi. Startup, session switches, and /reload never open the picker.
 *
 * Configuration:
 * {
 *   "roots": ["/absolute/path/to/skills", "~/shared-skills"]
 * }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { formatSkillsForPrompt, getAgentDir, loadSkillsFromDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";

interface SkillLoaderConfig {
	roots?: unknown;
}

const configPath = join(getAgentDir(), "skill-loader.json");
const runtimeStateKey = "__pi_squared_skill_loader_runtime_state__";

interface RuntimeState {
	openPickerOnReload: boolean;
	selectedPaths: string[];
	activeSkillNames: string[];
	activeSkillNamesKnown: boolean;
}

function getRuntimeState(): RuntimeState {
	const runtime = globalThis as typeof globalThis & { [runtimeStateKey]?: Partial<RuntimeState> };
	const state = (runtime[runtimeStateKey] ??= {});
	state.openPickerOnReload = state.openPickerOnReload === true;
	state.selectedPaths = Array.isArray(state.selectedPaths)
		? state.selectedPaths.filter((value): value is string => typeof value === "string")
		: [];
	state.activeSkillNames = Array.isArray(state.activeSkillNames)
		? state.activeSkillNames.filter((value): value is string => typeof value === "string")
		: [];
	state.activeSkillNamesKnown = state.activeSkillNamesKnown === true;
	return state as RuntimeState;
}

function resolveRoot(root: string): string {
	const trimmed = root.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return resolve(getAgentDir(), trimmed);
}

export function readRoots(path = configPath): { roots: string[]; error?: string } {
	if (!existsSync(path)) return { roots: [] };

	try {
		const config = JSON.parse(readFileSync(path, "utf-8")) as SkillLoaderConfig;
		if (config.roots === undefined) return { roots: [] };
		if (!Array.isArray(config.roots) || !config.roots.every((root) => typeof root === "string")) {
			return { roots: [], error: '"roots" must be an array of strings' };
		}
		if (config.roots.some((root) => !root.trim())) {
			return { roots: [], error: '"roots" must not contain empty paths' };
		}
		return { roots: [...new Set(config.roots.map(resolveRoot))] };
	} catch (error) {
		return { roots: [], error: error instanceof Error ? error.message : String(error) };
	}
}

interface SkillDiscovery {
	skills: Skill[];
	missingRoots: string[];
	invalidRoots: string[];
	diagnostics: string[];
	duplicateNames: string[];
}

export function discoverSkills(roots: string[]): SkillDiscovery {
	const skillsByPath = new Map<string, Skill>();
	const missingRoots: string[] = [];
	const invalidRoots: string[] = [];
	const diagnostics: string[] = [];

	for (const root of roots) {
		if (!existsSync(root)) {
			missingRoots.push(root);
			continue;
		}
		try {
			if (!statSync(root).isDirectory()) {
				invalidRoots.push(root);
				continue;
			}
		} catch {
			invalidRoots.push(root);
			continue;
		}

		const result = loadSkillsFromDir({ dir: root, source: "extension:skill-loader" });
		const invalidSkillPaths = new Set(result.diagnostics.flatMap((diagnostic) =>
			diagnostic.path ? [diagnostic.path] : []));
		for (const skill of result.skills) {
			if (!invalidSkillPaths.has(skill.filePath)) skillsByPath.set(skill.filePath, skill);
		}
		for (const diagnostic of result.diagnostics) {
			diagnostics.push(`${diagnostic.path ?? root}: ${diagnostic.message}`);
		}
	}

	const skills = [...skillsByPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
	const names = new Map<string, number>();
	for (const skill of skills) names.set(skill.name, (names.get(skill.name) ?? 0) + 1);

	return {
		skills,
		missingRoots,
		invalidRoots,
		diagnostics,
		duplicateNames: [...names.entries()].filter(([, count]) => count > 1).map(([name]) => name),
	};
}

export const MAX_SELECTED_SKILL_METADATA_CHARS = 16_000;

function displayText(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function selectedMetadataChars(skills: readonly Skill[], selected: ReadonlySet<string>): number {
	return formatSkillsForPrompt(skills.filter((skill) => selected.has(skill.filePath))).length;
}

function validPreviousPaths(
	skills: readonly Skill[],
	previousPaths: readonly string[],
	activeSkillNames: ReadonlySet<string>,
): string[] {
	const available = new Map(skills.map((skill) => [skill.filePath, skill]));
	const valid = previousPaths.filter((skillPath) => {
		const skill = available.get(skillPath);
		return skill !== undefined && !activeSkillNames.has(skill.name);
	});
	return selectedMetadataChars(skills, new Set(valid)) <= MAX_SELECTED_SKILL_METADATA_CHARS ? valid : [];
}

function validateStoredPaths(
	previousPaths: readonly string[],
	activeSkillNames: ReadonlySet<string>,
): string[] {
	const roots = [...new Set(previousPaths.map((skillPath) => dirname(skillPath)))];
	const discovery = discoverSkills(roots);
	return validPreviousPaths(discovery.skills, previousPaths, activeSkillNames);
}

function skillOption(skill: Skill, index: number, selected: boolean, nameConflict: boolean): string {
	const description = displayText(skill.description).replace(/\s+/g, " ").trim();
	const preview = description.length > 70 ? `${description.slice(0, 67)}...` : description;
	const home = homedir();
	const source = skill.filePath === home || skill.filePath.startsWith(`${home}${sep}`)
		? `~${skill.filePath.slice(home.length)}`
		: skill.filePath;
	const sourcePreview = displayText(source.length > 70 ? `...${source.slice(-67)}` : source);
	const commandOnly = skill.disableModelInvocation ? " · command-only" : "";
	const conflict = nameConflict ? " · name already loaded" : "";
	return `${selected ? "✓" : " "} ${index + 1}. ${displayText(skill.name)}${commandOnly}${conflict}${preview ? ` — ${preview}` : ""} [${sourcePreview}]`;
}

async function selectSkills(
	skills: Skill[],
	ctx: ExtensionContext,
	previousPaths: readonly string[],
	activeSkillNames: ReadonlySet<string>,
): Promise<string[] | undefined> {
	const availablePaths = new Set(skills.map((skill) => skill.filePath));
	const selected = new Set(previousPaths.filter((skillPath) => availablePaths.has(skillPath)));

	while (true) {
		const metadataChars = selectedMetadataChars(skills, selected);
		const loadOption = `Load ${selected.size} selected skill${selected.size === 1 ? "" : "s"} (${metadataChars.toLocaleString()} model-context chars)`;
		const cancelOption = "Cancel";
		const options = [
			loadOption,
			cancelOption,
			...skills.map((skill, index) => skillOption(
				skill,
				index,
				selected.has(skill.filePath),
				activeSkillNames.has(skill.name),
			)),
		];
		const choice = await ctx.ui.select("Skill Loader — toggle skills, then load", options);

		if (choice === undefined || choice === cancelOption) return undefined;
		if (choice === loadOption) {
			if (metadataChars > MAX_SELECTED_SKILL_METADATA_CHARS) {
				ctx.ui.notify("Remove skills until the model-context metadata is within the limit.", "warning");
				continue;
			}
			return skills.filter((skill) => selected.has(skill.filePath)).map((skill) => skill.filePath);
		}

		const index = options.indexOf(choice) - 2;
		const skill = skills[index];
		if (!skill) continue;
		if (selected.has(skill.filePath)) {
			selected.delete(skill.filePath);
		} else {
			if (activeSkillNames.has(skill.name)) {
				ctx.ui.notify(`A skill named ${displayText(skill.name)} is already loaded. Choose a different skill.`, "warning");
				continue;
			}
			const candidate = new Set(selected);
			// Pi keeps the first skill on a name collision. Replace a selected collision.
			for (const other of skills) {
				if (other.name === skill.name) candidate.delete(other.filePath);
			}
			candidate.add(skill.filePath);
			const candidateChars = selectedMetadataChars(skills, candidate);
			if (candidateChars > MAX_SELECTED_SKILL_METADATA_CHARS) {
				ctx.ui.notify(
					`Skill metadata would use ${candidateChars.toLocaleString()} model-context characters. The limit is ${MAX_SELECTED_SKILL_METADATA_CHARS.toLocaleString()}. Remove another skill first.`,
					"warning",
				);
				continue;
			}
			selected.clear();
			for (const skillPath of candidate) selected.add(skillPath);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (_event, ctx) => {
		const runtimeState = getRuntimeState();
		if (!runtimeState.openPickerOnReload) {
			runtimeState.selectedPaths = [];
			runtimeState.activeSkillNames = [];
			runtimeState.activeSkillNamesKnown = false;
			return { skillPaths: [] };
		}
		runtimeState.openPickerOnReload = false;
		const previousPaths = runtimeState.selectedPaths.filter((skillPath) => existsSync(skillPath));
		const activeSkillNames = new Set(runtimeState.activeSkillNames);
		const clearSelection = () => {
			runtimeState.selectedPaths = [];
			return { skillPaths: [] };
		};
		const preserveStoredSelection = () => {
			runtimeState.selectedPaths = validateStoredPaths(previousPaths, activeSkillNames);
			return { skillPaths: runtimeState.selectedPaths };
		};
		if (!runtimeState.activeSkillNamesKnown) {
			if (ctx.hasUI) {
				ctx.ui.notify("Skill Loader updated its runtime state. Run /skill-loader again to choose skills.", "info");
			}
			return clearSelection();
		}
		if (!ctx.hasUI) return preserveStoredSelection();

		const { roots, error } = readRoots();
		if (error) {
			ctx.ui.notify(`Skill Loader config error: ${displayText(error)}`, "error");
			return preserveStoredSelection();
		}
		if (roots.length === 0) {
			ctx.ui.notify(`No skill roots configured. Add roots to ${displayText(configPath)}`, "warning");
			return preserveStoredSelection();
		}

		const { skills, missingRoots, invalidRoots, diagnostics, duplicateNames } = discoverSkills(roots);
		if (missingRoots.length > 0) {
			ctx.ui.notify(`Skill Loader could not find: ${displayText(missingRoots.join(", "))}`, "warning");
		}
		if (invalidRoots.length > 0) {
			ctx.ui.notify(`Skill Loader roots must be directories: ${displayText(invalidRoots.join(", "))}`, "warning");
		}
		if (diagnostics.length > 0) {
			const summary = displayText(diagnostics.slice(0, 3).join("\n"));
			ctx.ui.notify(`Skill Loader found invalid skill metadata:\n${summary}${diagnostics.length > 3 ? "\n..." : ""}`, "warning");
		}
		if (duplicateNames.length > 0) {
			ctx.ui.notify(`Duplicate skill names found: ${displayText(duplicateNames.join(", "))}. Selecting one replaces the other.`, "warning");
		}
		if (skills.length === 0) {
			ctx.ui.notify("Skill Loader found no valid skills in the configured roots.", "warning");
			return clearSelection();
		}

		const preservedPaths = validPreviousPaths(skills, previousPaths, activeSkillNames);
		if (previousPaths.length !== preservedPaths.length) {
			ctx.ui.notify("Some previously selected skills are no longer valid or exceed the model-context limit.", "warning");
		}
		const selectedPaths = await selectSkills(skills, ctx, preservedPaths, activeSkillNames);
		runtimeState.selectedPaths = selectedPaths ?? preservedPaths;
		return { skillPaths: runtimeState.selectedPaths };
	});

	pi.registerCommand("skill-loader", {
		description: "Choose skills from configured roots",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			// /reload creates a new extension instance, so use process-local state to
			// carry this one-shot request to that instance without persisting it.
			const runtimeState = getRuntimeState();
			const loadedSkills = ctx.getSystemPromptOptions().skills ?? [];
			runtimeState.selectedPaths = loadedSkills
				.filter((skill) => skill.sourceInfo.source === "extension:skill-loader")
				.map((skill) => skill.filePath);
			runtimeState.activeSkillNames = loadedSkills
				.filter((skill) => skill.sourceInfo.source !== "extension:skill-loader")
				.map((skill) => skill.name);
			runtimeState.activeSkillNamesKnown = true;
			runtimeState.openPickerOnReload = true;
			try {
				await ctx.reload();
			} finally {
				runtimeState.openPickerOnReload = false;
			}
			return;
		},
	});
}
