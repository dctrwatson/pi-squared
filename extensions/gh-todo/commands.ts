/**
 * Command handlers for gh-todo extension
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { type GhIssue } from "./types.js";
import {
	extractPiSection,
	getIssueSessionName,
	getIssueBranchName,
	sessionMatchesIssue,
	extractIssueNumberFromSession,
	extractIssueNumberFromBranch,
	isMainBranch,
	getSmallModel,
} from "./utils.js";
import {
	checkGhCli,
	listIssues,
	createIssue,
	getIssue,
	addIssueComment,
	closeIssue,
	reopenIssue,
	openInBrowser,
	getCurrentBranch,
	hasUncommittedChanges,
	pushBranch,
	pullBranch,
	checkoutNewBranch,
	checkoutBranch,
	branchExists,
	hasUpstream,
} from "./github.js";
import {
	findPrTemplate,
	gatherSessionContext,
	generatePrSummary,
	fillPrTemplate,
	createPr,
} from "./pr.js";
import { TodoListComponent } from "./ui.js";

export function registerCommands(pi: ExtensionAPI) {
	// Register the /todo command for users
	pi.registerCommand("todo", {
		description: "Interactive GitHub issues todo manager (pi-todo label)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.error("/todo requires interactive mode");
				return;
			}

			// Check gh CLI
			if (!(await checkGhCli(pi))) {
				ctx.ui.notify("GitHub CLI (gh) not found. Install with: brew install gh", "error");
				return;
			}

			ctx.ui.setStatus("gh-todo", "Loading issues...");

			let issues: GhIssue[];
			try {
				issues = await listIssues(pi, true);
			} catch (err) {
				ctx.ui.setStatus("gh-todo", undefined);
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to load issues: ${message}`, "error");
				return;
			}

			ctx.ui.setStatus("gh-todo", undefined);

			// Result from UI - some actions need handling after UI closes
			const result = await ctx.ui.custom<{ action: "start" | "comment"; issue: GhIssue } | null>((tui, theme, _kb, done) => {
				const component = new TodoListComponent(
					issues,
					tui,
					theme,
					() => done(null),
					async (action, issue, title, body) => {
						component.setLoading(true);
						try {
							switch (action) {
								case "refresh": {
									const refreshed = await listIssues(pi, true);
									component.updateIssues(refreshed);
									component.setStatus("Refreshed", "success");
									break;
								}
								case "add": {
									if (title) {
										const newIssue = await createIssue(pi, title, body);
										// Refresh from GitHub
										let refreshed = await listIssues(pi, true);
										// Ensure new issue is in list (GitHub API timing)
										if (!refreshed.find(i => i.number === newIssue.number)) {
											refreshed = [newIssue, ...refreshed];
										}
										component.updateIssues(refreshed);
										const openCount = refreshed.filter(i => i.state === "open").length;
										component.setStatus(`Created #${newIssue.number}: ${newIssue.title} (${openCount} open)`, "success");
									}
									break;
								}
								case "start": {
									if (issue) {
										// Close dialog and return issue for session handling
										done({ action: "start", issue });
										return;
									}
									break;
								}
								case "comment": {
									if (issue) {
										// Close dialog and handle adding comment without closing
										done({ action: "comment", issue });
										return;
									}
									break;
								}
								case "close": {
									if (issue) {
										await closeIssue(pi, issue.number);
										const refreshed = await listIssues(pi, true);
										component.updateIssues(refreshed);
										component.setStatus(`Closed #${issue.number}`, "info");
									}
									break;
								}
								case "reopen": {
									if (issue) {
										await reopenIssue(pi, issue.number);
										const refreshed = await listIssues(pi, true);
										component.updateIssues(refreshed);
										component.setStatus(`Reopened #${issue.number}`, "info");
									}
									break;
								}
								case "open": {
									if (issue?.url) {
										await openInBrowser(pi, issue.url);
										component.setStatus(`Opened #${issue.number} in browser`, "info");
									}
									break;
								}
							}
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							component.setStatus(`Error: ${message}`, "error");
						}
						component.setLoading(false);
					}
				);

				return {
					render: (width: number) => component.render(width),
					invalidate: () => component.invalidate(),
					handleInput: (data: string) => component.handleInput(data),
				};
			});

			// Handle actions after UI closes
			if (result?.action === "start" && result.issue) {
				const issue = result.issue;
				const sessionName = getIssueSessionName(issue);
				const targetBranch = getIssueBranchName(issue);
				
				// Ensure we're not on the default branch
				const currentBranch = await getCurrentBranch(pi);
				
				if (isMainBranch(currentBranch)) {
					// Check for uncommitted changes before switching
					if (await hasUncommittedChanges(pi)) {
						ctx.ui.notify(`Uncommitted changes on ${currentBranch}. Commit or stash them first.`, "error");
						return;
					}
					
					// Pull main to ensure it's up-to-date
					ctx.ui.setStatus("gh-todo", `Pulling ${currentBranch}...`);
					try {
						await pullBranch(pi);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Warning: Failed to pull ${currentBranch}: ${msg}`, "warning");
					}
					
					// Create or checkout the todo branch
					ctx.ui.setStatus("gh-todo", `Setting up branch ${targetBranch}...`);
					try {
						if (await branchExists(pi, targetBranch)) {
							await checkoutBranch(pi, targetBranch);
							ctx.ui.notify(`Checked out existing branch: ${targetBranch}`, "info");
						} else {
							await checkoutNewBranch(pi, targetBranch);
							ctx.ui.notify(`Created branch: ${targetBranch}`, "info");
						}
					} catch (err) {
						ctx.ui.setStatus("gh-todo", undefined);
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to set up branch: ${msg}`, "error");
						return;
					}
					ctx.ui.setStatus("gh-todo", undefined);
				}
				
				// Check for Pi Agent Notes
				const agentNotes = extractPiSection(issue.body);
				const hasNotes = agentNotes && agentNotes.trim().length > 0;
				
				// Warn if notes are empty - prompt to plan or continue
				if (!hasNotes) {
					const choice = await ctx.ui.select(
						`⚠️ Pi Agent Notes are empty for #${issue.number}.`,
						["Plan", "Continue"]
					);
					
					if (choice === "Plan") {
						// Rename session before triggering planning
						if (!pi.getSessionName()) {
							pi.setSessionName(sessionName);
						}
						pi.sendUserMessage(`Plan todo #${issue.number}`);
						return;
					}
					// If "Continue" is selected, proceed with starting
				}
				
				// Check if a session for this issue already exists (match by issue number prefix)
				const sessions = await SessionManager.listAll();
				const existingSession = sessions.find(s => sessionMatchesIssue(s.name, issue.number));
				
				// Check if current session is already for this issue
				const currentSessionName = pi.getSessionName();
				const isCurrentSessionForIssue = sessionMatchesIssue(currentSessionName, issue.number);
				
				if (isCurrentSessionForIssue) {
					// Already working on this issue in current session
					ctx.ui.notify(`Already working on #${issue.number}`, "info");
				} else if (existingSession) {
					// Session exists elsewhere - tell user to use /resume
					ctx.ui.notify(
						`Session for #${issue.number} exists. Use /resume and search for "#${issue.number}".`,
						"info"
					);
				} else if (!currentSessionName) {
					// Session has no name - auto-rename and inject notes
					pi.setSessionName(sessionName);
					ctx.ui.notify(`Session "${sessionName}" ready. Starting work!`, "info");
					
					// Inject agent notes
					try {
						const freshIssue = await getIssue(pi, issue.number);
						const freshNotes = extractPiSection(freshIssue.body);
						
						if (freshNotes && freshNotes.trim().length > 0) {
							let contextMessage = `Starting work on #${freshIssue.number}: ${freshIssue.title}\n\n`;
							contextMessage += `## Agent Notes\n${freshNotes}\n\n`;
							contextMessage += `Review the notes above and ask any clarifying questions.\n\n`;
							contextMessage += `⚠️ Do NOT start implementing changes until explicitly told to proceed.`;
							
							pi.sendUserMessage(contextMessage);
						}
					} catch (err) {
						console.error(`Failed to inject agent notes for #${issue.number}:`, err);
					}
				} else {
					// Session has a different name - ask what to do
					const options = [
						"Create new session",
						"Rename current session",
						"Cancel",
					];
					
					const choice = await ctx.ui.select(
						`Start working on #${issue.number}: ${issue.title}`,
						options
					);
					
					if (choice === "Create new session") {
						ctx.ui.notify(`Creating session for #${issue.number}...`, "info");
						const newSessionResult = await ctx.newSession();
						
						if (!newSessionResult.cancelled) {
							pi.setSessionName(sessionName);
							ctx.ui.notify(`Session "${sessionName}" created. Ready to work!`, "info");
							
							// Inject agent notes into the new session
							try {
								// Fetch fresh issue data to get latest agent notes from GitHub
								const freshIssue = await getIssue(pi, issue.number);
								const agentNotes = extractPiSection(freshIssue.body);
								
								if (agentNotes && agentNotes.trim().length > 0) {
									// Format and inject the context message
									let contextMessage = `Starting work on #${freshIssue.number}: ${freshIssue.title}\n\n`;
									contextMessage += `## Agent Notes\n${agentNotes}\n\n`;
									contextMessage += `Review the notes above and ask any clarifying questions.\n\n`;
									contextMessage += `⚠️ Do NOT start implementing changes until explicitly told to proceed.`;
									
									pi.sendUserMessage(contextMessage);
								}
							} catch (err) {
								// Silent failure - don't block session creation if notes injection fails
								console.error(`Failed to inject agent notes for #${issue.number}:`, err);
							}
						}
					} else if (choice === "Rename current session") {
						pi.setSessionName(sessionName);
						ctx.ui.notify(`Session renamed to "${sessionName}"`, "info");
					} else {
						ctx.ui.notify(`Cancelled`, "info");
					}
				}
			}

			// Handle adding comment without closing
			if (result?.action === "comment" && result.issue) {
				const issue = result.issue;
				
				// Gather session context for summarization
				const sessionContext = gatherSessionContext(ctx);
				
				// Generate summary using LLM
				let draftSummary = `## Progress Update: ${issue.title}\n\n### Notes:\n(Add your notes here)`;
				
				if (sessionContext.trim()) {
					const summaryPrompt = `Summarize the work done in this coding session for a GitHub issue progress comment. Be concise and focus on what was accomplished. This is a progress update, not a closing comment - the issue will remain open.

Issue: ${issue.title}

Session activity:
${sessionContext}

Write a brief markdown summary suitable for a GitHub progress comment. Include:
- What was done (bullet points)
- Any blockers or next steps if apparent

Keep it under 200 words.`;

					ctx.ui.setStatus("gh-todo", "Generating summary...");
					
					try {
						const result = await getSmallModel(ctx);
						if (result) {
							const { model, apiKey } = result;
							const response = await complete(model, {
								systemPrompt: "You are a helpful assistant that writes concise GitHub issue progress comments.",
								messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }], timestamp: Date.now() }],
							}, { apiKey });
							
							const summary = response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("");
							
							if (summary) {
								draftSummary = summary;
							}
						}
					} catch (err) {
						// Failed to generate summary, use default template
						ctx.ui.notify(`Summary generation failed, using template`, "warning");
					}
					
					ctx.ui.setStatus("gh-todo", undefined);
				}
				
				// Let user edit the summary
				const editedSummary = await ctx.ui.editor("Edit comment (or clear to cancel):", draftSummary);
				
				if (editedSummary && editedSummary.trim()) {
					// Confirm posting
					const choice = await ctx.ui.select(
						`Post comment to issue #${issue.number}?`,
						[
							"Post comment",
							"Cancel",
						]
					);
					
					if (choice === "Post comment") {
						try {
							await addIssueComment(pi, issue.number, editedSummary.trim());
							ctx.ui.notify(`Comment posted to #${issue.number}`, "info");
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(`Failed to post comment: ${message}`, "error");
						}
					} else {
						ctx.ui.notify(`Cancelled`, "info");
					}
				} else {
					ctx.ui.notify(`Cancelled - no comment posted`, "info");
				}
			}
		},
	});

	// Register the /todo-pr command
	pi.registerCommand("todo-pr", {
		description: "Create a PR for the current todo issue",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.error("/todo-pr requires interactive mode");
				return;
			}

			// Check gh CLI
			if (!(await checkGhCli(pi))) {
				ctx.ui.notify("GitHub CLI (gh) not found. Install with: brew install gh", "error");
				return;
			}

			ctx.ui.setStatus("todo-pr", "Checking git status...");

			try {
				// Get current branch
				const currentBranch = await getCurrentBranch(pi);
				
				// Don't allow PR from main/master
				if (isMainBranch(currentBranch)) {
					ctx.ui.setStatus("todo-pr", undefined);
					ctx.ui.notify("Cannot create PR from main/master branch. Create a feature branch first.", "error");
					return;
				}
				
				// Detect issue number from session name
				const sessionName = pi.getSessionName();
				const sessionIssueNum = extractIssueNumberFromSession(sessionName);
				const branchIssueNum = extractIssueNumberFromBranch(currentBranch);
				
				// If on a todo/ branch, session must match
				if (branchIssueNum !== null && sessionIssueNum !== null && branchIssueNum !== sessionIssueNum) {
					ctx.ui.setStatus("todo-pr", undefined);
					ctx.ui.notify(`Branch todo/${branchIssueNum}-* doesn't match session issue #${sessionIssueNum}`, "error");
					return;
				}
				
				// Determine issue number
				const issueNumber = sessionIssueNum ?? branchIssueNum;
				
				if (!issueNumber) {
					ctx.ui.setStatus("todo-pr", undefined);
					ctx.ui.notify("Could not determine issue number. Start a todo session first with /todo.", "error");
					return;
				}
				
				// Fetch the issue
				ctx.ui.setStatus("todo-pr", "Fetching issue...");
				const issue = await getIssue(pi, issueNumber);
				
				if (issue.state === "closed") {
					ctx.ui.setStatus("todo-pr", undefined);
					ctx.ui.notify(`Issue #${issueNumber} is already closed.`, "error");
					return;
				}
				
				// Check for uncommitted changes
				if (await hasUncommittedChanges(pi)) {
					ctx.ui.setStatus("todo-pr", undefined);
					const proceed = await ctx.ui.confirm(
						"Uncommitted changes",
						"You have uncommitted changes. Continue anyway?\n(They won't be included in the PR)"
					);
					if (!proceed) return;
				}
				
				// Push branch if needed
				ctx.ui.setStatus("todo-pr", "Checking branch...");
				if (!(await hasUpstream(pi, currentBranch))) {
					ctx.ui.setStatus("todo-pr", "Pushing branch...");
					try {
						await pushBranch(pi, currentBranch);
					} catch (err) {
						ctx.ui.setStatus("todo-pr", undefined);
						const message = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to push branch: ${message}`, "error");
						return;
					}
				}
				
				// Ask about closing the issue
				const closeChoice = await ctx.ui.select(
					`Create PR for #${issue.number}: ${issue.title}`,
					[
						"Create PR (Related: #" + issue.number + ")",
						"Create PR (Closes #" + issue.number + ")",
						"Cancel",
					]
				);
				
				if (closeChoice === "Cancel") {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				
				const shouldClose = closeChoice ? closeChoice.includes("Closes") : false;
				
				// Gather session context
				ctx.ui.setStatus("todo-pr", "Generating PR description...");
				const sessionContext = gatherSessionContext(ctx);
				
				// Check for PR template
				const template = findPrTemplate();
				
				// Generate PR body
				let prBody: string;
				if (template) {
					prBody = await fillPrTemplate(template, issue, sessionContext, shouldClose, ctx);
				} else {
					prBody = await generatePrSummary(issue, sessionContext, shouldClose, ctx);
				}
				
				ctx.ui.setStatus("todo-pr", undefined);
				
				// Let user edit the PR body
				const editedBody = await ctx.ui.editor("Edit PR description:", prBody);
				
				if (!editedBody || !editedBody.trim()) {
					ctx.ui.notify("Cancelled - empty PR description", "info");
					return;
				}
				
				// Confirm PR creation
				const prTitle = `${issue.title} (#${issue.number})`;
				const confirmChoice = await ctx.ui.select(
					`Create PR: "${prTitle}"?`,
					["Create PR", "Cancel"]
				);
				
				if (confirmChoice !== "Create PR") {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
				
				// Create the PR
				ctx.ui.setStatus("todo-pr", "Creating PR...");
				
				try {
					const pr = await createPr(pi, prTitle, editedBody.trim(), currentBranch);
					ctx.ui.setStatus("todo-pr", undefined);
					ctx.ui.notify(`Created PR #${pr.number}: ${pr.url}`, "info");
				} catch (err) {
					ctx.ui.setStatus("todo-pr", undefined);
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to create PR: ${message}`, "error");
				}
			} catch (err) {
				ctx.ui.setStatus("todo-pr", undefined);
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Error: ${message}`, "error");
			}
		},
	});
}
