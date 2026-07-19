/**
 * Q&A Command Extension - Extracts questions from assistant responses
 * and presents an interactive wizard for answering them.
 *
 * Usage: /qa
 *
 * Workflow:
 * 1. Extracts questions (explicit and implicit) from the last assistant message
 * 2. Presents a wizard-style form to answer each question
 * 3. Submits formatted Q&A pairs back to the conversation
 */

// Pi's ModelRegistry currently supplies dynamically configured models and auth;
// migrate to its Models instance when that API is exposed, then drop compat.
import { complete, parseJsonWithRepair, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type Focusable, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const EXTRACTION_SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering from the user.

Extract both:
1. Explicit questions (ending with ?)
2. Implicit decision points ("let me know which...", "would you prefer...", "should I...", etc.)

IMPORTANT: Preserve ALL context, options, examples, and explanations that relate to each question. The user needs this information to answer properly.

Output format: JSON array of objects with "question" field containing the FULL question with all its context.
If no questions found, return empty array [].

Example input:
"What database should we use for this project?

Consider the following options:
- PostgreSQL: Great for complex queries, ACID compliance
- MongoDB: Flexible schema, good for rapid prototyping

What are your requirements for scalability?"

Example output:
[
  {"question": "What database should we use for this project?\\n\\nConsider the following options:\\n- PostgreSQL: Great for complex queries, ACID compliance\\n- MongoDB: Flexible schema, good for rapid prototyping"},
  {"question": "What are your requirements for scalability?"}
]

Group related context with the main question it belongs to. Preserve formatting like bullet points and line breaks.
Return ONLY valid JSON, no markdown code blocks.`;

interface ExtractedQuestion {
	question: string;
}

interface QAState {
	questions: ExtractedQuestion[];
	answers: Map<number, string>;
	currentIndex: number;
}

const MAX_QUESTIONS = 20;
const MAX_QUESTION_CHARS = 12_000;

type ExtractionModel = NonNullable<ExtensionContext["model"]>;
type ExtractionAuth = {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
};

const EXTRACTION_MODEL_PREFERENCES = [
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-haiku-4-5"],
] as const;

function hasUsableRequestAuth(auth: ExtractionAuth): boolean {
    if (auth.apiKey?.trim()) return true;
    return Object.entries(auth.headers ?? {}).some(([name, value]) =>
        ["authorization", "cf-aig-authorization", "x-api-key"].includes(name.toLowerCase()) && value.trim(),
    );
}

export async function selectExtractionModel(
    activeModel: ExtractionModel,
    modelRegistry: Pick<ExtensionContext["modelRegistry"], "find" | "getApiKeyAndHeaders">,
): Promise<{ model: ExtractionModel; auth?: ExtractionAuth }> {
    for (const [provider, modelId] of EXTRACTION_MODEL_PREFERENCES) {
        const model = modelRegistry.find(provider, modelId);
        if (!model) continue;
        if (model.provider === activeModel.provider && model.id === activeModel.id) {
            return { model: activeModel };
        }

        const auth = await modelRegistry.getApiKeyAndHeaders(model);
        if (auth.ok && hasUsableRequestAuth(auth)) {
            return { model, auth };
        }
    }

    return { model: activeModel };
}

function extractJsonArrayCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			else if (char === "[") depth++;
			else if (char === "]") {
				depth--;
				if (depth === 0) {
					candidates.push(text.slice(start, index + 1));
					break;
				}
			}
		}
	}
	return candidates;
}

function questionsFromJsonArray(value: unknown): ExtractedQuestion[] | undefined {
    if (!Array.isArray(value)) return undefined;

    const seen = new Set<string>();
    const questions: ExtractedQuestion[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || typeof (item as { question?: unknown }).question !== "string") continue;
        const question = (item as { question: string }).question.trim();
        if (!question || question.length > MAX_QUESTION_CHARS || seen.has(question)) continue;
        seen.add(question);
        questions.push({ question });
        if (questions.length >= MAX_QUESTIONS) break;
    }
    return questions;
}

function parseExtractionResponse(responseText: string): { questions: ExtractedQuestion[]; valid: boolean } {
	const direct = responseText.trim();
	const candidates = [direct, ...extractJsonArrayCandidates(direct)];
    let foundJsonArray = false;

	for (const candidate of candidates) {
		try {
            const questions = questionsFromJsonArray(parseJsonWithRepair<unknown>(candidate));
            if (!questions) continue;
            foundJsonArray = true;
            if (questions.length > 0 || candidate.trim() === "[]") {
                return { questions, valid: true };
            }
		} catch {
			// Try the next JSON candidate.
		}
	}
    return { questions: [], valid: foundJsonArray };
}

export function parseExtractedQuestions(responseText: string): ExtractedQuestion[] {
    return parseExtractionResponse(responseText).questions;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("qa", {
		description: "Extract and answer questions from the last assistant message",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/qa requires TUI mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (!entry || entry.type !== "message") continue;
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const content = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }];
					const textParts = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text);
					if (textParts.length > 0) {
						lastAssistantText = textParts.join("\n");
						break;
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

            // Prefer Luna, then Haiku, when each has request credentials; otherwise keep the active model.
            const selection = await selectExtractionModel(ctx.model, ctx.modelRegistry);
            const extractionModel = selection.model;

			// Extract questions with loader UI
			const assistantText = lastAssistantText;
			let extractionError: string | undefined;
			const questions = await ctx.ui.custom<ExtractedQuestion[] | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`Extracting questions using ${extractionModel.id}...`,
				);
				let completed = false;
				const finish = (value: ExtractedQuestion[] | null) => {
					if (completed) return;
					completed = true;
					done(value);
				};
				loader.onAbort = () => finish(null);

				const doExtract = async () => {
                    let auth = selection.auth;
                    if (!auth) {
                        const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
                        if (!resolvedAuth.ok) {
                            extractionError = `No API key available for ${extractionModel.id}`;
                            return null;
                        }
                        auth = resolvedAuth;
                    }

					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: assistantText }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}
                    if (response.stopReason === "error") {
                        throw new Error(response.errorMessage ?? "Question extraction request failed");
                    }

					const responseText = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("");

                    // Strip markdown code fences before parsing.
                    const cleaned = responseText
                        .replace(/^```(?:json)?\s*\n?/gm, "")
                        .replace(/\n?```\s*$/gm, "");
                    const parsed = parseExtractionResponse(cleaned);
                    if (!parsed.valid) {
                        throw new Error(`${extractionModel.id} returned an invalid question list`);
                    }

                    return parsed.questions;
				};

				doExtract()
					.then(finish)
					.catch((err) => {
						extractionError = err instanceof Error ? err.message : String(err);
						finish(null);
					});

				return loader;
			});

			if (extractionError) {
				ctx.ui.notify(`Extraction failed: ${extractionError}`, "error");
				return;
			}

			if (questions === null || questions === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			if (questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			// Show wizard UI for answering questions
			const result = await ctx.ui.custom<Map<number, string> | null>((tui, theme, _kb, done) => {
				const state: QAState = {
					questions,
					answers: new Map(),
					currentIndex: 0,
				};

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Pre-fill editor with existing answer if any
				const existingAnswer = state.answers.get(state.currentIndex);
				if (existingAnswer) {
					editor.setText(existingAnswer);
				}

				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;

				function refresh() {
					cachedWidth = undefined;
					cachedLines = undefined;
					tui.requestRender();
				}

				function saveAnswer(index: number, value: string) {
					const text = value.trim();
					if (text) state.answers.set(index, text);
					else state.answers.delete(index);
				}

				function saveCurrentAnswer() {
					saveAnswer(state.currentIndex, editor.getText());
				}

				function advanceToNext(submittedValue?: string) {
					// Save the submitted value if provided, otherwise get from editor.
					saveAnswer(state.currentIndex, submittedValue ?? editor.getText());

					// Find next unanswered question after current
					let nextIndex = -1;
					for (let i = state.currentIndex + 1; i < state.questions.length; i++) {
						if (!state.answers.has(i)) {
							nextIndex = i;
							break;
						}
					}

					// If none found after, look from beginning
					if (nextIndex === -1) {
						for (let i = 0; i < state.currentIndex; i++) {
							if (!state.answers.has(i)) {
								nextIndex = i;
								break;
							}
						}
					}

					// If all answered, stay on current question
					if (nextIndex === -1) {
						refresh();
						return;
					}

					state.currentIndex = nextIndex;
					const answer = state.answers.get(nextIndex) || "";
					editor.setText(answer);
					refresh();
				}

				// Enter saves answer and advances to next unanswered question
				// Shift+Enter adds newlines for multi-line answers.
				editor.onSubmit = (value) => {
					advanceToNext(value);
				};

				function allAnswered(): boolean {
					return state.questions.every((_, i) => state.answers.has(i));
				}

				function navigateTo(index: number) {
					if (index < 0 || index >= state.questions.length) return;
					saveCurrentAnswer();
					state.currentIndex = index;
					const answer = state.answers.get(index) || "";
					editor.setText(answer);
					refresh();
				}

				function submit() {
					saveCurrentAnswer();
					if (allAnswered()) {
						done(state.answers);
					} else {
						// Find first unanswered question
						for (let i = 0; i < state.questions.length; i++) {
							if (!state.answers.has(i)) {
								navigateTo(i);
								break;
							}
						}
					}
				}

				function handleInput(data: string) {
					// Escape to cancel
					if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}

					// Ctrl+Enter to submit all answers
					if (matchesKey(data, Key.ctrl("return"))) {
						submit();
						return;
					}

					// Tab / Shift+Tab to navigate questions
					if (matchesKey(data, Key.tab)) {
						saveCurrentAnswer();
						const next = (state.currentIndex + 1) % state.questions.length;
						navigateTo(next);
						return;
					}
					if (matchesKey(data, Key.shift("tab"))) {
						saveCurrentAnswer();
						const prev = (state.currentIndex - 1 + state.questions.length) % state.questions.length;
						navigateTo(prev);
						return;
					}

					// Pass to editor (Enter advances, Shift+Enter adds newline)
					editor.handleInput(data);
					refresh();
				}

				// Focusable implementation — propagate focus to embedded editor for IME support
				let _focused = false;

				function render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;

					const safeWidth = Math.max(1, width);
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, safeWidth));

					const total = state.questions.length;
					const current = state.currentIndex;
					const currentQ = state.questions[current];

					// Top border
					add(theme.fg("accent", "─".repeat(safeWidth)));

					// Header: Title + Progress dots
					const title = theme.fg("accent", theme.bold(" Answering Questions "));
					const dots = state.questions
						.map((_, i) => {
							const isAnswered = state.answers.has(i);
							const isCurrent = i === current;
							if (isCurrent) {
								return theme.fg("accent", "◉");
							} else if (isAnswered) {
								return theme.fg("success", "●");
							} else {
								return theme.fg("dim", "○");
							}
						})
						.join(" ");
					const counter = theme.fg("muted", ` (${current + 1}/${total})`);
					add(`${title}${dots}${counter}`);

					// Sidebar: Question list (compact)
					lines.push("");
					for (let i = 0; i < state.questions.length; i++) {
						const q = state.questions[i];
						if (!q) continue;
						const isCurrent = i === current;
						const isAnswered = state.answers.has(i);
						
						const marker = isCurrent ? theme.fg("accent", "▶") : " ";
						const status = isAnswered ? theme.fg("success", "✓") : theme.fg("dim", "○");
						const qNum = `Q${i + 1}`;
						
						// Truncate question text for sidebar
						const maxQLen = Math.max(8, safeWidth - 12);
						let qText = (q.question.split("\n")[0] ?? ""); // First line only for sidebar
						if (qText.length > maxQLen) {
							qText = qText.substring(0, maxQLen - 3) + "...";
						}
						
						if (isCurrent) {
							add(` ${marker} ${status} ${theme.fg("accent", qNum + ": " + qText)}`);
						} else {
							const color = isAnswered ? "muted" : "text";
							add(` ${marker} ${status} ${theme.fg(color, qNum + ": " + qText)}`);
						}
					}

					// Separator
					lines.push("");
					add(theme.fg("dim", "─".repeat(safeWidth)));
					lines.push("");

					// Current question (full text, word-wrapped)
					const qPrefix = `Q${current + 1}: `;
					const indent = " ".repeat(qPrefix.length + 1); // +1 for leading space
					const wrapWidth = Math.max(1, safeWidth - indent.length);
					const questionLines = (currentQ?.question ?? "").split("\n");
					let firstLine = true;
					for (const qLine of questionLines) {
						if (qLine.trim() === "") {
							lines.push("");
							continue;
						}
						const wrapped = wrapTextWithAnsi(qLine, wrapWidth);
						for (const wl of wrapped) {
							if (firstLine) {
								add(` ${theme.fg("accent", theme.bold(qPrefix))}${wl}`);
								firstLine = false;
							} else {
								add(`${indent}${wl}`);
							}
						}
					}

					// Answer editor
					lines.push("");
					add(` ${theme.fg("muted", "Your answer:")}`);
					const editorLines = editor.render(Math.max(1, safeWidth - 2));
					for (const line of editorLines) {
						add(` ${line}`);
					}

					// Help text
					lines.push("");
					const canSubmit = allAnswered();
					if (canSubmit) {
						add(theme.fg("success", ` All questions answered! ${rawKeyHint("Ctrl+Enter", "submit")}`));
					} else {
						add(theme.fg("dim", ` ${rawKeyHint("Enter", "next")} • ${rawKeyHint("Shift+Enter", "newline")} • ${rawKeyHint("Tab/Shift+Tab", "navigate")} • ${rawKeyHint("Ctrl+Enter", "submit")} • ${rawKeyHint("Esc", "cancel")}`));
					}

					// Bottom border
					add(theme.fg("accent", "─".repeat(safeWidth)));

					cachedWidth = width;
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
					handleInput,
					// Focusable interface for IME cursor positioning
					get focused() {
						return _focused;
					},
					set focused(value: boolean) {
						_focused = value;
						(editor as unknown as Focusable).focused = value;
					},
				};
			});

			if (result === null || result === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Format Q&A pairs and send as user message
			const qaPairs: string[] = [];
			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				if (!q) continue;
				const a = result.get(i) || "(no answer)";
				qaPairs.push(`Q: ${q.question}\nA: ${a}`);
			}

			const formattedResponse = qaPairs.join("\n\n");
			await ctx.waitForIdle();
			pi.sendUserMessage(formattedResponse);
		},
	});
}
