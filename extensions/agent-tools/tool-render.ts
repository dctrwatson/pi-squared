import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const COLLAPSED_RENDER_LINES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Render untrusted tool data without terminal control characters. */
export function safeRenderText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u000d\u000e-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\t") return "\\t";
    if (character === "\r") return "\\r";
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Render one tool argument in a safe single-line form. */
export function safeRenderArgument(value: unknown): string {
  if (typeof value === "string") return safeRenderText(value).replaceAll("\n", "\\n");
  if (value === undefined) return "";
  try {
    return safeRenderText(JSON.stringify(value) ?? String(value)).replaceAll("\n", "\\n");
  } catch {
    return safeRenderText(String(value)).replaceAll("\n", "\\n");
  }
}

function renderDirectArgument(value: unknown): string {
  if (typeof value !== "string") return safeRenderArgument(value);
  const rendered = safeRenderText(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(rendered) ? rendered : JSON.stringify(rendered);
}

/** Render one tool call with an ellipsis that keeps the row background. */
export function renderTruncatedToolCall(
  text: string,
  theme: Theme,
  isPartial: boolean,
  isError: boolean,
): Component {
  const background = isPartial
    ? "toolPendingBg"
    : isError
      ? "toolErrorBg"
      : "toolSuccessBg";
  const ellipsis = theme.bg(background, "...");

  return {
    render(width) {
      const availableWidth = Math.max(1, width);
      const newline = text.indexOf("\n");
      const firstLine = newline === -1 ? text : text.slice(0, newline);
      const truncated = truncateToWidth(firstLine, availableWidth, ellipsis);
      return [`${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`];
    },
    invalidate() {},
  };
}

/** Render a direct-process invocation with visible argument boundaries. */
export function formatDirectProcessCall(executable: string, args: unknown): string {
  if (!Array.isArray(args)) {
    const rendered = safeRenderArgument(args);
    return rendered ? `$ ${executable} ${rendered}` : `$ ${executable}`;
  }
  const rendered = args.map(renderDirectArgument).join(" ");
  return rendered ? `$ ${executable} ${rendered}` : `$ ${executable}`;
}

/** Report whether a process status represents an unsuccessful invocation. */
export function hasUnsuccessfulProcessStatus(details: unknown): boolean {
  if (!isRecord(details)) return false;
  if (details.ok === false || details.timed_out === true) return true;
  if (typeof details.exit_code === "number" && details.exit_code !== 0) return true;
  return details.signal !== undefined && details.signal !== null;
}

export function renderPreview(content: string, expanded: boolean): string {
  const safe = safeRenderText(content).trimEnd();
  if (expanded || safe.length === 0) return safe;
  const lines = safe.split("\n");
  if (lines.length <= COLLAPSED_RENDER_LINES + 1) return safe;
  return [lines[0], ...lines.slice(-COLLAPSED_RENDER_LINES)].join("\n");
}

export function textContent(result: { content: readonly unknown[] }): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => (
      isRecord(item) && item.type === "text" && typeof item.text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
}
