import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import path, { delimiter } from "node:path";
import { Type, type Static } from "typebox";
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
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_GREP_LIMIT = 100;

const findParameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files, for example '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
  path: Type.Optional(Type.String({ description: "Directory to search in; default: current directory" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results; default: 1000" })),
});

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Search pattern; regular expression by default" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search; default: current directory" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, for example '*.ts' or '**/*.spec.ts'" })),
  ignore_case: Type.Optional(Type.Boolean({ description: "Use case-insensitive search; default: false" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text; default: false" })),
  context: Type.Optional(Type.Number({ description: "Number of lines before and after each match; default: 0" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return; default: 100" })),
});

export type CodexFindInput = Static<typeof findParameters>;
export type CodexGrepInput = Static<typeof grepParameters>;

const FIND_DESCRIPTION = "Find paths by glob pattern. Regular-file results are directly reusable by read. Respects .gitignore. The result-count default is 1,000. Text output is capped at 50 KiB. Truncated results expose a complete plain-text artifact when capture succeeds.";
const GREP_DESCRIPTION = "Search file contents for a pattern. Patterns use regular expressions by default; set literal to true for exact text. The preview groups matches under session-resolvable paths that can be passed directly to read. Artifacts repeat the path on every record. Respects .gitignore. The match-count default is 100. Text output is capped at 50 KiB. Lines are capped at 500 characters. Truncated results expose a complete plain-text artifact when capture succeeds.";

type SearchCaptureState = "complete" | "incomplete";
type SearchToolName = "find" | "grep";

export interface CodexFindToolOptions extends FindToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  executable?: string;
}

export interface CodexGrepToolOptions {
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

export type CodexFindToolDetails = SearchSuccessDetails<"find"> & {
  result_limit?: number;
};

export type CodexGrepToolDetails = SearchSuccessDetails<"grep"> & {
  match_limit?: number;
  lines_truncated?: boolean;
};

export type CodexFindResultDetails = CodexFindToolDetails | ToolFailureDetails<"find", SearchErrorCode>;
export type CodexGrepResultDetails = CodexGrepToolDetails | ToolFailureDetails<"grep", SearchErrorCode>;

interface SearchRecord {
  text: string;
  readPath: string;
  match: boolean;
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

function prepareFindArguments(rawInput: unknown): CodexFindInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { pattern: "\0" };
  if (typeof prepared.pattern !== "string") prepared.pattern = "\0";
  if (prepared.path !== undefined && typeof prepared.path !== "string") prepared.path = "\0";
  if (prepared.limit !== undefined && typeof prepared.limit !== "number") prepared.limit = -1;
  return prepared as CodexFindInput;
}

function prepareGrepArguments(rawInput: unknown): CodexGrepInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { pattern: "\0" };
  if (typeof prepared.pattern !== "string") prepared.pattern = "\0";
  if (prepared.path !== undefined && typeof prepared.path !== "string") prepared.path = "\0";
  if (prepared.glob !== undefined && typeof prepared.glob !== "string") prepared.glob = "\0";
  if (prepared.context !== undefined && typeof prepared.context !== "number") prepared.context = -1;
  if (prepared.limit !== undefined && typeof prepared.limit !== "number") prepared.limit = -1;
  for (const field of ["ignore_case", "literal"] as const) {
    if (prepared[field] !== undefined && typeof prepared[field] !== "boolean") {
      prepared[field] = false;
      prepared.limit = -1;
    }
  }
  return prepared as CodexGrepInput;
}

function normalizeFindInput(rawInput: unknown): CodexFindInput {
  if (!isRecord(rawInput)) throw new Error("Input must be an object");
  const allowed = new Set(["pattern", "path", "limit"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown input field: ${unknown}`);
  if (typeof rawInput.pattern !== "string" || rawInput.pattern.includes("\0")) {
    throw new Error("pattern must be a string without NUL");
  }
  if (rawInput.path !== undefined && (typeof rawInput.path !== "string" || rawInput.path.includes("\0"))) {
    throw new Error("path must be a string without NUL");
  }
  if (rawInput.limit !== undefined && typeof rawInput.limit !== "number") throw new Error("limit must be a number");
  return rawInput as CodexFindInput;
}

function normalizeGrepInput(rawInput: unknown): CodexGrepInput {
  if (!isRecord(rawInput)) throw new Error("Input must be an object");
  const allowed = new Set(["pattern", "path", "glob", "ignore_case", "literal", "context", "limit"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown input field: ${unknown}`);
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
    && (typeof rawInput.context !== "number" || !Number.isFinite(rawInput.context) || rawInput.context < 0)
  ) {
    throw new Error("context must be a nonnegative number");
  }
  if (rawInput.limit !== undefined && typeof rawInput.limit !== "number") throw new Error("limit must be a number");
  return rawInput as CodexGrepInput;
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
    : /^(Input must|Unknown input field|Invalid regular expression|pattern must|path must|glob must|ignore_case must|literal must|context must|limit must)/.test(message)
      ? "INVALID_INPUT"
      : /Cannot find/.test(message)
        ? "EXECUTABLE_NOT_FOUND"
        : /artifact/i.test(message)
          ? "ARTIFACT_FAILED"
          : "SEARCH_FAILED";
  const bounded = Buffer.byteLength(message) <= 4_096 ? message : `${message.slice(0, 4_093)}...`;
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
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("limit must be a positive number");
  }
  return Math.max(1, Math.floor(value));
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
  return !record.includes("\n")
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

function footerFor(
  tool: SearchToolName,
  shown: number,
  total: number,
  byteTruncated: boolean,
  lineTruncated: boolean,
  artifact: SearchArtifactDetails,
): string {
  const fields = [
    `${tool === "find" ? "results" : "matches"}=${shown}/${total}`,
    `preview=${shown < total || byteTruncated || lineTruncated ? "truncated" : "complete"}`,
  ];
  if (byteTruncated) fields.push("limit=50KiB");
  if (lineTruncated) fields.push("lines_truncated=true");
  fields.push(`capture=${artifact.capture}`);
  fields.push(`artifact=${artifact.path}`);
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
    const separatorBytes = 2;
    if (bytes + lineBytes + separatorBytes + footerBytes > MAX_SEARCH_TEXT_BYTES) break;
    selected.push(item);
    bytes += lineBytes;
  }
  const content = selected.map((item) => item.text).join("\n");
  return {
    text: content.length > 0 ? `${content}\n\n${footer}` : footer,
    outputRecords: selected.map((item) => item.record),
  };
}

function countShown(tool: SearchToolName, records: SearchRecord[]): number {
  return tool === "find" ? records.length : records.filter((record) => record.match).length;
}

function buildPreview(
  tool: SearchToolName,
  capture: SearchCapture,
  limit: number,
  totalMatches: number,
  artifact: SearchArtifactDetails,
): SearchPreview {
  const limitedRecords: SearchRecord[] = [];
  let selectedMatches = 0;
  for (const record of capture.records) {
    if (tool === "grep" && record.match) {
      if (selectedMatches >= limit) break;
      selectedMatches += 1;
    } else if (tool === "find" && limitedRecords.length >= limit) {
      break;
    }
    limitedRecords.push(record);
  }
  if (tool === "find") selectedMatches = limitedRecords.length;

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

  if (!needsArtifact) {
    return {
      text: rawText,
      outputRecords: limitedRecords,
      byteTruncated: false,
      lineTruncated: false,
    };
  }

  let shown = selectedMatches;
  let fitted = fitPreviewLines(
    rendered,
    footerFor(tool, shown, totalMatches, byteTruncated, lineTruncated, artifact),
  );
  for (let pass = 0; pass < 4; pass += 1) {
    if (fitted.outputRecords.length < rendered.length) byteTruncated = true;
    const nextShown = countShown(tool, fitted.outputRecords);
    const footer = footerFor(tool, nextShown, totalMatches, byteTruncated, lineTruncated, artifact);
    const next = fitPreviewLines(rendered, footer);
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
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
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
  if (process.platform === "win32") throw new Error("Codex search tools do not support Windows");
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

async function captureFindWithFd(
  pattern: string,
  searchRoot: string,
  cwd: string,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
  configuredExecutable: string | undefined,
): Promise<void> {
  const info = await stat(searchRoot).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Path not found: ${searchRoot}`);
  const args = ["--glob", "--color=never", "--hidden", "--print0", "--exclude", ".git", "--exclude", "node_modules"];
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

  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    let stderr = "";
    let stoppedForLimit = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectRun(error);
      else resolveRun();
    };
    const onAbort = (): void => {
      aborted = true;
      stopChild(child);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      while (true) {
        const delimiter = pending.indexOf(0);
        if (delimiter < 0) break;
        const raw = pending.subarray(0, delimiter);
        pending = pending.subarray(delimiter + 1);
        if (raw.length === 0) continue;
        const decoded = decodeUtf8(raw);
        if (decoded === undefined) {
          capture.complete = false;
          capture.unsupportedRecords += 1;
          continue;
        }
        const readPath = toSessionReadPath(decoded, searchRoot, cwd);
        if (!appendSearchRecord(capture, { text: readPath, readPath, match: true })) {
          stoppedForLimit = true;
          stopChild(child);
          killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
          break;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(new Error(`Failed to run fd: ${error.message}`)));
    child.once("close", (code) => {
      if (aborted || signal?.aborted) return finish(new Error("Operation aborted"));
      if (pending.length > 0) {
        capture.complete = false;
        capture.malformedRecords += 1;
      }
      if (!stoppedForLimit && code !== 0) {
        const message = stderr.trim() || `fd exited with code ${code}`;
        if (capture.records.length === 0) return finish(new Error(message));
        capture.complete = false;
        capture.captureError = message;
      }
      finish();
    });
  });
}

async function captureFind(
  pattern: string,
  searchRoot: string,
  cwd: string,
  options: CodexFindToolOptions | undefined,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!options?.operations) {
    await captureFindWithFd(pattern, searchRoot, cwd, capture, signal, options?.executable);
    return;
  }
  if (!await options.operations.exists(searchRoot)) throw new Error(`Path not found: ${searchRoot}`);
  const results = await options.operations.glob(pattern, searchRoot, {
    ignore: ["**/node_modules/**", "**/.git/**"],
    limit: Number.MAX_SAFE_INTEGER,
  });
  if (signal?.aborted) throw new Error("Operation aborted");
  for (const result of results) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const readPath = toSessionReadPath(result, searchRoot, cwd);
    if (!appendSearchRecord(capture, { text: readPath, readPath, match: true })) break;
  }
}

function eventText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("bytes" in value && typeof value.bytes === "string") {
    return decodeUtf8(Buffer.from(value.bytes, "base64"));
  }
  return undefined;
}

function stripOneLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

async function captureGrep(
  input: Record<string, unknown>,
  searchRoot: string,
  cwd: string,
  options: CodexGrepToolOptions | undefined,
  capture: SearchCapture,
  signal: AbortSignal | undefined,
): Promise<number> {
  await stat(searchRoot).catch(() => { throw new Error(`Path not found: ${searchRoot}`); });
  if (typeof input.pattern !== "string") throw new Error("pattern must be a string");
  const args = ["--json", "--heading", "--line-number", "--color=never", "--hidden"];
  if (input.ignore_case === true) args.push("--ignore-case");
  if (input.literal === true) args.push("--fixed-strings");
  if (typeof input.glob === "string") args.push("--glob", input.glob);
  if (typeof input.context === "number" && input.context > 0) {
    args.push("--context", String(Math.floor(input.context)));
  }
  args.push("--", input.pattern, searchRoot);
  const executable = await resolveSearchExecutable(options?.executable, ["rg"], cwd);

  return new Promise<number>((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    let rawBytes = 0;
    let stderr = "";
    let matchCount = 0;
    let stoppedForLimit = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectRun(error);
      else resolveRun(matchCount);
    };
    const requestLimitStop = (): void => {
      capture.complete = false;
      capture.stoppedAtLimit = true;
      stoppedForLimit = true;
      stopChild(child);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const onAbort = (): void => {
      aborted = true;
      stopChild(child);
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    const processLine = (line: Buffer): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.toString("utf8"));
      } catch {
        capture.complete = false;
        capture.malformedRecords += 1;
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        capture.complete = false;
        capture.malformedRecords += 1;
        return;
      }
      const event = parsed as Record<string, unknown>;
      if (event.type !== "match" && event.type !== "context") return;
      const data = event.data;
      if (typeof data !== "object" || data === null) {
        capture.complete = false;
        capture.malformedRecords += 1;
        return;
      }
      const filePath = eventText("path" in data ? data.path : undefined);
      const lineText = eventText("lines" in data ? data.lines : undefined);
      const lineNumber = "line_number" in data ? data.line_number : undefined;
      if (event.type === "match") matchCount += 1;
      if (filePath === undefined || lineText === undefined || typeof lineNumber !== "number") {
        capture.complete = false;
        capture.unsupportedRecords += 1;
        return;
      }
      const readPath = toSessionReadPath(filePath, searchRoot, cwd);
      const sourceText = stripOneLineEnding(lineText);
      const separator = event.type === "match" ? ":" : "-";
      const artifactPrefix = `${readPath}${separator}${lineNumber}${separator} `;
      if (!appendSearchRecord(capture, {
        text: `${artifactPrefix}${sourceText}`,
        readPath,
        match: event.type === "match",
        sourceText,
        lineNumber,
        separator,
      })) requestLimitStop();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (rawChunk: Buffer) => {
      if (stoppedForLimit) return;
      const chunk = Buffer.from(rawChunk);
      const available = Math.max(0, MAX_SEARCH_CAPTURE_BYTES - rawBytes);
      const selected = chunk.subarray(0, available);
      rawBytes += selected.length;
      pending = Buffer.concat([pending, selected]);
      while (!stoppedForLimit) {
        const delimiterIndex = pending.indexOf(10);
        if (delimiterIndex < 0) break;
        const line = pending.subarray(0, delimiterIndex);
        pending = pending.subarray(delimiterIndex + 1);
        if (line.length > 0) processLine(line);
      }
      if (selected.length < chunk.length || (available === 0 && chunk.length > 0)) requestLimitStop();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish(new Error(`Failed to run ripgrep: ${error.message}`)));
    child.once("close", (code) => {
      if (aborted || signal?.aborted) return finish(new Error("Operation aborted"));
      if (pending.length > 0) {
        capture.complete = false;
        capture.malformedRecords += 1;
      }
      if (!stoppedForLimit && code !== 0 && code !== 1) {
        const message = stderr.trim() || `ripgrep exited with code ${code}`;
        const diagnostic = regexParseError(message) ?? message;
        if (capture.records.length === 0) return finish(new Error(diagnostic));
        capture.complete = false;
        capture.captureError = diagnostic;
      }
      finish();
    });
  });
}

/** Create a Codex find tool with normalized output and recoverable truncation. */
export function createCodexFindTool(
  options?: CodexFindToolOptions,
): ToolDefinition<typeof findParameters, CodexFindResultDetails> {
  const base = createFindToolDefinition(process.cwd(), options);
  return {
    name: base.name,
    label: base.label,
    description: FIND_DESCRIPTION,
    promptSnippet: "Find paths by glob pattern. Regular-file results can be passed directly to read.",
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
        await captureFind(input.pattern, searchRoot, ctx.cwd, runOptions, capture, signal);
        const artifactDetails = await writeSearchArtifact(artifact, "find", capture, {
          search_root: searchRoot,
          pattern: input.pattern,
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
        const details: CodexFindToolDetails = {
          ok: true,
          tool: "find",
          result_count: capture.records.length,
          shown_count: preview.outputRecords.length,
          preview: needsArtifact ? "truncated" : "complete",
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

/** Create a Codex grep tool with canonical read paths and recoverable truncation. */
export function createCodexGrepTool(
  options?: CodexGrepToolOptions,
): ToolDefinition<typeof grepParameters, CodexGrepResultDetails> {
  const base = createGrepToolDefinition(process.cwd());
  return {
    name: base.name,
    label: base.label,
    description: GREP_DESCRIPTION,
    promptSnippet: "Search file contents grouped under paths that can be passed directly to read.",
    promptGuidelines: base.promptGuidelines,
    parameters: grepParameters,
    prepareArguments: prepareGrepArguments,
    constrainedSampling: base.constrainedSampling,
    executionMode: base.executionMode,
    async execute(_toolCallId, rawInput, signal, _onUpdate, ctx) {
      let artifact: ProcessArtifact | undefined;
      try {
        const input = normalizeGrepInput(rawInput);
        const searchRoot = normalizeSearchRoot(input.path, ctx.cwd);
        const limit = normalizeLimit(input.limit, DEFAULT_GREP_LIMIT);
        artifact = await createSearchArtifact(options?.onArtifactCreated);
        const capture = createSearchCapture();
        const { ignore_case, ...baseInput } = input;
        const executable = await ensureSearchExecutable(
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
        );
        const totalMatches = await captureGrep(
          input as Record<string, unknown>,
          searchRoot,
          ctx.cwd,
          { ...options, executable },
          capture,
          signal,
        );
        const artifactDetails = await writeSearchArtifact(artifact, "grep", capture, {
          search_root: searchRoot,
          pattern: input.pattern,
          matches: totalMatches,
        }, signal);
        if (totalMatches === 0 && capture.complete) {
          await removeSearchArtifact(artifact.directory);
          return {
            content: [{ type: "text", text: "No matches found" }],
            details: {
              ok: true,
              tool: "grep",
              result_count: 0,
              shown_count: 0,
              preview: "complete",
              capture: "complete",
              read_paths: [],
            },
          };
        }
        const preview = buildPreview("grep", capture, limit, totalMatches, artifactDetails);
        const countLimited = totalMatches > limit;
        const needsArtifact = countLimited || preview.byteTruncated || preview.lineTruncated || !capture.complete;
        if (!needsArtifact) await removeSearchArtifact(artifact.directory);
        const readPaths = [...new Set(preview.outputRecords.map((record) => record.readPath))];
        const details: CodexGrepToolDetails = {
          ok: true,
          tool: "grep",
          result_count: totalMatches,
          shown_count: preview.outputRecords.filter((record) => record.match).length,
          preview: needsArtifact ? "truncated" : "complete",
          capture: capture.complete ? "complete" : "incomplete",
          read_paths: readPaths,
          ...(countLimited ? { match_limit: limit } : {}),
          ...(preview.truncation ? { truncation: preview.truncation } : {}),
          ...(preview.lineTruncated ? { lines_truncated: true } : {}),
          ...(needsArtifact ? { artifact: artifactDetails } : {}),
        };
        return {
          content: [{ type: "text", text: preview.text }],
          details,
        };
      } catch (error) {
        if (artifact) await removeSearchArtifact(artifact.directory).catch(() => undefined);
        return searchFailure("grep", error, signal);
      }
    },
    renderCall: base.renderCall
      ? (args, theme, context) => {
        const { ignore_case, ...baseArgs } = args;
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
