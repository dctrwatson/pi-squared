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
import { join, resolve } from "node:path";
import { getAgentDir, loadSkillsFromDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";

interface SkillLoaderConfig {
	roots?: unknown;
}

const configPath = join(getAgentDir(), "skill-loader.json");
const runtimeStateKey = "__pi_squared_skill_loader_runtime_state__";

interface RuntimeState {
	openPickerOnReload: boolean;
}

function getRuntimeState(): RuntimeState {
	const runtime = globalThis as typeof globalThis & { [runtimeStateKey]?: RuntimeState };
	return (runtime[runtimeStateKey] ??= { openPickerOnReload: false });
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
		return { roots: [...new Set(config.roots.map(resolveRoot).filter(Boolean))] };
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
		for (const skill of result.skills) skillsByPath.set(skill.filePath, skill);
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

function skillOption(skill: Skill, index: number, selected: boolean): string {
	const description = skill.description.replace(/\s+/g, " ").trim();
	const preview = description.length > 70 ? `${description.slice(0, 67)}...` : description;
	const source = skill.filePath.startsWith(homedir()) ? `~${skill.filePath.slice(homedir().length)}` : skill.filePath;
	const sourcePreview = source.length > 70 ? `...${source.slice(-67)}` : source;
	return `${selected ? "✓" : " "} ${index + 1}. ${skill.name}${preview ? ` — ${preview}` : ""} [${sourcePreview}]`;
}

async function selectSkills(skills: Skill[], ctx: ExtensionContext): Promise<string[]> {
	const selected = new Set<string>();

	while (true) {
		const loadOption = `Load ${selected.size} selected skill${selected.size === 1 ? "" : "s"}`;
		const cancelOption = "Cancel";
		const options = [
			loadOption,
			cancelOption,
			...skills.map((skill, index) => skillOption(skill, index, selected.has(skill.filePath))),
		];
		const choice = await ctx.ui.select("Skill Loader — toggle skills, then load", options);

		if (choice === undefined || choice === cancelOption) return [];
		if (choice === loadOption) {
			return skills.filter((skill) => selected.has(skill.filePath)).map((skill) => skill.filePath);
		}

		const index = options.indexOf(choice) - 2;
		const skill = skills[index];
		if (!skill) continue;
		if (selected.has(skill.filePath)) {
			selected.delete(skill.filePath);
		} else {
			// Pi keeps the first skill on a name collision. Selecting one here should
			// therefore replace any same-name selection instead of loading both.
			for (const other of skills) {
				if (other.name === skill.name) selected.delete(other.filePath);
			}
			selected.add(skill.filePath);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (_event, ctx) => {
		const runtimeState = getRuntimeState();
		if (!runtimeState.openPickerOnReload) return { skillPaths: [] };
		runtimeState.openPickerOnReload = false;
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("Skill Loader requires TUI mode.", "error");
			return { skillPaths: [] };
		}

		const { roots, error } = readRoots();
		if (error) {
			ctx.ui.notify(`Skill Loader config error: ${error}`, "error");
			return { skillPaths: [] };
		}
		if (roots.length === 0) {
			ctx.ui.notify(`No skill roots configured. Add roots to ${configPath}`, "warning");
			return { skillPaths: [] };
		}

		const { skills, missingRoots, invalidRoots, diagnostics, duplicateNames } = discoverSkills(roots);
		if (missingRoots.length > 0) {
			ctx.ui.notify(`Skill Loader could not find: ${missingRoots.join(", ")}`, "warning");
		}
		if (invalidRoots.length > 0) {
			ctx.ui.notify(`Skill Loader roots must be directories: ${invalidRoots.join(", ")}`, "warning");
		}
		if (diagnostics.length > 0) {
			const summary = diagnostics.slice(0, 3).join("\n");
			ctx.ui.notify(`Skill Loader found invalid skill metadata:\n${summary}${diagnostics.length > 3 ? "\n..." : ""}`, "warning");
		}
		if (duplicateNames.length > 0) {
			ctx.ui.notify(`Duplicate skill names found: ${duplicateNames.join(", ")}. Selecting one replaces the other.`, "warning");
		}
		if (skills.length === 0) {
			ctx.ui.notify("Skill Loader found no skills in the configured roots.", "warning");
			return { skillPaths: [] };
		}

		return { skillPaths: await selectSkills(skills, ctx) };
	});

	pi.registerCommand("skill-loader", {
		description: "Choose skills from configured roots",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Skill Loader requires TUI mode.", "error");
				return;
			}
			// /reload creates a new extension instance, so use process-local state to
			// carry this one-shot request to that instance without persisting it.
			const runtimeState = getRuntimeState();
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
