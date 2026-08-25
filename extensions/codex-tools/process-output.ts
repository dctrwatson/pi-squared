import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";

export const MAX_PROCESS_STREAM_BYTES = 67_108_864;
export const MAX_PROCESS_TOTAL_BYTES = 134_217_728;
export const MAX_PROCESS_RESULT_BYTES = 48 * 1024;
export const PROCESS_PREVIEW_FRAGMENT_BYTES = 65_536;

const INITIAL_PREVIEW_BYTES = 18_432;
const MIN_PREVIEW_BYTES = 512;

export type ProcessToolName = "bash" | "git" | "gh";
export type ProcessCaptureState = "complete" | "incomplete";
export type ProcessPreviewState = "complete" | "truncated";

export interface CapturedProcessStream {
  path: string;
  totalBytes: number;
  lineFeeds: number;
  endsWithNewline: boolean;
  head: Buffer<ArrayBufferLike>;
  tail: Buffer<ArrayBufferLike>;
}

export interface ProcessStatus {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
}

export interface ProcessStreamDetails {
  capture: ProcessCaptureState;
  preview: ProcessPreviewState;
  captured_raw_bytes: number;
  captured_lines: number;
  preview_bytes: number;
  head_preview_bytes?: number;
  omitted_captured_raw_bytes?: number;
  tail_preview_bytes?: number;
  artifact?: string;
}

export interface ProcessSuccessDetails extends ProcessStatus, ToolSuccessDetails<ProcessToolName> {
  stdout: ProcessStreamDetails;
  stderr: ProcessStreamDetails;
  artifact?: ProcessArtifact;
}

export interface ProcessFailureDetails extends ToolFailureDetails<ProcessToolName> {}

export type ProcessToolDetails = ProcessSuccessDetails | ProcessFailureDetails;

interface PreviewResult {
  text: string;
  details: ProcessStreamDetails;
}

export interface FormattedProcessResult {
  text: string;
  details: ProcessSuccessDetails;
  needsArtifact: boolean;
}

/** Create counters and bounded raw fragments for one stream. */
export function createCapturedProcessStream(path: string): CapturedProcessStream {
  return {
    path,
    totalBytes: 0,
    lineFeeds: 0,
    endsWithNewline: false,
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
  };
}

function countLineFeeds(data: Buffer): number {
  let count = 0;
  for (const byte of data) if (byte === 10) count += 1;
  return count;
}

/** Add raw bytes to stream counters and preview fragments. */
export function appendCapturedProcessStream(capture: CapturedProcessStream, data: Buffer): void {
  capture.totalBytes += data.length;
  capture.lineFeeds += countLineFeeds(data);
  if (data.length > 0) capture.endsWithNewline = data[data.length - 1] === 10;

  if (capture.head.length < PROCESS_PREVIEW_FRAGMENT_BYTES) {
    const remaining = PROCESS_PREVIEW_FRAGMENT_BYTES - capture.head.length;
    capture.head = Buffer.concat([capture.head, data.subarray(0, remaining)]);
  }
  const nextTail = Buffer.concat([capture.tail, data]);
  capture.tail = nextTail.length <= PROCESS_PREVIEW_FRAGMENT_BYTES
    ? nextTail
    : nextTail.subarray(nextTail.length - PROCESS_PREVIEW_FRAGMENT_BYTES);
}

/** Count decoded lines from raw LF records. */
export function capturedProcessLines(capture: CapturedProcessStream): number {
  if (capture.totalBytes === 0) return 0;
  return capture.lineFeeds + (capture.endsWithNewline ? 0 : 1);
}

function decodedByteLength(data: Buffer): number {
  return Buffer.byteLength(data.toString("utf8"));
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function trimPrefixBoundary(data: Buffer, length: number): number {
  let result = length;
  while (result > 0 && isUtf8ContinuationByte(data[result])) result -= 1;
  return result;
}

function trimSuffixBoundary(data: Buffer, start: number): number {
  let result = start;
  while (result < data.length && isUtf8ContinuationByte(data[result])) result += 1;
  return result;
}

function fittingPrefix(data: Buffer, maxBytes: number): Buffer {
  let low = 0;
  let high = data.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (decodedByteLength(data.subarray(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return data.subarray(0, trimPrefixBoundary(data, low));
}

function fittingSuffix(data: Buffer, maxBytes: number): Buffer {
  let low = 0;
  let high = data.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (decodedByteLength(data.subarray(data.length - middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return data.subarray(trimSuffixBoundary(data, data.length - low));
}

function omissionText(head: string, omittedBytes: number, tail: string): string {
  const before = head.length > 0 && !head.endsWith("\n") ? "\n" : "";
  const after = tail.length > 0 ? "\n" : "";
  return `${head}${before}[process preview omitted: ${omittedBytes} captured raw bytes]${after}${tail}`;
}

function buildPreview(
  capture: CapturedProcessStream,
  captureState: ProcessCaptureState,
  limit: number,
): PreviewResult {
  const artifactRequired = captureState === "incomplete";
  const common = {
    capture: captureState,
    captured_raw_bytes: capture.totalBytes,
    captured_lines: capturedProcessLines(capture),
  } as const;

  if (
    capture.totalBytes <= capture.head.length
    && decodedByteLength(capture.head.subarray(0, capture.totalBytes)) <= limit
  ) {
    const text = capture.head.subarray(0, capture.totalBytes).toString("utf8");
    return {
      text,
      details: {
        ...common,
        preview: "complete",
        preview_bytes: Buffer.byteLength(text),
        ...(artifactRequired ? { artifact: capture.path } : {}),
      },
    };
  }

  const headLength = Math.min(capture.head.length, Math.floor(capture.totalBytes / 2));
  const tailLength = Math.min(capture.tail.length, capture.totalBytes - headLength);
  const headSource = capture.head.subarray(0, headLength);
  const tailSource = capture.tail.subarray(capture.tail.length - tailLength);
  let head: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let omittedBytes = capture.totalBytes;
  let text = omissionText("", omittedBytes, "");

  for (let pass = 0; pass < 4; pass += 1) {
    const generatedBytes = Buffer.byteLength(omissionText("", omittedBytes, ""));
    const available = Math.max(0, limit - generatedBytes - 2);
    head = fittingPrefix(headSource, Math.floor(available / 2));
    tail = fittingSuffix(tailSource, available - decodedByteLength(head));
    omittedBytes = Math.max(0, capture.totalBytes - head.length - tail.length);
    text = omissionText(head.toString("utf8"), omittedBytes, tail.toString("utf8"));
  }

  return {
    text,
    details: {
      ...common,
      preview: "truncated",
      preview_bytes: Buffer.byteLength(text),
      head_preview_bytes: decodedByteLength(head),
      omitted_captured_raw_bytes: omittedBytes,
      tail_preview_bytes: decodedByteLength(tail),
      artifact: capture.path,
    },
  };
}

function formatStatusHeader(tool: ProcessToolName, status: ProcessStatus, compact: boolean): string {
  if (compact) return `[${tool}: ok; duration_ms=${status.duration_ms}]`;
  const exitCode = status.exit_code === null ? "null" : String(status.exit_code);
  return `[${tool}: exit_code=${exitCode}; signal=${status.signal ?? "none"}; timed_out=${status.timed_out}; duration_ms=${status.duration_ms}]`;
}

function formatStreamHeader(
  name: "stdout" | "stderr",
  details: ProcessStreamDetails,
  compact: boolean,
): string {
  if (compact) return `[${name}: preview_bytes=${details.preview_bytes}]`;
  const fields = [
    `capture=${details.capture}`,
    `preview=${details.preview}`,
    `captured_raw_bytes=${details.captured_raw_bytes}`,
    `captured_lines=${details.captured_lines}`,
    `preview_bytes=${details.preview_bytes}`,
  ];
  if (details.preview === "truncated") {
    fields.push(`head_preview_bytes=${details.head_preview_bytes}`);
    fields.push(`omitted_captured_raw_bytes=${details.omitted_captured_raw_bytes}`);
    fields.push(`tail_preview_bytes=${details.tail_preview_bytes}`);
  }
  if (details.artifact) fields.push(`artifact=${details.artifact}`);
  return `[${name}: ${fields.join("; ")}]`;
}

function streamSection(
  name: "stdout" | "stderr",
  preview: PreviewResult,
  compact: boolean,
): string | undefined {
  if (
    preview.details.captured_raw_bytes === 0
    && preview.details.capture === "complete"
    && preview.details.preview === "complete"
  ) {
    return undefined;
  }
  const header = formatStreamHeader(name, preview.details, compact);
  return preview.text.length > 0 ? `${header}\n${preview.text}` : header;
}

/** Format one normal process result with bounded unescaped previews. */
export function formatProcessResult(
  tool: ProcessToolName,
  status: ProcessStatus,
  artifact: ProcessArtifact,
  stdout: CapturedProcessStream,
  stderr: CapturedProcessStream,
  capture: { stdout: ProcessCaptureState; stderr: ProcessCaptureState },
): FormattedProcessResult {
  let previewLimit = INITIAL_PREVIEW_BYTES;
  while (true) {
    const stdoutPreview = buildPreview(stdout, capture.stdout, previewLimit);
    const stderrPreview = buildPreview(stderr, capture.stderr, previewLimit);
    const compact = status.exit_code === 0
      && status.signal === null
      && status.timed_out === false
      && stdoutPreview.details.capture === "complete"
      && stdoutPreview.details.preview === "complete"
      && stderrPreview.details.capture === "complete"
      && stderrPreview.details.preview === "complete";
    const sections = [
      formatStatusHeader(tool, status, compact),
      streamSection("stdout", stdoutPreview, compact),
      streamSection("stderr", stderrPreview, compact),
    ].filter((section): section is string => section !== undefined);
    const text = sections.join("\n");
    const details: ProcessSuccessDetails = {
      ok: true,
      tool,
      ...status,
      stdout: stdoutPreview.details,
      stderr: stderrPreview.details,
      artifact,
    };
    if (Buffer.byteLength(text) < MAX_PROCESS_RESULT_BYTES) {
      return {
        text,
        details,
        needsArtifact: stdoutPreview.details.artifact !== undefined || stderrPreview.details.artifact !== undefined,
      };
    }
    if (previewLimit <= MIN_PREVIEW_BYTES) {
      throw new Error(`Cannot create a bounded ${tool} result`);
    }
    previewLimit = Math.max(MIN_PREVIEW_BYTES, Math.floor(previewLimit / 2));
  }
}

function singleLineErrorMessage(message: string): string {
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

function utf8Prefix(text: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Format one bounded wrapper failure with a stable code. */
export function formatProcessFailure(
  tool: ProcessToolName,
  code: string,
  message: string,
): { text: string; details: ProcessFailureDetails } {
  const prefix = `[${tool} error: ${code}; `;
  const suffix = "]";
  const sanitized = singleLineErrorMessage(message);
  const available = MAX_PROCESS_RESULT_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix) - 1;
  const boundedMessage = Buffer.byteLength(sanitized) <= available
    ? sanitized
    : `${utf8Prefix(sanitized, Math.max(0, available - Buffer.byteLength("…")))}…`;
  return {
    text: `${prefix}${boundedMessage}${suffix}`,
    details: { ok: false, tool, error: { code, message: boundedMessage } },
  };
}

/** Test whether process details report a wrapper failure. */
export function isProcessFailureDetails(details: unknown): details is ProcessFailureDetails {
  return typeof details === "object"
    && details !== null
    && "ok" in details
    && details.ok === false
    && "error" in details;
}
