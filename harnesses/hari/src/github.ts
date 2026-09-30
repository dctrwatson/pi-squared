import { execFile } from "node:child_process";

/** A bounded observation of a GitHub issue. */
export interface GitHubIssue {
  url: string;
  title: string;
  body: string;
  bodyTruncated: boolean;
  state: string;
  updatedAt: string;
  repository: string;
  number: number;
  observedAt: string;
}

/** A pull request selected by a bounded relevance search. */
export interface GitHubPullRequest {
  url: string;
  title: string;
  repository: string;
  number: number;
  updatedAt: string;
  reasons: string[];
}

const COMMAND_TIMEOUT_MS = 12_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_ISSUE_BODY_CODE_POINTS = 32_000;
const MAX_DISCOVERY_LIMIT = 50;
const DEFAULT_DISCOVERY_LIMIT = 20;
const MAX_REPOSITORIES = 8;
const MAX_TRACKED_ISSUES = 8;
const MAX_RESULTS_PER_QUERY = 20;
const ISSUE_FIELDS = "url,title,body,state,updatedAt";
const PULL_REQUEST_FIELDS = "url,title,repository,number,updatedAt";

interface IssueReference {
  repository: string;
  number: number;
  url: string;
}

interface DiscoveryQuery {
  args: string[];
  description: string;
  reason: string;
}

interface DiscoveryQueryResult {
  description: string;
  reason: string;
  items: GitHubPullRequest[];
  warning?: string;
}

/**
 * Reads one issue through the read-only `gh issue view` command.
 *
 * Bare issue references require a repository override. Fully qualified
 * references select their own repository. This function does not cache
 * observations; a failed read is surfaced to the caller rather than being
 * represented as current data.
 */
export async function readIssue(
  reference: string,
  options: { repository?: string; signal?: AbortSignal } = {},
): Promise<GitHubIssue> {
  const issue = parseIssueReference(reference, options.repository);
  const stdout = await runGh(
    [
      "issue",
      "view",
      String(issue.number),
      "--repo",
      issue.repository,
      "--json",
      ISSUE_FIELDS,
    ],
    options.signal,
  );

  const value = parseJson(stdout, `issue ${issue.repository}#${issue.number}`);
  if (!isRecord(value)) {
    throw new Error(`GitHub returned an invalid issue response for ${issue.repository}#${issue.number}.`);
  }

  const url = requiredString(value.url, "issue url");
  const title = requiredString(value.title, "issue title");
  const state = requiredString(value.state, "issue state");
  const updatedAt = requiredTimestamp(value.updatedAt, "issue updatedAt");
  const body = optionalString(value.body, "issue body") ?? "";
  const boundedBody = truncateCodePoints(body, MAX_ISSUE_BODY_CODE_POINTS);

  return {
    url,
    title,
    body: boundedBody.value,
    bodyTruncated: boundedBody.truncated,
    state,
    updatedAt,
    repository: issue.repository,
    number: issue.number,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Produces a bounded, on-demand PR shortlist. It searches only explicitly
 * selected repositories for review requests and mentions. Tracked-issue link
 * searches are individually bounded and may find PRs in other repositories.
 */
export async function discoverPullRequests(
  options: {
    repositories?: string[];
    trackedIssues?: string[];
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ observedAt: string; items: GitHubPullRequest[]; warnings: string[] }> {
  throwIfAborted(options.signal);

  const warnings: string[] = [
    "PR discovery is a bounded on-demand snapshot, not an exhaustive or continuously refreshed result.",
  ];
  const limit = normalizeLimit(options.limit, warnings);
  const repositories = collectRepositories(options.repositories, warnings);
  const trackedIssues = collectTrackedIssues(options.trackedIssues, warnings);
  const perQueryLimit = Math.min(limit, MAX_RESULTS_PER_QUERY);
  const queries: DiscoveryQuery[] = [];

  for (const repository of repositories) {
    queries.push({
      args: [
        "search",
        "prs",
        "--repo",
        repository,
        "--state",
        "open",
        "--review-requested",
        "@me",
        "--limit",
        String(perQueryLimit),
        "--json",
        PULL_REQUEST_FIELDS,
      ],
      description: `review-request search in ${repository}`,
      reason: "review requested",
    });
    queries.push({
      args: [
        "search",
        "prs",
        "--repo",
        repository,
        "--state",
        "open",
        "--mentions",
        "@me",
        "--limit",
        String(perQueryLimit),
        "--json",
        PULL_REQUEST_FIELDS,
      ],
      description: `mention search in ${repository}`,
      reason: "mentioned",
    });
  }

  for (const issue of trackedIssues) {
    queries.push({
      args: [
        "search",
        "prs",
        issue.url,
        "--state",
        "open",
        "--limit",
        String(perQueryLimit),
        "--json",
        PULL_REQUEST_FIELDS,
      ],
      description: `tracked-issue link search for ${issue.repository}#${issue.number}`,
      reason: `links tracked issue ${issue.url}`,
    });
  }

  if (queries.length === 0) {
    warnings.push(
      "No repositories or tracked issues were selected; skipped PR discovery rather than scan a default repository.",
    );
    return { observedAt: new Date().toISOString(), items: [], warnings };
  }

  const results = await Promise.all(
    queries.map((query) => runDiscoveryQuery(query, options.signal)),
  );
  const selected = new Map<string, GitHubPullRequest>();

  for (const result of results) {
    if (result.warning) {
      warnings.push(result.warning);
    }

    for (const item of result.items) {
      const key = `${item.repository.toLowerCase()}#${item.number}`;
      const previous = selected.get(key);
      if (previous) {
        if (!previous.reasons.includes(result.reason)) {
          previous.reasons.push(result.reason);
        }
        continue;
      }

      if (selected.size >= limit) {
        continue;
      }
      selected.set(key, { ...item, reasons: [result.reason] });
    }
  }

  return {
    observedAt: new Date().toISOString(),
    items: [...selected.values()],
    warnings,
  };
}

async function runDiscoveryQuery(
  query: DiscoveryQuery,
  signal: AbortSignal | undefined,
): Promise<DiscoveryQueryResult> {
  try {
    const stdout = await runGh(query.args, signal);
    const value = parseJson(stdout, query.description);
    if (!Array.isArray(value)) {
      return {
        description: query.description,
        reason: query.reason,
        items: [],
        warning: `${query.description} returned an invalid response; that relevance source is unknown.`,
      };
    }

    const items: GitHubPullRequest[] = [];
    let malformed = 0;
    for (const entry of value) {
      const item = parsePullRequest(entry);
      if (item) {
        items.push(item);
      } else {
        malformed += 1;
      }
    }

    return {
      description: query.description,
      reason: query.reason,
      items,
      warning:
        malformed > 0
          ? `${query.description} omitted ${malformed} malformed result(s); that relevance source is partial.`
          : undefined,
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw abortError();
    }
    return {
      description: query.description,
      reason: query.reason,
      items: [],
      warning: `${query.description} failed; that relevance source is unknown (${errorMessage(error)}).`,
    };
  }
}

function parseIssueReference(reference: string, repositoryOverride: string | undefined): IssueReference {
  if (typeof reference !== "string") {
    throw new TypeError("GitHub issue reference must be a string.");
  }

  const trimmed = reference.trim();
  const explicitUrl = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/([1-9][0-9]*)\/?$/.exec(trimmed);
  if (explicitUrl) {
    return makeIssueReference(explicitUrl[1], explicitUrl[2]);
  }

  const explicitReference = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})#([1-9][0-9]*)$/.exec(trimmed);
  if (explicitReference) {
    return makeIssueReference(explicitReference[1], explicitReference[2]);
  }

  const bareReference = /^#?([1-9][0-9]*)$/.exec(trimmed);
  if (bareReference) {
    if (!repositoryOverride) {
      throw new TypeError(
        "Bare GitHub issue references require an explicit repository option. Use owner/repository#number or a canonical https://github.com/owner/repository/issues/number URL.",
      );
    }
    return makeIssueReference(repositoryOverride, bareReference[1]);
  }

  throw new TypeError(
    "GitHub issue reference must be a bare number, owner/repository#number, or canonical https://github.com/owner/repository/issues/number URL.",
  );
}

function makeIssueReference(repository: string, numberText: string): IssueReference {
  const normalizedRepository = normalizeRepository(repository);
  const number = parsePositiveNumber(numberText, "GitHub issue number");
  return {
    repository: normalizedRepository,
    number,
    url: `https://github.com/${normalizedRepository}/issues/${number}`,
  };
}

function collectRepositories(value: string[] | undefined, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push("Repository selection was invalid; skipped review-request and mention discovery.");
    return [];
  }

  const repositories: string[] = [];
  const seen = new Set<string>();
  if (value.length > MAX_REPOSITORIES) {
    warnings.push(`Only the first ${MAX_REPOSITORIES} selected repositories were searched.`);
  }

  for (const candidate of value.slice(0, MAX_REPOSITORIES)) {
    try {
      if (typeof candidate !== "string") {
        throw new TypeError("repository is not a string");
      }
      const repository = normalizeRepository(candidate);
      const key = repository.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        repositories.push(repository);
      }
    } catch {
      warnings.push("Skipped an invalid repository selection.");
    }
  }
  return repositories;
}

function collectTrackedIssues(value: string[] | undefined, warnings: string[]): IssueReference[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push("Tracked issue selection was invalid; skipped tracked-issue link discovery.");
    return [];
  }

  const issues: IssueReference[] = [];
  const seen = new Set<string>();
  if (value.length > MAX_TRACKED_ISSUES) {
    warnings.push(`Only the first ${MAX_TRACKED_ISSUES} tracked issues were searched for PR links.`);
  }

  for (const candidate of value.slice(0, MAX_TRACKED_ISSUES)) {
    try {
      const issue = parseIssueReference(candidate, undefined);
      const key = `${issue.repository.toLowerCase()}#${issue.number}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push(issue);
      }
    } catch (error) {
      warnings.push(`Skipped tracked issue reference: ${errorMessage(error)}`);
    }
  }
  return issues;
}

function normalizeLimit(value: number | undefined, warnings: string[]): number {
  if (value === undefined) {
    return DEFAULT_DISCOVERY_LIMIT;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError("PR discovery limit must be a positive integer.");
  }
  if (value > MAX_DISCOVERY_LIMIT) {
    warnings.push(`PR discovery limit was capped at ${MAX_DISCOVERY_LIMIT}.`);
    return MAX_DISCOVERY_LIMIT;
  }
  return value;
}

function normalizeRepository(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("GitHub repository must be an owner/repository string.");
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(trimmed)) {
    throw new TypeError("GitHub repository must be a safe owner/repository string.");
  }
  return trimmed;
}

function parsePositiveNumber(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${description} must be a positive safe integer.`);
  }
  return parsed;
}

function parsePullRequest(value: unknown): GitHubPullRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const url = optionalString(value.url, "pull request url");
  const title = optionalString(value.title, "pull request title");
  const numberValue = value.number;
  const updatedAtValue = value.updatedAt;
  if (!url || title === undefined || typeof numberValue !== "number" || typeof updatedAtValue !== "string") {
    return undefined;
  }

  let number: number;
  let updatedAt: string;
  let repository: string;
  try {
    number = parsePositiveNumber(String(numberValue), "pull request number");
    if (number !== numberValue) {
      return undefined;
    }
    updatedAt = requiredTimestamp(updatedAtValue, "pull request updatedAt");
    repository = parseSearchRepository(value.repository) ?? repositoryFromPullRequestUrl(url, number) ?? "";
    repository = normalizeRepository(repository);
  } catch {
    return undefined;
  }

  if (!isCanonicalPullRequestUrl(url, repository, number)) {
    return undefined;
  }

  return { url, title, repository, number, updatedAt, reasons: [] };
}

function parseSearchRepository(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.nameWithOwner === "string") {
    return value.nameWithOwner;
  }
  if (typeof value.name === "string" && isRecord(value.owner) && typeof value.owner.login === "string") {
    return `${value.owner.login}/${value.name}`;
  }
  return undefined;
}

function repositoryFromPullRequestUrl(url: string, number: number): string | undefined {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})\/pull\/(\d+)\/?$/.exec(url);
  if (!match || Number(match[2]) !== number) {
    return undefined;
  }
  return match[1];
}

function isCanonicalPullRequestUrl(url: string, repository: string, number: number): boolean {
  const urlRepository = repositoryFromPullRequestUrl(url, number);
  return urlRepository !== undefined && urlRepository.toLowerCase() === repository.toLowerCase();
}

function parseJson(stdout: string, description: string): unknown {
  if (!stdout.trim()) {
    throw new Error(`GitHub returned no JSON for ${description}.`);
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`GitHub returned malformed JSON for ${description}.`);
  }
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub returned an invalid ${description}.`);
  }
  return value;
}

function optionalString(value: unknown, description: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`GitHub returned an invalid ${description}.`);
  }
  return value;
}

function requiredTimestamp(value: unknown, description: string): string {
  const timestamp = requiredString(value, description);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`GitHub returned an invalid ${description}.`);
  }
  return timestamp;
}

function truncateCodePoints(value: string, maximum: number): { value: string; truncated: boolean } {
  let end = 0;
  let count = 0;
  for (const codePoint of value) {
    if (count === maximum) {
      return { value: value.slice(0, end), truncated: true };
    }
    end += codePoint.length;
    count += 1;
  }
  return { value, truncated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Run gh without a shell, with the existing timeout and output limits. */
export function runGh(args: string[], signal: AbortSignal | undefined): Promise<string> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted || error.name === "AbortError") {
            reject(abortError());
            return;
          }
          reject(new Error(`GitHub CLI read failed: ${commandFailureMessage(error, stderr)}`));
          return;
        }

        const output = stdout;
        if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          reject(new Error("GitHub CLI read exceeded the bounded output limit."));
          return;
        }
        resolve(output);
      },
    );
  });
}

function commandFailureMessage(error: Error & { killed?: boolean; signal?: string | null }, stderr: string | Buffer): string {
  if (error.killed) {
    return `timed out after ${COMMAND_TIMEOUT_MS}ms or exceeded the output limit`;
  }
  const details = typeof stderr === "string" ? stderr : stderr.toString("utf8");
  const compact = details.replace(/\s+/g, " ").trim().slice(0, 400);
  return compact || error.message.replace(/\s+/g, " ").trim().slice(0, 400) || "unknown gh CLI failure";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error("GitHub read was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, " ").trim().slice(0, 400);
  }
  return "unknown failure";
}
