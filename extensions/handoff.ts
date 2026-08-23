/**
 * Handoff Extension
 *
 * Starts a fresh session with a focused context transfer in the editor.
 *
 * Usage:
 *   /handoff          Transfer the last complete assistant response verbatim.
 *   /handoff generate Generate a self-contained handoff from active context.
 */

import { type AssistantMessage, type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
    BorderedLoader,
    convertToLlm,
    sessionEntryToContextMessages,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const HANDOFF_SYSTEM_PROMPT = `You are a session handoff writer. Your only task is to produce the first user message for a fresh coding-agent session. The new session cannot access this conversation.

Create a compact, high-signal, self-contained handoff. Prioritize:
- The current objective, requirements, constraints, and user preferences
- Decisions and only the rationale needed to apply them
- Completed work, in-progress work, and the exact next actions
- Material file paths, symbols, commands, errors, and test results
- Open questions, blockers, and risks

Rules:
- Do not continue or solve the task.
- Do not call tools.
- Do not invent details or resolve ambiguity.
- Transfer conclusions and relevant facts, not hidden reasoning or thinking.
- Omit raw logs, conversational history, repetition, and repository facts that the next agent can quickly rediscover, unless they are needed for the next action.
- Prefer precise bullets and short sections over narrative.
- Write context and instructions directly to the next agent.
- Output only the handoff text, with no preamble, commentary, or code fence.`;

export const HANDOFF_MAX_TOKENS = 4_096;
const HANDOFF_GENERATION_REQUEST = "Create the handoff now.";

type HandoffMode = "verbatim" | "generate";
type ActiveModel = NonNullable<ExtensionContext["model"]>;

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

export function buildHandoffGenerationMessages(
    entries: readonly SessionEntry[],
    request = HANDOFF_GENERATION_REQUEST,
): Message[] {
    const messages = convertToLlm(entries.flatMap(sessionEntryToContextMessages));

    return [
        ...messages,
        {
            role: "user",
            content: [{ type: "text", text: request }],
            timestamp: Date.now(),
        },
    ];
}

function buildGenerationMessages(ctx: ExtensionCommandContext): Message[] {
    const temporarySkills = (ctx.getSystemPromptOptions().skills ?? [])
        .filter((skill) =>
            skill.sourceInfo.source === "extension:skill-loader" && !skill.disableModelInvocation)
        .map((skill) => ({ name: skill.name, path: skill.filePath }));
    const request = temporarySkills.length === 0
        ? HANDOFF_GENERATION_REQUEST
        : `${HANDOFF_GENERATION_REQUEST}\n\nTemporary skill metadata, encoded as JSON: ${JSON.stringify(temporarySkills)}\nThese skills do not carry into the new session. Include only relevant skills in the handoff, with an instruction to read the given path on demand.`;
    return buildHandoffGenerationMessages(ctx.sessionManager.buildContextEntries(), request);
}

export async function generateHandoffText(
    ctx: ExtensionCommandContext,
    model: ActiveModel,
    signal: AbortSignal,
): Promise<string> {
    const messages = buildGenerationMessages(ctx);
    if (messages.length === 1) {
        throw new Error("No conversation to hand off");
    }

    const response = await ctx.modelRegistry.complete(
        model,
        {
            systemPrompt: HANDOFF_SYSTEM_PROMPT,
            messages,
        },
        {
            signal,
            cacheRetention: "none",
            maxTokens: Math.max(1, Math.min(HANDOFF_MAX_TOKENS, model.maxTokens || HANDOFF_MAX_TOKENS)),
            sessionId: uuidv7(),
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

        void generateHandoffText(ctx, model, loader.signal)
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
                    handoffText = await generateWithLoader(ctx, model);
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
