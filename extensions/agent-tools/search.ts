import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import path, { delimiter } from "node:path";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  getAgentDir,
  truncateLine,
  type AgentToolResult,
  type ToolDefinition,
  type FindToolDetails,
  type FindToolOptions,
  type GrepToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";
import {
  createProcessArtifact,
  removeProcessArtifact,
  writeProcessArtifactMetadata,
  type ProcessArtifact,
} from "./process-artifacts.ts";

const MAX_SEARCH_TEXT_BYTES = 50 * 1024;
const MAX_SEARCH_CAPTURE_BYTES = 64 * 1024 * 1024;
const DEFAULT_FIND_LIMIT = 100;
const DEFAULT_GREP_LIMIT = 50;
const DEFAULT_GREP_FILES_LIMIT = 100;
const MAX_SEARCH_LIMIT = 2_147_483_647;
const MAX_GREP_CONTEXT = 200;
const FIND_OPTIONAL_FIELDS = ["path", "include_ignored", "limit"];
const GREP_OPTIONAL_FIELDS = ["path", "glob", "ignore_case", "literal", "context", "limit", "mode", "include_ignored"];

const findParameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern, for example '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Search directory (default: current directory)" })),
  include_ignored: Type.Optional(Type.Boolean({ description: "Include ignored files, except .git descendants (default false)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Preview limit (default: 100)" })),
}, { additionalProperties: false });

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Regex by default; set literal=true for exact text" }),
  path: Type.Optional(Type.String({ description: "Search file or directory (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "File glob, for example '*.ts' or '**/*.spec.ts'" })),
  ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Exact text instead of regex (default false)" })),
  mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("files"), Type.Literal("count"), Type.Literal("exists")], { description: "Output mode (default: content)" })),
  include_ignored: Type.Optional(Type.Boolean({ description: "Include ignored files, except .git descendants (default false)" })),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GREP_CONTEXT, description: "Content lines before and after each match (default 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Preview limit (content: 50; files/count: 100); not valid for exists" })),
}, { additionalProperties: false });

export type AgentFindInput = Static<typeof findParameters>;
export type AgentGrepInput = Static<typeof grepParameters>;

const FIND_DESCRIPTION = "Find paths by glob. Regular-file results work with read. Respects .gitignore. Default: 100 paths. Preview cap: 50 KiB. Truncated results provide a complete plain-text artifact when capture succeeds.";
const GREP_DESCRIPTION = "Search by regex or literal text. Modes: content, files, count (matching lines), exists. Results use paths usable by read. Respects ignore files; include_ignored excludes only .git descendants. Defaults: 50 content matches; 100 files/count records. Preview cap: 50 KiB; line cap: 500 characters. Truncated results provide a complete plain-text artifact when capture succeeds.";

type SearchCaptureState = "complete" | "incomplete";
type SearchToolName = "find" | "grep";
type GrepMode = "content" | "files" | "count" | "exists";
type SearchOutputMode = "find" | Exclude<GrepMode, "exists">;

export interface AgentFindToolOptions extends FindToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  executable?: string;
}

export interface AgentGrepToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  executable?: string;
}

export interface SearchArtifactDetails {
  path: string;
  metadata_path: string;
  format: "text";
  capture: SearchCaptureState;
  captured_records: number;
  captured_bytes: number;
  expires_at: number;
}

export type SearchErrorCode =
  | "INVALID_INPUT"
  | "CANCELLED"
  | "EXECUTABLE_NOT_FOUND"
  | "SEARCH_FAILED"
  | "ARTIFACT_FAILED"
  | "INTERNAL_ERROR";

interface SearchSuccessDetails<ToolName extends SearchToolName> extends ToolSuccessDetails<ToolName> {
  result_count: number;
  shown_count: number;
  preview: "complete" | "truncated";
  capture: SearchCaptureState;
  artifact?: SearchArtifactDetails;
  read_paths: string[];
  truncation?: NonNullable<FindToolDetails["truncation"]>;
}

export type AgentFindToolDetails = SearchSuccessDetails<"find"> & {
  result_limit?: number;
};

export type AgentGrepToolDetails = SearchSuccessDetails<"grep"> & (
  | { mode: "content"; match_limit?: number; lines_truncated?: boolean }
  | { mode: "files" }
  | {
    mode: "count";
    counts: { path: string; matching_lines: number }[];
    total_matching_lines: number | null;
    captured_matching_lines: number;
  }
  | { mode: "exists"; exists: boolean; termination: "match" | "eof" }
);

export type AgentFindResultDetails = AgentFindToolDetails | ToolFailureDetails<"find", SearchErrorCode>;
export type AgentGrepResultDetails = AgentGrepToolDetails | ToolFailureDetails<"grep", SearchErrorCode>;

interface SearchRecord {
  text: string;
  readPath: string;
  match: boolean;
  matchingLines?: number;
  sourceText?: string;
  lineNumber?: number;
  separator?: ":" | "-";
}

interface SearchCapture {
  records: SearchRecord[];
  bytes: number;
  complete: boolean;
  unsupportedRecords: number;
  stoppedAtLimit: boolean;
  malformedRecords: number;
  captureError?: string;
}

interface SearchPreview {
  text: string;
  outputRecords: SearchRecord[];
  byteTruncated: boolean;
  lineTruncated: boolean;
  truncation?: NonNullable<FindToolDetails["truncation"]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareFindArguments(rawInput: unknown): AgentFindInput {
  return prepareInputArguments(rawInput, FIND_OPTIONAL_FIELDS, normalizeFindInput);
}

function prepareGrepArguments(rawInput: unknown): AgentGrepInput {
  return prepareInputArguments(rawInput, GREP_OPTIONAL_FIELDS, normalizeGrepInput);
}

function normalizeFindInput(rawInput: unknown): AgentFindInput {
  rawInput = omitNullOptionalFields(rawInput, FIND_OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new Error("Input must be an object");
  const allowed = new Set(["pattern", ...FIND_OPTIONAL_FIELDS]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`Unknown input field: ${unknown}`);
  if (typeof rawInput.pattern !== "string" || rawInput.pattern.includes("\0")) {
    throw new Error("pattern must be a string without NUL");
  }
  if (rawInput.path !== undefined && (typeof rawInput.path !== "string" || rawInput.path.includes("\0"))) {
    throw new Error("path must be a string without NUL");
  }
  if (rawInput.include_ignored !== undefined && typeof rawInput.include_ignored !== "boolean") {
    throw new Error("include_ignored must be a boolean");
  }
  return { ...rawInput, include_ignored: rawInput.include_ignored ?? false, limit: normalizeLimit(rawInput.limit, DEFAULT_FIND_LIMIT) } as AgentFindInput;
}

function normalizeGrepInput(rawInput: unknown): AgentGrepInput {
  rawInput = omitNullOptionalFields(rawInput, GREP_OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new Error("Input must be an object");
  const allowed = new Set(["pattern", ...GREP_OPTIONAL_FIELDS]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`Unknown input field: ${unknown}`);
  if (typeof rawInput.pattern !== "string" || rawInput.pattern.includes("\0")) {
    throw new Error("pattern must be a string without NUL");
  }
  if (rawInput.path !== undefined && (typeof rawInput.path !== "string" || rawInput.path.includes("\0"))) {
    throw new Error("path must be a string without NUL");
  }
  if (rawInput.glob !== undefined && (typeof rawInput.glob !== "string" || rawInput.glob.includes("\0"))) {
    throw new Error("glob must be a string without NUL");
  }
  if (rawInput.ignore_case !== undefined && typeof rawInput.ignore_case !== "boolean") {
    throw new Error("ignore_case must be a boolean");
  }
  if (rawInput.literal !== undefined && typeof rawInput.literal !== "boolean") throw new Error("literal must be a boolean");
  if (
    rawInput.context !== undefined
    && (!Number.isSafeInteger(rawInput.context) || (rawInput.context as number) < 0 || (rawInput.context as number) > MAX_GREP_CONTEXT)
  ) {
    throw new Error("context must be an integer from 0 through 200");
  }
  const mode = rawInput.mode ?? "content";
  if (typeof mode !== "string" || !["content", "files", "count", "exists"].includes(mode)) {
    throw new Error("mode must be content, files, count, or exists");
  }
  if (rawInput.include_ignored !== undefined && typeof rawInput.include_ignored !== "boolean") {
    throw new Error("include_ignored must be a boolean");
  }
  if (mode !== "content" && ((rawInput.context as number | undefined) ?? 0) > 0) {
    throw new Error("context must be zero or omitted outside content mode");
  }
  if (mode === "exists" && rawInput.limit !== undefined) throw new Error("limit must be omitted in exists mode");
  return {
    ...rawInput,
    mode,
    include_ignored: rawInput.include_ignored ?? false,
    context: rawInput.context ?? 0,
    ...(mode === "exists" ? {} : { limit: normalizeLimit(rawInput.limit, mode === "content" ? DEFAULT_GREP_LIMIT : DEFAULT_GREP_FILES_LIMIT) }),
  } as AgentGrepInput;
}

function boundedErrorMessage(message: string): string {
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= 4_096) return message;
  let end = 4_093;
  while (end > 0 && decodeUtf8(bytes.subarray(0, end)) === undefined) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + "...";
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

function regexParseError(message: string): string | undefined {
  if (!/(?:^|\n)(?:rg:\s+)?regex parse error:/i.test(message)) return undefined;
  const reason = /^error:\s*(.+)$/im.exec(message)?.[1]?.trim();
  return reason
    ? `Invalid regular expression: ${reason}. Set literal to true to search exact text.`
    : "Invalid regular expression. Set literal to true to search exact text.";
}

function searchFailure<ToolName extends SearchToolName>(
  tool: ToolName,
  error: unknown,
  signal: AbortSignal | undefined,
): { content: [{ type: "text"; text: string }]; details: ToolFailureDetails<ToolName, SearchErrorCode> } {
  const message = error instanceof Error ? error.message : String(error);
  const code: SearchErrorCode = signal?.aborted || message === "Operation aborted"
    ? "CANCELLED"
    : /^(Input must|Unknown input field|Invalid regular expression|pattern must|path must|glob must|ignore_case must|literal must|context must|limit must|mode must|include_ignored must)/.test(message)
      ? "INVALID_INPUT"
      : /Cannot find/.test(message)
        ? "EXECUTABLE_NOT_FOUND"
        : /artifact/i.test(message)
          ? "ARTIFACT_FAILED"
          : "SEARCH_FAILED";
  const bounded = boundedErrorMessage(message);
  return {
    content: [{ type: "text", text: `[${tool} error: ${code}; ${singleLineErrorMessage(bounded)}]` }],
    details: { ok: false, tool, error: { code, message: bounded } },
  };
}

function normalizeSearchRoot(value: unknown, cwd: string): string {
  if (value === undefined) return path.resolve(cwd);
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("path must be a nonempty string without NUL");
  }
  const normalized = value.startsWith("@") ? value.slice(1) : value;
  if (normalized.length === 0) throw new Error("path must not be @ only");
  return path.resolve(cwd, normalized);
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SEARCH_LIMIT) {
    throw new Error("limit must be an integer from 1 through 2147483647");
  }
  return value as number;
}

function slashPath(value: string): string {
  return value.split(path.sep).join("/");
}

/** Convert one absolute or search-root-relative result to a path accepted by read. */
export function toSessionReadPath(resultPath: string, searchRoot: string, cwd: string): string {
  const trailingSeparator = resultPath.endsWith(path.sep) || resultPath.endsWith("/");
  const pathPart = trailingSeparator ? resultPath.slice(0, -1) : resultPath;
  const absolute = path.isAbsolute(pathPart) ? path.resolve(pathPart) : path.resolve(searchRoot, pathPart);
  const relative = path.relative(path.resolve(cwd), absolute);
  const insideSession = relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
  let selected = insideSession ? (relative || ".") : absolute;
  selected = slashPath(selected);
  if (insideSession && selected.startsWith("@")) selected = `./${selected}`;
  return trailingSeparator && !selected.endsWith("/") ? `${selected}/` : selected;
}

/** Return true when one plain-text artifact line can represent one path without loss. */
export function isComposableFindPathRecord(record: string): boolean {
  return record.length > 0
    && !record.includes("\0")
    && Buffer.from(record, "utf8").toString("utf8") === record
    && !record.includes("\n")
    && !record.includes("\r")
    && record.trim() === record;
}

function createSearchCapture(): SearchCapture {
  return {
    records: [],
    bytes: 0,
    complete: true,
    unsupportedRecords: 0,
    stoppedAtLimit: false,
    malformedRecords: 0,
  };
}

function appendSearchRecord(capture: SearchCapture, record: SearchRecord): boolean {
  if (!isComposableFindPathRecord(record.readPath) || record.text.includes("\n") || record.text.includes("\r")) {
    capture.complete = false;
    capture.unsupportedRecords += 1;
    return true;
  }
  const recordBytes = Buffer.byteLength(record.text) + (capture.records.length > 0 ? 1 : 0);
  if (capture.bytes + recordBytes > MAX_SEARCH_CAPTURE_BYTES) {
    capture.complete = false;
    capture.stoppedAtLimit = true;
    return false;
  }
  capture.records.push(record);
  capture.bytes += recordBytes;
  return true;
}

async function removeSearchArtifact(directory: string): Promise<void> {
  if (!await removeProcessArtifact(directory)) {
    throw new Error(`Cannot remove search artifact: ${directory}`);
  }
}

async function createSearchArtifact(onCreated?: (artifact: ProcessArtifact) => void): Promise<ProcessArtifact> {
  let artifact: ProcessArtifact | undefined;
  try {
    artifact = await createProcessArtifact();
    onCreated?.(artifact);
    return artifact;
  } catch (error) {
    if (artifact) await removeSearchArtifact(artifact.directory);
    throw new Error(`Cannot create search artifact: ${String(error)}`);
  }
}

async function writeSearchArtifact(
  artifact: ProcessArtifact,
  tool: SearchToolName,
  capture: SearchCapture,
  metadata: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<SearchArtifactDetails> {
  const text = capture.records.map((record) => record.text).join("\n");
  try {
    await writeFile(artifact.stdout_path, text, signal ? { signal } : undefined);
    await writeProcessArtifactMetadata(artifact, {
      id: artifact.id,
      tool,
      format: "text",
      capture: capture.complete ? "complete" : "incomplete",
      captured_records: capture.records.length,
      captured_bytes: Buffer.byteLength(text),
      unsupported_records: capture.unsupportedRecords,
      capture_limit_reached: capture.stoppedAtLimit,
      malformed_records: capture.malformedRecords,
      capture_error: capture.captureError,
      ...metadata,
    });
    if (signal?.aborted) throw new Error("Operation aborted");
  } catch (error) {
    await removeSearchArtifact(artifact.directory);
    throw new Error(`Cannot write search artifact: ${String(error)}`);
  }
  return {
    path: artifact.stdout_path,
    metadata_path: artifact.metadata_path,
    format: "text",
    capture: capture.complete ? "complete" : "incomplete",
    captured_records: capture.records.length,
    captured_bytes: Buffer.byteLength(text),
    expires_at: artifact.expires_at,
  };
}

function capturedMatchingLines(capture: SearchCapture): number {
  return capture.records.reduce((sum, record) => sum + (record.matchingLines ?? 0), 0);
}

function footerFor(
  mode: SearchOutputMode,
  shown: number,
  total: number,
  byteTruncated: boolean,
  lineTruncated: boolean,
  capture: SearchCapture,
  artifact?: SearchArtifactDetails,
): string {
  const tool = mode === "find" ? "find" : "grep";
  const unit = mode === "find" ? "results" : mode === "content" ? "matches" : "files";
  const fields = mode === "find" ? [] : [`mode=${mode}`];
  fields.push(`${unit}=${shown}/${total}`);
  if (mode === "count") {
    fields.push(`matching_lines=${capture.complete ? capturedMatchingLines(capture) : "unknown"}`);
    if (!capture.complete) fields.push(`captured_matching_lines=${capturedMatchingLines(capture)}`);
  }
  fields.push(`preview=${shown < total || byteTruncated || lineTruncated ? "truncated" : "complete"}`);
  if (byteTruncated) fields.push("limit=50KiB");
  if (lineTruncated) fields.push("lines_truncated=true");
  fields.push(`capture=${capture.complete ? "complete" : "incomplete"}`);
  if (!capture.complete) fields.push("counts=lower_bounds");
  if (artifact) fields.push(`artifact=${artifact.path}`);
  if (capture.captureError) fields.push(`search_error=${singleLineErrorMessage(boundedErrorMessage(capture.captureError))}`);
  return `[${tool}: ${fields.join("; ")}]`;
}

function fitPreviewLines(
  rendered: Array<{ text: string; record: SearchRecord }>,
  footer: string,
): { text: string; outputRecords: SearchRecord[] } {
  const footerBytes = Buffer.byteLength(footer);
  const selected: Array<{ text: string; record: SearchRecord }> = [];
  let bytes = 0;
  for (const item of rendered) {
    const lineBytes = Buffer.byteLength(item.text) + (selected.length > 0 ? 1 : 0);
    if (bytes + lineBytes + 2 + footerBytes > MAX_SEARCH_TEXT_BYTES) break;
    selected.push(item);
    bytes += lineBytes;
  }
  const content = selected.map((item) => item.text).join("\n");
  return {
    text: content.length > 0 ? `${content}\n\n${footer}` : footer,
    outputRecords: selected.map((item) => item.record),
  };
}

function countShown(mode: SearchOutputMode, records: SearchRecord[]): number {
  return mode === "content" ? records.filter((record) => record.match).length : records.length;
}

function buildPreview(
  mode: SearchOutputMode,
  capture: SearchCapture,
  limit: number,
  totalMatches: number,
  artifact: SearchArtifactDetails,
): SearchPreview {
  const limitedRecords: SearchRecord[] = [];
  let selectedMatches = 0;
  for (const record of capture.records) {
    if (mode !== "content" || record.match) {
      if (selectedMatches >= limit) break;
      selectedMatches += 1;
    }
    limitedRecords.push(record);
  }

  let lineTruncated = false;
  let previousGrepPath: string | undefined;
  const rendered = limitedRecords.map((record) => {
    if (record.sourceText === undefined || record.lineNumber === undefined || record.separator === undefined) {
      return { text: record.text, record };
    }
    const truncated = truncateLine(record.sourceText);
    if (truncated.wasTruncated) lineTruncated = true;
    const line = `${record.lineNumber}${record.separator} ${truncated.text}`;
    const heading = record.readPath === previousGrepPath
      ? ""
      : `${previousGrepPath === undefined ? "" : "\n"}${record.readPath}\n`;
    previousGrepPath = record.readPath;
    return { text: `${heading}${line}`, record };
  });
  const renderedText = new Map(rendered.map((item) => [item.record, item.text]));
  const rawText = rendered.map((item) => item.text).join("\n");
  const previewLimited = selectedMatches < totalMatches;
  let byteTruncated = Buffer.byteLength(rawText) > MAX_SEARCH_TEXT_BYTES;
  const needsArtifact = previewLimited || byteTruncated || lineTruncated || !capture.complete;

  if (!needsArtifact && mode !== "count") {
    return { text: rawText, outputRecords: limitedRecords, byteTruncated: false, lineTruncated: false };
  }

  const makeFooter = (shown: number): string => footerFor(
    mode, shown, totalMatches, byteTruncated, lineTruncated, capture,
    previewLimited || byteTruncated || lineTruncated || !capture.complete ? artifact : undefined,
  );
  let shown = selectedMatches;
  let fitted = fitPreviewLines(rendered, makeFooter(shown));
  for (let pass = 0; pass < 4; pass += 1) {
    if (fitted.outputRecords.length < rendered.length) byteTruncated = true;
    const nextShown = countShown(mode, fitted.outputRecords);
    const next = fitPreviewLines(rendered, makeFooter(nextShown));
    if (nextShown === shown && next.outputRecords.length === fitted.outputRecords.length) {
      fitted = next;
      break;
    }
    shown = nextShown;
    fitted = next;
  }

  const outputText = fitted.outputRecords.map((record) => renderedText.get(record) ?? record.text).join("\n");
  const truncation = byteTruncated ? {
    content: outputText,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines: rawText.length > 0 ? rawText.split("\n").length : 0,
    totalBytes: Buffer.byteLength(rawText),
    outputLines: outputText.length > 0 ? outputText.split("\n").length : 0,
    outputBytes: Buffer.byteLength(outputText),
    lastLinePartial: false,
    firstLineExceedsLimit: rendered.length > 0 && fitted.outputRecords.length === 0,
    maxLines: Number.MAX_SAFE_INTEGER,
    maxBytes: MAX_SEARCH_TEXT_BYTES,
  } : undefined;
  return {
    text: fitted.text,
    outputRecords: fitted.outputRecords,
    byteTruncated,
    lineTruncated,
    ...(truncation ? { truncation } : {}),
  };
}

function decodeUtf8(data: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
}

function stopChild(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGTERM");
}

async function resolveSearchExecutable(
  configured: string | undefined,
  names: string[],
  cwd: string,
): Promise<string> {
  if (process.platform === "win32") throw new Error("Agent search tools do not support Windows");
  if (configured) return configured;
  const primaryName = names[0] ?? "search-tool";
  const managed = path.join(getAgentDir(), "bin", primaryName);
  try {
    await access(managed, constants.X_OK);
    return managed;
  } catch {
    // Continue through PATH entries.
  }
  const pathValue = process.env.PATH;
  if (!pathValue) throw new Error(`Cannot find ${primaryName} in PATH`);
  for (const entry of pathValue.split(delimiter)) {
    for (const name of names) {
      const candidate = path.resolve(cwd, entry || ".", name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through executable names and PATH entries.
      }
    }
  }
  throw new Error(`Cannot find ${names.join(" or ")} in PATH`);
}

async function ensureSearchExecutable(
  configured: string | undefined,
  names: string[],
  cwd: string,
  provision: () => Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<string> {
  try {
    return await resolveSearchExecutable(configured, names, cwd);
  } catch (initialError) {
    let provisionError: unknown;
    try {
      await provision();
    } catch (error) {
      provisionError = error;
    }
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      return await resolveSearchExecutable(configured, names, cwd);
    } catch {
      throw provisionError ?? initialError;
    }
  }
}

async function isInsideGitRepository(searchRoot: string): Promise<boolean> {
  for (let current = searchRoot;;) {
    try {
      await stat(path.join(current, ".git"));
      return true;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

interface SearchByteProtocol {
  pendingBytes(): number;
  push(chunk: Buffer): boolean;
  finish(): void;
}

function malformedProtocol(capture: SearchCapture, reason: string): void {
  capture.complete = false;
  capture.malformedRecords += 1;
  capture.captureError ??= `Malformed search protocol: ${reason}`;
}

function unsupportedPath(capture: SearchCapture): void {
  capture.complete = false;
  capture.unsupportedRecords += 1;
}

function normalizeRecordPath(
  nativePath: string | undefined,
  executionCwd: string,
  cwd: string,
  capture: SearchCapture,
): string | undefined {
  if (nativePath === undefined || !isComposableFindPathRecord(nativePath)) {
    unsupportedPath(capture);
    return undefined;
  }
  const readPath = toSessionReadPath(nativePath, executionCwd, cwd);
  if (!isComposableFindPathRecord(readPath)) {
    unsupportedPath(capture);
    return undefined;
  }
  return readPath;
}

/** Keep partial byte records until their native delimiter arrives. */
function createByteProtocol(
  capture: SearchCapture,
  delimiter: () => number,
  consume: (frame: Buffer) => boolean,
  extraPendingBytes: () => number = () => 0,
): SearchByteProtocol {
  let parts: Buffer[] = [];
  let bytes = 0;
  return {
    pendingBytes: () => bytes + extraPendingBytes(),
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(delimiter(), offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (capture.bytes + bytes + extraPendingBytes() + part.length > MAX_SEARCH_CAPTURE_BYTES) return false;
        if (part.length > 0) {
          parts.push(part);
          bytes += part.length;
        }
        if (end < 0) break;
        const frame = Buffer.concat(parts, bytes);
        parts = [];
        bytes = 0;
        if (!consume(frame)) return false;
        offset = end + 1;
      }
      return true;
    },
    finish() {
      if (bytes + extraPendingBytes() > 0) malformedProtocol(capture, "unfinished record");
      parts = [];
      bytes = 0;
    },
  };
}

async function runSearchCapture(
  executable: string,
  args: string[],
  executionCwd: string,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
  protocol: SearchByteProtocol | undefined,
  nativeTool: "fd" | "ripgrep",
): Promise<number> {
  if (signal?.aborted) throw new Error("Operation aborted");
  return new Promise<number>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: executionCwd,
      stdio: ["ignore", protocol ? "pipe" : "ignore", "pipe"],
    });
    let rawBytes = 0;
    let stderr = Buffer.alloc(0);
    let stoppedForLimit = false;
    let aborted = false;
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (): void => {
      stopChild(child);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    const limitStop = (): void => {
      capture.complete = false;
      capture.stoppedAtLimit = true;
      stoppedForLimit = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stoppedForLimit || aborted || !protocol) return;
      const available = Math.max(0, Math.min(
        MAX_SEARCH_CAPTURE_BYTES - rawBytes,
        MAX_SEARCH_CAPTURE_BYTES - capture.bytes - protocol.pendingBytes(),
      ));
      const selected = chunk.subarray(0, available);
      rawBytes += selected.length;
      if (!protocol.push(selected) || selected.length < chunk.length) limitStop();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const available = Math.max(0, 16_384 - stderr.length);
      if (available > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, available)]);
    });
    child.once("error", (error) => { spawnError = new Error(`Failed to run ${nativeTool}: ${error.message}`); });
    child.once("close", (code, childSignal) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (aborted || signal?.aborted) return rejectRun(new Error("Operation aborted"));
      if (spawnError) return rejectRun(spawnError);
      protocol?.finish();
      const validCode = code === 0 || (nativeTool === "ripgrep" && code === 1);
      if (!stoppedForLimit && (childSignal !== null || !validCode)) {
        const message = stderr.toString("utf8").trim()
          || (childSignal ? `${nativeTool} terminated by ${childSignal}` : `${nativeTool} exited with code ${code}`);
        const diagnostic = nativeTool === "ripgrep" ? regexParseError(message) ?? message : message;
        if (!protocol || capture.records.length === 0) return rejectRun(new Error(diagnostic));
        capture.complete = false;
        capture.captureError = diagnostic;
      }
      if (capture.malformedRecords > 0 && capture.records.length === 0 && !stoppedForLimit) {
        return rejectRun(new Error(capture.captureError ?? "Malformed search protocol"));
      }
      resolveRun(code ?? 0);
    });
  });
}

async function captureFindWithFd(
  pattern: string,
  searchRoot: string,
  cwd: string,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
  configuredExecutable: string | undefined,
  includeIgnored: boolean,
): Promise<void> {
  const info = await stat(searchRoot).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Path not found: ${searchRoot}`);
  const args = ["--glob", "--color=never", "--hidden", "--print0", "--exclude", ".git"];
  if (includeIgnored) args.push("--no-ignore");
  else args.push("--exclude", "node_modules");
  if (!await isInsideGitRepository(searchRoot)) args.push("--no-require-git");
  let effectivePattern = pattern;
  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      effectivePattern = `**/${pattern}`;
    }
  }
  args.push("--", effectivePattern, searchRoot);
  const executable = await resolveSearchExecutable(configuredExecutable, ["fd", "fdfind"], cwd);
  const protocol = createByteProtocol(capture, () => 0, (frame) => {
    if (frame.length === 0) {
      malformedProtocol(capture, "empty path");
      return true;
    }
    const readPath = normalizeRecordPath(decodeUtf8(frame), searchRoot, cwd, capture);
    return readPath === undefined || appendSearchRecord(capture, { text: readPath, readPath, match: true });
  });
  await runSearchCapture(executable, args, searchRoot, capture, signal, protocol, "fd");
}

async function captureFind(
  input: AgentFindInput,
  searchRoot: string,
  cwd: string,
  options: AgentFindToolOptions | undefined,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!options?.operations) {
    await captureFindWithFd(input.pattern, searchRoot, cwd, capture, signal, options?.executable, input.include_ignored === true);
    return;
  }
  if (!await options.operations.exists(searchRoot)) throw new Error(`Path not found: ${searchRoot}`);
  const results = await options.operations.glob(input.pattern, searchRoot, {
    ignore: ["**/.git/**", ...(input.include_ignored ? [] : ["**/node_modules/**"])],
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (signal?.aborted) throw new Error("Operation aborted");
  for (const result of results) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const readPath = normalizeRecordPath(result, searchRoot, cwd, capture);
    if (readPath !== undefined && !appendSearchRecord(capture, { text: readPath, readPath, match: true })) break;
  }
}

function eventText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return decodeUtf8(Buffer.from(value.bytes, "base64"));
  return undefined;
}

function stripOneLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function buildGrepArgs(input: AgentGrepInput, directory: boolean, target: string): string[] {
  const args = ["--no-config", "--color=never", "--hidden"];
  switch (input.mode) {
    case "files": args.push("--files-with-matches", "--null", "--with-filename"); break;
    case "count": args.push("--count", "--null", "--with-filename"); break;
    case "exists": args.push("--quiet"); break;
    default: args.push("--json", "--line-number");
  }
  if (input.ignore_case) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.include_ignored) args.push("--no-ignore");
  if (input.glob !== undefined) args.push("--glob", input.glob);
  if (directory) {
    args.push("--glob", "!**/.git/**");
    if (!input.include_ignored) args.push("--glob", "!**/node_modules/**");
  }
  if (input.mode === "content" && (input.context ?? 0) > 0) args.push("--context", String(input.context));
  args.push("--", input.pattern, target);
  return args;
}

function captureGrepContent(capture: SearchCapture, executionCwd: string, cwd: string): SearchByteProtocol {
  return createByteProtocol(capture, () => 10, (frame) => {
    let event: unknown;
    try {
      const text = decodeUtf8(frame);
      if (text === undefined) throw new Error("invalid UTF-8");
      event = JSON.parse(text);
    } catch {
      malformedProtocol(capture, "invalid JSON event");
      return true;
    }
    if (!isRecord(event) || typeof event.type !== "string") {
      malformedProtocol(capture, "invalid event");
      return true;
    }
    if (["begin", "end", "summary"].includes(event.type)) return true;
    if ((event.type !== "match" && event.type !== "context") || !isRecord(event.data)) {
      malformedProtocol(capture, "invalid match/context event");
      return true;
    }
    const data = event.data;
    if (!Number.isSafeInteger(data.line_number) || (data.line_number as number) < 1) {
      malformedProtocol(capture, "invalid line number");
      return true;
    }
    const readPath = normalizeRecordPath(eventText(data.path), executionCwd, cwd, capture);
    const lineText = eventText(data.lines);
    if (lineText === undefined) {
      unsupportedPath(capture);
      return true;
    }
    if (readPath === undefined) return true;
    const sourceText = stripOneLineEnding(lineText);
    const separator = event.type === "match" ? ":" : "-";
    const lineNumber = data.line_number as number;
    return appendSearchRecord(capture, {
      text: `${readPath}${separator}${lineNumber}${separator} ${sourceText}`,
      readPath,
      match: event.type === "match",
      sourceText,
      lineNumber,
      separator,
    });
  });
}

function captureGrepFiles(capture: SearchCapture, executionCwd: string, cwd: string): SearchByteProtocol {
  const seen = new Set<string>();
  return createByteProtocol(capture, () => 0, (frame) => {
    if (frame.length === 0) {
      malformedProtocol(capture, "empty path");
      return true;
    }
    const readPath = normalizeRecordPath(decodeUtf8(frame), executionCwd, cwd, capture);
    if (readPath === undefined || seen.has(readPath)) return true;
    if (!appendSearchRecord(capture, { text: readPath, readPath, match: true })) return false;
    seen.add(readPath);
    return true;
  });
}

function captureGrepCounts(capture: SearchCapture, executionCwd: string, cwd: string): SearchByteProtocol {
  const seen = new Set<string>();
  let pendingPath: { readPath: string | undefined; bytes: number } | undefined;
  let total = 0;
  return createByteProtocol(capture, () => pendingPath ? 10 : 0, (frame) => {
    if (!pendingPath) {
      if (frame.length === 0) malformedProtocol(capture, "empty count path");
      pendingPath = {
        readPath: frame.length === 0 ? undefined : normalizeRecordPath(decodeUtf8(frame), executionCwd, cwd, capture),
        bytes: frame.length + 1,
      };
      return true;
    }
    const readPath = pendingPath.readPath;
    pendingPath = undefined;
    const countText = frame.toString("ascii");
    const count = Number(countText);
    if (!frame.every((byte) => byte >= 48 && byte <= 57) || countText.length === 0 || !Number.isSafeInteger(count) || count < 1) {
      malformedProtocol(capture, "invalid matching-line count");
      return true;
    }
    if (readPath === undefined) return true;
    if (seen.has(readPath)) {
      malformedProtocol(capture, "duplicate count path");
      return true;
    }
    if (!Number.isSafeInteger(total + count)) {
      malformedProtocol(capture, "matching-line total exceeds safe integer");
      return true;
    }
    if (!appendSearchRecord(capture, { text: `${count}\t${readPath}`, readPath, match: true, matchingLines: count })) return false;
    seen.add(readPath);
    total += count;
    return true;
  }, () => pendingPath?.bytes ?? 0);
}

async function captureGrepExists(
  executable: string,
  args: string[],
  executionCwd: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const code = await runSearchCapture(executable, args, executionCwd, createSearchCapture(), signal, undefined, "ripgrep");
  return code === 0;
}

async function captureGrep(
  input: AgentGrepInput,
  searchRoot: string,
  cwd: string,
  executable: string,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined> {
  const info = await stat(searchRoot).catch(() => { throw new Error(`Path not found: ${searchRoot}`); });
  const directory = info.isDirectory();
  const executionCwd = directory ? searchRoot : path.dirname(searchRoot);
  const target = directory ? "." : path.basename(searchRoot);
  const args = buildGrepArgs(input, directory, target);
  if (input.mode === "exists") return captureGrepExists(executable, args, executionCwd, signal);
  const protocol = input.mode === "files" ? captureGrepFiles(capture, executionCwd, cwd)
    : input.mode === "count" ? captureGrepCounts(capture, executionCwd, cwd)
      : captureGrepContent(capture, executionCwd, cwd);
  await runSearchCapture(executable, args, executionCwd, capture, signal, protocol, "ripgrep");
  if (input.mode === "files" || input.mode === "count") {
    capture.records.sort((left, right) => left.readPath < right.readPath ? -1 : left.readPath > right.readPath ? 1 : 0);
  }
  return undefined;
}

/** Create a find tool with normalized output and recoverable truncation. */
export function createAgentFindTool(
  options?: AgentFindToolOptions,
): ToolDefinition<typeof findParameters, AgentFindResultDetails> {
  const base = createFindToolDefinition(process.cwd(), options);
  return {
    name: base.name,
    label: base.label,
    description: FIND_DESCRIPTION,
    promptSnippet: "Find paths by glob; regular files work with read.",
    promptGuidelines: base.promptGuidelines,
    parameters: findParameters,
    prepareArguments: prepareFindArguments,
    constrainedSampling: base.constrainedSampling,
    executionMode: base.executionMode,
    async execute(_toolCallId, rawInput, signal, _onUpdate, ctx) {
      let artifact: ProcessArtifact | undefined;
      try {
        const input = normalizeFindInput(rawInput);
        const searchRoot = normalizeSearchRoot(input.path, ctx.cwd);
        const limit = normalizeLimit(input.limit, DEFAULT_FIND_LIMIT);
        artifact = await createSearchArtifact(options?.onArtifactCreated);
        const capture = createSearchCapture();
        let runOptions = options;
        if (!options?.operations) {
          const executable = await ensureSearchExecutable(
            options?.executable,
            ["fd", "fdfind"],
            ctx.cwd,
            () => base.execute(
              _toolCallId,
              { ...input, limit: 1 },
              signal,
              _onUpdate as Parameters<typeof base.execute>[3],
              ctx,
            ),
            signal,
          );
          runOptions = { ...options, executable };
        }
        await captureFind(input, searchRoot, ctx.cwd, runOptions, capture, signal);
        const artifactDetails = await writeSearchArtifact(artifact, "find", capture, {
          search_root: searchRoot,
          pattern: input.pattern,
          include_ignored: input.include_ignored,
        }, signal);
        if (capture.records.length === 0 && capture.complete) {
          await removeSearchArtifact(artifact.directory);
          return {
            content: [{ type: "text", text: "No files found matching pattern" }],
            details: {
              ok: true,
              tool: "find",
              result_count: 0,
              shown_count: 0,
              preview: "complete",
              capture: "complete",
              read_paths: [],
            },
          };
        }
        const preview = buildPreview("find", capture, limit, capture.records.length, artifactDetails);
        const countLimited = capture.records.length > limit;
        const needsArtifact = countLimited || preview.byteTruncated || !capture.complete;
        if (!needsArtifact) await removeSearchArtifact(artifact.directory);
        const readPaths = [...new Set(preview.outputRecords.map((record) => record.readPath))];
        const details: AgentFindToolDetails = {
          ok: true,
          tool: "find",
          result_count: capture.records.length,
          shown_count: preview.outputRecords.length,
          preview: countLimited || preview.byteTruncated ? "truncated" : "complete",
          capture: capture.complete ? "complete" : "incomplete",
          read_paths: readPaths,
          ...(countLimited ? { result_limit: limit } : {}),
          ...(preview.truncation ? { truncation: preview.truncation } : {}),
          ...(needsArtifact ? { artifact: artifactDetails } : {}),
        };
        return {
          content: [{ type: "text", text: preview.text }],
          details,
        };
      } catch (error) {
        if (artifact) await removeSearchArtifact(artifact.directory).catch(() => undefined);
        return searchFailure("find", error, signal);
      }
    },
    renderCall: base.renderCall
      ? (args, theme, context) => base.renderCall!(args, theme, context)
      : undefined,
    renderResult: base.renderResult
      ? (result, options, theme, context) => {
        const details = result.details;
        const compatible = details?.ok
          ? { ...details, ...(details.result_limit === undefined ? {} : { resultLimitReached: details.result_limit }) }
          : details;
        return base.renderResult!(
          { ...result, details: compatible } as unknown as AgentToolResult<FindToolDetails | undefined>,
          options,
          theme,
          context,
        );
      }
      : undefined,
  };
}

/** Create a grep tool with canonical read paths and recoverable truncation. */
export function createAgentGrepTool(
  options?: AgentGrepToolOptions,
): ToolDefinition<typeof grepParameters, AgentGrepResultDetails> {
  const base = createGrepToolDefinition(process.cwd());
  return {
    name: base.name,
    label: base.label,
    description: GREP_DESCRIPTION,
    promptSnippet: "Search text by regex or literal; results work with read.",
    promptGuidelines: base.promptGuidelines,
    parameters: grepParameters,
    prepareArguments: prepareGrepArguments,
    constrainedSampling: base.constrainedSampling,
    executionMode: base.executionMode,
    async execute(_toolCallId, rawInput, signal, _onUpdate, ctx) {
      let artifact: ProcessArtifact | undefined;
      try {
        const input = normalizeGrepInput(rawInput);
        const mode = input.mode ?? "content";
        const searchRoot = normalizeSearchRoot(input.path, ctx.cwd);
        if (signal?.aborted) throw new Error("Operation aborted");
        if (mode !== "exists") artifact = await createSearchArtifact(options?.onArtifactCreated);
        const capture = createSearchCapture();
        const { ignore_case, mode: _mode, include_ignored: _includeIgnored, ...baseInput } = input;
        const executable = mode === "content"
          ? await ensureSearchExecutable(
            options?.executable,
            ["rg"],
            ctx.cwd,
            () => base.execute(
              _toolCallId,
              { ...baseInput, ...(ignore_case === undefined ? {} : { ignoreCase: ignore_case }), limit: 1 },
              signal,
              _onUpdate as Parameters<typeof base.execute>[3],
              ctx,
            ),
            signal,
          )
          : await resolveSearchExecutable(options?.executable, ["rg"], ctx.cwd);
        const exists = await captureGrep(input, searchRoot, ctx.cwd, executable, capture, signal);
        if (mode === "exists") {
          const witness = exists === true;
          const termination = witness ? "match" : "eof";
          return {
            content: [{ type: "text", text: `[grep: mode=exists; exists=${witness}; termination=${termination}; capture=complete]` }],
            details: {
              ok: true,
              tool: "grep",
              mode,
              exists: witness,
              termination,
              result_count: witness ? 1 : 0,
              shown_count: witness ? 1 : 0,
              preview: "complete",
              capture: "complete",
              read_paths: [],
            },
          };
        }
        if (!artifact) throw new Error("Search artifact is not available");
        const totalMatches = countShown(mode, capture.records);
        const matchingLines = capturedMatchingLines(capture);
        const artifactDetails = await writeSearchArtifact(artifact, "grep", capture, {
          search_root: searchRoot,
          pattern: input.pattern,
          mode,
          include_ignored: input.include_ignored,
          result_count: totalMatches,
          ...(mode === "count" ? {
            total_matching_lines: capture.complete ? matchingLines : null,
            captured_matching_lines: matchingLines,
          } : {}),
        }, signal);
        if (totalMatches === 0 && capture.complete && mode !== "count") {
          await removeSearchArtifact(artifact.directory);
          return {
            content: [{ type: "text", text: "No matches found" }],
            details: {
              ok: true,
              tool: "grep",
              mode,
              result_count: 0,
              shown_count: 0,
              preview: "complete",
              capture: "complete",
              read_paths: [],
            },
          };
        }
        const limit = normalizeLimit(input.limit, mode === "content" ? DEFAULT_GREP_LIMIT : DEFAULT_GREP_FILES_LIMIT);
        const preview = buildPreview(mode, capture, limit, totalMatches, artifactDetails);
        const countLimited = totalMatches > limit;
        const previewTruncated = countLimited || preview.byteTruncated || preview.lineTruncated;
        const needsArtifact = previewTruncated || !capture.complete;
        if (!needsArtifact) await removeSearchArtifact(artifact.directory);
        const readPaths = [...new Set(preview.outputRecords.map((record) => record.readPath))];
        const details: AgentGrepToolDetails = {
          ok: true,
          tool: "grep",
          result_count: totalMatches,
          shown_count: countShown(mode, preview.outputRecords),
          preview: previewTruncated ? "truncated" : "complete",
          capture: capture.complete ? "complete" : "incomplete",
          read_paths: readPaths,
          ...(preview.truncation ? { truncation: preview.truncation } : {}),
          ...(needsArtifact ? { artifact: artifactDetails } : {}),
          ...(mode === "count" ? {
            mode,
            counts: preview.outputRecords.map((record) => ({ path: record.readPath, matching_lines: record.matchingLines! })),
            total_matching_lines: capture.complete ? matchingLines : null,
            captured_matching_lines: matchingLines,
          } : mode === "content" ? {
            mode,
            ...(countLimited ? { match_limit: limit } : {}),
            ...(preview.lineTruncated ? { lines_truncated: true } : {}),
          } : { mode }),
        };
        return { content: [{ type: "text", text: preview.text }], details };
      } catch (error) {
        if (artifact) await removeSearchArtifact(artifact.directory).catch(() => undefined);
        return searchFailure("grep", error, signal);
      }
    },
    renderCall: base.renderCall
      ? (args, theme, context) => {
        const { ignore_case, mode: _mode, include_ignored: _includeIgnored, ...baseArgs } = args;
        return base.renderCall!(
          { ...baseArgs, ...(ignore_case === undefined ? {} : { ignoreCase: ignore_case }) },
          theme,
          context as never,
        );
      }
      : undefined,
    renderResult: base.renderResult
      ? (result, options, theme, context) => {
        const details = result.details;
        if (details?.ok && details.mode !== "content") {
          const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
          return new Text(text, 0, 0);
        }
        const compatible = details?.ok
          ? {
            ...details,
            ...(details.match_limit === undefined ? {} : { matchLimitReached: details.match_limit }),
            ...(details.lines_truncated === undefined ? {} : { linesTruncated: details.lines_truncated }),
          }
          : details;
        return base.renderResult!(
          { ...result, details: compatible } as unknown as AgentToolResult<GrepToolDetails | undefined>,
          options,
          theme,
          context as never,
        );
      }
      : undefined,
  };
}
