/**
 * Utility functions for gh-todo extension
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { PI_SECTION_START, PI_SECTION_END, PI_SECTION_TITLE, type GhIssue } from "./types.js";

export const PR_LABEL_CREATED = "pr-created";
export const PR_LABEL_UPDATED = "pr-update";

/**
 * Wrap content in a collapsible GitHub markdown section
 */
export function wrapInCollapsible(content: string): string {
	if (!content.trim()) return "";
	return `${PI_SECTION_START}
<details>
<summary>${PI_SECTION_TITLE}</summary>

${content.trim()}

</details>
${PI_SECTION_END}`;
}

/**
 * Extract the pi-managed section content from issue body
 */
export function extractPiSection(body: string): string | null {
	const startIdx = body.indexOf(PI_SECTION_START);
	const endIdx = body.indexOf(PI_SECTION_END);
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
		return null;
	}
	// Extract content between markers, then between <details> tags
	const section = body.slice(startIdx + PI_SECTION_START.length, endIdx);
	const detailsMatch = section.match(/<details>[\s\S]*?<summary>[^<]*<\/summary>([\s\S]*?)<\/details>/);
	return detailsMatch ? detailsMatch[1].trim() : null;
}

/**
 * Get the expected session name for an issue
 */
export function getIssueSessionName(issue: { number: number; title: string }): string {
	return `#${issue.number}: ${issue.title}`;
}

/**
 * Get the session name prefix for an issue (used for matching)
 */
export function getIssueSessionPrefix(issueNumber: number): string {
	return `#${issueNumber}: `;
}

/**
 * Check if a session name matches an issue number
 */
export function sessionMatchesIssue(sessionName: string | undefined, issueNumber: number): boolean {
	if (!sessionName) return false;
	return sessionName.startsWith(getIssueSessionPrefix(issueNumber));
}

/**
 * Extract user content from issue body (everything except the pi-managed section)
 */
export function extractUserContent(body: string): string {
	const startIdx = body.indexOf(PI_SECTION_START);
	const endIdx = body.indexOf(PI_SECTION_END);
	
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
		// No pi section - entire body is user content
		return body.trim();
	}
	
	const before = body.slice(0, startIdx).trim();
	const after = body.slice(endIdx + PI_SECTION_END.length).trim();
	
	return [before, after].filter(p => p.length > 0).join("\n\n");
}

/**
 * Update only the pi-managed section in issue body, preserving other content
 */
export function updatePiSection(body: string, newContent: string): string {
	const wrapped = wrapInCollapsible(newContent);
	const startIdx = body.indexOf(PI_SECTION_START);
	const endIdx = body.indexOf(PI_SECTION_END);
	
	if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
		// No existing section - append it
		const trimmedBody = body.trim();
		if (!trimmedBody) {
			return wrapped;
		}
		return trimmedBody + "\n\n" + wrapped;
	}
	
	// Replace existing section
	const before = body.slice(0, startIdx).trim();
	const after = body.slice(endIdx + PI_SECTION_END.length).trim();
	
	const parts = [before, wrapped, after].filter(p => p.length > 0);
	return parts.join("\n\n");
}

/**
 * Parse GitHub CLI JSON output for issues
 */
export function parseIssues(json: string): GhIssue[] {
	try {
		const raw = JSON.parse(json);
		if (!Array.isArray(raw)) return [];
		return raw.map((issue: any) => ({
			number: issue.number,
			title: issue.title,
			state: issue.state?.toLowerCase() === "closed" ? "closed" : "open",
			body: issue.body || "",
			labels: (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
			assignees: (issue.assignees || []).map((a: any) => (typeof a === "string" ? a : a.login)),
			url: issue.url || "",
			createdAt: issue.createdAt || "",
			updatedAt: issue.updatedAt || "",
		}));
	} catch {
		return [];
	}
}

/**
 * Parse a single GitHub issue from JSON
 */
export function parseIssue(json: string): GhIssue | null {
	try {
		const issue = JSON.parse(json);
		return {
			number: issue.number,
			title: issue.title,
			state: issue.state?.toLowerCase() === "closed" ? "closed" : "open",
			body: issue.body || "",
			labels: (issue.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
			assignees: (issue.assignees || []).map((a: any) => (typeof a === "string" ? a : a.login)),
			url: issue.url || "",
			createdAt: issue.createdAt || "",
			updatedAt: issue.updatedAt || "",
		};
	} catch {
		return null;
	}
}

/**
 * Extract issue number from session name (e.g., "#11: Title" -> 11)
 */
export function extractIssueNumberFromSession(sessionName: string | undefined): number | null {
	if (!sessionName) return null;
	const match = sessionName.match(/^#(\d+):/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract issue number from todo branch name (e.g., "todo/11-something" -> 11)
 */
export function extractIssueNumberFromBranch(branchName: string): number | null {
	const match = branchName.match(/^todo\/(\d+)-/);
	return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if branch is main or master
 */
export function isMainBranch(branchName: string): boolean {
	return branchName === "main" || branchName === "master";
}

/**
 * Generate a branch name for a todo issue (e.g., "todo/42-my-feature-title")
 */
export function getIssueBranchName(issue: { number: number; title: string }): string {
	const slug = issue.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50)
		.replace(/-+$/, "");
	return `todo/${issue.number}-${slug}`;
}

/**
 * Find the last entry in the current branch that has a PR checkpoint label
 * ("pr-created" or "pr-update"). Returns the entry ID, or null if none found.
 */
export function findLastPrCheckpointEntryId(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getBranch();

	// Scan in reverse to find the most recent checkpoint
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const label = ctx.sessionManager.getLabel(entry.id);
		if (label === PR_LABEL_CREATED || label === PR_LABEL_UPDATED) {
			return entry.id;
		}
	}

	return null;
}

/**
 * Get session entries after a given entry ID.
 * If entryId is null, returns all entries.
 */
export function getEntriesAfter(ctx: ExtensionContext, afterEntryId: string | null): any[] {
	const entries = ctx.sessionManager.getBranch();

	if (!afterEntryId) {
		return entries;
	}

	const idx = entries.findIndex((e) => e.id === afterEntryId);
	if (idx === -1) {
		return entries; // Checkpoint not found in branch, return all
	}

	return entries.slice(idx + 1);
}
