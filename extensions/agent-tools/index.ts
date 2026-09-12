import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./ask-user.ts";
import { createAgentBashTool } from "./bash.ts";
import { createAgentGhTool } from "./gh.ts";
import { createAgentGitTool, gitExitIsExpected } from "./git.ts";
import { registerAgentReadTool } from "./read.ts";
import { createAgentWebSearchTool } from "./web-search.ts";
import { createAgentFindTool, createAgentGrepTool } from "./search.ts";
import { isToolFailureDetails } from "./tool-result.ts";
import { hasUnsuccessfulProcessStatus } from "./tool-render.ts";

const AGENT_TOOL_NAMES = ["read", "find", "grep", "bash", "git", "gh", "web_search", "ask_user"] as const;
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
  registerAgentReadTool(pi);
  pi.registerTool(createAgentFindTool());
  pi.registerTool(createAgentGrepTool());
  pi.registerTool(createAgentBashTool());
  pi.registerTool(createAgentGitTool());
  pi.registerTool(createAgentGhTool());
  pi.registerTool(createAgentWebSearchTool());
  registerAskUserTool(pi);

  pi.on("session_start", () => {
    const activeTools = new Set(pi.getActiveTools());
    for (const toolName of AGENT_TOOL_NAMES) activeTools.add(toolName);
    pi.setActiveTools([...activeTools]);
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
      (event.toolName === "bash" || event.toolName === "gh")
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
