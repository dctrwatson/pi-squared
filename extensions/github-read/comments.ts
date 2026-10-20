import { parseGitHubItemUrl, type GitHubItemReference } from "./reference.ts";
import { readGitHubJson, type GitHubRemoteRead, type GitHubValidators } from "./http.ts";

export type GitHubDiscussionSource = "comments" | "reviews" | "threads" | "thread_comments";

export interface GitHubDiscussionEntry {
  id: string;
  url: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  body: string;
  bodyTruncated: boolean;
  state?: string;
  path?: string;
  resolved?: boolean;
  outdated?: boolean;
  hasMoreComments?: boolean;
  commentCount?: number;
  commentCursor?: string;
}

export interface GitHubDiscussionPage {
  url: string;
  source: GitHubDiscussionSource;
  items: GitHubDiscussionEntry[];
  observedAt: string;
  page?: number;
  perPage: number;
  nextPage?: number;
  pageLimitReached?: true;
  cursor?: string;
  nextCursor?: string;
  threadId?: string;
  eof: boolean;
}

export interface GitHubDiscussionRequest {
  url: string;
  source: GitHubDiscussionSource;
  page: number;
  perPage: number;
  cursor?: string;
  threadId?: string;
}

export interface GitHubDiscussionOptions {
  source?: GitHubDiscussionSource;
  page?: number;
  perPage?: number;
  cursor?: string;
  threadId?: string;
  signal?: AbortSignal;
  validators?: GitHubValidators;
}

const DEFAULT_PER_PAGE = 5;
const MAX_PER_PAGE = 5;
const MAX_PAGE = 1_000;
const MAX_BODY_CODE_POINTS = 8_000;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_THREAD_ID_LENGTH = 256;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_+/=-]+$/;
const THREAD_ID_PATTERN = /^PRRT_[A-Za-z0-9_+/=-]+$/;
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

function requireValue(condition: unknown, description: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid GitHub ${description}.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionsObject(value: unknown): asserts value is GitHubDiscussionOptions {
  requireValue(record(value) && Object.keys(value).every((key) => ["source", "page", "perPage", "cursor", "threadId", "signal", "validators"].includes(key)), "discussion options");
}

function validateValidators(value: unknown): void {
  requireValue(record(value) && Object.keys(value).every((key) => key === "etag" || key === "lastModified"), "discussion validators");
  if (value.etag !== undefined) {
    requireValue(typeof value.etag === "string" && value.etag.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value.etag) && /^(?:W\/)?"[\x21\x23-\x7e\u0080-\u00ff]*"$/.test(value.etag), "discussion ETag");
  }
  if (value.lastModified !== undefined) {
    requireValue(typeof value.lastModified === "string" && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT$/.test(value.lastModified), "discussion Last-Modified");
    const date = new Date(value.lastModified);
    requireValue(Number.isFinite(date.getTime()) && date.toUTCString() === value.lastModified, "discussion Last-Modified");
  }
}

function positive(value: unknown, description: string, maximum = Number.MAX_SAFE_INTEGER): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum, description);
  return value;
}

function cursor(value: unknown, description: string): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH && CURSOR_PATTERN.test(value), description);
  return value;
}

function threadId(value: unknown): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= MAX_THREAD_ID_LENGTH && THREAD_ID_PATTERN.test(value), "review thread ID");
  return value;
}

function bounded(value: string): { body: string; bodyTruncated: boolean } {
  let end = 0;
  let points = 0;
  for (const point of value) {
    if (points === MAX_BODY_CODE_POINTS) return { body: value.slice(0, end), bodyTruncated: true };
    end += point.length;
    points += 1;
  }
  return { body: value, bodyTruncated: false };
}

function body(value: unknown, description: string): { body: string; bodyTruncated: boolean } {
  // Deleted comments can have a null body. Keep the entry without inventing text.
  requireValue(value === null || typeof value === "string", description);
  return bounded(value ?? "");
}

function timestamp(value: unknown, description: string, optional = false): string | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  requireValue(typeof value === "string" && value.length <= 64, description);
  const parts = /^(\d{4}-\d{2}-\d{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  requireValue(parts && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60 && Number.isFinite(Date.parse(value)), description);
  requireValue(new Date(`${parts[1]}T00:00:00Z`).toISOString().slice(0, 10) === parts[1], description);
  return value;
}

function login(value: unknown): string {
  requireValue(typeof value === "string" && value.length <= 44 && LOGIN_PATTERN.test(value), "comment author");
  return value;
}

function author(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  requireValue(record(value), "comment author");
  return login(value.login);
}

function identifier(value: unknown, description: string): string {
  if (typeof value === "number") return String(positive(value, description));
  requireValue(typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value), description);
  return value;
}

function graphNodeId(value: unknown, description: string): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= MAX_THREAD_ID_LENGTH && /^[A-Za-z0-9_+/=-]+$/.test(value), description);
  return value;
}

function databaseId(value: unknown, description: string): string {
  if (typeof value === "number") return String(positive(value, description));
  return identifier(value, description);
}

function discussionUrl(value: unknown, item: GitHubItemReference, id: string, anchor: "issuecomment" | "pullrequestreview" | "discussion_r"): string {
  requireValue(typeof value === "string" && value.length <= 768, "comment URL");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError("Invalid GitHub comment URL."); }
  const route = item.kind === "pr" ? "pull" : "issues";
  const expectedPath = `/${item.repository}/${route}/${item.number}`;
  requireValue(url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password && !url.search && url.pathname.toLowerCase() === expectedPath.toLowerCase(), "comment URL identity");
  const fragment = anchor === "discussion_r" ? `#discussion_r${id}` : `#${anchor}-${id}`;
  requireValue(url.hash === fragment, "comment URL identity");
  return value;
}

function restEntry(value: unknown, item: GitHubItemReference, source: "comments" | "reviews"): GitHubDiscussionEntry {
  requireValue(record(value), "comment response");
  const id = identifier(value.id, "comment ID");
  const url = discussionUrl(value.html_url, item, id, source === "comments" ? "issuecomment" : "pullrequestreview");
  const authorName = author(value.user);
  const createdAt = timestamp(source === "comments" ? value.created_at : value.submitted_at, "comment createdAt", source === "reviews");
  const updatedAt = source === "comments" ? timestamp(value.updated_at, "comment updatedAt") : undefined;
  const selectedBody = body(value.body, "comment body");
  const result: GitHubDiscussionEntry = { id, url, ...selectedBody };
  if (authorName !== undefined) result.author = authorName;
  if (createdAt !== undefined) result.createdAt = createdAt;
  if (updatedAt !== undefined) result.updatedAt = updatedAt;
  if (source === "reviews") {
    requireValue(typeof value.state === "string" && REVIEW_STATES.has(value.state), "review state");
    result.state = value.state;
  }
  return result;
}

function pageNumber(options: GitHubDiscussionOptions): number {
  return options.page === undefined ? 1 : positive(options.page, "discussion page", MAX_PAGE);
}

function pageSize(options: GitHubDiscussionOptions): number {
  return options.perPage === undefined ? DEFAULT_PER_PAGE : positive(options.perPage, "discussion perPage", MAX_PER_PAGE);
}

/** Validate and normalize a discussion request without starting a GitHub read. */
export function validateGitHubDiscussionRequest(url: string, options: GitHubDiscussionOptions = {}): GitHubDiscussionRequest {
  optionsObject(options);
  if (options.signal !== undefined) {
    requireValue(typeof options.signal === "object" && options.signal !== null && typeof options.signal.aborted === "boolean" && typeof options.signal.addEventListener === "function", "discussion abort signal");
  }
  if (options.validators !== undefined) validateValidators(options.validators);
  const item = parseGitHubItemUrl(url);
  const source = options.source ?? "comments";
  requireValue(["comments", "reviews", "threads", "thread_comments"].includes(source), "discussion source");
  const page = pageNumber(options);
  const perPage = pageSize(options);
  const selectedCursor = options.cursor === undefined ? undefined : cursor(options.cursor, "discussion cursor");
  const selectedThread = options.threadId === undefined ? undefined : threadId(options.threadId);

  if (source === "reviews" || source === "threads" || source === "thread_comments") requireValue(item.kind === "pr", "pull request discussion URL");
  if (source === "comments" || source === "reviews") {
    requireValue(selectedCursor === undefined && selectedThread === undefined, "REST discussion cursor or thread ID");
  } else {
    requireValue(options.validators === undefined, "GraphQL validators");
    requireValue(page === 1, "GraphQL page (use a continuation cursor)");
    if (source === "threads") requireValue(selectedThread === undefined, "review thread ID for thread list");
    else requireValue(selectedThread !== undefined, "review thread ID");
  }

  return {
    url: item.url,
    source,
    page,
    perPage,
    ...(selectedCursor === undefined ? {} : { cursor: selectedCursor }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
  };
}

function restProjection(source: "comments" | "reviews"): string {
  const bodyProjection = "body:(if .body == null then null else .body[0:8001] end)";
  if (source === "comments") return `map({id:(.id|tostring),html_url,user:(.user|if . == null then null else {login} end),created_at,updated_at,${bodyProjection}})`;
  return `map({id:(.id|tostring),html_url,user:(.user|if . == null then null else {login} end),submitted_at,state,${bodyProjection}})`;
}

const THREADS_PROJECTION = `{errors,data:{repository:{pullRequest:(if .data.repository.pullRequest == null then null else {url:.data.repository.pullRequest.url,reviewThreads:{nodes:[.data.repository.pullRequest.reviewThreads.nodes[]|{id,isResolved,isOutdated,path,comments:{totalCount:.comments.totalCount,nodes:[.comments.nodes[]|{id,databaseId,url,author:(.author|if . == null then null else {login} end),createdAt,updatedAt,body:((.body // "")[0:8001])}],pageInfo:.comments.pageInfo}}],pageInfo:.data.repository.pullRequest.reviewThreads.pageInfo}} end)}}}`;
const THREAD_COMMENTS_PROJECTION = `{errors,data:{node:(if .data.node == null then null else {id:.data.node.id,pullRequest:(if .data.node.pullRequest == null then null else {url:.data.node.pullRequest.url} end),comments:(if .data.node.comments == null then null else {nodes:[.data.node.comments.nodes[]|{id,databaseId,url,author:(.author|if . == null then null else {login} end),createdAt,updatedAt,body:((.body // "")[0:8001])}],pageInfo:.data.node.comments.pageInfo} end)} end)}}`;

function graphqlValue(value: unknown): Record<string, unknown> {
  requireValue(record(value), "GraphQL response");
  if (value.errors !== undefined && value.errors !== null) {
    requireValue(Array.isArray(value.errors), "GraphQL errors");
    if (value.errors.length > 0) throw new Error("GitHub returned GraphQL errors; no complete discussion page is available.");
  }
  requireValue(record(value.data), "GraphQL data");
  return value.data;
}

function pageInfo(value: unknown): { hasNextPage: boolean; endCursor?: string } {
  requireValue(record(value) && typeof value.hasNextPage === "boolean", "GraphQL page information");
  const result: { hasNextPage: boolean; endCursor?: string } = { hasNextPage: value.hasNextPage };
  if (value.endCursor !== null && value.endCursor !== undefined) result.endCursor = cursor(value.endCursor, "GraphQL continuation cursor");
  requireValue(!result.hasNextPage || result.endCursor !== undefined, "GraphQL continuation cursor");
  return result;
}

function uniqueItems(items: GitHubDiscussionEntry[], description: string): GitHubDiscussionEntry[] {
  const seen = new Set<string>();
  for (const item of items) {
    requireValue(!seen.has(item.id), `duplicate ${description} ID`);
    seen.add(item.id);
  }
  return items;
}

function restPage(
  value: unknown,
  item: GitHubItemReference,
  source: "comments" | "reviews",
  page: number,
  perPage: number,
): GitHubDiscussionPage {
  requireValue(Array.isArray(value), "discussion page");
  requireValue(value.length <= perPage, "discussion page size");
  const items = uniqueItems(value.map((entry) => restEntry(entry, item, source)), "discussion entry");
  const eof = items.length < perPage;
  const pageLimitReached = !eof && page === MAX_PAGE;
  return {
    url: item.url,
    source,
    items,
    observedAt: new Date().toISOString(),
    page,
    perPage,
    ...(!eof && !pageLimitReached ? { nextPage: page + 1 } : {}),
    ...(pageLimitReached ? { pageLimitReached: true as const } : {}),
    eof,
  };
}

function graphFields(item: GitHubItemReference, perPage: number, after?: string): string[] {
  const [owner, name] = item.repository.split("/");
  return [`owner=${owner}`, `name=${name}`, `number=${item.number}`, `first=${perPage}`, ...(after === undefined ? [] : [`after=${after}`])];
}

const THREADS_QUERY = "query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){url reviewThreads(first:$first,after:$after){nodes{id isResolved isOutdated path comments(first:1){totalCount nodes{id databaseId url author{login} createdAt updatedAt body} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}";
const THREAD_COMMENTS_QUERY = "query($threadId:ID!,$first:Int!,$after:String){node(id:$threadId){id ... on PullRequestReviewThread {pullRequest {url} comments(first:$first,after:$after){nodes{id databaseId url author{login} createdAt updatedAt body} pageInfo{hasNextPage endCursor}}}}}";

function expectedPullRequest(value: unknown, item: GitHubItemReference): Record<string, unknown> {
  requireValue(record(value) && typeof value.url === "string", "pull request identity");
  const expected = `https://github.com/${item.repository}/pull/${item.number}`;
  let returned: URL;
  try { returned = new URL(value.url); }
  catch { throw new TypeError("Invalid GitHub pull request identity."); }
  requireValue(returned.protocol === "https:" && returned.hostname === "github.com" && !returned.port && !returned.username && !returned.password && !returned.search && !returned.hash && returned.href.toLowerCase() === expected.toLowerCase(), "pull request identity");
  return value;
}

function graphComment(value: unknown, item: GitHubItemReference): GitHubDiscussionEntry {
  requireValue(record(value), "review thread comment");
  const id = graphNodeId(value.id, "review thread comment ID");
  const database = databaseId(value.databaseId, "review thread comment database ID");
  const url = discussionUrl(value.url, item, database, "discussion_r");
  const result: GitHubDiscussionEntry = {
    id,
    url,
    ...body(value.body, "review thread comment body"),
  };
  const authorName = author(value.author);
  if (authorName !== undefined) result.author = authorName;
  result.createdAt = timestamp(value.createdAt, "review thread comment createdAt");
  result.updatedAt = timestamp(value.updatedAt, "review thread comment updatedAt");
  return result;
}

function threadEntry(value: unknown, item: GitHubItemReference): GitHubDiscussionEntry {
  requireValue(record(value), "review thread");
  const id = threadId(value.id);
  requireValue(typeof value.isResolved === "boolean" && typeof value.isOutdated === "boolean", "review thread state");
  requireValue(typeof value.path === "string" && value.path.length > 0 && value.path.length <= 1_024 && !/[\u0000-\u001f\u007f]/.test(value.path), "review thread path");
  requireValue(record(value.comments) && Array.isArray(value.comments.nodes) && value.comments.nodes.length === 1, "review thread preview");
  const commentCount = value.comments.totalCount;
  requireValue(typeof commentCount === "number" && Number.isSafeInteger(commentCount) && commentCount > 0, "review thread comment count");
  const first = value.comments.nodes[0];
  requireValue(record(first), "review thread preview");
  const preview = graphComment(first, item);
  const commentsPage = pageInfo(value.comments.pageInfo);
  if (commentsPage.hasNextPage) requireValue(commentsPage.endCursor !== undefined, "review thread comment cursor");
  return {
    ...preview,
    id,
    path: value.path,
    resolved: value.isResolved,
    outdated: value.isOutdated,
    commentCount,
    hasMoreComments: commentsPage.hasNextPage,
    ...(commentsPage.hasNextPage ? { commentCursor: commentsPage.endCursor! } : {}),
  };
}

function threadsPage(value: unknown, item: GitHubItemReference, perPage: number, selectedCursor?: string): GitHubDiscussionPage {
  const data = graphqlValue(value);
  requireValue(record(data.repository), "repository in GraphQL response");
  const pullRequest = expectedPullRequest(data.repository.pullRequest, item);
  requireValue(record(pullRequest.reviewThreads) && Array.isArray(pullRequest.reviewThreads.nodes) && pullRequest.reviewThreads.nodes.length <= perPage, "review thread page");
  const items = uniqueItems(pullRequest.reviewThreads.nodes.map((entry) => threadEntry(entry, item)), "review thread");
  const info = pageInfo(pullRequest.reviewThreads.pageInfo);
  return {
    url: item.url,
    source: "threads",
    items,
    observedAt: new Date().toISOString(),
    perPage,
    ...(selectedCursor === undefined ? {} : { cursor: selectedCursor }),
    ...(info.hasNextPage ? { nextCursor: info.endCursor! } : {}),
    eof: !info.hasNextPage,
  };
}

function threadCommentsPage(value: unknown, item: GitHubItemReference, thread: string, perPage: number, selectedCursor?: string): GitHubDiscussionPage {
  const data = graphqlValue(value);
  requireValue(record(data.node) && data.node.id === thread, "review thread identity");
  expectedPullRequest(data.node.pullRequest, item);
  requireValue(record(data.node.comments) && Array.isArray(data.node.comments.nodes) && data.node.comments.nodes.length <= perPage, "review thread comments");
  const comments = uniqueItems(data.node.comments.nodes.map((entry) => graphComment(entry, item)), "review thread comment");
  const info = pageInfo(data.node.comments.pageInfo);
  return {
    url: item.url,
    source: "thread_comments",
    items: comments,
    observedAt: new Date().toISOString(),
    perPage,
    ...(selectedCursor === undefined ? {} : { cursor: selectedCursor }),
    ...(info.hasNextPage ? { nextCursor: info.endCursor! } : {}),
    threadId: thread,
    eof: !info.hasNextPage,
  };
}

/** Read one bounded page of issue or pull-request discussion. */
export async function readGitHubDiscussion(url: string, options: GitHubDiscussionOptions = {}): Promise<GitHubRemoteRead<GitHubDiscussionPage>> {
  const request = validateGitHubDiscussionRequest(url, options);
  const item = parseGitHubItemUrl(request.url);
  const { source, page, perPage, cursor: selectedCursor, threadId: selectedThread } = request;

  if (source === "comments" || source === "reviews") {
    const endpoint = `/repos/${item.repository}/${source === "reviews" ? "pulls" : "issues"}/${item.number}/${source}`;
    const response = await readGitHubJson(endpoint, {
      signal: options.signal,
      fields: [`per_page=${perPage}`, `page=${page}`],
      projection: restProjection(source),
      ...(options.validators === undefined ? {} : { validators: options.validators }),
    });
    if (response.status === "not_modified") return response;
    return { status: "ok", value: restPage(response.value, item, source, page, perPage), validators: response.validators };
  }

  if (source === "threads") {
    const response = await readGitHubJson("/graphql", {
      signal: options.signal,
      fields: graphFields(item, perPage, selectedCursor),
      query: THREADS_QUERY,
      projection: THREADS_PROJECTION,
    });
    if (response.status !== "ok") throw new Error("GitHub returned an invalid GraphQL conditional response.");
    return { status: "ok", value: threadsPage(response.value, item, perPage, selectedCursor), validators: response.validators };
  }

  requireValue(selectedThread !== undefined, "review thread ID");
  const response = await readGitHubJson("/graphql", {
    signal: options.signal,
    fields: [`threadId=${selectedThread}`, `first=${perPage}`, ...(selectedCursor === undefined ? [] : [`after=${selectedCursor}`])],
    query: THREAD_COMMENTS_QUERY,
    projection: THREAD_COMMENTS_PROJECTION,
  });
  if (response.status !== "ok") throw new Error("GitHub returned an invalid GraphQL conditional response.");
  return { status: "ok", value: threadCommentsPage(response.value, item, selectedThread, perPage, selectedCursor), validators: response.validators };
}
