import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import type { ProcessArtifact } from "./process-artifacts.ts";
import { BashProcessOwner, BashToolError, startBashProcess } from "./bash-process.ts";
import { BashJobRegistry, formatBashJobStart, type BashBackgroundDetails } from "./bash-jobs.ts";
import { hasUnsuccessfulProcessStatus } from "./tool-render.ts";
import {
  DEFAULT_PROCESS_OUTPUT_BYTES,
  MIN_PROCESS_OUTPUT_BYTES,
  MAX_PROCESS_OUTPUT_BYTES,
  formatProcessFailure,
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
const OSC_SEQUENCE_PATTERN =
  /(?:\u001b\u005d|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const ST_TERMINATED_SEQUENCE_PATTERN =
  /(?:\u001b[\u0050\u0058\u005e\u005f]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g;

function sanitizeDisplayText(text: string): string {
  const withoutTerminalSequences = stripVTControlCharacters(
    text
      .replace(OSC_SEQUENCE_PATTERN, "")
      .replace(ST_TERMINATED_SEQUENCE_PATTERN, ""),
  );
  return Array.from(withoutTerminalSequences)
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a) return true;
      if (code <= 0x1f) return false;
      return code < 0xfff9 || code > 0xfffb;
    })
    .join("");
}

export const agentBashParameters = Type.Object({
  command: Type.String({ description: "Bash source text to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session directory by default" })),
  timeout_seconds: Type.Optional(Type.Number({ minimum: 0.1, maximum: 86_400, description: "Run deadline in seconds; default: 120; foreground: 0.1–3600; background: 0.1–86400" })),
  background: Type.Optional(Type.Boolean({ description: "Start a managed Bash job; default false. Requires active bash_job." })),
  max_output_bytes: Type.Optional(Type.Integer({ minimum: MIN_PROCESS_OUTPUT_BYTES, maximum: MAX_PROCESS_OUTPUT_BYTES, description: "Total result bytes, including status and previews; default: 8192; range: 2048 through 40960" })),
}, { additionalProperties: false });

const bashParameters = agentBashParameters;
const BASH_OPTIONAL_FIELDS = ["max_output_bytes", "cwd", "timeout_seconds", "background"];

export type AgentBashInput = Static<typeof bashParameters>;

export type { BashErrorCode } from "./bash-process.ts";
export type BashToolDetails = ProcessToolDetails | BashBackgroundDetails;

export interface AgentBashToolOptions {
  onArtifactCreated?: (artifact: ProcessArtifact) => void;
  cleanupLimitMs?: number;
  owner?: BashProcessOwner | (() => BashProcessOwner);
  registry?: BashJobRegistry | (() => BashJobRegistry);
  controlAvailable?: () => boolean;
}

export interface NormalizedBashInput {
  command: string;
  cwd?: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  background: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeInput(rawInput: unknown): NormalizedBashInput {
  rawInput = omitNullOptionalFields(rawInput, BASH_OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new BashToolError("INVALID_INPUT", "Input must be an object");
  const allowedKeys = new Set(["command", "cwd", "timeout_seconds", "max_output_bytes", "background"]);
  const unknownKey = Object.keys(rawInput).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) throw new BashToolError("INVALID_INPUT", `Unknown input field: ${unknownKey}`);

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
  if (rawInput.background !== undefined && typeof rawInput.background !== "boolean") {
    throw new BashToolError("INVALID_INPUT", "background must be a boolean");
  }
  if (rawInput.background === true && rawInput.max_output_bytes !== undefined) {
    throw new BashToolError("INVALID_INPUT", "max_output_bytes is foreground-only");
  }
  if (
    rawInput.timeout_seconds !== undefined &&
    (typeof rawInput.timeout_seconds !== "number" ||
      !Number.isFinite(rawInput.timeout_seconds) ||
      rawInput.timeout_seconds < 0.1 ||
      rawInput.timeout_seconds > (rawInput.background === true ? 86_400 : 3_600))
  ) {
    throw new BashToolError("INVALID_INPUT", rawInput.background === true
      ? "timeout_seconds must be from 0.1 through 86400" : "timeout_seconds must be from 0.1 through 3600");
  }

  if (rawInput.max_output_bytes !== undefined && (
    typeof rawInput.max_output_bytes !== "number" || !Number.isSafeInteger(rawInput.max_output_bytes)
    || rawInput.max_output_bytes < MIN_PROCESS_OUTPUT_BYTES || rawInput.max_output_bytes > MAX_PROCESS_OUTPUT_BYTES
  )) {
    throw new BashToolError("INVALID_INPUT", "max_output_bytes must be an integer from 2048 through 40960");
  }

  return {
    command: rawInput.command,
    ...(rawInput.cwd === undefined ? {} : { cwd: rawInput.cwd }),
    timeoutSeconds: rawInput.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    maxOutputBytes: rawInput.max_output_bytes ?? DEFAULT_PROCESS_OUTPUT_BYTES,
    background: rawInput.background ?? false,
  };
}

function prepareBashArguments(rawInput: unknown): AgentBashInput {
  return prepareInputArguments(rawInput, BASH_OPTIONAL_FIELDS, normalizeInput);
}

export { validateBashCwd as validateCwd } from "./bash-process.ts";

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

export function createAgentBashTool(options: AgentBashToolOptions = {}): ToolDefinition<typeof bashParameters, BashToolDetails> {
  const fallbackOwner = new BashProcessOwner();
  return {
    name: "bash",
    label: "bash",
    description: "Run Bash with a 120-second default deadline. Foreground calls have bounded previews; background calls return a managed job. Read saved logs for omitted output.",
    promptSnippet: "Run Bash with bounded status and previews",
    parameters: bashParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    prepareArguments: prepareBashArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let maxOutputBytes = DEFAULT_PROCESS_OUTPUT_BYTES;
      try {
        const input = normalizeInput(params);
        maxOutputBytes = input.maxOutputBytes;
        const selectedRegistry = typeof options.registry === "function" ? options.registry() : options.registry;
        const owner = typeof options.owner === "function" ? options.owner() : options.owner ?? selectedRegistry?.owner ?? fallbackOwner;
        if (selectedRegistry && !selectedRegistry.belongsTo(ctx.sessionManager.getSessionId())) {
          throw new BashToolError("CANCELLED", "Bash invocation belongs to another runtime/session");
        }
        if (input.background) {
          if (!options.controlAvailable?.() || !options.registry) {
            throw new BashToolError("CONTROL_UNAVAILABLE", "Select bash_job before starting a background command");
          }
          const registry = selectedRegistry!;
          let job = await registry.start({ input, sessionCwd: ctx.cwd, environment: environmentForTool(ctx), signal,
            onArtifactCreated: options.onArtifactCreated, cleanupLimitMs: options.cleanupLimitMs,
            controlAvailable: options.controlAvailable });
          if (signal?.aborted && job.process?.cleanup === "pending") job = await registry.cancel(job.job_id);
          const result = formatBashJobStart(job);
          registry.transfer(job.job_id);
          return { content: [{ type: "text", text: result.text }], details: result.details,
            isError: hasUnsuccessfulProcessStatus(result.details) };
        }
        const controller = startBashProcess(owner, { input, sessionCwd: ctx.cwd,
          environment: environmentForTool(ctx), signal, onUpdate: onUpdate as import("@earendil-works/pi-coding-agent").AgentToolUpdateCallback<ProcessToolDetails>, ...options });
        const result = await controller.finished;
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
          isError: result.details.ok === false,
        };
      } catch (error) {
        const failure = error instanceof BashToolError
          ? formatProcessFailure("bash", error.code, error.detailMessage, undefined, maxOutputBytes)
          : formatProcessFailure(
            "bash",
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : String(error),
            undefined, maxOutputBytes,
          );
        return {
          content: [{ type: "text", text: failure.text }],
          details: failure.details,
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      let call = theme.fg("toolTitle", theme.bold(`$ ${safeRenderArgument(args.command)}`));
      if (args.cwd !== undefined) call += theme.fg("muted", ` (cwd ${safeRenderArgument(args.cwd)})`);
      if (args.timeout_seconds !== undefined) {
        call += theme.fg("muted", ` (timeout ${safeRenderArgument(args.timeout_seconds)}s)`);
      }
      if (args.background !== undefined) call += theme.fg("muted", ` (background ${safeRenderArgument(args.background)})`);
      if (args.max_output_bytes !== undefined) call += theme.fg("muted", ` (output ${safeRenderArgument(args.max_output_bytes)} bytes)`);
      return renderTruncatedToolCall(call, theme, context.isPartial, context.isError);
    },
    renderResult(toolResult, options, theme, context) {
      const rawText = textContent(toolResult);
      const displayText = sanitizeDisplayText(rawText);
      const color = context.isError ? "error" : "toolOutput";
      return new Text(theme.fg(color, renderPreview(displayText, options.expanded)), 0, 0);
    },
  };
}
