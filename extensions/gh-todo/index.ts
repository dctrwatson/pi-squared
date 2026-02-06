/**
 * GitHub Issues Todo Extension
 *
 * Uses GitHub issues labeled with `pi-todo` to track todos.
 * The LLM can manage todos via tools, and users can manage them via /todo command.
 *
 * Prerequisites:
 * - `gh` CLI installed and authenticated
 * - Repository must be a git repo with a GitHub remote
 *
 * Usage:
 * - LLM tools: gh_todo (list, add, view, plan, start, close, reopen, update, pr, feedback, pr-update)
 * - User commands:
 *   - /todo - interactive todo manager
 *   - /todo-pr - create a PR for the current todo issue
 * 
 * Note: Issues should be closed via PR merge (using "Fixes #X" or "Closes #X" in PR description).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GhTodoDetails } from "./types.js";
import { PR_LABEL_CREATED, PR_LABEL_UPDATED, findEntryByToolCallId } from "./utils.js";
import { registerTool } from "./tool.js";
import { registerCommands } from "./commands.js";

export default function (pi: ExtensionAPI) {
	// Register the gh_todo tool for the LLM
	registerTool(pi);

	// Register the /todo and /todo-pr commands for users
	registerCommands(pi);

	// Label entries after successful PR actions for scoping pr-update.
	// Uses turn_end (not tool_result) so session entries exist and can be found by toolCallId.
	pi.on("turn_end", async (event, ctx) => {
		for (const toolResult of event.toolResults) {
			if (toolResult.toolName !== "gh_todo") continue;

			const details = toolResult.details as GhTodoDetails | undefined;
			if (!details || details.error) continue;

			let label: string | undefined;
			if (details.action === "pr") {
				label = PR_LABEL_CREATED;
			} else if (details.action === "pr-update" && details.commentOnly !== undefined) {
				label = PR_LABEL_UPDATED;
			}
			if (!label) continue;

			const entry = findEntryByToolCallId(ctx, toolResult.toolCallId);
			if (entry) {
				pi.setLabel(entry.id, label);
			}
		}
	});

	// Notify on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`GitHub Todo extension loaded. Use /todo or /todo-pr.`, "info");
		}
	});
}
