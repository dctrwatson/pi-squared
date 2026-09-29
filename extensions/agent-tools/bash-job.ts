import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import { readBytePage, ReadToolError } from "./read.ts";
import { boundedProcessErrorMessage } from "./process-output.ts";
import { BashToolError } from "./bash-process.ts";
import { BashJobError, BashJobRegistry, formatBashJobStatus, formatBashJobHeader, isTerminalJob, type BashJobSnapshot } from "./bash-jobs.ts";
import { hasUnsuccessfulProcessStatus, renderPreview, renderTruncatedToolCall, safeRenderArgument, textContent } from "./tool-render.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("output"), Type.Literal("cancel")]),
  job_id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[\\x01-\\x7f]+$", description: "Runtime-owned job ID" }),
  wait_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "Wait only: 0–5 seconds; default 1" })),
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], { description: "Output only; default stdout" })),
  start_byte: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Output only: raw byte offset; omission selects the tail" })),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 40960, description: "Output only: default 4096; UTF-8 up to 40960, Base64 up to 30720" })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { description: "Output only; default utf8" })),
}, { additionalProperties: false });
const optionalFields = ["wait_seconds", "stream", "start_byte", "max_bytes", "encoding"];
export type BashJobInput = Static<typeof parameters>;
interface NormalizedInput {
  action: BashJobInput["action"];
  jobId: string;
  waitSeconds: number;
  stream: "stdout" | "stderr";
  startByte?: number;
  maxBytes: number;
  encoding: "utf8" | "base64";
}
function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new BashJobError("INVALID_INPUT", `${name} must be an integer from ${minimum} through ${maximum}`);
  return value as number;
}
export function normalizeBashJobInput(raw: unknown): NormalizedInput {
  raw = omitNullOptionalFields(raw, optionalFields);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BashJobError("INVALID_INPUT", "Input must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["action", "job_id", ...optionalFields].includes(key)) throw new BashJobError("INVALID_INPUT", `Unknown input field: ${key}`);
  if (!["status", "wait", "output", "cancel"].includes(input.action as string)) throw new BashJobError("INVALID_INPUT", "action must be status, wait, output, or cancel");
  if (typeof input.job_id !== "string" || !/^[\x01-\x7f]{1,64}$/.test(input.job_id)) throw new BashJobError("INVALID_INPUT", "job_id must contain 1 through 64 ASCII characters without NUL");
  for (const key of optionalFields) if (input[key] !== undefined && (key === "wait_seconds" ? input.action !== "wait" : input.action !== "output")) throw new BashJobError("INVALID_INPUT", `${key} is not used by this action`);
  const wait = input.wait_seconds ?? 1;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0 || wait > 5) throw new BashJobError("INVALID_INPUT", "wait_seconds must be finite from 0 through 5");
  const stream = input.stream ?? "stdout";
  const encoding = input.encoding ?? "utf8";
  if (stream !== "stdout" && stream !== "stderr") throw new BashJobError("INVALID_INPUT", "stream must be stdout or stderr");
  if (encoding !== "utf8" && encoding !== "base64") throw new BashJobError("INVALID_INPUT", "encoding must be utf8 or base64");
  return { action: input.action as BashJobInput["action"], jobId: input.job_id, waitSeconds: wait, stream, encoding,
    maxBytes: integer(input.max_bytes ?? 4096, "max_bytes", 1, encoding === "base64" ? 30720 : 40960),
    ...(input.start_byte !== undefined ? { startByte: integer(input.start_byte, "start_byte", 0, Number.MAX_SAFE_INTEGER) } : {}) };
}
export interface BashJobOutput {
  stream: "stdout" | "stderr";
  encoding: "utf8" | "base64";
  start_byte: number;
  end_byte: number;
  next_start_byte: number;
  available_bytes: number;
  has_more: boolean;
  capture: "complete" | "incomplete";
  artifact: string;
}
export type BashJobDetails = { ok: true; tool: "bash_job"; job: BashJobSnapshot; output?: BashJobOutput }
  | { ok: false; tool: "bash_job"; error: { code: string; message: string }; job?: BashJobSnapshot };

/** Read one saved byte prefix without applying read's immutable-file gate. */
export async function readBashJobOutput(job: BashJobSnapshot, input: NormalizedInput, signal?: AbortSignal): Promise<{ text: string; output: BashJobOutput }> {
  if (signal?.aborted) throw new BashJobError("CANCELLED", "Output observation was cancelled");
  const stream = job.process?.[input.stream];
  if (!stream?.artifact) throw new BashJobError("ARTIFACT_FAILED", "No verified saved stream is available");
  const path = stream.artifact;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || !Number.isSafeInteger(initial.size)) throw new BashJobError("ARTIFACT_FAILED", "Saved output must be a regular file with a safe byte size");
    const size = initial.size;
    let start = input.startByte ?? Math.max(0, size - input.maxBytes);
    if (start > size) throw new BashJobError("INVALID_INPUT", "start_byte exceeds the currently saved byte size");
    if (input.encoding === "utf8" && input.startByte === undefined && start < size) {
      const probe = Buffer.alloc(4);
      let count = 0;
      const length = Math.min(4, size - start);
      while (count < length) {
        const read = await file.read(probe, count, length - count, start + count);
        if (!read.bytesRead) throw new BashJobError("ARTIFACT_FAILED", "Saved output ended before its frozen size");
        count += read.bytesRead;
      }
      let skip = 0;
      while (skip < count && probe[skip]! >= 0x80 && probe[skip]! <= 0xbf) skip += 1;
      if (skip === 4) throw new BashJobError("INVALID_ENCODING", "Saved output is not valid UTF-8; use Base64");
      start += skip;
    }
    const reader = { async read(buffer: Buffer, offset: number, length: number, position: number) {
      if (signal?.aborted) throw new BashJobError("CANCELLED", "Output observation was cancelled");
      if ((await file.stat()).size < size) throw new BashJobError("ARTIFACT_FAILED", "Saved output shrank during the page read");
      const result = await file.read(buffer, offset, length, position);
      if (!result.bytesRead && length > 0) throw new BashJobError("ARTIFACT_FAILED", "Saved output ended before its frozen size");
      return result;
    } };
    const page = await readBytePage(reader, { totalBytes: size, startByte: start, maxBytes: input.maxBytes,
      encoding: input.encoding, path, signal, allowIncompleteUtf8: !isTerminalJob(job.state) && stream.capture !== "complete" });
    if ((await file.stat()).size < size) throw new BashJobError("ARTIFACT_FAILED", "Saved output shrank during the page read");
    const output: BashJobOutput = { stream: input.stream, encoding: input.encoding, start_byte: page.start_byte, end_byte: page.end_byte,
      next_start_byte: page.end_byte, available_bytes: size, has_more: page.end_byte < size, capture: stream.capture, artifact: path };
    const header = `[bash_job output: job_id=${job.job_id}; state=${job.state}; stream=${input.stream}; encoding=${input.encoding}; bytes=${page.start_byte}-${page.end_byte}]`;
    const footer = `[output: next_start_byte=${page.end_byte}; available_bytes=${size}; has_more=${output.has_more}; capture=${stream.capture}; omitted_before=${page.start_byte}; artifact=${path}]`;
    const text = [header, ...(page.content ? [page.content] : []), footer].join("\n");
    const bound = (input.encoding === "base64" ? Math.ceil(input.maxBytes / 3) * 4 : input.maxBytes) + 8192;
    if (Buffer.byteLength(text) > Math.min(49152, bound)) throw new BashJobError("ARTIFACT_FAILED", "Output metadata exceeds the reserved page budget");
    return { text, output };
  } finally { await file.close(); }
}

export function createAgentBashJobTool(registry: BashJobRegistry | (() => BashJobRegistry)): ToolDefinition<typeof parameters, BashJobDetails> {
  const current = () => typeof registry === "function" ? registry() : registry;
  return {
    name: "bash_job", label: "bash_job", parameters, executionMode: "parallel",
    description: "Inspect a managed Bash job. Cancelling wait does not stop the job; cancel does. Output defaults to a saved-log tail; use next_start_byte as start_byte to continue.",
    promptSnippet: "Inspect or stop a managed Bash job",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: (raw) => prepareInputArguments(raw, optionalFields, normalizeBashJobInput),
    prepareLoadout: () => current().retainedCount === 0 ? { hiddenDeclarations: ["bash_job"] } : undefined,
    renderCall(args, theme, context) {
      const text = theme.fg("toolTitle", theme.bold(`bash_job ${safeRenderArgument(args.action)} ${safeRenderArgument(args.job_id)}`));
      return renderTruncatedToolCall(text, theme, context.isPartial, context.isError);
    },
    renderResult(result, options, theme, context) {
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", renderPreview(textContent(result), options.expanded)), 0, 0);
    },
    async execute(_id, params, signal, _update, ctx) {
      let job: BashJobSnapshot | undefined;
      let input: NormalizedInput | undefined;
      try {
        input = normalizeBashJobInput(params);
        const jobs = current();
        if (!jobs.belongsTo(ctx.sessionManager.getSessionId())) throw new BashJobError("JOB_NOT_FOUND", "Job belongs to another session");
        job = jobs.status(input.jobId);
        if (input.action === "output") {
          const page = await readBashJobOutput(job, input, signal);
          return { content: [{ type: "text", text: page.text }], details: { ok: true, tool: "bash_job", job, output: page.output }, isError: false };
        }
        if (input.action === "wait") job = await jobs.wait(input.jobId, input.waitSeconds, signal);
        if (input.action === "cancel") job = await jobs.cancel(input.jobId, signal);
        if (input.action === "cancel" && job.state === "stop_failed") throw new BashJobError("PROCESS_CONTROL_FAILED", job.error?.message ?? "Bash cleanup is not verified");
        const details: BashJobDetails = { ok: true, tool: "bash_job", job };
        return { content: [{ type: "text", text: formatBashJobStatus(job) }], details, isError: hasUnsuccessfulProcessStatus(details) };
      } catch (error) {
        if (input && job) { try { job = current().status(input.jobId); } catch {} }
        const code = error instanceof BashJobError || error instanceof BashToolError || error instanceof ReadToolError ? error.code : "ARTIFACT_FAILED";
        const message = boundedProcessErrorMessage(error instanceof BashToolError ? error.detailMessage : error instanceof Error ? error.message : String(error));
        const details: BashJobDetails = { ok: false, tool: "bash_job", error: { code, message }, ...(job ? { job } : {}) };
        let text = `[bash_job error: ${code}; ${message}]${job ? `\n${formatBashJobHeader(job)}` : ""}`;
        if (Buffer.byteLength(text) > 8192) text = "[bash_job error: ARTIFACT_FAILED; Job metadata exceeds its status budget. Read the saved paths in job details. Do not rerun the command.]";
        return { content: [{ type: "text", text }], details, isError: true };
      }
    },
  };
}
