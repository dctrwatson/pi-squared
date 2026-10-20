import { execFile } from "node:child_process";

const COMMAND_TIMEOUT_MS = 12_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_BOUNDED_COMMAND_OUTPUT_BYTES = 1024 * 1024;

/** Keep the HTTP status separate from CLI error text. */
export class GitHubRequestError extends Error {
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "GitHubRequestError";
    this.httpStatus = httpStatus;
  }
}

/** Run gh without a shell, with a timeout and output limit. */
export function runGh(args: string[], signal: AbortSignal | undefined, maxOutputBytes = MAX_COMMAND_OUTPUT_BYTES): Promise<string> {
  throwIfAborted(signal);
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    return Promise.reject(new TypeError("GitHub CLI arguments must be strings without NUL."));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < MAX_COMMAND_OUTPUT_BYTES || maxOutputBytes > MAX_BOUNDED_COMMAND_OUTPUT_BYTES) {
    return Promise.reject(new TypeError("GitHub CLI output limit must be from 256 KiB through 1 MiB."));
  }

  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted || error.name === "AbortError") {
            reject(abortError());
            return;
          }
          const status = !error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? /^HTTP\/[0-9.]+ ([345][0-9]{2})(?: |\r?$)/.exec(stdout) : null;
          reject(new GitHubRequestError(`GitHub CLI read failed: ${commandFailureMessage(error, stderr)}`, status ? Number(status[1]) : undefined));
          return;
        }

        if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
          reject(new Error("GitHub CLI read exceeded the bounded output limit."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function commandFailureMessage(error: Error & { killed?: boolean; signal?: string | null }, stderr: string | Buffer): string {
  if (error.killed) return `timed out after ${COMMAND_TIMEOUT_MS}ms or exceeded the output limit`;
  const details = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  const compact = details.replace(/\s+/g, " ").trim().slice(0, 400);
  return compact || error.message.replace(/\s+/g, " ").trim().slice(0, 400) || "unknown gh CLI failure";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("GitHub read was aborted.");
  error.name = "AbortError";
  return error;
}
