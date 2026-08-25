import { writeFile } from "node:fs/promises";
import type { Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";
import {
  createProcessArtifact,
  removeProcessArtifact,
  writeProcessArtifactMetadata,
  type ProcessArtifact,
} from "./process-artifacts.ts";
import { renderPreview, renderTruncatedToolCall, safeRenderArgument, textContent } from "./tool-render.ts";

const CODEX_PROVIDER = "openai-codex";
const MAX_QUERY_BYTES = 12 * 1024;
const MAX_RESULT_BYTES = DEFAULT_MAX_BYTES - 1024;

const EXTERNAL_SYSTEM_PROMPT = [
  "You are a web-search worker.",
  "Use web search to answer the user query.",
  "Return only a concise factual summary with direct source URLs.",
  "Do not use claims that the search results do not support.",
].join(" ");

export const codexWebSearchParameters = Type.Object({
  query: Type.String({ description: "Focused query for current or external information" }),
});

export type CodexWebSearchInput = Static<typeof codexWebSearchParameters>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareWebSearchArguments(rawInput: unknown): CodexWebSearchInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { query: "\0" };
  if (typeof prepared.query !== "string") prepared.query = "\0";
  return prepared as CodexWebSearchInput;
}

export interface WebSearchArtifactDetails {
  path: string;
  metadata_path: string;
  format: "text";
  capture: "complete";
  captured_bytes: number;
  captured_lines: number;
  expires_at: number;
}

export type WebSearchErrorCode =
  | "INVALID_INPUT"
  | "MODEL_UNAVAILABLE"
  | "CANCELLED"
  | "REQUEST_FAILED"
  | "EMPTY_RESPONSE"
  | "ARTIFACT_FAILED"
  | "INTERNAL_ERROR";

export interface WebSearchSuccessDetails extends ToolSuccessDetails<"web_search"> {
  external_session: true;
  provider: string;
  model: string;
  response_truncated?: {
    by: "lines" | "bytes";
    total_lines: number;
    total_bytes: number;
  };
  artifact?: WebSearchArtifactDetails;
}

export type CodexWebSearchToolDetails =
  | WebSearchSuccessDetails
  | ToolFailureDetails<"web_search", WebSearchErrorCode>;

export interface CodexWebSearchToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
}

class WebSearchToolError extends Error {
  readonly code: WebSearchErrorCode;

  constructor(code: WebSearchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeWebSearchInput(rawInput: unknown): CodexWebSearchInput {
  if (!isRecord(rawInput)) throw new WebSearchToolError("INVALID_INPUT", "web_search input must be an object");
  const unknown = Object.keys(rawInput).find((key) => key !== "query");
  if (unknown) throw new WebSearchToolError("INVALID_INPUT", `Unknown input field: ${unknown}`);
  if (typeof rawInput.query !== "string") throw new WebSearchToolError("INVALID_INPUT", "web_search query must be a string");
  return rawInput as CodexWebSearchInput;
}

function validateQuery(query: string): void {
  const bytes = Buffer.byteLength(query, "utf8");
  if (bytes === 0 || bytes > MAX_QUERY_BYTES || !/\S/.test(query) || query.includes("\0")) {
    throw new WebSearchToolError(
      "INVALID_INPUT",
      "web_search query must contain 1 through 12288 UTF-8 bytes and non-whitespace text",
    );
  }
}

function addWebSearchTool(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Cannot prepare the external web-search request");
  }
  return {
    ...payload,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
}

function responseText(content: readonly unknown[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => (
      typeof item === "object"
      && item !== null
      && "type" in item
      && item.type === "text"
      && "text" in item
      && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
}

interface TruncatedWebSearchResponse {
  content: string;
  response_truncated: NonNullable<WebSearchSuccessDetails["response_truncated"]>;
}

function truncateResponse(text: string): { text: string; truncated?: TruncatedWebSearchResponse } {
  const truncation = truncateHead(text, {
    maxBytes: MAX_RESULT_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return { text };

  return {
    text: truncation.content,
    truncated: {
      content: truncation.content,
      response_truncated: {
        by: truncation.truncatedBy ?? "bytes",
        total_lines: truncation.totalLines,
        total_bytes: truncation.totalBytes,
      },
    },
  };
}

function capturedLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

async function writeWebSearchArtifact(
  text: string,
  response: { provider: string; model: string },
  truncated: TruncatedWebSearchResponse,
  signal: AbortSignal | undefined,
  onArtifactCreated: ((artifact: ProcessArtifact) => void) | undefined,
): Promise<WebSearchArtifactDetails> {
  let artifact: ProcessArtifact | undefined;
  try {
    artifact = await createProcessArtifact();
    onArtifactCreated?.(artifact);
    await writeFile(artifact.stdout_path, text, signal ? { signal } : undefined);
    await writeProcessArtifactMetadata(artifact, {
      id: artifact.id,
      tool: "web_search",
      format: "text",
      capture: "complete",
      captured_bytes: Buffer.byteLength(text),
      captured_lines: capturedLines(text),
      provider: response.provider,
      model: response.model,
      response_truncated: truncated.response_truncated,
    });
    if (signal?.aborted) throw new Error("Operation aborted");
    return {
      path: artifact.stdout_path,
      metadata_path: artifact.metadata_path,
      format: "text",
      capture: "complete",
      captured_bytes: Buffer.byteLength(text),
      captured_lines: capturedLines(text),
      expires_at: artifact.expires_at,
    };
  } catch (error) {
    if (artifact && !await removeProcessArtifact(artifact.directory)) {
      throw new Error("Cannot remove the incomplete web-search artifact");
    }
    throw new Error(`Cannot write web-search artifact: ${String(error)}`);
  }
}

function truncatedResponseText(truncated: TruncatedWebSearchResponse, artifact: WebSearchArtifactDetails): string {
  const notice = `[web_search: preview=truncated; lines=${capturedLines(truncated.content)}/${truncated.response_truncated.total_lines}; bytes=${Buffer.byteLength(truncated.content)}/${truncated.response_truncated.total_bytes}; capture=${artifact.capture}; artifact=${artifact.path}]`;
  return truncated.content.length > 0 ? `${truncated.content}\n\n${notice}` : notice;
}

function singleLineErrorMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f\[\]]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (character === "[") return "\\[";
    if (character === "]") return "\\]";
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  });
}

function webSearchFailure(error: unknown, signal: AbortSignal | undefined): { text: string; details: ToolFailureDetails<"web_search", WebSearchErrorCode> } {
  const code = error instanceof WebSearchToolError
    ? error.code
    : signal?.aborted
      ? "CANCELLED"
      : "REQUEST_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  const boundedMessage = Buffer.byteLength(message) <= 4_096
    ? message
    : `${Buffer.from(message).subarray(0, 4_093).toString("utf8")}...`;
  return {
    text: `[web_search error: ${code}; ${singleLineErrorMessage(boundedMessage)}]`,
    details: { ok: false, tool: "web_search", error: { code, message: boundedMessage } },
  };
}

async function runWebSearch(
  input: CodexWebSearchInput,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  options: CodexWebSearchToolOptions,
): Promise<{ text: string; details: WebSearchSuccessDetails; usage: Usage }> {
  if (!ctx.model || ctx.model.provider !== CODEX_PROVIDER) {
    throw new WebSearchToolError("MODEL_UNAVAILABLE", "web_search requires an openai-codex model");
  }
  input = normalizeWebSearchInput(input);
  validateQuery(input.query);

  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt: EXTERNAL_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [{ type: "text", text: input.query }],
        timestamp: Date.now(),
      }],
    },
    {
      signal,
      reasoningEffort: "minimal",
      textVerbosity: "low",
      onPayload: addWebSearchTool,
    },
  );
  if (response.stopReason === "aborted") throw new WebSearchToolError("CANCELLED", "web_search was cancelled");
  if (response.stopReason === "error" || response.stopReason === "toolUse") {
    throw new WebSearchToolError("REQUEST_FAILED", response.errorMessage ?? "The external web-search request failed");
  }

  const text = responseText(response.content);
  if (!/\S/.test(text)) throw new WebSearchToolError("EMPTY_RESPONSE", "The external web-search request returned no text");
  const truncated = truncateResponse(text);
  const artifact = truncated.truncated
    ? await writeWebSearchArtifact(text, response, truncated.truncated, signal, options.onArtifactCreated)
    : undefined;
  return {
    text: truncated.truncated && artifact
      ? truncatedResponseText(truncated.truncated, artifact)
      : truncated.text,
    details: {
      ok: true,
      tool: "web_search",
      external_session: true,
      provider: response.provider,
      model: response.model,
      ...(truncated.truncated ? { response_truncated: truncated.truncated.response_truncated } : {}),
      ...(artifact ? { artifact } : {}),
    },
    usage: response.usage,
  };
}

export function createCodexWebSearchTool(
  options: CodexWebSearchToolOptions = {},
): ToolDefinition<typeof codexWebSearchParameters, CodexWebSearchToolDetails> {
  return {
    name: "web_search",
    label: "web_search",
    description: "Search the public web for current information. The query runs in a separate Codex request and the response includes source URLs. Truncated results expose a complete plain-text artifact.",
    promptSnippet: "Search the public web for current information",
    promptGuidelines: [
      "Use web_search for current or external information that local files cannot verify.",
    ],
    parameters: codexWebSearchParameters,
    prepareArguments: prepareWebSearchArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Searching the web…" }],
        details: {
          ok: true,
          tool: "web_search",
          external_session: true,
          provider: ctx.model?.provider ?? CODEX_PROVIDER,
          model: ctx.model?.id ?? "unknown",
        },
      });
      try {
        const result = await runWebSearch(params, ctx, signal, options);
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
          usage: result.usage,
        };
      } catch (error) {
        const failure = webSearchFailure(error, signal);
        return {
          content: [{ type: "text", text: failure.text }],
          details: failure.details,
        };
      }
    },
    renderCall(args, theme, context) {
      const call = `${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("muted", safeRenderArgument(args.query))}`;
      return renderTruncatedToolCall(call, theme, context.isPartial, context.isError);
    },
    renderResult(result, options, theme, context) {
      const color = context.isError ? "error" : "toolOutput";
      return new Text(theme.fg(color, renderPreview(textContent(result), options.expanded)), 0, 0);
    },
  };
}
