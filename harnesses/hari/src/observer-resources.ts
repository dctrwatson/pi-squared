import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SubagentPersona } from "../../../extensions/subagents/personas.ts";
import { CoordinationError, integrationResources, type LauncherConfig } from "./coordination.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OBSERVER_PERSONA = "hari-session-observer";
export const OBSERVER_PERSONA_DIRECTORY = join(harnessRoot, "personas");
export const OBSERVER_POLICY_PATH = join(harnessRoot, "src", "observer-policy.ts");
export type ObserverSubagentModule = Pick<typeof import("../../../extensions/subagents/index.ts"),
  "default" | "loadSubagentPersonas" | "SUBAGENT_EXTENSION_CAPABILITIES">;

export function isObserverPersona(persona: SubagentPersona | undefined): persona is SubagentPersona {
  return Boolean(persona && persona.name === OBSERVER_PERSONA && persona.runtime === "pi"
    && persona.extensions.length === 1 && resolve(persona.extensions[0]) === OBSERVER_POLICY_PATH
    && persona.skills.length === 0);
}

/** Check explicit resources without starting a helper or changing saved settings. */
export async function loadSessionObserverResources(config: LauncherConfig): Promise<{ module: ObserverSubagentModule; persona: SubagentPersona }> {
  for (const path of [OBSERVER_POLICY_PATH, join(OBSERVER_PERSONA_DIRECTORY, "session-observer.md")]) {
    try {
      if (!(await lstat(path)).isFile()) throw new Error("not a regular file");
    } catch {
      throw new CoordinationError(`Missing Hari observer resource: ${path}`);
    }
  }
  const { subagentExtension } = integrationResources(config);
  const module = await import(pathToFileURL(subagentExtension).href) as ObserverSubagentModule;
  if (typeof module.default !== "function" || typeof module.loadSubagentPersonas !== "function"
    || module.SUBAGENT_EXTENSION_CAPABILITIES?.validateRestoredSubagent !== true) {
    throw new CoordinationError("Configured subagent extension lacks validateRestoredSubagent; use a compatible pi-squared checkout with hari init --pi-squared <checkout>");
  }
  const discovery = module.loadSubagentPersonas(OBSERVER_PERSONA_DIRECTORY);
  if (discovery.diagnostics.length || discovery.personas.length !== 1 || !isObserverPersona(discovery.personas[0])) {
    throw new CoordinationError(`Hari observer persona resources are invalid: ${discovery.diagnostics.join("; ") || "expected only the explicit Pi session observer"}`);
  }
  return { module, persona: discovery.personas[0] };
}
