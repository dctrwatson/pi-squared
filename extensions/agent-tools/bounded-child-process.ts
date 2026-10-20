import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type BoundedChildStream = {
  readonly chunks: Buffer[];
  bytes: number;
  overflow: boolean;
};

export type BoundedChildClose = {
  code: number | null;
  signal: NodeJS.Signals | null;
  failed: boolean;
  error?: Error;
};

export type BoundedChildProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<BoundedChildClose>;
  readonly stdout: BoundedChildStream;
  readonly stderr: BoundedChildStream;
  readonly totalOutputBytes: number;
  readonly totalOutputOverflow: boolean;
  /** Wait only; an argument signal cancels this wait. The constructor signal owns child termination. */
  waitForClose(signal?: AbortSignal): Promise<BoundedChildClose>;
  stop(): Promise<BoundedChildClose>;
};

export type BoundedChildOptions = {
  /** Abort requests SIGTERM for the owned child. */
  signal?: AbortSignal;
  /** Capture at most this many bytes. Omit to drain without retaining or limiting this stream. */
  stdoutLimitBytes?: number;
  /** Capture at most this many bytes. Omit to drain without retaining or limiting this stream. */
  stderrLimitBytes?: number;
  /** Limit combined bytes read from both streams. */
  totalOutputLimitBytes?: number;
  /** Stop the child when any configured limit is exceeded. */
  stopOnLimit?: boolean;
  cleanupTimeoutMs?: number;
  cleanupFailureMessage?: string;
};

export class BoundedChildCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundedChildCleanupError";
  }
}

function validateLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

/** Start one piped child, drain both streams, retain only configured byte caps, and provide bounded TERM/KILL cleanup. */
export function startBoundedChildProcess(
  executable: string,
  args: readonly string[],
  options: BoundedChildOptions = {},
): BoundedChildProcess {
  validateLimit(options.stdoutLimitBytes, "stdoutLimitBytes");
  validateLimit(options.stderrLimitBytes, "stderrLimitBytes");
  validateLimit(options.totalOutputLimitBytes, "totalOutputLimitBytes");
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 300;
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new RangeError("cleanupTimeoutMs must be a positive safe integer.");
  }
  options.signal?.throwIfAborted();

  const child = spawn(executable, [...args], { stdio: "pipe" });
  const stdout: BoundedChildStream = { chunks: [], bytes: 0, overflow: false };
  const stderr: BoundedChildStream = { chunks: [], bytes: 0, overflow: false };
  let totalOutputBytes = 0;
  let totalOutputOverflow = false;
  let failed = false;
  let processError: Error | undefined;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let cleanup: Promise<BoundedChildClose> | undefined;
  let closedStatus: BoundedChildClose | undefined;
  let closedResolve!: (status: BoundedChildClose) => void;
  const closed = new Promise<BoundedChildClose>((resolve) => { closedResolve = resolve; });

  const status = (): BoundedChildClose => ({ code, signal, failed, ...(processError ? { error: processError } : {}) });
  const requestTermination = (signalName: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(signalName); }
    catch { /* The close event below is the reaping check. */ }
  };
  const consume = (stream: BoundedChildStream, limit: number | undefined, chunk: Buffer) => {
    const before = stream.bytes;
    stream.bytes += chunk.length;
    totalOutputBytes += chunk.length;
    if (limit !== undefined) {
      const retained = Math.max(0, Math.min(chunk.length, limit - before));
      if (retained > 0) stream.chunks.push(retained === chunk.length ? chunk : chunk.subarray(0, retained));
      if (stream.bytes > limit) stream.overflow = true;
    }
    if (options.totalOutputLimitBytes !== undefined && totalOutputBytes > options.totalOutputLimitBytes) {
      totalOutputOverflow = true;
    }
    if (options.stopOnLimit && (stream.overflow || totalOutputOverflow)) requestTermination();
  };

  child.stdout.on("data", (chunk: Buffer) => consume(stdout, options.stdoutLimitBytes, chunk));
  child.stderr.on("data", (chunk: Buffer) => consume(stderr, options.stderrLimitBytes, chunk));
  child.once("error", (error) => { failed = true; processError = error; });
  child.once("close", (exitCode, exitSignal) => {
    code = failed ? null : exitCode;
    signal = failed ? null : exitSignal;
    options.signal?.removeEventListener("abort", onAbort);
    closedStatus = status();
    closedResolve(closedStatus);
  });
  const onAbort = () => requestTermination();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.end();

  const waitForClose = (signal?: AbortSignal): Promise<BoundedChildClose> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!signal) return closed;
    return new Promise((resolve, reject) => {
      const onSignalAbort = () => {
        signal.removeEventListener("abort", onSignalAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onSignalAbort, { once: true });
      closed.then((result) => {
        signal.removeEventListener("abort", onSignalAbort);
        resolve(result);
      });
    });
  };

  const waitForCloseWithin = async (milliseconds: number): Promise<BoundedChildClose | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  };

  const stop = (): Promise<BoundedChildClose> => {
    if (closedStatus) return Promise.resolve(closedStatus);
    cleanup ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) requestTermination("SIGTERM");
      if (!await waitForCloseWithin(cleanupTimeoutMs)) {
        if (child.exitCode === null && child.signalCode === null) {
          requestTermination("SIGKILL");
          if (await waitForCloseWithin(cleanupTimeoutMs)) return await closed;
        }
        throw new BoundedChildCleanupError(options.cleanupFailureMessage
          ?? "Child process close was not observed within bounded cleanup; outer process cleanup is required.");
      }
      return await closed;
    })();
    return cleanup;
  };

  return {
    child,
    closed,
    stdout,
    stderr,
    get totalOutputBytes() { return totalOutputBytes; },
    get totalOutputOverflow() { return totalOutputOverflow; },
    waitForClose,
    stop,
  };
}
