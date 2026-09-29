import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";

export const MAX_PROCESS_STREAM_BYTES = 67_108_864;
export const MAX_PROCESS_TOTAL_BYTES = 134_217_728;
export const MAX_PROCESS_RESULT_BYTES = 48 * 1024;
export const PROCESS_PREVIEW_FRAGMENT_BYTES = 65_536;

export const DEFAULT_PROCESS_OUTPUT_BYTES = 8192;
export const MIN_PROCESS_OUTPUT_BYTES = 2048;
export const MAX_PROCESS_OUTPUT_BYTES = 40960;
const MAX_ERROR_MESSAGE_BYTES = 512;

export class ProcessResultBudgetError extends Error {
  constructor() {
    super("Process output exceeds max_output_bytes");
  }
}

function validateOutputBudget(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < MIN_PROCESS_OUTPUT_BYTES || bytes > MAX_PROCESS_OUTPUT_BYTES) {
    throw new ProcessResultBudgetError();
  }
}

export type ProcessToolName = "bash" | "git" | "gh";
export type ProcessCaptureState = "complete" | "incomplete";
export type ProcessPreviewState = "complete" | "truncated";

export interface CapturedProcessStream {
  path?: string;
  savedRawBytes?: number;
  totalBytes: number;
  lineFeeds: number;
  endsWithNewline: boolean;
  head: Buffer<ArrayBufferLike>;
  tail: Buffer<ArrayBufferLike>;
}

export type ProcessStopReason = null | "timeout" | "cancelled" | "output_limit" |
  "capture_failed" | "artifact_failed" | "cleanup_failed" | "shutdown";

export interface ProcessStatus {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stop_reason: ProcessStopReason;
  cleanup: "pending" | "complete" | "failed";
}

export interface ProcessStreamDetails {
  capture: ProcessCaptureState;
  preview: ProcessPreviewState;
  captured_raw_bytes: number;
  saved_raw_bytes?: number;
  captured_lines: number;
  preview_bytes: number;
  head_preview_bytes?: number;
  omitted_captured_raw_bytes?: number;
  tail_preview_bytes?: number;
  artifact?: string;
}

export interface ProcessSnapshot extends ProcessStatus {
  stdout: ProcessStreamDetails;
  stderr: ProcessStreamDetails;
  artifact?: ProcessArtifact;
}

export interface ProcessSuccessDetails extends ProcessSnapshot, ToolSuccessDetails<ProcessToolName> {}

export interface ProcessFailureDetails extends ToolFailureDetails<ProcessToolName> {
  process?: ProcessSnapshot;
}

/** Copy process evidence without its tool envelope. */
export function nestedProcessSnapshot(details: ProcessSuccessDetails): ProcessSnapshot {
  const { ok: _ok, tool: _tool, stdout, stderr, artifact, ...status } = details;
  return {
    ...status,
    stdout: { ...stdout },
    stderr: { ...stderr },
    ...(artifact ? { artifact: { ...artifact } } : {}),
  };
}

export interface ProcessEvidence {
  status: ProcessStatus;
  artifact?: ProcessArtifact;
  stdout: CapturedProcessStream;
  stderr: CapturedProcessStream;
  capture: { stdout: ProcessCaptureState; stderr: ProcessCaptureState };
}

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

function streamDetails(capture: CapturedProcessStream, state: ProcessCaptureState): ProcessStreamDetails {
  return {
    capture: state,
    preview: "complete",
    captured_raw_bytes: capture.totalBytes,
    captured_lines: capturedProcessLines(capture),
    preview_bytes: 0,
    ...(capture.savedRawBytes !== undefined ? { saved_raw_bytes: capture.savedRawBytes } : {}),
  };
}

function fullDecodedBytes(capture: CapturedProcessStream): number {
  return capture.totalBytes <= capture.head.length
    ? decodedByteLength(capture.head.subarray(0, capture.totalBytes))
    : Infinity;
}

/** Fit source fragments and omission text inside one stream's share. */
export function buildPreview(
  capture: CapturedProcessStream,
  state: ProcessCaptureState,
  limit: number,
  unsuccessful = false,
): PreviewResult {
  const details = streamDetails(capture, state);
  if (fullDecodedBytes(capture) <= limit) {
    const text = capture.head.subarray(0, capture.totalBytes).toString("utf8");
    details.preview_bytes = Buffer.byteLength(text);
    if (state === "incomplete" && capture.path) details.artifact = capture.path;
    return { text, details };
  }

  const marker = (omitted: number): string => `[process preview omitted: ${omitted} captured raw bytes]`;
  const markerBytes = Buffer.byteLength(marker(capture.totalBytes));
  const sourceSpace = Math.max(0, limit - markerBytes - 2);
  const headShare = unsuccessful ? Math.floor(sourceSpace / 3) : Math.floor(sourceSpace / 2);
  const head = markerBytes <= limit ? fittingPrefix(capture.head, headShare) : Buffer.alloc(0);
  const tailLength = Math.min(capture.tail.length, Math.max(0, capture.totalBytes - head.length));
  const tail = markerBytes <= limit
    ? fittingSuffix(capture.tail.subarray(capture.tail.length - tailLength), sourceSpace - headShare)
    : Buffer.alloc(0);
  const omitted = Math.max(0, capture.totalBytes - head.length - tail.length);
  const text = markerBytes <= limit
    ? [head.toString("utf8"), marker(omitted), tail.toString("utf8")].filter((part) => part.length > 0).join("\n")
    : "";
  if (Buffer.byteLength(text) > limit) throw new ProcessResultBudgetError();
  return {
    text,
    details: {
      ...details,
      preview: "truncated",
      preview_bytes: Buffer.byteLength(text),
      head_preview_bytes: decodedByteLength(head),
      omitted_captured_raw_bytes: omitted,
      tail_preview_bytes: decodedByteLength(tail),
      ...(capture.path ? { artifact: capture.path } : {}),
    },
  };
}

function formatStatusHeader(tool: ProcessToolName, status: ProcessStatus, compact: boolean): string {
  if (compact) return `[${tool}: ok; duration_ms=${status.duration_ms}]`;
  const exitCode = status.exit_code === null ? "null" : String(status.exit_code);
  return `[${tool}: exit_code=${exitCode}; signal=${status.signal ?? "none"}; timed_out=${status.timed_out}; stop_reason=${status.stop_reason}; cleanup=${status.cleanup}; duration_ms=${status.duration_ms}]`;
}

function formatStreamHeader(name: "stdout" | "stderr", details: ProcessStreamDetails, compact: boolean): string {
  if (compact) return `[${name}: preview_bytes=${details.preview_bytes}]`;
  const fields = [
    `capture=${details.capture}`,
    `preview=${details.preview}`,
    `captured_raw_bytes=${details.captured_raw_bytes}`,
  ];
  if (details.saved_raw_bytes !== undefined) fields.push(`saved_raw_bytes=${details.saved_raw_bytes}`);
  if (details.artifact) fields.push(`artifact=${details.artifact}`);
  return `[${name}: ${fields.join("; ")}]`;
}

/** Reserve the largest process headers before an OS spawn. */
export function reserveProcessMetadataBytes(
  tool: ProcessToolName,
  paths: { stdout_path: string; stderr_path: string },
): number {
  const status: ProcessStatus = {
    exit_code: -2147483648,
    signal: "S".repeat(32),
    timed_out: false,
    duration_ms: Number.MAX_SAFE_INTEGER,
    stop_reason: "artifact_failed",
    cleanup: "complete",
  };
  const statusText = formatStatusHeader(tool, status, false);
  const heading = (name: "stdout" | "stderr", path: string): string => formatStreamHeader(name, {
    capture: "incomplete", preview: "truncated", captured_raw_bytes: 67108864,
    saved_raw_bytes: 67108864, captured_lines: 0, preview_bytes: 0, artifact: path,
  }, false);
  return Buffer.byteLength([
    `[${tool} error: RESULT_BUDGET_TOO_SMALL; ${"x".repeat(MAX_ERROR_MESSAGE_BYTES)}]`,
    statusText,
    heading("stdout", paths.stdout_path),
    heading("stderr", paths.stderr_path),
  ].join("\n")) + 2;
}

function includedStream(preview: PreviewResult): boolean {
  return preview.details.captured_raw_bytes > 0 || preview.details.capture === "incomplete";
}

function renderProcessText(
  tool: ProcessToolName,
  status: ProcessStatus,
  stdout: PreviewResult,
  stderr: PreviewResult,
  compact: boolean,
  wrapperError?: string,
): string {
  const sections = [wrapperError, formatStatusHeader(tool, status, compact)];
  for (const [name, preview] of [["stdout", stdout], ["stderr", stderr]] as const) {
    if (!includedStream(preview)) continue;
    const header = formatStreamHeader(name, preview.details, compact);
    sections.push(preview.text.length > 0 ? `${header}\n${preview.text}` : header);
  }
  return sections.filter((section): section is string => section !== undefined).join("\n");
}

function processResult(
  tool: ProcessToolName, status: ProcessStatus, artifact: ProcessArtifact | undefined,
  stdout: PreviewResult, stderr: PreviewResult, text: string, budget: number,
): FormattedProcessResult {
  if (Buffer.byteLength(text) > budget || Buffer.byteLength(text) > MAX_PROCESS_RESULT_BYTES) {
    throw new ProcessResultBudgetError();
  }
  return {
    text,
    details: {
      ok: true, tool, ...status, stdout: stdout.details, stderr: stderr.details,
      ...(artifact && status.cleanup === "complete" ? { artifact: { ...artifact } } : {}),
    },
    needsArtifact: stdout.details.capture === "incomplete" || stderr.details.capture === "incomplete"
      || stdout.details.preview === "truncated" || stderr.details.preview === "truncated",
  };
}

/** Allocate one total byte budget for process status, paths, and source previews. */
export function formatProcessResult(
  tool: ProcessToolName,
  status: ProcessStatus,
  artifact: ProcessArtifact | undefined,
  stdout: CapturedProcessStream,
  stderr: CapturedProcessStream,
  capture: { stdout: ProcessCaptureState; stderr: ProcessCaptureState },
  maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES,
  wrapperError?: string,
): FormattedProcessResult {
  validateOutputBudget(maxOutputBytes);
  const unsuccessful = !!wrapperError || (typeof status.exit_code === "number" && status.exit_code !== 0)
    || status.signal !== null || status.timed_out || status.stop_reason !== null;
  const publishPaths = !!wrapperError || status.cleanup === "pending";
  const previews = (stdoutShare: number, stderrShare: number): [PreviewResult, PreviewResult] => {
    const out = buildPreview(stdout, capture.stdout, stdoutShare, unsuccessful);
    const err = buildPreview(stderr, capture.stderr, stderrShare, unsuccessful);
    if (publishPaths) {
      if (stdout.path) out.details.artifact = stdout.path;
      if (stderr.path) err.details.artifact = stderr.path;
    }
    return [out, err];
  };
  const [fullOut, fullErr] = previews(maxOutputBytes, maxOutputBytes);
  if (fullOut.details.preview === "complete" && fullErr.details.preview === "complete") {
    const compact = !unsuccessful && status.cleanup === "complete" && status.stop_reason === null
      && capture.stdout === "complete" && capture.stderr === "complete";
    const candidate = renderProcessText(tool, status, fullOut, fullErr, compact, wrapperError);
    if (Buffer.byteLength(candidate) <= maxOutputBytes) {
      return processResult(tool, status, artifact, fullOut, fullErr, candidate, maxOutputBytes);
    }
  }

  const reservations = [
    { ...streamDetails(stdout, capture.stdout), preview: "truncated" as const, ...(stdout.path ? { artifact: stdout.path } : {}) },
    { ...streamDetails(stderr, capture.stderr), preview: "truncated" as const, ...(stderr.path ? { artifact: stderr.path } : {}) },
  ];
  const included = [stdout.totalBytes > 0 || capture.stdout === "incomplete", stderr.totalBytes > 0 || capture.stderr === "incomplete"];
  const headers = [wrapperError, formatStatusHeader(tool, status, false)];
  if (included[0]) headers.push(formatStreamHeader("stdout", reservations[0]!, false));
  if (included[1]) headers.push(formatStreamHeader("stderr", reservations[1]!, false));
  const overhead = Buffer.byteLength(headers.filter((header): header is string => header !== undefined).join("\n"))
    + Number(stdout.totalBytes > 0) + Number(stderr.totalBytes > 0);
  if (overhead > maxOutputBytes) throw new ProcessResultBudgetError();
  const available = maxOutputBytes - overhead;
  const outNonempty = stdout.totalBytes > 0;
  const errNonempty = stderr.totalBytes > 0;
  let outShare = outNonempty ? (errNonempty ? Math.ceil(available / 2) : available) : 0;
  let errShare = errNonempty ? (outNonempty ? Math.floor(available / 2) : available) : 0;
  const outFull = fullDecodedBytes(stdout);
  const errFull = fullDecodedBytes(stderr);
  if (outNonempty && errNonempty) {
    if (outFull <= outShare && errFull > errShare) {
      errShare += outShare - outFull;
      outShare = outFull;
    } else if (errFull <= errShare && outFull > outShare) {
      outShare += errShare - errFull;
      errShare = errFull;
    }
  }
  const [out, err] = previews(outShare, errShare);
  for (const [index, name, preview] of [[0, "stdout", out], [1, "stderr", err]] as const) {
    if (included[index] && Buffer.byteLength(formatStreamHeader(name, preview.details, false))
      > Buffer.byteLength(formatStreamHeader(name, reservations[index]!, false))) throw new ProcessResultBudgetError();
  }
  return processResult(tool, status, artifact, out, err,
    renderProcessText(tool, status, out, err, false, wrapperError), maxOutputBytes);
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

export function boundedProcessErrorMessage(message: string): string {
  const sanitized = singleLineErrorMessage(message);
  if (Buffer.byteLength(sanitized) <= MAX_ERROR_MESSAGE_BYTES) return sanitized;
  let bounded = "";
  let bytes = 0;
  for (const character of message) {
    const escaped = singleLineErrorMessage(character);
    const nextBytes = Buffer.byteLength(escaped);
    if (bytes + nextBytes + 3 > MAX_ERROR_MESSAGE_BYTES) break;
    bounded += escaped;
    bytes += nextBytes;
  }
  return `${bounded}…`;
}

/** Keep verified evidence when an unexpected formatter invariant fails. */
export function formatProcessBudgetFailure(
  tool: ProcessToolName,
  process: ProcessEvidence,
): { text: string; details: ProcessFailureDetails } {
  const message = "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command.";
  const stream = (capture: CapturedProcessStream, state: ProcessCaptureState): ProcessStreamDetails => ({
    ...streamDetails(capture, state),
    ...(capture.totalBytes > 0 ? {
      preview: "truncated", head_preview_bytes: 0, tail_preview_bytes: 0,
      omitted_captured_raw_bytes: capture.totalBytes,
    } : {}),
    ...(capture.path ? { artifact: capture.path } : {}),
  });
  return {
    text: `[${tool} error: RESULT_BUDGET_TOO_SMALL; ${message}]`,
    details: {
      ok: false, tool, error: { code: "RESULT_BUDGET_TOO_SMALL", message },
      process: {
        ...process.status,
        stdout: stream(process.stdout, process.capture.stdout),
        stderr: stream(process.stderr, process.capture.stderr),
        ...(process.artifact && process.status.cleanup === "complete" ? { artifact: { ...process.artifact } } : {}),
      },
    },
  };
}

/** Format a wrapper failure inside the same total process-output budget. */
export function formatProcessFailure(
  tool: ProcessToolName,
  code: string,
  message: string,
  process?: ProcessEvidence,
  maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES,
): { text: string; details: ProcessFailureDetails } {
  validateOutputBudget(maxOutputBytes);
  const boundedMessage = boundedProcessErrorMessage(message);
  const errorText = `[${tool} error: ${code}; ${boundedMessage}]`;
  if (process) {
    try {
      const formatted = formatProcessResult(
        tool, process.status, process.artifact, process.stdout, process.stderr, process.capture, maxOutputBytes, errorText,
      );
      return {
        text: formatted.text,
        details: { ok: false, tool, error: { code, message: boundedMessage }, process: nestedProcessSnapshot(formatted.details) },
      };
    } catch {
      return formatProcessBudgetFailure(tool, process);
    }
  }
  if (Buffer.byteLength(errorText) > maxOutputBytes) throw new ProcessResultBudgetError();
  return { text: errorText, details: { ok: false, tool, error: { code, message: boundedMessage } } };
}

/** Test whether process details report a wrapper failure. */
export function isProcessFailureDetails(details: unknown): details is ProcessFailureDetails {
  return typeof details === "object"
    && details !== null
    && "ok" in details
    && details.ok === false
    && "error" in details;
}
