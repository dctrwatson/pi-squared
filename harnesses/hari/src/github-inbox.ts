import { runGh } from "./github.ts";
import { gitHubItemKey, parseGitHubItemUrl, type GitHubItemReference } from "./github-reference.ts";

export const MAX_GITHUB_PAGE_SIZE = 25;
export const MAX_GITHUB_ITEM_BODY_CODE_POINTS = 8_000;
const MAX_TITLE_CODE_POINTS = 512;
const MAX_ASSIGNEES = 20;
const SEARCH_RESULT_LIMIT = 1_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const THREAD_PATTERN = /^[1-9][0-9]{0,19}$/;

export type GitHubWorkSource = "authored" | "assigned" | "review_requested";
export type GitHubWorkOptions = {
  source?: "all" | GitHubWorkSource;
  kind?: "all" | "issue" | "pr";
  state?: "open" | "closed" | "all";
  page?: number;
  perPage?: number;
  signal?: AbortSignal;
};
export type GitHubWorkItem = GitHubItemReference & {
  title: string;
  titleTruncated: boolean;
  state: "open" | "closed";
  updatedAt: string;
  author?: string;
  assignees?: string[];
  assigneesTruncated?: true;
  reasons: GitHubWorkSource[];
};
export type GitHubWorkSourcePage = {
  source: GitHubWorkSource;
  page: number;
  perPage: number;
  count: number;
  totalCount?: number;
  nextPage?: number;
  incomplete_results?: boolean;
  error?: string;
};
export type GitHubWork = {
  observedAt: string;
  account: string;
  page: number;
  perPage: number;
  items: GitHubWorkItem[];
  sources: GitHubWorkSourcePage[];
  warnings: string[];
};
export type GitHubItem = Omit<GitHubWorkItem, "reasons"> & {
  observedAt: string;
  body: string;
  bodyTruncated: boolean;
  stateReason?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeState?: string;
  mergedAt?: string | null;
};
export type GitHubNotification = {
  id: string;
  unread: boolean;
  reason: string;
  updatedAt: string;
  lastReadAt?: string;
  repository: string;
  title: string;
  titleTruncated: boolean;
  subjectType: string;
  url: string;
  item?: GitHubItemReference;
};
export type GitHubNotificationsOptions = {
  page?: number;
  perPage?: number;
  includeRead?: boolean;
  since?: string;
  signal?: AbortSignal;
};
export type GitHubNotifications = {
  observedAt: string;
  page: number;
  perPage: number;
  nextPage?: number;
  items: GitHubNotification[];
  pagination: "link" | "conservative";
  warnings: string[];
};
export type GitHubNotificationDetail = GitHubNotification & {
  observedAt: string;
  latestComment?: { url: string; body: string; bodyTruncated: boolean; author?: string; updatedAt: string };
  warnings: string[];
};
export type GitHubNotificationAction = "mark_read" | "mark_done";
export type GitHubNotificationUpdate = { thread: string; action: GitHubNotificationAction; status: "confirmed" };

/** A failed selected-thread write is not a confirmed change. Inspect before retry. */
export class GitHubNotificationUpdateError extends Error {
  readonly status = "unconfirmed";
  readonly thread: string;
  readonly action: GitHubNotificationAction;
  constructor(thread: string, action: GitHubNotificationAction, cause: unknown) {
    super(`GitHub notification ${thread} ${action} is unconfirmed. Inspect the thread before retry. ${failure(cause)}`, { cause });
    this.thread = thread;
    this.action = action;
    this.name = isAbort(cause) ? "AbortError" : "GitHubNotificationUpdateError";
  }
}

type JsonRecord = Record<string, unknown>;
type ApiResponse = { status: number; headers: Map<string, string>; body: string };

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireValue(condition: unknown, description: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid GitHub ${description}.`);
}
function text(value: unknown, description: string, maximum = 256): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maximum, description);
  return value;
}
function timestamp(value: unknown, description: string): string {
  const result = text(value, description, 64);
  const parts = /^(\d{4}-\d{2}-\d{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.exec(result);
  requireValue(parts && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60 && Number.isFinite(Date.parse(result)), description);
  requireValue(new Date(`${parts[1]}T00:00:00Z`).toISOString().slice(0, 10) === parts[1], description);
  return result;
}
function positive(value: unknown, description: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0, description);
  return value;
}
function pagination(options: { page?: number; perPage?: number }): { page: number; perPage: number } {
  const page = options.page === undefined ? 1 : positive(options.page, "page");
  const perPage = options.perPage === undefined ? 10 : positive(options.perPage, "perPage");
  requireValue(page < Number.MAX_SAFE_INTEGER, "page (continuation must remain a safe integer)");
  requireValue(perPage <= MAX_GITHUB_PAGE_SIZE, `perPage (maximum ${MAX_GITHUB_PAGE_SIZE})`);
  return { page, perPage };
}
function optionsObject(value: unknown, keys: string[]): asserts value is JsonRecord {
  requireValue(record(value) && Object.keys(value).every((key) => keys.includes(key)), "options");
}
function bounded(value: string, maximum: number): { value: string; truncated: boolean } {
  let end = 0;
  let count = 0;
  for (const point of value) {
    if (count === maximum) return { value: value.slice(0, end), truncated: true };
    end += point.length;
    count += 1;
  }
  return { value, truncated: false };
}
function login(value: unknown): string {
  const result = text(value, "account login", 44);
  requireValue(LOGIN_PATTERN.test(result), "account login");
  return result;
}
function people(value: JsonRecord): Pick<GitHubWorkItem, "author" | "assignees" | "assigneesTruncated"> {
  const result: Pick<GitHubWorkItem, "author" | "assignees" | "assigneesTruncated"> = {};
  if (value.user !== undefined && value.user !== null) {
    requireValue(record(value.user), "author");
    result.author = login(value.user.login);
  }
  if (value.assignees !== undefined && value.assignees !== null) {
    requireValue(Array.isArray(value.assignees), "assignees");
    result.assignees = value.assignees.slice(0, MAX_ASSIGNEES).map((person) => {
      requireValue(record(person), "assignee");
      return login(person.login);
    });
    if (value.assignees.length > MAX_ASSIGNEES) result.assigneesTruncated = true;
  }
  return result;
}
function repository(value: unknown): string {
  const result = text(value, "repository", 201);
  requireValue(REPOSITORY_PATTERN.test(result), "repository");
  return result;
}
function threadId(value: unknown): string {
  requireValue(typeof value === "string" && THREAD_PATTERN.test(value), "notification thread ID (1 to 20 decimal digits)");
  return value;
}
function sameRepository(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function apiPath(value: unknown): string {
  const url = text(value, "API URL", 512);
  requireValue(/^https:\/\/api\.github\.com\/[A-Za-z0-9/._-]+$/.test(url), "public GitHub API URL");
  return url.slice("https://api.github.com".length);
}
function matchesApi(value: unknown, expected: string): void {
  requireValue(apiPath(value).toLowerCase() === expected.toLowerCase(), "returned API identity");
}
function json(response: ApiResponse): unknown {
  try { return JSON.parse(response.body); }
  catch { throw new Error("GitHub returned malformed or missing JSON."); }
}
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function abort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("GitHub request was aborted.");
    error.name = "AbortError";
    throw error;
  }
}
function failure(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 400) : "Unknown GitHub request failure.";
}

// All endpoints are constructed here. Do not use response URLs as gh arguments.
async function api(method: "GET" | "PATCH" | "DELETE", endpoint: string, fields: string[], signal?: AbortSignal, projection?: string): Promise<ApiResponse> {
  abort(signal);
  const output = await runGh(["api", endpoint, "--hostname", "github.com", "--method", method, "--include", ...fields.flatMap((field) => ["-f", field]), ...(projection ? ["--jq", projection] : [])], signal);
  abort(signal);
  const split = /\r?\n\r?\n/.exec(output);
  if (!split || split.index === undefined) throw new Error("GitHub returned no HTTP status headers.");
  const lines = output.slice(0, split.index).split(/\r?\n/);
  const status = /^HTTP\/[0-9.]+ ([0-9]{3})(?: |$)/.exec(lines.shift() ?? "");
  if (!status) throw new Error("GitHub returned invalid HTTP status headers.");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const match = /^([^:\s]+):\s*(.*)$/.exec(line);
    requireValue(match, "HTTP header");
    const key = match[1].toLowerCase();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${match[2]}` : match[2]);
  }
  const response = { status: Number(status[1]), headers, body: output.slice(split.index + split[0].length) };
  if (method === "GET" && response.status !== 200) throw new Error(`GitHub GET returned HTTP ${response.status}, not 200.`);
  return response;
}

function parseItem(value: unknown): Omit<GitHubWorkItem, "reasons"> {
  requireValue(record(value), "item response");
  const reference = parseGitHubItemUrl(text(value.html_url, "item URL", 512));
  requireValue(value.html_url === reference.url && positive(value.number, "item number") === reference.number, "returned web identity");
  requireValue(typeof value.title === "string", "item title");
  requireValue(value.state === "open" || value.state === "closed", "item state");
  const title = bounded(value.title, MAX_TITLE_CODE_POINTS);
  return { ...reference, title: title.value, titleTruncated: title.truncated, state: value.state, updatedAt: timestamp(value.updated_at, "item updatedAt"), ...people(value) };
}

/** Read one page per applicable personal-work source. GitHub search exposes at most 1,000 results. */
export async function readGitHubWork(options: GitHubWorkOptions = {}): Promise<GitHubWork> {
  optionsObject(options, ["source", "kind", "state", "page", "perPage", "signal"]);
  const { page, perPage } = pagination(options);
  requireValue((page - 1) * perPage < SEARCH_RESULT_LIMIT, "search page (first 1,000 results only)");
  const source = options.source === undefined ? "all" : options.source;
  const kind = options.kind === undefined ? "all" : options.kind;
  const state = options.state === undefined ? "open" : options.state;
  requireValue(["all", "authored", "assigned", "review_requested"].includes(source), "work source");
  requireValue(["all", "issue", "pr"].includes(kind), "work kind");
  requireValue(["open", "closed", "all"].includes(state), "work state");
  requireValue(source !== "review_requested" || kind !== "issue", "issue review-request source");
  const user = json(await api("GET", "/user", [], options.signal, "{login}"));
  requireValue(record(user), "authenticated user");
  const account = login(user.login);
  const requested: GitHubWorkSource[] = source === "all" ? ["authored", "assigned", ...(kind === "issue" ? [] : ["review_requested" as const])] : [source];
  const items = new Map<string, GitHubWorkItem>();
  const sources: GitHubWorkSourcePage[] = [];
  const warnings: string[] = [];
  for (const selected of requested) {
    abort(options.signal);
    const result: GitHubWorkSourcePage = { source: selected, page, perPage, count: 0 };
    sources.push(result);
    const qualifier = selected === "authored" ? "author" : selected === "assigned" ? "assignee" : "review-requested";
    const query = [`${qualifier}:${account}`, ...(state === "all" ? [] : [`is:${state}`]), ...(kind === "all" && selected !== "review_requested" ? [] : [`is:${selected === "review_requested" ? "pr" : kind}`])].join(" ");
    try {
      const projection = "{total_count,incomplete_results,items:[.items[]|{url,repository_url,html_url,number,title,state,updated_at,user:(.user|if . == null then null else {login} end),assignees:(.assignees|if . == null then null else [.[]|{login}] end)}]}";
      const value = json(await api("GET", "/search/issues", [`q=${query}`, "sort=updated", "order=desc", `page=${page}`, `per_page=${perPage}`], options.signal, projection));
      requireValue(record(value) && Number.isSafeInteger(value.total_count) && Number(value.total_count) >= 0 && typeof value.incomplete_results === "boolean" && Array.isArray(value.items) && value.items.length <= perPage, "search page");
      result.totalCount = value.total_count as number;
      result.incomplete_results = value.incomplete_results;
      if (page * perPage < Math.min(result.totalCount, SEARCH_RESULT_LIMIT)) result.nextPage = page + 1;
      if (result.totalCount > SEARCH_RESULT_LIMIT) warnings.push(`${selected}: GitHub search exposes only the first 1,000 results.`);
      if (result.incomplete_results) warnings.push(`${selected}: GitHub reports incomplete_results; this source is partial.`);
      let malformed = 0;
      for (const entry of value.items) {
        try {
          const item = parseItem(entry);
          requireValue(record(entry), "search item");
          // Search represents PRs through the issue endpoint too.
          matchesApi(entry.url, `/repos/${item.repository}/issues/${item.number}`);
          matchesApi(entry.repository_url, `/repos/${item.repository}`);
          requireValue((kind === "all" || item.kind === kind) && (selected !== "review_requested" || item.kind === "pr") && (state === "all" || item.state === state), "search result scope");
          const key = gitHubItemKey(item);
          const previous = items.get(key);
          requireValue(!previous || previous.kind === item.kind, "conflicting item kind");
          result.count += 1;
          if (previous) {
            if (!previous.reasons.includes(selected)) previous.reasons.push(selected);
            if (Date.parse(item.updatedAt) > Date.parse(previous.updatedAt)) items.set(key, { ...item, reasons: previous.reasons });
          } else items.set(key, { ...item, reasons: [selected] });
        } catch { malformed += 1; }
      }
      if (malformed) {
        result.error = `Omitted ${malformed} invalid search item(s); this source is partial.`;
        warnings.push(`${selected}: ${result.error}`);
      }
    } catch (error) {
      if (isAbort(error) || options.signal?.aborted) { abort(options.signal); throw error; }
      result.error = failure(error);
      warnings.push(`${selected}: source unavailable (${result.error}).`);
    }
  }
  abort(options.signal);
  return { observedAt: new Date().toISOString(), account, page, perPage, items: [...items.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || gitHubItemKey(a).localeCompare(gitHubItemKey(b))), sources, warnings };
}

/** Read an exact issue or PR. Do not follow links in its text. */
export async function readGitHubItem(url: string, options: { signal?: AbortSignal } = {}): Promise<GitHubItem> {
  optionsObject(options, ["signal"]);
  const expected = parseGitHubItemUrl(url);
  const endpoint = `/repos/${expected.repository}/${expected.kind === "pr" ? "pulls" : "issues"}/${expected.number}`;
  const value = json(await api("GET", endpoint, [], options.signal));
  const item = parseItem(value);
  requireValue(item.kind === expected.kind && gitHubItemKey(item) === gitHubItemKey(expected), "selected item identity");
  requireValue(record(value), "item response");
  matchesApi(value.url, endpoint);
  requireValue(value.body === null || typeof value.body === "string", "item body");
  const body = bounded(value.body ?? "", MAX_GITHUB_ITEM_BODY_CODE_POINTS);
  const result: GitHubItem = { ...item, observedAt: new Date().toISOString(), body: body.value, bodyTruncated: body.truncated };
  if (value.state_reason !== undefined && value.state_reason !== null) result.stateReason = text(value.state_reason, "state reason", 128);
  if (item.kind === "pr") {
    for (const key of ["draft", "merged"] as const) {
      if (value[key] !== undefined) { requireValue(typeof value[key] === "boolean", `PR ${key}`); result[key] = value[key]; }
    }
    if (value.mergeable !== undefined) { requireValue(value.mergeable === null || typeof value.mergeable === "boolean", "PR mergeable"); result.mergeable = value.mergeable; }
    if (value.mergeable_state !== undefined) result.mergeState = text(value.mergeable_state, "PR merge state", 128);
    if (value.merged_at !== undefined) result.mergedAt = value.merged_at === null ? null : timestamp(value.merged_at, "PR mergedAt");
  }
  return result;
}

function parseNotification(value: unknown): { item: GitHubNotification; latestCommentUrl?: string } {
  requireValue(record(value) && record(value.repository) && record(value.subject), "notification response");
  const id = threadId(value.id);
  matchesApi(value.url, `/notifications/threads/${id}`);
  const repo = repository(value.repository.full_name);
  requireValue(value.repository.html_url === `https://github.com/${repo}`, "notification repository URL");
  requireValue(typeof value.unread === "boolean", "notification unread state");
  const subjectType = text(value.subject.type, "notification subject type", 128);
  requireValue(typeof value.subject.title === "string", "notification title");
  const title = bounded(value.subject.title, MAX_TITLE_CODE_POINTS);
  let reference: GitHubItemReference | undefined;
  if ((subjectType === "Issue" || subjectType === "PullRequest") && value.subject.url !== null && value.subject.url !== undefined) {
    const path = apiPath(value.subject.url);
    const match = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/([1-9][0-9]*)$/.exec(path);
    requireValue(match && sameRepository(match[1], repo) && match[2] === (subjectType === "Issue" ? "issues" : "pulls"), "notification subject binding");
    reference = parseGitHubItemUrl(`https://github.com/${repo}/${subjectType === "Issue" ? "issues" : "pull"}/${match[3]}`);
  }
  const item: GitHubNotification = { id, unread: value.unread, reason: text(value.reason, "notification reason", 128), updatedAt: timestamp(value.updated_at, "notification updatedAt"), repository: repo, title: title.value, titleTruncated: title.truncated, subjectType, url: reference?.url ?? `https://github.com/${repo}`, ...(reference ? { item: reference } : {}) };
  if (value.last_read_at !== null && value.last_read_at !== undefined) item.lastReadAt = timestamp(value.last_read_at, "notification lastReadAt");
  if (value.subject.latest_comment_url !== null && value.subject.latest_comment_url !== undefined) requireValue(typeof value.subject.latest_comment_url === "string", "latest comment URL");
  return { item, ...(typeof value.subject.latest_comment_url === "string" ? { latestCommentUrl: value.subject.latest_comment_url } : {}) };
}

function nextNotificationPage(link: string, page: number, perPage: number): number | undefined {
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (!match || !match[2].split(" ").includes("next")) continue;
    let url: URL;
    try { url = new URL(match[1]); } catch { throw new Error("Invalid GitHub notification pagination URL."); }
    requireValue(url.protocol === "https:" && url.hostname === "api.github.com" && !url.port && !url.username && !url.password && url.pathname === "/notifications" && !url.hash, "notification pagination URL");
    requireValue(url.searchParams.get("page") === String(page + 1) && (url.searchParams.get("per_page") === null || url.searchParams.get("per_page") === String(perPage)), "notification pagination page");
    return page + 1;
  }
  return undefined;
}

/** Read notifications without changing their read/done state. */
export async function readGitHubNotifications(options: GitHubNotificationsOptions = {}): Promise<GitHubNotifications> {
  optionsObject(options, ["page", "perPage", "includeRead", "since", "signal"]);
  const { page, perPage } = pagination(options);
  requireValue(options.includeRead === undefined || typeof options.includeRead === "boolean", "includeRead");
  const fields = [`page=${page}`, `per_page=${perPage}`, `all=${options.includeRead ?? false}`, "participating=false"];
  if (options.since !== undefined) fields.push(`since=${new Date(timestamp(options.since, "since")).toISOString()}`);
  const response = await api("GET", "/notifications", fields, options.signal);
  const value = json(response);
  requireValue(Array.isArray(value) && value.length <= perPage, "notifications page");
  const items = value.map((entry) => parseNotification(entry).item);
  const link = response.headers.get("link");
  const nextPage = link !== undefined ? nextNotificationPage(link, page, perPage) : items.length === perPage ? page + 1 : undefined;
  return { observedAt: new Date().toISOString(), page, perPage, ...(nextPage === undefined ? {} : { nextPage }), items, pagination: link === undefined ? "conservative" : "link", warnings: link === undefined && nextPage !== undefined ? ["A full page without a Link header needs one extra read to establish the end."] : [] };
}

function commentEndpoint(url: string, repo: string): { path: string; id: number } {
  const path = apiPath(url);
  const match = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/comments\/([1-9][0-9]*)$/.exec(path);
  requireValue(match && sameRepository(match[1], repo), "latest comment endpoint");
  const id = positive(Number(match[3]), "comment ID");
  return { path: `/repos/${repo}/${match[2]}/comments/${id}`, id };
}

/** Inspect one selected thread. Only approved, same-repository comment endpoints can be read. */
export async function readGitHubNotification(thread: string, options: { signal?: AbortSignal } = {}): Promise<GitHubNotificationDetail> {
  optionsObject(options, ["signal"]);
  const id = threadId(thread);
  const value = json(await api("GET", `/notifications/threads/${id}`, [], options.signal));
  const parsed = parseNotification(value);
  requireValue(parsed.item.id === id, "selected notification thread binding");
  const result: GitHubNotificationDetail = { ...parsed.item, observedAt: new Date().toISOString(), warnings: [] };
  if (!parsed.latestCommentUrl) return result;
  try {
    const endpoint = commentEndpoint(parsed.latestCommentUrl, parsed.item.repository);
    const comment = json(await api("GET", endpoint.path, [], options.signal));
    requireValue(record(comment) && comment.id === endpoint.id && (comment.body === null || typeof comment.body === "string"), "latest comment response");
    matchesApi(comment.url, endpoint.path);
    const body = bounded(comment.body ?? "", MAX_GITHUB_ITEM_BODY_CODE_POINTS);
    result.latestComment = { url: `https://api.github.com${endpoint.path}`, body: body.value, bodyTruncated: body.truncated, ...people({ user: comment.user }), updatedAt: timestamp(comment.updated_at, "comment updatedAt") };
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) { abort(options.signal); throw error; }
    result.warnings.push(`Latest comment detail is unavailable; this thread read is partial (${failure(error)}).`);
  }
  abort(options.signal);
  return result;
}

/** Change only the selected thread within the caller's authority. Never retry here. */
export async function updateGitHubNotification(thread: string, action: GitHubNotificationAction, options: { signal?: AbortSignal } = {}): Promise<GitHubNotificationUpdate> {
  optionsObject(options, ["signal"]);
  const id = threadId(thread);
  requireValue(action === "mark_read" || action === "mark_done", "notification action");
  try {
    const response = await api(action === "mark_read" ? "PATCH" : "DELETE", `/notifications/threads/${id}`, [], options.signal);
    const expected = action === "mark_read" ? 205 : 204;
    if (response.status !== expected) throw new Error(`GitHub returned HTTP ${response.status}, not the expected ${expected}.`);
    return { thread: id, action, status: "confirmed" };
  } catch (error) {
    throw new GitHubNotificationUpdateError(id, action, error);
  }
}
