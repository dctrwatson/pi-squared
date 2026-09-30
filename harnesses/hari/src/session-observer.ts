import { dirname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { PersistentSubagentSummary, StoredSubagent } from "../../../extensions/subagents/registry.ts";
import { CoordinationError, coordinationDirectory, readLauncherConfig } from "./coordination.ts";
import { isObserverPersona, loadSessionObserverResources, OBSERVER_PERSONA, OBSERVER_PERSONA_DIRECTORY, type ObserverSubagentModule } from "./observer-resources.ts";
import type { SubagentPersona } from "../../../extensions/subagents/personas.ts";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
type RegisterHandler = (name: string, handler: Handler) => () => void;

/** Reuse the native helper lifecycle. Permit only explicit read-only Pi observers. */
export function registerSessionObserver(
  pi: ExtensionAPI,
  module: ObserverSubagentModule,
  persona: SubagentPersona,
  coordinationDir: string,
): void {
  if (module.SUBAGENT_EXTENSION_CAPABILITIES?.validateRestoredSubagent !== true || !isObserverPersona(persona)) {
    throw new CoordinationError("Hari needs the observer persona and a restore-validating subagent factory");
  }
  let restoreContext: ExtensionContext | undefined;
  let blocked: string | undefined;
  const validateRestoredSubagent = (stored: Readonly<StoredSubagent>) => {
    const parentFile = restoreContext?.sessionManager.getSessionFile();
    const expectedDirectory = parentFile && join(dirname(parentFile), "persistent-subagents", restoreContext!.sessionManager.getSessionId());
    const sessionRelative = stored.runtime === "pi" && stored.sessionFile && expectedDirectory
      ? relative(expectedDirectory, resolve(stored.sessionFile)) : undefined;
    if (stored.runtime !== "pi" || !isObserverPersona(stored.persona)
      || stored.persona.systemPrompt !== persona.systemPrompt
      || resolve(stored.persona.filePath) !== resolve(persona.filePath)
      || stored.mode !== "fresh" || stored.parentSessionFile || stored.selectedSkillPaths.length
      || resolve(stored.cwd) !== resolve(coordinationDir)
      || !expectedDirectory || resolve(stored.sessionDir) !== resolve(expectedDirectory)
      || (sessionRelative !== undefined && (sessionRelative === "" || sessionRelative === ".." || sessionRelative.startsWith("../")))) {
      throw new CoordinationError(`Restored helper ${stored.name} is not a compatible Hari Pi observer. Its records were not changed. Use another Hari session or inspect the incompatible configuration.`);
    }
  };

  // Pi's on() has event-specific overloads. Preserve each registration and its result.
  const forwardOn = pi.on.bind(pi) as unknown as RegisterHandler;
  const on = ((name: string, handler: Handler) => forwardOn(name, async (event, ctx) => {
    if (name !== "session_start" && name !== "session_tree") return handler(event, ctx);
    restoreContext = ctx;
    blocked = undefined;
    try {
      return await handler(event, ctx);
    } catch (error) {
      blocked = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Hari observer blocked: ${blocked}`, "error");
      // Pi can continue coordination, but cannot use a partly restored helper registry.
    }
  })) as ExtensionAPI["on"];

  module.default({
    ...pi,
    on,
    registerCommand() {},
    registerShortcut() {},
    registerTool(tool) {
      if (tool.name !== "subagent") return;
      pi.registerTool({
        ...tool,
        description: "Inspect selected manager sessions for learning with a read-only Pi observer. Reuse retained observers; no workers, Cloud, or parent forks.",
        async execute(id, params, signal, onUpdate, ctx) {
          if (blocked) throw new CoordinationError(blocked);
          if (params.action === "create") {
            if (params.persona !== OBSERVER_PERSONA || (params.runtime !== undefined && params.runtime !== "pi")
              || (params.mode !== undefined && params.mode !== "fresh") || (params.skills !== undefined && params.skills.length)) {
              throw new CoordinationError(`Hari permits only ${OBSERVER_PERSONA} on Pi with fresh context and no selected skills`);
            }
            const parentFile = ctx.sessionManager.getSessionFile();
            if (!parentFile || resolve(ctx.cwd) !== resolve(coordinationDir)
              || relative(join(coordinationDir, ".hari", "sessions"), resolve(parentFile)).startsWith("..")) {
              throw new CoordinationError("Hari observers need a persisted parent session in the Prime Radiant's .hari/sessions");
            }
          } else if (["prompt", "status", "stop"].includes(params.action)) {
            // Native list is local and has no runtime contact. Do not keep a second registry.
            const list = await tool.execute(id, { action: "list" } as typeof params, signal, undefined, ctx);
            const targets = (list.details as { subagents?: PersistentSubagentSummary[] } | undefined)?.subagents;
            const target = Array.isArray(targets) && targets.find((entry) => entry.id === params.id || entry.name === params.id);
            if (!target || target.runtime !== "pi" || target.persona !== OBSERVER_PERSONA) {
              throw new CoordinationError("Select the exact ID or name of a retained Hari Pi observer");
            }
          }
          return tool.execute(id, params, signal, onUpdate, ctx);
        },
      });
    },
  }, { personaDirectory: OBSERVER_PERSONA_DIRECTORY, validateRestoredSubagent });

  pi.on("tool_call", (event) => {
    if (event.toolName === "subagent" && blocked) return { block: true, reason: blocked };
  });
}

export default async function sessionObserver(pi: ExtensionAPI): Promise<void> {
  if (process.env.HARI_ROLE !== "hari") throw new CoordinationError("Load the Hari observer adapter only through Hari");
  const directory = coordinationDirectory();
  const config = await readLauncherConfig(directory);
  const { module, persona } = await loadSessionObserverResources(config);
  registerSessionObserver(pi, module, persona, directory);
}
