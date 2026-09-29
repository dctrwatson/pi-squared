import { writeFile } from "node:fs/promises";
import {
  createProcessArtifact, removeProcessArtifact, writeProcessArtifactMetadata,
  pinProcessArtifact, unpinProcessArtifact, type ProcessArtifact,
} from "./process-artifacts.ts";

export const WEB_ARTIFACT_LIMIT = 2_097_152;
export class WebArtifactLimitError extends Error {}
export interface WebTextArtifactDetails {
  path: string;
  metadata_path: string;
  format: "text";
  capture: "complete";
  captured_bytes: number;
  captured_lines: number;
  expires_at: number;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function textLines(text: string): number {
  let count = text.length ? 1 : 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}
export function utf8Prefix(text: string, bytes: number): string {
  let used = 0;
  let end = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (used + size > bytes) break;
    used += size;
    end += point.length;
  }
  return text.slice(0, end);
}
export function linePrefix(text: string, lines: number): string {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++count > lines) return text.slice(0, i);
  }
  return text;
}
export function boundedJoin(parts: Iterable<string>, limit: number, overflow: () => Error): string {
  let bytes = 0;
  const bounded: string[] = [];
  for (const part of parts) {
    bytes += Buffer.byteLength(part);
    if (bytes > limit) throw overflow();
    bounded.push(part);
  }
  return bounded.join("");
}

// Count JSON tokens before serialization. Do not call accessors or toJSON.
export function jsonBytes(value: unknown, limit: number): number {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (size: number) => {
    bytes += size;
    if (bytes > limit) throw new RangeError("Serialized JSON exceeds the byte limit");
  };
  const quoted = (text: string) => {
    add(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code < 32) add(6);
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
      else if (code >= 0xd800 && code <= 0xdfff) add(6);
      else add(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  };
  const visit = (entry: unknown): void => {
    if (entry === null) { add(4); return; }
    if (typeof entry === "string") { quoted(entry); return; }
    if (typeof entry === "boolean") { add(entry ? 4 : 5); return; }
    if (typeof entry === "number" && Number.isFinite(entry)) { add(String(entry).length); return; }
    if (typeof entry !== "object" || !entry) throw new TypeError("Not JSON data");
    if (ancestors.has(entry)) throw new TypeError("Cyclic JSON data");
    const array = Array.isArray(entry);
    if (!array && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw new TypeError("Not a plain record");
    const conversion = Object.getOwnPropertyDescriptor(entry, "toJSON");
    if (conversion && (!("value" in conversion) || typeof conversion.value === "function")) throw new TypeError("Custom JSON conversion is not allowed");
    ancestors.add(entry);
    add(2);
    let first = true;
    const child = (key: string, omitKey: boolean) => {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Not a JSON value");
      if (!first) add(1);
      first = false;
      if (!omitKey) { quoted(key); add(1); }
      visit(descriptor.value);
    };
    if (array) for (let i = 0; i < entry.length; i++) child(String(i), true);
    else for (const key in entry) if (Object.hasOwn(entry, key)) child(key, false);
    ancestors.delete(entry);
  };
  visit(value);
  return bytes;
}
export function errorMessage(error: unknown): string {
  return utf8Prefix(error instanceof Error ? error.message : String(error), 4096);
}
export function errorText(tool: string, code: string, message: string): string {
  const prefix = `[${tool} error: ${code}; `;
  let display = "";
  let bytes = Buffer.byteLength(prefix) + 1;
  for (const point of message) {
    const codePoint = point.codePointAt(0)!;
    const escaped = point === "\n" ? "\\n" : point === "\r" ? "\\r" : point === "\t" ? "\\t"
      : point === "[" || point === "]" ? `\\${point}`
      : codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? `\\u${codePoint.toString(16).padStart(4, "0")}` : point;
    const size = Buffer.byteLength(escaped);
    if (bytes + size > 16_384) break;
    bytes += size;
    display += escaped;
  }
  return `${prefix}${display}]`;
}
export function checkCallerAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation cancelled");
}
export async function writeWebTextArtifact(
  text: string,
  metadata: (artifact: ProcessArtifact) => Record<string, unknown>,
  signal: AbortSignal | undefined,
  onArtifactCreated: ((artifact: ProcessArtifact) => void) | undefined,
  failure: (message: string, cancelled: boolean) => Error,
): Promise<WebTextArtifactDetails> {
  let artifact: ProcessArtifact | undefined;
  try {
    checkCallerAbort(signal);
    if (Buffer.byteLength(text) > WEB_ARTIFACT_LIMIT) throw new WebArtifactLimitError("The complete text exceeds the artifact limit");
    artifact = await createProcessArtifact();
    pinProcessArtifact(artifact.directory);
    onArtifactCreated?.(artifact);
    checkCallerAbort(signal);
    const record = metadata(artifact);
    try { jsonBytes(record, WEB_ARTIFACT_LIMIT - 1); }
    catch (error) {
      if (error instanceof RangeError) throw new WebArtifactLimitError("The complete metadata exceeds the artifact limit");
      throw error;
    }
    await writeFile(artifact.stdout_path, text, signal ? { signal } : undefined);
    checkCallerAbort(signal);
    await writeProcessArtifactMetadata(artifact, record);
    checkCallerAbort(signal);
    unpinProcessArtifact(artifact.directory);
    return {
      path: artifact.stdout_path, metadata_path: artifact.metadata_path, format: "text", capture: "complete",
      captured_bytes: Buffer.byteLength(text), captured_lines: textLines(text), expires_at: artifact.expires_at,
    };
  } catch (error) {
    if (artifact && !await removeProcessArtifact(artifact.directory)) throw failure("Cannot remove the incomplete web artifact", false);
    if (error instanceof WebArtifactLimitError) throw error;
    throw failure(`Cannot write web artifact: ${errorMessage(error)}`, signal?.aborted === true);
  }
}
