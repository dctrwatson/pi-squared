import { spawn, type ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import {
  createProcessArtifact,
  finalizeProcessArtifact,
  openProcessArtifactStreams,
  removeProcessArtifact,
  writeProcessArtifactMetadata,
  type ProcessArtifact,
} from "./process-artifacts.ts";
import {
  appendCapturedProcessStream,
  capturedProcessLines,
  createCapturedProcessStream,
  formatProcessResult,
  MAX_PROCESS_STREAM_BYTES,
  MAX_PROCESS_TOTAL_BYTES,
  type CapturedProcessStream,
  type FormattedProcessResult,
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
  | "INTERNAL_ERROR";

export interface DirectProcessOptions {
  tool: Exclude<ProcessToolName, "bash">;
  displayName: string;
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<ProcessToolDetails>;
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
}

interface ProcessExit {
  code: number | null;
  signal: string | null;
}

interface ProcessWait {
  exit: Promise<ProcessExit>;
  close: Promise<void>;
}

type Completion = Promise<[ProcessExit, void, void, void, void, void, void]>;
type StopReason = "timeout" | "cancelled" | "input" | "capture" | "artifact" | "output-limit";

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
  close.catch(() => undefined);
  return { exit, close };
}

function waitForStreamEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolveEnd) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveEnd();
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
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
  try {
    signalProcessGroup(child, "SIGTERM");
  } catch (error) {
    throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot terminate ${displayName}: ${String(error)}`);
  }
  const graceDeadline = Math.min(deadline, Date.now() + TERMINATE_GRACE_MS);
  if (await waitForGroupExit(child, graceDeadline)) return;
  try {
    signalProcessGroup(child, "SIGKILL");
  } catch (error) {
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

async function drainAfterStop(
  child: ChildProcess,
  completion: Completion,
  deadline: number,
  displayName: string,
): Promise<ProcessExit> {
  await terminateProcessGroup(child, deadline, displayName);
  const groupExited = waitForGroupExit(child, deadline);
  let complete = await waitForPromise(
    Promise.all([completion, groupExited]),
    Math.max(0, deadline - FORCED_CLOSE_RESERVE_MS - Date.now()),
  );
  if (!complete) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    complete = await waitForPromise(
      Promise.all([completion, groupExited]),
      Math.max(0, deadline - Date.now()),
    );
  }
  if (!complete || processGroupExists(child)) {
    throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot finish ${displayName} process cleanup.`);
  }
  try {
    const [exit] = await completion;
    return exit;
  } catch (error) {
    throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot reap ${displayName}: ${String(error)}`);
  }
}

async function createDirectArtifact(): Promise<ProcessArtifact> {
  try {
    return await createProcessArtifact();
  } catch (error) {
    throw new DirectProcessError("ARTIFACT_FAILED", `Cannot create output artifact: ${String(error)}`);
  }
}

async function writeDirectMetadata(
  artifact: ProcessArtifact,
  options: DirectProcessOptions,
  startedAt: number,
  status: { exit_code: number | null; signal: string | null; timed_out: boolean; duration_ms: number },
  stdout: CapturedProcessStream,
  stderr: CapturedProcessStream,
  stdoutComplete: boolean,
  stderrComplete: boolean,
): Promise<void> {
  try {
    await writeProcessArtifactMetadata(artifact, {
      id: artifact.id,
      tool: options.tool,
      started_at: startedAt,
      finished_at: Date.now(),
      cwd: options.cwd,
      ...status,
      streams_complete: stdoutComplete && stderrComplete,
      stdout: { bytes: stdout.totalBytes, lines: capturedProcessLines(stdout), complete: stdoutComplete },
      stderr: { bytes: stderr.totalBytes, lines: capturedProcessLines(stderr), complete: stderrComplete },
    });
  } catch (error) {
    throw new DirectProcessError("ARTIFACT_FAILED", `Cannot write artifact metadata: ${String(error)}`);
  }
}

function recordOutput(
  capture: CapturedProcessStream,
  other: CapturedProcessStream,
  data: Buffer,
  file: WriteStream,
  source: NodeJS.ReadableStream,
  streamName: string,
  state: {
    artifactFailure?: unknown;
    outputLimitFailure?: DirectProcessError;
  },
  requestStop: (reason: StopReason) => void,
  onOutput?: () => void,
): void {
  const streamSpace = Math.max(0, MAX_PROCESS_STREAM_BYTES - capture.totalBytes);
  const totalSpace = Math.max(0, MAX_PROCESS_TOTAL_BYTES - capture.totalBytes - other.totalBytes);
  const writeLength = Math.min(data.length, streamSpace, totalSpace);
  if (writeLength > 0 && !state.artifactFailure && !state.outputLimitFailure) {
    const captured = data.subarray(0, writeLength);
    appendCapturedProcessStream(capture, captured);
    onOutput?.();
    try {
      if (!file.write(captured)) {
        source.pause();
        file.once("drain", () => source.resume());
      }
    } catch (error) {
      state.artifactFailure ??= error;
      requestStop("artifact");
    }
  }
  if (writeLength < data.length) {
    state.outputLimitFailure ??= new DirectProcessError("OUTPUT_LIMIT", `${streamName} exceeded the full-capture limit.`);
    requestStop("output-limit");
  }
}

/** Run Git or GitHub CLI with shared exact capture and bounded output. */
export async function runDirectProcess(options: DirectProcessOptions): Promise<FormattedProcessResult> {
  if (options.signal?.aborted) {
    throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
  }
  const artifact = await createDirectArtifact();
  let stdoutFile: WriteStream | undefined;
  let stderrFile: WriteStream | undefined;
  let child: ChildProcess | undefined;

  try {
    options.onArtifactCreated?.(artifact);
    try {
      const streams = await openProcessArtifactStreams(artifact);
      stdoutFile = streams.stdout;
      stderrFile = streams.stderr;
    } catch (error) {
      throw new DirectProcessError("ARTIFACT_FAILED", `Cannot open output files: ${String(error)}`);
    }

    const stdout = createCapturedProcessStream(artifact.stdout_path);
    const stderr = createCapturedProcessStream(artifact.stderr_path);
    let stdoutComplete = false;
    let stderrComplete = false;
    let captureFailure: unknown;
    let inputFailure: unknown;
    let stopReason: StopReason | undefined;
    let requestStop: (reason: StopReason) => void = () => undefined;
    const stopRequested = new Promise<StopReason>((resolveStop) => {
      requestStop = (reason) => {
        if (stopReason) return;
        stopReason = reason;
        resolveStop(reason);
      };
    });
    const outputState: {
      artifactFailure?: unknown;
      outputLimitFailure?: DirectProcessError;
    } = {};

    if (options.signal?.aborted) {
      throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
    }

    const startedAt = Date.now();
    let updateHandle: NodeJS.Timeout | undefined;
    let progressHandle: NodeJS.Timeout | undefined;
    let updateDirty = false;
    let lastUpdateAt = 0;
    const clearUpdate = (): void => {
      if (updateHandle) clearTimeout(updateHandle);
      updateHandle = undefined;
    };
    const clearProgress = (): void => {
      if (progressHandle) clearInterval(progressHandle);
      progressHandle = undefined;
    };
    const emitUpdate = (): void => {
      if (!options.onUpdate || !updateDirty) return;
      updateDirty = false;
      lastUpdateAt = Date.now();
      const result = formatProcessResult(
        options.tool,
        {
          exit_code: null,
          signal: null,
          timed_out: stopReason === "timeout",
          duration_ms: Date.now() - startedAt,
        },
        artifact,
        stdout,
        stderr,
        { stdout: "incomplete", stderr: "incomplete" },
      );
      options.onUpdate({
        content: [{ type: "text", text: result.text }],
        details: result.details,
      });
    };
    const scheduleUpdate = (): void => {
      if (!options.onUpdate) return;
      updateDirty = true;
      const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
      if (delay <= 0) {
        clearUpdate();
        emitUpdate();
        return;
      }
      updateHandle ??= setTimeout(() => {
        updateHandle = undefined;
        emitUpdate();
      }, delay);
    };
    updateDirty = true;
    emitUpdate();
    if (options.onUpdate) {
      progressHandle = setInterval(() => {
        updateDirty = true;
        emitUpdate();
      }, PROGRESS_UPDATE_MS);
    }
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.environment,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new DirectProcessError("SPAWN_FAILED", `Cannot start ${options.displayName}: ${String(error)}`);
    }
    if (!child.stdout || !child.stderr || !child.stdin) {
      throw new DirectProcessError("SPAWN_FAILED", `${options.displayName} did not provide standard streams.`);
    }

    const activeChild = child;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    const activeStdoutFile = stdoutFile;
    const activeStderrFile = stderrFile;
    childStdout.on("data", (chunk: Buffer) => recordOutput(
      stdout,
      stderr,
      Buffer.from(chunk),
      activeStdoutFile,
      childStdout,
      `${options.displayName} standard output`,
      outputState,
      requestStop,
      scheduleUpdate,
    ));
    childStderr.on("data", (chunk: Buffer) => recordOutput(
      stderr,
      stdout,
      Buffer.from(chunk),
      activeStderrFile,
      childStderr,
      `${options.displayName} standard error`,
      outputState,
      requestStop,
      scheduleUpdate,
    ));
    childStdout.once("end", () => {
      stdoutComplete = true;
      activeStdoutFile.end();
    });
    childStderr.once("end", () => {
      stderrComplete = true;
      activeStderrFile.end();
    });
    childStdout.once("close", () => {
      if (!stdoutComplete) activeStdoutFile.end();
    });
    childStderr.once("close", () => {
      if (!stderrComplete) activeStderrFile.end();
    });
    childStdout.once("error", (error) => {
      captureFailure ??= error;
      requestStop("capture");
    });
    childStderr.once("error", (error) => {
      captureFailure ??= error;
      requestStop("capture");
    });
    activeStdoutFile.once("error", (error) => {
      outputState.artifactFailure ??= error;
      requestStop("artifact");
    });
    activeStderrFile.once("error", (error) => {
      outputState.artifactFailure ??= error;
      requestStop("artifact");
    });

    const processWait = waitForProcess(activeChild);
    const stdoutEnd = waitForStreamEnd(childStdout);
    const stderrEnd = waitForStreamEnd(childStderr);
    const stdoutFileDone = finished(activeStdoutFile).catch((error) => {
      outputState.artifactFailure ??= error;
      requestStop("artifact");
    });
    const stderrFileDone = finished(activeStderrFile).catch((error) => {
      outputState.artifactFailure ??= error;
      requestStop("artifact");
    });

    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    timeoutHandle = setTimeout(() => requestStop("timeout"), options.timeoutSeconds * 1_000);
    abortHandler = () => requestStop("cancelled");
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (options.signal?.aborted) requestStop("cancelled");

    const stdinBytes = Buffer.from(options.stdin ?? "", "utf8");
    const stdinDone = closeStandardInput(childStdin, stdinBytes, (error) => {
      inputFailure ??= error;
      requestStop("input");
    });
    const completion: Completion = Promise.all([
      processWait.exit,
      processWait.close,
      stdoutEnd,
      stderrEnd,
      stdinDone,
      stdoutFileDone,
      stderrFileDone,
    ]);

    try {
      const first = await Promise.race([
        completion.then(
          (value) => ({ kind: "complete" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        ),
        stopRequested.then((reason) => ({ kind: "stop" as const, reason })),
      ]);

      let exit: ProcessExit;
      let timedOut = false;
      if (first.kind === "error") {
        throw new DirectProcessError("SPAWN_FAILED", `Cannot run ${options.displayName}: ${String(first.error)}`);
      }
      if (first.kind === "stop") {
        const deadline = Date.now() + CLEANUP_LIMIT_MS;
        exit = await drainAfterStop(activeChild, completion, deadline, options.displayName);
        if (first.reason === "input" || inputFailure) {
          throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot write ${options.displayName} standard input.`);
        }
        if (first.reason === "cancelled" || options.signal?.aborted) {
          throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
        }
        if (first.reason === "capture" || captureFailure) {
          throw new DirectProcessError("CAPTURE_FAILED", `Cannot capture ${options.displayName} output: ${String(captureFailure)}`);
        }
        if (first.reason === "artifact" || outputState.artifactFailure) {
          throw new DirectProcessError("ARTIFACT_FAILED", `Cannot write ${options.displayName} output artifact: ${String(outputState.artifactFailure)}`);
        }
        if (first.reason === "output-limit" || outputState.outputLimitFailure) {
          throw outputState.outputLimitFailure;
        }
        timedOut = true;
      } else {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
        const cleanupDeadline = Date.now() + CLEANUP_LIMIT_MS;
        await terminateProcessGroup(activeChild, cleanupDeadline, options.displayName);
        if (!await waitForGroupExit(activeChild, cleanupDeadline)) {
          throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot finish ${options.displayName} process cleanup.`);
        }
        if (options.signal?.aborted) {
          throw new DirectProcessError("CANCELLED", `${options.displayName} command was cancelled.`);
        }
        if (inputFailure) {
          throw new DirectProcessError("PROCESS_CONTROL_FAILED", `Cannot write ${options.displayName} standard input.`);
        }
        if (captureFailure) {
          throw new DirectProcessError("CAPTURE_FAILED", `Cannot capture ${options.displayName} output: ${String(captureFailure)}`);
        }
        if (outputState.artifactFailure) {
          throw new DirectProcessError("ARTIFACT_FAILED", `Cannot write ${options.displayName} output artifact: ${String(outputState.artifactFailure)}`);
        }
        if (outputState.outputLimitFailure) throw outputState.outputLimitFailure;
        [exit] = first.value;
      }

      const status = {
        exit_code: timedOut || exit.signal ? null : exit.code,
        signal: exit.signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
      };
      clearUpdate();
      clearProgress();
      await writeDirectMetadata(
        artifact,
        options,
        startedAt,
        status,
        stdout,
        stderr,
        stdoutComplete,
        stderrComplete,
      );
      const formatted = formatProcessResult(
        options.tool,
        status,
        artifact,
        stdout,
        stderr,
        {
          stdout: stdoutComplete ? "complete" : "incomplete",
          stderr: stderrComplete ? "complete" : "incomplete",
        },
      );
      let retained: boolean;
      try {
        retained = await finalizeProcessArtifact(artifact, "when-needed", formatted.needsArtifact);
      } catch (error) {
        throw new DirectProcessError("ARTIFACT_FAILED", String(error));
      }
      if (retained) return formatted;
      const { artifact: _artifact, ...details } = formatted.details;
      return { ...formatted, details };
    } finally {
      clearUpdate();
      clearProgress();
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    }
  } catch (error) {
    if (child && processGroupExists(child)) {
      await terminateProcessGroup(child, Date.now() + CLEANUP_LIMIT_MS, options.displayName).catch(() => undefined);
    }
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    stdoutFile?.destroy();
    stderrFile?.destroy();
    if (!await removeProcessArtifact(artifact.directory)) {
      throw new DirectProcessError("ARTIFACT_FAILED", "Cannot remove the incomplete output artifact.");
    }
    throw error;
  }
}
