import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./ask-user.ts";
import { AgentToolAvailability, OPTIONAL_AGENT_TOOL_NAMES } from "./availability.ts";
import { createAgentBashTool } from "./bash.ts";
import { BashProcessOwner } from "./bash-process.ts";
import { BashJobRegistry } from "./bash-jobs.ts";
import { createAgentBashJobTool } from "./bash-job.ts";
import { createAgentGhTool } from "./gh.ts";
import { createAgentGitTool, gitExitIsExpected } from "./git.ts";
import { registerAgentReadTool } from "./read.ts";
import { createAgentWebSearchTool } from "./web-search.ts";
import { createAgentFindTool, createAgentGrepTool } from "./search.ts";
import { isToolFailureDetails } from "./tool-result.ts";
import { hasUnsuccessfulProcessStatus } from "./tool-render.ts";

export const AGENT_TOOL_NAMES = ["read", "find", "grep", "bash", "git", "gh", "web_search", "ask_user", "bash_job"] as const;
function correctWriteByteCount(
  content: readonly (TextContent | ImageContent)[],
  input: Record<string, unknown>,
): (TextContent | ImageContent)[] | undefined {
  if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
  const targetPath = input.path;
  const source = input.content;
  const expectedText = `Successfully wrote ${source.length} bytes to ${targetPath}`;
  const textIndex = content.findIndex((item) => item.type === "text" && item.text === expectedText);
  if (textIndex < 0) return undefined;

  return content.map((item, index) => index === textIndex
    ? {
      ...item,
      text: `Successfully wrote ${Buffer.byteLength(source, "utf8")} bytes to ${targetPath}`,
    }
    : item);
}

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

/** Create an extension that registers only the selected agent tools. */
export function createAgentToolsExtension(selectedTools: readonly AgentToolName[]): (pi: ExtensionAPI) => void {
  const known = new Set<string>(AGENT_TOOL_NAMES);
  for (const name of selectedTools) {
    if (!known.has(name)) throw new Error(`Unknown agent tool: ${name}`);
  }
  const selected = new Set<AgentToolName>(selectedTools);
  const has = (name: AgentToolName) => selected.has(name);
  const selectedOptional = OPTIONAL_AGENT_TOOL_NAMES.filter((name) => selected.has(name));
  const needsAvailability = selectedOptional.length > 0;
  const needsRuntime = has("bash") || has("bash_job");
  const registersAllTools = AGENT_TOOL_NAMES.every((name) => selected.has(name));

  return function agentTools(pi: ExtensionAPI): void {
    let runtime: { owner: BashProcessOwner; registry: BashJobRegistry } | undefined;
    let availability: AgentToolAvailability | undefined;
    const createRuntime = () => {
      const owner = new BashProcessOwner();
      const registry = new BashJobRegistry(owner, null, { onRetainedCountChange(count) {
        if (runtime?.registry !== registry) return;
        availability?.onRetainedCountChange(count);
      } });
      return { owner, registry };
    };
    if (needsRuntime) runtime = createRuntime();
    if (needsAvailability) availability = new AgentToolAvailability(pi, () => runtime?.registry.retainedCount ?? 0, undefined, selectedOptional);

    if (has("read")) registerAgentReadTool(pi);
    if (has("find")) pi.registerTool(createAgentFindTool());
    if (has("grep")) pi.registerTool(createAgentGrepTool());
    if (has("bash")) pi.registerTool(createAgentBashTool({ owner: () => runtime!.owner, registry: () => runtime!.registry,
      controlAvailable: () => pi.getActiveTools().includes("bash_job") }));
    if (has("bash_job")) pi.registerTool({ ...createAgentBashJobTool(() => runtime!.registry), exposure: "direct", defaultActive: true,
      prepareLoadout: availability!.prepareLoadout("bash_job") });
    if (has("git")) pi.registerTool(createAgentGitTool());
    if (has("gh")) pi.registerTool({ ...createAgentGhTool(), exposure: "direct", defaultActive: true,
      prepareLoadout: availability!.prepareLoadout("gh") });
    if (has("web_search")) pi.registerTool({ ...createAgentWebSearchTool(), exposure: "direct", defaultActive: true,
      prepareLoadout: availability!.prepareLoadout("web_search") });
    if (has("ask_user")) registerAskUserTool(pi, availability!.prepareLoadout("ask_user"));

    const shutdown = async (reason: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => {
      const current = runtime!;
      current.registry.closeAdmission();
      current.owner.close();
      const reports = await current.owner.shutdown();
      const failures = reports.filter((report) => report.process?.cleanup !== "complete" && report.process !== null);
      pi.appendEntry("agent-tools-bash-shutdown", { reason, controllers: reports });
      if (failures.length && ctx.hasUI) ctx.ui.notify(`Owned Bash cleanup is not verified for ${failures.map((report) => report.controller_id).join(", ")}. Saved logs remain pinned.`, "warning");
      current.registry.clear();
    };
    if (needsRuntime) {
      pi.on("session_shutdown", async (event, ctx) => { await shutdown(event.reason, ctx); });
    }
    if (needsRuntime || needsAvailability) {
      pi.on("session_start", async (event, ctx) => {
        if (needsRuntime) {
          if (runtime!.owner.closed || event.reason === "new" || event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
            if (!runtime!.owner.closed) await shutdown(event.reason, ctx);
            runtime = createRuntime();
          }
          runtime!.registry.bindSession(ctx.sessionManager.getSessionId());
        }
        if (availability) await availability.refresh(ctx);
      });
    }
    if (availability) {
      pi.on("model_select", async (_event, ctx) => { await availability!.refresh(ctx); });
      pi.on("before_agent_start", async (event, ctx) => {
        await availability!.refresh(ctx);
        availability!.suppressUnavailablePromptMetadata(event);
      });
    }

    if (selected.size > 0) pi.on("tool_result", (event) => {
      if (event.isError) return;
      if (registersAllTools && event.toolName === "write") {
        const content = correctWriteByteCount(event.content, event.input);
        return content ? { content } : undefined;
      }
      if (
        has("git") && event.toolName === "git"
        && hasUnsuccessfulProcessStatus(event.details)
        && !gitExitIsExpected(event.details, event.content)
      ) {
        return { isError: true };
      }
      if (
        ((has("bash") && event.toolName === "bash") || (has("gh") && event.toolName === "gh") || (has("bash_job") && event.toolName === "bash_job"))
        && hasUnsuccessfulProcessStatus(event.details)
      ) {
        return { isError: true };
      }
      if (selected.has(event.toolName as AgentToolName) && isToolFailureDetails(event.details)) {
        return { isError: true };
      }
      return undefined;
    });
  };
}

/** Register the complete extension for existing consumers. */
export default function agentTools(pi: ExtensionAPI): void {
  createAgentToolsExtension(AGENT_TOOL_NAMES)(pi);
}
