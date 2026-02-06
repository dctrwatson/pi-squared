/**
 * gh_todo tool registration
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager, truncateHead, truncateTail, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PI_TODO_LABEL, GhTodoParams, type GhTodoDetails } from "./types.js";
import {
	extractUserContent,
	extractPiSection,
	getIssueSessionName,
	getIssueBranchName,
	sessionMatchesIssue,
	extractIssueNumberFromSession,
	extractIssueNumberFromBranch,
	isMainBranch,
	findLastPrCheckpointEntryId,
} from "./utils.js";
import {
	checkGhCli,
	listIssues,
	createIssue,
	getIssue,
	updateIssueNotes,
	closeIssue,
	reopenIssue,
	getCurrentBranch,
	hasUncommittedChanges,
	pushBranch,
	pullBranch,
	checkoutNewBranch,
	checkoutBranch,
	branchExists,
	hasUpstream,
	getPrForBranch,
	getPrFeedback,
	getUnpushedCommits,
	addPrComment,
} from "./github.js";
import {
	findPrTemplate,
	gatherSessionContext,
	gatherScopedSessionContext,
	generatePrSummary,
	generatePrUpdateSummary,
	fillPrTemplate,
	createPr,
} from "./pr.js";

/**
 * Apply truncation to text output, following Pi docs pattern:
 * - Truncate using truncateHead or truncateTail with standard limits
 * - If truncated, write full output to temp file
 * - Append truncation notice with file path
 */
function applyTruncation(text: string, strategy: "head" | "tail"): string {
	const truncationFn = strategy === "head" ? truncateHead : truncateTail;
	const truncation = truncationFn(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return text;
	}

	// Write full output to temp file
	const tempDir = mkdtempSync(join(tmpdir(), "pi-gh-todo-"));
	const tempFile = join(tempDir, "output.txt");
	writeFileSync(tempFile, text);

	// Build result with truncation notice
	let result = truncation.content;
	result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
	result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	result += ` Full output saved to: ${tempFile}]`;

	return result;
}

export function registerTool(pi: ExtensionAPI, cachedIssues: { value: any[] }) {
	pi.registerTool({
		name: "gh_todo",
		label: "GitHub Todo",
		description: `Manage todos via GitHub issues (${PI_TODO_LABEL} label).
Actions: list, add, view, plan, start, close, reopen, update, pr, feedback, pr-update.
plan: fetches issue for planning. Use 'update' after to save notes.
feedback: fetches PR review/conversation comments for current branch's PR.
pr-update: pushes and posts auto-generated summary comment to PR. No 'body' needed.
Close issues via PR merge ("Fixes #X" in PR description), not via this tool.`,
		parameters: GhTodoParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Check for gh CLI
			if (!(await checkGhCli(pi, signal))) {
				return {
					content: [{ type: "text", text: "Error: GitHub CLI (gh) is not installed or not in PATH. Install it with: brew install gh" }],
					details: { action: params.action, error: "gh CLI not found" } as GhTodoDetails,
					isError: true,
				};
			}

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: { action: params.action, error: "Cancelled" } as GhTodoDetails,
				};
			}

			try {
				switch (params.action) {
					case "list": {
						const issues = await listIssues(pi, true, signal);
						cachedIssues.value = issues;
						const openIssues = issues.filter((i) => i.state === "open");
						const closedIssues = issues.filter((i) => i.state === "closed");

						let text = `Todos (${PI_TODO_LABEL}):\n`;
						text += `${openIssues.length} open, ${closedIssues.length} closed\n\n`;

						if (openIssues.length === 0) {
							text += "No open todo issues.\n";
						} else {
							text += "Open:\n";
							for (const issue of openIssues) {
								const assigned = issue.assignees.length > 0 ? ` [assigned: @${issue.assignees.join(", @")}]` : "";
								text += `  #${issue.number}: ${issue.title}${assigned}\n`;
								if (issue.body) {
									const bodyPreview = (issue.body.split("\n")[0] ?? "").slice(0, 100);
									text += `    ${bodyPreview}${issue.body.length > 100 ? "..." : ""}\n`;
								}
							}
						}

						// Apply truncation (beginning of list matters most)
						text = applyTruncation(text, "head");

						return {
							content: [{ type: "text", text }],
							details: { action: "list", issues } as GhTodoDetails,
						};
					}

					case "add": {
						if (!params.title) {
							return {
								content: [{ type: "text", text: "Error: 'title' is required for 'add' action" }],
								details: { action: "add", error: "title required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await createIssue(pi, params.title, params.body, signal);
						return {
							content: [{ type: "text", text: `Created issue #${issue.number}: ${issue.title}\n${issue.url}` }],
							details: { action: "add", issue } as GhTodoDetails,
						};
					}

					case "view": {
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'view' action" }],
								details: { action: "view", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await getIssue(pi, params.number, signal);
						const userContent = extractUserContent(issue.body);
						const agentNotes = extractPiSection(issue.body);
						
						let text = `Issue #${issue.number}: ${issue.title}\n`;
						text += `State: ${issue.state}\n`;
						text += `URL: ${issue.url}\n`;
						if (issue.assignees.length > 0) {
							text += `Assigned to: @${issue.assignees.join(", @")}\n`;
						}
						text += `\n--- User Content ---\n`;
						text += userContent || "(no user content)";
						text += `\n\n--- Pi Agent Notes ---\n`;
						text += agentNotes || "(no agent notes yet)";
						
						// Apply truncation (beginning of content matters most)
						text = applyTruncation(text, "head");
						
						return {
							content: [{ type: "text", text }],
							details: { action: "view", issue, userContent, agentNotes } as GhTodoDetails,
						};
					}

					case "plan": {
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'plan' action" }],
								details: { action: "plan", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await getIssue(pi, params.number, signal);
						const userContent = extractUserContent(issue.body);
						const agentNotes = extractPiSection(issue.body);
						
						let text = `#${issue.number}: ${issue.title} [${issue.state}]\n`;
						if (issue.assignees.length > 0) {
							text += `Assigned: @${issue.assignees.join(", @")}\n`;
						}
						
						if (userContent) {
							text += `\n## User Content\n${userContent}`;
						}
						
						if (agentNotes) {
							text += `\n\n## Existing Plan\n${agentNotes}`;
							text += `\n\nReview the existing plan. Ask the user what to clarify, change, or update. Do not assume — wait for answers before using 'update'.`;
						} else {
							text += `\n\nNo plan yet. Ask the user specific questions about unclear requirements, technical decisions, scope, and dependencies. Wait for answers, then use 'update' to write the plan.`;
						}
						
						text += `\n\nDo not implement changes until the user explicitly says to proceed.`;
						
						// Apply truncation (beginning of content matters most)
						text = applyTruncation(text, "head");
						
						return {
							content: [{ type: "text", text }],
							details: { action: "plan", issue, userContent, agentNotes } as GhTodoDetails,
						};
					}

					case "start": {
						// NOTE: Tool execute() receives ExtensionContext (not ExtensionCommandContext),
						// so we CANNOT create or switch sessions here — only rename the current one
						// via pi.setSessionName(). Full session creation requires the /todo command UI.
						// We CAN handle git branches via pi.exec().
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'start' action" }],
								details: { action: "start", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await getIssue(pi, params.number, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						const sessionName = getIssueSessionName(issue);
						const targetBranch = getIssueBranchName(issue);
						
						// Ensure we're not on the default branch
						const currentBranch = await getCurrentBranch(pi, signal);
						let branchInfo = "";
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						if (isMainBranch(currentBranch)) {
							// Check for uncommitted changes before switching
							if (await hasUncommittedChanges(pi, signal)) {
								return {
									content: [{ type: "text", text: `Error: You have uncommitted changes on ${currentBranch}. Commit or stash them before starting a todo.` }],
									details: { action: "start", error: "uncommitted changes", issue } as GhTodoDetails,
									isError: true,
								};
							}
							
							if (signal?.aborted) {
								return {
									content: [{ type: "text", text: "Cancelled" }],
									details: { action: params.action } as GhTodoDetails,
								};
							}
							
							// Pull main to ensure it's up-to-date
							try {
								await pullBranch(pi, signal);
								branchInfo += `Pulled ${currentBranch} to latest.\n`;
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								branchInfo += `Warning: Failed to pull ${currentBranch}: ${msg}\n`;
							}
							
							if (signal?.aborted) {
								return {
									content: [{ type: "text", text: "Cancelled" }],
									details: { action: params.action } as GhTodoDetails,
								};
							}
							
							// Create or checkout the todo branch
							if (await branchExists(pi, targetBranch, signal)) {
								await checkoutBranch(pi, targetBranch, signal);
								branchInfo += `Checked out existing branch: ${targetBranch}\n`;
							} else {
								await checkoutNewBranch(pi, targetBranch, signal);
								branchInfo += `Created and checked out branch: ${targetBranch}\n`;
							}
						} else if (currentBranch === targetBranch) {
							branchInfo += `Already on branch: ${targetBranch}\n`;
						} else {
							branchInfo += `On branch: ${currentBranch} (expected ${targetBranch})\n`;
						}
						
						// Check for Pi Agent Notes
						const agentNotes = extractPiSection(issue.body);
						const hasNotes = agentNotes && agentNotes.trim().length > 0;
						
						// Check if a session for this issue exists (match by issue number prefix)
						const sessions = await SessionManager.listAll();
						const existingSession = sessions.find(s => sessionMatchesIssue(s.name, issue.number));
						
						let text: string;
						if (existingSession) {
							text = `Issue #${issue.number}: ${issue.title}\n`;
							text += branchInfo;
							text += `Session exists: "${existingSession.name}"\n`;
							text += `Use /resume and search for "#${issue.number}" to continue.`;
						} else {
							text = `Issue #${issue.number}: ${issue.title}\n`;
							text += branchInfo;
							text += `Branch is ready. No session yet — use /todo and press 's' to create one (the tool cannot create sessions).`;
						}
						
						// Add warning if notes are empty
						if (!hasNotes) {
							text += `\n\n⚠️ Warning: Pi Agent Notes are empty. Consider using 'plan' to understand the issue and 'update' to add notes before starting work.`;
						}
						
						text += `\n\nDo not create a PR unless the user explicitly asks for it.`;
						
						return {
							content: [{ type: "text", text }],
							details: { action: "start", issue, sessionName: existingSession?.name ?? sessionName, sessionExists: !!existingSession } as GhTodoDetails,
						};
					}

					case "close": {
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'close' action" }],
								details: { action: "close", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await closeIssue(pi, params.number, signal);
						return {
							content: [{ type: "text", text: `Closed #${issue.number}: ${issue.title} (not planned)` }],
							details: { action: "close", issue } as GhTodoDetails,
						};
					}

					case "reopen": {
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'reopen' action" }],
								details: { action: "reopen", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await reopenIssue(pi, params.number, signal);
						return {
							content: [{ type: "text", text: `Reopened #${issue.number}: ${issue.title}` }],
							details: { action: "reopen", issue } as GhTodoDetails,
						};
					}

					case "update": {
						if (params.number === undefined) {
							return {
								content: [{ type: "text", text: "Error: 'number' is required for 'update' action" }],
								details: { action: "update", error: "number required" } as GhTodoDetails,
								isError: true,
							};
						}
						if (!params.body) {
							return {
								content: [{ type: "text", text: "Error: 'body' is required for 'update' action" }],
								details: { action: "update", error: "body required" } as GhTodoDetails,
								isError: true,
							};
						}
						const issue = await updateIssueNotes(pi, params.number, params.body, signal);
						return {
							content: [{ type: "text", text: `Updated notes on #${issue.number}: ${issue.title}` }],
							details: { action: "update", issue } as GhTodoDetails,
						};
					}

					case "pr": {
						// Get current branch
						const currentBranch = await getCurrentBranch(pi, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Don't allow PR from main/master
						if (isMainBranch(currentBranch)) {
							return {
								content: [{ type: "text", text: "Error: Cannot create PR from main/master branch. Create a feature branch first." }],
								details: { action: "pr", error: "on main branch" } as GhTodoDetails,
								isError: true,
							};
						}
						
						// Detect issue number from session name
						const sessionName = pi.getSessionName();
						const sessionIssueNum = extractIssueNumberFromSession(sessionName);
						const branchIssueNum = extractIssueNumberFromBranch(currentBranch);
						
						// If on a todo/ branch, session must match
						if (branchIssueNum !== null && sessionIssueNum !== null && branchIssueNum !== sessionIssueNum) {
							return {
								content: [{ type: "text", text: `Error: Branch todo/${branchIssueNum}-* doesn't match session issue #${sessionIssueNum}. Session and branch should be for the same issue.` }],
								details: { action: "pr", error: "branch/session mismatch" } as GhTodoDetails,
								isError: true,
							};
						}
						
						// Determine issue number (prefer explicit param > session > branch)
						const issueNumber = params.number ?? sessionIssueNum ?? branchIssueNum;
						
						if (!issueNumber) {
							return {
								content: [{ type: "text", text: "Error: Could not determine issue number. Either pass 'number' parameter, use a session named '#N: Title', or be on a 'todo/N-*' branch." }],
								details: { action: "pr", error: "no issue number" } as GhTodoDetails,
								isError: true,
							};
						}
						
						// Fetch the issue
						const issue = await getIssue(pi, issueNumber, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						if (issue.state === "closed") {
							return {
								content: [{ type: "text", text: `Error: Issue #${issueNumber} is already closed.` }],
								details: { action: "pr", error: "issue closed", issue } as GhTodoDetails,
								isError: true,
							};
						}
						
						// Check for uncommitted changes
						if (await hasUncommittedChanges(pi, signal)) {
							return {
								content: [{ type: "text", text: "Error: You have uncommitted changes. Commit or stash them before creating a PR." }],
								details: { action: "pr", error: "uncommitted changes", issue } as GhTodoDetails,
								isError: true,
							};
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Push branch if needed
						if (!(await hasUpstream(pi, currentBranch, signal))) {
							await pushBranch(pi, currentBranch, signal);
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Gather session context
						const sessionContext = gatherSessionContext(ctx);
						
						// Check for PR template
						const template = await findPrTemplate(pi, signal);
						const shouldClose = params.close === true;
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Generate PR body
						let prBody: string;
						if (template) {
							prBody = await fillPrTemplate(template, issue, sessionContext, shouldClose, ctx, signal);
						} else {
							prBody = await generatePrSummary(issue, sessionContext, shouldClose, ctx, signal);
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Create PR
						const prTitle = `${issue.title} (#${issue.number})`;
						const pr = await createPr(pi, prTitle, prBody, currentBranch, signal);
						
						return {
							content: [{ type: "text", text: `Created PR #${pr.number} for issue #${issue.number}\n${pr.url}` }],
							details: { action: "pr", issue, prUrl: pr.url, prNumber: pr.number } as GhTodoDetails,
						};
					}

					case "feedback": {
						// Get current branch
						const currentBranch = await getCurrentBranch(pi, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Auto-detect PR from branch
						const pr = await getPrForBranch(pi, currentBranch, signal);
						if (!pr) {
							return {
								content: [{ type: "text", text: "Error: No PR found for current branch. Create a PR first with the 'pr' action." }],
								details: { action: "feedback", error: "no PR found" } as GhTodoDetails,
								isError: true,
							};
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						const prNumber = pr.number;
						const prUrl = pr.url;
						
						// Fetch PR feedback
						const { reviewComments, conversationComments } = await getPrFeedback(pi, prNumber, signal);
						
						// Format output
						let text = `PR #${prNumber} Feedback:\n`;
						if (prUrl) text += `${prUrl}\n`;
						text += `\n`;
						
						const totalComments = reviewComments.length + conversationComments.length;
						
						if (totalComments === 0) {
							text += `No feedback yet.\n`;
						} else {
							text += `${reviewComments.length} review comment(s), ${conversationComments.length} conversation comment(s)\n\n`;
							
							// Review comments (inline code comments + review summaries)
							if (reviewComments.length > 0) {
								text += `--- Review Comments ---\n`;
								for (const comment of reviewComments) {
									text += `\n@${comment.author}`;
									if (comment.state) text += ` [${comment.state}]`;
									if (comment.path && comment.line) {
										text += ` (${comment.path}:${comment.line})`;
									}
									text += `:\n${comment.body}\n`;
								}
							}
							
							// Conversation comments
							if (conversationComments.length > 0) {
								text += `\n--- Conversation Comments ---\n`;
								for (const comment of conversationComments) {
									text += `\n@${comment.author}:\n${comment.body}\n`;
								}
							}
						}
						
						// Apply truncation (latest comments are most actionable)
						text = applyTruncation(text, "tail");
						
						return {
							content: [{ type: "text", text }],
							details: { 
								action: "feedback", 
								prNumber, 
								prUrl,
								prReviews: reviewComments,
								prComments: conversationComments,
							} as GhTodoDetails,
						};
					}

					case "pr-update": {
						// Get current branch
						const currentBranch = await getCurrentBranch(pi, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Get PR for current branch
						const pr = await getPrForBranch(pi, currentBranch, signal);
						if (!pr) {
							return {
								content: [{ type: "text", text: "Error: No PR found for current branch. Create a PR first with the 'pr' action." }],
								details: { action: "pr-update", error: "no PR found" } as GhTodoDetails,
								isError: true,
							};
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Verify there's a PR checkpoint label (from 'pr' or previous 'pr-update')
						const checkpointId = findLastPrCheckpointEntryId(ctx);
						if (!checkpointId) {
							return {
								content: [{ type: "text", text: "Error: No PR checkpoint found. Create a PR first with the 'pr' action." }],
								details: { action: "pr-update", error: "no PR checkpoint" } as GhTodoDetails,
								isError: true,
							};
						}
						
						// Check for uncommitted changes
						if (await hasUncommittedChanges(pi, signal)) {
							return {
								content: [{ type: "text", text: "Error: You have uncommitted changes. Commit them before running pr-update." }],
								details: { action: "pr-update", error: "uncommitted changes" } as GhTodoDetails,
								isError: true,
							};
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Gather scoped data
						const commits = await getUnpushedCommits(pi, currentBranch, signal);
						const scopedContext = gatherScopedSessionContext(ctx);
						const hasCommits = commits.length > 0;
						const hasContext = scopedContext.trim().length > 0;
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Nothing to do
						if (!hasCommits && !hasContext) {
							return {
								content: [{ type: "text", text: `Nothing to update on PR #${pr.number}. No unpushed commits and no new session activity since last checkpoint.` }],
								details: { action: "pr-update", prNumber: pr.number, prUrl: pr.url } as GhTodoDetails,
							};
						}
						
						// Push if there are commits
						if (hasCommits) {
							try {
								await pushBranch(pi, currentBranch, signal);
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								return {
									content: [{ type: "text", text: `Error pushing branch: ${message}` }],
									details: { action: "pr-update", error: `push failed: ${message}`, prNumber: pr.number, prUrl: pr.url } as GhTodoDetails,
									isError: true,
								};
							}
						}
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Auto-generate summary
						const commentBody = await generatePrUpdateSummary(scopedContext, commits, pr.number, ctx, signal);
						
						if (signal?.aborted) {
							return {
								content: [{ type: "text", text: "Cancelled" }],
								details: { action: params.action } as GhTodoDetails,
							};
						}
						
						// Post comment to PR
						try {
							await addPrComment(pi, pr.number, commentBody, signal);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							const errMsg = hasCommits
								? `Pushed changes but failed to post comment: ${message}`
								: `Failed to post comment: ${message}`;
							return {
								content: [{ type: "text", text: errMsg }],
								details: { action: "pr-update", error: `comment failed: ${message}`, prNumber: pr.number, prUrl: pr.url } as GhTodoDetails,
								isError: !hasCommits, // Not a full error if push succeeded
							};
						}
						
						const commentOnly = !hasCommits;
						const statusMsg = commentOnly
							? `Commented on PR #${pr.number} (no code changes)\n${pr.url}`
							: `Pushed ${commits.length} commit(s) and commented on PR #${pr.number}\n${pr.url}`;
						
						return {
							content: [{ type: "text", text: statusMsg }],
							details: { action: "pr-update", prNumber: pr.number, prUrl: pr.url, commentOnly } as GhTodoDetails,
						};
					}

					default:
						return {
							content: [{ type: "text", text: `Unknown action: ${params.action}` }],
							details: { action: "list", error: `unknown action: ${params.action}` } as GhTodoDetails,
							isError: true,
						};
				}
			} catch (err) {
				// Check if cancelled via signal
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Cancelled" }],
						details: { action: params.action, error: "Cancelled" } as GhTodoDetails,
					};
				}
				
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: { action: params.action, error: message } as GhTodoDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("gh_todo ")) + theme.fg("muted", args.action);
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			if (args.number !== undefined) text += ` ${theme.fg("accent", `#${args.number}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as GhTodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			switch (details.action) {
				case "list": {
					const issues = details.issues || [];
					const openIssues = issues.filter((i) => i.state === "open");
					const closedIssues = issues.filter((i) => i.state === "closed");

					if (issues.length === 0) {
						return new Text(theme.fg("dim", "No todo issues"), 0, 0);
					}

					let listText = theme.fg("muted", `${openIssues.length} open, ${closedIssues.length} closed`);
					const display = expanded ? openIssues : openIssues.slice(0, 5);
					for (const issue of display) {
						const assigned =
							issue.assignees.length > 0
								? theme.fg("success", ` @${issue.assignees.join(", @")}`)
								: "";
						listText += `\n${theme.fg("accent", `#${issue.number}`)} ${theme.fg("muted", issue.title)}${assigned}`;
					}
					if (!expanded && openIssues.length > 5) {
						listText += `\n${theme.fg("dim", `... ${openIssues.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("success", "✓ Issue created"), 0, 0);
					return new Text(
						theme.fg("success", "✓ Created ") +
							theme.fg("accent", `#${issue.number}`) +
							" " +
							theme.fg("muted", issue.title),
						0,
						0
					);
				}

				case "view": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("muted", "Issue details"), 0, 0);
					let text = theme.fg("accent", `#${issue.number}`) + " " + theme.fg("text", issue.title);
					text += "\n" + theme.fg("dim", `State: ${issue.state}`);
					if (details.userContent) {
						text += "\n" + theme.fg("muted", "User content: ") + theme.fg("dim", details.userContent.slice(0, 100) + (details.userContent.length > 100 ? "..." : ""));
					}
					if (details.agentNotes) {
						text += "\n" + theme.fg("muted", "Agent notes: ") + theme.fg("dim", "present");
					} else {
						text += "\n" + theme.fg("warning", "Agent notes: ") + theme.fg("dim", "none");
					}
					return new Text(text, 0, 0);
				}

				case "plan": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("accent", "📋 Planning..."), 0, 0);
					let text = theme.fg("accent", "📋 Planning ") + theme.fg("text", `#${issue.number}: ${issue.title}`);
					if (details.agentNotes) {
						text += "\n" + theme.fg("muted", "Existing plan will be reviewed/updated");
					} else {
						text += "\n" + theme.fg("warning", "No existing plan - creating new");
					}
					return new Text(text, 0, 0);
				}

				case "start": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("muted", "Start issue"), 0, 0);
					let text = theme.fg("accent", `#${issue.number}`) + " " + theme.fg("text", issue.title);
					if (details.sessionExists) {
						text += "\n" + theme.fg("success", "Session exists: ") + theme.fg("dim", details.sessionName ?? "");
					} else {
						text += "\n" + theme.fg("warning", "No session yet");
					}
					return new Text(text, 0, 0);
				}

				case "close": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("dim", "✓ Closed"), 0, 0);
					return new Text(
						theme.fg("dim", "✓ Closed ") + theme.fg("accent", `#${issue.number}`) + theme.fg("dim", " (not planned)"),
						0,
						0
					);
				}

				case "reopen": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("success", "✓ Reopened"), 0, 0);
					return new Text(
						theme.fg("success", "✓ Reopened ") + theme.fg("accent", `#${issue.number}`),
						0,
						0
					);
				}

				case "update": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("success", "✓ Updated"), 0, 0);
					return new Text(
						theme.fg("success", "✓ Updated notes on ") + theme.fg("accent", `#${issue.number}`),
						0,
						0
					);
				}

				case "pr": {
					const issue = details.issue;
					if (!issue) return new Text(theme.fg("success", "✓ PR created"), 0, 0);
					let text = theme.fg("success", "✓ PR ") + theme.fg("accent", `#${details.prNumber || "?"}`);
					text += theme.fg("success", " created for ") + theme.fg("accent", `#${issue.number}`);
					if (details.prUrl) {
						text += "\n" + theme.fg("dim", details.prUrl);
					}
					return new Text(text, 0, 0);
				}

				case "feedback": {
					const reviewComments = details.prReviews || [];
					const conversationComments = details.prComments || [];
					const totalComments = reviewComments.length + conversationComments.length;
					
					if (totalComments === 0) {
						return new Text(
							theme.fg("accent", `PR #${details.prNumber || "?"}`) + 
							theme.fg("dim", " - no feedback yet"),
							0,
							0
						);
					}
					
					let text = theme.fg("accent", `PR #${details.prNumber || "?"}`);
					text += theme.fg("muted", ` - ${totalComments} comment(s)`);
					text += theme.fg("dim", ` (${reviewComments.length} review, ${conversationComments.length} conversation)`);
					
					if (expanded) {
						// Show review comments
						if (reviewComments.length > 0) {
							text += "\n" + theme.fg("muted", "Review comments:");
							for (const comment of reviewComments.slice(0, 3)) {
								text += "\n  " + theme.fg("accent", `@${comment.author}`);
								if (comment.state) text += " " + theme.fg("warning", `[${comment.state}]`);
								if (comment.path && comment.line) {
									text += " " + theme.fg("dim", `${comment.path}:${comment.line}`);
								}
								const preview = comment.body.slice(0, 80).replace(/\n/g, " ");
								text += "\n  " + theme.fg("text", preview) + (comment.body.length > 80 ? "..." : "");
							}
							if (reviewComments.length > 3) {
								text += "\n  " + theme.fg("dim", `... ${reviewComments.length - 3} more`);
							}
						}
						
						// Show conversation comments
						if (conversationComments.length > 0) {
							text += "\n" + theme.fg("muted", "Conversation:");
							for (const comment of conversationComments.slice(0, 3)) {
								text += "\n  " + theme.fg("accent", `@${comment.author}`);
								const preview = comment.body.slice(0, 80).replace(/\n/g, " ");
								text += "\n  " + theme.fg("text", preview) + (comment.body.length > 80 ? "..." : "");
							}
							if (conversationComments.length > 3) {
								text += "\n  " + theme.fg("dim", `... ${conversationComments.length - 3} more`);
							}
						}
					}
					
					return new Text(text, 0, 0);
				}

				case "pr-update": {
					// Nothing to update (no commentOnly field set)
					if (details.commentOnly === undefined) {
						return new Text(
							theme.fg("dim", `Nothing to update on PR #${details.prNumber || "?"}`),
							0,
							0
						);
					}
					if (details.commentOnly) {
						let text = theme.fg("success", "✓ Commented on ") + theme.fg("accent", `PR #${details.prNumber || "?"}`) + theme.fg("dim", " (no code changes)");
						if (details.prUrl) {
							text += "\n" + theme.fg("dim", details.prUrl);
						}
						return new Text(text, 0, 0);
					}
					let text = theme.fg("success", "✓ Pushed & commented on ") + theme.fg("accent", `PR #${details.prNumber || "?"}`);
					if (details.prUrl) {
						text += "\n" + theme.fg("dim", details.prUrl);
					}
					return new Text(text, 0, 0);
				}

				default:
					return new Text(theme.fg("dim", "Done"), 0, 0);
			}
		},
	});
}
