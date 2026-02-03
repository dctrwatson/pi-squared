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
import type { GhIssue, GhTodoDetails } from "./types.js";
import { PR_LABEL_CREATED, PR_LABEL_UPDATED } from "./utils.js";
import { registerTool } from "./tool.js";
import { registerCommands } from "./commands.js";

export default function (pi: ExtensionAPI) {
	// Cache of issues (refreshed on each list action)
	const cachedIssues: { value: GhIssue[] } = { value: [] };

	// Register the gh_todo tool for the LLM
	registerTool(pi, cachedIssues);

	// Register the /todo and /todo-pr commands for users
	registerCommands(pi, cachedIssues);

	// Label entries after successful PR actions for scoping pr-update
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "gh_todo") return;

		const details = event.details as GhTodoDetails | undefined;
		if (!details || details.error) return;

		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) return;

		if (details.action === "pr") {
			pi.setLabel(leafId, PR_LABEL_CREATED);
		} else if (details.action === "pr-update" && details.commentOnly !== undefined) {
			// Only label if pr-update actually did something (commentOnly is set)
			pi.setLabel(leafId, PR_LABEL_UPDATED);
		}
	});

	// Notify on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`GitHub Todo extension loaded. Use /todo or /todo-pr.`, "info");
		}
	});
}
