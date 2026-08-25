import { spawn, type ChildProcess } from "node:child_process";
import { constants, type WriteStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  createProcessArtifact,
  openProcessArtifactStreams,
  removeProcessArtifact,
  writeProcessArtifactMetadata,
  type ProcessArtifact,
} from "./process-artifacts.ts";
import {
  appendCapturedProcessStream,
  capturedProcessLines,
  createCapturedProcessStream,
  formatProcessFailure,
  formatProcessResult,
  MAX_PROCESS_STREAM_BYTES,
  MAX_PROCESS_TOTAL_BYTES,
  type CapturedProcessStream,
  type FormattedProcessResult,
  type ProcessToolDetails,
} from "./process-output.ts";
import {
  renderPreview,
  renderTruncatedToolCall,
  safeRenderArgument,
  textContent,
} from "./tool-render.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_COMMAND_BYTES = 262_144;
const STOP_GRACE_MS = 2_000;
const STOP_FORCE_WAIT_MS = 2_000;
const FORCED_CLOSE_RESERVE_MS = 250;
const UPDATE_THROTTLE_MS = 100;
const PROGRESS_UPDATE_MS = 1_000;

export const codexBashParameters = Type.Object({
  command: Type.String({ description: "Bash source text to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
  timeout_seconds: Type.Optional(Type.Number({ description: "Maximum run time in seconds; default: 120; range: 0.1 through 3600" })),
});

const bashParameters = codexBashParameters;

export type CodexBashInput = Static<typeof bashParameters>;

export type BashErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "SHELL_NOT_FOUND"
  | "SPAWN_FAILED"
  | "ARTIFACT_FAILED"
  | "OUTPUT_LIMIT"
  | "PROCESS_CONTROL_FAILED"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export type BashToolDetails = ProcessToolDetails;

export interface CodexBashToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
}

export interface NormalizedBashInput {
  command: string;
  cwd?: string;
  timeoutSeconds: number;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

class BashToolError extends Error {
  readonly code: BashErrorCode;
  readonly detailMessage: string;

  constructor(code: BashErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.detailMessage = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeInput(rawInput: unknown): NormalizedBashInput {
  if (!isRecord(rawInput)) throw new BashToolError("INVALID_INPUT", "Input must be an object");
  const allowedKeys = new Set(["command", "cwd", "timeout_seconds"]);
  const unknownKey = Object.keys(rawInput).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new BashToolError("INVALID_INPUT", `Unknown input field: ${unknownKey}`);

  if (
    typeof rawInput.command !== "string" ||
    Buffer.byteLength(rawInput.command) === 0 ||
    Buffer.byteLength(rawInput.command) > MAX_COMMAND_BYTES ||
    !/\S/.test(rawInput.command) ||
    rawInput.command.includes("\0")
  ) {
    throw new BashToolError("INVALID_INPUT", "command must contain 1 through 262144 UTF-8 bytes and non-whitespace text");
  }
  if (rawInput.cwd !== undefined && (typeof rawInput.cwd !== "string" || rawInput.cwd.includes("\0"))) {
    throw new BashToolError("INVALID_INPUT", "cwd must be a string without NUL");
  }
  if (
    rawInput.timeout_seconds !== undefined &&
    (typeof rawInput.timeout_seconds !== "number" ||
      !Number.isFinite(rawInput.timeout_seconds) ||
      rawInput.timeout_seconds < 0.1 ||
      rawInput.timeout_seconds > 3_600)
  ) {
    throw new BashToolError("INVALID_INPUT", "timeout_seconds must be from 0.1 through 3600");
  }

  return {
    command: rawInput.command,
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

function prepareBashArguments(rawInput: unknown): CodexBashInput {
  if (!isRecord(rawInput)) return { command: "\0" } as CodexBashInput;
  const prepared: Record<string, unknown> = { ...rawInput };
  if (typeof prepared.command !== "string") prepared.command = "\0";
  if (prepared.cwd !== undefined && typeof prepared.cwd !== "string") prepared.cwd = "\0";
  if (
    prepared.timeout_seconds !== undefined &&
    (typeof prepared.timeout_seconds !== "number" || !Number.isFinite(prepared.timeout_seconds))
  ) {
    prepared.timeout_seconds = -1;
  }
  return prepared as CodexBashInput;
}

export async function validateCwd(input: NormalizedBashInput, sessionCwd: string): Promise<string> {
  const cwd = resolve(sessionCwd, input.cwd ?? ".");
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new BashToolError("INVALID_CWD", "cwd is not a directory");
    await access(cwd, constants.R_OK | constants.X_OK);
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
  const onError = (error: unknown) => {
    rejectExit(error);
    rejectClose(error);
  };
  child.once("error", onError);
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
  signalProcessGroup(child, "SIGTERM");
  const grace = Math.min(STOP_GRACE_MS, Math.max(0, deadline - Date.now()));
  if (await waitForProcessGroupGone(child, grace)) return;

  signalProcessGroup(child, "SIGKILL");
  const remaining = Math.max(0, deadline - Date.now());
  if (!await waitForProcessGroupGone(child, remaining)) {
    throw new BashToolError("PROCESS_CONTROL_FAILED", "Could not terminate the Bash process group");
  }
}

function environmentForTool(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  delete env.GH_FORCE_TTY;
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.GH_PAGER = "cat";
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

async function writeMetadata(
  artifact: ProcessArtifact,
  cwd: string,
  startedAt: number,
  exit: ProcessExit,
  timedOut: boolean,
  streamsComplete: boolean,
  stdout: CapturedProcessStream,
  stderr: CapturedProcessStream,
): Promise<void> {
  try {
    await writeProcessArtifactMetadata(artifact, {
      id: artifact.id,
      started_at: startedAt,
      finished_at: Date.now(),
      cwd,
      exit_code: timedOut || exit.signal ? null : exit.code,
      signal: exit.signal,
      timed_out: timedOut,
      duration_ms: Date.now() - startedAt,
      streams_complete: streamsComplete,
      stdout: { bytes: stdout.totalBytes, lines: capturedProcessLines(stdout) },
      stderr: { bytes: stderr.totalBytes, lines: capturedProcessLines(stderr) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BashToolError("ARTIFACT_FAILED", `Cannot write artifact metadata: ${message}`);
  }
}

function streamFailure(streamName: string, error: unknown): BashToolError {
  const message = error instanceof Error ? error.message : String(error);
  return new BashToolError("ARTIFACT_FAILED", `Cannot write ${streamName} artifact: ${message}`);
}

function buildSuccessResult(
  exit: ProcessExit,
  timedOut: boolean,
  durationMs: number,
  artifact: ProcessArtifact,
  stdout: CapturedProcessStream,
  stderr: CapturedProcessStream,
  captureComplete: { stdout: boolean; stderr: boolean },
): FormattedProcessResult {
  try {
    return formatProcessResult(
      "bash",
      {
        exit_code: timedOut || exit.signal ? null : exit.code,
        signal: exit.signal,
        timed_out: timedOut,
        duration_ms: durationMs,
      },
      artifact,
      stdout,
      stderr,
      {
        stdout: captureComplete.stdout ? "complete" : "incomplete",
        stderr: captureComplete.stderr ? "complete" : "incomplete",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BashToolError("INTERNAL_ERROR", message);
  }
}

async function runBash(
  input: NormalizedBashInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails> | undefined,
  onArtifactCreated?: (artifact: ProcessArtifact) => void,
): Promise<FormattedProcessResult> {
  if (signal?.aborted) throw new BashToolError("CANCELLED", "Bash command was cancelled");
  const artifact = await createBashArtifact();
  onArtifactCreated?.(artifact);
  let stdoutFile: WriteStream;
  let stderrFile: WriteStream;
  try {
    const streams = await openProcessArtifactStreams(artifact);
    stdoutFile = streams.stdout;
    stderrFile = streams.stderr;
  } catch (error) {
    await removeProcessArtifact(artifact.directory);
    const message = error instanceof Error ? error.message : String(error);
    throw new BashToolError("ARTIFACT_FAILED", `Cannot open output files: ${message}`);
  }
  if (signal?.aborted) {
    stdoutFile.destroy();
    stderrFile.destroy();
    await removeProcessArtifact(artifact.directory);
    throw new BashToolError("CANCELLED", "Bash command was cancelled");
  }
  const stdout = createCapturedProcessStream(artifact.stdout_path);
  const stderr = createCapturedProcessStream(artifact.stderr_path);
  const startedAt = Date.now();
  let child: ChildProcess | undefined;
  let childExit: Promise<ProcessExit> | undefined;
  let childClose: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopError: BashToolError | undefined;
  let artifactError: BashToolError | undefined;
  let outputLimitError: BashToolError | undefined;
  let timedOut = false;
  let cancelled = false;
  let forcedOutputClose = false;
  let stdoutComplete = false;
  let stderrComplete = false;
  let cleanupStartedAt: number | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let updateHandle: NodeJS.Timeout | undefined;
  let progressHandle: NodeJS.Timeout | undefined;
  let updateDirty = false;
  let lastUpdateAt = 0;
  let abortHandler: (() => void) | undefined;
  let resolveStopRequested: () => void = () => undefined;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStopRequested = resolve;
  });

  const emitUpdate = (): void => {
    if (!onUpdate || !updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();
    const result = buildSuccessResult(
      { code: null, signal: null },
      timedOut,
      Date.now() - startedAt,
      artifact,
      stdout,
      stderr,
      { stdout: false, stderr: false },
    );
    onUpdate({
      content: [{ type: "text", text: result.text }],
      details: result.details,
    });
  };
  const clearUpdate = (): void => {
    if (updateHandle) clearTimeout(updateHandle);
    updateHandle = undefined;
  };
  const scheduleUpdate = (): void => {
    if (!onUpdate) return;
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

  const requestStop = (): void => {
    cleanupStartedAt ??= Date.now();
    resolveStopRequested();
    if (!child || !childExit || stopPromise) return;
    stopPromise = terminateProcessGroup(child, STOP_GRACE_MS + STOP_FORCE_WAIT_MS).catch((error: unknown) => {
      stopError = error instanceof BashToolError
        ? error
        : new BashToolError("PROCESS_CONTROL_FAILED", String(error));
    });
  };
  const recordArtifactError = (streamName: string, error: unknown): void => {
    artifactError ??= streamFailure(streamName, error);
    requestStop();
  };
  const recordOutput = (
    capture: CapturedProcessStream,
    other: CapturedProcessStream,
    data: Buffer,
    streamName: string,
    file: WriteStream,
    source: NodeJS.ReadableStream,
  ): void => {
    const streamSpace = Math.max(0, MAX_PROCESS_STREAM_BYTES - capture.totalBytes);
    const totalSpace = Math.max(0, MAX_PROCESS_TOTAL_BYTES - capture.totalBytes - other.totalBytes);
    const writeLength = Math.min(data.length, streamSpace, totalSpace);
    if (writeLength > 0 && !outputLimitError) {
      const captured = data.subarray(0, writeLength);
      appendCapturedProcessStream(capture, captured);
      scheduleUpdate();
      try {
        if (!file.write(captured)) {
          source.pause();
          file.once("drain", () => source.resume());
        }
      } catch (error) {
        recordArtifactError(streamName, error);
      }
    }
    if (writeLength < data.length) {
      outputLimitError ??= new BashToolError("OUTPUT_LIMIT", `${streamName} exceeded the full-capture limit`);
      requestStop();
    }
  };

  const stdoutDone = finished(stdoutFile).catch((error: unknown) => {
    recordArtifactError("standard output", error);
  });
  const stderrDone = finished(stderrFile).catch((error: unknown) => {
    recordArtifactError("standard error", error);
  });

  updateDirty = true;
  emitUpdate();
  if (onUpdate) {
    progressHandle = setInterval(() => {
      updateDirty = true;
      emitUpdate();
    }, PROGRESS_UPDATE_MS);
  }

  try {
    stdoutFile.on("error", (error) => recordArtifactError("standard output", error));
    stderrFile.on("error", (error) => recordArtifactError("standard error", error));

    try {
      child = spawn("bash", ["-c", input.command], {
        cwd,
        detached: true,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BashToolError("SPAWN_FAILED", `Cannot start bash: ${message}`);
    }

    const activeChild = child;
    if (!activeChild) throw new BashToolError("SPAWN_FAILED", "Bash did not start");
    const processWait = waitForProcess(activeChild);
    childExit = processWait.exit;
    childClose = processWait.close;
    activeChild.stdout?.on("data", (chunk: Buffer) => recordOutput(
      stdout,
      stderr,
      Buffer.from(chunk),
      "standard output",
      stdoutFile,
      activeChild.stdout!,
    ));
    activeChild.stderr?.on("data", (chunk: Buffer) => recordOutput(
      stderr,
      stdout,
      Buffer.from(chunk),
      "standard error",
      stderrFile,
      activeChild.stderr!,
    ));
    activeChild.stdout?.once("end", () => {
      stdoutComplete = true;
      stdoutFile.end();
    });
    activeChild.stderr?.once("end", () => {
      stderrComplete = true;
      stderrFile.end();
    });
    if (!activeChild.stdout) {
      stdoutComplete = true;
      stdoutFile.end();
    }
    if (!activeChild.stderr) {
      stderrComplete = true;
      stderrFile.end();
    }

    try {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        requestStop();
      }, input.timeoutSeconds * 1_000);
      abortHandler = () => {
        cancelled = true;
        requestStop();
      };
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });

      let exit: ProcessExit;
      const firstEvent = await Promise.race([
        childExit.then(
          (value) => ({ kind: "exit" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        ),
        stopRequested.then(() => ({ kind: "stop" as const })),
      ]);

      if (firstEvent.kind === "error") {
        const error = firstEvent.error;
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new BashToolError("SHELL_NOT_FOUND", "Cannot find bash in PATH");
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new BashToolError("SPAWN_FAILED", `Cannot run bash: ${message}`);
      }
      if (firstEvent.kind === "stop") {
        requestStop();
        if (stopPromise) await stopPromise;
        if (stopError) throw stopError;
        const cleanupDeadline = (cleanupStartedAt ?? Date.now()) + STOP_GRACE_MS + STOP_FORCE_WAIT_MS;
        if (!await waitForPromise(childExit, Math.max(0, cleanupDeadline - Date.now()))) {
          throw new BashToolError("PROCESS_CONTROL_FAILED", "Bash did not exit during cleanup");
        }
        try {
          exit = await childExit;
        } catch (error) {
          throw new BashToolError("PROCESS_CONTROL_FAILED", `Could not reap Bash: ${String(error)}`);
        }
      } else {
        exit = firstEvent.value;
      }

      if (!stopPromise) {
        cleanupStartedAt ??= Date.now();
        stopPromise = terminateProcessGroup(child, STOP_GRACE_MS + STOP_FORCE_WAIT_MS);
      }
      await stopPromise;
      if (stopError) throw stopError;

      const cleanupDeadline = (cleanupStartedAt ?? Date.now()) + STOP_GRACE_MS + STOP_FORCE_WAIT_MS;
      const drainDeadline = cleanupDeadline - FORCED_CLOSE_RESERVE_MS;
      const drained = await waitForPromise(
        Promise.all([childClose ?? Promise.resolve(), stdoutDone, stderrDone]),
        Math.max(0, drainDeadline - Date.now()),
      );
      if (!drained) {
        forcedOutputClose = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        stdoutFile.end();
        stderrFile.end();
        const closeBudget = Math.max(0, cleanupDeadline - Date.now());
        const [outputsFlushed, childClosed] = await Promise.all([
          waitForPromise(Promise.all([stdoutDone, stderrDone]), closeBudget),
          childClose ? waitForPromise(childClose, closeBudget) : Promise.resolve(true),
        ]);
        if (!outputsFlushed) {
          throw new BashToolError("ARTIFACT_FAILED", "Could not flush Bash output artifacts");
        }
        if (!childClosed) {
          throw new BashToolError("PROCESS_CONTROL_FAILED", "Could not close Bash output streams");
        }
      }
      await Promise.all([stdoutDone, stderrDone]);

      if (stopError) throw stopError;
      if (artifactError) throw artifactError;
      if (outputLimitError) throw outputLimitError;
      if (cancelled || signal?.aborted) throw new BashToolError("CANCELLED", "Bash command was cancelled");

      const finalTimedOut = timedOut;
      const streamsComplete = stdoutComplete && stderrComplete && !forcedOutputClose;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
      clearUpdate();
      updateDirty = false;
      if (progressHandle) clearInterval(progressHandle);
      progressHandle = undefined;
      await writeMetadata(artifact, cwd, startedAt, exit, finalTimedOut, streamsComplete, stdout, stderr);
      return buildSuccessResult(
        exit,
        finalTimedOut,
        Date.now() - startedAt,
        artifact,
        stdout,
        stderr,
        { stdout: stdoutComplete, stderr: stderrComplete },
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
      clearUpdate();
      if (progressHandle) clearInterval(progressHandle);
    }

  } catch (error) {
    if (child && childExit && !stopPromise) {
      await terminateProcessGroup(child, STOP_GRACE_MS + STOP_FORCE_WAIT_MS).catch(() => undefined);
    }
    forcedOutputClose = true;
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    stdoutFile.destroy();
    stderrFile.destroy();
    if (!await removeProcessArtifact(artifact.directory)) {
      throw new BashToolError("ARTIFACT_FAILED", "Cannot remove the incomplete output artifact");
    }
    throw error;
  }
}

export function createCodexBashTool(options: CodexBashToolOptions = {}): ToolDefinition<typeof bashParameters, BashToolDetails> {
  return {
    name: "bash",
    label: "bash",
    description: "Execute Bash with a 120-second default timeout. Returns a bounded status and stream preview. Read an artifact for omitted captured bytes. Incomplete capture is marked.",
    promptSnippet: "Execute Bash with bounded status and stream previews",
    parameters: bashParameters,
    prepareArguments: prepareBashArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const input = normalizeInput(params);
        const cwd = await validateCwd(input, ctx.cwd);
        const result = await runBash(
          input,
          cwd,
          environmentForTool(ctx),
          signal,
          onUpdate,
          options.onArtifactCreated,
        );
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      } catch (error) {
        const failure = error instanceof BashToolError
          ? formatProcessFailure("bash", error.code, error.detailMessage)
          : formatProcessFailure(
            "bash",
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
          );
        return {
          content: [{ type: "text", text: failure.text }],
          details: failure.details,
        };
      }
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(`$ ${safeRenderArgument(args.command)}`));
      if (args.cwd !== undefined) call += theme.fg("muted", ` (cwd ${safeRenderArgument(args.cwd)})`);
      if (args.timeout_seconds !== undefined) {
        call += theme.fg("muted", ` (timeout ${safeRenderArgument(args.timeout_seconds)}s)`);
      }
      return renderTruncatedToolCall(call, theme, context.isPartial, context.isError);
    },
    renderResult(toolResult, options, theme, context) {
      const rawText = textContent(toolResult);
      const color = context.isError ? "error" : "toolOutput";
      return new Text(theme.fg(color, renderPreview(rawText, options.expanded)), 0, 0);
    },
  };
}
