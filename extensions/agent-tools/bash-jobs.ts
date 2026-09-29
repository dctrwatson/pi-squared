import { randomUUID } from "node:crypto";
import type { ProcessArtifact } from "./process-artifacts.ts";
import type { ProcessSnapshot } from "./process-output.ts";
import { boundedProcessErrorMessage } from "./process-output.ts";
import { BashProcessOwner, BashToolError, startBashProcess, type BashProcessController, type BashProcessOptions } from "./bash-process.ts";

export class BashJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export type BashJobState = "starting" | "running" | "stopping" | "exited" | "timed_out" | "cancelled" | "failed" | "stop_failed";
export interface BashJobSnapshot {
  job_id: string;
  state: BashJobState;
  started_at: string | null;
  deadline_at: string | null;
  finished_at: string | null;
  registry_expires_at: string | null;
  process: ProcessSnapshot | null;
  error?: { code: string; message: string };
}
export type BashBackgroundDetails = { ok: true; tool: "bash"; job: BashJobSnapshot }
  | { ok: false; tool: "bash"; error: { code: string; message: string }; job_id: string; job: BashJobSnapshot; process?: ProcessSnapshot };
interface Entry {
  id: string;
  controller?: BashProcessController;
  completedAt?: number;
  caller?: AbortSignal;
  pending?: Promise<unknown>;
}
export interface BashJobRegistryOptions {
  now?: () => number;
  onRetainedCountChange?: (count: number) => void;
  startController?: typeof startBashProcess;
}
export function isTerminalJob(state: BashJobState): boolean {
  return state === "exited" || state === "timed_out" || state === "cancelled" || state === "failed";
}
function stateOf(controller: BashProcessController | undefined): BashJobState {
  if (!controller) return "starting";
  const snapshot = controller.snapshot();
  const process = snapshot.process;
  if (!process) return "starting";
  if (process.cleanup === "failed") return "stop_failed";
  if (process.cleanup === "pending") return process.stop_reason === null ? "running" : "stopping";
  if (snapshot.error && snapshot.error.code !== "CANCELLED") return "failed";
  if (process.timed_out) return "timed_out";
  if (process.stop_reason === "cancelled" || process.stop_reason === "shutdown") return "cancelled";
  return "exited";
}

/** Observe one invocation without cancelling the controller's operation. */
export async function observeJobOperation(operation: Promise<unknown>, seconds: number | undefined, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BashToolError("CANCELLED", "Job observation was cancelled; the job operation continues");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new BashToolError("CANCELLED", "Job observation was cancelled; the job operation continues"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  const timeout = new Promise<void>((resolve) => { if (seconds !== undefined) timer = setTimeout(resolve, seconds * 1000); });
  try { await Promise.race([operation, cancelled, timeout]); }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

export class BashJobRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private closed = false;
  private sessionId: string | null;
  readonly owner: BashProcessOwner;
  private readonly options: BashJobRegistryOptions;
  constructor(owner: BashProcessOwner, sessionId: string | null, options: BashJobRegistryOptions = {}) {
    this.owner = owner;
    this.options = options;
    this.sessionId = sessionId;
    this.now = options.now ?? Date.now;
  }
  get retainedCount(): number { return this.entries.size; }
  bindSession(sessionId: string): void {
    if (this.sessionId !== null && this.sessionId !== sessionId) throw new BashJobError("JOB_NOT_FOUND", "Job registry belongs to another session");
    this.sessionId = sessionId;
  }
  belongsTo(sessionId: string): boolean { return this.sessionId === sessionId; }
  private changed(): void { this.options.onRetainedCountChange?.(this.entries.size); }
  private remove(id: string): void { if (this.entries.delete(id)) this.changed(); }
  prune(): void {
    const terminal = [...this.entries.values()].filter((entry) => entry.completedAt !== undefined)
      .sort((a, b) => a.completedAt! - b.completedAt! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const entry of terminal) if (this.now() - entry.completedAt! >= 3600000) this.remove(entry.id);
    const remaining = terminal.filter((entry) => this.entries.has(entry.id));
    for (const entry of remaining.slice(0, Math.max(0, remaining.length - 64))) this.remove(entry.id);
  }
  private settle(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    if (isTerminalJob(stateOf(entry.controller)) && entry.completedAt === undefined) entry.completedAt = this.now();
    this.prune();
  }
  private entry(id: string): Entry {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || this.closed) throw new BashJobError("JOB_NOT_FOUND", "Job does not belong to this runtime/session or its handle expired");
    return entry;
  }
  private snapshot(entry: Entry): BashJobSnapshot {
    this.settle(entry);
    const current = entry.controller?.snapshot();
    return { job_id: entry.id, state: stateOf(entry.controller), started_at: current?.started_at ?? null,
      deadline_at: current?.deadline_at ?? null, finished_at: current?.finished_at ?? null,
      registry_expires_at: entry.completedAt === undefined ? null : new Date(entry.completedAt + 3600000).toISOString(),
      process: current?.process ?? null, ...(current?.error ? { error: { ...current.error } } : {}) };
  }
  status(id: string): BashJobSnapshot { return this.snapshot(this.entry(id)); }
  async start(options: BashProcessOptions): Promise<BashJobSnapshot> {
    this.prune();
    if (this.closed || this.owner.closed) throw new BashToolError("CANCELLED", "Bash job admission is closed");
    if (options.signal?.aborted) throw new BashToolError("CANCELLED", "Bash command was cancelled");
    if ([...this.entries.values()].filter((entry) => !isTerminalJob(stateOf(entry.controller))).length >= 8) {
      throw new BashToolError("JOB_LIMIT", "Eight Bash jobs are already live or reserved");
    }
    const entry: Entry = { id: `job_${randomUUID()}`, caller: options.signal };
    this.entries.set(entry.id, entry);
    this.changed();
    try {
      const controller = (this.options.startController ?? startBashProcess)(this.owner, {
        ...options, background: true, onUpdate: undefined, jobId: entry.id, lifetimeSignal: this.lifetime.signal,
        reserveMetadata: (artifact) => reserveBashJobMetadataBytes(entry.id, artifact),
      });
      entry.controller = controller;
      controller.finished.then(() => this.settle(entry), () => { if (!controller.snapshot().process) this.remove(entry.id); });
      await controller.started;
      if (options.signal?.aborted || controller.snapshot().process?.cleanup !== "pending") await controller.finished;
      this.settle(entry);
      return this.snapshot(entry);
    } catch (error) {
      if (!entry.controller?.snapshot().process) this.remove(entry.id);
      throw error;
    }
  }
  transfer(id: string): void { this.entries.get(id)?.controller?.releaseCaller(); }
  async wait(id: string, seconds: number, signal?: AbortSignal): Promise<BashJobSnapshot> {
    const entry = this.entry(id);
    if (signal?.aborted) throw new BashToolError("CANCELLED", "Job observation was cancelled");
    if (!isTerminalJob(stateOf(entry.controller)) && stateOf(entry.controller) !== "stop_failed") {
      await observeJobOperation(entry.pending ?? entry.controller!.finished, seconds, signal);
    }
    this.settle(entry);
    return this.snapshot(entry);
  }
  async cancel(id: string, signal?: AbortSignal): Promise<BashJobSnapshot> {
    const entry = this.entry(id);
    if (signal?.aborted) throw new BashToolError("CANCELLED", "Job observation was cancelled");
    if (!isTerminalJob(stateOf(entry.controller))) {
      if (!entry.pending) {
        const operation = entry.controller!.stop("cancelled");
        entry.pending = operation.then(() => this.settle(entry)).finally(() => { entry.pending = undefined; });
      }
      await observeJobOperation(entry.pending, 4, signal);
    }
    this.settle(entry);
    return this.snapshot(entry);
  }
  closeAdmission(): void { this.closed = true; this.lifetime.abort(); }
  clear(): void { if (this.entries.size) { this.entries.clear(); this.changed(); } }
}

export function formatBashJobHeader(job: BashJobSnapshot, tool = "bash_job"): string {
  const process = job.process;
  return `[${tool}: job_id=${job.job_id}; state=${job.state}; deadline_at=${job.deadline_at}; registry_expires_at=${job.registry_expires_at}; exit_code=${process?.exit_code ?? null}; signal=${process?.signal ?? null}; timed_out=${process?.timed_out ?? null}; stop_reason=${process?.stop_reason ?? null}; cleanup=${process?.cleanup ?? null}; stdout_bytes=${process?.stdout.captured_raw_bytes ?? 0}; stderr_bytes=${process?.stderr.captured_raw_bytes ?? 0}${process?.stdout.artifact ? `; stdout_artifact=${process.stdout.artifact}` : ""}${process?.stderr.artifact ? `; stderr_artifact=${process.stderr.artifact}` : ""}]`;
}
export function formatBashJobStatus(job: BashJobSnapshot, tool = "bash_job"): string {
  const header = formatBashJobHeader(job, tool);
  const text = job.error ? `[job process error: ${job.error.code}; ${boundedProcessErrorMessage(job.error.message)}]\n${header}` : header;
  if (Buffer.byteLength(text) > 8192) throw new BashToolError("RESULT_BUDGET_TOO_SMALL", "Job metadata exceeds its status budget; the process did run. Do not rerun it");
  return text;
}
export function formatBashJobStart(job: BashJobSnapshot): { text: string; details: BashBackgroundDetails } {
  let text: string;
  try { text = formatBashJobStatus(job, "bash"); }
  catch {
    const error = { code: "RESULT_BUDGET_TOO_SMALL", message: "The process did run, but job metadata exceeds its status budget. Read the saved paths in job details. Do not rerun the command." };
    return { text: `[bash error: ${error.code}; job_id=${job.job_id}; ${error.message}]`,
      details: { ok: false, tool: "bash", error, job_id: job.job_id, job, ...(job.process ? { process: job.process } : {}) } };
  }
  if (job.error && isTerminalJob(job.state) || job.state === "stop_failed") {
    const error = job.error ?? { code: "PROCESS_CONTROL_FAILED", message: "Bash cleanup is not verified" };
    return { text, details: { ok: false, tool: "bash", error: { code: error.code, message: boundedProcessErrorMessage(error.message) }, job_id: job.job_id, job,
      ...(job.process ? { process: job.process } : {}) } };
  }
  return { text, details: { ok: true, tool: "bash", job } };
}
export function reserveBashJobMetadataBytes(id: string, artifact: ProcessArtifact): number {
  const job: BashJobSnapshot = { job_id: id, state: "stop_failed", started_at: null,
    deadline_at: "2000-01-01T00:00:00.000Z", finished_at: null, registry_expires_at: "2000-01-01T00:00:00.000Z",
    error: { code: "RESULT_BUDGET_TOO_SMALL", message: "x".repeat(512) },
    process: { exit_code: -2147483648, signal: "S".repeat(32), timed_out: false, stop_reason: "artifact_failed", cleanup: "complete", duration_ms: Number.MAX_SAFE_INTEGER,
      stdout: { capture: "incomplete", preview: "truncated", captured_raw_bytes: 67108864, captured_lines: 0, preview_bytes: 0, artifact: artifact.stdout_path },
      stderr: { capture: "incomplete", preview: "truncated", captured_raw_bytes: 67108864, captured_lines: 0, preview_bytes: 0, artifact: artifact.stderr_path } } };
  const status = Buffer.byteLength(`[job process error: RESULT_BUDGET_TOO_SMALL; ${"x".repeat(512)}]\n${formatBashJobHeader(job)}`);
  const page = Buffer.byteLength(`[bash_job output: job_id=${id}; state=stop_failed; stream=stderr; encoding=base64; bytes=9007199254740991-9007199254740991]\n[output: next_start_byte=9007199254740991; available_bytes=9007199254740991; has_more=false; capture=incomplete; omitted_before=9007199254740991; artifact=${Buffer.byteLength(artifact.stdout_path) > Buffer.byteLength(artifact.stderr_path) ? artifact.stdout_path : artifact.stderr_path}]`) + 1;
  return Math.max(status, page);
}
