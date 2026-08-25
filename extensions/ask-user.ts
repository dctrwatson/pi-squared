import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ToolFailureDetails, ToolSuccessDetails } from "./codex-tools/tool-result.ts";

const MAX_PROMPT_CODE_POINTS = 4_000;
const MAX_OPTIONS = 20;
const MAX_OPTION_ID_LENGTH = 64;
const MAX_LABEL_CODE_POINTS = 200;
const MAX_DESCRIPTION_CODE_POINTS = 500;
const MAX_PLACEHOLDER_CODE_POINTS = 200;
const MAX_TEXT_CODE_POINTS = 16_384;
const OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const askUserOptionParameters = Type.Object({
  id: Type.String({ description: "Stable option identifier" }),
  label: Type.String({ description: "Option text shown to the user" }),
  description: Type.Optional(Type.String({ description: "Optional supporting text for the option" })),
});

const askUserParameters = Type.Object({
  prompt: Type.String({ description: "Complete plain-text question to show to the user" }),
  options: Type.Optional(Type.Array(askUserOptionParameters, { description: "Optional answer options with id, label, and optional description" })),
  multiple: Type.Optional(Type.Boolean({ description: "Permit more than one option; valid only with options" })),
  allow_other: Type.Optional(Type.Boolean({ description: "Permit a free-text answer with options; valid only with options" })),
  placeholder: Type.Optional(Type.String({ description: "Hint for an available free-text input" })),
});

export type AskUserToolInput = Static<typeof askUserParameters>;

export function prepareAskUserArguments(rawInput: unknown): AskUserToolInput {
  const prepared: Record<string, unknown> = isRecord(rawInput) ? { ...rawInput } : { prompt: "" };
  if (typeof prepared.prompt !== "string") prepared.prompt = "";
  if (prepared.options !== undefined) {
    if (!Array.isArray(prepared.options)) {
      prepared.options = [];
    } else {
      prepared.options = prepared.options.map((option) => {
        if (!isRecord(option)) return { id: "", label: "" };
        return {
          ...option,
          ...(typeof option.id === "string" ? {} : { id: "" }),
          ...(typeof option.label === "string" ? {} : { label: "" }),
          ...(option.description === undefined || typeof option.description === "string" ? {} : { description: "" }),
        };
      });
    }
  }
  for (const field of ["multiple", "allow_other"] as const) {
    if (prepared[field] !== undefined && typeof prepared[field] !== "boolean") {
      prepared[field] = false;
      prepared.prompt = "";
    }
  }
  if (prepared.placeholder !== undefined && typeof prepared.placeholder !== "string") prepared.placeholder = "";
  return prepared as AskUserToolInput;
}

export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

export interface AskUserInput {
  prompt: string;
  options?: AskUserOption[];
  multiple?: boolean;
  allow_other?: boolean;
  placeholder?: string;
}

export interface NormalizedAskUserInput {
  prompt: string;
  options?: AskUserOption[];
  multiple: boolean;
  allowOther: boolean;
  placeholder?: string;
}

export type AskUserErrorCode =
  | "INVALID_INPUT"
  | "PROMPT_ACTIVE"
  | "UI_UNAVAILABLE"
  | "INVOCATION_CANCELLED"
  | "INTERNAL_ERROR";

export interface AskUserAnsweredResult {
  ok: true;
  status: "answered";
  selected_ids: string[];
  text?: string;
}

export interface AskUserCancelledResult {
  ok: true;
  status: "cancelled";
  reason: "user";
  selected_ids: [];
}

export interface AskUserFailureResult {
  ok: false;
  error: {
    code: AskUserErrorCode;
    message: string;
  };
}

export type AskUserResult = AskUserAnsweredResult | AskUserCancelledResult | AskUserFailureResult;

export type AskUserToolDetails =
  | (ToolSuccessDetails<"ask_user"> & AskUserAnsweredResult)
  | (ToolSuccessDetails<"ask_user"> & AskUserCancelledResult)
  | (ToolFailureDetails<"ask_user", AskUserErrorCode> & AskUserFailureResult);

interface AskUserTheme {
  fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
  bold(text: string): string;
}

interface ActivePrompt {
  finish?: (result: AskUserResult) => void;
}

export interface AskUserSessionState {
  active?: ActivePrompt;
}

class AskUserInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function hasNonWhitespace(value: string): boolean {
  return /\S/u.test(value);
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string") throw new AskUserInputError(`${name} must be a string.`);
  if (!hasNonWhitespace(value)) throw new AskUserInputError(`${name} must contain non-whitespace text.`);
  if (codePointLength(value) > maximum) throw new AskUserInputError(`${name} exceeds the ${maximum}-code-point limit.`);
  return value;
}

function normalizeOption(value: unknown, index: number): AskUserOption {
  if (!isRecord(value)) throw new AskUserInputError(`options[${index}] must be an object.`);
  const allowed = new Set(["id", "label", "description"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new AskUserInputError("Unknown option field.");

  if (typeof value.id !== "string" || !OPTION_ID_PATTERN.test(value.id) || value.id.length > MAX_OPTION_ID_LENGTH) {
    throw new AskUserInputError(`options[${index}].id is invalid.`);
  }

  const label = requireText(value.label, `options[${index}].label`, MAX_LABEL_CODE_POINTS);
  if (!hasOwn(value, "description")) return { id: value.id, label };
  return {
    id: value.id,
    label,
    description: requireText(value.description, `options[${index}].description`, MAX_DESCRIPTION_CODE_POINTS),
  };
}

export function normalizeAskUserInput(rawInput: unknown): NormalizedAskUserInput {
  if (!isRecord(rawInput)) throw new AskUserInputError("Input must be an object.");
  const allowed = new Set(["prompt", "options", "multiple", "allow_other", "placeholder"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown) throw new AskUserInputError("Unknown input field.");

  const prompt = requireText(rawInput.prompt, "prompt", MAX_PROMPT_CODE_POINTS);
  if (!hasOwn(rawInput, "options")) {
    if (hasOwn(rawInput, "multiple") || hasOwn(rawInput, "allow_other")) {
      throw new AskUserInputError("multiple and allow_other require options.");
    }
    if (!hasOwn(rawInput, "placeholder")) return { prompt, multiple: false, allowOther: true };
    return {
      prompt,
      multiple: false,
      allowOther: true,
      placeholder: requireText(rawInput.placeholder, "placeholder", MAX_PLACEHOLDER_CODE_POINTS),
    };
  }

  const optionsValue = rawInput.options;
  if (!Array.isArray(optionsValue) || optionsValue.length === 0 || optionsValue.length > MAX_OPTIONS) {
    throw new AskUserInputError(`options must contain 1 through ${MAX_OPTIONS} items.`);
  }
  const options = optionsValue.map(normalizeOption);
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new AskUserInputError("options IDs must be unique.");
    ids.add(option.id);
  }

  const multiple = hasOwn(rawInput, "multiple") ? rawInput.multiple : false;
  if (typeof multiple !== "boolean") throw new AskUserInputError("multiple must be a boolean.");
  const allowOther = hasOwn(rawInput, "allow_other") ? rawInput.allow_other : true;
  if (typeof allowOther !== "boolean") throw new AskUserInputError("allow_other must be a boolean.");
  if (hasOwn(rawInput, "placeholder") && !allowOther) {
    throw new AskUserInputError("placeholder requires an available free-text input.");
  }

  return {
    prompt,
    options,
    multiple,
    allowOther,
    ...(hasOwn(rawInput, "placeholder")
      ? { placeholder: requireText(rawInput.placeholder, "placeholder", MAX_PLACEHOLDER_CODE_POINTS) }
      : {}),
  };
}

export function askUserFailure(code: AskUserErrorCode, message: string): AskUserFailureResult {
  return { ok: false, error: { code, message } };
}

export function askUserCancelled(): AskUserCancelledResult {
  return { ok: true, status: "cancelled", reason: "user", selected_ids: [] };
}

function detailsFor(result: AskUserResult): AskUserToolDetails {
  return { ...result, tool: "ask_user" } as AskUserToolDetails;
}

interface AnswerResolution {
  result?: AskUserAnsweredResult;
  feedback?: string;
}

function submittedText(text: string | undefined): string | undefined {
  return text !== undefined && hasNonWhitespace(text) ? text : undefined;
}

function textFeedback(text: string | undefined): string | undefined {
  if (!submittedText(text)) return "Enter a nonblank answer.";
  if (codePointLength(text ?? "") > MAX_TEXT_CODE_POINTS) {
    return `Keep the answer within ${MAX_TEXT_CODE_POINTS} code points.`;
  }
  return undefined;
}

export function resolveAskUserAnswer(
  input: NormalizedAskUserInput,
  selected: ReadonlySet<string>,
  text: string | undefined,
): AnswerResolution {
  const options = input.options;
  if (!options) {
    const feedback = textFeedback(text);
    return feedback
      ? { feedback }
      : { result: { ok: true, status: "answered", selected_ids: [], text: text! } };
  }

  const selectedIds = options.filter((option) => selected.has(option.id)).map((option) => option.id);
  const answerText = input.allowOther ? submittedText(text) : undefined;
  if (!input.multiple) {
    if (selectedIds.length === 1) {
      return { result: { ok: true, status: "answered", selected_ids: selectedIds } };
    }
    if (answerText !== undefined) {
      if (codePointLength(answerText) > MAX_TEXT_CODE_POINTS) {
        return { feedback: `Keep the answer within ${MAX_TEXT_CODE_POINTS} code points.` };
      }
      return { result: { ok: true, status: "answered", selected_ids: [], text: answerText } };
    }
    return { feedback: input.allowOther ? "Select an option or enter a nonblank answer." : "Select one option." };
  }

  if (answerText !== undefined && codePointLength(answerText) > MAX_TEXT_CODE_POINTS) {
    return { feedback: `Keep the answer within ${MAX_TEXT_CODE_POINTS} code points.` };
  }
  if (selectedIds.length === 0 && answerText === undefined) {
    return { feedback: input.allowOther ? "Select an option or enter a nonblank answer." : "Select at least one option." };
  }
  return {
    result: {
      ok: true,
      status: "answered",
      selected_ids: selectedIds,
      ...(answerText === undefined ? {} : { text: answerText }),
    },
  };
}

function displayText(value: string): string {
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  });
}

function wrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return displayText(value).split("\n").flatMap((line) =>
    line.length === 0 ? [""] : wrapTextWithAnsi(line, safeWidth));
}

function wrapPrefixedText(value: string, prefix: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const continuation = " ".repeat(prefix.length);
  const parts = wrapDisplayText(value, Math.max(1, safeWidth - prefix.length));
  return parts.map((part, index) => truncateToWidth(`${index === 0 ? prefix : continuation}${part}`, safeWidth));
}

function isTextInput(data: string): boolean {
  if (data.includes("\u001b")) return false;
  return Array.from(data).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return character === "\n" || character === "\r" || character === "\t" || code >= 0x20;
  });
}

class AskUserPromptComponent implements Component, Focusable {
  focused = false;
  private optionIndex = 0;
  private text = "";
  private focus: "options" | "text";
  private readonly selected = new Set<string>();
  private feedback: string | undefined;
  private inBracketedPaste = false;
  private readonly input: NormalizedAskUserInput;
  private readonly theme: AskUserTheme;
  private readonly requestRender: () => void;
  private readonly onAnswer: (result: AskUserAnsweredResult) => void;
  private readonly onCancel: () => void;

  constructor(
    input: NormalizedAskUserInput,
    theme: AskUserTheme,
    requestRender: () => void,
    onAnswer: (result: AskUserAnsweredResult) => void,
    onCancel: () => void,
  ) {
    this.input = input;
    this.theme = theme;
    this.requestRender = requestRender;
    this.onAnswer = onAnswer;
    this.onCancel = onCancel;
    this.focus = input.options ? "options" : "text";
  }

  invalidate(): void {}

  private get options(): AskUserOption[] {
    return this.input.options ?? [];
  }

  private get canEnterText(): boolean {
    return !this.input.options || this.input.allowOther;
  }

  private setFeedback(feedback: string | undefined): void {
    this.feedback = feedback;
    this.requestRender();
  }

  private submit(): void {
    const resolution = resolveAskUserAnswer(this.input, this.selected, this.text);
    if (resolution.result) {
      this.onAnswer(resolution.result);
      return;
    }
    this.setFeedback(resolution.feedback ?? "Cannot submit this answer.");
  }

  private selectCurrentOption(): void {
    const option = this.options[this.optionIndex];
    if (!option) return;
    if (this.input.multiple) {
      if (this.selected.has(option.id)) this.selected.delete(option.id);
      else this.selected.add(option.id);
      this.setFeedback(undefined);
      return;
    }
    this.selected.clear();
    this.selected.add(option.id);
    this.submit();
  }

  private deleteLastCodePoint(): void {
    const points = Array.from(this.text);
    points.pop();
    this.text = points.join("");
    this.setFeedback(undefined);
  }

  private appendText(text: string): void {
    this.text += text;
    this.setFeedback(undefined);
  }

  private consumeBracketedPaste(data: string): boolean {
    const start = "\u001b[200~";
    const end = "\u001b[201~";
    if (!this.inBracketedPaste) {
      if (!data.startsWith(start)) return false;
      this.inBracketedPaste = true;
      data = data.slice(start.length);
    }

    const endIndex = data.indexOf(end);
    if (endIndex === -1) {
      this.appendText(data);
      return true;
    }

    this.appendText(data.slice(0, endIndex));
    this.inBracketedPaste = false;
    const trailing = data.slice(endIndex + end.length);
    if (trailing) this.handleTextInput(trailing);
    return true;
  }

  private handleTextInput(data: string): void {
    if (matchesKey(data, Key.ctrl(Key.enter))) {
      this.submit();
      return;
    }
    if (matchesKey(data, Key.tab) && this.input.options) {
      this.focus = "options";
      this.setFeedback(undefined);
      return;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      this.deleteLastCodePoint();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.appendText("\n");
      return;
    }

    const text = decodeKittyPrintable(data) ?? (isTextInput(data) ? data : undefined);
    if (text !== undefined) this.appendText(text);
  }

  private handleOptionInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      this.setFeedback(undefined);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.optionIndex = Math.min(this.options.length - 1, this.optionIndex + 1);
      this.setFeedback(undefined);
      return;
    }
    if (matchesKey(data, Key.tab) && this.canEnterText) {
      this.focus = "text";
      this.setFeedback(undefined);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.selectCurrentOption();
      return;
    }
    if (matchesKey(data, Key.ctrl(Key.enter))) {
      this.submit();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.input.multiple) this.submit();
      else this.selectCurrentOption();
    }
  }

  handleInput(data: string): void {
    if (this.focus === "text" && this.consumeBracketedPaste(data)) return;
    if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (this.focus === "text") this.handleTextInput(data);
    else this.handleOptionInput(data);
  }

  private renderOptions(width: number): string[] {
    const lines: string[] = [];
    for (const [index, option] of this.options.entries()) {
      const active = this.focus === "options" && index === this.optionIndex;
      const mark = this.input.multiple ? (this.selected.has(option.id) ? "[x] " : "[ ] ") : "    ";
      const prefix = `${active ? "> " : "  "}${mark}`;
      const style = active ? (text: string) => this.theme.fg("accent", text) : (text: string) => text;
      lines.push(...wrapPrefixedText(option.label, prefix, width).map(style));
      if (option.description) {
        lines.push(...wrapPrefixedText(option.description, "      ", width).map((line) => this.theme.fg("muted", line)));
      }
    }
    return lines;
  }

  private renderTextInput(width: number): string[] {
    const lines: string[] = [];
    const active = this.focus === "text";
    const heading = active ? this.theme.fg("accent", "Other answer:") : "Other answer:";
    lines.push(truncateToWidth(heading, Math.max(1, width)));
    if (this.text) {
      lines.push(...wrapPrefixedText(this.text, "  ", width));
    } else if (this.input.placeholder) {
      lines.push(...wrapPrefixedText(this.input.placeholder, "  ", width).map((line) => this.theme.fg("dim", line)));
    } else {
      lines.push(this.theme.fg("dim", truncateToWidth("  Type an answer", Math.max(1, width))));
    }
    if (active) lines.push(`${CURSOR_MARKER}${this.theme.fg("accent", "▌")}`);
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = wrapDisplayText(this.input.prompt, safeWidth).map((line) => this.theme.bold(line));
    if (this.input.options) lines.push(...this.renderOptions(safeWidth));
    if (this.canEnterText) lines.push(...this.renderTextInput(safeWidth));
    if (this.feedback) {
      lines.push(...wrapPrefixedText(this.feedback, "! ", safeWidth).map((line) => this.theme.fg("warning", line)));
    }

    const controls = this.input.options
      ? this.input.multiple
        ? "up/down move • space toggle • enter submit"
        : "up/down move • enter select"
      : "ctrl+enter submit";
    const textControls = this.input.options && this.canEnterText ? " • tab switch • ctrl+enter submit" : "";
    lines.push(this.theme.fg("dim", truncateToWidth(`${controls}${textControls} • esc cancel`, safeWidth)));
    return lines;
  }
}

export async function executeAskUser(
  rawInput: unknown,
  ctx: Pick<ExtensionContext, "mode" | "ui">,
  signal: AbortSignal | undefined,
  state: AskUserSessionState,
): Promise<AskUserResult> {
  let input: NormalizedAskUserInput;
  try {
    input = normalizeAskUserInput(rawInput);
  } catch (error) {
    const message = error instanceof AskUserInputError ? error.message : String(error);
    return askUserFailure("INVALID_INPUT", message);
  }

  if (ctx.mode !== "tui") {
    return askUserFailure("UI_UNAVAILABLE", "ask_user requires an interactive TUI.");
  }
  if (state.active) return askUserFailure("PROMPT_ACTIVE", "This session already has an active ask_user prompt.");
  if (signal?.aborted) return askUserFailure("INVOCATION_CANCELLED", "The ask_user invocation was cancelled.");

  const active: ActivePrompt = {};
  let cancellationRecorded = false;
  state.active = active;
  const abort = () => {
    cancellationRecorded = true;
    active.finish?.(askUserFailure("INVOCATION_CANCELLED", "The ask_user invocation was cancelled."));
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    return await ctx.ui.custom<AskUserResult>((tui, theme, _keybindings, done) => {
      let settled = false;
      const finish = (result: AskUserResult): void => {
        if (settled) return;
        settled = true;
        done(result);
      };
      active.finish = finish;
      if (signal?.aborted) {
        abort();
        return new AskUserPromptComponent(
          input,
          theme,
          () => tui.requestRender(),
          finish,
          () => finish(askUserCancelled()),
        );
      }
      return new AskUserPromptComponent(
        input,
        theme,
        () => tui.requestRender(),
        finish,
        () => finish(askUserCancelled()),
      );
    });
  } catch {
    return cancellationRecorded
      ? askUserFailure("INVOCATION_CANCELLED", "The ask_user invocation was cancelled.")
      : askUserFailure("UI_UNAVAILABLE", "The interactive prompt is unavailable.");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (state.active === active) state.active = undefined;
  }
}

export function createAskUserTool(state: AskUserSessionState = {}): ToolDefinition<typeof askUserParameters, AskUserToolDetails> {
  return {
    name: "ask_user",
    label: "ask_user",
    description: "Ask one interactive question with free text, one option, or multiple options.",
    promptSnippet: "Ask the user for required information or a decision",
    promptGuidelines: [
      "Use ask_user only when required information or a decision cannot be inferred safely.",
      "Do not use ask_user to request passwords, access tokens, or other secrets.",
    ],
    parameters: askUserParameters,
    prepareArguments: prepareAskUserArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = detailsFor(await executeAskUser(params, ctx, signal, state));
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

export default function askUserExtension(pi: ExtensionAPI): void {
  const state: AskUserSessionState = {};
  pi.registerTool(createAskUserTool(state));
  pi.on("session_shutdown", () => {
    state.active?.finish?.(askUserFailure("INVOCATION_CANCELLED", "The ask_user invocation was cancelled."));
  });
}
