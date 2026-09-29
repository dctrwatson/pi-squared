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

const ghParameters = Type.Object({
  args: Type.Array(Type.String(), { description: "Arguments after gh" }),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
  stdin: Type.Optional(Type.String({ description: "Text to write to standard input" })),
  timeout_seconds: Type.Optional(Type.Number({ minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS, description: "Maximum run time in seconds; default: 120; range: 0.1 through 3600" })),
  max_output_bytes: Type.Optional(Type.Integer({ minimum: MIN_PROCESS_OUTPUT_BYTES, maximum: MAX_PROCESS_OUTPUT_BYTES, description: "Total result bytes, including status and previews; default: 8192; range: 2048 through 40960" })),
}, { additionalProperties: false });

const GH_OPTIONAL_FIELDS = ["max_output_bytes", "cwd", "stdin", "timeout_seconds"];

export type AgentGhInput = Static<typeof ghParameters>;

export type GhErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CWD"
  | "EXECUTABLE_NOT_FOUND"
  | DirectProcessErrorCode;

export type GhToolDetails = ProcessToolDetails;

export interface AgentGhToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
}

interface NormalizedGhInput {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
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

function prepareGhArguments(rawInput: unknown): AgentGhInput {
  return prepareInputArguments(rawInput, GH_OPTIONAL_FIELDS, normalizeInput);
}

function normalizeInput(rawInput: unknown): NormalizedGhInput {
  rawInput = omitNullOptionalFields(rawInput, GH_OPTIONAL_FIELDS);
  if (!isRecord(rawInput) || Array.isArray(rawInput)) throw new GhToolError("INVALID_INPUT", "Input must be an object.");
  const allowed = new Set(["args", "cwd", "stdin", "timeout_seconds", "max_output_bytes"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new GhToolError("INVALID_INPUT", `Unknown input field: ${unknown}.`);

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

  if (rawInput.max_output_bytes !== undefined && (
    typeof rawInput.max_output_bytes !== "number" || !Number.isSafeInteger(rawInput.max_output_bytes)
    || rawInput.max_output_bytes < MIN_PROCESS_OUTPUT_BYTES || rawInput.max_output_bytes > MAX_PROCESS_OUTPUT_BYTES
  )) {
    throw new GhToolError("INVALID_INPUT", "max_output_bytes must be an integer from 2048 through 40960");
  }

  return {
    args: [...rawInput.args],
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    ...(rawInput.stdin === undefined ? {} : { stdin: rawInput.stdin }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxOutputBytes: rawInput.max_output_bytes ?? DEFAULT_PROCESS_OUTPUT_BYTES,
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

export async function findGh(environment: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const path = environment.PATH;
  if (!path) throw new GhToolError("EXECUTABLE_NOT_FOUND", "Cannot find gh in PATH.");
  for (const entry of path.split(delimiter)) {
    const candidate = resolve(cwd, entry || ".", "gh");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
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
  options: AgentGhToolOptions,
  onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<FormattedProcessResult | ReturnType<typeof formatProcessFailure>> {
  let maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES;
  try {
    const environment = ghEnvironment({ ...process.env });
    const input = normalizeInput(rawInput);
    maxOutputBytes = input.maxOutputBytes;
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
      maxOutputBytes: input.maxOutputBytes,
      signal,
      onUpdate,
      onArtifactCreated: options.onArtifactCreated,
      cleanupLimitMs: options.cleanupLimitMs,
    });
  } catch (error) {
    if (error instanceof GhToolError || error instanceof DirectProcessError) {
      return formatProcessFailure("gh", error.code, error.detailMessage, undefined, maxOutputBytes);
    }
    return formatProcessFailure("gh", "INTERNAL_ERROR", `Cannot run gh: ${String(error)}`, undefined, maxOutputBytes);
  }
}

export function createAgentGhTool(options: AgentGhToolOptions = {}): ToolDefinition<typeof ghParameters, GhToolDetails> {
  return {
    name: "gh",
    label: "gh",
    description: "Run GitHub CLI without a TTY. Results have bounded status and stream previews; read artifacts for omitted bytes.",
    promptSnippet: "Run GitHub CLI without a TTY",
    promptGuidelines: [
      "With git or gh, check exit_code, signal, timed_out, and capture state before use. Read artifacts before rerunning when output is omitted.",
      "gh has no TTY: pager=cat; prompts, editors, and browser are disabled. Avoid auth login, browse, --web, --editor, and incomplete create commands; use arguments or stdin.",
      "With gh, authentication failures are normal nonzero results; aliases, extensions, configuration, and credentials still apply.",
    ],
    parameters: ghParameters,
    prepareArguments: prepareGhArguments,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await executeGh(params, ctx, signal, options, onUpdate);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.details.ok === false,
      };
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(formatDirectProcessCall("gh", args.args)));
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
      const color = context.isError || hasUnsuccessfulProcessStatus(toolResult.details) ? "error" : "toolOutput";
      return new Text(theme.fg(color, renderPreview(rawText, renderOptions.expanded)), 0, 0);
    },
  };
}
