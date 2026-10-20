import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";

export const COMPLETED_CALL_REFERENCES_DETAILS_KEY = "completed_call_references";
export const DEFAULT_COMPLETED_CALL_REFERENCE_LIMITS = {
  maxConcurrentParents: 8,
  maxCallsPerParent: 32,
  maxReferenceJsonBytes: 12 * 1024,
  maxPerReferenceJsonBytes: 1024,
} as const;

const MAX_CONCURRENT_PARENTS = 32;
const MAX_CALLS_PER_PARENT = 128;
const MAX_REFERENCE_JSON_BYTES = 32 * 1024;
const MAX_PER_REFERENCE_JSON_BYTES = 8 * 1024;
const MAX_PARENT_ID_CHARS = 256;
const MAX_CALL_ID_CHARS = 256;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_OBSERVED_AT_CHARS = 64;
const MAX_PROJECTION_DEPTH = 12;
const MAX_PROJECTION_NODES = 256;
const APPENDIX_PREFIX = "\n\nCompleted nested-call references (JSON):\n";
export const COMPLETED_CALL_REFERENCE_APPENDIX_MAX_BYTES = MAX_REFERENCE_JSON_BYTES + 64;

export interface CompletedCallReference {
  tool_call_id: string;
  tool: string;
  is_error: boolean;
  observed_at: string;
  reference?: JsonValue;
  metadata_truncated?: true;
}

export interface CompletedCallReferenceIndex {
  version: 1;
  tool_call_id: string;
  tool: "codemode";
  is_error: true;
  observed_at: string;
  completed_observed_count: number;
  omitted_call_count: number;
  reference_omitted_count: number;
  projection_error_count: number;
  truncated: boolean;
  calls: CompletedCallReference[];
}

export interface CompletedCallReferenceLimits {
  maxConcurrentParents: number;
  maxCallsPerParent: number;
  maxReferenceJsonBytes: number;
  maxPerReferenceJsonBytes: number;
}

export interface CompletedCallReferenceOptions {
  /** Synchronously return host-approved JSON metadata. The default keeps call IDs and statuses only. */
  projectResult?: (event: ToolResultEvent, ctx: ExtensionContext) => JsonValue | undefined;
  /** Return an ISO timestamp or another short observation time. */
  now?: () => string;
  limits?: Partial<CompletedCallReferenceLimits>;
}

export interface CompletedCallReferenceTracker {
  /** Discard all open buffers. */
  reset(): void;
}

interface ParentBuffer {
  readonly toolCallId: string;
  readonly calls: CompletedCallReference[];
  completedObservedCount: number;
  referenceOmittedCount: number;
  projectionErrorCount: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, maxChars: number): { text: string; truncated: boolean } {
  let end = Math.min(value.length, maxChars);
  if (end < value.length && end > 0) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return { text: value.slice(0, end), truncated: end < value.length };
}

function observationTime(now: (() => string) | undefined): { text: string; truncated: boolean } {
  let value: unknown;
  try {
    value = now ? now() : new Date().toISOString();
  } catch {
    value = new Date().toISOString();
  }
  const original = typeof value === "string" ? value : new Date().toISOString();
  const safe = original.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  const bounded = boundedText(safe, MAX_OBSERVED_AT_CHARS);
  return { text: bounded.text, truncated: bounded.truncated || safe !== original };
}

function cloneBoundedJson(value: unknown, maxBytes: number): JsonValue | undefined {
  const ancestors = new Set<object>();
  let sourceBytes = 0;
  let nodes = 0;

  const clone = (item: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_PROJECTION_NODES || depth > MAX_PROJECTION_DEPTH) throw new RangeError("Reference exceeds its JSON bounds");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Reference is not JSON data");
      return item;
    }
    if (typeof item === "string") {
      sourceBytes += Buffer.byteLength(item, "utf8");
      if (sourceBytes > maxBytes) throw new RangeError("Reference exceeds its JSON bounds");
      return item;
    }
    if (typeof item !== "object") throw new TypeError("Reference is not JSON data");
    if (ancestors.has(item)) throw new TypeError("Reference contains a cycle");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > MAX_PROJECTION_NODES - nodes) throw new RangeError("Reference exceeds its JSON bounds");
        const result: JsonValue[] = [];
        for (let index = 0; index < item.length; index += 1) {
          result.push(index in item ? clone(item[index], depth + 1) : null);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Reference is not a plain JSON object");
      const result: Record<string, JsonValue> = {};
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        sourceBytes += Buffer.byteLength(key, "utf8");
        if (sourceBytes > maxBytes) throw new RangeError("Reference exceeds its JSON bounds");
        Object.defineProperty(result, key, {
          value: clone((item as Record<string, unknown>)[key], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };

  try {
    const safe = clone(value, 0);
    const json = JSON.stringify(safe);
    if (typeof json !== "string") return undefined;
    const jsonBytes = Buffer.byteLength(json, "utf8");
    return jsonBytes <= maxBytes ? safe : undefined;
  } catch {
    return undefined;
  }
}

function validateLimits(limits: Partial<CompletedCallReferenceLimits> | undefined): CompletedCallReferenceLimits {
  const result = { ...DEFAULT_COMPLETED_CALL_REFERENCE_LIMITS, ...limits };
  const caps: [keyof CompletedCallReferenceLimits, number][] = [
    ["maxConcurrentParents", MAX_CONCURRENT_PARENTS],
    ["maxCallsPerParent", MAX_CALLS_PER_PARENT],
    ["maxReferenceJsonBytes", MAX_REFERENCE_JSON_BYTES],
    ["maxPerReferenceJsonBytes", MAX_PER_REFERENCE_JSON_BYTES],
  ];
  for (const [name, maximum] of caps) {
    const value = result[name];
    const minimum = name === "maxReferenceJsonBytes" ? 1024 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
  }
  return result;
}

function indexFor(
  parent: ParentBuffer,
  calls: CompletedCallReference[],
  timestamp: string,
  truncated: boolean,
): CompletedCallReferenceIndex {
  return {
    version: 1,
    tool_call_id: parent.toolCallId,
    tool: "codemode",
    is_error: true,
    observed_at: timestamp,
    completed_observed_count: parent.completedObservedCount,
    omitted_call_count: Math.max(0, parent.completedObservedCount - calls.length),
    reference_omitted_count: parent.referenceOmittedCount,
    projection_error_count: parent.projectionErrorCount,
    truncated,
    calls: calls.map((call) => ({ ...call })),
  };
}

/** Observe nested call results. Host code supplies any safe reference data through projectResult. */
export function registerCompletedCallReferences(
  pi: Pick<ExtensionAPI, "on">,
  options: CompletedCallReferenceOptions = {},
): CompletedCallReferenceTracker {
  const limits = validateLimits(options.limits);
  const openParents = new Map<string, ParentBuffer>();
  const reset = (): void => openParents.clear();
  const findParent = (nestedToolCallId: string): ParentBuffer | undefined => {
    let match: ParentBuffer | undefined;
    for (const parent of openParents.values()) {
      if (nestedToolCallId.startsWith(`${parent.toolCallId}/`)
        && (!match || parent.toolCallId.length > match.toolCallId.length)) match = parent;
    }
    return match;
  };
  const serializeIndex = (parent: ParentBuffer, calls: CompletedCallReference[], timestamp: string, reserveTruncation = false) => {
    const truncated = parent.truncated || calls.length < parent.completedObservedCount;
    const index = indexFor(parent, calls, timestamp, reserveTruncation || truncated);
    const json = JSON.stringify(index);
    return { index, json, bytes: Buffer.byteLength(json, "utf8") };
  };
  const referenceFits = (parent: ParentBuffer, calls: CompletedCallReference[], timestamp: string): boolean =>
    serializeIndex(parent, calls, timestamp, true).bytes <= limits.maxReferenceJsonBytes;

  const observeNestedResult = (parent: ParentBuffer, event: ToolResultEvent, ctx: ExtensionContext): void => {
    if (parent.completedObservedCount < Number.MAX_SAFE_INTEGER) parent.completedObservedCount += 1;
    else parent.truncated = true;
    if (parent.calls.length >= limits.maxCallsPerParent) {
      parent.truncated = true;
      return;
    }

    const id = boundedText(event.toolCallId, MAX_CALL_ID_CHARS);
    const tool = boundedText(event.toolName, MAX_TOOL_NAME_CHARS);
    const time = observationTime(options.now);
    const entry: CompletedCallReference = {
      tool_call_id: id.text,
      tool: tool.text,
      is_error: event.isError,
      observed_at: time.text,
      ...(id.truncated || tool.truncated || time.truncated ? { metadata_truncated: true as const } : {}),
    };
    if (id.truncated || tool.truncated || time.truncated) parent.truncated = true;
    if (!referenceFits(parent, [...parent.calls, entry], time.text)) {
      parent.truncated = true;
      return;
    }
    parent.calls.push(entry);

    if (!options.projectResult) return;
    let projected: unknown;
    try {
      projected = options.projectResult(event, ctx);
    } catch {
      parent.projectionErrorCount += 1;
      parent.referenceOmittedCount += 1;
      parent.truncated = true;
      return;
    }
    if (projected === undefined) return;
    const bounded = cloneBoundedJson(projected, limits.maxPerReferenceJsonBytes);
    if (bounded === undefined) {
      parent.referenceOmittedCount += 1;
      parent.truncated = true;
      return;
    }
    entry.reference = bounded;
    if (!referenceFits(parent, parent.calls, time.text)) {
      delete entry.reference;
      parent.referenceOmittedCount += 1;
      parent.truncated = true;
    }
  };

  const finishParent = (event: ToolResultEvent): { content: ToolResultEvent["content"]; details: unknown } | undefined => {
    const parent = openParents.get(event.toolCallId);
    if (!parent) return undefined;
    openParents.delete(parent.toolCallId);
    if (!event.isError) return undefined;

    const timestamp = observationTime(options.now);
    if (timestamp.truncated) parent.truncated = true;
    let calls = parent.calls;
    let serialized = serializeIndex(parent, calls, timestamp.text);
    while (serialized.bytes > limits.maxReferenceJsonBytes && calls.length > 0) {
      calls = calls.slice(0, -1);
      parent.truncated = true;
      serialized = serializeIndex(parent, calls, timestamp.text);
    }
    const index = serialized.index;
    const appendix = `${APPENDIX_PREFIX}${serialized.json}`;
    if (Buffer.byteLength(appendix, "utf8") > COMPLETED_CALL_REFERENCE_APPENDIX_MAX_BYTES) return undefined;
    const priorDetails = event.details;
    const details = isRecord(priorDetails)
      ? { ...priorDetails, [COMPLETED_CALL_REFERENCES_DETAILS_KEY]: index }
      : {
        ...(priorDetails === undefined ? {} : { original_details: priorDetails }),
        [COMPLETED_CALL_REFERENCES_DETAILS_KEY]: index,
      };
    return {
      content: [...event.content, { type: "text", text: appendix }],
      details,
    };
  };

  pi.on("tool_call", (event) => {
    if (event.toolName !== "codemode" || event.toolCallId.length === 0
      || event.toolCallId.length > MAX_PARENT_ID_CHARS || Buffer.byteLength(event.toolCallId, "utf8") > 128
      || /[\u0000-\u001f\u007f-\u009f]/u.test(event.toolCallId)
      || openParents.size >= limits.maxConcurrentParents) return;
    openParents.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      calls: [],
      completedObservedCount: 0,
      referenceOmittedCount: 0,
      projectionErrorCount: 0,
      truncated: false,
    });
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "codemode") {
      const parent = findParent(event.toolCallId);
      if (parent) observeNestedResult(parent, event, ctx);
      return finishParent(event);
    }
    const parent = findParent(event.toolCallId);
    if (parent) observeNestedResult(parent, event, ctx);
    return undefined;
  });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  return { reset };
}
