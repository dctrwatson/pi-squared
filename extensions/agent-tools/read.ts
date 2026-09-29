import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionContext,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";

const SCAN_BLOCK_BYTES = 65_536;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_LINE_COUNT = 2_000;
const MAX_LINE_PAGE_BYTES = 40_960;
const MAX_UTF8_PAGE_BYTES = 40_960;
const MAX_BASE64_PAGE_BYTES = 30_720;
const READ_OPTIONAL_FIELDS = ["mode", "start_line", "max_lines", "show_line_numbers", "max_bytes", "start_byte", "encoding"];

const readParameters = Type.Object({
  path: Type.String({ description: "File path" }),
  mode: Type.Optional(Type.Union([Type.Literal("lines"), Type.Literal("bytes")], { description: "lines (default) or bytes" })),
  start_line: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Line mode: 1-based start, 1–2147483647 (default 1)" })),
  max_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LINE_COUNT, description: "Line mode: 1–2000 (default 200)" })),
  show_line_numbers: Type.Optional(Type.Boolean({ description: "Line mode: prefix 1-based line numbers (default true)" })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_UTF8_PAGE_BYTES, description: "Line or UTF-8 byte mode: 1–40960; Base64: 1–30720 (default 16384)" })),
  start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Byte mode: 0-based start, 0–9007199254740991 (default 0)" })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { description: "Byte mode: utf8 (default) or base64" })),
}, { additionalProperties: false });

export type AgentReadInput = Static<typeof readParameters>;

type ReadMode = "lines" | "bytes";
export type ByteEncoding = "utf8" | "base64";

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
  | "FILE_CHANGED"
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
  file: ReadFile & { total_lines: number | null };
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
    total_lines: number | null;
    start_line: number | null;
    end_line: number | null;
    next_start_line: number | null;
    has_more: boolean;
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
    has_more: boolean;
  })
  | (ToolFailureDetails<"read", ReadErrorCode> & {
    error: ReadFailure["error"];
  });

export class ReadToolError extends Error {
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

export interface PositionedReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

export interface ReadHandleStat {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
}

export interface ReadFileHandle extends PositionedReader {
  stat(options: { bigint: true }): Promise<ReadHandleStat>;
  close(): Promise<void>;
}

export interface AgentReadToolOptions {
  openFile?: (path: string, flags: number) => Promise<ReadFileHandle>;
}

type FileSnapshot = Pick<ReadHandleStat, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

interface PagedFile {
  path: string;
  handle: ReadFileHandle;
  totalBytes: number;
  snapshot: FileSnapshot;
}

interface LineSpan {
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareReadArguments(rawInput: unknown): AgentReadInput {
  return prepareInputArguments(rawInput, READ_OPTIONAL_FIELDS, normalizeInput);
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
  rawInput = omitNullOptionalFields(rawInput, READ_OPTIONAL_FIELDS);
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
  if (unknownKey !== undefined) {
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
    if (rawInput.start_byte !== undefined || rawInput.encoding !== undefined) {
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
        ? 200
        : validateInteger(rawInput.max_lines, "max_lines", 1, MAX_LINE_COUNT),
      showLineNumbers: rawInput.show_line_numbers ?? true,
      maxBytes: rawInput.max_bytes === undefined
        ? 16_384
        : validateInteger(rawInput.max_bytes, "max_bytes", 1, MAX_LINE_PAGE_BYTES),
    };
  }

  if (rawInput.start_line !== undefined || rawInput.max_lines !== undefined || rawInput.show_line_numbers !== undefined) {
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
      : validateInteger(rawInput.start_byte, "start_byte", 0, Number.MAX_SAFE_INTEGER),
    maxBytes: rawInput.max_bytes === undefined
      ? 16_384
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

async function openPagedFile(
  input: NormalizedReadInput,
  cwd: string,
  signal: AbortSignal | undefined,
  openFile: NonNullable<AgentReadToolOptions["openFile"]>,
): Promise<PagedFile> {
  checkCancelled(signal);
  const requestedPath = resolve(cwd, input.path);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
    checkCancelled(signal);
  } catch (error) {
    checkCancelled(signal);
    throw mapFilesystemError(error, requestedPath, "resolve path");
  }

  let handle: ReadFileHandle | undefined;
  let opened = false;
  try {
    const fileInfo = await stat(canonicalPath);
    checkCancelled(signal);
    if (!fileInfo.isFile()) {
      throw new ReadToolError("UNSUPPORTED_FILE_TYPE", "The target is not a regular file", canonicalPath);
    }
    handle = await openFile(canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
    checkCancelled(signal);
    const snapshot = await handle.stat({ bigint: true });
    checkCancelled(signal);
    if (!snapshot.isFile()) {
      throw new ReadToolError("UNSUPPORTED_FILE_TYPE", "The target is not a regular file", canonicalPath);
    }
    if (snapshot.size < 0n || snapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReadToolError("RESOURCE_LIMIT", "The file size is not a safe integer", canonicalPath);
    }
    const { dev, ino, size, mtimeNs, ctimeNs } = snapshot;
    opened = true;
    return { path: canonicalPath, handle, totalBytes: Number(size), snapshot: { dev, ino, size, mtimeNs, ctimeNs } };
  } catch (error) {
    checkCancelled(signal);
    throw mapFilesystemError(error, canonicalPath, "open file");
  } finally {
    if (handle && !opened) await handle.close();
  }
}

async function verifySnapshot(file: PagedFile, signal: AbortSignal | undefined): Promise<void> {
  checkCancelled(signal);
  const current = await file.handle.stat({ bigint: true });
  checkCancelled(signal);
  const keys = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
  if (!current.isFile() || keys.some((key) => current[key] !== file.snapshot[key])) {
    throw new ReadToolError("FILE_CHANGED", "The file changed during read", file.path);
  }
}

async function readPositioned(
  reader: PositionedReader,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
  signal: AbortSignal | undefined,
  path?: string,
): Promise<number> {
  checkCancelled(signal);
  let bytesRead: number;
  try {
    ({ bytesRead } = await reader.read(buffer, offset, length, position));
  } catch (error) {
    checkCancelled(signal);
    throw error;
  }
  checkCancelled(signal);
  if (bytesRead === 0) {
    throw new ReadToolError("FILE_CHANGED", "The file changed during read", path);
  }
  if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
    throw new ReadToolError("INTERNAL_ERROR", "The positioned read returned an invalid byte count", path);
  }
  return bytesRead;
}

function decodeUtf8(bytes: Buffer, path?: string): string {
  try {
    return new TextDecoder("utf-8", decoderOptions).decode(bytes);
  } catch {
    throw new ReadToolError("INVALID_ENCODING", "The file is not valid UTF-8", path);
  }
}

interface ScannedLinePage {
  bytes: Buffer;
  spans: LineSpan[];
  startByte: number;
  totalLines: number | null;
  limitedBy: "none" | "lines" | "bytes";
}

type LineInput = NormalizedReadInput & {
  mode: "lines";
  startLine: number;
  maxLines: number;
  showLineNumbers: boolean;
};

async function scanLinePage(
  input: LineInput,
  file: PagedFile,
  signal: AbortSignal | undefined,
): Promise<ScannedLinePage> {
  const scratch = Buffer.allocUnsafe(SCAN_BLOCK_BYTES);
  const source = Buffer.allocUnsafe(input.maxBytes + 1);
  const spans: LineSpan[] = [];
  let position = 0;
  let line = 1;
  let lineStart = 0;
  let startByte = 0;
  let retained = 0;
  let candidateStart = 0;
  let totalLines: number | null = file.totalBytes === 0 ? 0 : null;
  let limitedBy: ScannedLinePage["limitedBy"] = "none";

  scan: while (position < file.totalBytes) {
    const count = await readPositioned(
      file.handle, scratch, 0, Math.min(SCAN_BLOCK_BYTES, file.totalBytes - position), position, signal, file.path,
    );
    let cursor = 0;
    while (cursor < count) {
      checkCancelled(signal);
      const found = scratch.indexOf(10, cursor);
      const hasLf = found >= 0 && found < count;
      const end = hasLf ? found + 1 : count;
      const absoluteEnd = position + end;
      const atEof = absoluteEnd === file.totalBytes;
      if (line >= input.startLine) {
        if (retained === 0) startByte = lineStart;
        const length = end - cursor;
        const kept = Math.min(length, input.maxBytes + 1 - retained);
        scratch.copy(source, retained, cursor, cursor + kept);
        retained += kept;
        if (retained > input.maxBytes) {
          if (spans.length === 0) {
            throw new ReadToolError(
              "LINE_TOO_LONG", "The first requested line exceeds max_bytes", file.path, line, lineStart,
            );
          }
          limitedBy = "bytes";
          break scan;
        }
        if (hasLf || atEof) {
          spans.push({ start: candidateStart, end: retained });
          candidateStart = retained;
        }
      }
      if (atEof) totalLines = line;
      if (spans.length === input.maxLines) {
        limitedBy = atEof ? "none" : "lines";
        break scan;
      }
      if (spans.length > 0 && retained === input.maxBytes && (hasLf || atEof)) {
        limitedBy = atEof ? "none" : "bytes";
        break scan;
      }
      if (hasLf) {
        line += 1;
        lineStart = absoluteEnd;
      }
      cursor = end;
    }
    position += count;
  }
  return { bytes: source.subarray(0, retained), spans, startByte, totalLines, limitedBy };
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

async function buildLineResult(
  input: LineInput,
  pagedFile: PagedFile,
  signal: AbortSignal | undefined,
): Promise<ReadLinesResult> {
  const page = await scanLinePage(input, pagedFile, signal);
  const file = { path: pagedFile.path, total_bytes: pagedFile.totalBytes, total_lines: page.totalLines };
  if (page.spans.length === 0) {
    return {
      ok: true, mode: "lines", file, content: "", start_line: null, end_line: null,
      has_more: false, next_start_line: null, limited_by: "none",
      show_line_numbers: input.showLineNumbers, source_bytes: 0,
      formatted_bytes: Buffer.byteLength(lineFooter(null, null, false)),
    };
  }

  const formattedSize = (count: number): number => {
    const endLine = input.startLine + count - 1;
    const sourceEnd = page.spans[count - 1]!.end;
    const hasMore = page.startByte + sourceEnd < pagedFile.totalBytes;
    let bytes = sourceEnd;
    if (input.showLineNumbers) bytes += count * (String(endLine).length + Buffer.byteLength(" │ "));
    bytes += page.bytes[sourceEnd - 1] === 10 ? 1 : 2;
    return bytes + Buffer.byteLength(lineFooter(input.startLine, endLine, hasMore));
  };
  let low = 1;
  let high = page.spans.length;
  let emittedCount = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (formattedSize(middle) <= MAX_RESULT_BYTES) {
      emittedCount = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const selected = page.spans.slice(0, emittedCount);
  const sourceBytes = selected[emittedCount - 1]!.end;
  decodeUtf8(page.bytes.subarray(0, sourceBytes), pagedFile.path);
  checkCancelled(signal);
  const content = renderLineSpans(page.bytes, selected, input.startLine, input.showLineNumbers);
  const endLine = input.startLine + emittedCount - 1;
  const hasMore = page.startByte + sourceBytes < pagedFile.totalBytes;
  return {
    ok: true, mode: "lines", file, content, start_line: input.startLine, end_line: endLine,
    has_more: hasMore, next_start_line: hasMore ? endLine + 1 : null,
    limited_by: !hasMore ? "none" : emittedCount < page.spans.length ? "formatted_bytes" : page.limitedBy,
    show_line_numbers: input.showLineNumbers, source_bytes: sourceBytes,
    formatted_bytes: Buffer.byteLength(contentWithFooter(content, lineFooter(input.startLine, endLine, hasMore))),
  };
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

export interface BytePageOptions {
  totalBytes: number;
  startByte: number;
  maxBytes: number;
  encoding: ByteEncoding;
  path?: string;
  signal?: AbortSignal;
  /** Withhold a valid partial UTF-8 code point at a live prefix end. */
  allowIncompleteUtf8?: boolean;
}

export interface BytePage {
  encoding: ByteEncoding;
  content: string;
  start_byte: number;
  end_byte: number;
  has_more: boolean;
  next_start_byte: number | null;
}

function utf8Width(lead: number): number {
  return lead <= 0x7f ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
}

function bytePageRange(options: BytePageOptions): { startByte: number; length: number } {
  validateInteger(options.totalBytes, "totalBytes", 0, Number.MAX_SAFE_INTEGER);
  validateInteger(options.startByte, "startByte", 0, Number.MAX_SAFE_INTEGER);
  if (options.encoding !== "utf8" && options.encoding !== "base64") {
    throw new ReadToolError("INVALID_INPUT", "encoding must be utf8 or base64");
  }
  validateInteger(options.maxBytes, "maxBytes", 1,
    options.encoding === "base64" ? MAX_BASE64_PAGE_BYTES : MAX_UTF8_PAGE_BYTES);
  const startByte = Math.min(options.startByte, options.totalBytes);
  const length = Math.min(options.maxBytes + (options.encoding === "utf8" ? 3 : 0), options.totalBytes - startByte);
  return { startByte, length };
}

/** Supply bytes from startByte through maxBytes plus three UTF-8 lookahead bytes, or EOF. */
export function decodeBytePage(bytes: Buffer, options: BytePageOptions): BytePage {
  checkCancelled(options.signal);
  const { startByte, length } = bytePageRange(options);
  if (bytes.length < length) {
    throw new ReadToolError("INVALID_INPUT", "The byte page buffer is shorter than the requested range", options.path);
  }
  const budget = Math.min(options.maxBytes, options.totalBytes - startByte);
  bytes = bytes.subarray(0, length);
  let selected = budget;
  if (options.encoding === "utf8") {
    if (isContinuationByte(bytes[0])) {
      throw new ReadToolError("INVALID_BYTE_BOUNDARY", "start_byte is inside a UTF-8 code point", options.path);
    }
    let withheld = false;
    if (budget > 0) {
      let tail = budget - 1;
      while (tail > 0 && tail >= budget - 3 && isContinuationByte(bytes[tail])) tail -= 1;
      const width = utf8Width(bytes[tail]!);
      if (width > budget - tail) {
        if (options.allowIncompleteUtf8 && startByte + budget === options.totalBytes) {
          try {
            new TextDecoder("utf-8", decoderOptions).decode(bytes.subarray(tail, budget), { stream: true });
          } catch {
            throw new ReadToolError("INVALID_ENCODING", "The file is not valid UTF-8", options.path);
          }
          withheld = true;
        } else {
          decodeUtf8(bytes.subarray(tail, tail + width), options.path);
        }
        selected = tail;
      }
    }
    if (selected === 0 && budget > 0 && !withheld) {
      throw new ReadToolError("BYTE_PAGE_TOO_SMALL", "max_bytes cannot contain the next UTF-8 code point", options.path);
    }
  }
  const endByte = startByte + selected;
  const hasMore = endByte < options.totalBytes;
  const content = options.encoding === "base64" ? bytes.subarray(0, selected).toString("base64")
    : decodeUtf8(bytes.subarray(0, selected), options.path);
  checkCancelled(options.signal);
  return {
    encoding: options.encoding, content,
    start_byte: startByte, end_byte: endByte, has_more: hasMore, next_start_byte: hasMore ? endByte : null,
  };
}

/** Read a frozen byte prefix. The caller owns the handle and consistency checks. */
export async function readBytePage(reader: PositionedReader, options: BytePageOptions): Promise<BytePage> {
  checkCancelled(options.signal);
  const { startByte, length } = bytePageRange(options);
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    offset += await readPositioned(
      reader, bytes, offset, length - offset, startByte + offset, options.signal, options.path,
    );
  }
  return decodeBytePage(bytes, options);
}

async function executeRead(
  rawInput: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  options: AgentReadToolOptions,
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

  let errorPath = resolve(ctx.cwd, input.path);
  try {
    const file = await openPagedFile(input, ctx.cwd, signal, options.openFile ?? open);
    errorPath = file.path;
    let result: ReadLinesResult | ReadBytesResult;
    try {
      if (input.mode === "lines") {
        result = await buildLineResult(input as LineInput, file, signal);
      } else {
        const page = await readBytePage(file.handle, {
          totalBytes: file.totalBytes, startByte: input.startByte!, maxBytes: input.maxBytes,
          encoding: input.encoding!, path: file.path, signal,
        });
        result = { ok: true, mode: "bytes", file: { path: file.path, total_bytes: file.totalBytes }, ...page };
      }
      await verifySnapshot(file, signal);
    } finally {
      await file.handle.close();
    }
    checkCancelled(signal);
    return result;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return fail("CANCELLED", "Read was cancelled");
    const mapped = mapFilesystemError(error, errorPath, "read file");
    return fail(mapped.code, mapped.message, mapped.path, mapped.line, mapped.byteOffset);
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
      has_more: result.has_more,
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
    has_more: result.has_more,
  };
}

function boundResult(result: ReadResult): { result: ReadResult; text: string } {
  const text = formatReadResult(result);
  if (Buffer.byteLength(text) <= MAX_RESULT_BYTES) return { result, text };
  const failure = fail("RESOURCE_LIMIT", "The read result exceeds the 48-KiB result limit");
  return { result: failure, text: formatReadResult(failure) };
}

export function createAgentReadTool(options: AgentReadToolOptions = {}): ToolDefinition<typeof readParameters, ReadToolDetails> {
  return {
    name: "read",
    label: "read",
    description: "Read a regular file as bounded line or byte pages. Line ranges are inclusive; byte ranges are zero-based and half-open. Line pages include line numbers by default. Large lines require byte mode.",
    promptSnippet: "Read file contents with bounded line or byte paging",
    promptGuidelines: [
      "Use read for file examination or paging. Line numbers are on by default; set show_line_numbers=false for raw source. Do not use nl, cat -n, or sed only to number or page files.",
      "Use read byte mode when line mode reports LINE_TOO_LONG, starting at error.byte_offset.",
    ],
    parameters: readParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareReadArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const bounded = boundResult(await executeRead(params, ctx, signal, options));
      return {
        content: [{ type: "text", text: bounded.text }],
        details: detailsFor(bounded.result),
      };
    },
  };
}

export function registerAgentReadTool(pi: ExtensionAPI): void {
  pi.registerTool(createAgentReadTool());
}
