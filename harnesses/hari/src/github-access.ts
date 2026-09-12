import {
  discoverPullRequests,
  readIssue,
  type GitHubIssue,
  type GitHubPullRequest,
} from "./github.ts";

/** Harness role-layer access to the independently owned, read-only GitHub module. */
export async function readGitHubIssue(
  reference: string,
  options?: { repository?: string; signal?: AbortSignal },
): Promise<GitHubIssue> {
  return readIssue(reference, options);
}

export async function discoverGitHubPullRequests(options?: {
  repositories?: string[];
  trackedIssues?: string[];
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ observedAt: string; items: GitHubPullRequest[]; warnings: string[] }> {
  return discoverPullRequests(options);
}

export type { GitHubIssue, GitHubPullRequest };
