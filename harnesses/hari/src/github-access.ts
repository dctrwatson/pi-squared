import {
  discoverPullRequests,
  readIssue,
  type GitHubIssue,
  type GitHubPullRequest,
} from "./github.ts";
import { readGitHubItem } from "./github-inbox.ts";
import { parseGitHubItemUrl, type GitHubItemReference } from "./github-reference.ts";

/** Read legacy issue references or an exact PR URL in the existing issue shape. */
export async function readGitHubIssue(
  reference: string,
  options?: { repository?: string; signal?: AbortSignal },
): Promise<GitHubIssue> {
  let selected: GitHubItemReference | undefined;
  try { selected = parseGitHubItemUrl(reference); }
  catch { /* Legacy issue references retain their existing validation. */ }
  if (selected?.kind !== "pr") return readIssue(reference, options);

  const item = await readGitHubItem(selected.url, { signal: options?.signal });
  return {
    url: item.url,
    title: item.title,
    body: item.body,
    bodyTruncated: item.bodyTruncated,
    state: item.state.toUpperCase(),
    updatedAt: item.updatedAt,
    repository: item.repository,
    number: item.number,
    observedAt: item.observedAt,
  };
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
export {
  readGitHubWork,
  readGitHubItem,
  readGitHubNotifications,
  readGitHubNotification,
  updateGitHubNotification,
  GitHubNotificationUpdateError,
  type GitHubWorkSource,
  type GitHubWorkOptions,
  type GitHubWorkItem,
  type GitHubWorkSourcePage,
  type GitHubWork,
  type GitHubItem,
  type GitHubNotification,
  type GitHubNotificationsOptions,
  type GitHubNotifications,
  type GitHubNotificationDetail,
  type GitHubNotificationAction,
  type GitHubNotificationUpdate,
} from "./github-inbox.ts";
