import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionContext,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";

const MAX_FILE_BYTES = 67_108_864;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_LINE_COUNT = 2_000;
const MAX_LINE_PAGE_BYTES = 40_960;
const MAX_UTF8_PAGE_BYTES = 40_960;
const MAX_BASE64_PAGE_BYTES = 30_720;

const readParameters = Type.Object({
  path: Type.String({ description: "Required string path to the file to read" }),
  mode: Type.Optional(Type.String({ description: "String enum: lines (default) or bytes" })),
  start_line: Type.Optional(Type.Number({ description: "Line mode only: one-based integer from 1 through 2147483647; default 1" })),
  max_lines: Type.Optional(Type.Number({ description: "Line mode only: integer from 1 through 2000; default 500" })),
  show_line_numbers: Type.Optional(Type.Boolean({ description: "Line mode only: prefix actual 1-based line numbers; default false" })),
  max_bytes: Type.Optional(Type.Number({ description: "Raw source-byte page limit; line or UTF-8 byte mode: 1 through 40960; Base64 byte mode: 1 through 30720" })),
  start_byte: Type.Optional(Type.Number({ description: "Byte mode only: zero-based integer from 0 through 67108864; default 0" })),
  encoding: Type.Optional(Type.String({ description: "Byte mode only: string enum utf8 (default) or base64" })),
});

export type CodexReadInput = Static<typeof readParameters>;

type ReadMode = "lines" | "bytes";
type ByteEncoding = "utf8" | "base64";

interface NormalizedReadInput {
  path: string;
  mode: ReadMode;
  startLine?: number;
  maxLines?: number;
  showLineNumbers?: boolean;
  maxBytes: number;
  startByte?: number;
  encoding?: ByteEncoding;
}

export type ReadErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "NOT_READABLE"
  | "UNSUPPORTED_FILE_TYPE"
  | "RESOURCE_LIMIT"
  | "INVALID_ENCODING"
  | "INVALID_BYTE_BOUNDARY"
  | "BYTE_PAGE_TOO_SMALL"
  | "LINE_TOO_LONG"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface ReadFile {
  path: string;
  total_bytes: number;
}

export interface ReadLinesResult {
  ok: true;
  mode: "lines";
  file: ReadFile & { total_lines: number };
  content: string;
  start_line: number | null;
  end_line: number | null;
  has_more: boolean;
  next_start_line: number | null;
  limited_by: "none" | "lines" | "bytes" | "formatted_bytes";
  show_line_numbers: boolean;
  source_bytes: number;
  formatted_bytes: number;
}

export interface ReadBytesResult {
  ok: true;
  mode: "bytes";
  file: ReadFile;
  encoding: ByteEncoding;
  content: string;
  start_byte: number;
  end_byte: number;
  has_more: boolean;
  next_start_byte: number | null;
}

export interface ReadFailure {
  ok: false;
  error: {
    code: ReadErrorCode;
    message: string;
    path?: string;
    line?: number;
    byte_offset?: number;
  };
}

export type ReadResult = ReadLinesResult | ReadBytesResult | ReadFailure;

export type ReadToolDetails =
  | (ToolSuccessDetails<"read"> & {
    mode: "lines";
    path: string;
    total_bytes: number;
    total_lines: number;
    start_line: number | null;
    end_line: number | null;
    next_start_line: number | null;
    limited_by: "none" | "lines" | "bytes" | "formatted_bytes";
    show_line_numbers: boolean;
    source_bytes: number;
    formatted_bytes: number;
  })
  | (ToolSuccessDetails<"read"> & {
    mode: "bytes";
    path: string;
    total_bytes: number;
    encoding: ByteEncoding;
    start_byte: number;
    end_byte: number;
    next_start_byte: number | null;
  })
  | (ToolFailureDetails<"read", ReadErrorCode> & {
    error: ReadFailure["error"];
  });

class ReadToolError extends Error {
  readonly code: ReadErrorCode;
  readonly path: string | undefined;
  readonly line: number | undefined;
  readonly byteOffset: number | undefined;

  constructor(
    code: ReadErrorCode,
    message: string,
    path?: string,
    line?: number,
    byteOffset?: number,
  ) {
    super(message);
    this.code = code;
    this.path = path;
    this.line = line;
    this.byteOffset = byteOffset;
  }
}

interface FileBuffer {
  path: string;
  bytes: Buffer;
}

interface LineSpan {
  start: number;
  end: number;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function prepareReadArguments(rawInput: unknown): CodexReadInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { path: "" };
  if (typeof prepared.path !== "string") prepared.path = "";
  if (prepared.mode !== undefined && typeof prepared.mode !== "string") prepared.mode = "";
  for (const field of ["start_line", "max_lines", "max_bytes", "start_byte"] as const) {
    if (prepared[field] !== undefined && typeof prepared[field] !== "number") prepared[field] = -1;
  }
  if (prepared.show_line_numbers !== undefined && typeof prepared.show_line_numbers !== "boolean") {
    prepared.show_line_numbers = false;
    prepared.max_bytes = -1;
  }
  if (prepared.encoding !== undefined && typeof prepared.encoding !== "string") prepared.encoding = "";
  return prepared as CodexReadInput;
}

function fail(
  code: ReadErrorCode,
  message: string,
  path?: string,
  line?: number,
  byteOffset?: number,
): ReadFailure {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(line === undefined ? {} : { line }),
      ...(byteOffset === undefined ? {} : { byte_offset: byteOffset }),
    },
  };
}

function validateInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ReadToolError("INVALID_INPUT", `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function normalizeInput(rawInput: unknown): NormalizedReadInput {
  if (!isRecord(rawInput)) {
    throw new ReadToolError("INVALID_INPUT", "Input must be an object");
  }
  const allowedKeys = new Set([
    "path",
    "mode",
    "start_line",
    "max_lines",
    "show_line_numbers",
    "max_bytes",
    "start_byte",
    "encoding",
  ]);
  const unknownKey = Object.keys(rawInput).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new ReadToolError("INVALID_INPUT", `Unknown input field: ${unknownKey}`);
  }

  if (typeof rawInput.path !== "string" || rawInput.path.length === 0 || rawInput.path.includes("\0")) {
    throw new ReadToolError("INVALID_INPUT", "path must be a nonempty string without NUL");
  }

  const path = rawInput.path.startsWith("@") ? rawInput.path.slice(1) : rawInput.path;
  if (path.length === 0) {
    throw new ReadToolError("INVALID_INPUT", "path must not be only @");
  }

  const mode = rawInput.mode === undefined ? "lines" : rawInput.mode;
  if (mode !== "lines" && mode !== "bytes") {
    throw new ReadToolError("INVALID_INPUT", "mode must be lines or bytes");
  }

  if (mode === "lines") {
    if (hasOwn(rawInput, "start_byte") || hasOwn(rawInput, "encoding")) {
      throw new ReadToolError("INVALID_INPUT", "start_byte and encoding are valid only in byte mode");
    }

    if (rawInput.show_line_numbers !== undefined && typeof rawInput.show_line_numbers !== "boolean") {
      throw new ReadToolError("INVALID_INPUT", "show_line_numbers must be a boolean");
    }

    return {
      path,
      mode,
      startLine: rawInput.start_line === undefined
        ? 1
        : validateInteger(rawInput.start_line, "start_line", 1, 2_147_483_647),
      maxLines: rawInput.max_lines === undefined
        ? 500
        : validateInteger(rawInput.max_lines, "max_lines", 1, MAX_LINE_COUNT),
      showLineNumbers: rawInput.show_line_numbers ?? false,
      maxBytes: rawInput.max_bytes === undefined
        ? 32_768
        : validateInteger(rawInput.max_bytes, "max_bytes", 1, MAX_LINE_PAGE_BYTES),
    };
  }

  if (hasOwn(rawInput, "start_line") || hasOwn(rawInput, "max_lines") || hasOwn(rawInput, "show_line_numbers")) {
    throw new ReadToolError(
      "INVALID_INPUT",
      "start_line, max_lines, and show_line_numbers are valid only in line mode",
    );
  }

  const encoding = rawInput.encoding === undefined ? "utf8" : rawInput.encoding;
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new ReadToolError("INVALID_INPUT", "encoding must be utf8 or base64");
  }

  return {
    path,
    mode,
    startByte: rawInput.start_byte === undefined
      ? 0
      : validateInteger(rawInput.start_byte, "start_byte", 0, MAX_FILE_BYTES),
    maxBytes: rawInput.max_bytes === undefined
      ? 32_768
      : validateInteger(
        rawInput.max_bytes,
        "max_bytes",
        1,
        encoding === "base64" ? MAX_BASE64_PAGE_BYTES : MAX_UTF8_PAGE_BYTES,
      ),
    encoding,
  };
}

function mapFilesystemError(error: unknown, path: string, operation: string): ReadToolError {
  if (error instanceof ReadToolError) return error;
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return new ReadToolError("NOT_FOUND", `Cannot ${operation}: file was not found`, path);
    }
    if (code === "EACCES" || code === "EPERM") {
      return new ReadToolError("NOT_READABLE", `Cannot ${operation}: permission was denied`, path);
    }
    if (code === "EISDIR") {
      return new ReadToolError("UNSUPPORTED_FILE_TYPE", "The target is not a regular file", path);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ReadToolError("INTERNAL_ERROR", `Cannot ${operation}: ${message}`, path);
}

const decoderOptions = { fatal: true, ignoreBOM: true } as const;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && ((error as NodeJS.ErrnoException).code === "ABORT_ERR" || error.name === "AbortError");
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReadToolError("CANCELLED", "Read was cancelled");
}

async function loadFileBuffer(
  input: NormalizedReadInput,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<FileBuffer> {
  checkCancelled(signal);
  const requestedPath = resolve(cwd, input.path);
  let canonicalPath: string;

  try {
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    throw mapFilesystemError(error, requestedPath, "resolve path");
  }

  try {
    const fileInfo = await stat(canonicalPath);
    if (!fileInfo.isFile()) {
      throw new ReadToolError("UNSUPPORTED_FILE_TYPE", "The target is not a regular file", canonicalPath);
    }
    if (fileInfo.size > MAX_FILE_BYTES) {
      throw new ReadToolError("RESOURCE_LIMIT", "The file exceeds the 67108864-byte limit", canonicalPath);
    }

    checkCancelled(signal);
    const bytes = await readFile(canonicalPath, signal ? { signal } : undefined);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new ReadToolError("RESOURCE_LIMIT", "The file exceeds the 67108864-byte limit", canonicalPath);
    }
    return { path: canonicalPath, bytes };
  } catch (error) {
    if (isAbortError(error)) throw new ReadToolError("CANCELLED", "Read was cancelled");
    if (error instanceof ReadToolError) throw error;
    throw mapFilesystemError(error, canonicalPath, "read file");
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", decoderOptions).decode(bytes);
  } catch {
    throw new ReadToolError("INVALID_ENCODING", "The file is not valid UTF-8");
  }
}

function countLogicalLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lineFeeds = 0;
  for (const byte of bytes) {
    if (byte === 10) lineFeeds += 1;
  }
  return lineFeeds + (bytes[bytes.length - 1] === 10 ? 0 : 1);
}

function findLineSpan(bytes: Buffer, targetLine: number): LineSpan | undefined {
  let line = 1;
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue;
    if (line === targetLine) return { start, end: index + 1 };
    line += 1;
    start = index + 1;
  }
  if (start < bytes.length && line === targetLine) return { start, end: bytes.length };
  return undefined;
}

function findNextLineSpan(bytes: Buffer, previous: LineSpan): LineSpan | undefined {
  if (previous.end >= bytes.length) return undefined;
  const start = previous.end;
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 10) return { start, end: index + 1 };
  }
  return { start, end: bytes.length };
}

function lineFooter(startLine: number | null, endLine: number | null, hasMore: boolean): string {
  if (startLine === null || endLine === null) {
    return "[lines none; next_start_line=null; eof=true]";
  }
  return `[lines ${startLine}-${endLine}; next_start_line=${hasMore ? endLine + 1 : "null"}; eof=${!hasMore}]`;
}

function byteFooter(startByte: number, endByte: number, hasMore: boolean): string {
  if (startByte === endByte && !hasMore) {
    return "[bytes none; next_start_byte=null; eof=true]";
  }
  return `[bytes ${startByte},${endByte}); next_start_byte=${hasMore ? endByte : "null"}; eof=${!hasMore}]`;
}

function contentWithFooter(content: string, footer: string): string {
  if (content.length === 0) return footer;
  return content.endsWith("\n") ? `${content}\n${footer}` : `${content}\n\n${footer}`;
}

function renderLineSpans(
  bytes: Buffer,
  spans: LineSpan[],
  startLine: number,
  showLineNumbers: boolean,
): string {
  if (spans.length === 0) return "";
  if (!showLineNumbers) {
    return new TextDecoder("utf-8", decoderOptions).decode(
      bytes.subarray(spans[0]!.start, spans[spans.length - 1]!.end),
    );
  }
  const endLine = startLine + spans.length - 1;
  const width = String(endLine).length;
  return spans.map((span, index) => {
    const lineNumber = String(startLine + index).padStart(width, " ");
    const source = new TextDecoder("utf-8", decoderOptions).decode(bytes.subarray(span.start, span.end));
    return `${lineNumber} │ ${source}`;
  }).join("");
}

function buildLineResult(
  input: NormalizedReadInput & {
    mode: "lines";
    startLine: number;
    maxLines: number;
    showLineNumbers: boolean;
  },
  fileBuffer: FileBuffer,
  signal: AbortSignal | undefined,
): ReadLinesResult {
  decodeUtf8(fileBuffer.bytes);
  checkCancelled(signal);
  const totalLines = countLogicalLines(fileBuffer.bytes);
  const file = { path: fileBuffer.path, total_bytes: fileBuffer.bytes.length, total_lines: totalLines };

  if (input.startLine > totalLines || totalLines === 0) {
    const footer = lineFooter(null, null, false);
    return {
      ok: true,
      mode: "lines",
      file,
      content: "",
      start_line: null,
      end_line: null,
      has_more: false,
      next_start_line: null,
      limited_by: "none",
      show_line_numbers: input.showLineNumbers,
      source_bytes: 0,
      formatted_bytes: Buffer.byteLength(footer),
    };
  }

  const eligible: LineSpan[] = [];
  let sourceBytes = 0;
  let span = findLineSpan(fileBuffer.bytes, input.startLine);
  let sourceLimitedBy: "none" | "lines" | "bytes" = "none";
  while (span && eligible.length < input.maxLines) {
    checkCancelled(signal);
    const lineBytes = span.end - span.start;
    if (eligible.length === 0 && lineBytes > input.maxBytes) {
      throw new ReadToolError(
        "LINE_TOO_LONG",
        "The first requested line exceeds max_bytes",
        fileBuffer.path,
        input.startLine,
        span.start,
      );
    }
    if (sourceBytes + lineBytes > input.maxBytes) {
      sourceLimitedBy = "bytes";
      break;
    }
    eligible.push(span);
    sourceBytes += lineBytes;
    span = findNextLineSpan(fileBuffer.bytes, span);
  }

  const eligibleEndLine = input.startLine + eligible.length - 1;
  if (eligibleEndLine >= totalLines) sourceLimitedBy = "none";
  else if (eligible.length === input.maxLines) sourceLimitedBy = "lines";

  const formattedPage = (count: number): { content: string; text: string } => {
    const selected = eligible.slice(0, count);
    const content = renderLineSpans(fileBuffer.bytes, selected, input.startLine, input.showLineNumbers);
    const endLine = input.startLine + count - 1;
    return {
      content,
      text: contentWithFooter(content, lineFooter(input.startLine, endLine, endLine < totalLines)),
    };
  };

  let low = 1;
  let high = eligible.length;
  let emittedCount = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(formattedPage(middle).text) <= MAX_RESULT_BYTES) {
      emittedCount = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const endLine = input.startLine + emittedCount - 1;
  const hasMore = endLine < totalLines;
  const limitedBy = endLine === totalLines
    ? "none"
    : emittedCount < eligible.length
      ? "formatted_bytes"
      : sourceLimitedBy;
  const selectedSpans = eligible.slice(0, emittedCount);
  const emittedSourceBytes = selectedSpans.reduce((total, selected) => total + selected.end - selected.start, 0);
  const formatted = formattedPage(emittedCount);

  return {
    ok: true,
    mode: "lines",
    file,
    content: formatted.content,
    start_line: input.startLine,
    end_line: endLine,
    has_more: hasMore,
    next_start_line: hasMore ? endLine + 1 : null,
    limited_by: limitedBy,
    show_line_numbers: input.showLineNumbers,
    source_bytes: emittedSourceBytes,
    formatted_bytes: Buffer.byteLength(formatted.text),
  };
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function buildByteResult(
  input: NormalizedReadInput & { mode: "bytes"; startByte: number; maxBytes: number; encoding: ByteEncoding },
  fileBuffer: FileBuffer,
  signal: AbortSignal | undefined,
): ReadBytesResult {
  const { bytes } = fileBuffer;
  const file = { path: fileBuffer.path, total_bytes: bytes.length };
  const startByte = Math.min(input.startByte, bytes.length);
  if (input.encoding === "base64") {
    const endByte = Math.min(startByte + input.maxBytes, bytes.length);
    return {
      ok: true,
      mode: "bytes",
      file,
      encoding: "base64",
      content: bytes.subarray(startByte, endByte).toString("base64"),
      start_byte: startByte,
      end_byte: endByte,
      has_more: endByte < bytes.length,
      next_start_byte: endByte < bytes.length ? endByte : null,
    };
  }

  decodeUtf8(bytes);
  checkCancelled(signal);
  if (startByte < bytes.length && isContinuationByte(bytes[startByte])) {
    throw new ReadToolError("INVALID_BYTE_BOUNDARY", "start_byte is inside a UTF-8 code point", fileBuffer.path);
  }

  const tentativeEnd = Math.min(startByte + input.maxBytes, bytes.length);
  let endByte = tentativeEnd;
  while (endByte > startByte && endByte < bytes.length && isContinuationByte(bytes[endByte])) {
    endByte -= 1;
  }
  if (endByte === startByte && startByte < bytes.length) {
    throw new ReadToolError("BYTE_PAGE_TOO_SMALL", "max_bytes cannot contain the next UTF-8 code point", fileBuffer.path);
  }

  return {
    ok: true,
    mode: "bytes",
    file,
    encoding: "utf8",
    content: new TextDecoder("utf-8", decoderOptions).decode(bytes.subarray(startByte, endByte)),
    start_byte: startByte,
    end_byte: endByte,
    has_more: endByte < bytes.length,
    next_start_byte: endByte < bytes.length ? endByte : null,
  };
}

async function executeRead(
  rawInput: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  let input: NormalizedReadInput;
  try {
    input = normalizeInput(rawInput);
  } catch (error) {
    if (error instanceof ReadToolError) {
      return fail(error.code, error.message, error.path, error.line, error.byteOffset);
    }
    return fail("INVALID_INPUT", error instanceof Error ? error.message : String(error));
  }

  try {
    const fileBuffer = await loadFileBuffer(input, ctx.cwd, signal);
    if (input.mode === "lines") {
      return buildLineResult(
        input as NormalizedReadInput & {
          mode: "lines";
          startLine: number;
          maxLines: number;
          showLineNumbers: boolean;
        },
        fileBuffer,
        signal,
      );
    }
    return buildByteResult(
      input as NormalizedReadInput & { mode: "bytes"; startByte: number; maxBytes: number; encoding: ByteEncoding },
      fileBuffer,
      signal,
    );
  } catch (error) {
    if (error instanceof ReadToolError) {
      return fail(error.code, error.message, error.path, error.line, error.byteOffset);
    }
    if (isAbortError(error)) return fail("CANCELLED", "Read was cancelled");
    return fail("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  }
}

function singleLineReadMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f-\u009f\[\]]/g, (character) => {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (character === "[") return "\\[";
    if (character === "]") return "\\]";
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function formatReadResult(result: ReadResult): string {
  if (!result.ok) {
    const suffix = result.error.code === "LINE_TOO_LONG"
      ? `; line=${result.error.line}; byte_offset=${result.error.byte_offset}`
      : "";
    return `[read error: ${result.error.code}; ${singleLineReadMessage(result.error.message)}${suffix}]`;
  }

  const footer = result.mode === "lines"
    ? lineFooter(result.start_line, result.end_line, result.has_more)
    : byteFooter(result.start_byte, result.end_byte, result.has_more);
  return contentWithFooter(result.content, footer);
}

function detailsFor(result: ReadResult): ReadToolDetails {
  if (!result.ok) return { ok: false, tool: "read", error: result.error };
  if (result.mode === "lines") {
    return {
      ok: true,
      tool: "read",
      mode: "lines",
      path: result.file.path,
      total_bytes: result.file.total_bytes,
      total_lines: result.file.total_lines,
      start_line: result.start_line,
      end_line: result.end_line,
      next_start_line: result.next_start_line,
      limited_by: result.limited_by,
      show_line_numbers: result.show_line_numbers,
      source_bytes: result.source_bytes,
      formatted_bytes: result.formatted_bytes,
    };
  }
  return {
    ok: true,
    tool: "read",
    mode: "bytes",
    path: result.file.path,
    total_bytes: result.file.total_bytes,
    encoding: result.encoding,
    start_byte: result.start_byte,
    end_byte: result.end_byte,
    next_start_byte: result.next_start_byte,
  };
}

function boundResult(result: ReadResult): { result: ReadResult; text: string } {
  const text = formatReadResult(result);
  if (Buffer.byteLength(text) <= MAX_RESULT_BYTES) return { result, text };
  const failure = fail("RESOURCE_LIMIT", "The read result exceeds the 48-KiB result limit");
  return { result: failure, text: formatReadResult(failure) };
}

export function createCodexReadTool(): ToolDefinition<typeof readParameters, ReadToolDetails> {
  return {
    name: "read",
    label: "read",
    description: "Read a regular file as bounded line or byte pages. Line ranges are inclusive; byte ranges are zero-based and half-open. Set show_line_numbers=true when precise line identity is needed. Large lines require byte mode.",
    promptSnippet: "Read file contents with bounded line or byte paging",
    promptGuidelines: [
      "Use read to examine and page files. Do not use nl, cat -n, or sed solely for numbering or paging files.",
      "Use read with show_line_numbers=true when precise line identity is needed.",
      "Use read byte mode when line mode reports LINE_TOO_LONG, starting at error.byte_offset.",
    ],
    parameters: readParameters,
    prepareArguments: prepareReadArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const bounded = boundResult(await executeRead(params, ctx, signal));
      return {
        content: [{ type: "text", text: bounded.text }],
        details: detailsFor(bounded.result),
      };
    },
  };
}

export function registerCodexReadTool(pi: ExtensionAPI): void {
  pi.registerTool(createCodexReadTool());
}
