/**
 * Handoff Extension
 *
 * Starts a fresh session with a focused context transfer in the editor.
 *
 * Usage:
 *   /handoff          Transfer the last complete assistant response verbatim.
 *   /handoff generate Generate a self-contained handoff from active context.
 */

import { completeSimple, type AssistantMessage, type Message } from "@earendil-works/pi-ai/compat";
import {
    BorderedLoader,
    convertToLlm,
    sessionEntryToContextMessages,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const HANDOFF_SYSTEM_PROMPT = `You are a session handoff writer. Your only task is to produce the text that will become the first user message in a fresh coding-agent session.

Transfer the working context with maximum fidelity and minimal compression. The new session will not have access to this conversation.

Preserve all relevant:
- User goals, requirements, constraints, and preferences
- Decisions already made and their important rationale
- Work completed, work in progress, and work not yet attempted
- Exact file paths, symbols, commands, errors, test results, and other concrete details
- Unresolved questions, blockers, risks, and expected next actions

Rules:
- Do not continue or solve the task.
- Do not call tools.
- Do not invent details or silently resolve ambiguity.
- Do not expose hidden reasoning or thinking. Transfer conclusions and relevant facts only.
- Do not copy irrelevant conversational history or raw tool logs. Preserve the useful facts they established.
- Do not optimize for brevity. Omit only genuinely irrelevant or redundant material.
- Make the result self-contained and directly actionable by the next model.
- Write it as context and instructions addressed to the next model.
- Output only the handoff text, with no preamble, commentary, or code fence.`;

const HANDOFF_GENERATION_REQUEST = "Create the handoff now.";

type HandoffMode = "verbatim" | "generate";
type ActiveModel = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export function parseHandoffMode(args: string): HandoffMode | undefined {
    const value = args.trim();
    if (!value) return "verbatim";
    if (value === "generate") return "generate";
    return undefined;
}

/** Extract only visible assistant text, preserving text-block order and contents. */
export function extractVisibleAssistantText(message: Pick<AssistantMessage, "content">): string {
    return message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

/**
 * Return the newest assistant response only when it completed normally and has
 * visible text. An incomplete newest response deliberately falls back to
 * generated handoff context rather than an older response.
 */
export function getLastCompleteAssistantText(entries: readonly SessionEntry[]): string | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (!entry || entry.type !== "message" || entry.message.role !== "assistant") continue;
        if (entry.message.stopReason !== "stop") return undefined;

        const text = extractVisibleAssistantText(entry.message);
        return text.trim() ? text : undefined;
    }

    return undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function buildHandoffGenerationMessages(entries: readonly SessionEntry[]): Message[] {
    const messages = convertToLlm(entries.flatMap(sessionEntryToContextMessages));

    return [
        ...messages,
        {
            role: "user",
            content: [{ type: "text", text: HANDOFF_GENERATION_REQUEST }],
            timestamp: Date.now(),
        },
    ];
}

function buildGenerationMessages(ctx: ExtensionContext): Message[] {
    return buildHandoffGenerationMessages(ctx.sessionManager.buildContextEntries());
}

async function generateHandoffText(
    ctx: ExtensionContext,
    model: ActiveModel,
    thinkingLevel: ThinkingLevel,
    signal: AbortSignal,
): Promise<string> {
    const messages = buildGenerationMessages(ctx);
    if (messages.length === 1) {
        throw new Error("No conversation to hand off");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const response = await completeSimple(
        model,
        {
            systemPrompt: HANDOFF_SYSTEM_PROMPT,
            messages,
        },
        {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            signal,
            ...(model.reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
        },
    );

    if (response.stopReason === "aborted") {
        throw new Error("Handoff generation was aborted");
    }
    if (response.stopReason !== "stop") {
        throw new Error(`Handoff generation did not complete (${response.stopReason})${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
    }

    const text = extractVisibleAssistantText(response);
    if (!text.trim()) throw new Error("Handoff generation returned no visible text");
    return text;
}

async function generateWithLoader(
    ctx: ExtensionCommandContext,
    model: ActiveModel,
    thinkingLevel: ThinkingLevel,
): Promise<string | undefined> {
    let generationError: unknown;

    const text = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, `Generating handoff with ${model.id}...`);
        let finished = false;
        const finish = (value: string | undefined) => {
            if (finished) return;
            finished = true;
            done(value);
        };

        loader.onAbort = () => finish(undefined);

        void generateHandoffText(ctx, model, thinkingLevel, loader.signal)
            .then(finish)
            .catch((error) => {
                if (!loader.signal.aborted) generationError = error;
                finish(undefined);
            });

        return loader;
    });

    if (generationError !== undefined) throw generationError;
    return text;
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("handoff", {
        description: "Start a fresh session with the latest response or generated context handoff",
        handler: async (args, ctx) => {
            if (ctx.mode !== "tui") {
                if (ctx.hasUI) ctx.ui.notify("/handoff requires TUI mode", "error");
                return;
            }

            const mode = parseHandoffMode(args);
            if (!mode) {
                ctx.ui.notify("Usage: /handoff [generate]", "error");
                return;
            }

            if (!ctx.isIdle()) {
                ctx.ui.notify("/handoff is only available when the agent is idle", "error");
                return;
            }

            const sourceSessionFile = ctx.sessionManager.getSessionFile();
            let handoffText =
                mode === "verbatim" ? getLastCompleteAssistantText(ctx.sessionManager.getBranch()) : undefined;

            if (handoffText === undefined) {
                const model = ctx.model;
                if (!model) {
                    ctx.ui.notify("No model selected to generate a handoff", "error");
                    return;
                }

                try {
                    handoffText = await generateWithLoader(ctx, model, pi.getThinkingLevel());
                } catch (error) {
                    ctx.ui.notify(`Handoff generation failed: ${errorMessage(error)}`, "error");
                    return;
                }

                if (handoffText === undefined) {
                    ctx.ui.notify("Handoff generation cancelled", "info");
                    return;
                }
            }

            const result = await ctx.newSession({
                ...(sourceSessionFile ? { parentSession: sourceSessionFile } : {}),
                withSession: async (replacementCtx) => {
                    replacementCtx.ui.setEditorText(handoffText);
                    replacementCtx.ui.notify(
                        "Handoff ready. Choose a model and thinking level, then submit when ready.",
                        "info",
                    );
                },
            });

            if (result.cancelled) {
                ctx.ui.notify("New session cancelled", "info");
            }
        },
    });
}
