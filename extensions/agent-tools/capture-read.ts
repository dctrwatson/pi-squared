import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gunzipSync } from "node:zlib";
import { Type, type Static } from "typebox";
import { prepareInputArguments, omitNullOptionalFields } from "./optional-input.ts";
import { createArtifactReadTool, type ArtifactReadToolOptions } from "./artifact-read.ts";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_JSONL_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_PAGE_SCAN_BYTES = MAX_JSONL_CAPTURE_BYTES;
const MAX_JSONL_LINE_BYTES = 256 * 1024;
const MAX_JSONL_RECORDS = 100_000;
const MAX_JSONL_ERRORS = 10;
const MAX_JSONL_PAGE_RECORDS = 200;
const MAX_JSONL_PAGE_DEFAULT_RECORDS = 10;
const MAX_JSONL_PAGE_OUTPUT_BYTES = 12_000;
const MAX_JSONL_PAGE_PROJECTION_BYTES = 8 * 1024;
const MAX_GZIP_FIELD_INPUT_BYTES = 512 * 1024;
const MAX_GZIP_FIELD_DEFAULT_DECODE_BYTES = 16 * 1024;
const MAX_GZIP_FIELD_MAX_DECODE_BYTES = MAX_CAPTURE_BYTES;
const MAX_GZIP_FIELD_MAX_PAGE_BYTES = 16 * 1024;
const MAX_METADATA_CHARS = 8192;
const MAX_SAMPLE_ROWS = 10;
const MAX_SAMPLE_ROW_CHARS = 2048;
const MAX_SAMPLE_CHARS = 12_000;
const MAX_PROJECT_ROWS = 200;
const MAX_PROJECT_CHARS = 12_000;
const MAX_REDUCER_ROWS = 100_000;
const MAX_REDUCER_GROUPS = 100;
const MAX_REDUCER_CHARS = 12_000;
const MAX_CONTEXT_BYTES = 12 * 1024;
const MAX_ORIGINAL_VALUE_BYTES = 2 * 1024;
const MAX_PROCESS_VALUE_BYTES = 512;
const MAX_PROVENANCE_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const OPTIONAL_FIELDS = ["format", "selection", "project", "reduce", "gzip_field", "jsonl_page"];

const aliasSchema = Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$", maxLength: 64 });
const pointerSchema = Type.String({ maxLength: 4096 });
const selectionSchema = Type.Object({
  rows_pointer: Type.Optional(pointerSchema),
  metadata_pointers: Type.Optional(Type.Record(aliasSchema, pointerSchema, { maxProperties: 16 })),
  identity_pointers: Type.Optional(Type.Record(aliasSchema, Type.String({ maxLength: 512 }), { minProperties: 1, maxProperties: 8 })),
}, { additionalProperties: false });
const projectSchema = Type.Object({
  fields: Type.Record(aliasSchema, Type.String({ maxLength: 512 }), { minProperties: 1, maxProperties: 16 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PROJECT_ROWS })),
}, { additionalProperties: false });
const reduceSchema = Type.Object({
  group_pointer: Type.String({ maxLength: 512 }),
  value_pointer: Type.Optional(Type.String({ maxLength: 512 })),
  time_pointer: Type.Optional(Type.String({ maxLength: 512 })),
}, { additionalProperties: false });
const jsonlPageSchema = Type.Object({
  start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "JSONL page cursor; use the prior next_start_byte" })),
  max_records: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_JSONL_PAGE_RECORDS, description: "Maximum records to return (default 10; maximum 200)" })),
}, { additionalProperties: false });
const gzipFieldSchema = Type.Object({
  pointer: Type.String({ maxLength: 4096, description: "JSON Pointer to a saved base64-encoded gzip string" }),
  max_decoded_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GZIP_FIELD_MAX_DECODE_BYTES, description: "Per-field expansion ceiling (default 16384; maximum 1048576)" })),
  start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GZIP_FIELD_MAX_DECODE_BYTES, description: "Zero-based UTF-8 byte offset at a code-point boundary" })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 4, maximum: MAX_GZIP_FIELD_MAX_PAGE_BYTES, description: "Maximum UTF-8 page bytes (default and maximum 16384)" })),
}, { additionalProperties: false });
const parameters = Type.Object({
  saved_capture: Type.Record(Type.String(), Type.Any(), { description: "Compact process-envelope checkpoint from the original query result" }),
  format: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("jsonl")], { description: "Saved capture format (default json)" })),
  selection: Type.Optional(selectionSchema),
  project: Type.Optional(projectSchema),
  reduce: Type.Optional(reduceSchema),
  gzip_field: Type.Optional(gzipFieldSchema),
  jsonl_page: Type.Optional(jsonlPageSchema),
}, { additionalProperties: false });
const outputSchema = Type.Record(Type.String(), Type.Any());

export type CaptureReadInput = Static<typeof parameters>;
export type CaptureReadDetails = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function boundedUtf8Prefix(text: string, maxBytes: number): { text: string; byteLength: number } {
  let end = 0;
  let byteLength = 0;
  while (end < text.length) {
    const point = text.codePointAt(end)!;
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (byteLength + bytes > maxBytes) break;
    byteLength += bytes;
    end += point > 0xffff ? 2 : 1;
  }
  return { text: text.slice(0, end), byteLength };
}

function utf8CodeUnitOffsetAtByte(text: string, targetByte: number): number | undefined {
  if (!Number.isSafeInteger(targetByte) || targetByte < 0) return undefined;
  let byteOffset = 0;
  let codeUnitOffset = 0;
  while (codeUnitOffset < text.length) {
    if (byteOffset === targetByte) return codeUnitOffset;
    const point = text.codePointAt(codeUnitOffset)!;
    byteOffset += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    codeUnitOffset += point > 0xffff ? 2 : 1;
    if (byteOffset > targetByte) return undefined;
  }
  return byteOffset === targetByte ? codeUnitOffset : undefined;
}

function parsePointer(pointer: unknown): string[] {
  if (typeof pointer !== "string" || pointer.length > 4096) throw new Error("A JSON Pointer must be a string of at most 4096 characters");
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("A JSON Pointer must be empty or start with /");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("A JSON Pointer has an invalid escape");
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function getPointer(root: unknown, parts: string[]): { found: boolean; value?: unknown } {
  let value = root;
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part) || Number(part) >= value.length) return { found: false };
      value = value[Number(part)];
    } else if (isRecord(value) && own(value, part)) value = value[part];
    else return { found: false };
  }
  return { found: true, value };
}

function normalizeGzipField(raw: unknown): {
  pointer: string;
  parts: string[];
  maxDecodedBytes: number;
  startByte: number;
  maxBytes: number;
} | undefined {
  if (raw === undefined) return undefined;
  const allowed = ["pointer", "max_decoded_bytes", "start_byte", "max_bytes"];
  if (!isRecord(raw) || Object.keys(raw).some((key) => !allowed.includes(key)) || typeof raw.pointer !== "string" || raw.pointer.length > 4096) {
    throw new Error("gzip_field must contain a JSON Pointer and optional bounded byte-page settings");
  }
  const maxDecodedBytes = raw.max_decoded_bytes === undefined ? MAX_GZIP_FIELD_DEFAULT_DECODE_BYTES : raw.max_decoded_bytes;
  const startByte = raw.start_byte === undefined ? 0 : raw.start_byte;
  const maxBytes = raw.max_bytes === undefined ? MAX_GZIP_FIELD_MAX_PAGE_BYTES : raw.max_bytes;
  if (!Number.isSafeInteger(maxDecodedBytes) || (maxDecodedBytes as number) < 1 || (maxDecodedBytes as number) > MAX_GZIP_FIELD_MAX_DECODE_BYTES
      || !Number.isSafeInteger(startByte) || (startByte as number) < 0 || (startByte as number) > MAX_GZIP_FIELD_MAX_DECODE_BYTES
      || !Number.isSafeInteger(maxBytes) || (maxBytes as number) < 4 || (maxBytes as number) > MAX_GZIP_FIELD_MAX_PAGE_BYTES) {
    throw new Error("gzip_field byte limits are outside their allowed bounds");
  }
  return {
    pointer: raw.pointer,
    parts: parsePointer(raw.pointer),
    maxDecodedBytes: maxDecodedBytes as number,
    startByte: startByte as number,
    maxBytes: maxBytes as number,
  };
}

class GzipFieldDecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GzipFieldDecodeError";
    this.code = code;
  }
}

function decodeBase64GzipField(document: Record<string, unknown>, field: NonNullable<ReturnType<typeof normalizeGzipField>>) {
  const selected = getPointer(document, field.parts);
  if (!selected.found || typeof selected.value !== "string") {
    throw new GzipFieldDecodeError("FIELD_NOT_FOUND", "The selected saved JSON field is missing or is not a string");
  }
  const encoded = selected.value;
  const encodedBytes = utf8ByteLength(encoded);
  if (encodedBytes > MAX_GZIP_FIELD_INPUT_BYTES) {
    throw new GzipFieldDecodeError("FIELD_INPUT_TOO_LARGE", `The encoded field exceeds the ${MAX_GZIP_FIELD_INPUT_BYTES}-byte input limit`);
  }
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new GzipFieldDecodeError("INVALID_BASE64", "The selected field is not canonical padded base64");
  }
  const compressed = Buffer.from(encoded, "base64");
  if (compressed.toString("base64") !== encoded) {
    throw new GzipFieldDecodeError("INVALID_BASE64", "The selected field is not canonical padded base64");
  }
  if (compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    throw new GzipFieldDecodeError("INVALID_GZIP", "The selected field does not contain a complete gzip member");
  }
  let decompressed: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    decompressed = gunzipSync(compressed, { info: true, maxOutputLength: field.maxDecodedBytes }) as unknown as typeof decompressed;
  } catch (error) {
    const code = isRecord(error) && error.code === "ERR_BUFFER_TOO_LARGE" ? "GZIP_OUTPUT_TOO_LARGE"
      : /unexpected end|unexpected eof|unexpected end of file/i.test(String(error)) ? "GZIP_TRUNCATED"
        : /incorrect data check/i.test(String(error)) ? "GZIP_CRC_MISMATCH"
          : /incorrect length check/i.test(String(error)) ? "GZIP_SIZE_MISMATCH" : "INVALID_GZIP";
    const message = code === "GZIP_OUTPUT_TOO_LARGE" ? `The decompressed field exceeds the requested ${field.maxDecodedBytes}-byte ceiling`
      : code === "GZIP_TRUNCATED" ? "The gzip field is truncated"
        : code === "GZIP_CRC_MISMATCH" ? "The gzip field failed its CRC check"
          : code === "GZIP_SIZE_MISMATCH" ? "The gzip field failed its uncompressed-size check"
            : "The selected field is not a valid gzip stream";
    throw new GzipFieldDecodeError(code, message);
  }
  if (decompressed.engine.bytesWritten !== compressed.length) {
    throw new GzipFieldDecodeError("GZIP_TRAILING_DATA", "The gzip field contains trailing or unconsumed bytes");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(decompressed.buffer);
  } catch {
    throw new GzipFieldDecodeError("INVALID_UTF8", "The decompressed field is not valid UTF-8");
  }
  const totalDecodedBytes = decompressed.buffer.length;
  if (field.startByte > totalDecodedBytes) {
    throw new GzipFieldDecodeError("GZIP_OFFSET_OUT_OF_RANGE", "The requested byte offset is beyond the decoded field");
  }
  if (field.startByte < totalDecodedBytes && (decompressed.buffer[field.startByte]! & 0xc0) === 0x80) {
    throw new GzipFieldDecodeError("GZIP_OFFSET_NOT_BOUNDARY", "The requested byte offset splits a UTF-8 code point");
  }
  let endByte = Math.min(field.startByte + field.maxBytes, totalDecodedBytes);
  while (endByte < totalDecodedBytes && (decompressed.buffer[endByte]! & 0xc0) === 0x80) endByte -= 1;
  const page = decompressed.buffer.subarray(field.startByte, endByte);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(page);
  } catch {
    throw new GzipFieldDecodeError("INVALID_UTF8", "The requested page is not valid UTF-8");
  }
  const eof = endByte === totalDecodedBytes;
  return {
    pointer: field.pointer,
    encoding: "base64+gzip",
    encoded_bytes: encodedBytes,
    compressed_bytes: compressed.length,
    decoded_bytes: totalDecodedBytes,
    total_decoded_bytes: totalDecodedBytes,
    max_decoded_bytes: field.maxDecodedBytes,
    start_byte: field.startByte,
    next_start_byte: eof ? null : endByte,
    page_bytes: page.length,
    eof,
    crc_verified: true,
    size_verified: true,
    text,
  };
}

function projectBoundedValue(value: unknown, depth = 0, maxStringChars = 256): { ok: true; value: unknown } | { ok: false } {
  if ((typeof value === "string" && value.length <= maxStringChars)
      || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || value === null) {
    return { ok: true, value };
  }
  if (depth >= 4) return { ok: false };
  if (Array.isArray(value) && value.length <= 16) {
    const children = value.map((child) => projectBoundedValue(child, depth + 1, maxStringChars));
    return children.every((child) => child.ok) ? { ok: true, value: children.map((child) => child.value) } : { ok: false };
  }
  if (isRecord(value) && Object.keys(value).length <= 16) {
    const entries: Array<[string, unknown]> = [];
    for (const [key, child] of Object.entries(value)) {
      const projected = projectBoundedValue(child, depth + 1, maxStringChars);
      if (key.length > 256 || !projected.ok) return { ok: false };
      entries.push([key, projected.value]);
    }
    return { ok: true, value: Object.fromEntries(entries) };
  }
  return { ok: false };
}

function normalizeSelection(raw: unknown): {
  rowsPointer: string;
  rowsParts: string[];
  metadataPointers: Record<string, string>;
  metadataParts: Record<string, string[]>;
  identityPointers?: Record<string, string>;
  identityParts: Record<string, string[]>;
} {
  const selection = raw === undefined ? {} : raw;
  if (!isRecord(selection) || Object.keys(selection).some((key) => !["rows_pointer", "metadata_pointers", "identity_pointers"].includes(key))) {
    throw new Error("Selection must contain only rows_pointer, metadata_pointers, and identity_pointers");
  }
  const defaults: Record<string, string> = {
    source: "/source", status: "/status", time: "/time", coverage: "/coverage", row_count: "/row_count", truncated: "/truncated",
  };
  const metadataOverrides = selection.metadata_pointers === undefined ? {} : selection.metadata_pointers;
  if (!isRecord(metadataOverrides)) throw new Error("metadata_pointers must be an object");
  const extraFields = Object.keys(metadataOverrides).filter((key) => !own(defaults, key));
  if (Object.keys(metadataOverrides).some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key)) || extraFields.length > 10) {
    throw new Error("Use at most ten additional lowercase metadata aliases of up to 64 characters");
  }
  const fields = [...Object.keys(defaults), ...extraFields];
  const metadataPointers: Record<string, string> = {};
  const metadataParts: Record<string, string[]> = {};
  for (const field of fields) {
    const pointer = own(metadataOverrides, field) ? metadataOverrides[field] : defaults[field];
    metadataPointers[field] = pointer as string;
    metadataParts[field] = parsePointer(pointer);
  }
  const identityOverrides = selection.identity_pointers;
  const identityFields = identityOverrides === undefined ? [] : isRecord(identityOverrides) ? Object.keys(identityOverrides) : [];
  if (identityOverrides !== undefined && !isRecord(identityOverrides)) throw new Error("identity_pointers must be an object");
  if (identityOverrides !== undefined && (identityFields.length === 0 || identityFields.length > 8
      || identityFields.some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))
      || identityFields.some((key) => typeof identityOverrides[key] !== "string" || (identityOverrides[key] as string).length > 512))) {
    throw new Error("Use one to eight lowercase identity fields with JSON Pointers of at most 512 characters");
  }
  const identityPointers: Record<string, string> = {};
  const identityParts: Record<string, string[]> = {};
  for (const field of identityFields) {
    identityPointers[field] = identityOverrides![field] as string;
    identityParts[field] = parsePointer(identityOverrides![field]);
  }
  const rowsPointer = own(selection, "rows_pointer") ? selection.rows_pointer as string : "/rows";
  return {
    rowsPointer,
    rowsParts: parsePointer(rowsPointer),
    metadataPointers,
    metadataParts,
    ...(identityOverrides === undefined ? {} : { identityPointers }),
    identityParts,
  };
}

function boundedOriginalValue(value: unknown, reference: string, maxBytes = MAX_ORIGINAL_VALUE_BYTES): unknown {
  const bytes = outputBytes(value);
  if (bytes <= maxBytes) return value;
  return { omitted: true, reference, encoded_bytes: Number.isFinite(bytes) ? bytes : null };
}

function readOriginal(saved: Record<string, unknown>): {
  original: CaptureReadDetails;
  details: Record<string, unknown>;
  processDetails: Record<string, unknown>;
  stdout: Record<string, unknown>;
  stderr: Record<string, unknown>;
  artifact: Record<string, unknown> | undefined;
  stdoutTextIsSafe: boolean;
} {
  const rawDetails = saved.details;
  if (!isRecord(rawDetails)) throw new Error("No process details");
  const details = rawDetails;
  const processDetails = isRecord(details.process) ? details.process : details;
  const stdout = isRecord(processDetails.stdout) ? processDetails.stdout : isRecord(details.stdout) ? details.stdout : {};
  const stderr = isRecord(processDetails.stderr) ? processDetails.stderr : isRecord(details.stderr) ? details.stderr : {};
  const artifactValue = details.artifact ?? processDetails.artifact;
  const artifact = isRecord(artifactValue) ? artifactValue : undefined;
  const processFailed = details.ok === false || saved.is_error === true
    || (typeof processDetails.exit_code === "number" && processDetails.exit_code !== 0)
    || processDetails.signal != null || processDetails.timed_out === true || processDetails.stop_reason != null;
  const processSucceeded = details.ok === true && saved.is_error !== true && processDetails.exit_code === 0
    && processDetails.signal === null && processDetails.timed_out === false
    && processDetails.stop_reason === null && processDetails.cleanup === "complete";
  const processOutcome = processFailed ? "failed" : processSucceeded ? "ok" : "unknown";
  const captureReference = artifact && typeof artifact.id === "string"
    ? {
        artifact_id: boundedOriginalValue(artifact.id, "saved_capture.details.artifact.id", 128),
        stdout: (typeof stdout.artifact === "string" && stdout.artifact.length > 0)
          || (typeof artifact.stdout_path === "string" && artifact.stdout_path.length > 0),
        stderr: (typeof stderr.artifact === "string" && stderr.artifact.length > 0)
          || (typeof artifact.stderr_path === "string" && artifact.stderr_path.length > 0),
      }
    : null;
  const processPath = processDetails === details ? "saved_capture.details" : "saved_capture.details.process";
  const stdoutPath = processDetails.stdout === stdout ? `${processPath}.stdout` : "saved_capture.details.stdout";
  const stderrPath = processDetails.stderr === stderr ? `${processPath}.stderr` : "saved_capture.details.stderr";
  const processValue = (value: unknown, field: string, path = `${processPath}.${field}`) => boundedOriginalValue(value, path, MAX_PROCESS_VALUE_BYTES);
  const original: CaptureReadDetails = {
    status: { process: processOutcome, capture: processValue(stdout.capture ?? "unknown", "stdout.capture", `${stdoutPath}.capture`), decode: "not_attempted", producer: "unknown" },
    capture_ref: captureReference,
    process: {
      tool: processValue(details.tool ?? null, "tool", "saved_capture.details.tool"),
      details_ok: details.ok === true,
      is_error: saved.is_error === true,
      exit_code: processValue(processDetails.exit_code ?? null, "exit_code", `${processPath}.exit_code`),
      signal: processValue(processDetails.signal ?? null, "signal", `${processPath}.signal`),
      timed_out: processValue(processDetails.timed_out ?? null, "timed_out", `${processPath}.timed_out`),
      stop_reason: processValue(processDetails.stop_reason ?? null, "stop_reason", `${processPath}.stop_reason`),
      cleanup: processValue(processDetails.cleanup ?? null, "cleanup", `${processPath}.cleanup`),
      duration_ms: processValue(processDetails.duration_ms ?? null, "duration_ms", `${processPath}.duration_ms`),
      stdout_capture: processValue(stdout.capture ?? null, "stdout.capture", `${stdoutPath}.capture`),
      stdout_preview: processValue(stdout.preview ?? null, "stdout.preview", `${stdoutPath}.preview`),
      stdout_captured_bytes: processValue(stdout.captured_raw_bytes ?? null, "stdout.captured_raw_bytes", `${stdoutPath}.captured_raw_bytes`),
      stderr_captured_bytes: processValue(stderr.captured_raw_bytes ?? null, "stderr.captured_raw_bytes", `${stderrPath}.captured_raw_bytes`),
      envelope_preview_truncated: saved.preview_truncated === true,
    },
    ...(own(details, "request") ? { request: boundedOriginalValue(details.request, "saved_capture.details.request") } : {}),
    ...(own(details, "error") ? { query_error: boundedOriginalValue(details.error, "saved_capture.details.error") } : {}),
    ...(own(saved, "failure_display") ? { failure_display: boundedOriginalValue(saved.failure_display, "saved_capture.failure_display") } : {}),
  };
  const stdoutTextIsSafe = typeof saved.stdout_text === "string"
    && processDetails.stop_reason === null && processDetails.cleanup === "complete" && processDetails.timed_out === false
    && stdout.capture === "complete" && stdout.preview === "complete" && stdout.artifact === undefined
    && stdout.captured_raw_bytes === utf8ByteLength(saved.stdout_text)
    && stderr.capture === "complete" && stderr.preview === "complete" && stderr.artifact === undefined
    && processDetails.artifact === undefined && details.artifact === undefined;
  if (captureReference === null && stdoutTextIsSafe) original.capture_ref = { source: "stdout_text" };
  return { original, details, processDetails, stdout, stderr, artifact, stdoutTextIsSafe };
}

function outputBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? utf8ByteLength(json) : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function formatFailure(original: CaptureReadDetails, stage: string, code: string, message: string, extra: CaptureReadDetails = {}): CaptureReadDetails {
  const currentStatus = isRecord(original.status) ? original.status : {};
  return {
    ...original,
    ...extra,
    status: {
      ...currentStatus,
      decode: ["json_parse", "document_shape", "metadata_limit", "jsonl_parse", "jsonl_page", "field_decode"].includes(stage) ? "failed"
        : ["reduce", "output_limit"].includes(stage) ? "ok" : "not_attempted",
      producer: "unknown",
    },
    read_ok: false,
    stage,
    decode_error: { code, message },
  };
}

function outputLimitFailure(result: CaptureReadDetails): CaptureReadDetails {
  const original: CaptureReadDetails = {};
  if (isRecord(result.status)) {
    original.status = Object.fromEntries(Object.entries(result.status).map(([field, value]) => [
      field, boundedOriginalValue(value, `capture_read.status.${field}`, MAX_PROCESS_VALUE_BYTES),
    ]));
  }
  if (isRecord(result.process)) {
    original.process = Object.fromEntries(Object.entries(result.process).map(([field, value]) => [
      field, boundedOriginalValue(value, `capture_read.process.${field}`, MAX_PROCESS_VALUE_BYTES),
    ]));
  }
  for (const field of ["capture_ref", "request", "query_error", "failure_display"] as const) {
    if (own(result, field)) original[field] = boundedOriginalValue(result[field], `capture_read.${field}`);
  }
  const extra: CaptureReadDetails = {};
  if (own(result, "capture")) extra.capture = boundedOriginalValue(result.capture, "capture_read.capture", MAX_PROCESS_VALUE_BYTES * 2);
  if (own(result, "provenance")) extra.provenance = boundedOriginalValue(result.provenance, "capture_read.provenance", MAX_PROVENANCE_BYTES);
  return formatFailure(original, "output_limit", "RESULT_TOO_LARGE", "Decoded capture exceeds the 48-KiB result limit", extra);
}

function createCaptureSummary(state: unknown, stdoutTextIsSafe: boolean, totalBytes: number | undefined, bytesRead: number, pageCount: number, savedEof = false) {
  return {
    state: state ?? "unknown",
    ...(stdoutTextIsSafe ? { source: "stdout_text" } : {}),
    saved_bytes: stdoutTextIsSafe ? null : totalBytes ?? null,
    bytes_read: bytesRead,
    page_count: pageCount,
    saved_eof: savedEof,
  };
}

function normalizeProjection(raw: unknown): { fields: Record<string, string>; parts: Record<string, string[]>; limit: number } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).some((key) => !["fields", "limit"].includes(key)) || !isRecord(raw.fields)) {
    throw new Error("project must contain fields and an optional limit");
  }
  const fields = Object.keys(raw.fields);
  if (fields.length === 0 || fields.length > 16 || fields.some((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key))) {
    throw new Error("Use one to sixteen lowercase projected field aliases");
  }
  const projected: Record<string, string> = {};
  const parts: Record<string, string[]> = {};
  for (const field of fields) {
    const pointer = raw.fields[field];
    if (typeof pointer !== "string" || pointer.length > 512) throw new Error("Projected field pointers must be strings of at most 512 characters");
    projected[field] = pointer;
    parts[field] = parsePointer(pointer);
  }
  const limit = raw.limit === undefined ? MAX_PROJECT_ROWS : raw.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_PROJECT_ROWS) {
    throw new Error(`project.limit must be an integer from 1 through ${MAX_PROJECT_ROWS}`);
  }
  return { fields: projected, parts, limit: limit as number };
}

type JsonlPageConfig = { startByte: number; maxRecords: number };

function normalizeJsonlPage(raw: unknown): JsonlPageConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "start_byte" && key !== "max_records")) {
    throw new Error("jsonl_page must contain only start_byte and max_records");
  }
  const startByte = raw.start_byte === undefined ? 0 : raw.start_byte;
  const maxRecords = raw.max_records === undefined ? MAX_JSONL_PAGE_DEFAULT_RECORDS : raw.max_records;
  if (!Number.isSafeInteger(startByte) || (startByte as number) < 0) throw new Error("jsonl_page.start_byte must be a non-negative safe byte offset");
  if (!Number.isSafeInteger(maxRecords) || (maxRecords as number) < 1 || (maxRecords as number) > MAX_JSONL_PAGE_RECORDS) {
    throw new Error(`jsonl_page.max_records must be an integer from 1 through ${MAX_JSONL_PAGE_RECORDS}`);
  }
  return { startByte: startByte as number, maxRecords: maxRecords as number };
}

function normalizeReducer(raw: unknown): { groupPointer: string; groupParts: string[]; valuePointer?: string; valueParts?: string[]; timePointer?: string; timeParts?: string[] } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).some((key) => !["group_pointer", "value_pointer", "time_pointer"].includes(key))
      || typeof raw.group_pointer !== "string" || raw.group_pointer.length > 512
      || (raw.value_pointer !== undefined && (typeof raw.value_pointer !== "string" || raw.value_pointer.length > 512))
      || (raw.time_pointer !== undefined && (typeof raw.time_pointer !== "string" || raw.time_pointer.length > 512))) {
    throw new Error("reduce requires an observed group_pointer and optional value_pointer or time_pointer");
  }
  return {
    groupPointer: raw.group_pointer,
    groupParts: parsePointer(raw.group_pointer),
    ...(raw.value_pointer === undefined ? {} : { valuePointer: raw.value_pointer as string, valueParts: parsePointer(raw.value_pointer) }),
    ...(raw.time_pointer === undefined ? {} : { timePointer: raw.time_pointer as string, timeParts: parsePointer(raw.time_pointer) }),
  };
}

function makeProjection(rows: unknown[], config: NonNullable<ReturnType<typeof normalizeProjection>>, rowsAreArray: boolean, maxStringChars = 256) {
  const result = { fields: config.fields, row_count: rowsAreArray ? rows.length : null, shown_count: 0, scan_complete: rowsAreArray,
    fields_complete: true, invalid_rows: 0, limit_reached: null as string | null, items: [] as Record<string, unknown>[] };
  let chars = 2;
  for (const row of rows) {
    if (result.items.length >= config.limit) {
      result.scan_complete = false;
      result.limit_reached = "rows";
      break;
    }
    const item: Record<string, unknown> = {};
    if (isRecord(row)) {
      for (const field of Object.keys(config.fields)) {
        const selected = getPointer(row, config.parts[field]!);
        const safe = selected.found ? projectBoundedValue(selected.value, 0, maxStringChars) : { ok: false as const };
        if (!safe.ok) {
          result.fields_complete = false;
          item[field] = null;
        } else item[field] = safe.value;
      }
    } else {
      result.invalid_rows += 1;
      result.fields_complete = false;
      for (const field of Object.keys(config.fields)) item[field] = null;
    }
    const encoded = JSON.stringify(item);
    const nextChars = chars + (result.items.length === 0 ? 0 : 1) + encoded.length;
    if (nextChars > MAX_PROJECT_CHARS) {
      result.scan_complete = false;
      result.limit_reached = "output_chars";
      break;
    }
    result.items.push(item);
    result.shown_count = result.items.length;
    chars = nextChars;
  }
  return result;
}

function projectJsonlRecord(row: unknown, config: NonNullable<ReturnType<typeof normalizeProjection>>): {
  item: Record<string, unknown>;
  fieldsComplete: boolean;
  invalidRow: boolean;
} {
  const item: Record<string, unknown> = {};
  let fieldsComplete = true;
  const invalidRow = !isRecord(row);
  if (invalidRow) fieldsComplete = false;
  for (const field of Object.keys(config.fields)) {
    const selected = isRecord(row) ? getPointer(row, config.parts[field]!) : { found: false as const };
    const safe = selected.found ? projectBoundedValue(selected.value, 0, MAX_SAMPLE_ROW_CHARS) : { ok: false as const };
    if (!safe.ok) {
      fieldsComplete = false;
      item[field] = null;
    } else item[field] = safe.value;
  }
  return { item, fieldsComplete, invalidRow };
}

type ParsedTimestamp = { kind: "number"; order: number; value: number } | { kind: "iso"; order: bigint; value: string };
type ReductionGroup = { group: unknown; count: number; sum: number | null; min: number | null; max: number | null;
  positive_count?: number; first_time?: string | number | null; last_time?: string | number | null; invalid_times?: number };
type ReductionGroupState = { summary: ReductionGroup; encodedChars: number; timeKind?: ParsedTimestamp["kind"]; firstTimeOrder?: number | bigint; lastTimeOrder?: number | bigint };

function parseTimestamp(value: unknown): ParsedTimestamp | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? { kind: "number", order: value, value } : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0", fraction = "", zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (zone === undefined) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  const offset = zone.toUpperCase() === "Z" ? 0 : (sign === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const epochMilliseconds = date.getTime() - offset * 60_000;
  if (!Number.isSafeInteger(epochMilliseconds)) return undefined;
  const fractionalNanoseconds = BigInt((fraction || "0").padEnd(9, "0"));
  return { kind: "iso", order: BigInt(epochMilliseconds) * 1_000_000n + fractionalNanoseconds, value };
}

function timestampBefore(value: ParsedTimestamp, order: number | bigint): boolean {
  return value.kind === "number" && typeof order === "number" ? value.order < order
    : value.kind === "iso" && typeof order === "bigint" ? value.order < order : false;
}

function timestampAfter(value: ParsedTimestamp, order: number | bigint): boolean {
  return value.kind === "number" && typeof order === "number" ? value.order > order
    : value.kind === "iso" && typeof order === "bigint" ? value.order > order : false;
}

function makeReduction(rows: unknown[], config: NonNullable<ReturnType<typeof normalizeReducer>>) {
  const groups = new Map<string, ReductionGroupState>();
  const result: {
    group_pointer: string; value_pointer: string | null; time_pointer: string | null;
    rows_scanned: number; scan_complete: boolean; groups_complete: boolean; invalid_groups: number; invalid_values: number;
    invalid_times?: number; omitted_groups: number; limit_reached: string | null; groups: ReductionGroup[];
  } = {
    group_pointer: config.groupPointer, value_pointer: config.valuePointer ?? null, time_pointer: config.timePointer ?? null,
    rows_scanned: 0, scan_complete: true, groups_complete: true, invalid_groups: 0, invalid_values: 0,
    ...(config.timeParts === undefined ? {} : { invalid_times: 0 }),
    omitted_groups: 0, limit_reached: null, groups: [],
  };
  const metadataValueChars = () => String(result.rows_scanned).length + String(result.invalid_groups).length
    + String(result.invalid_values).length + String(result.omitted_groups).length
    + (result.invalid_times === undefined ? 0 : String(result.invalid_times).length)
    + (result.scan_complete ? 4 : 5) + (result.groups_complete ? 4 : 5)
    + (result.limit_reached === null ? 4 : result.limit_reached.length + 2);
  const fixedChars = JSON.stringify(result).length - metadataValueChars();
  let groupChars = 0;
  const updateGroupChars = (state: ReductionGroupState) => {
    const nextChars = JSON.stringify(state.summary).length;
    groupChars += nextChars - state.encodedChars;
    state.encodedChars = nextChars;
  };
  // Count changed groups and metadata, not the complete group array on each row.
  const encodedChars = () => fixedChars + metadataValueChars() + groupChars + Math.max(0, result.groups.length - 1);
  for (const row of rows) {
    if (result.rows_scanned >= MAX_REDUCER_ROWS) {
      result.scan_complete = false;
      result.limit_reached = "rows";
      break;
    }
    result.rows_scanned += 1;
    const rowIsRecord = isRecord(row);
    const selectedTime = config.timeParts && rowIsRecord ? getPointer(row, config.timeParts) : undefined;
    const timestamp = selectedTime?.found ? parseTimestamp(selectedTime.value) : undefined;
    let invalidTime = config.timeParts !== undefined && timestamp === undefined;
    if (invalidTime) {
      result.invalid_times! += 1;
      result.groups_complete = false;
    }
    if (!rowIsRecord) {
      result.invalid_groups += 1;
      result.groups_complete = false;
      continue;
    }
    const selected = getPointer(row, config.groupParts);
    const safeGroup = selected.found ? projectBoundedValue(selected.value) : { ok: false as const };
    if (!safeGroup.ok) {
      result.invalid_groups += 1;
      result.groups_complete = false;
      continue;
    }
    let value: number | undefined;
    let invalidValue = false;
    if (config.valueParts) {
      const selectedValue = getPointer(row, config.valueParts);
      if (!selectedValue.found || typeof selectedValue.value !== "number" || !Number.isFinite(selectedValue.value)) {
        result.invalid_values += 1;
        result.groups_complete = false;
        invalidValue = true;
      } else value = selectedValue.value;
    }
    if (invalidValue && config.timeParts === undefined) continue;
    const key = JSON.stringify(safeGroup.value);
    let state = groups.get(key);
    if (!state) {
      if (groups.size >= MAX_REDUCER_GROUPS) {
        result.groups_complete = false;
        result.limit_reached = "groups";
        continue;
      }
      const summary: ReductionGroup = { group: safeGroup.value, count: 0, sum: config.valueParts ? 0 : null, min: null, max: null,
        ...(config.valueParts === undefined ? {} : { positive_count: 0 }),
        ...(config.timeParts === undefined ? {} : { first_time: null, last_time: null, invalid_times: 0 }),
      };
      state = { summary, encodedChars: 0 };
      groups.set(key, state);
      result.groups.push(summary);
    }
    if (config.timeParts !== undefined) {
      if (timestamp && state.timeKind !== undefined && state.timeKind !== timestamp.kind) {
        invalidTime = true;
        result.invalid_times! += 1;
        result.groups_complete = false;
      }
      if (invalidTime) state.summary.invalid_times! += 1;
      else if (timestamp) {
        state.timeKind = timestamp.kind;
        if (state.firstTimeOrder === undefined || timestampBefore(timestamp, state.firstTimeOrder)) {
          state.firstTimeOrder = timestamp.order;
          state.summary.first_time = timestamp.value;
        }
        if (state.lastTimeOrder === undefined || timestampAfter(timestamp, state.lastTimeOrder)) {
          state.lastTimeOrder = timestamp.order;
          state.summary.last_time = timestamp.value;
        }
      }
    }
    if (invalidValue) {
      updateGroupChars(state);
      continue;
    }
    state.summary.count += 1;
    if (value !== undefined) {
      const sum = state.summary.sum! + value;
      if (!Number.isFinite(sum)) throw new Error("Reduced sum is outside the finite number range");
      state.summary.sum = sum;
      state.summary.min = state.summary.min === null ? value : Math.min(state.summary.min, value);
      state.summary.max = state.summary.max === null ? value : Math.max(state.summary.max, value);
      if (value > 0) state.summary.positive_count! += 1;
    }
    updateGroupChars(state);
    if (encodedChars() > MAX_REDUCER_CHARS) {
      result.groups_complete = false;
      result.scan_complete = false;
      result.limit_reached = "output_chars";
      break;
    }
  }
  if (config.timeParts !== undefined) {
    for (const state of groups.values()) {
      if (!result.scan_complete || result.invalid_groups > 0 || state.summary.invalid_times! > 0) {
        state.summary.first_time = null;
        state.summary.last_time = null;
        updateGroupChars(state);
      }
    }
  }
  if (result.invalid_groups > 0) {
    result.groups = [];
    groupChars = 0;
  }
  while (encodedChars() > MAX_REDUCER_CHARS && result.groups.length > 0) {
    const removed = result.groups.pop()!;
    groupChars -= groups.get(JSON.stringify(removed.group))!.encodedChars;
    result.omitted_groups += 1;
    result.groups_complete = false;
    result.limit_reached = "output_chars";
  }
  return result;
}

type JsonlScannedRecord = {
  row: unknown;
  startByte: number;
  endByte: number;
  nextByte: number;
  line: number;
  error?: { code: string; message: string };
};

type JsonlScan = {
  rows: unknown[];
  recordDetails: JsonlScannedRecord[];
  linesSeen: number;
  recordsSeen: number;
  validRecords: number;
  invalidLines: number;
  blankLines: number;
  nonObjectRecords: number;
  omittedRecords: number;
  lineLimitReached: boolean;
  recordLimitReached: boolean;
  errors: Array<{ line: number; code: string; message: string }>;
  omittedErrors: number;
  pending: string;
  pendingBytes: number;
  skippingLongLine: boolean;
  nextByteOffset: number;
  lineStartByte: number;
};

function createJsonlScanner(startByte = 0, detailLimit = 0): {
  scan: JsonlScan;
  consume: (text: string, startByte?: number) => void;
  finish: (savedEof: boolean) => void;
} {
  const scan: JsonlScan = {
    rows: [], recordDetails: [], linesSeen: 0, recordsSeen: 0, validRecords: 0, invalidLines: 0, blankLines: 0, nonObjectRecords: 0,
    omittedRecords: 0, lineLimitReached: false, recordLimitReached: false, errors: [], omittedErrors: 0,
    pending: "", pendingBytes: 0, skippingLongLine: false, nextByteOffset: startByte, lineStartByte: startByte,
  };
  const addError = (line: number, code: string, message: string) => {
    if (scan.errors.length < MAX_JSONL_ERRORS) scan.errors.push({ line, code, message: message.slice(0, 240) });
    else scan.omittedErrors += 1;
  };
  const appendRow = (row: unknown) => {
    if (scan.recordsSeen > MAX_JSONL_RECORDS) {
      scan.recordLimitReached = true;
      scan.omittedRecords += 1;
      return;
    }
    if (detailLimit <= 0 || scan.recordDetails.length < detailLimit) scan.rows.push(row);
  };
  const finishLine = (endByte: number, nextByte: number) => {
    scan.linesSeen += 1;
    const line = scan.linesSeen;
    const startByte = scan.lineStartByte;
    let row: unknown;
    let recordError: JsonlScannedRecord["error"];
    if (scan.skippingLongLine) {
      scan.recordsSeen += 1;
      scan.invalidLines += 1;
      recordError = { code: "LINE_TOO_LARGE", message: `Line exceeds the ${MAX_JSONL_LINE_BYTES}-byte limit` };
      addError(line, recordError.code, recordError.message);
      appendRow(null);
      row = null;
    } else if (scan.pending.trim().length === 0) {
      scan.blankLines += 1;
      scan.pending = "";
      scan.pendingBytes = 0;
      scan.skippingLongLine = false;
      scan.nextByteOffset = nextByte;
      scan.lineStartByte = nextByte;
      return;
    } else {
      scan.recordsSeen += 1;
      if (scan.recordsSeen > MAX_JSONL_RECORDS) {
        scan.recordLimitReached = true;
        scan.omittedRecords += 1;
        scan.pending = "";
        scan.pendingBytes = 0;
        scan.skippingLongLine = false;
        scan.nextByteOffset = nextByte;
        scan.lineStartByte = nextByte;
        return;
      }
      try {
        row = JSON.parse(scan.pending) as unknown;
        scan.validRecords += 1;
        if (!isRecord(row)) {
          scan.nonObjectRecords += 1;
          scan.invalidLines += 1;
          recordError = { code: "INVALID_RECORD", message: "JSONL record is not an object" };
          addError(line, recordError.code, recordError.message);
        }
        appendRow(row);
      } catch {
        scan.invalidLines += 1;
        recordError = { code: "INVALID_JSON", message: "JSONL record is not valid JSON" };
        addError(line, recordError.code, recordError.message);
        appendRow(null);
        row = null;
      }
    }
    if (detailLimit > 0 && scan.recordDetails.length < detailLimit) {
      scan.recordDetails.push({ row, startByte, endByte, nextByte, line, ...(recordError ? { error: recordError } : {}) });
    }
    scan.pending = "";
    scan.pendingBytes = 0;
    scan.skippingLongLine = false;
    scan.nextByteOffset = nextByte;
    scan.lineStartByte = nextByte;
  };
  const appendSegment = (segment: string) => {
    if (scan.skippingLongLine) return;
    const bytes = utf8ByteLength(segment);
    if (scan.pendingBytes + bytes > MAX_JSONL_LINE_BYTES) {
      scan.pending = "";
      scan.pendingBytes = 0;
      scan.skippingLongLine = true;
      scan.lineLimitReached = true;
      return;
    }
    scan.pending += segment;
    scan.pendingBytes += bytes;
  };
  return {
    scan,
    consume(text, pageStartByte = scan.nextByteOffset) {
      if (pageStartByte !== scan.nextByteOffset) throw new Error("JSONL scanner received a non-contiguous byte page");
      let textIndex = 0;
      let byteOffset = pageStartByte;
      while (true) {
        const newline = text.indexOf("\n", textIndex);
        if (newline < 0) break;
        const segment = text.slice(textIndex, newline);
        const segmentBytes = utf8ByteLength(segment);
        appendSegment(segment);
        finishLine(byteOffset + segmentBytes, byteOffset + segmentBytes + 1);
        byteOffset += segmentBytes + 1;
        textIndex = newline + 1;
        if (detailLimit > 0 && scan.recordDetails.length >= detailLimit) return;
      }
      const tail = text.slice(textIndex);
      const tailBytes = utf8ByteLength(tail);
      appendSegment(tail);
      scan.nextByteOffset = byteOffset + tailBytes;
    },
    finish(savedEof) {
      if (savedEof && (scan.pending.length > 0 || scan.skippingLongLine)) finishLine(scan.nextByteOffset, scan.nextByteOffset);
    },
  };
}

class JsonlArtifactPageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "JsonlArtifactPageError";
  }
}

type JsonlArtifactBytePage = {
  data: string;
  rawBytes: Buffer;
  totalBytes: number;
  startByte: number;
  endByte: number;
  hasMore: boolean;
  provenance: Record<string, unknown>;
};

async function readJsonlArtifactPage(
  readArtifact: ReturnType<typeof createArtifactReadTool>,
  artifactId: string,
  requestId: string,
  startByte: number,
  maxBytes: number,
  encoding: "utf8" | "base64",
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<JsonlArtifactBytePage> {
  let result: Awaited<ReturnType<NonNullable<typeof readArtifact.execute>>>;
  try {
    result = await readArtifact.execute(
      requestId,
      { artifact_id: artifactId, stream: "stdout", mode: "bytes", encoding, start_byte: startByte, max_bytes: maxBytes },
      signal,
      undefined,
      ctx,
    );
  } catch (error) {
    throw new JsonlArtifactPageError("ARTIFACT_READ_FAILED", String(error));
  }
  const pageResult = result.structuredContent as unknown;
  if (!isRecord(pageResult) || pageResult.ok !== true) {
    const error = isRecord(pageResult) && isRecord(pageResult.error) ? pageResult.error : { code: "INVALID_RESULT", message: "No artifact page" };
    throw new JsonlArtifactPageError(typeof error.code === "string" ? error.code : "ARTIFACT_READ_FAILED",
      typeof error.message === "string" ? error.message : "artifact_read failed");
  }
  if (!isRecord(pageResult.page) || typeof pageResult.data !== "string" || !isRecord(pageResult.provenance)) {
    throw new JsonlArtifactPageError("INVALID_PAGE", "artifact_read returned an invalid byte page");
  }
  const page = pageResult.page;
  if (!Number.isSafeInteger(page.total_bytes) || (page.total_bytes as number) < 0) {
    throw new JsonlArtifactPageError("INVALID_PAGE", "artifact_read returned an invalid source size");
  }
  if (Number.isSafeInteger(page.start_byte) && startByte > (page.total_bytes as number) && page.start_byte === page.total_bytes) {
    throw new JsonlArtifactPageError("INVALID_INPUT", "start_byte must not exceed source_bytes on the bytes route");
  }
  if (page.encoding !== encoding || !Number.isSafeInteger(page.start_byte) || page.start_byte !== startByte
      || !Number.isSafeInteger(page.end_byte) || (page.end_byte as number) < startByte
      || (page.end_byte as number) > (page.total_bytes as number) || typeof page.has_more !== "boolean") {
    throw new JsonlArtifactPageError("INVALID_PAGE", "artifact_read returned invalid byte offsets");
  }
  const rawBytes = encoding === "base64" ? Buffer.from(pageResult.data, "base64") : Buffer.from(pageResult.data, "utf8");
  if ((encoding === "base64" && rawBytes.toString("base64") !== pageResult.data)
      || rawBytes.length !== (page.end_byte as number) - startByte || rawBytes.length > maxBytes
      || (encoding === "utf8" && utf8ByteLength(pageResult.data) !== rawBytes.length)) {
    throw new JsonlArtifactPageError("INVALID_PAGE", "artifact_read returned a byte payload with invalid length or encoding");
  }
  if (page.has_more) {
    if (page.next_start_byte !== page.end_byte || (page.end_byte as number) >= (page.total_bytes as number)) {
      throw new JsonlArtifactPageError("INVALID_PAGE", "Byte page has no valid numeric continuation");
    }
  } else if (page.next_start_byte !== null || page.end_byte !== page.total_bytes) {
    throw new JsonlArtifactPageError("INVALID_PAGE", "Final page did not reach saved-file EOF");
  }
  if (page.has_more && rawBytes.length === 0) throw new JsonlArtifactPageError("INVALID_PAGE", "Byte page made no progress");
  return {
    data: pageResult.data,
    rawBytes,
    totalBytes: page.total_bytes as number,
    startByte: page.start_byte as number,
    endByte: page.end_byte as number,
    hasMore: page.has_more as boolean,
    provenance: pageResult.provenance,
  };
}

function finalizeJsonlResult(
  original: CaptureReadDetails,
  project: ReturnType<typeof normalizeProjection>,
  reducer: ReturnType<typeof normalizeReducer>,
  scanner: ReturnType<typeof createJsonlScanner>,
  capture: (savedEof?: boolean) => ReturnType<typeof createCaptureSummary>,
  savedEof: boolean,
  provenance: Record<string, unknown> | undefined,
  totalBytes: number | undefined,
): CaptureReadDetails {
  const scan = scanner.scan;
  const captureLimited = !savedEof && (totalBytes ?? 0) > MAX_JSONL_CAPTURE_BYTES;
  const byteScanComplete = savedEof;
  const recordsComplete = savedEof && !scan.lineLimitReached && !scan.recordLimitReached && scan.invalidLines === 0;
  let projection: CaptureReadDetails | undefined;
  let reduction: CaptureReadDetails | undefined;
  const samples: unknown[] = [];
  let sampleChars = 0;
  if (project) {
    projection = makeProjection(scan.rows, project, true);
    projection.row_count = savedEof ? scan.recordsSeen : null;
    if (!byteScanComplete || scan.recordLimitReached || scan.lineLimitReached) {
      projection.scan_complete = false;
      if (projection.limit_reached === null) {
        projection.limit_reached = captureLimited ? "capture_bytes" : scan.recordLimitReached ? "records" : scan.lineLimitReached ? "line_bytes" : null;
      }
    }
  } else {
    for (const row of scan.rows) {
      if (samples.length >= MAX_SAMPLE_ROWS) break;
      const encoded = JSON.stringify(row);
      if (typeof encoded !== "string" || encoded.length > MAX_SAMPLE_ROW_CHARS || sampleChars + encoded.length > MAX_SAMPLE_CHARS) break;
      samples.push(row);
      sampleChars += encoded.length;
    }
  }
  if (reducer) {
    try {
      reduction = makeReduction(scan.rows, reducer);
      if (!byteScanComplete || scan.recordLimitReached || scan.lineLimitReached) {
        reduction.scan_complete = false;
        reduction.groups_complete = false;
        reduction.limit_reached = captureLimited ? "capture_bytes" : scan.recordLimitReached ? "records" : "line_bytes";
      } else if (!recordsComplete) {
        reduction.groups_complete = false;
      }
      if (!reduction.scan_complete || !reduction.groups_complete) {
        for (const group of reduction.groups as ReductionGroup[]) {
          if (reducer.timeParts !== undefined) {
            group.first_time = null;
            group.last_time = null;
          }
        }
        if (scan.invalidLines > 0 || scan.lineLimitReached) reduction.groups = [];
      }
    } catch (error) {
      return formatFailure(original, "reduce", "REDUCTION_FAILED", String(error), {
        capture: capture(savedEof), provenance: provenance ?? null,
      });
    }
  }
  const decoded: CaptureReadDetails = {
    ...original,
    status: { ...(isRecord(original.status) ? original.status : {}), decode: scan.invalidLines > 0 ? "failed" : "ok", producer: "unknown" },
    read_ok: recordsComplete,
    capture: capture(savedEof),
    provenance: provenance ?? null,
    document: {
      format: "jsonl",
      selection: { rows_pointer: "", metadata_pointers: {} },
      producer_metadata: {},
      missing_metadata: [],
      jsonl: {
        byte_scan_complete: byteScanComplete,
        records_complete: recordsComplete,
        lines_seen: scan.linesSeen,
        records_seen: savedEof ? scan.recordsSeen : null,
        valid_records: scan.validRecords,
        invalid_lines: scan.invalidLines,
        blank_lines: scan.blankLines,
        non_object_records: scan.nonObjectRecords,
        omitted_records: scan.omittedRecords,
        errors_omitted: scan.omittedErrors,
        limit_reached: captureLimited ? "capture_bytes" : scan.recordLimitReached ? "records" : scan.lineLimitReached ? "line_bytes" : null,
        errors: scan.errors,
      },
      rows: {
        state: "array",
        value_type: "array",
        count: savedEof ? scan.recordsSeen : null,
        shown: project ? projection?.shown_count : samples.length,
        sample_incomplete: project ? null : !recordsComplete || samples.length < scan.rows.length,
        sample: project ? null : samples,
        ...(projection === undefined ? {} : { projection }),
        ...(reduction === undefined ? {} : { reduction }),
      },
    },
    ...(!recordsComplete ? {
      stage: captureLimited ? "size_limit" : "jsonl_parse",
      decode_error: captureLimited
        ? { code: "CAPTURE_TOO_LARGE", message: `Saved JSONL exceeds the ${MAX_JSONL_CAPTURE_BYTES}-byte scan limit` }
        : scan.recordLimitReached ? { code: "JSONL_RECORD_LIMIT", message: `Saved JSONL exceeds the ${MAX_JSONL_RECORDS}-record limit` }
          : scan.lineLimitReached ? { code: "JSONL_LINE_TOO_LARGE", message: `A saved JSONL line exceeds the ${MAX_JSONL_LINE_BYTES}-byte limit` }
            : { code: "INVALID_JSONL_LINES", message: `${scan.invalidLines} saved JSONL line(s) could not be decoded; see document.jsonl.errors` },
    } : {}),
  };
  if (outputBytes(decoded) > MAX_RESULT_BYTES) return outputLimitFailure(decoded);
  return decoded;
}

async function decodeJsonlPageCapture(
  original: CaptureReadDetails,
  saved: Record<string, unknown>,
  artifact: Record<string, unknown> | undefined,
  stdoutTextIsSafe: boolean,
  project: ReturnType<typeof normalizeProjection>,
  pageConfig: JsonlPageConfig,
  readArtifact: ReturnType<typeof createArtifactReadTool>,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<CaptureReadDetails> {
  if (project && outputBytes(project.fields) > MAX_JSONL_PAGE_PROJECTION_BYTES) {
    return formatFailure(original, "selection", "INVALID_SELECTION", "JSONL page projection fields exceed the 8-KiB limit");
  }
  const startByte = pageConfig.startByte;
  const maxRecords = Math.min(pageConfig.maxRecords, project?.limit ?? pageConfig.maxRecords);
  const scanner = createJsonlScanner(startByte, maxRecords + 1);
  let totalBytes: number | undefined;
  let bytesRead = 0;
  let pageCount = 0;
  let provenance: Record<string, unknown> | undefined;
  let provenanceJson: string | undefined;
  let readCursor = startByte;
  let fileEof = false;
  let logicalCursor = startByte;
  let stop = false;
  let limitReached: string | null = null;
  let returnedRecords = 0;
  let examinedRecords = 0;
  let validRecords = 0;
  let invalidLines = 0;
  let nonObjectRecords = 0;
  let omittedErrors = 0;
  let sampleChars = 0;
  let sampleBytes = 0;
  let projectionFieldsComplete = true;
  let projectionInvalidRows = 0;
  let processedDetailCount = 0;
  const returnedRows: unknown[] = [];
  const errors: Array<Record<string, unknown>> = [];
  const gaps: Array<Record<string, unknown>> = [];
  const capture = (eof = false) => createCaptureSummary(
    isRecord(original.status) ? original.status.capture : "unknown", stdoutTextIsSafe, totalBytes, bytesRead, pageCount, eof,
  );
  const artifactFailure = (code: string, message: string) => formatFailure(original, "artifact_read", code, message, {
    capture: capture(), ...(provenance === undefined ? {} : { provenance }),
  });
  const cursorFailure = (message: string) => formatFailure(original, "jsonl_page", "INVALID_CURSOR", message, {
    capture: capture(), ...(provenance === undefined ? {} : { provenance }),
  });
  const adoptPage = (page: JsonlArtifactBytePage): string | undefined => {
    if (totalBytes !== undefined && totalBytes !== page.totalBytes) return "Saved stream size changed between pages";
    totalBytes = page.totalBytes;
    const current = JSON.stringify(page.provenance);
    if (provenanceJson !== undefined && provenanceJson !== current) return "Artifact provenance changed between pages";
    provenanceJson = current;
    provenance ??= page.provenance;
    return undefined;
  };
  const recordError = (record: JsonlScannedRecord, code: string, message: string) => {
    const item = { line: record.line, start_byte: record.startByte, end_byte: record.endByte, code, message: message.slice(0, 240) };
    if (errors.length < MAX_JSONL_ERRORS) errors.push(item);
    else omittedErrors += 1;
  };
  const recordGap = (record: JsonlScannedRecord, code: string, message: string) => {
    gaps.push({
      start_byte: record.startByte,
      end_byte: record.endByte,
      next_start_byte: record.nextByte,
      code,
      message: message.slice(0, 240),
    });
    examinedRecords += 1;
    invalidLines += 1;
    logicalCursor = record.nextByte;
    limitReached = "record_gap";
    stop = true;
  };
  const processRecords = () => {
    while (processedDetailCount < scanner.scan.recordDetails.length) {
      const record = scanner.scan.recordDetails[processedDetailCount]!;
      if (returnedRecords >= maxRecords) {
        logicalCursor = record.startByte;
        limitReached = project && project.limit < pageConfig.maxRecords ? "project_rows" : "max_records";
        stop = true;
        return;
      }
      if (record.error?.code === "LINE_TOO_LARGE") {
        recordGap(record, "LINE_TOO_LARGE", record.error.message);
        return;
      }
      let outputRow: unknown = record.row;
      if (project) {
        const projected = projectJsonlRecord(record.row, project);
        outputRow = projected.item;
        projectionFieldsComplete &&= projected.fieldsComplete;
        if (projected.invalidRow) projectionInvalidRows += 1;
      }
      const encoded = JSON.stringify(outputRow);
      if (typeof encoded !== "string" || encoded.length > MAX_SAMPLE_ROW_CHARS) {
        recordGap(record, "ROW_TOO_LARGE", `JSONL page row exceeds the ${MAX_SAMPLE_ROW_CHARS}-character limit`);
        return;
      }
      if (sampleChars + encoded.length > MAX_SAMPLE_CHARS) {
        logicalCursor = record.startByte;
        limitReached = "sample_chars";
        stop = true;
        return;
      }
      const encodedBytes = utf8ByteLength(encoded);
      if (sampleBytes + encodedBytes > MAX_JSONL_PAGE_OUTPUT_BYTES) {
        logicalCursor = record.startByte;
        limitReached = "result_bytes";
        stop = true;
        return;
      }
      if (record.error) {
        recordError(record, record.error.code, record.error.message);
        invalidLines += 1;
        if (record.error.code === "INVALID_RECORD") {
          nonObjectRecords += 1;
          validRecords += 1;
        }
      } else validRecords += 1;
      returnedRows.push(outputRow);
      returnedRecords += 1;
      examinedRecords += 1;
      processedDetailCount += 1;
      sampleChars += encoded.length;
      sampleBytes += encodedBytes;
      logicalCursor = record.nextByte;
      if (returnedRecords >= maxRecords) {
        const hasMore = totalBytes === undefined || logicalCursor < totalBytes;
        limitReached = hasMore ? project && project.limit < pageConfig.maxRecords ? "project_rows" : "max_records" : null;
        stop = true;
        return;
      }
    }
    logicalCursor = scanner.scan.lineStartByte;
  };

  if (stdoutTextIsSafe) {
    const text = saved.stdout_text as string;
    totalBytes = utf8ByteLength(text);
    const codeUnitOffset = utf8CodeUnitOffsetAtByte(text, startByte);
    if (codeUnitOffset === undefined || startByte > totalBytes) return cursorFailure("jsonl_page.start_byte is not a valid UTF-8 byte boundary");
    if (startByte > 0 && startByte < totalBytes && text.charCodeAt(codeUnitOffset - 1) !== 0x0a) {
      return cursorFailure("jsonl_page.start_byte must be zero, EOF, or immediately after a newline");
    }
    const pagePrefix = boundedUtf8Prefix(text.slice(codeUnitOffset), MAX_JSONL_PAGE_SCAN_BYTES);
    bytesRead = pagePrefix.byteLength;
    const reachedFileEof = startByte + pagePrefix.byteLength === totalBytes;
    scanner.consume(pagePrefix.text, startByte);
    if (reachedFileEof) {
      fileEof = true;
      scanner.finish(true);
    }
    processRecords();
    readCursor = startByte + pagePrefix.byteLength;
  } else {
    if (!artifact || typeof artifact.id !== "string") {
      return formatFailure(original, "artifact", "ARTIFACT_MISSING", "The saved envelope has no granted stdout artifact ID");
    }
    if (startByte > 0) {
      let boundaryPage: JsonlArtifactBytePage;
      try {
        boundaryPage = await readJsonlArtifactPage(readArtifact, artifact.id, `capture-read/jsonl-boundary/${pageCount + 1}`,
          startByte - 1, 1, "base64", signal, ctx);
      } catch (error) {
        if (error instanceof JsonlArtifactPageError && error.code === "INVALID_INPUT" && /start_byte/i.test(error.message)) {
          return cursorFailure("jsonl_page.start_byte exceeds the saved stream or is not a valid cursor");
        }
        const failure = error instanceof JsonlArtifactPageError ? error : new JsonlArtifactPageError("ARTIFACT_READ_FAILED", String(error));
        return artifactFailure(failure.code, failure.message);
      }
      pageCount += 1;
      bytesRead += boundaryPage.rawBytes.length;
      const changed = adoptPage(boundaryPage);
      if (changed) return artifactFailure("PROVENANCE_CHANGED", changed);
      if (startByte > boundaryPage.totalBytes) return cursorFailure("jsonl_page.start_byte exceeds the saved stream length");
      if (startByte < boundaryPage.totalBytes && boundaryPage.rawBytes.length !== 1) {
        return cursorFailure("jsonl_page.start_byte is not a valid newline boundary");
      }
      if (startByte < boundaryPage.totalBytes && boundaryPage.rawBytes[0] !== 0x0a) {
        return cursorFailure("jsonl_page.start_byte must be zero, EOF, or immediately after a newline");
      }
    }
    if (totalBytes !== undefined && startByte === totalBytes) fileEof = true;
    while (!stop && !fileEof && (totalBytes === undefined || readCursor < totalBytes) && bytesRead < MAX_JSONL_PAGE_SCAN_BYTES) {
      const remaining = MAX_JSONL_PAGE_SCAN_BYTES - bytesRead;
      if (remaining <= 0) break;
      if (remaining < 4) {
        limitReached = "scan_bytes";
        logicalCursor = scanner.scan.lineStartByte;
        stop = true;
        break;
      }
      let page: JsonlArtifactBytePage;
      try {
        page = await readJsonlArtifactPage(readArtifact, artifact.id, `capture-read/jsonl-page/${pageCount + 1}`,
          readCursor, Math.min(40_960, remaining), "utf8", signal, ctx);
      } catch (error) {
        if (error instanceof JsonlArtifactPageError && error.code === "INVALID_INPUT" && /start_byte/i.test(error.message)) {
          return cursorFailure("jsonl_page.start_byte exceeds the saved stream length");
        }
        const failure = error instanceof JsonlArtifactPageError ? error : new JsonlArtifactPageError("ARTIFACT_READ_FAILED", String(error));
        return artifactFailure(failure.code, failure.message);
      }
      pageCount += 1;
      bytesRead += page.rawBytes.length;
      const changed = adoptPage(page);
      if (changed) return artifactFailure("PROVENANCE_CHANGED", changed);
      if (page.startByte !== readCursor) return artifactFailure("INVALID_PAGE", "artifact_read returned a page at an unexpected cursor");
      scanner.consume(page.data, readCursor);
      readCursor = page.endByte;
      if (!page.hasMore) {
        fileEof = true;
        scanner.finish(true);
      }
      processRecords();
      if (!stop) logicalCursor = scanner.scan.lineStartByte;
      if (bytesRead >= MAX_JSONL_PAGE_SCAN_BYTES && !fileEof && !stop) {
        limitReached = "scan_bytes";
        logicalCursor = scanner.scan.lineStartByte;
        stop = true;
      }
    }
    if (!stop && fileEof) logicalCursor = scanner.scan.lineStartByte;
    if (!stop && !fileEof && bytesRead >= MAX_JSONL_PAGE_SCAN_BYTES) limitReached = "scan_bytes";
  }

  const eof = totalBytes !== undefined && logicalCursor === totalBytes && fileEof;
  if (eof) logicalCursor = totalBytes!;
  const complete = startByte === 0 && eof && errors.length === 0 && gaps.length === 0;
  const scanStalled = !eof && limitReached === "scan_bytes" && logicalCursor === startByte;
  const readOk = errors.length === 0 && gaps.length === 0 && projectionFieldsComplete && !scanStalled;
  const projection = project ? {
    fields: project.fields,
    row_count: complete ? examinedRecords : null,
    shown_count: returnedRows.length,
    scan_complete: complete,
    fields_complete: projectionFieldsComplete,
    invalid_rows: projectionInvalidRows,
    limit_reached: limitReached === "max_records" || limitReached === "project_rows" ? "rows"
      : limitReached === "sample_chars" ? "output_chars"
        : limitReached === "result_bytes" ? "output_bytes" : gaps.length > 0 ? "record_gap" : null,
    items: returnedRows,
  } : undefined;
  const decoded: CaptureReadDetails = {
    ...original,
    status: { ...(isRecord(original.status) ? original.status : {}), decode: readOk ? "ok" : "failed", producer: "unknown" },
    read_ok: readOk,
    capture: capture(eof),
    provenance: provenance ?? null,
    document: {
      format: "jsonl",
      selection: { rows_pointer: "", metadata_pointers: {} },
      producer_metadata: {},
      missing_metadata: [],
      jsonl: {
        byte_scan_complete: startByte === 0 && eof,
        records_complete: complete,
        lines_seen: complete ? scanner.scan.linesSeen : null,
        records_seen: complete ? examinedRecords : null,
        valid_records: validRecords,
        invalid_lines: invalidLines,
        blank_lines: eof && startByte === 0 ? scanner.scan.blankLines : null,
        non_object_records: nonObjectRecords,
        omitted_records: gaps.length,
        errors_omitted: omittedErrors,
        limit_reached: limitReached ?? (gaps.length > 0 ? "record_gap" : null),
        errors: errors.map(({ line, code, message }) => ({ line, code, message })),
      },
      jsonl_page: {
        start_byte: startByte,
        next_start_byte: logicalCursor,
        eof,
        complete,
        records_scanned: examinedRecords,
        records_returned: returnedRows.length,
        limit_reached: limitReached,
        errors,
        errors_omitted: omittedErrors,
        gaps,
      },
      rows: {
        state: "array",
        value_type: "array",
        count: complete ? examinedRecords : null,
        shown: returnedRows.length,
        sample_incomplete: !complete,
        sample: project ? null : returnedRows,
        ...(projection === undefined ? {} : { projection }),
      },
    },
    ...(!readOk ? {
      stage: "jsonl_page",
      decode_error: gaps.length > 0
        ? { code: "JSONL_RECORD_GAP", message: "A JSONL page record was skipped; continue from document.jsonl_page.next_start_byte" }
        : errors.length > 0
          ? { code: "INVALID_JSONL_LINES", message: "One or more JSONL page records could not be decoded; see document.jsonl_page.errors" }
          : project && !projectionFieldsComplete
            ? { code: "JSONL_FIELDS_INCOMPLETE", message: "One or more selected JSONL fields are missing or exceed the projection bounds; see document.rows.projection.fields_complete" }
            : scanStalled
              ? { code: "JSONL_SCAN_BUDGET_EXCEEDED", message: "A JSONL record exceeds the 8-MiB page scan budget before a newline boundary; this cursor cannot advance safely" }
              : { code: "INVALID_JSONL_LINES", message: "The JSONL page could not be decoded completely" },
    } : {}),
  };
  if (outputBytes(decoded) > MAX_RESULT_BYTES) return outputLimitFailure(decoded);
  return decoded;
}

async function decodeJsonlCapture(
  original: CaptureReadDetails,
  saved: Record<string, unknown>,
  artifact: Record<string, unknown> | undefined,
  stdoutTextIsSafe: boolean,
  project: ReturnType<typeof normalizeProjection>,
  reducer: ReturnType<typeof normalizeReducer>,
  pageConfig: JsonlPageConfig | undefined,
  readArtifact: ReturnType<typeof createArtifactReadTool>,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<CaptureReadDetails> {
  if (pageConfig) return decodeJsonlPageCapture(original, saved, artifact, stdoutTextIsSafe, project, pageConfig, readArtifact, signal, ctx);
  const scanner = createJsonlScanner();
  let nextStartByte = 0;
  let bytesRead = 0;
  let totalBytes: number | undefined;
  let pageCount = 0;
  let provenance: Record<string, unknown> | undefined;
  let provenanceJson: string | undefined;
  let savedEof = false;
  const captureState = isRecord(original.status) ? original.status.capture : "unknown";
  const capture = (eof = false) => createCaptureSummary(captureState, stdoutTextIsSafe, totalBytes, bytesRead, pageCount, eof);
  const readFailure = (code: string, message: string) => formatFailure(original, "artifact_read", code, message, {
    capture: capture(), ...(provenance === undefined ? {} : { provenance }),
  });

  if (stdoutTextIsSafe) {
    const text = saved.stdout_text as string;
    totalBytes = text.length > MAX_JSONL_CAPTURE_BYTES ? MAX_JSONL_CAPTURE_BYTES + 1 : utf8ByteLength(text);
    if (totalBytes > MAX_JSONL_CAPTURE_BYTES) {
      const prefix = boundedUtf8Prefix(text, MAX_JSONL_CAPTURE_BYTES);
      scanner.consume(prefix.text);
      bytesRead = prefix.byteLength;
    } else {
      bytesRead = totalBytes;
      scanner.consume(text);
      savedEof = true;
    }
  } else {
    if (!artifact || typeof artifact.id !== "string") {
      return formatFailure(original, "artifact", "ARTIFACT_MISSING", "The saved envelope has no granted stdout artifact ID");
    }
    while (true) {
      const remaining = MAX_JSONL_CAPTURE_BYTES - bytesRead;
      if (remaining < 4 && (totalBytes ?? 0) > MAX_JSONL_CAPTURE_BYTES) break;
      const maxBytes = Math.min(40_960, Math.max(1, remaining));
      let pageResult: Awaited<ReturnType<NonNullable<typeof readArtifact.execute>>>;
      try {
        pageResult = await readArtifact.execute(
          `capture-read/jsonl/${pageCount + 1}`,
          { artifact_id: artifact.id as string, stream: "stdout", mode: "bytes", encoding: "utf8", start_byte: nextStartByte, max_bytes: maxBytes },
          signal,
          undefined,
          ctx,
        );
      } catch (error) {
        return readFailure("ARTIFACT_READ_FAILED", String(error));
      }
      const page = pageResult.structuredContent as unknown;
      if (!isRecord(page) || page.ok !== true) {
        const error = isRecord(page) && isRecord(page.error) ? page.error : { code: "INVALID_RESULT", message: "No artifact page" };
        return readFailure(typeof error.code === "string" ? error.code : "ARTIFACT_READ_FAILED",
          typeof error.message === "string" ? error.message : "artifact_read failed");
      }
      if (!isRecord(page.page) || typeof page.data !== "string") return readFailure("INVALID_PAGE", "artifact_read returned an invalid page");
      const meta = page.page;
      if (!Number.isSafeInteger(meta.total_bytes) || (meta.total_bytes as number) < 0
          || !Number.isSafeInteger(meta.start_byte) || !Number.isSafeInteger(meta.end_byte)
          || meta.start_byte !== nextStartByte || (meta.end_byte as number) < nextStartByte
          || (meta.end_byte as number) > (meta.total_bytes as number) || typeof meta.has_more !== "boolean"
          || utf8ByteLength(page.data) !== (meta.end_byte as number) - (meta.start_byte as number)) {
        return readFailure("INVALID_PAGE", "artifact_read returned invalid byte offsets or payload length");
      }
      const firstPage = pageCount === 0;
      bytesRead += (meta.end_byte as number) - (meta.start_byte as number);
      pageCount += 1;
      if (totalBytes !== undefined && totalBytes !== meta.total_bytes) return readFailure("FILE_CHANGED", "Saved stream size changed between pages");
      totalBytes = meta.total_bytes as number;
      if (!isRecord(page.provenance)) return readFailure("INVALID_PAGE", "artifact_read returned invalid provenance");
      const currentProvenance = JSON.stringify(page.provenance);
      if (firstPage) {
        provenance = page.provenance;
        provenanceJson = currentProvenance;
      } else if (currentProvenance !== provenanceJson) return readFailure("PROVENANCE_CHANGED", "Artifact provenance changed between pages");
      if ((meta.end_byte as number) - (meta.start_byte as number) > maxBytes) return readFailure("INVALID_PAGE", "artifact_read exceeded the requested JSONL page size");
      scanner.consume(page.data);
      if (!meta.has_more) {
        if (meta.next_start_byte !== null || meta.end_byte !== totalBytes) return readFailure("INVALID_PAGE", "Final page did not reach saved-file EOF");
        nextStartByte = meta.end_byte as number;
        savedEof = true;
        break;
      }
      if (!Number.isSafeInteger(meta.next_start_byte) || (meta.next_start_byte as number) <= nextStartByte || meta.next_start_byte !== meta.end_byte) {
        return readFailure("INVALID_PAGE", "Byte page has no valid numeric continuation");
      }
      nextStartByte = meta.next_start_byte as number;
      if (bytesRead >= MAX_JSONL_CAPTURE_BYTES) break;
    }
  }
  scanner.finish(savedEof);
  return finalizeJsonlResult(original, project, reducer, scanner, capture, savedEof, provenance, totalBytes);
}

async function decodeCapture(
  saved: Record<string, unknown>,
  formatInput: unknown,
  selectionInput: unknown,
  projectInput: unknown,
  reduceInput: unknown,
  gzipFieldInput: unknown,
  jsonlPageInput: unknown,
  readArtifact: ReturnType<typeof createArtifactReadTool>,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
): Promise<CaptureReadDetails> {
  let state: ReturnType<typeof readOriginal>;
  try {
    state = readOriginal(saved);
  } catch (error) {
    const empty: CaptureReadDetails = { status: { process: "unknown", capture: "unknown", decode: "not_attempted", producer: "unknown" } };
    return formatFailure(empty, "envelope", "INVALID_ENVELOPE", String(error));
  }
  const { original, artifact, stdoutTextIsSafe } = state;
  let selection: ReturnType<typeof normalizeSelection>;
  let projection: ReturnType<typeof normalizeProjection>;
  let reducer: ReturnType<typeof normalizeReducer>;
  let gzipField: ReturnType<typeof normalizeGzipField>;
  let jsonlPage: JsonlPageConfig | undefined;
  const format = formatInput ?? "json";
  try {
    if (format !== "json" && format !== "jsonl") throw new Error('format must be "json" or "jsonl"');
    selection = normalizeSelection(selectionInput);
    projection = normalizeProjection(projectInput);
    reducer = normalizeReducer(reduceInput);
    gzipField = normalizeGzipField(gzipFieldInput);
    jsonlPage = normalizeJsonlPage(jsonlPageInput);
    if (projection && selection.identityPointers) throw new Error("Use project or identity_pointers, not both");
    if (format === "jsonl" && selectionInput !== undefined) throw new Error("selection is not used with format=jsonl; use project or reduce pointers on each JSONL record");
    if (format === "jsonl" && gzipField) throw new Error("gzip_field is available only with format=json");
    if (jsonlPage && format !== "jsonl") throw new Error("jsonl_page is available only with format=jsonl");
    if (jsonlPage && reducer) throw new Error("reduce is available only for a full JSONL scan, not with jsonl_page");
  } catch (error) {
    return formatFailure(original, "selection", "INVALID_SELECTION", String(error));
  }
  if (outputBytes(original) > MAX_CONTEXT_BYTES) {
    return formatFailure(original, "original_metadata_limit", "METADATA_TOO_LARGE", "Saved process metadata exceeds the context limit");
  }
  if (!stdoutTextIsSafe && (!artifact || typeof artifact.id !== "string")) {
    return formatFailure(original, "artifact", "ARTIFACT_MISSING", "The saved envelope has no granted stdout artifact ID");
  }
  if (format === "jsonl") return decodeJsonlCapture(original, saved, artifact, stdoutTextIsSafe, projection, reducer, jsonlPage, readArtifact, signal, ctx);

  let nextStartByte = 0;
  let bytesRead = 0;
  let totalBytes: number | undefined;
  let pageCount = 0;
  let sourceText = "";
  let provenance: Record<string, unknown> | undefined;
  let provenanceJson: string | undefined;
  const captureState = isRecord(original.status) ? original.status.capture : "unknown";
  const capture = (savedEof = false) => createCaptureSummary(captureState, stdoutTextIsSafe, totalBytes, bytesRead, pageCount, savedEof);
  const readFailure = (code: string, message: string) => formatFailure(original, "artifact_read", code, message, {
    capture: capture(), ...(provenance === undefined ? {} : { provenance }),
  });

  if (stdoutTextIsSafe) {
    sourceText = saved.stdout_text as string;
    totalBytes = utf8ByteLength(sourceText);
    bytesRead = totalBytes;
    if (totalBytes > MAX_CAPTURE_BYTES) {
      return formatFailure(original, "size_limit", "CAPTURE_TOO_LARGE", "Saved capture exceeds the size limit", { capture: capture(), provenance: null });
    }
  } else {
    while (true) {
      let pageResult: Awaited<ReturnType<NonNullable<typeof readArtifact.execute>>>;
      try {
        pageResult = await readArtifact.execute(
          `capture-read/${pageCount + 1}`,
          { artifact_id: artifact!.id as string, stream: "stdout", mode: "bytes", encoding: "utf8", start_byte: nextStartByte, max_bytes: 40_960 },
          signal,
          undefined,
          ctx,
        );
      } catch (error) {
        return readFailure("ARTIFACT_READ_FAILED", String(error));
      }
      const page = pageResult.structuredContent as unknown;
      if (!isRecord(page) || page.ok !== true) {
        const error = isRecord(page) && isRecord(page.error) ? page.error : { code: "INVALID_RESULT", message: "No artifact page" };
        return readFailure(typeof error.code === "string" ? error.code : "ARTIFACT_READ_FAILED",
          typeof error.message === "string" ? error.message : "artifact_read failed");
      }
      if (!isRecord(page.page) || typeof page.data !== "string") return readFailure("INVALID_PAGE", "artifact_read returned an invalid page");
      const meta = page.page;
      if (!Number.isSafeInteger(meta.total_bytes) || (meta.total_bytes as number) < 0
          || !Number.isSafeInteger(meta.start_byte) || !Number.isSafeInteger(meta.end_byte)
          || meta.start_byte !== nextStartByte || (meta.end_byte as number) < nextStartByte
          || (meta.end_byte as number) > (meta.total_bytes as number) || typeof meta.has_more !== "boolean"
          || utf8ByteLength(page.data) !== (meta.end_byte as number) - (meta.start_byte as number)) {
        return readFailure("INVALID_PAGE", "artifact_read returned invalid byte offsets or payload length");
      }
      const firstPage = pageCount === 0;
      bytesRead += (meta.end_byte as number) - (meta.start_byte as number);
      pageCount += 1;
      if (totalBytes !== undefined && totalBytes !== meta.total_bytes) return readFailure("FILE_CHANGED", "Saved stream size changed between pages");
      totalBytes = meta.total_bytes as number;
      if (!isRecord(page.provenance)) return readFailure("INVALID_PAGE", "artifact_read returned invalid provenance");
      const currentProvenance = JSON.stringify(page.provenance);
      if (firstPage) {
        provenance = page.provenance;
        provenanceJson = currentProvenance;
      } else if (currentProvenance !== provenanceJson) {
        return readFailure("PROVENANCE_CHANGED", "Artifact provenance changed between pages");
      }
      if (totalBytes > MAX_CAPTURE_BYTES) {
        return formatFailure(original, "size_limit", "CAPTURE_TOO_LARGE", "Saved capture exceeds the size limit", { capture: capture(), provenance });
      }
      sourceText += page.data;
      if (!meta.has_more) {
        if (meta.next_start_byte !== null || meta.end_byte !== totalBytes) return readFailure("INVALID_PAGE", "Final page did not reach saved-file EOF");
        nextStartByte = meta.end_byte as number;
        break;
      }
      if (!Number.isSafeInteger(meta.next_start_byte) || (meta.next_start_byte as number) <= nextStartByte || meta.next_start_byte !== meta.end_byte) {
        return readFailure("INVALID_PAGE", "Byte page has no valid numeric continuation");
      }
      nextStartByte = meta.next_start_byte as number;
    }
  }

  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(sourceText);
    if (!isRecord(parsed)) return formatFailure(original, "document_shape", "INVALID_DOCUMENT", "Saved JSON is not an object", { capture: capture(true), provenance: provenance ?? null });
    document = parsed;
  } catch (error) {
    return formatFailure(original, "json_parse", "INVALID_JSON", String(error), { capture: capture(true), provenance: provenance ?? null });
  }
  const producerMetadata: Record<string, unknown> = {};
  const missingMetadata: string[] = [];
  let decodedGzipField: (ReturnType<typeof decodeBase64GzipField> & { page_limit_reached?: "result_bytes" }) | undefined;
  if (gzipField) {
    try {
      decodedGzipField = decodeBase64GzipField(document, gzipField);
    } catch (error) {
      const failure = error instanceof GzipFieldDecodeError ? error : new GzipFieldDecodeError("INVALID_GZIP", "The saved field could not be decoded");
      return formatFailure(original, "field_decode", failure.code, failure.message, { capture: capture(true), provenance: provenance ?? null });
    }
  }
  for (const field of Object.keys(selection.metadataParts)) {
    const selected = getPointer(document, selection.metadataParts[field]!);
    if (selected.found) producerMetadata[field] = selected.value;
    else missingMetadata.push(field);
  }
  const metadataChars = JSON.stringify(producerMetadata).length;
  if (metadataChars > MAX_METADATA_CHARS) {
    return formatFailure(original, "metadata_limit", "METADATA_TOO_LARGE", "Selected metadata exceeds its output limit", {
      capture: capture(true), provenance: provenance ?? null, metadata_chars: metadataChars, max_metadata_chars: MAX_METADATA_CHARS,
    });
  }
  const selectedRows = getPointer(document, selection.rowsParts);
  const rowsAreArray = selectedRows.found && Array.isArray(selectedRows.value);
  const rowsType = !selectedRows.found ? "missing" : selectedRows.value === null ? "null" : Array.isArray(selectedRows.value) ? "array" : typeof selectedRows.value;
  const rows = rowsAreArray ? selectedRows.value as unknown[] : [];
  const rowSamples: unknown[] = [];
  let rowSampleChars = 0;
  let identityProjection: CaptureReadDetails | undefined;
  let projectedRows: CaptureReadDetails | undefined;
  let reducedRows: CaptureReadDetails | undefined;
  if (selection.identityPointers) {
    const identityFields = Object.keys(selection.identityPointers);
    const items: Array<Record<string, unknown>> = [];
    let identityChars = 2;
    let missingRows = 0;
    let invalidRows = 0;
    let scanComplete = rowsAreArray;
    let limitReached: string | null = null;
    if (rowsAreArray) {
      for (const row of rows) {
        if (items.length >= MAX_PROJECT_ROWS) { scanComplete = false; limitReached = "rows"; break; }
        let identity: Record<string, unknown> | null = null;
        if (isRecord(row)) {
          identity = {};
          for (const field of identityFields) {
            const selected = getPointer(row, selection.identityParts[field]!);
            const value = selected.found ? projectBoundedValue(selected.value) : { ok: false as const };
            const encoded = value.ok ? JSON.stringify(value.value) : undefined;
            identity[field] = value.ok && typeof encoded === "string" && encoded.length <= 2048 ? value.value : null;
          }
          if (Object.values(identity).some((value) => value === null)) missingRows += 1;
        } else invalidRows += 1;
        const encoded = JSON.stringify(identity);
        const nextChars = identityChars + (items.length === 0 ? 0 : 1) + encoded.length;
        if (nextChars > MAX_PROJECT_CHARS) { scanComplete = false; limitReached = "output_chars"; break; }
        items.push(identity ?? {});
        identityChars = nextChars;
      }
    }
    identityProjection = {
      fields: selection.identityPointers,
      row_count: rowsAreArray ? rows.length : null,
      shown_count: items.length,
      scan_complete: scanComplete,
      identities_complete: scanComplete && missingRows === 0 && invalidRows === 0,
      missing_rows: missingRows,
      invalid_rows: invalidRows,
      limit_reached: limitReached,
      items,
    };
  } else if (projection) projectedRows = makeProjection(rows, projection, rowsAreArray);
  else {
    for (const row of rows) {
      if (rowSamples.length >= MAX_SAMPLE_ROWS) break;
      const encoded = JSON.stringify(row);
      if (typeof encoded !== "string" || encoded.length > 2048 || rowSampleChars + encoded.length > MAX_SAMPLE_CHARS) break;
      rowSamples.push(row);
      rowSampleChars += encoded.length;
    }
  }
  if (reducer) {
    if (rowsAreArray) {
      try { reducedRows = makeReduction(rows, reducer); }
      catch (error) {
        return formatFailure(original, "reduce", "REDUCTION_FAILED", String(error), { capture: capture(true), provenance: provenance ?? null });
      }
    } else reducedRows = {
      group_pointer: reducer.groupPointer, value_pointer: reducer.valuePointer ?? null, time_pointer: reducer.timePointer ?? null,
      rows_scanned: 0, scan_complete: false, groups_complete: false, invalid_groups: 0, invalid_values: 0,
      ...(reducer.timeParts === undefined ? {} : { invalid_times: 0 }),
      omitted_groups: 0, limit_reached: "rows_not_array", groups: [],
    };
  }
  const rowCount = rowsAreArray ? rows.length : null;
  const decoded: CaptureReadDetails = {
    ...original,
    status: { ...(isRecord(original.status) ? original.status : {}), decode: "ok", producer: own(producerMetadata, "status") ? producerMetadata.status : "unknown" },
    read_ok: true,
    capture: capture(true),
    provenance: provenance ?? null,
    document: {
      selection: {
        rows_pointer: selection.rowsPointer,
        metadata_pointers: selection.metadataPointers,
        ...(selection.identityPointers === undefined ? {} : { identity_pointers: selection.identityPointers }),
      },
      producer_metadata: producerMetadata,
      missing_metadata: missingMetadata,
      ...(decodedGzipField === undefined ? {} : { gzip_field: decodedGzipField }),
      rows: {
        state: !selectedRows.found ? "missing" : rowsAreArray ? "array" : "wrong_type",
        value_type: rowsType,
        count: rowCount,
        shown: identityProjection ? identityProjection.shown_count : projectedRows ? projectedRows.shown_count : rowSamples.length,
        sample_incomplete: selection.identityPointers || projection ? null : rowsAreArray ? rowSamples.length < rows.length : null,
        sample: selection.identityPointers || projection ? null : rowsAreArray ? rowSamples : null,
        ...(identityProjection === undefined ? {} : { identity_projection: identityProjection }),
        ...(projectedRows === undefined ? {} : { projection: projectedRows }),
        ...(reducedRows === undefined ? {} : { reduction: reducedRows }),
      },
    },
  };
  if (outputBytes(decoded) > MAX_RESULT_BYTES && decodedGzipField && gzipField) {
    let pageLimit = decodedGzipField.page_bytes;
    while (pageLimit > 4) {
      pageLimit = Math.max(4, Math.floor(pageLimit / 2));
      decodedGzipField = {
        ...decodeBase64GzipField(document, { ...gzipField, maxBytes: pageLimit }),
        page_limit_reached: "result_bytes",
      };
      (decoded.document as Record<string, unknown>).gzip_field = decodedGzipField;
      if (outputBytes(decoded) <= MAX_RESULT_BYTES) break;
    }
  }
  if (outputBytes(decoded) > MAX_RESULT_BYTES) return outputLimitFailure(decoded);
  return decoded;
}

function normalizeInput(rawInput: unknown): CaptureReadInput {
  rawInput = omitNullOptionalFields(rawInput, OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new Error("Input must be an object");
  const unknown = Object.keys(rawInput).find((field) => !["saved_capture", ...OPTIONAL_FIELDS].includes(field));
  if (unknown !== undefined) throw new Error(`Unknown input field: ${unknown}`);
  if (!isRecord(rawInput.saved_capture)) throw new Error("saved_capture must be an object");
  if (rawInput.format !== undefined && rawInput.format !== "json" && rawInput.format !== "jsonl") throw new Error('format must be "json" or "jsonl"');
  return rawInput as CaptureReadInput;
}

function prepareArguments(rawInput: unknown): CaptureReadInput {
  return prepareInputArguments(rawInput, OPTIONAL_FIELDS, normalizeInput);
}

/** Create an unregistered read tool that decodes a saved process capture through the host's artifact grant resolver. */
export function createCaptureReadTool(options: ArtifactReadToolOptions): ToolDefinition<typeof parameters, CaptureReadDetails> {
  const artifactRead = createArtifactReadTool(options);
  return {
    name: "capture_read",
    label: "capture_read",
    description: "Decode a granted saved JSON or JSONL process capture with bounded row pages, projections, reductions, and gzip fields; never reruns the source query.",
    promptSnippet: "Read, project, or reduce a granted saved capture",
    exposure: "codemode",
    promptGuidelines: [
      "Pass the compact saved process-envelope checkpoint. Do not pass or parse its preview.",
      "Use format=jsonl for line-delimited JSON. Use jsonl_page to retrieve contiguous bounded records; continue at next_start_byte and inspect gaps.",
      "Select JSON Pointers from observed record fields; full-scan projections and reductions stay bounded.",
      "gzip_field reads only an observed JSON field from this saved document. It does not read another source or grant another path.",
      "Keep gzip expansion within max_decoded_bytes (at most 1 MiB); page with max_bytes (at most 16 KiB) and continue at the returned next_start_byte until eof.",
      "The tool reads only safe complete stdout_text or the host-granted stdout artifact. Check EOF, partial status, line errors, and provenance; do not rerun the source query.",
    ],
    parameters,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    prepareArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let result: CaptureReadDetails;
      try {
        result = await decodeCapture(params.saved_capture, params.format, params.selection, params.project, params.reduce, params.gzip_field, params.jsonl_page, artifactRead, signal, ctx);
      } catch (error) {
        result = {
          ok: false,
          tool: "capture_read",
          read_ok: false,
          status: { process: "unknown", capture: "unknown", decode: "not_attempted", producer: "unknown" },
          stage: "internal",
          decode_error: { code: "INTERNAL_ERROR", message: String(error) },
        };
      }
      const complete: CaptureReadDetails = { tool: "capture_read", ok: result["read_ok"] === true, ...result };
      const text = JSON.stringify(complete);
      if (utf8ByteLength(text) > MAX_RESULT_BYTES) {
        const bounded = { tool: "capture_read", ok: false, ...outputLimitFailure(result) };
        const boundedText = JSON.stringify(bounded);
        return { content: [{ type: "text", text: boundedText }], details: bounded, structuredContent: bounded as unknown as JsonValue, isError: true };
      }
      return {
        content: [{ type: "text", text }],
        details: complete,
        structuredContent: complete as unknown as JsonValue,
        isError: complete["read_ok"] !== true,
      };
    },
  };
}
