import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import {
  DirectProcessError,
  runDirectProcess,
  type DirectProcessErrorCode,
} from "./direct-process.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";
import {
  DEFAULT_PROCESS_OUTPUT_BYTES,
  MIN_PROCESS_OUTPUT_BYTES,
  MAX_PROCESS_OUTPUT_BYTES,
  formatProcessFailure,
  type FormattedProcessResult,
  type ProcessToolDetails,
} from "./process-output.ts";
import {
  formatDirectProcessCall,
  hasUnsuccessfulProcessStatus,
  renderPreview,
  renderTruncatedToolCall,
  safeRenderArgument,
  textContent,
} from "./tool-render.ts";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 0.1;
const MAX_TIMEOUT_SECONDS = 3_600;
const GIT_OUTPUT_CONFIGURATION = ["-c", "color.ui=false", "-c", "column.ui=never"];
const GIT_ERROR_DIAGNOSTIC = /(?:^|\n)(?:fatal|error):|(?:^|\n)usage: git(?:\s|$)/im;

const gitParameters = Type.Object({
  args: Type.Array(Type.String(), { description: "Arguments after git" }),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
  stdin: Type.Optional(Type.String({ description: "Text to write to standard input" })),
  timeout_seconds: Type.Optional(Type.Number({ minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS, description: "Maximum run time in seconds; default: 120; range: 0.1 through 3600" })),
  max_output_bytes: Type.Optional(Type.Integer({ minimum: MIN_PROCESS_OUTPUT_BYTES, maximum: MAX_PROCESS_OUTPUT_BYTES, description: "Total result bytes, including status and previews; default: 8192; range: 2048 through 40960" })),
}, { additionalProperties: false });

const GIT_OPTIONAL_FIELDS = ["max_output_bytes", "cwd", "stdin", "timeout_seconds"];

export type AgentGitInput = Static<typeof gitParameters>;

export type GitErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "EXECUTABLE_NOT_FOUND"
  | DirectProcessErrorCode;

export type GitToolDetails = ProcessToolDetails;

export interface AgentGitToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
}

interface NormalizedGitInput {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

const INVALID_STDIN = "\0__pi_invalid_git_stdin__";

class GitToolError extends Error {
  readonly code: GitErrorCode;
  readonly detailMessage: string;

  constructor(code: GitErrorCode, message: string) {
    super(message);
    this.code = code;
    this.detailMessage = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Report whether Git status 1 is a normal boolean result. */
export function gitExitIsExpected(details: unknown, content: readonly (TextContent | ImageContent)[]): boolean {
  if (
    !isRecord(details)
    || details.ok !== true
    || details.exit_code !== 1
    || details.signal !== null
    || details.timed_out !== false
  ) {
    return false;
  }
  const output = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const stderrHeader = output.lastIndexOf("\n[stderr:");
  if (stderrHeader < 0) return true;
  const stderrStart = output.indexOf("\n", stderrHeader) + 1;
  return !GIT_ERROR_DIAGNOSTIC.test(output.slice(stderrStart));
}

function prepareGitArguments(rawInput: unknown): AgentGitInput {
  return prepareInputArguments(rawInput, GIT_OPTIONAL_FIELDS, normalizeInput);
}

function normalizeInput(rawInput: unknown): NormalizedGitInput {
  rawInput = omitNullOptionalFields(rawInput, GIT_OPTIONAL_FIELDS);
  if (!isRecord(rawInput) || Array.isArray(rawInput)) throw new GitToolError("INVALID_INPUT", "Input must be an object.");
  const allowed = new Set(["args", "cwd", "stdin", "timeout_seconds", "max_output_bytes"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new GitToolError("INVALID_INPUT", `Unknown input field: ${unknown}.`);

  if (!Array.isArray(rawInput.args) || rawInput.args.length === 0 || rawInput.args.some((arg) => typeof arg !== "string")) {
    throw new GitToolError("INVALID_INPUT", "args must be a nonempty array of strings.");
  }
  if (rawInput.args.some((arg) => arg.includes("\0"))) {
    throw new GitToolError("INVALID_INPUT", "args must not contain NUL.");
  }
  if (rawInput.cwd !== undefined && (typeof rawInput.cwd !== "string" || rawInput.cwd.includes("\0"))) {
    throw new GitToolError("INVALID_INPUT", "cwd must be a string without NUL.");
  }
  if (rawInput.stdin !== undefined && (typeof rawInput.stdin !== "string" || rawInput.stdin === INVALID_STDIN)) {
    throw new GitToolError("INVALID_INPUT", "stdin must be a string.");
  }
  if (
    rawInput.timeout_seconds !== undefined
    && (
      typeof rawInput.timeout_seconds !== "number"
      || !Number.isFinite(rawInput.timeout_seconds)
      || rawInput.timeout_seconds < MIN_TIMEOUT_SECONDS
      || rawInput.timeout_seconds > MAX_TIMEOUT_SECONDS
    )
  ) {
    throw new GitToolError("INVALID_INPUT", "timeout_seconds must be from 0.1 through 3600.");
  }

  if (rawInput.max_output_bytes !== undefined && (
    typeof rawInput.max_output_bytes !== "number" || !Number.isSafeInteger(rawInput.max_output_bytes)
    || rawInput.max_output_bytes < MIN_PROCESS_OUTPUT_BYTES || rawInput.max_output_bytes > MAX_PROCESS_OUTPUT_BYTES
  )) {
    throw new GitToolError("INVALID_INPUT", "max_output_bytes must be an integer from 2048 through 40960");
  }

  return {
    args: [...rawInput.args],
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    ...(rawInput.stdin === undefined ? {} : { stdin: rawInput.stdin }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxOutputBytes: rawInput.max_output_bytes ?? DEFAULT_PROCESS_OUTPUT_BYTES,
  };
}

async function validateCwd(input: NormalizedGitInput, sessionCwd: string): Promise<string> {
  const cwd = resolve(sessionCwd, input.cwd ?? ".");
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new GitToolError("INVALID_CWD", "cwd is not a directory.");
    await access(cwd, constants.R_OK | constants.X_OK);
    return cwd;
  } catch (error) {
    if (error instanceof GitToolError) throw error;
    throw new GitToolError("INVALID_CWD", "cwd does not exist or is not accessible.");
  }
}

function gitEnvironment(baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnvironment };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === "GIT_ASKPASS" || normalized === "SSH_ASKPASS" || normalized === "GIT_EXTERNAL_DIFF") delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "Never";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_EDITOR = ":";
  env.GIT_SEQUENCE_EDITOR = ":";
  env.EDITOR = ":";
  env.VISUAL = ":";
  env.BROWSER = ":";
  env.GIT_MERGE_AUTOEDIT = "no";
  env.LC_ALL = "C";
  return env;
}

async function findGit(environment: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const path = environment.PATH;
  if (!path) throw new GitToolError("EXECUTABLE_NOT_FOUND", "Cannot find git in PATH.");
  for (const entry of path.split(delimiter)) {
    const candidate = resolve(cwd, entry || ".", "git");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  throw new GitToolError("EXECUTABLE_NOT_FOUND", "Cannot find git in PATH.");
}

async function executeGit(
  rawInput: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  options: AgentGitToolOptions,
  onUpdate: AgentToolUpdateCallback<GitToolDetails> | undefined,
): Promise<FormattedProcessResult | ReturnType<typeof formatProcessFailure>> {
  let maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES;
  try {
    const environment = gitEnvironment({ ...process.env });
    const input = normalizeInput(rawInput);
    maxOutputBytes = input.maxOutputBytes;
    const cwd = await validateCwd(input, ctx.cwd);
    const executable = await findGit(environment, cwd);
    return await runDirectProcess({
      tool: "git",
      displayName: "Git",
      executable,
      args: [...GIT_OUTPUT_CONFIGURATION, ...input.args],
      cwd,
      environment,
      stdin: input.stdin,
      timeoutSeconds: input.timeoutSeconds,
      maxOutputBytes: input.maxOutputBytes,
      signal,
      onUpdate,
      onArtifactCreated: options.onArtifactCreated,
      cleanupLimitMs: options.cleanupLimitMs,
    });
  } catch (error) {
    if (error instanceof GitToolError || error instanceof DirectProcessError) {
      return formatProcessFailure("git", error.code, error.detailMessage, undefined, maxOutputBytes);
    }
    return formatProcessFailure("git", "INTERNAL_ERROR", `Cannot run git: ${String(error)}`, undefined, maxOutputBytes);
  }
}

export function createAgentGitTool(options: AgentGitToolOptions = {}): ToolDefinition<typeof gitParameters, GitToolDetails> {
  return {
    name: "git",
    label: "git",
    description: "Run Git without a TTY. Results have bounded status and stream previews; read artifacts for omitted bytes.",
    promptSnippet: "Run Git without a TTY",
    promptGuidelines: [
      "With git or gh, check exit_code, signal, timed_out, and capture state before use. Read artifacts before rerunning when output is omitted.",
      "git has no TTY: pagers, prompts, askpass, editors, and browser use are disabled. Avoid interactive modes and input-dependent hooks; use flags for messages and choices.",
      "git disables color and columns, and uses the C locale for diagnostics. Use options for stable formats.",
      "Other git configuration, aliases, hooks, helpers, and credentials still apply.",
    ],
    parameters: gitParameters,
    prepareArguments: prepareGitArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await executeGit(params, ctx, signal, options, onUpdate);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.details.ok === false,
      };
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(formatDirectProcessCall("git", args.args)));
      if (args.cwd !== undefined) call += theme.fg("muted", ` (cwd ${safeRenderArgument(args.cwd)})`);
      if (args.stdin !== undefined) call += theme.fg("muted", ` (stdin ${safeRenderArgument(args.stdin)})`);
      if (args.timeout_seconds !== undefined) {
        call += theme.fg("muted", ` (timeout ${safeRenderArgument(args.timeout_seconds)}s)`);
      }
      if (args.max_output_bytes !== undefined) call += theme.fg("muted", ` (output ${safeRenderArgument(args.max_output_bytes)} bytes)`);
      return renderTruncatedToolCall(call, theme, context.isPartial, context.isError);
    },
    renderResult(toolResult, renderOptions, theme, context) {
      const rawText = textContent(toolResult);
      const color = context.isError
        || (hasUnsuccessfulProcessStatus(toolResult.details) && !gitExitIsExpected(toolResult.details, toolResult.content))
        ? "error"
        : "toolOutput";
      return new Text(theme.fg(color, renderPreview(rawText, renderOptions.expanded)), 0, 0);
    },
  };
}
