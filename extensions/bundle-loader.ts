import { realpathSync } from "node:fs";
import {
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { importBundleTools, validateToolNames } from "./bundle-loader/adapters.ts";
import { loadManifest, readRegistry, validateSkills } from "./bundle-loader/config.ts";
import { failBundle, getBundleState, shutdownSession, startSession, type ActivationStage } from "./bundle-loader/state.ts";

const MAX_LIST_ROWS = 40;
const SOURCE = "extension:bundle-loader";

function displayText(value: string, limit = 180): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, limit);
}

function sessionIdentity(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() ?? null]);
}

/** Commands expose the current native skill names and files, including command-only skills. */
function nativeSkills(pi: ExtensionAPI): Skill[] {
  return pi.getCommands().filter((command) => command.source === "skill" && command.sourceInfo?.source !== SOURCE)
    .map((command) => ({
      name: command.name.slice("skill:".length),
      description: command.description ?? "",
      filePath: command.sourceInfo!.path,
      baseDir: "",
      sourceInfo: command.sourceInfo!,
      disableModelInvocation: false,
    }));
}

export default function bundleLoader(pi: ExtensionAPI) {
  // Read only the user registry here. No manifest or adapter is read at startup.
  const registry = readRegistry();
  const state = getBundleState();
  type Contribution = { skills: Skill[]; tools: ToolDefinition[]; enabled: boolean; activating: boolean; activationError?: unknown };
  const active = new Map<string, Contribution>();
  let runtimeIdentity: string | undefined;

  const report = (ctx: ExtensionContext, name: string, stage: ActivationStage, error: unknown) => {
    ctx.ui.notify(`Bundle ${displayText(name, 80)} failed at ${stage}: ${displayText(error instanceof Error ? error.message : String(error))}`, "error");
  };

  pi.on("session_shutdown", (event, ctx) => {
    for (const bundle of active.values()) bundle.enabled = false;
    shutdownSession(state, sessionIdentity(ctx), event.reason, pi.getActiveTools());
  });

  pi.on("session_start", async (event, ctx) => {
    runtimeIdentity = sessionIdentity(ctx);
    startSession(state, runtimeIdentity, event.reason);
    active.clear();
    const baseSkills = nativeSkills(pi);
    let selectedSkills: Skill[] = [];

    // Preserve successful bundles before a new selection can claim their names.
    const selections = [...state.selections].sort((a, b) => Number(b[1].status === "loaded") - Number(a[1].status === "loaded"));
    for (const [name, selection] of selections) {
      if (selection.status === "failed") continue;
      const manifestPath = registry.bundles[name];
      let stage: ActivationStage = "manifest";
      let contribution: Contribution | undefined;
      let previousTools: string[] = [];
      const attempted: ToolDefinition[] = [];
      try {
        if (!manifestPath || manifestPath !== selection.manifestPath) throw new Error("The registry entry changed. Select the bundle again.");
        const manifest = loadManifest(manifestPath);
        stage = "skills";
        const combinedSkills = validateSkills([...selectedSkills, ...manifest.skills], baseSkills);
        stage = "adapter";
        const tools = manifest.adapter ? await importBundleTools(manifest.adapter) : [];
        stage = "tools";
        validateToolNames(tools, [...pi.getAllTools().map((tool) => tool.name), "tool_search"]);
        contribution = {
          skills: combinedSkills.filter((skill) => manifest.skills.some((selected) => selected.filePath === skill.filePath)),
          tools, enabled: false, activating: true,
        };
        active.set(name, contribution);
        previousTools = pi.getActiveTools();
        stage = "registration";
        // Use the public native factory only if the host did not load tool_search.
        if (tools.some((tool) => tool.exposure === "deferred") && !pi.getAllTools().some((tool) => tool.name === "tool_search")) {
          createToolSearchExtension()(pi);
        }
        const gate = contribution;
        for (const tool of tools) {
          attempted.push(tool);
          pi.registerTool({
            ...tool,
            defaultActive: false,
            prepareLoadout: tool.prepareLoadout ? (loadout) => {
              if (!gate.enabled) return undefined;
              try {
                return tool.prepareLoadout!(loadout);
              } catch (error) {
                if (!gate.activating) throw error;
                // Pi reports loadout hook errors without throwing from setActiveTools.
                gate.activationError = error;
                return undefined;
              }
            } : undefined,
            execute: async (...args) => {
              if (!gate.enabled || state.selections.get(name)?.status !== "loaded"
                || state.sessionIdentity !== runtimeIdentity || sessionIdentity(args[4]) !== runtimeIdentity) {
                throw new Error(`Bundle ${name} is not active. Use /bundle ${name} to retry.`);
              }
              return tool.execute(...args);
            },
          });
        }
        const restore = [...previousTools, ...state.activeTools, ...tools.filter((tool) =>
          selection.status === "pending" && (tool.exposure === "direct" || tool.exposure === "model-only")
          && tool.defaultActive !== false).map((tool) => tool.name)];
        gate.enabled = true;
        pi.setActiveTools([...new Set(restore)]);
        if (Object.hasOwn(gate, "activationError")) throw gate.activationError;
        if (tools.some((tool) => tool.exposure === "deferred")) {
          // Activate discovery only after the bundle's initial loadout succeeds.
          pi.setActiveTools([...new Set([...restore, "tool_search"])]);
          if (Object.hasOwn(gate, "activationError")) throw gate.activationError;
          if (!pi.getActiveTools().includes("tool_search")) {
            throw new Error("Native tool_search is not available in the active tool set.");
          }
        }
        gate.activating = false;
        state.selections.set(name, { manifestPath, status: "loaded" });
        selectedSkills = combinedSkills;
      } catch (error) {
        if (contribution) contribution.enabled = false;
        failBundle(state, name, selection.manifestPath, stage, error);
        if (attempted.length > 0) {
          // Registration is not atomic. Keep gates closed and replace attempted names with inert, hidden tools.
          try {
            for (const tool of attempted) {
              pi.registerTool({
                name: tool.name, label: tool.label, description: "Bundle activation failed.",
                parameters: tool.parameters, exposure: "hidden", defaultActive: false,
                execute: async () => { throw new Error(`Bundle ${name} activation failed.`); },
              });
            }
            // Hidden registration removes failed names without clearing Pi's pending late-tool activations.
          } catch {
            // If the host cannot quarantine the tools, do not continue with an uncertain loadout.
            ctx.shutdown();
          }
        }
        report(ctx, name, stage, error);
      }
    }
  });

  pi.on("tool_call", (event) => {
    for (const [name, bundle] of active) {
      if (bundle.tools.some((tool) => tool.name === event.toolName) && (!bundle.enabled || state.sessionIdentity !== runtimeIdentity)) {
        return { block: true, reason: `Bundle ${displayText(name, 80)} is not active.` };
      }
    }
    return undefined;
  });

  pi.on("resources_discover", (_event, ctx) => {
    if (runtimeIdentity !== sessionIdentity(ctx) || state.sessionIdentity !== runtimeIdentity) return { skillPaths: [] };
    const paths = new Set<string>();
    for (const [name, bundle] of active) {
      if (!bundle.enabled || state.selections.get(name)?.status !== "loaded") continue;
      for (const skill of bundle.skills) paths.add(realpathSync(skill.filePath));
    }
    return { skillPaths: [...paths] };
  });

  pi.registerCommand("bundle", {
    description: "List bundles or load one for this session",
    getArgumentCompletions: (prefix) => Object.keys(registry.bundles).sort().filter((name) => name.startsWith(prefix))
      .slice(0, MAX_LIST_ROWS).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        if (registry.error) ctx.ui.notify(`Bundle registry: ${displayText(registry.error)}`, "error");
        const names = Object.keys(registry.bundles).sort();
        const rows = names.slice(0, MAX_LIST_ROWS).map((configuredName) => {
          const selection = state.sessionIdentity === sessionIdentity(ctx) ? state.selections.get(configuredName) : undefined;
          const status = selection?.status === "loaded" ? "loaded" : selection?.status === "failed" ? "failed" : "not loaded";
          const diagnostic = status === "failed" ? ` — ${selection!.stage}: ${displayText(selection!.diagnostic ?? "", 120)}` : "";
          return `${displayText(configuredName, 80)} · ${status}${diagnostic}`;
        });
        if (names.length > MAX_LIST_ROWS) rows.push(`${names.length - MAX_LIST_ROWS} more bundles. Use /bundle <name>.`);
        if (ctx.hasUI && rows.length > 0) await ctx.ui.select("Bundles — use /bundle <name> to load", rows);
        else ctx.ui.notify(rows.join("\n") || "No bundles configured.", "info");
        return;
      }
      const manifestPath = registry.bundles[name];
      if (!Object.hasOwn(registry.bundles, name) || manifestPath === undefined) {
        ctx.ui.notify(`Unknown bundle: ${displayText(name, 80)}${registry.error ? `. Registry: ${displayText(registry.error)}` : ""}`, "error");
        return;
      }
      const identity = sessionIdentity(ctx);
      if (state.sessionIdentity === identity && state.selections.get(name)?.status === "loaded") return;
      let stage: ActivationStage = "manifest";
      try {
        const manifest = loadManifest(manifestPath);
        stage = "skills";
        const selectedSkills = [...active.values()].filter((bundle) => bundle.enabled).flatMap((bundle) => bundle.skills);
        validateSkills([...selectedSkills, ...manifest.skills], nativeSkills(pi));
      } catch (error) {
        if (state.sessionIdentity !== identity) startSession(state, identity, "startup");
        failBundle(state, name, manifestPath, stage, error);
        report(ctx, name, stage, error);
        return;
      }
      await ctx.waitForIdle();
      if (sessionIdentity(ctx) !== identity || state.sessionIdentity !== identity) return;
      state.selections.set(name, { manifestPath, status: "pending" });
      await ctx.reload();
      return;
    },
  });
}
