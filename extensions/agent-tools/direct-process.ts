import { spawn, type ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  completeProcessArtifact,
  createProcessArtifact,
  pinProcessArtifact,
  verifiedProcessStreamBytes,
  finalizeProcessArtifact,
  openProcessArtifactStreams,
  removeProcessArtifact,
  type ProcessArtifact,
} from "./process-artifacts.ts";
import {
  appendCapturedProcessStream,
  capturedProcessLines,
  createCapturedProcessStream,
  DEFAULT_PROCESS_OUTPUT_BYTES,
  formatProcessFailure,
  formatProcessResult,
  formatProcessBudgetFailure,
  ProcessResultBudgetError,
  reserveProcessMetadataBytes,
  MAX_PROCESS_STREAM_BYTES,
  MAX_PROCESS_TOTAL_BYTES,
  type FormattedProcessResult,
  type ProcessEvidence,
  type ProcessStopReason,
  type ProcessToolDetails,
  type ProcessToolName,
} from "./process-output.ts";

const TERMINATE_GRACE_MS = 2_000;
const CLEANUP_LIMIT_MS = 4_000;
const FORCED_CLOSE_RESERVE_MS = 250;
const UPDATE_THROTTLE_MS = 100;
const PROGRESS_UPDATE_MS = 1_000;

export type DirectProcessErrorCode =
  | "SPAWN_FAILED"
  | "CAPTURE_FAILED"
  | "ARTIFACT_FAILED"
  | "OUTPUT_LIMIT"
  | "PROCESS_CONTROL_FAILED"
  | "CANCELLED"
  | "INTERNAL_ERROR"
  | "RESULT_BUDGET_TOO_SMALL";

export interface DirectProcessOptions {
  tool: Exclude<ProcessToolName, "bash">;
  displayName: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutSeconds: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>;
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
}

interface ProcessExit {
  code: number | null;
  signal: string | null;
}

interface ProcessWait {
  exit: Promise<ProcessExit>;
  close: Promise<void>;
}

export class DirectProcessError extends Error {
  readonly code: DirectProcessErrorCode;
  readonly detailMessage: string;

  constructor(code: DirectProcessErrorCode, message: string) {
    super(message);
    this.code = code;
    this.detailMessage = message;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function waitForProcess(child: ChildProcess): ProcessWait {
  let rejectExit: (error: unknown) => void = () => undefined;
  let rejectClose: (error: unknown) => void = () => undefined;
  const exit = new Promise<ProcessExit>((resolveExit, reject) => {
    rejectExit = reject;
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const close = new Promise<void>((resolveClose, reject) => {
    rejectClose = reject;
    child.once("close", () => resolveClose());
  });
  child.once("error", (error) => {
    rejectExit(error);
    rejectClose(error);
  });
  exit.catch(() => undefined);
  close.catch(() => undefined);
  return { exit, close };
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

function processGroupExists(child: ChildProcess): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

async function waitForGroupExit(child: ChildProcess, deadline: number): Promise<boolean> {
  while (processGroupExists(child)) {
    if (Date.now() >= deadline) return false;
    await wait(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function terminateProcessGroup(
  child: ChildProcess,
  deadline: number,
  displayName: string,
): Promise<void> {
  if (!child.pid || !processGroupExists(child)) return;
  const graceDeadline = Math.min(deadline, Date.now() + TERMINATE_GRACE_MS);
  try {
    signalProcessGroup(child, "SIGTERM");
  } catch (error) {
    if (isErrno(error, "EPERM") && await waitForGroupExit(child, graceDeadline)) return;
    throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot terminate ${displayName}: ${String(error)}`);
  }
  if (await waitForGroupExit(child, graceDeadline)) return;
  try {
    signalProcessGroup(child, "SIGKILL");
  } catch (error) {
    if (isErrno(error, "EPERM") && await waitForGroupExit(child, deadline)) return;
    throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot force terminate ${displayName}: ${String(error)}`);
  }
}

function closeStandardInput(
  stream: NodeJS.WritableStream,
  input: Buffer,
  onFailure: (error: unknown) => void,
): Promise<void> {
  return new Promise((resolveInput) => {
    let inputFinished = false;
    const finishInput = (): void => {
      if (inputFinished) return;
      inputFinished = true;
      resolveInput();
    };
    stream.on("error", (error) => {
      if (!isErrno(error, "EPIPE")) onFailure(error);
      finishInput();
    });
    try {
      stream.end(input, finishInput);
    } catch (error) {
      if (!isErrno(error, "EPIPE")) onFailure(error);
      finishInput();
    }
  });
}

async function createDirectArtifact(): Promise<ProcessArtifact> {
  try {
    return await createProcessArtifact();
  } catch (error) {
    throw new DirectProcessError("ARTIFACT_FAILED", `Cannot create output artifact: ${String(error)}`);
  }
}

/** Run Git or GitHub CLI with exact capture and bounded partial evidence. */
export async function runDirectProcess(options: DirectProcessOptions): Promise<FormattedProcessResult | ReturnType<typeof formatProcessFailure>> {
  const signal = options.signal;
  const onUpdate = options.onUpdate;
  const cwd = options.cwd;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
  if (signal?.aborted) throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
  const cleanupLimitMs = options.cleanupLimitMs ?? CLEANUP_LIMIT_MS;
  const artifact = await createDirectArtifact();
  pinProcessArtifact(artifact.directory);
  let stdoutFile: WriteStream | undefined;
  let stderrFile: WriteStream | undefined;
  let child: ChildProcess | undefined;
  let spawned = false;
  let startedAt = Date.now();
  let observedExit: ProcessExit | undefined;
  let processWait: ProcessWait | undefined;
  let stdoutDone: Promise<void> = Promise.resolve();
  let stderrDone: Promise<void> = Promise.resolve();
  let cleanup: ProcessEvidence["status"]["cleanup"] = "pending";
  let cleanupDeadline: number | undefined;
  let stopReason: ProcessStopReason = null;
  let firstFailure: DirectProcessError | undefined;
  let artifactError: DirectProcessError | undefined;
  let budgetError: DirectProcessError | undefined;
  let captureError: DirectProcessError | undefined;
  let controlError: DirectProcessError | undefined;
  const stdout = createCapturedProcessStream(artifact.stdout_path);
  const stderr = createCapturedProcessStream(artifact.stderr_path);
  const eof = { stdout: false, stderr: false };
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
  const requestStop = (reason: Exclude<ProcessStopReason, null>, failure?: DirectProcessError): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    firstFailure = failure;
    if (!eof.stdout) interrupted.stdout = true;
    if (!eof.stderr) interrupted.stderr = true;
    resolveStop();
  };
  const recordArtifactError = (name: string, error: unknown): void => {
    artifactError ??= new DirectProcessError("ARTIFACT_FAILED", `Cannot write ${name} artifact: ${String(error)}`);
    requestStop("artifact_failed", artifactError);
  };
  const evidence = (completedArtifact?: ProcessArtifact): ProcessEvidence => ({
    status: {
      exit_code: cleanup === "pending" || stopReason === "timeout" || observedExit?.signal ? null : observedExit?.code ?? null,
      signal: cleanup === "pending" ? null : observedExit?.signal ?? null,
      timed_out: stopReason === "timeout",
      duration_ms: Math.max(0, Date.now() - startedAt),
      stop_reason: stopReason,
      cleanup,
    },
    artifact: completedArtifact,
    stdout,
    stderr,
    capture: {
      stdout: eof.stdout && !interrupted.stdout ? "complete" : "incomplete",
      stderr: eof.stderr && !interrupted.stderr ? "complete" : "incomplete",
    },
  });
  const format = (completedArtifact?: ProcessArtifact): FormattedProcessResult => {
    const snapshot = evidence(completedArtifact);
    return formatProcessResult(options.tool, snapshot.status, snapshot.artifact, stdout, stderr, snapshot.capture, maxOutputBytes);
  };
  const recordProgressError = (error: unknown): void => {
    if (updatesClosed || progressFailed) return;
    progressFailed = true;
    clearUpdates();
    if (error instanceof ProcessResultBudgetError) {
      budgetError ??= new DirectProcessError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command.");
      requestStop("capture_failed", budgetError);
      return;
    }
    captureError ??= new DirectProcessError("CAPTURE_FAILED", `Cannot publish ${options.displayName} progress: ${String(error)}`);
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
            file.once("drain", () => source.resume());
          }
        } catch (error) { recordArtifactError(name, error); }
      }
      scheduleUpdate();
    } else if (data.length > 0) interrupted[name] = true;
    if (length < data.length) {
      interrupted[name] = true;
      requestStop("output_limit", new DirectProcessError("OUTPUT_LIMIT",
        `standard ${name === "stdout" ? "output" : "error"} exceeded the full-capture limit`));
    }
  };

  const finishCleanup = async (deadline: number): Promise<ProcessEvidence["status"]["cleanup"]> => {
    if (!child || !processWait || !stdoutFile || !stderrFile) {
      throw new DirectProcessError("PROCESS_CONTROL_FAILED", "Process cleanup state is not available");
    }
    const activeChild = child;
    const activeStdoutFile = stdoutFile;
    const activeStderrFile = stderrFile;
    try {
      await terminateProcessGroup(activeChild, deadline, options.displayName);
      if (!await waitForGroupExit(activeChild, deadline)) throw new Error("Process group did not exit during cleanup");
      if (!await waitForPromise(processWait.exit, Math.max(0, deadline - Date.now())) || !observedExit) {
        throw new Error(`${options.displayName} did not exit during cleanup.`);
      }
    } catch (error) {
      controlError = new DirectProcessError("PROCESS_CONTROL_FAILED", String(error));
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
          controlError ??= new DirectProcessError("PROCESS_CONTROL_FAILED", "Could not close output artifact streams");
          requestStop("cleanup_failed", controlError);
        }
      }
      if (!controlError && !await waitForPromise(processWait.close, Math.max(0, deadline - Date.now()))) {
        controlError = new DirectProcessError("PROCESS_CONTROL_FAILED", `${options.displayName} could not close output streams.`);
        requestStop("cleanup_failed", controlError);
      }
    }
    const cleaned = controlError || !observedExit || processGroupExists(activeChild) ? "failed" : "complete";
    if (cleaned === "failed") controlError ??= new DirectProcessError("PROCESS_CONTROL_FAILED", `${options.displayName} cleanup is not verified.`);
    return cleaned;
  };

  try {
    options.onArtifactCreated?.(artifact);
    if (reserveProcessMetadataBytes(options.tool, artifact) > maxOutputBytes) {
      throw new DirectProcessError("RESULT_BUDGET_TOO_SMALL", "Process metadata exceeds max_output_bytes; the process did not run.");
    }
    try {
      const streams = await openProcessArtifactStreams(artifact);
      stdoutFile = streams.stdout;
      stderrFile = streams.stderr;
    } catch (error) {
      throw new DirectProcessError("ARTIFACT_FAILED", `Cannot open output files: ${String(error)}`);
    }
    if (signal?.aborted) throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
    const activeStdoutFile = stdoutFile;
    const activeStderrFile = stderrFile;
    stdoutDone = finished(activeStdoutFile).catch((error) => recordArtifactError("standard output", error));
    stderrDone = finished(activeStderrFile).catch((error) => recordArtifactError("standard error", error));
    try {
      child = spawn(options.executable, options.args, { cwd, detached: true, env: options.environment, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new DirectProcessError("SPAWN_FAILED", `Cannot start ${options.displayName}: ${String(error)}`);
    }
    const activeChild = child;
    processWait = waitForProcess(activeChild);
    activeChild.once("exit", (code, signal) => { observedExit = { code, signal }; });
    activeChild.stdout?.on("data", (data: Buffer) => recordOutput("stdout", data, activeStdoutFile, activeChild.stdout!));
    activeChild.stderr?.on("data", (data: Buffer) => recordOutput("stderr", data, activeStderrFile, activeChild.stderr!));
    for (const [name, source, file] of [
      ["stdout", activeChild.stdout, activeStdoutFile],
      ["stderr", activeChild.stderr, activeStderrFile],
    ] as const) {
      source?.once("end", () => { eof[name] = true; file.end(); });
      source?.once("close", () => { if (!eof[name]) { interrupted[name] = true; file.end(); } });
      source?.once("error", (error) => {
        interrupted[name] = true;
        captureError ??= new DirectProcessError("CAPTURE_FAILED", `Cannot capture ${options.displayName} output: ${String(error)}`);
        requestStop("capture_failed", captureError);
      });
      if (!source) { eof[name] = true; file.end(); }
    }
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      activeChild.once("spawn", () => { spawned = true; startedAt = Date.now(); resolveSpawn(); });
      activeChild.once("error", (error: NodeJS.ErrnoException) => rejectSpawn(new DirectProcessError(
        "SPAWN_FAILED", `Cannot start ${options.displayName}: ${error.message}`,
      )));
    });
    timeoutHandle = setTimeout(() => requestStop("timeout"), options.timeoutSeconds * 1_000);
    abortHandler = () => requestStop("cancelled", new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`));
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    updateDirty = true;
    emitUpdate();
    if (onUpdate && !progressFailed) progressHandle = setInterval(() => { updateDirty = true; emitUpdate(); }, PROGRESS_UPDATE_MS);
    const stdinDone = activeChild.stdin ? closeStandardInput(activeChild.stdin, Buffer.from(options.stdin ?? "", "utf8"), (error) => {
      requestStop("capture_failed", new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot write ${options.displayName} standard input: ${String(error)}`));
    }) : Promise.resolve();
    const completion = Promise.all([processWait.exit, processWait.close, stdoutDone, stderrDone, stdinDone]);
    await Promise.race([
      completion.then(() => "exit" as const, (error) => {
        captureError ??= new DirectProcessError("CAPTURE_FAILED", String(error));
        requestStop("capture_failed", captureError);
        return "stop" as const;
      }),
      stopRequested.then(() => "stop" as const),
    ]);
    cleanup = await finishCleanup(cleanupDeadline ??= Date.now() + cleanupLimitMs);
  } catch (error) {
    if (!spawned) {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      stdoutFile?.destroy();
      stderrFile?.destroy();
      await removeProcessArtifact(artifact.directory);
      throw error;
    }
    const failure = error instanceof DirectProcessError
      ? error
      : error instanceof ProcessResultBudgetError
        ? (budgetError ??= new DirectProcessError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command."))
        : new DirectProcessError("CAPTURE_FAILED", `Cannot capture ${options.displayName} process: ${String(error)}`);
    if (failure.code === "CAPTURE_FAILED") captureError ??= failure;
    requestStop(failure.code === "PROCESS_CONTROL_FAILED" ? "cleanup_failed" : "capture_failed", failure);
    clearUpdates();
    try {
      cleanup = await finishCleanup(cleanupDeadline ??= Date.now() + cleanupLimitMs);
    } catch (cleanupError) {
      controlError ??= new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot finish ${options.displayName} cleanup: ${String(cleanupError)}`);
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
  }

  for (const [name, capture, path] of [["stdout", stdout, artifact.stdout_path], ["stderr", stderr, artifact.stderr_path]] as const) {
    const saved = await verifiedProcessStreamBytes(path);
    capture.path = saved === undefined || (saved === 0 && capture.totalBytes > 0) ? undefined : path;
    if (saved !== capture.totalBytes) {
      if (saved !== undefined) capture.savedRawBytes = saved;
      interrupted[name] = true;
      artifactError ??= new DirectProcessError("ARTIFACT_FAILED", `Cannot save all ${name} bytes`);
      requestStop("artifact_failed", artifactError);
    }
  }
  let completedArtifact: ProcessArtifact | undefined;
  let failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  let preliminary: FormattedProcessResult | undefined;
  try {
    preliminary = format();
  } catch {
    budgetError ??= new DirectProcessError("RESULT_BUDGET_TOO_SMALL", "The process did run, but its preview exceeds max_output_bytes. Read its saved output. Do not rerun the command.");
    requestStop("capture_failed", budgetError);
    failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  }
  if (cleanup === "complete") {
    try {
      if (!failure && preliminary && !preliminary.needsArtifact) {
        await finalizeProcessArtifact(artifact, "when-needed", false);
      } else if (!budgetError && failure && stdout.totalBytes === 0 && stderr.totalBytes === 0 && !artifactError) {
        await finalizeProcessArtifact(artifact, "when-needed", false);
        stdout.path = undefined;
        stderr.path = undefined;
      } else {
        const completedAt = Date.now();
        completedArtifact = await completeProcessArtifact(artifact, completedAt, {
          id: artifact.id, tool: options.tool, cwd, started_at: startedAt, finished_at: completedAt,
          ...evidence().status,
          streams_complete: evidence().capture.stdout === "complete" && evidence().capture.stderr === "complete",
          stdout: { bytes: stdout.totalBytes, lines: capturedProcessLines(stdout) },
          stderr: { bytes: stderr.totalBytes, lines: capturedProcessLines(stderr) },
        });
      }
    } catch (error) {
      artifactError ??= new DirectProcessError("ARTIFACT_FAILED", `Cannot complete output artifact: ${String(error)}`);
      requestStop("artifact_failed", artifactError);
      pinProcessArtifact(artifact.directory);
    }
  }
  failure = controlError ?? artifactError ?? budgetError ?? firstFailure ?? captureError;
  if (failure) {
    const cause = firstFailure && firstFailure !== failure ? `; first stop: ${firstFailure.code}: ${firstFailure.detailMessage}` : "";
    const captureCause = captureError && captureError !== failure && captureError !== firstFailure
      ? `; capture: ${captureError.code}: ${captureError.detailMessage}` : "";
    return formatProcessFailure(options.tool, failure.code, failure.detailMessage + cause + captureCause, evidence(completedArtifact), maxOutputBytes);
  }
  if (preliminary && !preliminary.needsArtifact) return preliminary;
  try {
    return format(completedArtifact);
  } catch {
    return formatProcessBudgetFailure(options.tool, evidence(completedArtifact));
  }
}
