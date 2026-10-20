import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import { ReadToolError, readBytePage, type ByteEncoding, type ReadFileHandle } from "./read.ts";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_PROJECTION_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_ENTRIES = 8;
const MAX_JSON_ITEMS = 100_000;
const MAX_JSON_PAGE_ITEMS = 1_000;
const MAX_PAGE_BYTES = 40_960;
const MAX_BASE64_PAGE_BYTES = 30_720;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_RESOLUTION_ERROR_MESSAGE_BYTES = 512;
const MAX_READ_BYTES = 65_536;
const ARTIFACT_ID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const OPTIONAL_FIELDS = [
  "stream", "mode", "start_byte", "max_bytes", "encoding", "array_pointer", "object_pointer", "fields", "offset", "limit", "json_start_byte",
];

const parameters = Type.Object({
  artifact_id: Type.String({ pattern: ARTIFACT_ID_PATTERN, description: "UUID of an artifact granted by the host resolver" }),
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], { description: "Artifact stream (default stdout)" })),
  mode: Type.Optional(Type.Union([Type.Literal("bytes"), Type.Literal("json")], { description: "bytes (default) or json" })),
  start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Bytes route: zero-based byte offset (default 0)" })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_BYTES, description: "Bytes route: 1–40960 UTF-8 bytes or 1–30720 Base64 bytes; JSON route: encoded projected page or object bytes (runtime minimum 2)" })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { description: "Bytes route: utf8 (default) or base64" })),
  array_pointer: Type.Optional(Type.String({ maxLength: 4096, description: "JSON array projection: RFC 6901 pointer to the array (default root)" })),
  object_pointer: Type.Optional(Type.String({ maxLength: 4096, description: "JSON object projection: RFC 6901 pointer to one object; use '' for the root; mutually exclusive with array_pointer" })),
  fields: Type.Optional(Type.Record(
    Type.String({ minLength: 1, maxLength: 128 }),
    Type.String({ maxLength: 4096 }),
    { maxProperties: 64, description: "JSON route: output aliases mapped to RFC 6901 pointers relative to each selected array item or object" },
  )),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "JSON array route: zero-based projected row offset (default 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_JSON_PAGE_ITEMS, description: "JSON array route: rows per page (1–1000, default 100)" })),
  json_start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "JSON route: explicit byte offset where the JSON document starts (default 0)" })),
}, { additionalProperties: false });

const errorSchema = Type.Object({
  code: Type.String(),
  message: Type.String(),
  route: Type.Union([Type.Literal("bytes"), Type.Literal("json"), Type.Literal("input")]),
}, { additionalProperties: false });
const bytesPageSchema = Type.Object({
  encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]),
  total_bytes: Type.Integer({ minimum: 0 }),
  start_byte: Type.Integer({ minimum: 0 }),
  end_byte: Type.Integer({ minimum: 0 }),
  next_start_byte: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  has_more: Type.Boolean(),
}, { additionalProperties: false });
const jsonArrayPageSchema = Type.Object({
  offset: Type.Integer({ minimum: 0 }),
  next_offset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  has_more: Type.Boolean(),
  total_items: Type.Integer({ minimum: 0 }),
  source_bytes: Type.Integer({ minimum: 0 }),
  json_start_byte: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const jsonObjectPageSchema = Type.Object({
  source_bytes: Type.Integer({ minimum: 0 }),
  json_start_byte: Type.Integer({ minimum: 0 }),
  requested_fields: Type.Integer({ minimum: 1, maximum: 64 }),
  returned_fields: Type.Integer({ minimum: 0, maximum: 64 }),
  missing_fields: Type.Integer({ minimum: 0, maximum: 64 }),
  projection_complete: Type.Boolean(),
}, { additionalProperties: false });
const outputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    tool: Type.Literal("artifact_read"),
    data: Type.String(),
    page: bytesPageSchema,
    provenance: Type.Record(Type.String(), Type.Any()),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(true),
    tool: Type.Literal("artifact_read"),
    data: Type.Array(Type.Record(Type.String(), Type.Any())),
    page: jsonArrayPageSchema,
    provenance: Type.Record(Type.String(), Type.Any()),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(true),
    tool: Type.Literal("artifact_read"),
    data: Type.Record(Type.String(), Type.Any()),
    page: jsonObjectPageSchema,
    provenance: Type.Record(Type.String(), Type.Any()),
  }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(false),
    tool: Type.Literal("artifact_read"),
    error: errorSchema,
  }, { additionalProperties: false }),
]);

export type ArtifactReadInput = Static<typeof parameters>;
export type ArtifactReadRoute = "bytes" | "json" | "input";
export type ArtifactReadErrorCode =
  | "INVALID_INPUT"
  | "RESULT_BUDGET_TOO_SMALL"
  | "ARTIFACT_NOT_FOUND"
  | "NOT_READABLE"
  | "UNSUPPORTED_FILE_TYPE"
  | "RESOURCE_LIMIT"
  | "FILE_CHANGED"
  | "INVALID_ENCODING"
  | "INVALID_BYTE_BOUNDARY"
  | "BYTE_PAGE_TOO_SMALL"
  | "INVALID_POINTER"
  | "INVALID_JSON"
  | "ROW_TOO_LARGE"
  | "CANCELLED"
  | "INTERNAL_ERROR";
export type ArtifactProvenance = Record<string, unknown>;

export interface ArtifactResolution {
  path: string;
  provenance: ArtifactProvenance;
}

export type ArtifactResolutionErrorCode = "ARTIFACT_NOT_FOUND" | "UNSUPPORTED_FILE_TYPE" | "INVALID_INPUT";

export interface ArtifactResolutionErrorOptions {
  code?: ArtifactResolutionErrorCode;
  /** The supported route to report for an unsupported-mode failure. */
  route?: "bytes" | "json";
}

function boundedResolutionMessage(message: string): string {
  if (Buffer.byteLength(message) <= MAX_RESOLUTION_ERROR_MESSAGE_BYTES) return message;
  let bounded = "";
  let bytes = 0;
  for (const character of message) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > MAX_RESOLUTION_ERROR_MESSAGE_BYTES - 3) break;
    bounded += character;
    bytes += characterBytes;
  }
  return `${bounded}...`;
}

/** A safe, bounded resolver failure that the tool returns to the caller. */
export class ArtifactResolutionError extends Error {
  readonly code: ArtifactResolutionErrorCode;
  readonly route: "bytes" | "json" | undefined;

  constructor(message: string, options: ArtifactResolutionErrorOptions = {}) {
    super(boundedResolutionMessage(message));
    this.name = "ArtifactResolutionError";
    this.code = options.code ?? "ARTIFACT_NOT_FOUND";
    this.route = options.route;
  }
}

export interface ArtifactReadFileHandle extends ReadFileHandle {}

export interface ArtifactReadToolOptions {
  resolveArtifact(
    id: string,
    stream: "stdout" | "stderr",
    ctx: ExtensionContext,
  ): ArtifactResolution | Promise<ArtifactResolution>;
  /** Optional host file opener. The default opens a regular file for positioned reads. */
  openFile?: (path: string, flags: number) => Promise<ArtifactReadFileHandle>;
}

export interface ArtifactBytesPage {
  encoding: ByteEncoding;
  total_bytes: number;
  start_byte: number;
  end_byte: number;
  next_start_byte: number | null;
  has_more: boolean;
}

export interface ArtifactJsonArrayPage {
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  total_items: number;
  source_bytes: number;
  json_start_byte: number;
}

export interface ArtifactJsonObjectPage {
  source_bytes: number;
  json_start_byte: number;
  requested_fields: number;
  returned_fields: number;
  missing_fields: number;
  projection_complete: boolean;
}

export type ArtifactJsonPage = ArtifactJsonArrayPage | ArtifactJsonObjectPage;

export type ArtifactReadSuccess =
  | { ok: true; tool: "artifact_read"; data: string; page: ArtifactBytesPage; provenance: ArtifactProvenance }
  | { ok: true; tool: "artifact_read"; data: Record<string, unknown>[]; page: ArtifactJsonArrayPage; provenance: ArtifactProvenance }
  | { ok: true; tool: "artifact_read"; data: Record<string, unknown>; page: ArtifactJsonObjectPage; provenance: ArtifactProvenance };

export interface ArtifactReadFailure {
  ok: false;
  tool: "artifact_read";
  error: { code: ArtifactReadErrorCode; message: string; route: ArtifactReadRoute };
}

export type ArtifactReadToolDetails = ArtifactReadSuccess | ArtifactReadFailure;

interface NormalizedInput {
  artifactId: string;
  stream: "stdout" | "stderr";
  mode: "bytes" | "json";
  startByte?: number;
  maxBytes: number;
  encoding?: ByteEncoding;
  arrayPointer?: string;
  objectPointer?: string;
  fields?: Array<[string, string]>;
  offset?: number;
  limit?: number;
  jsonStartByte?: number;
}

interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface OpenArtifact {
  path: string;
  handle: ArtifactReadFileHandle;
  totalBytes: number;
  snapshot: FileSnapshot;
}

interface ArtifactReadExecution {
  result: ArtifactReadSuccess | ArtifactReadFailure;
  rawBytes?: Buffer;
}

interface CachedProjectionBase {
  key: string;
  snapshot: FileSnapshot;
  sourceBytes: number;
  jsonStartByte: number;
  weight: number;
}

type CachedProjection = CachedProjectionBase & (
  | { kind: "array"; rows: string[]; totalItems: number }
  | { kind: "object"; object: string; requestedFields: number; returnedFields: number }
);

const decoderOptions = { fatal: true, ignoreBOM: true } as const;

class ArtifactReadError extends Error {
  readonly code: ArtifactReadErrorCode;
  readonly route: ArtifactReadRoute;

  constructor(code: ArtifactReadErrorCode, message: string, route: ArtifactReadRoute) {
    super(message);
    this.code = code;
    this.route = route;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateInteger(value: unknown, name: string, minimum: number, maximum: number, route: ArtifactReadRoute): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ArtifactReadError("INVALID_INPUT", `${name} must be an integer from ${minimum} through ${maximum} on the ${route} route`, route);
  }
  return value as number;
}

function normalizeInput(rawInput: unknown): NormalizedInput {
  rawInput = omitNullOptionalFields(rawInput, OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new ArtifactReadError("INVALID_INPUT", "Input must be an object", "input");
  const allowed = new Set(["artifact_id", ...OPTIONAL_FIELDS]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new ArtifactReadError("INVALID_INPUT", `Unknown input field: ${unknown}`, "input");

  const mode = rawInput.mode === undefined ? "bytes" : rawInput.mode;
  if (mode !== "bytes" && mode !== "json") {
    throw new ArtifactReadError("INVALID_INPUT", "mode must be bytes or json; use the bytes or json route", "input");
  }
  const route = mode;
  if (typeof rawInput.artifact_id !== "string" || !new RegExp(ARTIFACT_ID_PATTERN).test(rawInput.artifact_id)) {
    throw new ArtifactReadError("INVALID_INPUT", "artifact_id must be a UUID", route);
  }
  const stream = rawInput.stream === undefined ? "stdout" : rawInput.stream;
  if (stream !== "stdout" && stream !== "stderr") {
    throw new ArtifactReadError("INVALID_INPUT", "stream must be stdout or stderr on the bytes or json route", route);
  }

  if (mode === "bytes") {
    const jsonField = ["array_pointer", "object_pointer", "fields", "offset", "limit", "json_start_byte"].find((field) => rawInput[field] !== undefined);
    if (jsonField !== undefined) {
      throw new ArtifactReadError("INVALID_INPUT", `${jsonField} is valid only on the json route`, "json");
    }
    const encoding = rawInput.encoding === undefined ? "utf8" : rawInput.encoding;
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new ArtifactReadError("INVALID_INPUT", "encoding must be utf8 or base64 on the bytes route", "bytes");
    }
    return {
      artifactId: rawInput.artifact_id,
      stream,
      mode,
      startByte: rawInput.start_byte === undefined ? 0 : validateInteger(rawInput.start_byte, "start_byte", 0, Number.MAX_SAFE_INTEGER, "bytes"),
      maxBytes: rawInput.max_bytes === undefined ? 16_384 : validateInteger(
        rawInput.max_bytes, "max_bytes", 1, encoding === "base64" ? MAX_BASE64_PAGE_BYTES : MAX_PAGE_BYTES, "bytes",
      ),
      encoding,
    };
  }

  const byteField = ["start_byte", "encoding"].find((field) => rawInput[field] !== undefined);
  if (byteField !== undefined) {
    throw new ArtifactReadError("INVALID_INPUT", `${byteField} is valid only on the bytes route`, "bytes");
  }
  if (typeof rawInput.array_pointer !== "undefined" && typeof rawInput.array_pointer !== "string") {
    throw new ArtifactReadError("INVALID_INPUT", "array_pointer must be a string on the json route", "json");
  }
  if (typeof rawInput.array_pointer === "string" && rawInput.array_pointer.length > 4096) {
    throw new ArtifactReadError("INVALID_INPUT", "array_pointer must not exceed 4096 characters on the json route", "json");
  }
  if (typeof rawInput.object_pointer !== "undefined" && typeof rawInput.object_pointer !== "string") {
    throw new ArtifactReadError("INVALID_INPUT", "object_pointer must be a string on the json route", "json");
  }
  if (typeof rawInput.object_pointer === "string" && rawInput.object_pointer.length > 4096) {
    throw new ArtifactReadError("INVALID_INPUT", "object_pointer must not exceed 4096 characters on the json route", "json");
  }
  if (rawInput.object_pointer !== undefined && rawInput.array_pointer !== undefined) {
    throw new ArtifactReadError("INVALID_INPUT", "object_pointer and array_pointer are mutually exclusive on the json route", "json");
  }
  if (rawInput.object_pointer !== undefined && (rawInput.offset !== undefined || rawInput.limit !== undefined)) {
    throw new ArtifactReadError("INVALID_INPUT", "offset and limit are valid only for JSON array projections", "json");
  }
  if (!isRecord(rawInput.fields)) {
    throw new ArtifactReadError("INVALID_INPUT", "fields must be a record of aliases to RFC 6901 pointers on the json route", "json");
  }
  const rawFieldEntries = Object.entries(rawInput.fields);
  if (rawFieldEntries.length === 0 || rawFieldEntries.length > 64) {
    throw new ArtifactReadError("INVALID_INPUT", "fields must contain 1 through 64 aliases on the json route", "json");
  }
  const fieldEntries: Array<[string, string]> = [];
  for (const [alias, pointer] of rawFieldEntries) {
    if (alias.length === 0 || alias.length > 128) {
      throw new ArtifactReadError("INVALID_INPUT", "field aliases must contain 1 through 128 characters on the json route", "json");
    }
    if (typeof pointer !== "string" || pointer.length > 4096) {
      throw new ArtifactReadError("INVALID_INPUT", `fields[${JSON.stringify(alias)}] must be a pointer string on the json route`, "json");
    }
    parsePointer(pointer, "json");
    fieldEntries.push([alias, pointer]);
  }
  const objectPointer = typeof rawInput.object_pointer === "string" ? rawInput.object_pointer : undefined;
  const arrayPointer = objectPointer === undefined
    ? rawInput.array_pointer === undefined ? "" : rawInput.array_pointer
    : undefined;
  parsePointer(objectPointer ?? arrayPointer!, "json");
  const maxBytes = rawInput.max_bytes === undefined ? 16_384 : validateInteger(rawInput.max_bytes, "max_bytes", 2, MAX_PAGE_BYTES, "json");
  return {
    artifactId: rawInput.artifact_id,
    stream,
    mode,
    maxBytes,
    ...(arrayPointer === undefined ? {} : { arrayPointer }),
    ...(objectPointer === undefined ? {} : { objectPointer }),
    fields: fieldEntries,
    offset: rawInput.offset === undefined ? 0 : validateInteger(rawInput.offset, "offset", 0, Number.MAX_SAFE_INTEGER, "json"),
    limit: rawInput.limit === undefined ? 100 : validateInteger(rawInput.limit, "limit", 1, MAX_JSON_PAGE_ITEMS, "json"),
    jsonStartByte: rawInput.json_start_byte === undefined
      ? 0
      : validateInteger(rawInput.json_start_byte, "json_start_byte", 0, Number.MAX_SAFE_INTEGER, "json"),
  };
}

function prepareArguments(rawInput: unknown): ArtifactReadInput {
  return prepareInputArguments(rawInput, OPTIONAL_FIELDS, normalizeInput);
}

function parsePointer(pointer: string, route: ArtifactReadRoute): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new ArtifactReadError("INVALID_POINTER", `JSON Pointer must be empty or start with / on the ${route} route`, route);
  }
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) {
      throw new ArtifactReadError("INVALID_POINTER", `JSON Pointer has an invalid escape on the ${route} route`, route);
    }
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function pointerValue(root: unknown, segments: string[]): unknown {
  let value = root;
  for (const segment of segments) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= value.length) return undefined;
      value = value[index];
    } else if (isRecord(value) && Object.hasOwn(value, segment)) {
      value = value[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function snapshotFrom(statResult: Awaited<ReturnType<ArtifactReadFileHandle["stat"]>>): FileSnapshot {
  return {
    dev: statResult.dev,
    ino: statResult.ino,
    size: statResult.size,
    mtimeNs: statResult.mtimeNs,
    ctimeNs: statResult.ctimeNs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function checkCancelled(signal: AbortSignal | undefined, route: ArtifactReadRoute): void {
  if (signal?.aborted) throw new ArtifactReadError("CANCELLED", "Artifact read was cancelled", route);
}

async function openArtifactFile(path: string, cwd: string, signal: AbortSignal | undefined, opener: NonNullable<ArtifactReadToolOptions["openFile"]>): Promise<OpenArtifact> {
  checkCancelled(signal, "input");
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new ArtifactReadError("ARTIFACT_NOT_FOUND", "The artifact is not available", "input");
  }
  const requestedPath = resolve(cwd, path);
  let fileHandle: ArtifactReadFileHandle | undefined;
  let opened = false;
  try {
    const pathStat = await stat(requestedPath);
    checkCancelled(signal, "input");
    if (!pathStat.isFile()) throw new ArtifactReadError("UNSUPPORTED_FILE_TYPE", "The artifact stream is not a regular file", "input");
    fileHandle = await opener(requestedPath, constants.O_RDONLY | constants.O_NONBLOCK);
    checkCancelled(signal, "input");
    const statResult = await fileHandle.stat({ bigint: true });
    checkCancelled(signal, "input");
    if (!statResult.isFile()) throw new ArtifactReadError("UNSUPPORTED_FILE_TYPE", "The artifact stream is not a regular file", "input");
    if (statResult.size < 0n || statResult.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ArtifactReadError("RESOURCE_LIMIT", "The artifact stream size is not a safe integer", "input");
    }
    if (statResult.size > BigInt(MAX_SOURCE_BYTES)) {
      throw new ArtifactReadError("RESOURCE_LIMIT", "Artifact reads are limited to 64 MiB of source data", "input");
    }
    opened = true;
    return {
      path: requestedPath,
      handle: fileHandle,
      totalBytes: Number(statResult.size),
      snapshot: snapshotFrom(statResult),
    };
  } catch (error) {
    checkCancelled(signal, "input");
    if (error instanceof ArtifactReadError) throw error;
    const errno = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (errno === "ENOENT" || errno === "ENOTDIR") throw new ArtifactReadError("ARTIFACT_NOT_FOUND", "The artifact stream is not available", "input");
    if (errno === "EACCES" || errno === "EPERM") throw new ArtifactReadError("NOT_READABLE", "The artifact stream is not readable", "input");
    if (errno === "EISDIR") throw new ArtifactReadError("UNSUPPORTED_FILE_TYPE", "The artifact stream is not a regular file", "input");
    throw new ArtifactReadError("INTERNAL_ERROR", "Cannot open the artifact stream", "input");
  } finally {
    if (fileHandle && !opened) await fileHandle.close();
  }
}

async function verifySnapshot(file: OpenArtifact, signal: AbortSignal | undefined, route: ArtifactReadRoute): Promise<void> {
  checkCancelled(signal, route);
  const current = await file.handle.stat({ bigint: true });
  checkCancelled(signal, route);
  if (!current.isFile() || !sameSnapshot(snapshotFrom(current), file.snapshot)) {
    throw new ArtifactReadError("FILE_CHANGED", "The artifact stream changed during the read", route);
  }
}

async function readAll(file: OpenArtifact, signal: AbortSignal | undefined): Promise<Buffer> {
  const data = Buffer.allocUnsafe(file.totalBytes);
  let offset = 0;
  while (offset < data.length) {
    checkCancelled(signal, "json");
    const length = Math.min(MAX_READ_BYTES, data.length - offset);
    let bytesRead: number;
    try {
      ({ bytesRead } = await file.handle.read(data, offset, length, offset));
    } catch (error) {
      checkCancelled(signal, "json");
      throw error;
    }
    checkCancelled(signal, "json");
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
      throw new ArtifactReadError("FILE_CHANGED", "The artifact stream changed during the read", "json");
    }
    offset += bytesRead;
  }
  return data;
}

async function readBase64Page(file: OpenArtifact, startByte: number, maxBytes: number, signal: AbortSignal | undefined): Promise<{ bytes: Buffer; startByte: number; endByte: number }> {
  const start = Math.min(startByte, file.totalBytes);
  const length = Math.min(maxBytes, file.totalBytes - start);
  const data = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < data.length) {
    checkCancelled(signal, "bytes");
    let bytesRead: number;
    try {
      ({ bytesRead } = await file.handle.read(data, offset, data.length - offset, start + offset));
    } catch (error) {
      checkCancelled(signal, "bytes");
      throw error;
    }
    checkCancelled(signal, "bytes");
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > data.length - offset) {
      throw new ArtifactReadError("FILE_CHANGED", "The artifact stream changed during the read", "bytes");
    }
    offset += bytesRead;
  }
  return { bytes: data, startByte: start, endByte: start + length };
}

function decodeJson(data: Buffer, jsonStartByte: number): unknown {
  try {
    const text = new TextDecoder("utf-8", decoderOptions).decode(data.subarray(jsonStartByte));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ArtifactReadError) throw error;
    const message = error instanceof SyntaxError ? "The selected bytes do not contain valid JSON" : "The selected bytes are not valid UTF-8 JSON";
    throw new ArtifactReadError(error instanceof SyntaxError ? "INVALID_JSON" : "INVALID_ENCODING", message, "json");
  }
}

function projectionCacheKey(input: NormalizedInput, path: string): string {
  return JSON.stringify([
    input.artifactId,
    input.stream,
    path,
    input.arrayPointer,
    input.objectPointer,
    input.fields,
    input.jsonStartByte,
  ]);
}

function projectRows(parsed: unknown, input: NormalizedInput, sourceBytes: number): CachedProjection {
  const route: ArtifactReadRoute = "json";
  const arraySegments = parsePointer(input.arrayPointer!, route);
  const selected = pointerValue(parsed, arraySegments);
  if (!Array.isArray(selected)) {
    throw new ArtifactReadError("INVALID_JSON", "array_pointer must select a JSON array on the json route", "json");
  }
  if (selected.length > MAX_JSON_ITEMS) {
    throw new ArtifactReadError("RESOURCE_LIMIT", `The JSON route is limited to ${MAX_JSON_ITEMS} array items`, "json");
  }
  const pointers = input.fields!.map(([alias, pointer]) => [alias, parsePointer(pointer, route)] as const);
  const rows: string[] = [];
  let projectionBytes = 2;
  let weight = 256;
  for (const item of selected) {
    const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [alias, segments] of pointers) {
      const value = pointerValue(item, segments);
      if (value !== undefined) row[alias] = value;
    }
    const encoded = JSON.stringify(row);
    if (typeof encoded !== "string") {
      throw new ArtifactReadError("INVALID_JSON", "A projected row cannot be represented as JSON", "json");
    }
    const rowBytes = Buffer.byteLength(encoded);
    projectionBytes += rowBytes + (rows.length === 0 ? 0 : 1);
    if (projectionBytes > MAX_JSON_PROJECTION_BYTES) {
      throw new ArtifactReadError("RESOURCE_LIMIT", "The JSON projection exceeds the 8-MiB limit", "json");
    }
    rows.push(encoded);
    weight += rowBytes * 2 + 64;
  }
  if (rows.length === 0) projectionBytes = 2;
  weight += Buffer.byteLength(input.artifactId) + Buffer.byteLength(input.arrayPointer!) + 256;
  return {
    key: "",
    snapshot: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n },
    kind: "array",
    rows,
    totalItems: selected.length,
    sourceBytes,
    jsonStartByte: input.jsonStartByte!,
    weight,
  };
}

function projectObject(parsed: unknown, input: NormalizedInput, sourceBytes: number): CachedProjection {
  const route: ArtifactReadRoute = "json";
  const objectSegments = parsePointer(input.objectPointer!, route);
  const selected = pointerValue(parsed, objectSegments);
  if (!isRecord(selected)) {
    throw new ArtifactReadError("INVALID_JSON", "object_pointer must select a JSON object on the json route", "json");
  }
  const pointers = input.fields!.map(([alias, pointer]) => [alias, parsePointer(pointer, route)] as const);
  const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [alias, segments] of pointers) {
    const value = pointerValue(selected, segments);
    if (value !== undefined) object[alias] = value;
  }
  const encoded = JSON.stringify(object);
  if (typeof encoded !== "string") {
    throw new ArtifactReadError("INVALID_JSON", "The projected object cannot be represented as JSON", "json");
  }
  const projectionBytes = Buffer.byteLength(encoded);
  if (projectionBytes > MAX_JSON_PROJECTION_BYTES) {
    throw new ArtifactReadError("RESOURCE_LIMIT", "The JSON projection exceeds the 8-MiB limit", "json");
  }
  const returnedFields = Object.keys(object).length;
  return {
    key: "",
    snapshot: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n },
    kind: "object",
    object: encoded,
    requestedFields: pointers.length,
    returnedFields,
    sourceBytes,
    jsonStartByte: input.jsonStartByte!,
    weight: projectionBytes * 2 + Buffer.byteLength(input.artifactId) + Buffer.byteLength(input.objectPointer!) + 256,
  };
}

function cacheGet(cache: Map<string, CachedProjection>, key: string): CachedProjection | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cachePut(cache: Map<string, CachedProjection>, projection: CachedProjection): void {
  if (projection.weight > MAX_CACHED_BYTES) return;
  const previous = cache.get(projection.key);
  if (previous) cache.delete(projection.key);
  cache.set(projection.key, projection);
  let totalWeight = 0;
  for (const value of cache.values()) totalWeight += value.weight;
  while (cache.size > MAX_CACHED_ENTRIES || totalWeight > MAX_CACHED_BYTES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    totalWeight -= oldest.weight;
  }
}

function jsonStringBytesWithin(value: string, maximum: number): number | undefined {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

function jsonEncodedBytesWithin(value: unknown, maximum: number): number | undefined {
  let bytes = 0;
  const active = new Set<object>();
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= maximum;
  };
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > 512) return false;
    if (current === null) return add(4);
    if (typeof current === "string") {
      const length = jsonStringBytesWithin(current, maximum - bytes);
      return length !== undefined && add(length);
    }
    if (typeof current === "number") {
      const encoded = JSON.stringify(current);
      return encoded !== undefined && add(Buffer.byteLength(encoded));
    }
    if (typeof current === "boolean") return add(current ? 4 : 5);
    if (typeof current !== "object") return false;
    if (active.has(current)) return false;
    active.add(current);
    let valid = true;
    if (Array.isArray(current)) {
      valid = add(2);
      for (let index = 0; valid && index < current.length; index += 1) {
        if (index > 0) valid = add(1);
        const item = current[index];
        valid = valid && (item === undefined || typeof item === "function" || typeof item === "symbol"
          ? add(4)
          : visit(item, depth + 1));
      }
    } else if (isRecord(current)) {
      const prototype = Object.getPrototypeOf(current);
      valid = (prototype === Object.prototype || prototype === null) && typeof current.toJSON !== "function" && add(1);
      let count = 0;
      for (const key in current) {
        if (!valid) break;
        if (!Object.hasOwn(current, key)) continue;
        const item = current[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        if (count > 0) valid = add(1);
        const keyBytes = jsonStringBytesWithin(key, maximum - bytes);
        valid = valid && keyBytes !== undefined && add(keyBytes) && add(1) && visit(item, depth + 1);
        count += 1;
      }
      if (valid) valid = add(1);
    } else {
      valid = false;
    }
    active.delete(current);
    return valid;
  };
  try {
    return visit(value, 0) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function jsonObjectPage(
  projection: Extract<CachedProjection, { kind: "object" }>,
  input: NormalizedInput,
  provenance: ArtifactProvenance,
): ArtifactReadSuccess {
  const page: ArtifactJsonObjectPage = {
    source_bytes: projection.sourceBytes,
    json_start_byte: projection.jsonStartByte,
    requested_fields: projection.requestedFields,
    returned_fields: projection.returnedFields,
    missing_fields: projection.requestedFields - projection.returnedFields,
    projection_complete: projection.requestedFields === projection.returnedFields,
  };
  const emptyEnvelope: ArtifactReadSuccess = { ok: true, tool: "artifact_read", data: {}, page, provenance };
  const metadataBytes = jsonEncodedBytesWithin(emptyEnvelope, MAX_RESULT_BYTES);
  if (metadataBytes === undefined) {
    throw new ArtifactReadError(
      "RESULT_BUDGET_TOO_SMALL", "Provenance and projection metadata exceed the 48-KiB result limit", "json",
    );
  }
  const objectBytes = Buffer.byteLength(projection.object);
  if (objectBytes > input.maxBytes || metadataBytes - 2 + objectBytes > MAX_RESULT_BYTES) {
    throw new ArtifactReadError(
      "ROW_TOO_LARGE", "The complete projected object does not fit max_bytes or the 48-KiB result budget on the json route", "json",
    );
  }
  return { ok: true, tool: "artifact_read", data: JSON.parse(projection.object) as Record<string, unknown>, page, provenance };
}

function jsonPage(
  projection: CachedProjection,
  input: NormalizedInput,
  provenance: ArtifactProvenance,
): ArtifactReadSuccess {
  if (projection.kind === "object") return jsonObjectPage(projection, input, provenance);
  const offset = input.offset!;
  const limit = input.limit!;
  const end = Math.min(projection.totalItems, offset + limit);
  const page: ArtifactJsonArrayPage = {
    offset,
    next_offset: null,
    has_more: false,
    total_items: projection.totalItems,
    source_bytes: projection.sourceBytes,
    json_start_byte: projection.jsonStartByte,
  };
  const emptyEnvelope: ArtifactReadSuccess = { ok: true, tool: "artifact_read", data: [], page, provenance };
  const metadataBytes = jsonEncodedBytesWithin(emptyEnvelope, MAX_RESULT_BYTES);
  if (metadataBytes === undefined) {
    throw new ArtifactReadError(
      "RESULT_BUDGET_TOO_SMALL", "Provenance and page metadata exceed the 48-KiB result limit", "json",
    );
  }
  const resultDataBudget = MAX_RESULT_BYTES - metadataBytes + 2;
  const dataBudget = Math.min(input.maxBytes, resultDataBudget);
  const selectedRows: string[] = [];
  let encodedBytes = 2;
  for (let index = offset; index < end; index += 1) {
    const row = projection.rows[index]!;
    const rowBytes = Buffer.byteLength(row);
    const candidateBytes = encodedBytes + rowBytes + (selectedRows.length === 0 ? 0 : 1);
    if (candidateBytes > dataBudget) {
      if (selectedRows.length === 0) {
        throw new ArtifactReadError(
          "ROW_TOO_LARGE", "The next complete row does not fit max_bytes or the 48-KiB result budget on the json route", "json",
        );
      }
      break;
    }
    selectedRows.push(row);
    encodedBytes = candidateBytes;
  }
  const rows = selectedRows.map((row) => JSON.parse(row) as Record<string, unknown>);
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < projection.totalItems;
  page.next_offset = hasMore ? nextOffset : null;
  page.has_more = hasMore;
  return { ok: true, tool: "artifact_read", data: rows, page, provenance };
}

function failure(code: ArtifactReadErrorCode, message: string, route: ArtifactReadRoute): ArtifactReadFailure {
  return { ok: false, tool: "artifact_read", error: { code, message, route } };
}

function errorResult(error: unknown, fallbackRoute: ArtifactReadRoute): ArtifactReadFailure {
  if (error instanceof ArtifactReadError) return failure(error.code, error.message, error.route);
  if (error instanceof ReadToolError) {
    const code: ArtifactReadErrorCode = error.code === "NOT_FOUND" ? "ARTIFACT_NOT_FOUND"
      : error.code === "NOT_READABLE" || error.code === "UNSUPPORTED_FILE_TYPE" || error.code === "RESOURCE_LIMIT"
        || error.code === "FILE_CHANGED" || error.code === "INVALID_ENCODING" || error.code === "INVALID_BYTE_BOUNDARY"
        || error.code === "BYTE_PAGE_TOO_SMALL" || error.code === "CANCELLED" || error.code === "INVALID_INPUT"
        || error.code === "INTERNAL_ERROR"
        ? error.code
        : "INTERNAL_ERROR";
    return failure(code, error.message, fallbackRoute);
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return failure("ARTIFACT_NOT_FOUND", "The artifact stream is not available", fallbackRoute);
    if (code === "EACCES" || code === "EPERM") return failure("NOT_READABLE", "The artifact stream is not readable", fallbackRoute);
  }
  return failure("INTERNAL_ERROR", "The artifact read failed", fallbackRoute);
}

async function executeRead(
  rawInput: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  options: ArtifactReadToolOptions,
  cache: Map<string, CachedProjection>,
): Promise<ArtifactReadExecution> {
  let input: NormalizedInput;
  try {
    input = normalizeInput(rawInput);
  } catch (error) {
    return { result: errorResult(error, "input") };
  }
  if (signal?.aborted) return { result: failure("CANCELLED", "Artifact read was cancelled", input.mode) };
  let resolution: ArtifactResolution;
  try {
    resolution = await options.resolveArtifact(input.artifactId, input.stream, ctx);
  } catch (error) {
    if (signal?.aborted) return { result: failure("CANCELLED", "Artifact read was cancelled", input.mode) };
    if (error instanceof ArtifactResolutionError) return { result: failure(error.code, error.message, error.route ?? input.mode) };
    return { result: failure("INTERNAL_ERROR", "The artifact resolver failed", input.mode) };
  }
  if (signal?.aborted) return { result: failure("CANCELLED", "Artifact read was cancelled", input.mode) };
  if (!isRecord(resolution) || typeof resolution.path !== "string" || !isRecord(resolution.provenance)) {
    return { result: failure("ARTIFACT_NOT_FOUND", "The artifact is not available for this stream", input.mode) };
  }

  let file: OpenArtifact;
  try {
    file = await openArtifactFile(resolution.path, ctx.cwd, signal, options.openFile ?? open);
  } catch (error) {
    const result = errorResult(error, input.mode);
    return { result: { ...result, error: { ...result.error, route: input.mode } } };
  }
  try {
    if (input.mode === "bytes") {
      let data: string;
      let rawBytes: Buffer;
      let startByte: number;
      let endByte: number;
      if (input.encoding === "base64") {
        const page = await readBase64Page(file, input.startByte!, input.maxBytes, signal);
        rawBytes = page.bytes;
        data = rawBytes.toString("base64");
        startByte = page.startByte;
        endByte = page.endByte;
      } else {
        const page = await readBytePage(file.handle, {
          totalBytes: file.totalBytes,
          startByte: input.startByte!,
          maxBytes: input.maxBytes,
          encoding: "utf8",
          path: file.path,
          signal,
          includeBytes: true,
        });
        data = page.content;
        rawBytes = page.bytes!;
        startByte = page.start_byte;
        endByte = page.end_byte;
      }
      await verifySnapshot(file, signal, "bytes");
      const hasMore = endByte < file.totalBytes;
      return {
        result: {
          ok: true,
          tool: "artifact_read",
          data,
          page: {
            encoding: input.encoding!,
            total_bytes: file.totalBytes,
            start_byte: startByte,
            end_byte: endByte,
            next_start_byte: hasMore ? endByte : null,
            has_more: hasMore,
          },
          provenance: resolution.provenance,
        },
        rawBytes,
      };
    }

    const key = projectionCacheKey(input, file.path);
    let projection = cacheGet(cache, key);
    if (projection && !sameSnapshot(projection.snapshot, file.snapshot)) {
      cache.delete(key);
      throw new ArtifactReadError("FILE_CHANGED", "The artifact stream changed since the JSON projection was cached", "json");
    }
    if (!projection) {
      const jsonStartByte = input.jsonStartByte!;
      if (jsonStartByte > file.totalBytes) {
        throw new ArtifactReadError("INVALID_INPUT", "json_start_byte must not exceed source_bytes on the json route", "json");
      }
      const bytes = await readAll(file, signal);
      const parsed = decodeJson(bytes, jsonStartByte);
      projection = input.objectPointer === undefined
        ? projectRows(parsed, input, file.totalBytes)
        : projectObject(parsed, input, file.totalBytes);
      projection.key = key;
      projection.snapshot = file.snapshot;
      await verifySnapshot(file, signal, "json");
      cachePut(cache, projection);
    }
    const result = jsonPage(projection, input, resolution.provenance);
    await verifySnapshot(file, signal, "json");
    return { result };
  } catch (error) {
    const route = input.mode;
    return { result: errorResult(error, route) };
  } finally {
    await file.handle.close();
  }
}

function bytePage(
  encoding: ByteEncoding,
  startByte: number,
  endByte: number,
  totalBytes: number,
): ArtifactBytesPage {
  const hasMore = endByte < totalBytes;
  return {
    encoding,
    total_bytes: totalBytes,
    start_byte: startByte,
    end_byte: endByte,
    next_start_byte: hasMore ? endByte : null,
    has_more: hasMore,
  };
}

function shrinkByteResult(result: ArtifactReadSuccess, rawBytes: Buffer): ArtifactReadSuccess | ArtifactReadFailure {
  if (typeof result.data !== "string") return result;
  const originalPage = result.page as ArtifactBytesPage;
  const encoding = originalPage.encoding;
  const startByte = originalPage.start_byte;
  const totalBytes = originalPage.total_bytes;
  const skeleton: ArtifactReadSuccess = {
    ...result,
    data: "",
    page: {} as ArtifactBytesPage,
  };
  const fixedBytes = jsonEncodedBytesWithin(skeleton, MAX_RESULT_BYTES + 512);
  if (fixedBytes === undefined) {
    return failure("RESULT_BUDGET_TOO_SMALL", "Provenance and page metadata exceed the 48-KiB result limit", "bytes");
  }

  let bestByteCount = -1;
  const consider = (byteCount: number, dataStringBytes: number): void => {
    const page = bytePage(encoding, startByte, startByte + byteCount, totalBytes);
    const pageBytes = jsonEncodedBytesWithin(page, 512);
    if (pageBytes === undefined) return;
    const envelopeBytes = fixedBytes - 4 + pageBytes + dataStringBytes;
    if (envelopeBytes <= MAX_RESULT_BYTES) bestByteCount = byteCount;
  };

  if (encoding === "base64") {
    for (let byteCount = 0; byteCount <= rawBytes.length; byteCount += 1) {
      consider(byteCount, 2 + Math.ceil(byteCount / 3) * 4);
    }
  } else {
    const characters = Array.from(result.data);
    let rawByteCount = 0;
    let dataStringBytes = 2;
    consider(0, dataStringBytes);
    for (const character of characters) {
      rawByteCount += Buffer.byteLength(character);
      const characterBytes = jsonStringBytesWithin(character, MAX_RESULT_BYTES);
      if (characterBytes === undefined || rawByteCount > rawBytes.length) {
        return failure("INTERNAL_ERROR", "Cannot map the UTF-8 page to source byte boundaries", "bytes");
      }
      dataStringBytes += characterBytes - 2;
      consider(rawByteCount, dataStringBytes);
    }
    if (rawByteCount !== rawBytes.length) {
      return failure("INTERNAL_ERROR", "Cannot map the UTF-8 page to source byte boundaries", "bytes");
    }
    if (bestByteCount > 0 || rawBytes.length === 0) {
      const data = new TextDecoder("utf-8", decoderOptions).decode(rawBytes.subarray(0, bestByteCount));
      const endByte = startByte + bestByteCount;
      return { ...result, data, page: bytePage(encoding, startByte, endByte, totalBytes) };
    }
    return failure(
      "RESULT_BUDGET_TOO_SMALL", "Provenance and metadata leave no room for the next complete UTF-8 code point", "bytes",
    );
  }

  if (bestByteCount < 0 || (rawBytes.length > 0 && bestByteCount === 0)) {
    return failure("RESULT_BUDGET_TOO_SMALL", "Provenance and metadata leave no room for the next complete byte", "bytes");
  }
  const data = rawBytes.subarray(0, bestByteCount).toString("base64");
  const endByte = startByte + bestByteCount;
  return { ...result, data, page: bytePage(encoding, startByte, endByte, totalBytes) };
}

function boundedOutput(execution: ArtifactReadExecution): { result: ArtifactReadSuccess | ArtifactReadFailure; text: string } {
  let result = execution.result;
  const encode = (candidate: ArtifactReadSuccess | ArtifactReadFailure): string | undefined => {
    if (jsonEncodedBytesWithin(candidate, MAX_RESULT_BYTES) === undefined) return undefined;
    const text = JSON.stringify(candidate);
    return Buffer.byteLength(text) <= MAX_RESULT_BYTES ? text : undefined;
  };
  let text = encode(result);
  if (text === undefined && result.ok && typeof result.data === "string" && execution.rawBytes !== undefined) {
    result = shrinkByteResult(result, execution.rawBytes);
    text = encode(result);
  }
  if (text !== undefined) return { result, text };

  const route = result.ok ? typeof result.data === "string" ? "bytes" : "json" : result.error.route;
  let message = "The structured result exceeds the 48-KiB result limit";
  if (result.ok) {
    const emptyResult = { ...result, data: typeof result.data === "string" ? "" : Array.isArray(result.data) ? [] : {} } as ArtifactReadSuccess;
    if (jsonEncodedBytesWithin(emptyResult, MAX_RESULT_BYTES) === undefined) {
      message = "Provenance and page metadata exceed the 48-KiB result limit";
    }
  }
  const bounded = failure("RESULT_BUDGET_TOO_SMALL", message, route);
  return { result: bounded, text: JSON.stringify(bounded) };
}

export function createArtifactReadTool(options: ArtifactReadToolOptions): ToolDefinition<typeof parameters, ArtifactReadToolDetails> {
  const cache = new Map<string, CachedProjection>();
  return {
    name: "artifact_read",
    label: "artifact_read",
    description: "Read a resolver-granted artifact stream as structured byte pages, bounded JSON array pages, or a bounded JSON object field projection.",
    promptSnippet: "Read granted artifact streams as bounded structured pages",
    promptGuidelines: [
      "Use bytes mode for exact stream bytes; use Base64 for binary data.",
      "Use JSON mode with explicit field projections: array_pointer selects paged rows; object_pointer selects one object and returns one bounded projection. Set json_start_byte only when the JSON document starts after a known byte prefix.",
      "Keep provenance with projection metadata: array counts describe the saved JSON array; object projection completeness describes only requested fields, not whether capture was complete.",
    ],
    parameters,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    prepareArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const output = boundedOutput(await executeRead(params, ctx, signal, options, cache));
      return {
        content: [{ type: "text", text: output.text }],
        details: output.result,
        structuredContent: output.result as unknown as JsonValue,
        isError: output.result.ok === false,
      };
    },
  };
}
