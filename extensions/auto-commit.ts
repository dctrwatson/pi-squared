/**
 * Auto-Commit Extension
 *
 * Replicates aider's /undo functionality:
 * - Auto-commits after every interaction (configurable to per-turn)
 * - Commits all changed files via `git add -A`
 * - Commit message format: "pi: <summary of changes>"
 * - Uses claude-haiku-4-5 for commit summaries (falls back to user prompt)
 * - /undo command to reset the last auto-commit
 * - Commits pending changes on session shutdown
 * - Silently does nothing if not in a git repo
 *
 * Configuration:
 * --commit-strategy=per-interaction (default) - One commit per user request
 * --commit-strategy=per-turn - One commit per LLM turn (original behavior)
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Truncate text to a maximum length, keeping the first and last portions
 * with a separator in between.
 */
function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const half = Math.floor(maxLength / 2);
	return text.slice(0, half) + "\n...\n" + text.slice(-half);
}

/**
 * Generate a commit summary using claude-haiku-4-5.
 * Returns null if the model or API key is unavailable, or if the call fails.
 */
async function generateCommitSummary(
	assistantText: string,
	ctx: ExtensionContext
): Promise<string | null> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	if (!model) return null;

	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return null;

	const truncated = truncateText(assistantText, 2000);

	try {
		const response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Summarize the following assistant response as a single short sentence (max 50 chars) suitable for a git commit message. Focus on what was accomplished. Do not include quotes or punctuation at the end.\n\n${truncated}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, maxTokens: 100 }
		);

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.slice(0, 50);

		return summary.length >= 5 ? summary : null;
	} catch {
		return null;
	}
}

/**
 * Generate a fallback commit summary from the user prompt, without calling an LLM.
 */
function generateFallbackSummary(userPrompt: string): string {
	if (userPrompt) {
		const firstLine = userPrompt.split("\n")[0] || "";
		const summary = firstLine.slice(0, 50) + (firstLine.length > 50 ? "..." : "");
		if (summary.trim().length >= 5) return summary;
	}
	return "changes";
}

export default function (pi: ExtensionAPI) {
	// Register commit strategy flag
	pi.registerFlag("commit-strategy", {
		description: "Commit strategy: per-interaction (default) or per-turn",
		type: "string",
		default: "per-interaction",
	});

	// Track assistant text and user prompt
	let assistantText = "";
	let userPrompt = "";
	let inGitRepo = false;

	// Get commit strategy
	const getCommitStrategy = (): "per-interaction" | "per-turn" => {
		const strategy = pi.getFlag("--commit-strategy") as string;
		return strategy === "per-turn" ? "per-turn" : "per-interaction";
	};

	// Reset transient state
	function resetState() {
		assistantText = "";
		userPrompt = "";
	}

	// Check if we're in a git repo on session start
	pi.on("session_start", async (_event, _ctx) => {
		const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { timeout: 1000 });
		inGitRepo = code === 0;
	});

	// Reset state on session switch (e.g., /new, /resume)
	pi.on("session_switch", async (_event, _ctx) => {
		const { code } = await pi.exec("git", ["rev-parse", "--git-dir"], { timeout: 1000 });
		inGitRepo = code === 0;
		resetState();
	});

	// Reset state on session fork
	pi.on("session_fork", async (_event, _ctx) => {
		resetState();
	});

	// Capture user prompt before agent starts
	pi.on("before_agent_start", async (event, _ctx) => {
		userPrompt = event.prompt || "";
	});

	// Reset tracking at the start of each agent interaction (per-interaction mode)
	pi.on("agent_start", async (_event, _ctx) => {
		if (getCommitStrategy() === "per-interaction") {
			resetState();
		}
	});

	// Reset tracking at the start of each turn (per-turn mode only)
	pi.on("turn_start", async (_event, _ctx) => {
		if (getCommitStrategy() === "per-turn") {
			resetState();
		}
	});

	// Accumulate assistant text during each turn
	pi.on("turn_end", async (event, ctx) => {
		// Extract assistant text from this turn
		if (event.message && event.message.role === "assistant") {
			const content = event.message.content;
			if (Array.isArray(content)) {
				const textContent = content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");

				if (assistantText) {
					assistantText += "\n\n" + textContent;
				} else {
					assistantText = textContent;
				}
			}
		}

		// Auto-commit at the end of each turn (per-turn mode only)
		if (getCommitStrategy() === "per-turn") {
			await performCommit(ctx, false);
		}
	});

	// Auto-commit at the end of agent interaction (per-interaction mode)
	pi.on("agent_end", async (_event, ctx) => {
		if (getCommitStrategy() === "per-interaction") {
			await performCommit(ctx, false);
		}
	});

	// Commit pending changes on shutdown (uses fast fallback, no Haiku)
	pi.on("session_shutdown", async (_event, ctx) => {
		await performCommit(ctx, true);
	});

	// Shared commit logic
	async function performCommit(ctx: ExtensionContext, skipHaiku: boolean) {
		if (!inGitRepo) return;

		try {
			// Stage all changes
			const { code: addCode } = await pi.exec("git", ["add", "-A"], { timeout: 5000 });
			if (addCode !== 0) return;

			// Check if there are any staged changes to commit
			const { code: diffCode } = await pi.exec("git", ["diff", "--cached", "--quiet"], {
				timeout: 5000,
			});
			if (diffCode === 0) {
				// Exit code 0 = no staged changes
				return;
			}

			// Generate commit message
			let summary: string;
			if (!skipHaiku && assistantText) {
				const haikuSummary = await generateCommitSummary(assistantText, ctx);
				summary = haikuSummary ?? generateFallbackSummary(userPrompt);
			} else {
				summary = generateFallbackSummary(userPrompt);
			}

			const commitMessage = `pi: ${summary}`;

			// Commit the changes
			const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage], {
				timeout: 5000,
			});

			if (commitCode === 0 && ctx.hasUI) {
				ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
			}
		} catch {
			// Silently ignore errors (e.g., nothing to commit)
		}
	}

	// Register /undo command
	pi.registerCommand("undo", {
		description: "Undo the last pi auto-commit",
		handler: async (_args, ctx) => {
			if (!inGitRepo) {
				if (ctx.hasUI) {
					ctx.ui.notify("Not in a git repository", "warning");
				}
				return;
			}

			try {
				// Check if the last commit was a pi auto-commit
				const { stdout: lastMessage, code: logCode } = await pi.exec(
					"git",
					["log", "-1", "--pretty=%s"],
					{ timeout: 5000 }
				);

				if (logCode !== 0) {
					if (ctx.hasUI) {
						ctx.ui.notify("No commits to undo", "warning");
					}
					return;
				}

				const message = lastMessage.trim();
				if (!message.startsWith("pi:")) {
					if (ctx.hasUI) {
						const proceed = await ctx.ui.confirm(
							"Not a pi commit",
							`Last commit: "${message}"\n\nUndo it anyway?`
						);
						if (!proceed) return;
					} else {
						// In non-interactive mode, only undo pi commits
						return;
					}
				}

				// Perform the undo
				const { code: resetCode } = await pi.exec(
					"git",
					["reset", "--hard", "HEAD~1"],
					{ timeout: 5000 }
				);

				if (resetCode === 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Undone: ${message}`, "info");
					}
				} else {
					if (ctx.hasUI) {
						ctx.ui.notify("Failed to undo commit", "error");
					}
				}
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Error: ${error}`, "error");
				}
			}
		},
	});
}
