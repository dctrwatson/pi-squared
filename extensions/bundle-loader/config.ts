import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { formatSkillsForPrompt, getAgentDir, loadSkills, type Skill } from "@earendil-works/pi-coding-agent";

export const MAX_BUNDLE_SKILL_METADATA_CHARS = 16_000;
const MANIFEST_VERSION = 1;

export interface BundleRegistry {
  bundles: Record<string, string>;
  error?: string;
}

export interface BundleManifest {
  adapter?: string;
  skills: Skill[];
}

export class BundleContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandPath(path: string, base: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(isAbsolute(trimmed) ? trimmed : join(base, trimmed));
}

function readRegularFile(path: string, label: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
    if (!statSync(canonicalPath).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new BundleContractError(`${label} must be a readable file: ${path}`, { cause: error });
  }
  return canonicalPath;
}

function checkFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new BundleContractError(`${label} has unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

/** Read the registry once and resolve each manifest path from the registry directory. */
export function readRegistry(path = join(getAgentDir(), "bundle-loader.json")): BundleRegistry {
  if (!existsSync(path)) return { bundles: {} };

  try {
    const registryPath = realpathSync(path);
    if (!statSync(registryPath).isFile()) throw new BundleContractError("Registry must be a regular file");
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    if (!isRecord(parsed)) throw new BundleContractError("Registry must be an object");
    checkFields(parsed, ["bundles"], "Registry");
    if (!isRecord(parsed.bundles)) throw new BundleContractError('Registry field "bundles" must be an object');

    const bundles: Record<string, string> = {};
    for (const [name, configuredPath] of Object.entries(parsed.bundles)) {
      if (!name || /[\s\p{Cc}\p{Cf}]/u.test(name) || ["__proto__", "prototype", "constructor"].includes(name)) {
        throw new BundleContractError(`Invalid bundle name: ${JSON.stringify(name)}`);
      }
      if (typeof configuredPath !== "string" || !configuredPath.trim()) {
        throw new BundleContractError(`Bundle "${name}" must have a non-empty manifest path`);
      }
      bundles[name] = expandPath(configuredPath, dirname(registryPath));
    }
    return { bundles };
  } catch (error) {
    return { bundles: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Keep valid skills by canonical file path and reject name or context collisions. */
export function validateSkills(skills: readonly Skill[], existingSkills: readonly Skill[] = []): Skill[] {
  const existingByPath = new Set<string>();
  const namesByPath = new Map<string, string>();
  for (const skill of existingSkills) {
    const canonicalPath = readRegularFile(skill.filePath, "Existing skill");
    existingByPath.add(canonicalPath);
    if (!namesByPath.has(skill.name)) namesByPath.set(skill.name, canonicalPath);
  }

  const selectedByPath = new Map<string, Skill>();
  const selectedNames = new Map<string, string>();
  for (const skill of skills) {
    const canonicalPath = readRegularFile(skill.filePath, "Skill");
    if (basename(canonicalPath) !== "SKILL.md") {
      throw new BundleContractError(`Skill path must end with SKILL.md: ${skill.filePath}`);
    }
    if (existingByPath.has(canonicalPath) || selectedByPath.has(canonicalPath)) continue;

    const existingPath = namesByPath.get(skill.name);
    if (existingPath && existingPath !== canonicalPath) {
      throw new BundleContractError(`Skill name "${skill.name}" is already used by another file`);
    }
    const selectedPath = selectedNames.get(skill.name);
    if (selectedPath && selectedPath !== canonicalPath) {
      throw new BundleContractError(`Selected skills have a name collision: "${skill.name}"`);
    }
    selectedByPath.set(canonicalPath, skill);
    selectedNames.set(skill.name, canonicalPath);
  }

  const uniqueSkills = [...selectedByPath.values()];
  const metadataChars = formatSkillsForPrompt(uniqueSkills).length;
  if (metadataChars > MAX_BUNDLE_SKILL_METADATA_CHARS) {
    throw new BundleContractError(`Selected skill metadata uses ${metadataChars} characters; limit is ${MAX_BUNDLE_SKILL_METADATA_CHARS}`);
  }
  return uniqueSkills;
}

/** Read one manifest and load only its explicit SKILL.md file paths. */
export function loadManifest(path: string): BundleManifest {
  const manifestPath = readRegularFile(resolve(path), "Manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new BundleContractError(`Manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new BundleContractError("Manifest must be an object");
  checkFields(parsed, ["version", "adapter", "skills"], "Manifest");
  if (parsed.version !== MANIFEST_VERSION) throw new BundleContractError(`Manifest version must be ${MANIFEST_VERSION}`);

  let adapter: string | undefined;
  if (parsed.adapter !== undefined) {
    if (typeof parsed.adapter !== "string" || !parsed.adapter.trim()) {
      throw new BundleContractError('Manifest field "adapter" must be a non-empty path');
    }
    adapter = readRegularFile(expandPath(parsed.adapter, dirname(manifestPath)), "Adapter");
  }

  const configuredSkills = parsed.skills === undefined ? [] : parsed.skills;
  if (!Array.isArray(configuredSkills) || !configuredSkills.every((skillPath) => typeof skillPath === "string" && skillPath.trim())) {
    throw new BundleContractError('Manifest field "skills" must be an array of non-empty paths');
  }
  const skillPaths = [...new Set(configuredSkills.map((skillPath) => {
    const resolvedSkillPath = expandPath(skillPath, dirname(manifestPath));
    if (basename(resolvedSkillPath) !== "SKILL.md") {
      throw new BundleContractError(`Skill path must end with SKILL.md: ${skillPath}`);
    }
    const canonicalPath = readRegularFile(resolvedSkillPath, "Skill");
    if (basename(canonicalPath) !== "SKILL.md") {
      throw new BundleContractError(`Skill path must resolve to SKILL.md: ${skillPath}`);
    }
    return canonicalPath;
  }))];

  let skills: Skill[] = [];
  if (skillPaths.length > 0) {
    const result = loadSkills({
      cwd: dirname(manifestPath),
      agentDir: getAgentDir(),
      skillPaths,
      includeDefaults: false,
    });
    if (result.diagnostics.length > 0) {
      const details = result.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
      throw new BundleContractError(`Manifest has invalid skill files: ${details}`);
    }
    if (result.skills.length !== skillPaths.length) {
      throw new BundleContractError("Manifest did not load every explicit skill file");
    }
    skills = validateSkills(result.skills);
  }

  return { ...(adapter ? { adapter } : {}), skills };
}
