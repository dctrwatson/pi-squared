import { parseGitHubItemUrl, type GitHubItemReference } from "./reference.ts";
import { readGitHubJson } from "./http.ts";

export interface GitHubPullFile {
  path: string;
  pathTruncated: boolean;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  previousPath?: string;
  previousPathTruncated?: boolean;
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  patchAvailable: boolean;
  patchTruncated: boolean;
}

export type GitHubPullFilesGapReason = "github_file_limit" | "page_limit" | "path_truncated" | "previous_path_missing" | "previous_path_truncated" | "metadata_mismatch";

export class GitHubPullRequestRevisionError extends TypeError {
  constructor(revision: "base" | "head") {
    super(`GitHub pull request metadata does not include a valid ${revision} SHA. Exact changed-file coverage cannot be reported. Verify that both PR refs are available and retry.`);
    this.name = "GitHubPullRequestRevisionError";
  }
}

export interface GitHubPullFilesPage {
  url: string;
  baseSha: string;
  headSha: string;
  totalChangedFiles: number;
  snapshotStable: boolean;
  items: GitHubPullFile[];
  observedAt: string;
  page: number;
  perPage: number;
  itemOffset: number;
  nextItemOffset?: number;
  patchLimit: number;
  nextPage?: number;
  pageLimitReached?: true;
  eof: boolean;
  coverage: "page" | "source_complete" | "gap";
  gapReasons?: GitHubPullFilesGapReason[];
}

export interface GitHubPullFilesOptions {
  page?: number;
  perPage?: number;
  itemOffset?: number;
  patchLimit?: number;
  signal?: AbortSignal;
}

const DEFAULT_PER_PAGE = 100;
const MAX_PER_PAGE = 100;
const MAX_PAGE = 1_000;
const MAX_PATCH_CODE_POINTS = 512;
const MAX_PATH_CODE_POINTS = 512;
const GITHUB_FILES_LIMIT = 3_000;
const MAX_FILE_CAPTURE_BYTES = 1024 * 1024;
const MAX_FILE_OUTPUT_BYTES = 64 * 1024;
const FILE_STATUSES = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);

function requireValue(condition: unknown, description: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid GitHub pull request files ${description}.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown, description: string, maximum: number): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum, description);
  return value;
}

function nonnegative(value: unknown, description: string, maximum = Number.MAX_SAFE_INTEGER): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum, description);
  return value;
}

function sha(value: unknown, revision: "base" | "head"): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
    throw new GitHubPullRequestRevisionError(revision);
  }
  return value;
}

function status(value: unknown): GitHubPullFile["status"] {
  requireValue(typeof value === "string" && FILE_STATUSES.has(value), "file status");
  return value as GitHubPullFile["status"];
}

function validateOptions(value: unknown): asserts value is GitHubPullFilesOptions {
  requireValue(record(value) && Object.keys(value).every((key) => ["page", "perPage", "itemOffset", "patchLimit", "signal"].includes(key)), "options");
  if (value.page !== undefined) positive(value.page, "page", MAX_PAGE);
  if (value.perPage !== undefined) positive(value.perPage, "perPage", MAX_PER_PAGE);
  const perPage = (value.perPage as number | undefined) ?? DEFAULT_PER_PAGE;
  if (value.itemOffset !== undefined) nonnegative(value.itemOffset, "itemOffset", perPage - 1);
  if (value.patchLimit !== undefined) nonnegative(value.patchLimit, "patchLimit", MAX_PATCH_CODE_POINTS);
  if (value.signal !== undefined) {
    const signal = value.signal as AbortSignal;
    requireValue(typeof signal === "object" && signal !== null && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function", "abort signal");
  }
}

function pullMetadata(value: unknown, item: GitHubItemReference): { baseSha: string; headSha: string; totalChangedFiles: number } {
  requireValue(record(value) && value.number === item.number, "pull request identity");
  if (!record(value.base)) throw new GitHubPullRequestRevisionError("base");
  if (!record(value.head)) throw new GitHubPullRequestRevisionError("head");
  return {
    baseSha: sha(value.base.sha, "base"),
    headSha: sha(value.head.sha, "head"),
    totalChangedFiles: nonnegative(value.changed_files, "changed file count"),
  };
}

function boundedFile(value: unknown, patchLimit: number): GitHubPullFile {
  requireValue(record(value) && typeof value.filename === "string", "file path");
  if (value.pathTruncated !== undefined) requireValue(typeof value.pathTruncated === "boolean", "file path truncation flag");
  const pathPoints = [...value.filename];
  const pathTruncated = value.pathTruncated === true || pathPoints.length > MAX_PATH_CODE_POINTS;
  const path = pathPoints.slice(0, MAX_PATH_CODE_POINTS).join("");
  const fileStatus = status(value.status);
  const previousPathValue = value.previousPath === undefined ? value.previous_filename : value.previousPath;
  if (value.previousPathTruncated !== undefined) requireValue(typeof value.previousPathTruncated === "boolean", "previous file path truncation flag");
  const previousPathPoints = typeof previousPathValue === "string" ? [...previousPathValue] : [];
  const previousPathTruncated = fileStatus === "renamed"
    && (value.previousPathTruncated === true || previousPathPoints.length > MAX_PATH_CODE_POINTS);
  const previousPath = fileStatus === "renamed" && typeof previousPathValue === "string" && previousPathValue.length > 0
    ? previousPathPoints.slice(0, MAX_PATH_CODE_POINTS).join("")
    : undefined;
  const additions = nonnegative(value.additions, "file additions");
  const deletions = nonnegative(value.deletions, "file deletions");
  const changes = nonnegative(value.changes, "file changes");
  requireValue((value.patchAvailable === undefined || typeof value.patchAvailable === "boolean") && (value.patch === null || value.patch === undefined || typeof value.patch === "string"), "file patch");
  const patchAvailable = value.patchAvailable === undefined ? typeof value.patch === "string" : value.patchAvailable;
  const patchPoints = typeof value.patch === "string" ? [...value.patch] : [];
  const patchTruncated = patchAvailable && patchPoints.length > patchLimit;
  return {
    path,
    pathTruncated,
    status: fileStatus,
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(fileStatus === "renamed" ? { previousPathTruncated } : {}),
    additions,
    deletions,
    changes,
    patch: patchPoints.slice(0, patchLimit).join(""),
    patchAvailable,
    patchTruncated,
  };
}

function filesProjection(patchLimit: number): string {
  return `map({filename:(.filename[0:${MAX_PATH_CODE_POINTS + 1}]),pathTruncated:((.filename|length)>${MAX_PATH_CODE_POINTS}),status,previousPath:(if .status=="renamed" and (.previous_filename|type)=="string" then .previous_filename[0:${MAX_PATH_CODE_POINTS + 1}] else null end),previousPathTruncated:(.status=="renamed" and (.previous_filename|type)=="string" and (.previous_filename|length)>${MAX_PATH_CODE_POINTS}),additions,deletions,changes,patchAvailable:(has("patch") and (.patch|type)=="string"),patch:(if has("patch") and (.patch|type)=="string" then .patch[0:${patchLimit + 1}] else null end)})`;
}

function filePage(
  value: unknown,
  item: GitHubItemReference,
  metadata: ReturnType<typeof pullMetadata>,
  page: number,
  perPage: number,
  itemOffset: number,
  patchLimit: number,
  snapshotStable: boolean,
): GitHubPullFilesPage {
  requireValue(Array.isArray(value) && value.length <= perPage, "page");
  const pageItems = value.map((entry) => boundedFile(entry, patchLimit));
  requireValue(itemOffset < pageItems.length || pageItems.length === 0 && itemOffset === 0, "item offset");
  const paths = new Set<string>();
  for (const entry of pageItems) {
    if (entry.pathTruncated) continue;
    requireValue(!paths.has(entry.path), "duplicate file path");
    paths.add(entry.path);
  }

  const availableFileCount = Math.min(metadata.totalChangedFiles, GITHUB_FILES_LIMIT);
  const start = (page - 1) * perPage;
  const expectedOnPage = Math.max(0, Math.min(perPage, availableFileCount - start));
  const gapReasons = new Set<GitHubPullFilesGapReason>();
  if (metadata.totalChangedFiles > GITHUB_FILES_LIMIT) gapReasons.add("github_file_limit");
  if (!snapshotStable) gapReasons.add("metadata_mismatch");
  if (pageItems.some((entry) => entry.pathTruncated)) gapReasons.add("path_truncated");
  if (pageItems.some((entry) => entry.status === "renamed" && entry.previousPath === undefined)) gapReasons.add("previous_path_missing");
  if (pageItems.some((entry) => entry.status === "renamed" && entry.previousPathTruncated)) gapReasons.add("previous_path_truncated");
  if (pageItems.length !== expectedOnPage) gapReasons.add("metadata_mismatch");

  const reachedAvailableLimit = start + pageItems.length >= availableFileCount;
  const apiEof = pageItems.length < perPage || reachedAvailableLimit;
  if (!apiEof && page === MAX_PAGE) gapReasons.add("page_limit");
  const pageLimitReached = !apiEof && page === MAX_PAGE;
  const observedAt = new Date().toISOString();

  const makePageMetadata = (windowSize: number): Omit<GitHubPullFilesPage, "items"> => {
    const endOffset = itemOffset + windowSize;
    const windowConsumed = endOffset >= pageItems.length;
    const eof = windowConsumed && apiEof;
    const coverage = gapReasons.size > 0
      ? "gap"
      : page === 1 && itemOffset === 0 && windowConsumed && eof && metadata.totalChangedFiles === pageItems.length
        ? "source_complete"
        : "page";
    const reportPageLimit = windowConsumed && pageLimitReached;
    return {
      url: item.url,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      totalChangedFiles: metadata.totalChangedFiles,
      snapshotStable,
      observedAt,
      page,
      perPage,
      itemOffset,
      ...(windowConsumed ? {} : { nextItemOffset: endOffset }),
      patchLimit,
      ...(windowConsumed && !apiEof && !pageLimitReached ? { nextPage: page + 1 } : {}),
      ...(reportPageLimit ? { pageLimitReached: true as const } : {}),
      eof,
      coverage,
      ...(gapReasons.size > 0 ? { gapReasons: [...gapReasons] } : {}),
    };
  };
  const makePage = (windowSize: number): GitHubPullFilesPage => ({
    ...makePageMetadata(windowSize),
    items: pageItems.slice(itemOffset, itemOffset + windowSize),
  });
  const itemByteLengths = pageItems.map((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8"));
  let selectedSize = pageItems.length === 0 ? 0 : -1;
  let windowItemBytes = 0;
  for (let count = 1; count <= pageItems.length - itemOffset; count += 1) {
    windowItemBytes += itemByteLengths[itemOffset + count - 1]! + (count === 1 ? 0 : 1);
    const data = { ...makePageMetadata(count), items: [] };
    const output = { ok: true, tool: "github_read", action: "files", data };
    const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8") + windowItemBytes;
    if (outputBytes <= MAX_FILE_OUTPUT_BYTES) selectedSize = count;
  }
  requireValue(selectedSize >= 0, "single file output window");
  return makePage(selectedSize);
}

/** Read one bounded, read-only page of a pull request's changed files. */
async function readPullMetadata(item: GitHubItemReference, signal?: AbortSignal): Promise<ReturnType<typeof pullMetadata>> {
  const response = await readGitHubJson(`/repos/${item.repository}/pulls/${item.number}`, {
    signal,
    projection: "{number,base:{sha:.base.sha},head:{sha:.head.sha},changed_files}",
  });
  requireValue(response.status === "ok", "pull request metadata response");
  return pullMetadata(response.value, item);
}

export async function readGitHubPullFiles(url: string, options: GitHubPullFilesOptions = {}): Promise<GitHubPullFilesPage> {
  validateOptions(options);
  const item = parseGitHubItemUrl(url);
  requireValue(item.kind === "pr", "pull request URL");
  const page = options.page ?? 1;
  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const itemOffset = options.itemOffset ?? 0;
  const patchLimit = options.patchLimit ?? MAX_PATCH_CODE_POINTS;
  const metadata = await readPullMetadata(item, options.signal);
  const filesResponse = await readGitHubJson(`/repos/${item.repository}/pulls/${item.number}/files`, {
    signal: options.signal,
    fields: [`per_page=${perPage}`, `page=${page}`],
    projection: filesProjection(patchLimit),
    maxOutputBytes: MAX_FILE_CAPTURE_BYTES,
  });
  requireValue(filesResponse.status === "ok", "file page response");
  const confirmation = await readPullMetadata(item, options.signal);
  const snapshotStable = metadata.baseSha === confirmation.baseSha
    && metadata.headSha === confirmation.headSha
    && metadata.totalChangedFiles === confirmation.totalChangedFiles;
  return filePage(filesResponse.value, item, metadata, page, perPage, itemOffset, patchLimit, snapshotStable);
}

export { MAX_PAGE as MAX_GITHUB_PULL_FILES_PAGE, MAX_PER_PAGE as MAX_GITHUB_PULL_FILES_PER_PAGE, MAX_PATCH_CODE_POINTS as MAX_GITHUB_PULL_FILE_PATCH_CODE_POINTS };
