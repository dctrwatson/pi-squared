import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    Input,
    Markdown,
    hyperlink,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Focusable,
    type KeybindingsManager,
    type TUI,
} from "@earendil-works/pi-tui";
import {
    SubagentSessionController,
    formatSubagentTokens,
    type InputMode,
    type SubagentViewState,
} from "./controller.ts";

type Theme = ExtensionContext["ui"]["theme"];
const MAX_TOOL_OUTPUT_LINES = 10;

export {
    MAX_SUBAGENT_TRANSCRIPT_ITEMS,
    promptFingerprint,
    SubagentSessionController,
} from "./controller.ts";
export type {
    AssistantItem,
    InputMode,
    RunSubagentDialogOptions,
    StatusItem,
    SubagentPromptAttribution,
    SubagentPromptCompletion,
    SubagentPromptSource,
    SubagentStatusLevel,
    SubagentViewState,
    ToolItem,
    TranscriptItem,
    UserItem,
} from "./controller.ts";

export type SubagentDialogResult =
    | { action: "return"; text: string }
    | { action: "cancel" };

export function getSubagentPanelWidths(width: number): { dialogWidth: number; innerWidth: number } | undefined {
    if (width < 3) return undefined;
    return { dialogWidth: width, innerWidth: width - 2 };
}

/** Render capability-aware panel controls with one separator between each hint. */
export function renderSubagentPanelControls(
    state: Pick<SubagentViewState, "busy" | "canFollowUp" | "readOnly">,
    capabilities: Pick<SubagentSessionController["capabilities"], "steering" | "queuedFollowUp">,
    hint: (action: Parameters<typeof keyHint>[0], label: string) => string = keyHint,
): string {
    const readOnly = state.readOnly === true;
    const controls = [
        !readOnly && (!state.busy || capabilities.steering)
            ? hint("tui.input.submit", state.busy ? "steer" : state.canFollowUp ? "follow-up" : "send")
            : undefined,
        !readOnly && capabilities.queuedFollowUp ? hint("app.message.followUp", "follow-up") : undefined,
        hint("app.interrupt", state.busy ? "abort" : "close"),
        state.busy ? hint("app.exit", "detach") : undefined,
        hint("app.message.copy", "return"),
    ].filter((control): control is string => Boolean(control));
    return controls.join(" · ");
}

function wrapPlain(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    for (const line of text.split("\n")) {
        if (!line) {
            lines.push("");
            continue;
        }
        lines.push(...wrapTextWithAnsi(line, safeWidth));
    }
    return lines;
}

function formatUsageLine(state: SubagentViewState): string {
    const parts: string[] = [];
    if (state.usage.turns) parts.push(`${state.usage.turns} turn${state.usage.turns === 1 ? "" : "s"}`);
    if (state.usage.input) parts.push(`↑${formatSubagentTokens(state.usage.input)}`);
    if (state.usage.output) parts.push(`↓${formatSubagentTokens(state.usage.output)}`);
    if (state.usage.cacheRead) parts.push(`R${formatSubagentTokens(state.usage.cacheRead)}`);
    if (state.usage.cacheWrite) parts.push(`W${formatSubagentTokens(state.usage.cacheWrite)}`);
    if (state.usage.cost.total) parts.push(`$${state.usage.cost.total.toFixed(4)}`);
    const context = state.stats?.contextUsage;
    if (context) {
        const current = context.tokens === null ? "?" : formatSubagentTokens(context.tokens);
        parts.push(`ctx:${current}/${formatSubagentTokens(context.contextWindow)}`);
    }
    return parts.join(" ");
}

function formatDuration(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
    if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
    return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function cursorAgentPageUrl(agentId: string): string | undefined {
    if (!/^bc-[A-Za-z0-9-]+$/.test(agentId)) return undefined;
    return `https://cursor.com/agents/${encodeURIComponent(agentId)}`;
}

/** Render dynamic model and thinking options without inspecting backend internals. */
export function renderSubagentPanelOptions(
    state: Pick<SubagentViewState, "controls">,
    hint: (action: Parameters<typeof keyHint>[0], label: string) => string = keyHint,
): string {
    return [
        state.controls.model ? hint("app.model.select", "model") : undefined,
        state.controls.thinking ? hint("app.thinking.cycle", "thinking") : undefined,
        hint("app.thinking.toggle", "thoughts"),
        hint("app.tools.expand", "details"),
        hint("tui.select.pageUp", "scroll"),
    ].filter((option): option is string => Boolean(option)).join(" · ");
}

/** Render details that are not shown in the panel status line. */
export function renderSubagentPanelDetails(state: SubagentViewState, width: number, theme: Theme): string[] {
    const details = state.details;
    const safeWidth = Math.max(1, width);
    const lines = [theme.fg("muted", theme.bold("Subagent details"))];
    const add = (label: string, value: string, color: "dim" | "warning" = "dim") => {
        lines.push(...wrapPlain(theme.fg(color, `${label}: ${value}`), safeWidth));
    };
    if (state.connection && !details?.agent && state.connection.runtime !== "cursor-cloud") {
        add("Connection", `${state.connection.runtime}/${state.connection.id}`);
    }
    if (details?.agent) {
        const url = cursorAgentPageUrl(details.agent.id);
        if (url) add("Cursor", hyperlink(url, url));
        else add("Agent ID", details.agent.id);
    }
    if (details?.run) add("Run ID", details.run.id);
    else if (state.run) add("Active run ID", state.run.id);
    else if (state.lastRun) add("Last run ID", state.lastRun.id);
    const duration = formatDuration(state.durationMs);
    if (duration) add("Duration", duration);
    for (const repository of details?.repositories ?? []) {
        add("Repository", `${repository.url}${repository.startingRef ? ` @ ${repository.startingRef}` : ""}`);
    }
    for (const artifact of details?.artifacts ?? []) {
        const metadata = [
            artifact.path ? `path ${artifact.path}` : undefined,
            artifact.url ? `URL ${artifact.url}` : undefined,
            artifact.sizeBytes === undefined ? undefined : `${artifact.sizeBytes} bytes`,
            artifact.updatedAt ? `updated ${artifact.updatedAt}` : undefined,
            `ID ${artifact.id}`,
        ].filter((value): value is string => Boolean(value));
        add("Artifact", `${artifact.name}${metadata.length ? ` (${metadata.join(", ")})` : ""}`);
    }
    for (const warning of details?.runtimeWarnings ?? []) add("Runtime warning", warning, "warning");
    for (const warning of details?.policyWarnings ?? []) add("Policy warning", warning, "warning");
    return lines.length > 1 ? lines : [];
}

function renderTranscript(
    state: SubagentViewState,
    width: number,
    theme: Theme,
    showThinking: boolean,
    showToolOutput: boolean,
): string[] {
    const lines: string[] = [];
    const markdownTheme = getMarkdownTheme();
    const safeWidth = Math.max(1, width);
    const addSpacer = () => {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    };

    if (state.omittedItems > 0) {
        lines.push(theme.fg(
            "dim",
            `[${state.omittedItems} earlier transcript item${state.omittedItems === 1 ? "" : "s"} omitted from this panel; full history remains in the subagent session.]`,
        ));
    }

    for (const item of state.items) {
        switch (item.kind) {
            case "user": {
                addSpacer();
                const actor = item.source === "human"
                    ? "You"
                    : item.source === "parent"
                        ? "Parent agent"
                        : item.source === "context"
                            ? "Parent context"
                            : "Previous prompt";
                const qualifier = item.mode === "prompt" ? "" : item.mode === "steer" ? " · steer" : " · follow-up";
                lines.push(theme.fg("accent", theme.bold(`${actor}${qualifier}`)));
                lines.push(...wrapPlain(item.text, safeWidth));
                break;
            }
            case "assistant": {
                addSpacer();
                const suffix = item.streaming
                    ? " · streaming"
                    : item.stopReason && item.stopReason !== "stop"
                        ? ` · ${item.stopReason}`
                        : "";
                lines.push(theme.fg("success", theme.bold(`Subagent${suffix}`)));
                if (item.thinking) {
                    if (showThinking) {
                        lines.push(theme.fg("dim", "Thinking:"));
                        lines.push(...wrapPlain(theme.fg("dim", item.thinking), safeWidth));
                    } else {
                        lines.push(theme.fg("dim", "Thinking hidden"));
                    }
                }
                if (item.text) {
                    try {
                        lines.push(...new Markdown(item.text, 0, 0, markdownTheme).render(safeWidth));
                    } catch {
                        lines.push(...wrapPlain(item.text, safeWidth));
                    }
                } else if (!item.thinking) {
                    lines.push(theme.fg("dim", item.streaming ? "…" : "(no visible text)"));
                }
                if (item.errorMessage) lines.push(...wrapPlain(theme.fg("error", item.errorMessage), safeWidth));
                break;
            }
            case "tool": {
                const icon = item.status === "running" ? "⚙" : item.status === "error" ? "✗" : "✓";
                const color = item.status === "error" ? "error" : item.status === "done" ? "success" : "warning";
                const label = `${theme.fg(color, `${icon} `)}${theme.fg("toolTitle", item.name)}${item.args ? theme.fg("dim", ` ${item.args}`) : ""}`;
                lines.push(...wrapPlain(label, safeWidth));
                if (showToolOutput && item.output) {
                    const outputLines = wrapPlain(theme.fg(item.status === "error" ? "error" : "toolOutput", item.output), safeWidth);
                    const omitted = Math.max(0, outputLines.length - MAX_TOOL_OUTPUT_LINES);
                    if (omitted) lines.push(theme.fg("dim", `  … ${omitted} earlier output lines`));
                    for (const outputLine of outputLines.slice(-MAX_TOOL_OUTPUT_LINES)) lines.push(`  ${outputLine}`);
                }
                break;
            }
            case "status": {
                const icon = item.level === "error" ? "✗" : item.level === "warning" ? "!" : item.level === "success" ? "✓" : "·";
                const color = item.level === "info" ? "dim" : item.level;
                lines.push(...wrapPlain(theme.fg(color, `${icon} ${item.text}`), safeWidth));
                break;
            }
        }
    }

    if (state.extensionUi && (state.extensionStatuses.size > 0 || state.extensionWidgets.size > 0)) {
        addSpacer();
        lines.push(theme.fg("muted", theme.bold("Subagent extension UI")));
        for (const [key, value] of state.extensionStatuses) {
            lines.push(...wrapPlain(theme.fg("dim", `${key}: ${value}`), safeWidth));
        }
        for (const [key, widgetLines] of state.extensionWidgets) {
            lines.push(theme.fg("dim", `${key}:`));
            for (const line of widgetLines) lines.push(...wrapPlain(line, safeWidth));
        }
    }

    if (showToolOutput) {
        const details = renderSubagentPanelDetails(state, safeWidth, theme);
        if (details.length > 0) {
            addSpacer();
            lines.push(...details);
        }
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > 0 ? lines : [theme.fg("dim", "No subagent messages yet. Type a prompt below.")];
}

export class SubagentPanel implements Focusable {
    private readonly input = new Input();
    private _focused = false;
    private showThinking = true;
    private showToolOutput = true;
    private scrollFromBottom = 0;
    private lastTranscriptHeight = 10;
    private cachedWidth: number | undefined;
    private cachedRevision = -1;
    private cachedThinking = true;
    private cachedToolOutput = true;
    private cachedTranscript: string[] | undefined;
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly keybindings: KeybindingsManager;
    private readonly controller: SubagentSessionController;
    private readonly title: string;
    private readonly onReturn: (text: string) => void;
    private readonly onCancel: () => void;

    get focused(): boolean {
        return this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        this.input.focused = value;
    }

    constructor(
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        controller: SubagentSessionController,
        title: string,
        onReturn: (text: string) => void,
        onCancel: () => void,
    ) {
        this.tui = tui;
        this.theme = theme;
        this.keybindings = keybindings;
        this.controller = controller;
        this.title = title;
        this.onReturn = onReturn;
        this.onCancel = onCancel;
        this.input.onSubmit = (value) => {
            void this.submitInput(value);
        };
        this.input.onEscape = () => {
            if (this.controller.state.busy) void this.controller.interrupt();
            else this.onCancel();
        };
    }

    setInput(text: string): void {
        this.input.setValue(text);
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (this.keybindings.matches(data, "app.message.copy")) {
            const text = this.controller.returnText();
            if (text !== undefined) this.onReturn(text);
            return;
        }
        if (this.keybindings.matches(data, "app.interrupt")) {
            if (this.controller.state.busy) void this.controller.interrupt();
            else this.onCancel();
            return;
        }
        if (this.keybindings.matches(data, "app.exit") && !this.input.getValue()) {
            this.onCancel();
            return;
        }
        if (this.controller.state.readOnly) {
            this.controller.setTransientStatus("This completed result is read-only. Return it before sending another prompt.", "warning");
            return;
        }
        if (this.controller.state.busy && !this.controller.capabilities.steering && !this.controller.capabilities.queuedFollowUp) {
            this.controller.setTransientStatus("The subagent is working. Wait for it to settle before sending a follow-up.", "info");
            return;
        }
        if (this.keybindings.matches(data, "app.message.followUp")) {
            if (!this.controller.capabilities.queuedFollowUp) {
                this.controller.setTransientStatus("The subagent backend does not support queued follow-ups.", "warning");
            } else {
                void this.submitInput(this.input.getValue(), "followUp");
            }
            return;
        }
        if (this.keybindings.matches(data, "app.model.select")) {
            void this.controller.selectModel();
            return;
        }
        if (this.keybindings.matches(data, "app.model.cycleForward")) {
            void this.controller.cycleModel();
            return;
        }
        if (this.keybindings.matches(data, "app.model.cycleBackward")) {
            void this.controller.selectModel();
            return;
        }
        if (this.keybindings.matches(data, "app.thinking.cycle")) {
            void this.controller.cycleThinking();
            return;
        }
        if (this.keybindings.matches(data, "app.thinking.toggle")) {
            this.showThinking = !this.showThinking;
            this.invalidate();
            return;
        }
        if (this.keybindings.matches(data, "app.tools.expand")) {
            this.showToolOutput = !this.showToolOutput;
            this.invalidate();
            return;
        }
        if (this.keybindings.matches(data, "tui.select.pageUp")) {
            this.scrollFromBottom += Math.max(1, this.lastTranscriptHeight - 2);
            this.tui.requestRender();
            return;
        }
        if (this.keybindings.matches(data, "tui.select.pageDown")) {
            this.scrollFromBottom = Math.max(0, this.scrollFromBottom - Math.max(1, this.lastTranscriptHeight - 2));
            this.tui.requestRender();
            return;
        }
        this.input.handleInput(data);
        this.tui.requestRender();
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedTranscript = undefined;
        this.tui.requestRender();
    }

    render(width: number): string[] {
        if (width <= 0) return [];
        const widths = getSubagentPanelWidths(width);
        if (!widths) return [this.theme.fg("borderMuted", "·".repeat(width))];

        const { innerWidth } = widths;
        const terminalRows = process.stdout.rows ?? 32;
        const transcriptHeight = Math.max(8, Math.min(42, terminalRows - 11));
        this.lastTranscriptHeight = transcriptHeight;

        const transcript = this.getTranscript(innerWidth);
        const maxScroll = Math.max(0, transcript.length - transcriptHeight);
        this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
        const end = Math.max(transcriptHeight, transcript.length - this.scrollFromBottom);
        const visible = transcript.slice(Math.max(0, end - transcriptHeight), end);
        const padding = Math.max(0, transcriptHeight - visible.length);

        const state = this.controller.state;
        const model = state.model ? `${state.model.provider}/${state.model.id}` : "no model";
        const usage = formatUsageLine(state);
        const status = `${model} · thinking ${state.thinking} · ${state.phase}${usage ? ` · ${usage}` : ""}`;
        const scroll = this.scrollFromBottom > 0 ? ` · ${this.scrollFromBottom} lines below` : "";

        const previousFocus = this.input.focused;
        this.input.focused = false;
        const inputLine = state.readOnly
            ? this.theme.fg("dim", "Completed result retained for delivery (read-only)")
            : state.busy && !this.controller.capabilities.steering && !this.controller.capabilities.queuedFollowUp
                ? this.theme.fg("dim", "Subagent is working; wait for settlement")
                : this.input.render(innerWidth)[0] ?? "";
        this.input.focused = previousFocus;

        const lines = [
            this.border(innerWidth, "top"),
            this.frame(this.theme.fg("accent", this.theme.bold(` ${this.title} `)), innerWidth),
            this.frame(this.theme.fg("dim", `${status}${scroll}`), innerWidth),
            this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
        ];
        for (const line of visible) lines.push(this.frame(line, innerWidth));
        for (let index = 0; index < padding; index++) lines.push(this.frame("", innerWidth));
        lines.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
        lines.push(this.frame(inputLine, innerWidth));
        lines.push(this.frame(renderSubagentPanelControls(state, this.controller.capabilities), innerWidth));
        lines.push(this.frame(renderSubagentPanelOptions(state), innerWidth));
        lines.push(this.border(innerWidth, "bottom"));
        return lines;
    }

    private async submitInput(rawValue: string, mode?: InputMode): Promise<void> {
        const value = rawValue.trim();
        if (!value) {
            this.controller.setTransientStatus("Enter a subagent prompt first.", "warning");
            return;
        }
        this.input.setValue("");
        this.tui.requestRender();
        const accepted = await this.controller.submit(value, mode);
        if (!accepted && !this.input.getValue()) this.input.setValue(rawValue);
        this.tui.requestRender();
    }

    private getTranscript(width: number): string[] {
        const state = this.controller.state;
        if (
            this.cachedTranscript &&
            this.cachedWidth === width &&
            this.cachedRevision === state.revision &&
            this.cachedThinking === this.showThinking &&
            this.cachedToolOutput === this.showToolOutput
        ) {
            return this.cachedTranscript;
        }
        this.cachedTranscript = renderTranscript(state, width, this.theme, this.showThinking, this.showToolOutput);
        this.cachedWidth = width;
        this.cachedRevision = state.revision;
        this.cachedThinking = this.showThinking;
        this.cachedToolOutput = this.showToolOutput;
        return this.cachedTranscript;
    }

    private frame(content: string, width: number): string {
        const truncated = truncateToWidth(content, width, "");
        return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${this.theme.fg("borderMuted", "│")}`;
    }

    private border(width: number, edge: "top" | "bottom"): string {
        return this.theme.fg("borderMuted", `${edge === "top" ? "┌" : "└"}${"─".repeat(width)}${edge === "top" ? "┐" : "┘"}`);
    }
}

export async function runSubagentDialog(
    ctx: ExtensionContext,
    controller: SubagentSessionController,
    title: string,
    initialPrompt = "",
): Promise<SubagentDialogResult | undefined> {
    let detach: (() => void) | undefined;
    try {
        return await ctx.ui.custom<SubagentDialogResult>((tui, theme, keybindings, done) => {
            let finished = false;
            const finish = (result: SubagentDialogResult) => {
                if (finished) return;
                finished = true;
                done(result);
            };
            const panel = new SubagentPanel(
                tui,
                theme,
                keybindings,
                controller,
                title,
                (text) => finish({ action: "return", text }),
                () => finish({ action: "cancel" }),
            );
            panel.focused = true;
            detach = controller.attach(ctx, () => {
                panel.invalidate();
            }, (text) => panel.setInput(text));
            queueMicrotask(() => {
                void controller.start()
                    .then(async () => {
                        if (initialPrompt.trim()) await controller.submit(initialPrompt, "prompt", "human");
                    })
                    .catch(() => {});
            });
            return panel;
        }, {
            overlay: true,
            overlayOptions: {
                width: "94%",
                minWidth: 72,
                maxHeight: "94%",
                anchor: "top-center",
                margin: { top: 1, left: 1, right: 1 },
            },
        });
    } finally {
        detach?.();
        // Cloud observation is local. Closing one panel must not disconnect another.
        await controller.disposePanelObservation();
    }
}
