import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./ask-user.ts";
import { AgentToolAvailability } from "./availability.ts";
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

/** Register tools for all models. */
export default function agentTools(pi: ExtensionAPI): void {
  const createRuntime = () => {
    const owner = new BashProcessOwner();
    const registry = new BashJobRegistry(owner, null, { onRetainedCountChange(count) {
      if (runtime.registry !== registry) return;
      availability.onRetainedCountChange(count);
    } });
    return { owner, registry };
  };
  let runtime = createRuntime();
  const availability = new AgentToolAvailability(pi, () => runtime.registry.retainedCount);
  registerAgentReadTool(pi);
  pi.registerTool(createAgentFindTool());
  pi.registerTool(createAgentGrepTool());
  pi.registerTool(createAgentBashTool({ owner: () => runtime.owner, registry: () => runtime.registry,
    controlAvailable: () => pi.getActiveTools().includes("bash_job") }));
  pi.registerTool({ ...createAgentBashJobTool(() => runtime.registry), exposure: "direct", defaultActive: true,
    prepareLoadout: availability.prepareLoadout("bash_job") });
  pi.registerTool(createAgentGitTool());
  pi.registerTool({ ...createAgentGhTool(), exposure: "direct", defaultActive: true,
    prepareLoadout: availability.prepareLoadout("gh") });
  pi.registerTool({ ...createAgentWebSearchTool(), exposure: "direct", defaultActive: true,
    prepareLoadout: availability.prepareLoadout("web_search") });
  registerAskUserTool(pi, availability.prepareLoadout("ask_user"));

  const shutdown = async (reason: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) => {
    const current = runtime;
    current.registry.closeAdmission();
    current.owner.close();
    const reports = await current.owner.shutdown();
    const failures = reports.filter((report) => report.process?.cleanup !== "complete" && report.process !== null);
    pi.appendEntry("agent-tools-bash-shutdown", { reason, controllers: reports });
    if (failures.length && ctx.hasUI) ctx.ui.notify(`Owned Bash cleanup is not verified for ${failures.map((report) => report.controller_id).join(", ")}. Saved logs remain pinned.`, "warning");
    current.registry.clear();
  };
  pi.on("session_shutdown", async (event, ctx) => { await shutdown(event.reason, ctx); });
  pi.on("session_start", async (event, ctx) => {
    if (runtime.owner.closed || event.reason === "new" || event.reason === "resume" || event.reason === "fork" || event.reason === "reload") {
      if (!runtime.owner.closed) await shutdown(event.reason, ctx);
      runtime = createRuntime();
    }
    runtime.registry.bindSession(ctx.sessionManager.getSessionId());
    await availability.refresh(ctx);
  });
  pi.on("model_select", async (_event, ctx) => { await availability.refresh(ctx); });
  pi.on("before_agent_start", async (event, ctx) => {
    await availability.refresh(ctx);
    availability.suppressUnavailablePromptMetadata(event);
  });

  pi.on("tool_result", (event) => {
    if (event.isError) return;
    if (event.toolName === "write") {
      const content = correctWriteByteCount(event.content, event.input);
      return content ? { content } : undefined;
    }
    if (
      event.toolName === "git"
      && hasUnsuccessfulProcessStatus(event.details)
      && !gitExitIsExpected(event.details, event.content)
    ) {
      return { isError: true };
    }
    if (
      (event.toolName === "bash" || event.toolName === "gh" || event.toolName === "bash_job")
      && hasUnsuccessfulProcessStatus(event.details)
    ) {
      return { isError: true };
    }
    if (AGENT_TOOL_NAMES.includes(event.toolName as typeof AGENT_TOOL_NAMES[number]) && isToolFailureDetails(event.details)) {
      return { isError: true };
    }
    return undefined;
  });
}
