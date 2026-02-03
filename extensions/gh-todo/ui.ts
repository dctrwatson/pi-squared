/**
 * UI component for gh-todo extension
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, matchesKey, Text, truncateToWidth, type TUI } from "@mariozechner/pi-tui";
import { PI_TODO_LABEL, type GhIssue, type ViewMode } from "./types.js";

/**
 * Interactive UI component for the /todo command
 */
export class TodoListComponent {
	private issues: GhIssue[];
	private theme: Theme;
	private tui: TUI;
	private onClose: () => void;
	private onAction: (action: string, issue?: GhIssue, title?: string, body?: string) => Promise<void>;
	
	private selectedIndex = 0;
	private scrollOffset = 0;
	private viewMode: ViewMode = "list";
	private statusMessage = "";
	private statusType: "info" | "error" | "success" = "info";
	private isLoading = false;
	
	// For add mode
	private editor: Editor;
	private addStep: "title" | "body" = "title";
	private newTitle = "";
	private newBody = "";
	
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		issues: GhIssue[],
		tui: TUI,
		theme: Theme,
		onClose: () => void,
		onAction: (action: string, issue?: GhIssue, title?: string, body?: string) => Promise<void>
	) {
		this.issues = issues;
		this.tui = tui;
		this.theme = theme;
		this.onClose = onClose;
		this.onAction = onAction;
		
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
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (value) => this.handleEditorSubmit(value);
	}

	updateIssues(issues: GhIssue[]) {
		this.issues = issues;
		// Adjust selection if needed
		if (this.selectedIndex >= issues.length) {
			this.selectedIndex = Math.max(0, issues.length - 1);
		}
		this.invalidate();
		this.tui.requestRender();
	}

	setStatus(message: string, type: "info" | "error" | "success" = "info") {
		this.statusMessage = message;
		this.statusType = type;
		this.invalidate();
		this.tui.requestRender();
	}

	setLoading(loading: boolean) {
		this.isLoading = loading;
		this.invalidate();
		this.tui.requestRender();
	}

	private get openIssues(): GhIssue[] {
		return this.issues.filter((i) => i.state === "open");
	}

	private get closedIssues(): GhIssue[] {
		return this.issues.filter((i) => i.state === "closed");
	}

	private get allDisplayItems(): Array<{ type: "issue" | "header"; issue?: GhIssue; label?: string }> {
		const items: Array<{ type: "issue" | "header"; issue?: GhIssue; label?: string }> = [];
		
		if (this.openIssues.length > 0) {
			items.push({ type: "header", label: "Open" });
			for (const issue of this.openIssues) {
				items.push({ type: "issue", issue });
			}
		}
		
		if (this.closedIssues.length > 0) {
			items.push({ type: "header", label: "Closed" });
			for (const issue of this.closedIssues) {
				items.push({ type: "issue", issue });
			}
		}
		
		return items;
	}

	private get selectableIndices(): number[] {
		return this.allDisplayItems
			.map((item, idx) => (item.type === "issue" ? idx : -1))
			.filter((idx) => idx >= 0);
	}

	private get selectedIssue(): GhIssue | undefined {
		const indices = this.selectableIndices;
		if (this.selectedIndex < 0 || this.selectedIndex >= indices.length) return undefined;
		const displayIdx = indices[this.selectedIndex];
		return this.allDisplayItems[displayIdx]?.issue;
	}

	private handleEditorSubmit(value: string) {
		if (this.addStep === "title") {
			this.newTitle = value.trim();
			if (!this.newTitle) {
				this.setStatus("Title cannot be empty", "error");
				return;
			}
			this.addStep = "body";
			this.editor.setText("");
			this.invalidate();
			this.tui.requestRender();
		} else {
			this.newBody = value.trim();
			const title = this.newTitle;
			const body = this.newBody;
			this.viewMode = "list";
			this.addStep = "title";
			this.editor.setText("");
			this.newTitle = "";
			this.newBody = "";
			// Set loading BEFORE triggering action to prevent empty list flash
			this.isLoading = true;
			this.invalidate();
			this.tui.requestRender();
			// Trigger async action
			this.onAction("add", undefined, title, body);
		}
	}

	handleInput(data: string): void {
		if (this.isLoading) return;

		// Handle add mode
		if (this.viewMode === "add") {
			if (matchesKey(data, "escape")) {
				this.viewMode = "list";
				this.addStep = "title";
				this.editor.setText("");
				this.newTitle = "";
				this.newBody = "";
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Handle detail mode
		if (this.viewMode === "detail") {
			if (matchesKey(data, "escape") || matchesKey(data, "return")) {
				this.viewMode = "list";
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// List mode
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.onClose();
			return;
		}

		const indices = this.selectableIndices;

		// Navigation
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (this.selectedIndex < indices.length - 1) {
				this.selectedIndex++;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// View detail
		if (matchesKey(data, "return")) {
			if (this.selectedIssue) {
				this.viewMode = "detail";
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		// Add new issue
		if (data === "a" || data === "A") {
			this.viewMode = "add";
			this.addStep = "title";
			this.editor.setText("");
			this.statusMessage = "";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Open in browser
		if (data === "o" || data === "O") {
			const issue = this.selectedIssue;
			if (issue?.url) {
				this.onAction("open", issue);
			}
			return;
		}

		// Start working on issue
		if (data === "s" || data === "S") {
			const issue = this.selectedIssue;
			if (issue && issue.state === "open") {
				this.onAction("start", issue);
			}
			return;
		}

		// Dismiss issue (close as not planned)
		if (data === "x" || data === "X") {
			const issue = this.selectedIssue;
			if (issue && issue.state === "open") {
				this.onAction("close", issue);
			}
			return;
		}

		// Reopen issue
		if (data === "g" || data === "G") {
			const issue = this.selectedIssue;
			if (issue && issue.state === "closed") {
				this.onAction("reopen", issue);
			}
			return;
		}

		// Add comment (session summary) without closing
		if (data === "c" || data === "C") {
			const issue = this.selectedIssue;
			if (issue && issue.state === "open") {
				this.onAction("comment", issue);
			}
			return;
		}

		// Refresh
		if (data === "r" || data === "R") {
			this.onAction("refresh");
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const maxVisibleItems = 15;

		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// Header
		add(th.fg("accent", "─".repeat(width)));
		const title = th.fg("accent", th.bold(` Todos (${PI_TODO_LABEL}) `));
		const counts = th.fg("muted", `${this.openIssues.length} open, ${this.closedIssues.length} closed`);
		add(`${title} ${counts}`);
		add(th.fg("accent", "─".repeat(width)));

		// Status message
		if (this.statusMessage) {
			const statusColor = this.statusType === "error" ? "error" : this.statusType === "success" ? "success" : "muted";
			add(th.fg(statusColor, ` ${this.statusMessage}`));
			add("");
		}

		// Loading indicator
		if (this.isLoading) {
			add(th.fg("warning", " Loading..."));
			add(th.fg("accent", "─".repeat(width)));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// Add mode
		if (this.viewMode === "add") {
			add("");
			add(th.fg("accent", th.bold(" Add New Issue")));
			add("");
			if (this.addStep === "title") {
				add(th.fg("text", " Title:"));
				for (const line of this.editor.render(width - 4)) {
					add(`  ${line}`);
				}
				add("");
				add(th.fg("dim", " Enter to continue • Esc to cancel"));
			} else {
				add(th.fg("muted", ` Title: ${th.fg("text", this.newTitle)}`));
				add("");
				add(th.fg("text", " Description (optional):"));
				for (const line of this.editor.render(width - 4)) {
					add(`  ${line}`);
				}
				add("");
				add(th.fg("dim", " Enter to create • Esc to cancel"));
			}
			add(th.fg("accent", "─".repeat(width)));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// Detail mode
		if (this.viewMode === "detail") {
			const issue = this.selectedIssue;
			if (issue) {
				add("");
				add(th.fg("accent", `#${issue.number}`) + " " + th.fg("text", th.bold(issue.title)));
				add("");
				add(th.fg("muted", `State: `) + th.fg(issue.state === "open" ? "success" : "dim", issue.state));
				if (issue.assignees.length > 0) {
					add(th.fg("muted", `Assigned: `) + th.fg("accent", `@${issue.assignees.join(", @")}`));
				}
				add(th.fg("muted", `URL: `) + th.fg("dim", issue.url));
				add("");
				if (issue.body) {
					add(th.fg("muted", "Description:"));
					const bodyLines = issue.body.split("\n").slice(0, 10);
					for (const line of bodyLines) {
						add(`  ${th.fg("text", line)}`);
					}
					if (issue.body.split("\n").length > 10) {
						add(th.fg("dim", "  ..."));
					}
				} else {
					add(th.fg("dim", " No description"));
				}
				add("");
				add(th.fg("dim", " Enter/Esc to go back"));
			}
			add(th.fg("accent", "─".repeat(width)));
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		// List mode
		const items = this.allDisplayItems;
		const indices = this.selectableIndices;

		if (items.length === 0) {
			add("");
			add(th.fg("dim", " No todo issues found."));
			add(th.fg("dim", " Press 'a' to add a new issue."));
			add("");
		} else {
			// Calculate scroll window
			let startIdx = 0;
			let endIdx = items.length;

			if (items.length > maxVisibleItems) {
				const selectedDisplayIdx = indices[this.selectedIndex] ?? 0;
				const halfWindow = Math.floor(maxVisibleItems / 2);
				startIdx = Math.max(0, selectedDisplayIdx - halfWindow);
				endIdx = Math.min(items.length, startIdx + maxVisibleItems);
				if (endIdx - startIdx < maxVisibleItems) {
					startIdx = Math.max(0, endIdx - maxVisibleItems);
				}
			}

			add("");
			for (let i = startIdx; i < endIdx; i++) {
				const item = items[i];
				if (item.type === "header") {
					if (i > startIdx) add(""); // spacing before header
					add(th.fg("accent", ` ${item.label}:`));
				} else if (item.issue) {
					const issue = item.issue;
					const isSelected = indices[this.selectedIndex] === i;
					const prefix = isSelected ? th.fg("accent", "> ") : "  ";
					const num = th.fg("accent", `#${issue.number}`);
					const titleColor = issue.state === "open" ? "text" : "dim";
					const titleText = isSelected ? th.bold(issue.title) : issue.title;
					const assigned =
						issue.assignees.length > 0
							? th.fg("success", ` @${issue.assignees.join(", @")}`)
							: "";
					const check = issue.state === "closed" ? th.fg("success", "✓ ") : "";
					add(truncateToWidth(`${prefix}${check}${num} ${th.fg(titleColor, titleText)}${assigned}`, width));
				}
			}

			if (startIdx > 0) {
				lines[lines.length - (endIdx - startIdx)] = th.fg("dim", ` ↑ ${startIdx} more above`);
			}
			if (endIdx < items.length) {
				add(th.fg("dim", ` ↓ ${items.length - endIdx} more below`));
			}
			add("");
		}

		// Help bar
		add(th.fg("accent", "─".repeat(width)));
		const issue = this.selectedIssue;
		const helpItems: string[] = [];
		helpItems.push("a:add");
		if (issue) {
			helpItems.push("Enter:view");
			helpItems.push("o:open");
			if (issue.state === "open") {
				helpItems.push("s:start");
				helpItems.push("c:comment");
				helpItems.push("x:dismiss");
			} else {
				helpItems.push("g:reopen");
			}
		}
		helpItems.push("r:refresh");
		helpItems.push("q/Esc:quit");
		add(th.fg("dim", ` ${helpItems.join(" • ")}`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
