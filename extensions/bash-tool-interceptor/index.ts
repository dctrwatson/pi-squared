import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { delimiter } from "node:path";
import { BASH_COMMAND_INTERCEPTORS, type BashCommandInterceptor } from "./interceptors/index.ts";

/**
 * Prepend every registered policy bin without changing Pi's own environment.
 * Later policies can add their own bin and prompt guidance independently.
 */
export function withInterceptorBins(
  env: NodeJS.ProcessEnv,
  interceptors: readonly BashCommandInterceptor[] = BASH_COMMAND_INTERCEPTORS,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const binDirs = [...new Set(interceptors.map((interceptor) => interceptor.binDir))];
  const currentPath = env[pathKey];
  const entries = currentPath === undefined ? [] : currentPath.split(delimiter).filter((entry) => !binDirs.includes(entry));

  return {
    ...env,
    [pathKey]: [...binDirs, ...entries].join(delimiter),
  };
}

export function interceptorGuidance(interceptors: readonly BashCommandInterceptor[] = BASH_COMMAND_INTERCEPTORS): string {
  return interceptors.map((interceptor) => interceptor.systemPromptGuidance).join("\n");
}

export default function bashToolInterceptor(pi: ExtensionAPI) {
  const bashTool = createBashToolDefinition(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: withInterceptorBins(env),
    }),
  });

  // Override only the model-facing Bash tool. The built-in implementation,
  // rendering, output limits, and process handling remain intact.
  pi.registerTool(bashTool);

  pi.on("before_agent_start", (event) => {
    if (!event.systemPromptOptions.selectedTools?.includes("bash")) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n${interceptorGuidance()}` };
  });
}
