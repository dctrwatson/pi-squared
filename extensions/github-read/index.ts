import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readGitHubDiscussion, validateGitHubDiscussionRequest, type GitHubDiscussionEntry, type GitHubDiscussionPage, type GitHubDiscussionSource } from "./comments.ts";
import { MAX_GITHUB_ITEM_BODY_CODE_POINTS, readGitHubItem, readGitHubItemRemote, type GitHubItem } from "./item.ts";
import { parseGitHubItemUrl } from "./reference.ts";
import { GitHubRequestError } from "./runner.ts";
import { GitHubPullRequestRevisionError, MAX_GITHUB_PULL_FILES_PER_PAGE, readGitHubPullFiles, type GitHubPullFilesPage } from "./files.ts";

const MAX_BODY_WINDOW = 2_000;
const MAX_DISCUSSION_PAGE_SIZE = 5;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_BODY_LIMIT = 2_000;
const COMMENT_EXCERPT_LIMIT = 400;
const SOURCE_TRUNCATION_NOTICE = "The shared reader retains at most 8,000 Unicode code points per source body. One or more bodies may be longer.";

const sourceSchema = Type.Union([
  Type.Literal("comments"),
  Type.Literal("reviews"),
  Type.Literal("threads"),
  Type.Literal("thread_comments"),
], { description: "Discussion source; defaults to comments. threads gives one-comment previews; use thread_comments for replies." });

const inputSchema = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("comments"), Type.Literal("files")]),
  url: Type.String({ minLength: 1, maxLength: 512, description: "Canonical https://github.com/owner/repository/issues/number or /pull/number URL" }),
  source: Type.Optional(sourceSchema),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: "REST page; GraphQL requires 1 and uses cursor. Default: 1." })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GITHUB_PULL_FILES_PER_PAGE, description: "Changed files per page: maximum 100. Discussion entries per page: maximum 5." })),
  itemOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GITHUB_PULL_FILES_PER_PAGE - 1, description: "Changed-file window offset within the selected page; use nextItemOffset to continue" })),
  patchLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 512, description: "Maximum patch size per changed file in Unicode code points; default and maximum: 512; 0 omits patch text" })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048, description: "GraphQL continuation cursor from nextCursor" })),
  threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Required for thread_comments; use a review thread ID from threads" })),
  bodyOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS, description: "Body window offset in Unicode code points; default: 0" })),
  bodyLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BODY_WINDOW, description: "Body window size in Unicode code points; maximum: 2,000" })),
  entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Window this page entry; other entries are excerpts of up to 400 code points" })),
}, { additionalProperties: false });

type GitHubReadInput = Static<typeof inputSchema>;
type WindowFields = {
  body: string;
  bodyOffset: number;
  bodyLength: number;
  bodyNextOffset?: number;
  bodyTruncated: boolean;
  bodyWindowTruncated: boolean;
};

type ToolErrorCode = "authentication" | "permission" | "github_read_failed" | "invalid_pull_request_revision" | "output_limit";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type GitHubReadOutput =
  | { ok: true; tool: "github_read"; action: "read"; data: JsonObject }
  | { ok: true; tool: "github_read"; action: "comments"; data: JsonObject }
  | { ok: true; tool: "github_read"; action: "files"; data: JsonObject }
  | { ok: false; tool: "github_read"; error: { code: ToolErrorCode; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid github_read input: ${message}.`);
}

function validateInput(value: unknown): GitHubReadInput {
  const allowed = new Set(["action", "url", "source", "page", "perPage", "itemOffset", "patchLimit", "cursor", "threadId", "bodyOffset", "bodyLimit", "entryId"]);
  requireInput(isRecord(value), "expected an object");
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  requireInput(unknown === undefined, `unknown field ${unknown}`);
  requireInput(value.action === "read" || value.action === "comments" || value.action === "files", "action must be read, comments, or files");
  requireInput(typeof value.url === "string" && value.url.length > 0 && value.url.length <= 512, "url must be a GitHub issue or pull request URL");

  for (const key of ["page", "perPage", "itemOffset", "patchLimit", "bodyOffset", "bodyLimit"] as const) {
    if (value[key] !== undefined) requireInput(typeof value[key] === "number" && Number.isSafeInteger(value[key]), `${key} must be an integer`);
  }
  if (value.bodyOffset !== undefined) requireInput(Number(value.bodyOffset) >= 0 && Number(value.bodyOffset) <= MAX_GITHUB_ITEM_BODY_CODE_POINTS, "bodyOffset must be from 0 through 8,000");
  if (value.bodyLimit !== undefined) requireInput(Number(value.bodyLimit) >= 1 && Number(value.bodyLimit) <= MAX_BODY_WINDOW, "bodyLimit must be from 1 through 2,000");
  if (value.patchLimit !== undefined) requireInput(Number(value.patchLimit) >= 0 && Number(value.patchLimit) <= 512, "patchLimit must be from 0 through 512");
  if (value.entryId !== undefined) requireInput(typeof value.entryId === "string" && value.entryId.length > 0 && value.entryId.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value.entryId), "entryId must be a nonempty ID of at most 256 characters");

  if (value.action === "read") {
    requireInput(["source", "page", "perPage", "itemOffset", "patchLimit", "cursor", "threadId", "entryId"].every((key) => value[key] === undefined), "discussion fields require action comments");
    parseGitHubItemUrl(value.url);
    return value as GitHubReadInput;
  }

  if (value.action === "files") {
    requireInput(["source", "cursor", "threadId", "bodyOffset", "bodyLimit", "entryId"].every((key) => value[key] === undefined), "file action does not accept discussion or body-window fields");
    if (value.page !== undefined) requireInput(Number(value.page) >= 1 && Number(value.page) <= 1_000, "page must be from 1 through 1,000");
    if (value.perPage !== undefined) requireInput(Number(value.perPage) >= 1 && Number(value.perPage) <= MAX_GITHUB_PULL_FILES_PER_PAGE, `perPage must be from 1 through ${MAX_GITHUB_PULL_FILES_PER_PAGE}`);
    const filePerPage = Number(value.perPage ?? MAX_GITHUB_PULL_FILES_PER_PAGE);
    if (value.itemOffset !== undefined) requireInput(Number(value.itemOffset) >= 0 && Number(value.itemOffset) < filePerPage, `itemOffset must be from 0 through ${filePerPage - 1}`);
    requireInput(parseGitHubItemUrl(value.url).kind === "pr", "files action requires a pull request URL");
    return value as GitHubReadInput;
  }

  requireInput(value.patchLimit === undefined && value.itemOffset === undefined, "patchLimit and itemOffset require action files");
  requireInput(value.bodyOffset === undefined && value.bodyLimit === undefined || value.entryId !== undefined, "bodyOffset and bodyLimit require entryId");
  if (value.source !== undefined) requireInput(["comments", "reviews", "threads", "thread_comments"].includes(String(value.source)), "source is not supported");
  const options = {
    ...(value.source === undefined ? {} : { source: value.source as GitHubDiscussionSource }),
    ...(value.page === undefined ? {} : { page: value.page as number }),
    ...(value.perPage === undefined ? {} : { perPage: value.perPage as number }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    ...(value.threadId === undefined ? {} : { threadId: value.threadId as string }),
  };
  const request = validateGitHubDiscussionRequest(value.url, options);
  return { ...value, url: request.url } as GitHubReadInput;
}

function windowBody(body: string, sourceTruncated: boolean, offset: number, limit: number): WindowFields {
  const points = [...body];
  requireInput(offset <= points.length, `bodyOffset ${offset} exceeds retained body length ${points.length}`);
  const selected = points.slice(offset, offset + limit);
  const nextOffset = offset + selected.length < points.length ? offset + selected.length : undefined;
  return {
    body: selected.join(""),
    bodyOffset: offset,
    bodyLength: points.length,
    ...(nextOffset === undefined ? {} : { bodyNextOffset: nextOffset }),
    bodyTruncated: sourceTruncated,
    bodyWindowTruncated: sourceTruncated || offset > 0 || nextOffset !== undefined,
  };
}

function singleItemData(item: GitHubItem, offset: number, limit: number): Record<string, unknown> {
  const { body, bodyTruncated, ...metadata } = item;
  const data = {
    ...metadata,
    ...windowBody(body, bodyTruncated, offset, limit),
    coverage: "single_item",
    ...(bodyTruncated ? { sourceTruncationNotice: SOURCE_TRUNCATION_NOTICE } : {}),
  };
  return data;
}

function discussionItem(entry: GitHubDiscussionEntry, selected: boolean, offset: number, limit: number): Record<string, unknown> {
  const { body, bodyTruncated, ...metadata } = entry;
  return {
    ...metadata,
    ...(selected
      ? windowBody(body, bodyTruncated, offset, limit)
      : { ...windowBody(body, bodyTruncated, 0, COMMENT_EXCERPT_LIMIT), bodyExcerpt: true }),
  };
}

function discussionData(page: GitHubDiscussionPage, kind: "issue" | "pr", input: GitHubReadInput): Record<string, unknown> {
  const entryId = input.entryId;
  let found = entryId === undefined;
  const items = page.items.map((entry) => {
    const selected = entry.id === entryId;
    if (selected) found = true;
    return discussionItem(entry, selected, input.bodyOffset ?? 0, input.bodyLimit ?? DEFAULT_BODY_LIMIT);
  });
  requireInput(found, `entryId ${entryId} is not on this page`);
  const sourceTruncated = page.items.some((entry) => entry.bodyTruncated);
  const startsAtSourceBeginning = page.page === undefined ? page.cursor === undefined : page.page === 1;
  return {
    ...page,
    kind,
    items,
    coverage: page.eof && startsAtSourceBeginning ? "source_complete" : "page",
    ...(sourceTruncated ? { sourceTruncationNotice: SOURCE_TRUNCATION_NOTICE } : {}),
  };
}

function safeError(error: unknown): { code: ToolErrorCode; message: string } {
  const rawMessage = error instanceof Error ? error.message : "";
  if (error instanceof GitHubPullRequestRevisionError) {
    return { code: "invalid_pull_request_revision", message: error.message };
  }
  if ((error instanceof GitHubRequestError && error.httpStatus === 401) || /gh auth login|GH_TOKEN environment variable|not logged into any GitHub hosts|authentication failed/i.test(rawMessage)) {
    return { code: "authentication", message: "GitHub authentication failed. Check the existing gh authentication." };
  }
  if (error instanceof GitHubRequestError && error.httpStatus === 403) {
    return { code: "permission", message: "GitHub denied this read (HTTP 403). Check the active account and access." };
  }
  if (error instanceof GitHubRequestError && error.httpStatus !== undefined) {
    return { code: "github_read_failed", message: `GitHub read failed (HTTP ${error.httpStatus}).` };
  }
  let message = rawMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  for (const token of [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]) if (token) message = message.replaceAll(token, "[credential]");
  return { code: "github_read_failed", message: message.slice(0, 400) || "GitHub read failed." };
}

function jsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function result(content: GitHubReadOutput, isError = false) {
  const bounded = JSON.parse(JSON.stringify(content)) as GitHubReadOutput;
  let text = JSON.stringify(bounded);
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    const failure: GitHubReadOutput = { ok: false, tool: "github_read", error: { code: "output_limit", message: "GitHub read result exceeded the 64 KiB output limit." } };
    text = JSON.stringify(failure);
    return { content: [{ type: "text" as const, text }], details: failure, structuredContent: failure, isError: true };
  }
  return { content: [{ type: "text" as const, text }], details: bounded, structuredContent: bounded, ...(isError ? { isError: true } : {}) };
}

const optionalString = Type.Optional(Type.String());
const itemDataSchema = Type.Object({
  url: Type.String({ maxLength: 512 }),
  kind: Type.Union([Type.Literal("issue"), Type.Literal("pr")]),
  repository: Type.String({ maxLength: 201 }),
  number: Type.Integer({ minimum: 1 }),
  title: Type.String({ maxLength: 512 }),
  titleTruncated: Type.Boolean(),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  updatedAt: Type.String({ maxLength: 64 }),
  observedAt: Type.String({ maxLength: 64 }),
  author: optionalString,
  assignees: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
  assigneesTruncated: Type.Optional(Type.Literal(true)),
  stateReason: optionalString,
  draft: Type.Optional(Type.Boolean()),
  merged: Type.Optional(Type.Boolean()),
  mergeable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  mergeState: optionalString,
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  body: Type.String({ maxLength: MAX_BODY_WINDOW }),
  bodyOffset: Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS }),
  bodyLength: Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS }),
  bodyNextOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS })),
  bodyTruncated: Type.Boolean(),
  bodyWindowTruncated: Type.Boolean(),
  coverage: Type.Literal("single_item"),
  sourceTruncationNotice: optionalString,
}, { additionalProperties: false });
const discussionEntrySchema = Type.Object({
  id: Type.String({ maxLength: 256 }),
  url: Type.String({ maxLength: 768 }),
  author: optionalString,
  createdAt: Type.Optional(Type.String({ maxLength: 64 })),
  updatedAt: Type.Optional(Type.String({ maxLength: 64 })),
  body: Type.String({ maxLength: MAX_BODY_WINDOW }),
  bodyOffset: Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS }),
  bodyLength: Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS }),
  bodyNextOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_GITHUB_ITEM_BODY_CODE_POINTS })),
  bodyTruncated: Type.Boolean(),
  bodyWindowTruncated: Type.Boolean(),
  bodyExcerpt: Type.Optional(Type.Boolean()),
  state: optionalString,
  path: Type.Optional(Type.String({ maxLength: 1_024 })),
  resolved: Type.Optional(Type.Boolean()),
  outdated: Type.Optional(Type.Boolean()),
  hasMoreComments: Type.Optional(Type.Boolean()),
  commentCount: Type.Optional(Type.Integer({ minimum: 1 })),
  commentCursor: optionalString,
}, { additionalProperties: false });
const filesDataSchema = Type.Object({
  url: Type.String({ maxLength: 512 }),
  baseSha: Type.String({ maxLength: 64 }),
  headSha: Type.String({ maxLength: 64 }),
  totalChangedFiles: Type.Integer({ minimum: 0 }),
  snapshotStable: Type.Boolean(),
  items: Type.Array(Type.Object({
    path: Type.String({ maxLength: 512 }),
    pathTruncated: Type.Boolean(),
    status: Type.Union([Type.Literal("added"), Type.Literal("removed"), Type.Literal("modified"), Type.Literal("renamed"), Type.Literal("copied"), Type.Literal("changed"), Type.Literal("unchanged")]),
    previousPath: Type.Optional(Type.String({ maxLength: 512 })),
    previousPathTruncated: Type.Optional(Type.Boolean()),
    additions: Type.Integer({ minimum: 0 }),
    deletions: Type.Integer({ minimum: 0 }),
    changes: Type.Integer({ minimum: 0 }),
    patch: Type.String({ maxLength: 512 }),
    patchAvailable: Type.Boolean(),
    patchTruncated: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: MAX_GITHUB_PULL_FILES_PER_PAGE }),
  observedAt: Type.String({ maxLength: 64 }),
  page: Type.Integer({ minimum: 1, maximum: 1_000 }),
  perPage: Type.Integer({ minimum: 1, maximum: MAX_GITHUB_PULL_FILES_PER_PAGE }),
  itemOffset: Type.Integer({ minimum: 0, maximum: MAX_GITHUB_PULL_FILES_PER_PAGE - 1 }),
  nextItemOffset: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GITHUB_PULL_FILES_PER_PAGE - 1 })),
  patchLimit: Type.Integer({ minimum: 0, maximum: 512 }),
  nextPage: Type.Optional(Type.Integer({ minimum: 2, maximum: 1_000 })),
  pageLimitReached: Type.Optional(Type.Literal(true)),
  eof: Type.Boolean(),
  coverage: Type.Union([Type.Literal("page"), Type.Literal("source_complete"), Type.Literal("gap")]),
  gapReasons: Type.Optional(Type.Array(Type.Union([Type.Literal("github_file_limit"), Type.Literal("page_limit"), Type.Literal("path_truncated"), Type.Literal("previous_path_missing"), Type.Literal("previous_path_truncated"), Type.Literal("metadata_mismatch")]), { maxItems: 6 })),
}, { additionalProperties: false });
const discussionDataSchema = Type.Object({
  url: Type.String({ maxLength: 512 }),
  kind: Type.Union([Type.Literal("issue"), Type.Literal("pr")]),
  source: sourceSchema,
  items: Type.Array(discussionEntrySchema, { maxItems: MAX_DISCUSSION_PAGE_SIZE }),
  observedAt: Type.String({ maxLength: 64 }),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  perPage: Type.Integer({ minimum: 1, maximum: MAX_DISCUSSION_PAGE_SIZE }),
  nextPage: Type.Optional(Type.Integer({ minimum: 2, maximum: 1_000 })),
  pageLimitReached: Type.Optional(Type.Literal(true)),
  cursor: optionalString,
  nextCursor: optionalString,
  threadId: optionalString,
  eof: Type.Boolean(),
  coverage: Type.Union([Type.Literal("page"), Type.Literal("source_complete")]),
  sourceTruncationNotice: optionalString,
}, { additionalProperties: false });
const outputSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), tool: Type.Literal("github_read"), action: Type.Literal("read"), data: itemDataSchema }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(true), tool: Type.Literal("github_read"), action: Type.Literal("comments"), data: discussionDataSchema }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(true), tool: Type.Literal("github_read"), action: Type.Literal("files"), data: filesDataSchema }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(false), tool: Type.Literal("github_read"), error: Type.Object({ code: Type.Union([Type.Literal("authentication"), Type.Literal("permission"), Type.Literal("github_read_failed"), Type.Literal("invalid_pull_request_revision"), Type.Literal("output_limit")]), message: Type.String({ maxLength: 400 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
]);

/** Create a bounded, read-only GitHub item and discussion tool. */
export function createGitHubReadTool(): ToolDefinition<typeof inputSchema, GitHubReadOutput> {
  return {
    name: "github_read",
    label: "GitHub read",
    description: "Read one exact issue or PR, one page of discussion, or one page of PR changed files. source defaults to comments; reviews are PR review submissions, threads are inline threads with first-comment previews, and thread_comments reads replies for a thread. Use cursor for GraphQL pages and page for REST pages. PR files default to 100 per page and use itemOffset/nextItemOffset for bounded windows; they include base/head SHAs and bounded patches. No writes or custom commands, endpoints, projections, or queries.",
    promptSnippet: "Read one GitHub issue or PR, a bounded discussion page, or a changed-file page.",
    parameters: inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_toolCallId, params, signal) {
      const input = validateInput(params);
      try {
        if (input.action === "read") {
          const item = await readGitHubItem(input.url, { signal });
          const data = singleItemData(item, input.bodyOffset ?? 0, input.bodyLimit ?? DEFAULT_BODY_LIMIT);
          return result({ ok: true, tool: "github_read", action: "read", data: jsonObject(data) });
        }
        if (input.action === "files") {
          const data: GitHubPullFilesPage = await readGitHubPullFiles(input.url, {
            ...(input.page === undefined ? {} : { page: input.page }),
            ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
            ...(input.itemOffset === undefined ? {} : { itemOffset: input.itemOffset }),
            ...(input.patchLimit === undefined ? {} : { patchLimit: input.patchLimit }),
            signal,
          });
          return result({ ok: true, tool: "github_read", action: "files", data: jsonObject(data) });
        }
        const request = validateGitHubDiscussionRequest(input.url, {
          ...(input.source === undefined ? {} : { source: input.source as GitHubDiscussionSource }),
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.perPage === undefined ? {} : { perPage: input.perPage }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        });
        const response = await readGitHubDiscussion(request.url, {
          source: request.source,
          page: request.page,
          perPage: request.perPage,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
          signal,
        });
        if (response.status !== "ok") throw new Error("GitHub returned a conditional response without a stored discussion page.");
        const data = discussionData(response.value, parseGitHubItemUrl(request.url).kind, input);
        return result({ ok: true, tool: "github_read", action: "comments", data: jsonObject(data) });
      } catch (error) {
        if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw error;
        const failure = safeError(error);
        return result({ ok: false, tool: "github_read", error: failure }, true);
      }
    },
  };
}

/** Keep automatic package discovery inert; harnesses opt in by registering the named factory. */
export default function githubReadModule(_pi: ExtensionAPI): void {}

export { readGitHubItem, readGitHubItemRemote, MAX_GITHUB_ITEM_BODY_CODE_POINTS };
export type { GitHubItem };
export { parseGitHubItemUrl, gitHubItemKey } from "./reference.ts";
export type { GitHubItemKind, GitHubItemReference } from "./reference.ts";
export { readGitHubJson, readGitHubAccount } from "./http.ts";
export type { GitHubJsonOptions, GitHubRemoteRead, GitHubValidators } from "./http.ts";
export { readGitHubDiscussion, validateGitHubDiscussionRequest };
export type { GitHubDiscussionEntry, GitHubDiscussionPage, GitHubDiscussionSource };
export type { GitHubDiscussionOptions, GitHubDiscussionRequest } from "./comments.ts";
export { readGitHubPullFiles } from "./files.ts";
export type { GitHubPullFile, GitHubPullFilesGapReason, GitHubPullFilesOptions, GitHubPullFilesPage } from "./files.ts";
export { GitHubRequestError, runGh } from "./runner.ts";
