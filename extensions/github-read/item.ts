import { readGitHubJson, type GitHubRemoteRead, type GitHubValidators } from "./http.ts";
import { gitHubItemKey, parseGitHubItemUrl, type GitHubItemReference } from "./reference.ts";

export const MAX_GITHUB_ITEM_BODY_CODE_POINTS = 8_000;
const MAX_TITLE_CODE_POINTS = 512;
const MAX_ASSIGNEES = 20;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;
const ITEM_PROJECTION = `{url,html_url,number,title:(if .title == null then null else .title[0:513] end),state,updated_at,user:(.user|if . == null then null else {login} end),assignees:(.assignees|if . == null then null else [.[0:21][]|{login}] end),body:(if .body == null then null else .body[0:8001] end),state_reason,draft,merged,mergeable,mergeable_state,merged_at}`;

type JsonRecord = Record<string, unknown>;

export type GitHubItem = Omit<GitHubItemReference, "url"> & {
  url: string;
  title: string;
  titleTruncated: boolean;
  state: "open" | "closed";
  updatedAt: string;
  author?: string;
  assignees?: string[];
  assigneesTruncated?: true;
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

function people(value: JsonRecord): Pick<GitHubItem, "author" | "assignees" | "assigneesTruncated"> {
  const result: Pick<GitHubItem, "author" | "assignees" | "assigneesTruncated"> = {};
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

function apiPath(value: unknown): string {
  const url = text(value, "API URL", 512);
  requireValue(/^https:\/\/api\.github\.com\/[A-Za-z0-9/._-]+$/.test(url), "public GitHub API URL");
  return url.slice("https://api.github.com".length);
}

function matchesApi(value: unknown, expected: string): void {
  requireValue(apiPath(value).toLowerCase() === expected.toLowerCase(), "returned API identity");
}

function parseItem(value: unknown): Omit<GitHubItem, "observedAt" | "body" | "bodyTruncated" | "stateReason" | "draft" | "merged" | "mergeable" | "mergeState" | "mergedAt"> {
  requireValue(record(value), "item response");
  const reference = parseGitHubItemUrl(text(value.html_url, "item URL", 512));
  requireValue(value.html_url === reference.url && Number.isSafeInteger(value.number) && Number(value.number) > 0 && Number(value.number) === reference.number, "returned web identity");
  requireValue(typeof value.title === "string", "item title");
  requireValue(value.state === "open" || value.state === "closed", "item state");
  const title = bounded(value.title, MAX_TITLE_CODE_POINTS);
  return { ...reference, title: title.value, titleTruncated: title.truncated, state: value.state, updatedAt: timestamp(value.updated_at, "item updatedAt"), ...people(value) };
}

function optionsObject(value: unknown): asserts value is { signal?: AbortSignal; validators?: GitHubValidators } {
  requireValue(record(value) && Object.keys(value).every((key) => key === "signal" || key === "validators"), "item options");
}

/** Read an exact issue or PR. Do not follow links in its text. */
export async function readGitHubItem(url: string, options: { signal?: AbortSignal } = {}): Promise<GitHubItem> {
  optionsObject(options);
  const result = await readGitHubItemRemote(url, options);
  if (result.status !== "ok") throw new Error("GitHub returned 304 without a stored item.");
  return result.value;
}

/** Read item data, or validate a stored item with a conditional GET. */
export async function readGitHubItemRemote(
  url: string,
  options: { signal?: AbortSignal; validators?: GitHubValidators } = {},
): Promise<GitHubRemoteRead<GitHubItem>> {
  optionsObject(options);
  const expected = parseGitHubItemUrl(url);
  const endpoint = `/repos/${expected.repository}/${expected.kind === "pr" ? "pulls" : "issues"}/${expected.number}`;
  const response = await readGitHubJson(endpoint, { signal: options.signal, projection: ITEM_PROJECTION, ...(options.validators === undefined ? {} : { validators: options.validators }) });
  if (response.status === "not_modified") return response;
  const value = response.value;
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
  return { status: "ok", value: result, validators: response.validators };
}
