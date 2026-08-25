import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
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

const ghParameters = Type.Object({
  args: Type.Array(Type.String(), { description: "Arguments after gh" }),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
  stdin: Type.Optional(Type.String({ description: "Text to write to standard input" })),
  timeout_seconds: Type.Optional(Type.Number({ description: "Maximum run time in seconds; default: 120; range: 0.1 through 3600" })),
});

export type CodexGhInput = Static<typeof ghParameters>;

export type GhErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "EXECUTABLE_NOT_FOUND"
  | DirectProcessErrorCode;

export type GhToolDetails = ProcessToolDetails;

export interface CodexGhToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
}

interface NormalizedGhInput {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutSeconds: number;
}

const INVALID_STDIN = "\0__pi_invalid_gh_stdin__";

class GhToolError extends Error {
  readonly code: GhErrorCode;
  readonly detailMessage: string;

  constructor(code: GhErrorCode, message: string) {
    super(message);
    this.code = code;
    this.detailMessage = message;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function prepareGhArguments(rawInput: unknown): CodexGhInput {
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
  return prepared as CodexGhInput;
}

function normalizeInput(rawInput: unknown): NormalizedGhInput {
  if (!isRecord(rawInput)) throw new GhToolError("INVALID_INPUT", "Input must be an object.");
  const allowed = new Set(["args", "cwd", "stdin", "timeout_seconds"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown) throw new GhToolError("INVALID_INPUT", `Unknown input field: ${unknown}.`);

  if (!Array.isArray(rawInput.args) || rawInput.args.length === 0 || rawInput.args.some((arg) => typeof arg !== "string")) {
    throw new GhToolError("INVALID_INPUT", "args must be a nonempty array of strings.");
  }
  if (rawInput.args.some((arg) => arg.includes("\0"))) {
    throw new GhToolError("INVALID_INPUT", "args must not contain NUL.");
  }
  if (rawInput.cwd !== undefined && (typeof rawInput.cwd !== "string" || rawInput.cwd.includes("\0"))) {
    throw new GhToolError("INVALID_INPUT", "cwd must be a string without NUL.");
  }
  if (rawInput.stdin !== undefined && (typeof rawInput.stdin !== "string" || rawInput.stdin === INVALID_STDIN)) {
    throw new GhToolError("INVALID_INPUT", "stdin must be a string.");
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
    throw new GhToolError("INVALID_INPUT", "timeout_seconds must be from 0.1 through 3600.");
  }

  return {
    args: [...rawInput.args],
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    ...(rawInput.stdin === undefined ? {} : { stdin: rawInput.stdin }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

async function validateCwd(input: NormalizedGhInput, sessionCwd: string): Promise<string> {
  const cwd = resolve(sessionCwd, input.cwd ?? ".");
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new GhToolError("INVALID_CWD", "cwd is not a directory.");
    await access(cwd, constants.R_OK | constants.X_OK);
    return cwd;
  } catch (error) {
    if (error instanceof GhToolError) throw error;
    throw new GhToolError("INVALID_CWD", "cwd does not exist or is not accessible.");
  }
}

function ghEnvironment(baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnvironment };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "GH_FORCE_TTY") delete env[key];
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GH_PAGER = "cat";
  env.PAGER = "cat";
  env.GH_EDITOR = ":";
  env.EDITOR = ":";
  env.VISUAL = ":";
  env.GH_BROWSER = ":";
  env.BROWSER = ":";
  return env;
}

async function findGh(environment: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const path = environment.PATH;
  if (!path) throw new GhToolError("EXECUTABLE_NOT_FOUND", "Cannot find gh in PATH.");
  for (const entry of path.split(delimiter)) {
    const candidate = resolve(cwd, entry || ".", "gh");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  throw new GhToolError("EXECUTABLE_NOT_FOUND", "Cannot find gh in PATH.");
}

async function executeGh(
  rawInput: unknown,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  options: CodexGhToolOptions,
  onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<FormattedProcessResult | ReturnType<typeof formatProcessFailure>> {
  try {
    const environment = ghEnvironment({ ...process.env });
    const input = normalizeInput(rawInput);
    const cwd = await validateCwd(input, ctx.cwd);
    const executable = await findGh(environment, cwd);
    return await runDirectProcess({
      tool: "gh",
      displayName: "GitHub CLI",
      executable,
      args: input.args,
      cwd,
      environment,
      stdin: input.stdin,
      timeoutSeconds: input.timeoutSeconds,
      signal,
      onUpdate,
      onArtifactCreated: options.onArtifactCreated,
    });
  } catch (error) {
    if (error instanceof GhToolError || error instanceof DirectProcessError) {
      return formatProcessFailure("gh", error.code, error.detailMessage);
    }
    return formatProcessFailure("gh", "INTERNAL_ERROR", `Cannot run gh: ${String(error)}`);
  }
}

export function createCodexGhTool(options: CodexGhToolOptions = {}): ToolDefinition<typeof ghParameters, GhToolDetails> {
  return {
    name: "gh",
    label: "gh",
    description: "Run GitHub CLI directly without a TTY, with bounded status and stream previews. Read artifacts for omitted bytes.",
    promptSnippet: "Run GitHub CLI without a TTY or interactive UI",
    promptGuidelines: [
      "Check exit_code, signal, timed_out, and capture state before use. Read artifacts before reruns with omitted output.",
      "No TTY: pager=cat; prompts, editors, and browser are disabled. Avoid auth login, browse, --web, --editor, and incomplete create commands; use arguments or stdin.",
      "Authentication failures are normal nonzero results. Normal aliases, extensions, configuration, and credentials apply.",
    ],
    parameters: ghParameters,
    prepareArguments: prepareGhArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await executeGh(params, ctx, signal, options, onUpdate);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(formatDirectProcessCall("gh", args.args)));
      if (args.cwd !== undefined) call += theme.fg("muted", ` (cwd ${safeRenderArgument(args.cwd)})`);
      if (args.stdin !== undefined) call += theme.fg("muted", ` (stdin ${safeRenderArgument(args.stdin)})`);
      if (args.timeout_seconds !== undefined) {
        call += theme.fg("muted", ` (timeout ${safeRenderArgument(args.timeout_seconds)}s)`);
      }
      return renderTruncatedToolCall(call, theme, context.isPartial, context.isError);
    },
    renderResult(toolResult, renderOptions, theme, context) {
      const rawText = textContent(toolResult);
      const color = context.isError || hasUnsuccessfulProcessStatus(toolResult.details) ? "error" : "toolOutput";
      return new Text(theme.fg(color, renderPreview(rawText, renderOptions.expanded)), 0, 0);
    },
  };
}
