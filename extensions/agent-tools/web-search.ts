import { hasApi, type Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields } from "./optional-input.ts";
import type { ToolFailureDetails } from "./tool-result.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";
import { renderPreview, renderTruncatedToolCall, safeRenderArgument, textContent } from "./tool-render.ts";
import {
  boundedJoin, errorMessage, errorText, isRecord, jsonBytes, linePrefix, textLines, utf8Prefix,
  WEB_ARTIFACT_LIMIT, WebArtifactLimitError, writeWebTextArtifact, type WebTextArtifactDetails,
} from "./web-common.ts";
import { createNativeWebEvidenceCollector, type NativeWebSearchRecord, type NativeUrlCitation } from "./web-search-evidence.ts";
export { createNativeWebEvidenceCollector } from "./web-search-evidence.ts";
export type { NativeWebSearchRecord, NativeUrlCitation } from "./web-search-evidence.ts";

const EXTERNAL_SYSTEM_PROMPT = "Search the web. Return a concise factual answer with direct source URLs. Do not make unsupported claims.";
export const agentWebSearchParameters = Type.Object({
  query: Type.String({ description: "Focused query for current or external information" }),
}, { additionalProperties: false });
export type AgentWebSearchInput = Static<typeof agentWebSearchParameters>;
export type WebSearchArtifactDetails = WebTextArtifactDetails;
export type WebSearchErrorCode = "INVALID_INPUT" | "MODEL_UNAVAILABLE" | "CANCELLED" | "REQUEST_FAILED" |
  "EMPTY_RESPONSE" | "ARTIFACT_FAILED" | "INTERNAL_ERROR" | "RETRIEVAL_UNVERIFIED" | "EVIDENCE_LIMIT";
export class WebSearchToolError extends Error {
  readonly code: WebSearchErrorCode;
  constructor(code: WebSearchErrorCode, message: string) { super(message); this.code = code; }
}
export interface WebSearchSuccessDetails {
  ok: true;
  tool: "web_search";
  external_session: true;
  provider: string;
  model: string;
  retrieved_at: string;
  native_search_count: number;
  citation_count: number;
  uncited_summary: boolean;
  searches: NativeWebSearchRecord[];
  citations: NativeUrlCitation[];
  response_truncated?: { by: "lines" | "bytes"; total_lines: number; total_bytes: number };
  artifact?: WebTextArtifactDetails;
}
interface WebSearchProgressDetails {
  ok: true;
  tool: "web_search";
  external_session: true;
  provider: string;
  model: string;
}
export type AgentWebSearchToolDetails = WebSearchSuccessDetails | WebSearchProgressDetails | ToolFailureDetails<"web_search", WebSearchErrorCode>;
export interface AgentWebSearchToolOptions { onArtifactCreated?: (artifact: ProcessArtifact) => void }
export function normalizeWebSearchInput(rawInput: unknown): AgentWebSearchInput {
  const input = omitNullOptionalFields(rawInput, []);
  if (!isRecord(input)) throw new WebSearchToolError("INVALID_INPUT", "web_search input must be an object");
  const unknown = Object.keys(input).find((key) => key !== "query");
  if (unknown !== undefined) throw new WebSearchToolError("INVALID_INPUT", `Unknown input field: ${unknown}`);
  if (typeof input.query !== "string") throw new WebSearchToolError("INVALID_INPUT", "web_search query must be a string");
  validateQuery(input.query);
  return { query: input.query };
}
export function validateQuery(query: string): void {
  const bytes = Buffer.byteLength(query);
  if (!bytes || bytes > 12_288 || !/\S/.test(query) || query.includes("\0")) {
    throw new WebSearchToolError("INVALID_INPUT", "web_search query must contain 1 through 12288 UTF-8 bytes and non-whitespace text");
  }
}
export function addWebSearchTool(payload: unknown): unknown {
  if (!isRecord(payload)) throw new Error("Cannot prepare the external web-search request");
  return { ...payload, tools: [{ type: "web_search" }], tool_choice: "required", parallel_tool_calls: false };
}
export function supportsNativeWebSearch(model: NonNullable<ExtensionContext["model"]>): boolean {
  return model.provider === "openai-codex" && hasApi(model, "openai-codex-responses") && model.compat?.supportsAdditionalTools === true;
}
export function selectWebSearchModel(ctx: ExtensionContext): NonNullable<ExtensionContext["model"]> {
  const models = ctx.modelRegistry.getAvailable().filter(supportsNativeWebSearch);
  const model = models.find((entry) => entry.provider === ctx.model?.provider && entry.id === ctx.model?.id)
    ?? models.find((entry) => entry.id === "gpt-6-luna") ?? models.find((entry) => entry.id === "gpt-5.6-luna") ?? models[0];
  if (!model) throw new WebSearchToolError("MODEL_UNAVAILABLE", "web_search requires an available openai-codex model with native tool support");
  return model;
}
const evidenceLimit = () => new WebSearchToolError("EVIDENCE_LIMIT", "Web evidence exceeds a retention limit");
function evidenceParts(summary: string, details: WebSearchSuccessDetails) {
  try {
    jsonBytes(details.provider, WEB_ARTIFACT_LIMIT);
    jsonBytes(details.model, WEB_ARTIFACT_LIMIT);
  } catch (error) { if (error instanceof RangeError) throw evidenceLimit(); throw error; }
  const warning = details.uncited_summary ? "\nWarning: Native search completed, but the provider returned no URL citations. This summary is uncited." : "";
  const prefix = boundedJoin([
    "[web_search: provider=", JSON.stringify(details.provider), "; model=", JSON.stringify(details.model),
    `; native_searches=${details.native_search_count}; citations=${details.citation_count}; retrieved_at=${details.retrieved_at}]`,
    warning, "\n\nSummary (auxiliary model; not source text):\n",
  ], WEB_ARTIFACT_LIMIT, evidenceLimit);
  const citations: string[] = [];
  let remaining = WEB_ARTIFACT_LIMIT - Buffer.byteLength(prefix) - Buffer.byteLength(summary) - Buffer.byteLength("\n\nNative URL citations:\n");
  for (const [index, record] of details.citations.entries()) {
    const label = `[${index + 1}] `;
    const value = { url: record.url, title: record.title };
    try { remaining -= jsonBytes(value, Math.max(0, remaining)); }
    catch (error) { if (error instanceof RangeError) throw evidenceLimit(); throw error; }
    remaining -= Buffer.byteLength(label) + (index ? 1 : 0);
    if (remaining < 0) throw evidenceLimit();
    citations.push(label + JSON.stringify(value));
  }
  const suffix = boundedJoin(["\n\nNative URL citations:\n", citations.length ? citations.join("\n") : "none"], WEB_ARTIFACT_LIMIT, evidenceLimit);
  return { prefix, summary, suffix, citations };
}
export async function writeWebSearchArtifact(
  text: string, query: string, details: WebSearchSuccessDetails, signal: AbortSignal | undefined,
  onArtifactCreated?: (artifact: ProcessArtifact) => void,
): Promise<WebTextArtifactDetails> {
  if (Buffer.byteLength(text) > WEB_ARTIFACT_LIMIT) throw evidenceLimit();
  try {
    return await writeWebTextArtifact(text, (artifact) => ({
      id: artifact.id, tool: "web_search", format: "text", capture: "complete",
      captured_bytes: Buffer.byteLength(text), captured_lines: textLines(text), query,
      provider: details.provider, model: details.model, retrieved_at: details.retrieved_at,
      native_search_count: details.native_search_count, citation_count: details.citation_count,
      uncited_summary: details.uncited_summary, searches: details.searches, citations: details.citations,
      response_truncated: details.response_truncated!,
    }), signal, onArtifactCreated, (message, cancelled) => new WebSearchToolError(cancelled ? "CANCELLED" : "ARTIFACT_FAILED", message));
  } catch (error) { if (error instanceof WebArtifactLimitError) throw evidenceLimit(); throw error; }
}
export async function renderWebSearchEvidence(
  summary: string, query: string, details: WebSearchSuccessDetails, signal: AbortSignal | undefined, options: AgentWebSearchToolOptions,
): Promise<string> {
  const parts = evidenceParts(summary, details);
  const full = boundedJoin([parts.prefix, summary, parts.suffix], WEB_ARTIFACT_LIMIT, evidenceLimit);
  if (Buffer.byteLength(full) <= 16_384 && textLines(full) <= 200) return full;
  const bytePrefix = utf8Prefix(full, 16_384);
  const linesPrefix = linePrefix(full, 200);
  details.response_truncated = {
    by: bytePrefix.length <= linesPrefix.length ? "bytes" : "lines", total_bytes: Buffer.byteLength(full), total_lines: textLines(full),
  };
  const artifact = await writeWebSearchArtifact(full, query, details, signal, options.onArtifactCreated);
  const notice = `\n\n[web_search: preview=truncated; omitted_text=true; capture=complete; artifact=${artifact.path}]`;
  const citationHeading = "\n\nNative URL citations:\n";
  const omission = "[citation records omitted; see artifact]";
  let records = "";
  for (const record of parts.citations) {
    const next = records ? `${records}\n${record}` : record;
    const reserve = parts.prefix + citationHeading + next + "\n" + omission + notice;
    if (Buffer.byteLength(reserve) > 16_384 || textLines(reserve) > 200) break;
    records = next;
  }
  const displayed = records ? textLines(records) : 0;
  const citationText = parts.citations.length === 0 ? "none"
    : displayed === parts.citations.length ? records : `${records}${records ? "\n" : ""}${omission}`;
  const fixed = parts.prefix + citationHeading + citationText + notice;
  if (Buffer.byteLength(fixed) > 16_384 || textLines(fixed) > 200) throw new WebSearchToolError("ARTIFACT_FAILED", "Web provenance and artifact path do not fit the preview");
  const excerpt = utf8Prefix(linePrefix(summary, Math.max(1, 201 - textLines(fixed))), 16_384 - Buffer.byteLength(fixed));
  details.artifact = artifact;
  return parts.prefix + excerpt + citationHeading + citationText + notice;
}
export async function runWebSearch(
  input: AgentWebSearchInput, ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>,
  signal: AbortSignal | undefined, options: AgentWebSearchToolOptions, onUsage: (usage: Usage) => void,
): Promise<{ text: string; details: WebSearchSuccessDetails; usage: Usage }> {
  const collector = createNativeWebEvidenceCollector();
  const response = await ctx.modelRegistry.complete(model, {
    systemPrompt: EXTERNAL_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: input.query }], timestamp: Date.now() }],
  }, { signal, reasoningEffort: "minimal", textVerbosity: "low", onPayload: addWebSearchTool, onProviderStreamEvent: collector.observe });
  onUsage(response.usage);
  const retrieved_at = new Date().toISOString();
  if (signal?.aborted || response.stopReason === "aborted") throw new WebSearchToolError("CANCELLED", "web_search was cancelled");
  if (response.stopReason !== "stop") throw new WebSearchToolError("REQUEST_FAILED", response.errorMessage ?? "The external web-search request failed");
  if (collector.limitExceeded()) throw evidenceLimit();
  function* textParts() {
    let first = true;
    for (const item of response.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        if (!first) yield "\n";
        first = false;
        yield item.text;
      }
    }
  }
  const summary = boundedJoin(textParts(), 1_048_576, evidenceLimit);
  const searches = collector.searches();
  const citations = collector.citations();
  if (!searches.length) throw new WebSearchToolError("RETRIEVAL_UNVERIFIED", "The provider returned no completed native web search");
  if (!/\S/.test(summary)) throw new WebSearchToolError("EMPTY_RESPONSE", "The external web-search request returned no text");
  const details: WebSearchSuccessDetails = {
    ok: true, tool: "web_search", external_session: true, provider: response.provider, model: response.model,
    retrieved_at, native_search_count: searches.length, citation_count: citations.length, uncited_summary: !citations.length, searches, citations,
  };
  const text = await renderWebSearchEvidence(summary, input.query, details, signal, options);
  return { text, details, usage: response.usage };
}
export function createAgentWebSearchTool(options: AgentWebSearchToolOptions = {}): ToolDefinition<typeof agentWebSearchParameters, AgentWebSearchToolDetails> {
  return {
    name: "web_search", label: "web_search",
    description: "Search the public web in a separate Codex request. Report native search and citation counts. Citations can be absent. Truncated results have a complete text artifact.",
    promptSnippet: "Search the public web for current information",
    promptGuidelines: ["Use web_search for current or external facts that local files cannot verify.", "A search summary is not source text."],
    parameters: agentWebSearchParameters, prepareArguments: normalizeWebSearchInput,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let usage: Usage | undefined;
      try {
        const input = normalizeWebSearchInput(params);
        const model = selectWebSearchModel(ctx);
        onUpdate?.({ content: [{ type: "text", text: "Searching the web…" }], details: {
          ok: true, tool: "web_search", external_session: true, provider: model.provider, model: model.id,
        } });
        const result = await runWebSearch(input, ctx, model, signal, options, (value) => { usage = value; });
        return { content: [{ type: "text", text: result.text }], details: result.details, usage };
      } catch (error) {
        const code = error instanceof WebSearchToolError ? error.code : signal?.aborted ? "CANCELLED" : "REQUEST_FAILED";
        const message = errorMessage(error);
        return { content: [{ type: "text", text: errorText("web_search", code, message) }],
          details: { ok: false, tool: "web_search", error: { code, message } }, isError: true, ...(usage ? { usage } : {}) };
      }
    },
    renderCall(args, theme, context) {
      return renderTruncatedToolCall(`${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("muted", safeRenderArgument(args.query))}`, theme, context.isPartial, context.isError);
    },
    renderResult(result, options, theme, context) {
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", renderPreview(textContent(result), options.expanded)), 0, 0);
    },
  };
}
