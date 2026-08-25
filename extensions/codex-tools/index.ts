import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexBashTool } from "./bash.ts";
import { createCodexGhTool } from "./gh.ts";
import { createCodexGitTool } from "./git.ts";
import { registerCodexReadTool } from "./read.ts";
import { createCodexWebSearchTool } from "./web-search.ts";
import { createCodexFindTool, createCodexGrepTool } from "./search.ts";
import { isToolFailureDetails } from "./tool-result.ts";
import { hasUnsuccessfulProcessStatus } from "./tool-render.ts";

export const CODEX_PROVIDER = "openai-codex";
const CODEX_TOOL_NAMES = ["read", "find", "grep", "bash", "git", "gh", "web_search"] as const;
const GIT_ERROR_DIAGNOSTIC = /(?:^|\n)(?:fatal|error):|(?:^|\n)usage: git(?:\s|$)/im;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function gitExitIsExpected(details: unknown, content: readonly (TextContent | ImageContent)[]): boolean {
  if (
    !isRecord(details)
    || details.ok !== true
    || details.exit_code !== 1
    || details.signal !== null
    || details.timed_out !== false
  ) {
    return false;
  }
  const output = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const stderrHeader = output.lastIndexOf("\n[stderr:");
  if (stderrHeader < 0) return true;
  const stderrStart = output.indexOf("\n", stderrHeader) + 1;
  return !GIT_ERROR_DIAGNOSTIC.test(output.slice(stderrStart));
}

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

/** Register Codex tool replacements once when a Codex model is selected. */
export default function codexTools(pi: ExtensionAPI): void {
  let registered = false;
  const registerForCodex = (provider: string | undefined): void => {
    if (provider !== CODEX_PROVIDER || registered) return;
    registerCodexReadTool(pi);
    pi.registerTool(createCodexFindTool());
    pi.registerTool(createCodexGrepTool());
    pi.registerTool(createCodexBashTool());
    pi.registerTool(createCodexGitTool());
    pi.registerTool(createCodexGhTool());
    pi.registerTool(createCodexWebSearchTool());
    const activeTools = new Set(pi.getActiveTools());
    for (const toolName of CODEX_TOOL_NAMES) activeTools.add(toolName);
    pi.setActiveTools([...activeTools]);
    registered = true;
  };

  pi.on("session_start", (_event, ctx) => {
    registerForCodex(ctx.model?.provider);
  });

  pi.on("model_select", (event, ctx) => {
    registerForCodex(event.model.provider);
    if (registered && event.model.provider !== CODEX_PROVIDER && ctx.hasUI) {
      ctx.ui.notify(
        "Codex tool replacements stay active after a model change. Restart Pi to restore built-in tools.",
        "warning",
      );
    }
  });

  pi.on("tool_result", (event) => {
    if (!registered || event.isError) return;
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
    if (CODEX_TOOL_NAMES.includes(event.toolName as typeof CODEX_TOOL_NAMES[number]) && isToolFailureDetails(event.details)) {
      return { isError: true };
    }
    return undefined;
  });
}
