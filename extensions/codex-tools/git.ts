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
import {
  DirectProcessError,
  runDirectProcess,
  type DirectProcessErrorCode,
} from "./direct-process.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";
import {
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
  timeout_seconds: Type.Optional(Type.Number({ description: "Maximum run time in seconds; default: 120; range: 0.1 through 3600" })),
});

export type CodexGitInput = Static<typeof gitParameters>;

export type GitErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "EXECUTABLE_NOT_FOUND"
  | DirectProcessErrorCode;

export type GitToolDetails = ProcessToolDetails;

export interface CodexGitToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
}

interface NormalizedGitInput {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutSeconds: number;
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

function prepareGitArguments(rawInput: unknown): CodexGitInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { args: [] };
  if (!Array.isArray(prepared.args)) {
    prepared.args = [];
  } else if (prepared.args.some((arg) => typeof arg !== "string")) {
    prepared.args = prepared.args.map((arg) => typeof arg === "string" ? arg : "\0");
  }
  if (prepared.cwd !== undefined && typeof prepared.cwd !== "string") {
    prepared.cwd = "\0";
  }
  if (prepared.stdin !== undefined && typeof prepared.stdin !== "string") {
    prepared.stdin = INVALID_STDIN;
  }
  if (prepared.timeout_seconds !== undefined && typeof prepared.timeout_seconds !== "number") {
    prepared.timeout_seconds = -1;
  }
  return prepared as CodexGitInput;
}

function normalizeInput(rawInput: unknown): NormalizedGitInput {
  if (!isRecord(rawInput)) throw new GitToolError("INVALID_INPUT", "Input must be an object.");
  const allowed = new Set(["args", "cwd", "stdin", "timeout_seconds"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown) throw new GitToolError("INVALID_INPUT", `Unknown input field: ${unknown}.`);

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

  return {
    args: [...rawInput.args],
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    ...(rawInput.stdin === undefined ? {} : { stdin: rawInput.stdin }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
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
  options: CodexGitToolOptions,
  onUpdate: AgentToolUpdateCallback<GitToolDetails> | undefined,
): Promise<FormattedProcessResult | ReturnType<typeof formatProcessFailure>> {
  try {
    const environment = gitEnvironment({ ...process.env });
    const input = normalizeInput(rawInput);
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
      signal,
      onUpdate,
      onArtifactCreated: options.onArtifactCreated,
      cleanupLimitMs: options.cleanupLimitMs,
    });
  } catch (error) {
    if (error instanceof GitToolError || error instanceof DirectProcessError) {
      return formatProcessFailure("git", error.code, error.detailMessage);
    }
    return formatProcessFailure("git", "INTERNAL_ERROR", `Cannot run git: ${String(error)}`);
  }
}

export function createCodexGitTool(options: CodexGitToolOptions = {}): ToolDefinition<typeof gitParameters, GitToolDetails> {
  return {
    name: "git",
    label: "git",
    description: "Run Git directly without a TTY, with bounded status and stream previews. Read artifacts for omitted bytes.",
    promptSnippet: "Run Git without a TTY or interactive UI",
    promptGuidelines: [
      "Check exit_code, signal, timed_out, and capture state before use. Read artifacts before reruns with omitted output.",
      "No TTY: pagers, prompts, askpass, editors, and browser use are disabled. Avoid UI modes and hooks that need input; use flags for messages and choices.",
      "Output baseline: color is off, columns are off, and diagnostics use the C locale. Use command options for stable formats.",
      "Normal configuration, aliases, hooks, helpers, and credentials still apply unless this baseline overrides them.",
    ],
    parameters: gitParameters,
    prepareArguments: prepareGitArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await executeGit(params, ctx, signal, options, onUpdate);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(formatDirectProcessCall("git", args.args)));
      if (args.cwd !== undefined) call += theme.fg("muted", ` (cwd ${safeRenderArgument(args.cwd)})`);
      if (args.stdin !== undefined) call += theme.fg("muted", ` (stdin ${safeRenderArgument(args.stdin)})`);
      if (args.timeout_seconds !== undefined) {
        call += theme.fg("muted", ` (timeout ${safeRenderArgument(args.timeout_seconds)}s)`);
      }
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
