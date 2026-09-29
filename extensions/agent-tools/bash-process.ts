import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, type WriteStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { completeProcessArtifact, createProcessArtifact, finalizeProcessArtifact, pinProcessArtifact, verifiedProcessStreamBytes, openProcessArtifactStreams, removeProcessArtifact, type ProcessArtifact } from "./process-artifacts.ts";
import { appendCapturedProcessStream, capturedProcessLines, createCapturedProcessStream, formatProcessFailure, formatProcessResult, formatProcessBudgetFailure, ProcessResultBudgetError, reserveProcessMetadataBytes, MAX_PROCESS_STREAM_BYTES, MAX_PROCESS_TOTAL_BYTES, type FormattedProcessResult, type ProcessEvidence, type ProcessStopReason, type ProcessToolDetails, type ProcessSnapshot } from "./process-output.ts";
import type { NormalizedBashInput } from "./bash.ts";
const STOP_GRACE_MS = 2000;
const STOP_FORCE_WAIT_MS = 2000;
const FORCED_CLOSE_RESERVE_MS = 250;
const UPDATE_THROTTLE_MS = 100;
const PROGRESS_UPDATE_MS = 1000;
export type BashErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "SHELL_NOT_FOUND"
  | "SPAWN_FAILED"
  | "CAPTURE_FAILED"
  | "ARTIFACT_FAILED"
  | "OUTPUT_LIMIT"
  | "PROCESS_CONTROL_FAILED"
  | "CANCELLED"
  | "INTERNAL_ERROR"
  | "RESULT_BUDGET_TOO_SMALL"
  | "CONTROL_UNAVAILABLE"
  | "JOB_LIMIT";

export class BashToolError extends Error {
  readonly code: BashErrorCode;
  readonly detailMessage: string;

  constructor(code: BashErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.detailMessage = message;
  }
}

interface ProcessExit { code: number | null; signal: NodeJS.Signals | null; }
export async function validateBashCwd(input: NormalizedBashInput, sessionCwd: string, guard?: () => void): Promise<string> {
  const cwd = resolve(sessionCwd, input.cwd ?? ".");
  try {
    guard?.();
    const info = await stat(cwd);
    guard?.();
    if (!info.isDirectory()) throw new BashToolError("INVALID_CWD", "cwd is not a directory");
    await access(cwd, constants.R_OK | constants.X_OK);
    guard?.();
    return cwd;
  } catch (error) {
    if (error instanceof BashToolError) throw error;
    throw new BashToolError("INVALID_CWD", `Cannot access cwd: ${cwd}`);
  }
}

async function createBashArtifact(): Promise<ProcessArtifact> {
  try {
    return await createProcessArtifact();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BashToolError("ARTIFACT_FAILED", `Cannot create output artifact: ${message}`);
  }
}

interface ProcessWait {
  exit: Promise<ProcessExit>;
  close: Promise<void>;
  dispose(): void;
}

function waitForProcess(child: ChildProcess): ProcessWait {
  let rejectExit: (error: unknown) => void = () => undefined;
  let rejectClose: (error: unknown) => void = () => undefined;
  let onExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  let onClose!: () => void;
  const exit = new Promise<ProcessExit>((resolveExit, reject) => {
    rejectExit = reject;
    onExit = (code, signal) => resolveExit({ code, signal });
    child.once("exit", onExit);
  });
  const close = new Promise<void>((resolveClose, reject) => {
    rejectClose = reject;
    onClose = () => resolveClose();
    child.once("close", onClose);
  });
  const onError = (error: unknown) => {
    rejectExit(error);
    rejectClose(error);
  };
  child.once("error", onError);
  exit.catch(() => undefined);
  close.catch(() => undefined);
  return { exit, close, dispose() {
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    child.removeListener("error", onError);
  } };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForPromise(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolveTimeout) => {
        timeoutHandle = setTimeout(() => resolveTimeout(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupGone(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (!child.pid) return true;
  const deadline = Date.now() + milliseconds;
  while (processGroupExists(child.pid)) {
    if (Date.now() >= deadline) return false;
    await wait(50);
  }
  return true;
}

async function terminateProcessGroup(child: ChildProcess, budgetMs: number): Promise<void> {
  if (!child.pid || !processGroupExists(child.pid)) return;
  const deadline = Date.now() + budgetMs;
  const grace = Math.min(STOP_GRACE_MS, Math.max(0, deadline - Date.now()));
  try {
    signalProcessGroup(child, "SIGTERM");
  } catch (error) {
    // A group can finish between its existence check and SIGTERM. Keep the
    // cleanup contract by waiting for it to disappear before reporting EPERM.
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || !await waitForProcessGroupGone(child, grace)) throw error;
    return;
  }
  if (await waitForProcessGroupGone(child, grace)) return;

  try { signalProcessGroup(child, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" || !await waitForProcessGroupGone(child, Math.max(0, deadline - Date.now()))) throw error;
    return;
  }
  const remaining = Math.max(0, deadline - Date.now());
  if (!await waitForProcessGroupGone(child, remaining)) {
    throw new BashToolError("PROCESS_CONTROL_FAILED", "Could not terminate the Bash process group");
  }
}


export interface BashControllerSnapshot {
  controller_id: string;
  job_id?: string;
  started_at: string | null;
  deadline_at: string | null;
  finished_at: string | null;
  process: ProcessSnapshot | null;
  error?: { code: string; message: string };
}
export type BashProcessResult = FormattedProcessResult | ReturnType<typeof formatProcessFailure>;
export interface BashProcessController {
  readonly id: string;
  readonly jobId?: string;
  readonly started: Promise<void>;
  readonly finished: Promise<BashProcessResult>;
  snapshot(): BashControllerSnapshot;
  stop(reason: Exclude<ProcessStopReason, null>): Promise<BashProcessResult>;
  releaseCaller(): void;
}
export interface BashProcessOptions {
  input: NormalizedBashInput;
  sessionCwd: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  lifetimeSignal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>;
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
  background?: boolean;
  controlAvailable?: () => boolean;
  jobId?: string;
  createArtifact?: () => Promise<ProcessArtifact>;
  reserveMetadata?: (artifact: ProcessArtifact) => number;
}
export class BashProcessOwner {
  readonly signal: AbortSignal;
  readonly controllers = new Set<BashProcessController>();
  readonly pendingStarts = new Set<Promise<void>>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<BashControllerSnapshot[]>;
  closed = false;
  constructor() { this.signal = this.lifetime.signal; }
  close(): void { this.closed = true; this.lifetime.abort(); }
  shutdown(): Promise<BashControllerSnapshot[]> {
    this.close();
    return this.closing ??= (async () => {
      const owned = [...this.controllers];
      const outcomes = await Promise.allSettled(owned.map(async (controller) => controller.stop("shutdown")));
      await Promise.allSettled([...this.pendingStarts]);
      return owned.map((controller, index) => {
        const snapshot = controller.snapshot();
        const outcome = outcomes[index];
        return outcome?.status === "rejected" && snapshot.process !== null && snapshot.process.cleanup !== "complete"
          ? { ...snapshot, error: { code: "PROCESS_CONTROL_FAILED", message: String(outcome.reason) } } : snapshot;
      });
    })();
  }
}

/** Start one owned Bash controller before its first asynchronous boundary. */
export function startBashProcess(owner: BashProcessOwner, options: BashProcessOptions): BashProcessController {
  if (owner.closed) throw new BashToolError("CANCELLED", "Bash runtime admission is closed");
  const input = options.input;
  const env = options.environment;
  const signal = options.signal;
  const onUpdate = options.onUpdate;
  const id = randomUUID();
  let resolveStarted!: () => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  started.catch(() => undefined);
  let result: BashProcessResult | undefined;
  let settled = false;
  let attempt: Promise<BashProcessResult> | undefined;
  const cleanupLimitMs = options.cleanupLimitMs ?? STOP_GRACE_MS + STOP_FORCE_WAIT_MS;
  let artifact: ProcessArtifact;
  let completedArtifact: ProcessArtifact | undefined;
  let cwd = options.sessionCwd;
  let stdoutFile: WriteStream | undefined;
  let stderrFile: WriteStream | undefined;
  let child: ChildProcess | undefined;
  let spawned = false;
  let startedAt = 0;
  let startedElapsed = 0;
  let finishedAt: number | null = null;
  let finishedElapsed: number | null = null;
  let observedExit: ProcessExit | undefined;
  let processWait: ProcessWait | undefined;
  let spawnWait: Promise<void> | undefined;
  const sourceDisposers: (() => void)[] = [];
  const drains = new Map<WriteStream, Set<() => void>>();
  const childDisposers: (() => void)[] = [];
  let stdoutDone: Promise<void> = Promise.resolve();
  let stderrDone: Promise<void> = Promise.resolve();
  let cleanup: ProcessEvidence["status"]["cleanup"] = "pending";
  let cleanupDeadline: number | undefined;
  let stopReason: ProcessStopReason = null;
  let firstFailure: BashToolError | undefined;
  let artifactError: BashToolError | undefined;
  let budgetError: BashToolError | undefined;
  let captureError: BashToolError | undefined;
  let controlError: BashToolError | undefined;
  const stdout = createCapturedProcessStream("");
  const stderr = createCapturedProcessStream("");
  stdout.path = undefined;
  stderr.path = undefined;
  const eof = { stdout: false, stderr: false };
  const savedEof = { stdout: false, stderr: false };
  const interrupted = { stdout: false, stderr: false };
  let timeoutHandle: NodeJS.Timeout | undefined;
  let updateHandle: NodeJS.Timeout | undefined;
  let progressHandle: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  let updateDirty = false;
  let lastUpdateAt = 0;
  let progressFailed = false;
  let updatesClosed = false;
  let resolveStop: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => { resolveStop = resolve; });
  const requestStop = (reason: Exclude<ProcessStopReason, null>, failure?: BashToolError): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    firstFailure = failure;
    if (!eof.stdout) interrupted.stdout = true;
    if (!eof.stderr) interrupted.stderr = true;
    resolveStop();
  };
  const recordArtifactError = (name: string, error: unknown): void => {
    artifactError ??= new BashToolError("ARTIFACT_FAILED", `Cannot write ${name} artifact: ${String(error)}`);
    requestStop("artifact_failed", artifactError);
  };
  const evidence = (completed?: ProcessArtifact): ProcessEvidence => ({
    status: {
      exit_code: cleanup === "pending" || stopReason === "timeout" || observedExit?.signal ? null : observedExit?.code ?? null,
      signal: cleanup === "pending" ? null : observedExit?.signal ?? null,
      timed_out: stopReason === "timeout",
      duration_ms: spawned ? Math.floor(Math.max(0, (finishedElapsed ?? performance.now()) - startedElapsed)) : 0,
      stop_reason: stopReason,
      cleanup,
    },
    artifact: completed,
    stdout,
    stderr,
    capture: {
      stdout: eof.stdout && savedEof.stdout && !interrupted.stdout ? "complete" : "incomplete",
      stderr: eof.stderr && savedEof.stderr && !interrupted.stderr ? "complete" : "incomplete",
    },
  });
  const format = (completedArtifact?: ProcessArtifact): FormattedProcessResult => {
    const snapshot = evidence(completedArtifact);
    return formatProcessResult("bash", snapshot.status, snapshot.artifact, stdout, stderr, snapshot.capture, input.maxOutputBytes);
  };
  const recordProgressError = (error: unknown): void => {
    if (updatesClosed || progressFailed) return;
    progressFailed = true;
    clearUpdates();
    if (error instanceof ProcessResultBudgetError) {
      budgetError ??= new BashToolError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command.");
      requestStop("capture_failed", budgetError);
      return;
    }
    captureError ??= new BashToolError("CAPTURE_FAILED", `Cannot publish Bash progress: ${String(error)}`);
    requestStop("capture_failed", captureError);
  };
  const emitUpdate = (): void => {
    if (!spawned || !onUpdate || !updateDirty || updatesClosed || progressFailed) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    try {
      const result = format();
      const returned: unknown = onUpdate({ content: [{ type: "text", text: result.text }], details: result.details });
      void Promise.resolve(returned).catch(recordProgressError);
    } catch (error) {
      recordProgressError(error);
    }
  };
  const clearUpdates = (): void => {
    if (updateHandle) clearTimeout(updateHandle);
    if (progressHandle) clearInterval(progressHandle);
    updateHandle = undefined;
    progressHandle = undefined;
  };
  const scheduleUpdate = (): void => {
    if (!onUpdate || updatesClosed || progressFailed) return;
    updateDirty = true;
    const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      if (updateHandle) clearTimeout(updateHandle);
      updateHandle = undefined;
      emitUpdate();
    } else {
      updateHandle ??= setTimeout(() => { updateHandle = undefined; emitUpdate(); }, delay);
    }
  };
  const recordOutput = (
    name: "stdout" | "stderr", data: Buffer, file: WriteStream, source: NodeJS.ReadableStream,
  ): void => {
    const capture = name === "stdout" ? stdout : stderr;
    const other = name === "stdout" ? stderr : stdout;
    const length = Math.min(data.length, MAX_PROCESS_STREAM_BYTES - capture.totalBytes,
      MAX_PROCESS_TOTAL_BYTES - capture.totalBytes - other.totalBytes);
    if (length > 0 && stopReason !== "output_limit") {
      const captured = data.subarray(0, length);
      appendCapturedProcessStream(capture, captured);
      if (!file.destroyed) {
        try {
          if (!file.write(captured)) {
            source.pause();
            const callbacks = drains.get(file) ?? new Set<() => void>();
            drains.set(file, callbacks);
            const resume = () => { callbacks.delete(resume); source.resume(); };
            callbacks.add(resume);
            file.once("drain", resume);
          }
        } catch (error) { recordArtifactError(name, error); }
      }
      scheduleUpdate();
    } else if (data.length > 0) interrupted[name] = true;
    if (length < data.length) {
      interrupted[name] = true;
      requestStop("output_limit", new BashToolError("OUTPUT_LIMIT",
        `standard ${name === "stdout" ? "output" : "error"} exceeded the full-capture limit`));
    }
  };

  const finishCleanup = async (deadline: number): Promise<ProcessEvidence["status"]["cleanup"]> => {
    if (!child || !processWait || !stdoutFile || !stderrFile) {
      throw new BashToolError("PROCESS_CONTROL_FAILED", "Process cleanup state is not available");
    }
    const activeChild = child;
    const activeStdoutFile = stdoutFile;
    const activeStderrFile = stderrFile;
    try {
      await terminateProcessGroup(activeChild, Math.max(0, deadline - Date.now()));
      if (!await waitForPromise(processWait.exit, Math.max(0, deadline - Date.now())) || !observedExit) {
        throw new Error("Bash did not exit during cleanup");
      }
    } catch (error) {
      controlError = new BashToolError("PROCESS_CONTROL_FAILED", String(error));
      requestStop("cleanup_failed", controlError);
    }
    const drain = Promise.allSettled([processWait.close, stdoutDone, stderrDone]);
    if (controlError || !await waitForPromise(drain, Math.max(0, deadline - FORCED_CLOSE_RESERVE_MS - Date.now()))) {
      if (!eof.stdout) interrupted.stdout = true;
      if (!eof.stderr) interrupted.stderr = true;
      activeChild.stdout?.destroy();
      activeChild.stderr?.destroy();
      activeStdoutFile.end();
      activeStderrFile.end();
      if (!await waitForPromise(Promise.all([stdoutDone, stderrDone]), Math.max(0, deadline - Date.now()))) {
        activeStdoutFile.destroy();
        activeStderrFile.destroy();
        if (!await waitForPromise(Promise.all([stdoutDone, stderrDone]), Math.max(0, deadline - Date.now()))) {
          controlError ??= new BashToolError("PROCESS_CONTROL_FAILED", "Could not close output artifact streams");
          requestStop("cleanup_failed", controlError);
        }
      }
      if (!controlError && !await waitForPromise(processWait.close, Math.max(0, deadline - Date.now()))) {
        controlError = new BashToolError("PROCESS_CONTROL_FAILED", "Could not close Bash output streams");
        requestStop("cleanup_failed", controlError);
      }
    }
    const cleaned = controlError || !observedExit || (activeChild.pid && processGroupExists(activeChild.pid)) ? "failed" : "complete";
    if (cleaned === "failed") controlError ??= new BashToolError("PROCESS_CONTROL_FAILED", "Bash cleanup is not verified");
    return cleaned;
  };

  const checkAdmission = (): void => {
    if (owner.closed || owner.signal.aborted || options.lifetimeSignal?.aborted) throw new BashToolError("CANCELLED", "Bash runtime was shut down");
    if (signal?.aborted) throw new BashToolError("CANCELLED", "Bash command was cancelled");
    if (options.background && options.controlAvailable && !options.controlAvailable()) {
      throw new BashToolError("CONTROL_UNAVAILABLE", "Select bash_job before starting a background command");
    }
  };
  const lifetimeAbort = (): void => requestStop("shutdown", new BashToolError("CANCELLED", "Bash runtime was shut down"));
  const settleResult = async (): Promise<BashProcessResult> => {
  for (const [name, capture, path] of [["stdout", stdout, artifact.stdout_path], ["stderr", stderr, artifact.stderr_path]] as const) {
    const saved = await verifiedProcessStreamBytes(path);
    capture.path = saved === undefined || (saved === 0 && capture.totalBytes > 0) ? undefined : path;
    if (saved !== capture.totalBytes) {
      if (saved !== undefined) capture.savedRawBytes = saved;
      interrupted[name] = true;
      artifactError ??= new BashToolError("ARTIFACT_FAILED", `Cannot save all ${name} bytes`);
      requestStop("artifact_failed", artifactError);
    }
  }
  if (cleanup === "complete") { finishedAt = Date.now(); finishedElapsed = performance.now(); }
  let failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  let preliminary: FormattedProcessResult | undefined;
  try {
    preliminary = format();
  } catch {
    budgetError ??= new BashToolError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command.");
    requestStop("capture_failed", budgetError);
    failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  }
  if (cleanup === "complete") {
    try {
      if (!options.background && !failure && preliminary && !preliminary.needsArtifact) {
        await finalizeProcessArtifact(artifact, "when-needed", false);
        stdout.path = undefined;
        stderr.path = undefined;
      } else if (!options.background && !budgetError && failure && stdout.totalBytes === 0 && stderr.totalBytes === 0 && !artifactError) {
        await finalizeProcessArtifact(artifact, "when-needed", false);
        stdout.path = undefined;
        stderr.path = undefined;
      } else {
        const completedAt = Date.now();
        completedArtifact = await completeProcessArtifact(artifact, completedAt, {
          id: artifact.id, tool: "bash", cwd, started_at: startedAt, finished_at: completedAt,
          ...evidence().status,
          streams_complete: evidence().capture.stdout === "complete" && evidence().capture.stderr === "complete",
          stdout: { bytes: stdout.totalBytes, lines: capturedProcessLines(stdout) },
          stderr: { bytes: stderr.totalBytes, lines: capturedProcessLines(stderr) },
        });
      }
    } catch (error) {
      artifactError ??= new BashToolError("ARTIFACT_FAILED", `Cannot complete output artifact: ${String(error)}`);
      requestStop("artifact_failed", artifactError);
      pinProcessArtifact(artifact.directory);
    }
  }
  failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  if (failure) {
    const cause = firstFailure && firstFailure !== failure ? `; first stop: ${firstFailure.code}: ${firstFailure.detailMessage}` : "";
    const captureCause = captureError && captureError !== failure && captureError !== firstFailure
      ? `; capture: ${captureError.code}: ${captureError.detailMessage}` : "";
    return formatProcessFailure("bash", failure.code, failure.detailMessage + cause + captureCause, evidence(completedArtifact), input.maxOutputBytes);
  }
  if (preliminary && !preliminary.needsArtifact) return preliminary;
  try {
    return format(completedArtifact);
  } catch {
    return formatProcessBudgetFailure("bash", evidence(completedArtifact));
  }
  };
  const controller: BashProcessController = {
    id, jobId: options.jobId, started,
    finished: undefined!,
    snapshot() {
      const current = evidence(completedArtifact);
      const observingAttempt = !settled || attempt !== undefined;
      if (observingAttempt) {
        current.status.cleanup = "pending";
        current.status.exit_code = null;
        current.status.signal = null;
      }
      const failure = result?.details.ok === false ? result.details.error : undefined;
      const stream = (name: "stdout" | "stderr") => {
        const capture = name === "stdout" ? stdout : stderr;
        return { capture: current.capture[name], preview: capture.totalBytes > 0 ? "truncated" as const : "complete" as const,
          captured_raw_bytes: capture.totalBytes, captured_lines: capturedProcessLines(capture), preview_bytes: 0,
          ...(capture.totalBytes > 0 ? { head_preview_bytes: 0, tail_preview_bytes: 0, omitted_captured_raw_bytes: capture.totalBytes } : {}),
          ...(capture.savedRawBytes !== undefined ? { saved_raw_bytes: capture.savedRawBytes } : {}),
          ...(capture.path ? { artifact: capture.path } : {}) };
      };
      return { controller_id: id, ...(options.jobId ? { job_id: options.jobId } : {}), started_at: spawned ? new Date(startedAt).toISOString() : null,
        deadline_at: spawned ? new Date(startedAt + input.timeoutSeconds * 1000).toISOString() : null,
        finished_at: observingAttempt || finishedAt === null ? null : new Date(finishedAt).toISOString(),
        process: spawned ? { ...current.status, stdout: stream("stdout"), stderr: stream("stderr"),
          ...(!observingAttempt && completedArtifact ? { artifact: { ...completedArtifact } } : {}) } : null,
        ...(failure ? { error: { ...failure } } : {}) };
    },
    releaseCaller() { if (abortHandler) signal?.removeEventListener("abort", abortHandler); },
    stop(reason) {
      if (settled && (cleanup === "complete" || !spawned)) return result ? Promise.resolve(result) : controller.finished;
      const failure = reason === "cancelled" || reason === "shutdown"
        ? new BashToolError("CANCELLED", reason === "shutdown" ? "Bash runtime was shut down" : "Bash command was cancelled") : undefined;
      requestStop(reason, failure);
      if (!settled) return controller.finished;
      if (attempt) return attempt;
      attempt = (async () => {
        controlError = undefined;
        if (firstFailure?.code === "PROCESS_CONTROL_FAILED") firstFailure = undefined;
        cleanup = "pending";
        cleanupDeadline = Date.now() + cleanupLimitMs;
        cleanup = await finishCleanup(cleanupDeadline);
        result = await settleResult();
        if (cleanup === "complete") {
          processWait?.dispose();
          for (const dispose of childDisposers) dispose();
          childDisposers.length = 0;
          owner.controllers.delete(controller);
        }
        return result;
      })().finally(() => { attempt = undefined; });
      return attempt;
    },
  };
  owner.controllers.add(controller);
  owner.pendingStarts.add(started);
  started.then(() => owner.pendingStarts.delete(started), () => owner.pendingStarts.delete(started));
  owner.signal.addEventListener("abort", lifetimeAbort, { once: true });
  options.lifetimeSignal?.addEventListener("abort", lifetimeAbort, { once: true });
  const execution = (async () => {
  try {
    checkAdmission();
    cwd = await validateBashCwd(input, options.sessionCwd, checkAdmission);
    checkAdmission();
    artifact = await (options.createArtifact ?? createBashArtifact)();
    pinProcessArtifact(artifact.directory);
    checkAdmission();
    options.onArtifactCreated?.(artifact);
    checkAdmission();
    if (Math.max(reserveProcessMetadataBytes("bash", artifact), options.reserveMetadata?.(artifact) ?? 0) > input.maxOutputBytes) {
      throw new BashToolError("RESULT_BUDGET_TOO_SMALL", "Process metadata exceeds max_output_bytes; the process did not run.");
    }
    try {
      const streams = await openProcessArtifactStreams(artifact);
      stdoutFile = streams.stdout;
      stderrFile = streams.stderr;
      stdout.path = artifact.stdout_path;
      stderr.path = artifact.stderr_path;
      checkAdmission();
    } catch (error) {
      throw new BashToolError("ARTIFACT_FAILED", `Cannot open output files: ${String(error)}`);
    }
    checkAdmission();
    const activeStdoutFile = stdoutFile;
    const activeStderrFile = stderrFile;
    stdoutDone = finished(activeStdoutFile, { cleanup: true }).then(() => { savedEof.stdout = true; }).catch((error) => recordArtifactError("standard output", error));
    stderrDone = finished(activeStderrFile, { cleanup: true }).then(() => { savedEof.stderr = true; }).catch((error) => recordArtifactError("standard error", error));
    try {
      child = spawn("bash", ["-c", input.command], { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new BashToolError("SPAWN_FAILED", `Cannot start bash: ${String(error)}`);
    }
    const activeChild = child;
    processWait = waitForProcess(activeChild);
    spawnWait = new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = () => { spawned = true; startedAt = Date.now(); startedElapsed = performance.now(); resolveSpawn(); };
      const onSpawnError = (error: NodeJS.ErrnoException) => rejectSpawn(new BashToolError(
        error.code === "ENOENT" ? "SHELL_NOT_FOUND" : "SPAWN_FAILED", `Cannot start bash: ${error.message}`,
      ));
      activeChild.once("spawn", onSpawn);
      activeChild.once("error", onSpawnError);
      childDisposers.push(() => { activeChild.removeListener("spawn", onSpawn); activeChild.removeListener("error", onSpawnError); });
    });
    spawnWait.catch(() => undefined);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { observedExit = { code, signal }; };
    activeChild.once("exit", onExit);
    childDisposers.push(() => activeChild.removeListener("exit", onExit));
    for (const [name, source, file] of [
      ["stdout", activeChild.stdout, activeStdoutFile],
      ["stderr", activeChild.stderr, activeStderrFile],
    ] as const) {
      if (!source) { eof[name] = true; file.end(); continue; }
      const onData = (data: Buffer) => recordOutput(name, data, file, source);
      const onEnd = () => { eof[name] = true; file.end(); };
      const onClose = () => { if (!eof[name]) { interrupted[name] = true; file.end(); } };
      const onError = (error: unknown) => {
        interrupted[name] = true;
        captureError ??= new BashToolError("CAPTURE_FAILED", `Cannot capture Bash output: ${String(error)}`);
        requestStop("capture_failed", captureError);
      };
      sourceDisposers.push(() => {
        source.removeListener("data", onData); source.removeListener("end", onEnd);
        source.removeListener("close", onClose); source.removeListener("error", onError);
      });
      source.on("data", onData);
      source.once("end", onEnd);
      source.once("close", onClose);
      source.once("error", onError);
    }
    await spawnWait;
    checkAdmission();
    timeoutHandle = setTimeout(() => requestStop("timeout"), input.timeoutSeconds * 1_000);
    abortHandler = () => requestStop("cancelled", new BashToolError("CANCELLED", "Bash command was cancelled"));
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    updateDirty = true;
    emitUpdate();
    if (onUpdate && !progressFailed) progressHandle = setInterval(() => { updateDirty = true; emitUpdate(); }, PROGRESS_UPDATE_MS);
    resolveStarted();
    await Promise.race([
      processWait.exit.then(() => "exit" as const, (error) => {
        captureError ??= new BashToolError("CAPTURE_FAILED", String(error));
        requestStop("capture_failed", captureError);
        return "stop" as const;
      }),
      stopRequested.then(() => "stop" as const),
    ]);
    cleanup = await finishCleanup(cleanupDeadline ??= Date.now() + cleanupLimitMs);
  } catch (error) {
    if (!spawned && spawnWait) { try { await spawnWait; } catch {} }
    if (!spawned) {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      stdoutFile?.destroy();
      stderrFile?.destroy();
      if (artifact!) await removeProcessArtifact(artifact.directory);
      throw error;
    }
    const failure = error instanceof BashToolError
      ? error
      : error instanceof ProcessResultBudgetError
        ? (budgetError ??= new BashToolError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command."))
        : new BashToolError("CAPTURE_FAILED", `Cannot capture Bash process: ${String(error)}`);
    if (failure.code === "CAPTURE_FAILED") captureError ??= failure;
    requestStop(failure.code === "CANCELLED" ? (owner.signal.aborted || options.lifetimeSignal?.aborted ? "shutdown" : "cancelled")
      : failure.code === "PROCESS_CONTROL_FAILED" ? "cleanup_failed" : "capture_failed", failure);
    clearUpdates();
    try {
      cleanup = await finishCleanup(cleanupDeadline ??= Date.now() + cleanupLimitMs);
    } catch (cleanupError) {
      controlError ??= new BashToolError("PROCESS_CONTROL_FAILED", `Cannot finish Bash cleanup: ${String(cleanupError)}`);
      requestStop("cleanup_failed", controlError);
      cleanup = "failed";
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      stdoutFile?.destroy();
      stderrFile?.destroy();
      await waitForPromise(Promise.allSettled([processWait?.exit, processWait?.close, stdoutDone, stderrDone]), Math.max(0, (cleanupDeadline ?? Date.now()) - Date.now()));
    }
  } finally {
    updatesClosed = true;
    clearUpdates();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    for (const dispose of sourceDisposers) dispose();
    sourceDisposers.length = 0;
    for (const [file, callbacks] of drains) for (const resume of callbacks) file.removeListener("drain", resume);
    drains.clear();
    if (cleanup === "complete" || !spawned) {
      processWait?.dispose();
      for (const dispose of childDisposers) dispose();
      childDisposers.length = 0;
    }
    owner.signal.removeEventListener("abort", lifetimeAbort);
    options.lifetimeSignal?.removeEventListener("abort", lifetimeAbort);
  }

    const outcome = await settleResult();
    result = outcome;
    settled = true;
    resolveStarted();
    return outcome;
  })();
  Object.defineProperty(controller, "finished", { value: execution });
  execution.then((value) => {
    result = value; settled = true;
    if (cleanup === "complete") owner.controllers.delete(controller);
  }, (error) => {
    rejectStarted(error); settled = true;
    owner.signal.removeEventListener("abort", lifetimeAbort);
    options.lifetimeSignal?.removeEventListener("abort", lifetimeAbort);
    if (!spawned) owner.controllers.delete(controller);
  });
  return controller;
}
