import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type Keybinding,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { omitNullOptionalFields, prepareInputArguments } from "./optional-input.ts";
import type { ToolFailureDetails, ToolSuccessDetails } from "./tool-result.ts";

const MAX_PROMPT_CODE_POINTS = 4_000;
const MAX_OPTIONS = 20;
const MAX_OPTION_ID_LENGTH = 64;
const MAX_LABEL_CODE_POINTS = 200;
const MAX_DESCRIPTION_CODE_POINTS = 500;
const MAX_PLACEHOLDER_CODE_POINTS = 200;
const MAX_TEXT_CODE_POINTS = 16_384;
const OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASK_USER_OPTIONAL_FIELDS = ["options", "multiple", "allow_other", "placeholder"];

const askUserOptionParameters = Type.Object({
  id: Type.String({ description: "Stable option identifier" }),
  label: Type.String({ description: "Option text shown to the user" }),
  description: Type.Optional(Type.String({ description: "Optional supporting text for the option" })),
}, { additionalProperties: false });

const askUserParameters = Type.Object({
  prompt: Type.String({ description: "Complete plain-text question to show to the user" }),
  options: Type.Optional(Type.Array(askUserOptionParameters, { description: "Optional answer options with id, label, and optional description" })),
  multiple: Type.Optional(Type.Boolean({ description: "Permit more than one option; valid only with options" })),
  allow_other: Type.Optional(Type.Boolean({ description: "Permit a free-text answer with options; valid only with options" })),
  placeholder: Type.Optional(Type.String({ description: "Hint for an available free-text input" })),
}, { additionalProperties: false });

export type AskUserToolInput = Static<typeof askUserParameters>;

export function prepareAskUserArguments(rawInput: unknown): AskUserToolInput {
  const prepared = omitNullOptionalFields(rawInput, ASK_USER_OPTIONAL_FIELDS);
  if (isRecord(prepared) && Array.isArray(prepared.options)) {
    prepared.options = prepared.options.map((option, index) => prepareInputArguments<AskUserOption>(
      option,
      ["description"],
      (value) => normalizeOption(value, index),
    ));
  }
  return prepareInputArguments(prepared, ASK_USER_OPTIONAL_FIELDS, normalizeAskUserInput);
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
  value = omitNullOptionalFields(value, ["description"]);
  if (!isRecord(value)) throw new AskUserInputError(`options[${index}] must be an object.`);
  const allowed = new Set(["id", "label", "description"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new AskUserInputError("Unknown option field.");

  if (typeof value.id !== "string" || !OPTION_ID_PATTERN.test(value.id) || value.id.length > MAX_OPTION_ID_LENGTH) {
    throw new AskUserInputError(`options[${index}].id is invalid.`);
  }

  const label = requireText(value.label, `options[${index}].label`, MAX_LABEL_CODE_POINTS);
  if (value.description === undefined) return { id: value.id, label };
  return {
    id: value.id,
    label,
    description: requireText(value.description, `options[${index}].description`, MAX_DESCRIPTION_CODE_POINTS),
  };
}

export function normalizeAskUserInput(rawInput: unknown): NormalizedAskUserInput {
  rawInput = omitNullOptionalFields(rawInput, ASK_USER_OPTIONAL_FIELDS);
  if (!isRecord(rawInput)) throw new AskUserInputError("Input must be an object.");
  const allowed = new Set(["prompt", "options", "multiple", "allow_other", "placeholder"]);
  const unknown = Object.keys(rawInput).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new AskUserInputError("Unknown input field.");

  const prompt = requireText(rawInput.prompt, "prompt", MAX_PROMPT_CODE_POINTS);
  if (rawInput.options === undefined) {
    if (rawInput.multiple !== undefined || rawInput.allow_other !== undefined) {
      throw new AskUserInputError("multiple and allow_other require options.");
    }
    if (rawInput.placeholder === undefined) return { prompt, multiple: false, allowOther: true };
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

  const multiple = rawInput.multiple === undefined ? false : rawInput.multiple;
  if (typeof multiple !== "boolean") throw new AskUserInputError("multiple must be a boolean.");
  const allowOther = rawInput.allow_other === undefined ? true : rawInput.allow_other;
  if (typeof allowOther !== "boolean") throw new AskUserInputError("allow_other must be a boolean.");
  if (rawInput.placeholder !== undefined && !allowOther) {
    throw new AskUserInputError("placeholder requires an available free-text input.");
  }

  return {
    prompt,
    options,
    multiple,
    allowOther,
    ...(rawInput.placeholder !== undefined
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

class AskUserPromptComponent implements Component, Focusable {
  private wrapperFocused = false;
  private optionIndex = 0;
  private focus: "options" | "text";
  private readonly selected = new Set<string>();
  private feedback: string | undefined;
  private pasteTarget: "text" | "discard" | undefined;
  private pasteEndPrefix = "";
  private readonly input: NormalizedAskUserInput;
  private readonly theme: AskUserTheme;
  private readonly editor: Editor;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly onAnswer: (result: AskUserAnsweredResult) => void;
  private readonly onCancel: () => void;

  constructor(
    input: NormalizedAskUserInput,
    theme: AskUserTheme,
    editor: Editor,
    keybindings: KeybindingsManager,
    requestRender: () => void,
    onAnswer: (result: AskUserAnsweredResult) => void,
    onCancel: () => void,
  ) {
    this.input = input;
    this.theme = theme;
    this.editor = editor;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.onAnswer = onAnswer;
    this.onCancel = onCancel;
    this.focus = input.options ? "options" : "text";
    this.editor.onChange = () => this.setFeedback(undefined);
    this.updateEditorFocus();
  }

  get focused(): boolean {
    return this.wrapperFocused;
  }

  set focused(focused: boolean) {
    this.wrapperFocused = focused;
    this.updateEditorFocus();
  }

  private updateEditorFocus(): void {
    this.editor.focused = this.wrapperFocused && this.focus === "text";
  }

  private switchFocus(focus: "options" | "text"): void {
    this.focus = focus;
    this.updateEditorFocus();
    this.setFeedback(undefined);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

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
    const resolution = resolveAskUserAnswer(this.input, this.selected, this.editor.getExpandedText());
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

  private forwardToEditor(data: string): void {
    this.editor.handleInput(data);
    this.requestRender();
  }

  private consumeBracketedPaste(data: string): boolean {
    const start = "\u001b[200~";
    const end = "\u001b[201~";
    if (this.pasteTarget === undefined) {
      if (!data.startsWith(start)) return false;
      this.pasteTarget = this.focus === "text" ? "text" : "discard";
      if (this.pasteTarget === "text") this.forwardToEditor(start);
      data = data.slice(start.length);
    }

    data = this.pasteEndPrefix + data;
    this.pasteEndPrefix = "";
    const endIndex = data.indexOf(end);
    if (endIndex !== -1) {
      if (this.pasteTarget === "text") this.forwardToEditor(data.slice(0, endIndex + end.length));
      this.pasteTarget = undefined;
      const trailing = data.slice(endIndex + end.length);
      if (trailing) this.handleInput(trailing);
      return true;
    }

    // Retain a possible end-marker suffix, not the paste body.
    for (let length = Math.min(data.length, end.length - 1); length > 0; length--) {
      if (end.startsWith(data.slice(-length))) {
        this.pasteEndPrefix = data.slice(-length);
        data = data.slice(0, -length);
        break;
      }
    }
    if (data && this.pasteTarget === "text") this.forwardToEditor(data);
    return true;
  }

  private handleTextInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.copy")) {
      this.forwardToEditor(data);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.newLine")) {
      this.forwardToEditor(data);
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit")) {
      this.submit();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab") && this.input.options) {
      this.switchFocus("options");
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    this.forwardToEditor(data);
  }

  private handleOptionInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.tab")) {
      if (this.canEnterText) this.switchFocus("text");
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.optionIndex = Math.max(0, this.optionIndex - 1);
      this.setFeedback(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.optionIndex = Math.min(this.options.length - 1, this.optionIndex + 1);
      this.setFeedback(undefined);
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.selectCurrentOption();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.input.multiple) this.submit();
      else this.selectCurrentOption();
      return;
    }
    if (this.keybindings.matches(data, "tui.input.submit")) this.submit();
  }

  handleInput(data: string): void {
    if (this.consumeBracketedPaste(data)) return;
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
    const heading = this.focus === "text" ? this.theme.fg("accent", "Other answer:") : "Other answer:";
    const lines = [truncateToWidth(heading, width, "")];
    if (!this.editor.getExpandedText()) {
      lines.push(...wrapDisplayText(this.input.placeholder ?? "Type an answer", width)
        .map((line) => this.theme.fg("dim", line)));
    }
    lines.push(...this.editor.render(Math.max(3, width)).map((line) => truncateToWidth(line, width, "")));
    return lines;
  }

  private keyLabel(action: Keybinding): string {
    return this.keybindings.getKeys(action).join("/") || "unbound";
  }

  private textCancelLabel(): string {
    const normalize = (key: string) => key.toLowerCase().split("+")
      .map((part) => part === "return" ? "enter" : part === "esc" ? "escape" : part).sort().join("+");
    const actions: Keybinding[] = ["tui.input.copy", "tui.input.newLine", "tui.input.submit"];
    if (this.input.options) actions.push("tui.input.tab");
    const claimed = new Set(actions.flatMap((action) => this.keybindings.getKeys(action).map(normalize)));
    return this.keybindings.getKeys("tui.select.cancel").filter((key) => !claimed.has(normalize(key))).join("/") || "unbound";
  }

  private renderControls(): string {
    const controls = this.focus === "text"
      ? [`${this.keyLabel("tui.input.submit")} submit`, `${this.keyLabel("tui.input.newLine")} newline`]
      : [
        `${this.keyLabel("tui.select.up")}/${this.keyLabel("tui.select.down")} move`,
        `space ${this.input.multiple ? "toggle" : "select"}`,
        `${this.keyLabel("tui.select.confirm")} ${this.input.multiple ? "submit" : "select"}`,
        `${this.keyLabel("tui.input.submit")} submit`,
      ];
    if (this.input.options && this.canEnterText) controls.push(`${this.keyLabel("tui.input.tab")} switch`);
    controls.push(`${this.focus === "text" ? this.textCancelLabel() : this.keyLabel("tui.select.cancel")} cancel`);
    return controls.join(" • ");
  }

  render(width: number): string[] {
    const actualWidth = Math.max(1, width);
    const lines = wrapDisplayText(this.input.prompt, actualWidth).map((line) => this.theme.bold(line));
    if (this.input.options) lines.push(...this.renderOptions(actualWidth));
    if (this.canEnterText) lines.push(...this.renderTextInput(actualWidth));
    if (this.feedback) {
      lines.push(...wrapPrefixedText(this.feedback, "! ", actualWidth).map((line) => this.theme.fg("warning", line)));
    }
    lines.push(this.theme.fg("dim", truncateToWidth(this.renderControls(), actualWidth)));
    return lines.map((line) => truncateToWidth(line, actualWidth, ""));
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
    return await ctx.ui.custom<AskUserResult>((tui, theme, keybindings, done) => {
      let settled = false;
      const finish = (result: AskUserResult): void => {
        if (settled) return;
        settled = true;
        done(result);
      };
      active.finish = finish;
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const editor = new Editor(tui, editorTheme);
      editor.disableSubmit = true;
      if (signal?.aborted) abort();
      return new AskUserPromptComponent(
        input,
        theme,
        editor,
        keybindings,
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

export function createAskUserTool(
  state: AskUserSessionState = {},
  prepareLoadout?: ToolDefinition["prepareLoadout"],
): ToolDefinition<typeof askUserParameters, AskUserToolDetails> {
  return {
    name: "ask_user",
    exposure: "model-only",
    defaultActive: true,
    prepareLoadout,
    label: "ask_user",
    description: "Ask one question in the interactive TUI, with free text, options, or both.",
    promptSnippet: "Ask the user for required information or a decision",
    promptGuidelines: [
      "Use ask_user only when required information or a decision cannot be safely inferred.",
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

export function registerAskUserTool(pi: ExtensionAPI, prepareLoadout?: ToolDefinition["prepareLoadout"]): void {
  const state: AskUserSessionState = {};
  pi.registerTool(createAskUserTool(state, prepareLoadout));
  pi.on("session_shutdown", () => {
    state.active?.finish?.(askUserFailure("INVOCATION_CANCELLED", "The ask_user invocation was cancelled."));
  });
}
