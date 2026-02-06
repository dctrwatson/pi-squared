/**
 * PR-related functions for gh-todo extension
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PR_TEMPLATE_LOCATIONS, type GhIssue } from "./types.js";
import { findLastPrCheckpointEntryId, getEntriesAfter, getSmallModel } from "./utils.js";

/**
 * Find PR template file
 */
export async function findPrTemplate(pi: ExtensionAPI, signal?: AbortSignal): Promise<string | null> {
	for (const location of PR_TEMPLATE_LOCATIONS) {
		const result = await pi.exec("test", ["-f", location], { timeout: 1000, signal });
		if (result.code === 0) {
			const content = await pi.exec("cat", [location], { timeout: 5000, signal });
			if (content.code === 0) {
				return content.stdout;
			}
		}
	}
	return null;
}

/**
 * Gather session context for PR summary
 */
export function gatherSessionContext(ctx: ExtensionContext): string {
	let sessionContext = "";
	
	try {
		const entries = ctx.sessionManager.getBranch();
		
		for (const entry of entries) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role === "user") {
					const content = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }];
					const text = content.map((c: any) => c.type === "text" ? c.text : "").join("");
					if (text) sessionContext += `User: ${text.slice(0, 500)}\n\n`;
				} else if (msg.role === "assistant") {
					const content = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }];
					const text = content.map((c: any) => c.type === "text" ? c.text : "").join("");
					if (text) sessionContext += `Assistant: ${text.slice(0, 500)}\n\n`;
				} else if (msg.role === "toolResult" && !msg.isError) {
					if (msg.toolName === "write" || msg.toolName === "edit") {
						const details = msg.details as { path?: string } | undefined;
						if (details?.path) sessionContext += `Tool: ${msg.toolName} ${details.path}\n\n`;
					} else if (msg.toolName === "bash") {
						const details = msg.details as { command?: string } | undefined;
						if (details?.command) sessionContext += `Tool: bash \`${details.command.slice(0, 100)}\`\n\n`;
					}
				}
			}
		}
	} catch {
		// Failed to gather context
	}
	
	// Limit context size
	return sessionContext.slice(0, 8000);
}

/**
 * Gather session context scoped to entries after the last PR checkpoint label.
 * Returns empty string if no entries found after the checkpoint.
 */
export function gatherScopedSessionContext(ctx: ExtensionContext): string {
	let sessionContext = "";

	try {
		const checkpointId = findLastPrCheckpointEntryId(ctx);
		const entries = getEntriesAfter(ctx, checkpointId);

		for (const entry of entries) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role === "user") {
					const text = msg.content.map((c: any) => c.type === "text" ? c.text : "").join("");
					if (text) sessionContext += `User: ${text.slice(0, 500)}\n\n`;
				} else if (msg.role === "assistant") {
					const text = msg.content.map((c: any) => c.type === "text" ? c.text : "").join("");
					if (text) sessionContext += `Assistant: ${text.slice(0, 500)}\n\n`;
				} else if (msg.role === "toolResult" && !msg.isError) {
					if (msg.toolName === "write" || msg.toolName === "edit") {
						const details = msg.details as { path?: string } | undefined;
						if (details?.path) sessionContext += `Tool: ${msg.toolName} ${details.path}\n\n`;
					} else if (msg.toolName === "bash") {
						const details = msg.details as { command?: string } | undefined;
						if (details?.command) sessionContext += `Tool: bash \`${details.command.slice(0, 100)}\`\n\n`;
					}
				}
			}
		}
	} catch {
		// Failed to gather context
	}

	// Limit context size
	return sessionContext.slice(0, 8000);
}

/**
 * Generate a PR update comment summarizing feedback addressed.
 * Uses Haiku (or falls back to current model) to auto-generate from scoped session context + commits.
 */
export async function generatePrUpdateSummary(
	scopedContext: string,
	commits: { hash: string; message: string }[],
	prNumber: number,
	ctx: ExtensionContext,
	signal?: AbortSignal
): Promise<string> {
	const hasCommits = commits.length > 0;

	// Build commits section
	let commitsSection = "";
	if (hasCommits) {
		commitsSection = "\n\n### Commits\n";
		for (const commit of commits) {
			commitsSection += `- ${commit.hash} ${commit.message}\n`;
		}
	}

	// Fallback if no context or AI fails: just the commits
	const fallback = hasCommits
		? `## Feedback addressed\n\n(Changes pushed)${commitsSection}`
		: `## Feedback addressed\n\n(Responded to feedback)`;

	if (!scopedContext.trim() && !hasCommits) {
		return fallback;
	}

	try {
		const result = await getSmallModel(ctx);
		if (!result) {
			return fallback;
		}
		const { model, apiKey } = result;

		let commitContext = "";
		if (hasCommits) {
			commitContext = "\n\nCommits:\n" + commits.map((c) => `- ${c.hash} ${c.message}`).join("\n");
		}

		const prompt = `Generate a brief summary of PR feedback that was addressed. Keep it concise (under 150 words).

PR #${prNumber}

Session activity since last update:
${scopedContext}${commitContext}

Write a markdown section with:
1. First line: "## Feedback addressed"
2. A concise bullet-point summary of what was changed or discussed in response to reviewer feedback
${hasCommits ? '3. End with a "### Commits" section listing the commits (I will add this — do NOT include commits yourself)' : ""}

Focus on what feedback was addressed and how, not implementation details.`;

		const response = await complete(model, {
			systemPrompt: "You are a helpful assistant that writes concise GitHub PR update comments summarizing how reviewer feedback was addressed.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, { apiKey, maxTokens: 400, signal });

		let summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		if (!summary) {
			return fallback;
		}

		// Append commits section if the AI didn't include it
		if (hasCommits) {
			summary = summary.trimEnd() + commitsSection;
		}

		return summary;
	} catch {
		return fallback;
	}
}

/**
 * Generate PR summary using Haiku
 */
export async function generatePrSummary(
	issue: GhIssue,
	sessionContext: string,
	closeIssue: boolean,
	ctx: ExtensionContext,
	signal?: AbortSignal
): Promise<string> {
	const issueLink = closeIssue ? `Closes #${issue.number}` : `Related: #${issue.number}`;
	
	// Default body if no context or Haiku fails
	let defaultBody = `${issueLink}\n\n## Summary\n\n(Add summary of changes here)`;
	
	if (!sessionContext.trim()) {
		return defaultBody;
	}

	try {
		const result = await getSmallModel(ctx);
		if (!result) {
			return defaultBody;
		}
		const { model, apiKey } = result;

		const prompt = `Generate a brief PR description for the following changes. Keep it concise (under 200 words).

Issue: #${issue.number} - ${issue.title}

Session activity:
${sessionContext}

Write a markdown PR body with:
1. First line: "${issueLink}"
2. A "## Summary" section with bullet points of what was done
3. Keep it focused on the actual changes made

Do not include sections for testing, screenshots, or other template sections - just the issue link and summary.`;

		const response = await complete(model, {
			systemPrompt: "You are a helpful assistant that writes concise GitHub PR descriptions.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, { apiKey, maxTokens: 500, signal });

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");

		return summary || defaultBody;
	} catch {
		return defaultBody;
	}
}

/**
 * Fill PR template with issue link and summary using Haiku
 */
export async function fillPrTemplate(
	template: string,
	issue: GhIssue,
	sessionContext: string,
	closeIssue: boolean,
	ctx: ExtensionContext,
	signal?: AbortSignal
): Promise<string> {
	const issueLink = closeIssue ? `Closes #${issue.number}` : `Related: #${issue.number}`;

	try {
		const result = await getSmallModel(ctx);
		if (!result) {
			// Fallback: prepend issue link to template
			return `${issueLink}\n\n${template}`;
		}
		const { model, apiKey } = result;

		const prompt = `Fill in this PR template. You should ONLY fill in:
1. Place "${issueLink}" in the appropriate section (usually near the top, or in a "Related Issues" section)
2. Add a brief summary of changes in the description/summary section

Leave all other sections (testing, screenshots, checklist, etc.) with their original placeholder text for the user to fill in.

Issue: #${issue.number} - ${issue.title}

Session activity (for context):
${sessionContext.slice(0, 4000)}

PR Template:
${template}

Return the filled template. Only fill the issue link and summary sections, leave everything else as-is.`;

		const response = await complete(model, {
			systemPrompt: "You are a helpful assistant that fills in PR templates. Only fill in the issue link and summary sections, leave other sections for the user.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, { apiKey, maxTokens: 2000, signal });

		const filled = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("");

		return filled || `${issueLink}\n\n${template}`;
	} catch {
		return `${issueLink}\n\n${template}`;
	}
}

/**
 * Create a PR using gh CLI
 */
export async function createPr(
	pi: ExtensionAPI,
	title: string,
	body: string,
	branch: string,
	signal?: AbortSignal
): Promise<{ url: string; number: number }> {
	const result = await pi.exec(
		"gh",
		["pr", "create", "--title", title, "--body", body, "--head", branch],
		{ timeout: 30000, signal }
	);
	
	if (result.code !== 0) {
		throw new Error(`Failed to create PR: ${result.stderr}`);
	}
	
	// Parse PR URL from output
	const url = result.stdout.trim();
	const prNumMatch = url.match(/\/pull\/(\d+)/);
	const prNumber = prNumMatch?.[1] ? parseInt(prNumMatch[1], 10) : 0;
	
	return { url, number: prNumber };
}
