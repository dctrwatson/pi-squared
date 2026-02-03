/**
 * GitHub CLI operations for gh-todo extension
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PI_TODO_LABEL, type GhIssue } from "./types.js";
import { parseIssues, parseIssue, updatePiSection } from "./utils.js";

/**
 * Check if gh CLI is available
 */
export async function checkGhCli(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("which", ["gh"], { timeout: 5000 });
	return result.code === 0;
}

/**
 * Ensure the pi-todo label exists
 */
export async function ensureLabel(pi: ExtensionAPI): Promise<void> {
	// Try to create label (will fail silently if exists)
	await pi.exec(
		"gh",
		["label", "create", PI_TODO_LABEL, "--description", "Todo item managed by pi", "--color", "7057ff"],
		{ timeout: 10000 }
	);
}

/**
 * List all issues with pi-todo label
 */
export async function listIssues(pi: ExtensionAPI, includesClosed = false): Promise<GhIssue[]> {
	const stateArg = includesClosed ? "all" : "open";
	const result = await pi.exec(
		"gh",
		["issue", "list", "--label", PI_TODO_LABEL, "--state", stateArg, "--json", "number,title,state,body,labels,assignees,url,createdAt,updatedAt", "--limit", "100"],
		{ timeout: 30000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to list issues: ${result.stderr}`);
	}
	return parseIssues(result.stdout);
}

/**
 * Create a new issue
 * The body is treated as user content (not wrapped in Pi Agent Notes)
 */
export async function createIssue(pi: ExtensionAPI, title: string, body?: string): Promise<GhIssue> {
	await ensureLabel(pi);
	const args = ["issue", "create", "--title", title, "--label", PI_TODO_LABEL];
	// Body is user content - Pi Agent Notes section is added later via update
	args.push("--body", body || "");
	const result = await pi.exec("gh", args, { timeout: 30000 });
	if (result.code !== 0) {
		throw new Error(`Failed to create issue: ${result.stderr}`);
	}
	// Extract issue number from output URL
	const match = result.stdout.match(/\/issues\/(\d+)/);
	if (!match) {
		throw new Error("Could not parse created issue number");
	}
	const issueNum = parseInt(match[1], 10);
	// Fetch the created issue
	return await getIssue(pi, issueNum);
}

/**
 * Update the pi-managed section of an issue's body
 */
export async function updateIssueNotes(pi: ExtensionAPI, number: number, notes: string): Promise<GhIssue> {
	// Get current issue to preserve non-pi content
	const current = await getIssue(pi, number);
	const newBody = updatePiSection(current.body, notes);
	
	const result = await pi.exec(
		"gh",
		["issue", "edit", String(number), "--body", newBody],
		{ timeout: 15000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to update issue #${number}: ${result.stderr}`);
	}
	return await getIssue(pi, number);
}

/**
 * Get a single issue by number
 */
export async function getIssue(pi: ExtensionAPI, number: number): Promise<GhIssue> {
	const result = await pi.exec(
		"gh",
		["issue", "view", String(number), "--json", "number,title,state,body,labels,assignees,url,createdAt,updatedAt"],
		{ timeout: 15000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to get issue #${number}: ${result.stderr}`);
	}
	const issue = parseIssue(result.stdout);
	if (!issue) {
		throw new Error(`Could not parse issue #${number}`);
	}
	return issue;
}

/**
 * Add a comment to an issue without closing it
 */
export async function addIssueComment(pi: ExtensionAPI, number: number, comment: string): Promise<void> {
	const result = await pi.exec(
		"gh",
		["issue", "comment", String(number), "--body", comment],
		{ timeout: 15000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to add comment to issue #${number}: ${result.stderr}`);
	}
}

/**
 * Close an issue (not completed)
 */
export async function closeIssue(pi: ExtensionAPI, number: number): Promise<GhIssue> {
	const result = await pi.exec(
		"gh",
		["issue", "close", String(number), "--reason", "not planned"],
		{ timeout: 15000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to close issue #${number}: ${result.stderr}`);
	}
	return await getIssue(pi, number);
}

/**
 * Reopen an issue
 */
export async function reopenIssue(pi: ExtensionAPI, number: number): Promise<GhIssue> {
	const result = await pi.exec(
		"gh",
		["issue", "reopen", String(number)],
		{ timeout: 15000 }
	);
	if (result.code !== 0) {
		throw new Error(`Failed to reopen issue #${number}: ${result.stderr}`);
	}
	return await getIssue(pi, number);
}

/**
 * Open issue in browser
 */
export async function openInBrowser(pi: ExtensionAPI, url: string): Promise<void> {
	await pi.exec("open", [url], { timeout: 5000 });
}

/**
 * Pull the current branch from origin (fast-forward only)
 */
export async function pullBranch(pi: ExtensionAPI): Promise<void> {
	const result = await pi.exec("git", ["pull", "--ff-only"], { timeout: 30000 });
	if (result.code !== 0) {
		throw new Error(`Failed to pull: ${result.stderr}`);
	}
}

/**
 * Checkout a branch, creating it if it doesn't exist
 */
export async function checkoutNewBranch(pi: ExtensionAPI, branch: string): Promise<void> {
	const result = await pi.exec("git", ["checkout", "-b", branch], { timeout: 10000 });
	if (result.code !== 0) {
		throw new Error(`Failed to create branch "${branch}": ${result.stderr}`);
	}
}

/**
 * Check if a local branch exists
 */
export async function branchExists(pi: ExtensionAPI, branch: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", branch], { timeout: 5000 });
	return result.code === 0;
}

/**
 * Checkout an existing branch
 */
export async function checkoutBranch(pi: ExtensionAPI, branch: string): Promise<void> {
	const result = await pi.exec("git", ["checkout", branch], { timeout: 10000 });
	if (result.code !== 0) {
		throw new Error(`Failed to checkout branch "${branch}": ${result.stderr}`);
	}
}

/**
 * Get current git branch name
 */
export async function getCurrentBranch(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 5000 });
	if (result.code !== 0) {
		throw new Error("Not in a git repository or failed to get branch name");
	}
	return result.stdout.trim();
}

/**
 * Check if there are uncommitted changes
 */
export async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("git", ["status", "--porcelain"], { timeout: 5000 });
	return result.stdout.trim().length > 0;
}

/**
 * Push current branch to origin
 */
export async function pushBranch(pi: ExtensionAPI, branch: string): Promise<void> {
	const result = await pi.exec("git", ["push", "-u", "origin", branch], { timeout: 30000 });
	if (result.code !== 0) {
		throw new Error(`Failed to push branch: ${result.stderr}`);
	}
}

/**
 * Check if branch has upstream
 */
export async function hasUpstream(pi: ExtensionAPI, branch: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", `${branch}@{u}`], { timeout: 5000 });
	return result.code === 0;
}

/**
 * Get PR number for current branch
 */
export async function getPrForBranch(pi: ExtensionAPI, branch: string): Promise<{ number: number; url: string; state: string } | null> {
	const result = await pi.exec(
		"gh",
		["pr", "view", branch, "--json", "number,url,state"],
		{ timeout: 15000 }
	);
	
	if (result.code !== 0) {
		return null;
	}
	
	try {
		const data = JSON.parse(result.stdout);
		return {
			number: data.number,
			url: data.url,
			state: data.state,
		};
	} catch {
		return null;
	}
}

/**
 * Get unpushed commits on the current branch.
 * Returns commits between origin/<branch>..HEAD.
 * If no upstream exists, compares against main/master.
 */
export async function getUnpushedCommits(pi: ExtensionAPI, branch: string): Promise<{ hash: string; message: string }[]> {
	let range: string;

	if (await hasUpstream(pi, branch)) {
		range = `origin/${branch}..HEAD`;
	} else {
		// No upstream — compare against main/master to get all branch commits
		const mainResult = await pi.exec("git", ["rev-parse", "--verify", "main"], { timeout: 5000 });
		const baseBranch = mainResult.code === 0 ? "main" : "master";
		range = `${baseBranch}..HEAD`;
	}

	const result = await pi.exec(
		"git",
		["log", range, "--oneline", "--no-decorate"],
		{ timeout: 10000 }
	);

	if (result.code !== 0 || !result.stdout.trim()) {
		return [];
	}

	return result.stdout
		.trim()
		.split("\n")
		.map((line) => {
			const spaceIdx = line.indexOf(" ");
			if (spaceIdx === -1) return { hash: line, message: "" };
			return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
		});
}

/**
 * Get PR comments and reviews
 */
export async function getPrFeedback(pi: ExtensionAPI, prNumber: number): Promise<{
	reviewComments: Array<{ author: string; body: string; path?: string; line?: number; state?: string; createdAt: string }>;
	conversationComments: Array<{ author: string; body: string; createdAt: string }>;
}> {
	const reviewComments: Array<{ author: string; body: string; path?: string; line?: number; state?: string; createdAt: string }> = [];
	const conversationComments: Array<{ author: string; body: string; createdAt: string }> = [];
	
	// Get repository info
	const repoResult = await pi.exec("gh", ["repo", "view", "--json", "owner,name"], { timeout: 5000 });
	if (repoResult.code !== 0) {
		throw new Error("Failed to get repository info");
	}
	
	let owner: string;
	let repo: string;
	try {
		const repoData = JSON.parse(repoResult.stdout);
		owner = repoData.owner.login;
		repo = repoData.name;
	} catch {
		throw new Error("Failed to parse repository info");
	}
	
	// Fetch review comments (inline code comments)
	const reviewResult = await pi.exec(
		"gh",
		["api", `/repos/${owner}/${repo}/pulls/${prNumber}/comments`],
		{ timeout: 15000 }
	);
	
	if (reviewResult.code === 0) {
		try {
			const comments = JSON.parse(reviewResult.stdout);
			for (const comment of comments) {
				reviewComments.push({
					author: comment.user?.login || "unknown",
					body: comment.body || "",
					path: comment.path,
					line: comment.line || comment.original_line,
					createdAt: comment.created_at,
				});
			}
		} catch {
			// Failed to parse review comments
		}
	}
	
	// Fetch conversation comments (general PR comments)
	const commentResult = await pi.exec(
		"gh",
		["api", `/repos/${owner}/${repo}/issues/${prNumber}/comments`],
		{ timeout: 15000 }
	);
	
	if (commentResult.code === 0) {
		try {
			const comments = JSON.parse(commentResult.stdout);
			for (const comment of comments) {
				conversationComments.push({
					author: comment.user?.login || "unknown",
					body: comment.body || "",
					createdAt: comment.created_at,
				});
			}
		} catch {
			// Failed to parse conversation comments
		}
	}
	
	// Fetch review summaries (APPROVED, CHANGES_REQUESTED, etc.)
	const reviewsResult = await pi.exec(
		"gh",
		["api", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`],
		{ timeout: 15000 }
	);
	
	if (reviewsResult.code === 0) {
		try {
			const reviews = JSON.parse(reviewsResult.stdout);
			for (const review of reviews) {
				if (review.body && review.body.trim()) {
					reviewComments.push({
						author: review.user?.login || "unknown",
						body: review.body,
						state: review.state,
						createdAt: review.submitted_at || review.created_at,
					});
				}
			}
		} catch {
			// Failed to parse reviews
		}
	}
	
	return { reviewComments, conversationComments };
}
