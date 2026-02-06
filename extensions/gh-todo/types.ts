/**
 * Type definitions for gh-todo extension
 */

import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";

export const PI_TODO_LABEL = "pi-todo";
export const PI_SECTION_START = "<!-- pi-agent-notes-start -->";
export const PI_SECTION_END = "<!-- pi-agent-notes-end -->";
export const PI_SECTION_TITLE = "Pi Agent Notes";

export interface GhIssue {
	number: number;
	title: string;
	state: "open" | "closed";
	body: string;
	labels: string[];
	assignees: string[];
	url: string;
	createdAt: string;
	updatedAt: string;
}

export interface PrReviewComment {
	author: string;
	body: string;
	path?: string;
	line?: number;
	state?: string; // PENDING, APPROVED, CHANGES_REQUESTED, etc.
	createdAt: string;
}

export interface PrComment {
	author: string;
	body: string;
	createdAt: string;
}

export interface GhTodoDetails {
	action: string;
	issues?: GhIssue[];
	issue?: GhIssue;
	userContent?: string;
	agentNotes?: string | null;
	sessionName?: string;
	sessionExists?: boolean;
	prUrl?: string;
	prNumber?: number;
	prReviews?: PrReviewComment[];
	prComments?: PrComment[];
	commentOnly?: boolean;
	error?: string;
}

export const GhTodoParams = Type.Object({
	action: StringEnum(["list", "add", "view", "plan", "start", "close", "reopen", "update", "pr", "feedback", "pr-update"] as const, {
		description: "Action to perform",
	}),
	title: Type.Optional(
		Type.String({ description: "Issue title (required for 'add')" })
	),
	body: Type.Optional(
		Type.String({ description: "For 'add': user content/description. For 'update': self-contained implementation notes for Pi Agent Notes section (injected into fresh sessions when work begins)." })
	),
	number: Type.Optional(
		Type.Number({ description: "Issue number (required for 'view', 'plan', 'start', 'close', 'reopen', 'update')" })
	),
	close: Type.Optional(
		Type.Boolean({ description: "For 'pr': whether to close issue when PR merges (default: false)" })
	),
});

export type GhTodoInput = Static<typeof GhTodoParams>;

export const PR_TEMPLATE_LOCATIONS = [
	".github/pull_request_template.md",
	".github/PULL_REQUEST_TEMPLATE.md",
	"docs/pull_request_template.md",
	"pull_request_template.md",
	"PULL_REQUEST_TEMPLATE.md",
];

export type ViewMode = "list" | "add" | "detail";
