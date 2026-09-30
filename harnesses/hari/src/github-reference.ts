export type GitHubItemKind = "issue" | "pr";

export type GitHubItemReference = {
  kind: GitHubItemKind;
  repository: string;
  number: number;
  url: string;
};

/** Normalize an issue or PR URL without a network request. */
export function parseGitHubItemUrl(input: string): GitHubItemReference {
  if (typeof input !== "string") throw new TypeError("A GitHub issue or PR URL is required");
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new TypeError("A GitHub issue or PR URL is required"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) {
    throw new TypeError("Use an https://github.com issue or PR URL");
  }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (!match) throw new TypeError("Use an https://github.com/owner/repository/issues/number or /pull/number URL");
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) throw new RangeError("GitHub item number must be a positive safe integer");
  const repository = match[1];
  return {
    kind: match[2] === "pull" ? "pr" : "issue",
    repository,
    number,
    url: `https://github.com/${repository}/${match[2]}/${number}`,
  };
}

export function gitHubItemKey(item: Pick<GitHubItemReference, "repository" | "number">): string {
  return `${item.repository.toLowerCase()}#${item.number}`;
}
