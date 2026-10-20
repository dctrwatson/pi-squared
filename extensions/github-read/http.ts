import { GitHubRequestError, runGh } from "./runner.ts";

export interface GitHubValidators {
  etag?: string;
  lastModified?: string;
}

export type GitHubRemoteRead<T> =
  | { status: "ok"; value: T; validators: GitHubValidators }
  | { status: "not_modified"; validators: GitHubValidators };

export interface GitHubJsonOptions {
  signal?: AbortSignal;
  fields?: string[];
  projection?: string;
  validators?: GitHubValidators;
  query?: string;
  maxOutputBytes?: number;
}

interface HttpResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

function requireValue(condition: unknown, description: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid GitHub ${description}.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHeader(value: unknown, description: string, maximum = 512): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value), description);
  return value;
}

function etag(value: unknown): string {
  const result = safeHeader(value, "ETag");
  requireValue(/^(?:W\/)?"[\x21\x23-\x7e\u0080-\u00ff]*"$/.test(result), "ETag");
  return result;
}

function lastModified(value: unknown): string {
  const result = safeHeader(value, "Last-Modified", 64);
  requireValue(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT$/.test(result), "Last-Modified header");
  const date = new Date(result);
  requireValue(Number.isFinite(date.getTime()) && date.toUTCString() === result, "Last-Modified header");
  return result;
}

function validateValidators(value: unknown): GitHubValidators {
  requireValue(record(value) && Object.keys(value).every((key) => key === "etag" || key === "lastModified"), "validators");
  const result: GitHubValidators = {};
  if (value.etag !== undefined) result.etag = etag(value.etag);
  if (value.lastModified !== undefined) result.lastModified = lastModified(value.lastModified);
  return result;
}

function endpointPath(value: unknown): string {
  requireValue(typeof value === "string" && value.length <= 512 && value.startsWith("/"), "API endpoint");
  requireValue(!/[?#\\\u0000-\u0020\u007f]/.test(value) && !value.includes("//"), "API endpoint");
  requireValue(value.split("/").every((part) => part !== "." && part !== ".."), "API endpoint");
  requireValue(value === "/graphql" || value === "/user" || /^\/repos\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/(?:issues\/[1-9][0-9]*(?:\/comments)?|pulls\/[1-9][0-9]*(?:\/(?:comments|reviews|files))?)$/.test(value), "API endpoint");
  return value;
}

function hasWriteOperation(query: string): boolean {
  for (let index = 0; index < query.length;) {
    if (query[index] === "#") {
      while (index < query.length && query[index] !== "\n" && query[index] !== "\r") index += 1;
      continue;
    }
    if (query.startsWith('"""', index)) {
      index += 3;
      let closed = false;
      while (index < query.length) {
        if (query.startsWith('\\\"""', index)) { index += 4; continue; }
        if (query.startsWith('"""', index)) { index += 3; closed = true; break; }
        index += 1;
      }
      if (!closed) return true;
      continue;
    }
    if (query[index] === '"') {
      index += 1;
      let closed = false;
      while (index < query.length) {
        if (query[index] === "\\") { index += 2; continue; }
        if (query[index] === '"') { index += 1; closed = true; break; }
        index += 1;
      }
      if (!closed) return true;
      continue;
    }
    if (/[A-Za-z_]/.test(query[index]!)) {
      const start = index++;
      while (index < query.length && /[A-Za-z0-9_]/.test(query[index]!)) index += 1;
      const token = query.slice(start, index);
      if (token === "mutation" || token === "subscription") return true;
      continue;
    }
    index += 1;
  }
  return false;
}

function validateOptions(value: unknown): asserts value is GitHubJsonOptions {
  requireValue(record(value) && Object.keys(value).every((key) => ["signal", "fields", "projection", "validators", "query", "maxOutputBytes"].includes(key)), "API options");
  if (value.maxOutputBytes !== undefined) requireValue(typeof value.maxOutputBytes === "number" && Number.isSafeInteger(value.maxOutputBytes) && value.maxOutputBytes >= 256 * 1024 && value.maxOutputBytes <= 1024 * 1024, "API output limit");
  if (value.fields !== undefined) {
    requireValue(Array.isArray(value.fields) && value.fields.length <= 20, "API fields");
    for (const field of value.fields) {
      requireValue(typeof field === "string" && field.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(field), "API field");
      const split = field.indexOf("=");
      requireValue(split > 0 && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(field.slice(0, split)), "API field");
    }
  }
  if (value.projection !== undefined) {
    requireValue(typeof value.projection === "string" && value.projection.length > 0 && value.projection.length <= 16_384 && !/[\u0000\r\n]/.test(value.projection), "API projection");
  }
  if (value.query !== undefined) {
    requireValue(typeof value.query === "string" && value.query.length > 0 && value.query.length <= 16_384 && /^query(?:\s|\()/.test(value.query) && !/[\u0000\r]/.test(value.query) && !hasWriteOperation(value.query), "read-only GraphQL query");
  }
  if (value.validators !== undefined) validateValidators(value.validators);
}

function parseResponse(output: string): HttpResponse {
  const separator = /\r?\n\r?\n/.exec(output);
  requireValue(separator?.index !== undefined, "HTTP status and headers");
  const lines = output.slice(0, separator.index).split(/\r?\n/);
  const statusLine = lines.shift() ?? "";
  const match = /^HTTP\/[0-9.]+ ([0-9]{3})(?:[ \t].*)?$/.exec(statusLine);
  requireValue(match, "HTTP status");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/.exec(line);
    requireValue(header && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(header[2]!), "HTTP header");
    headers.set(header[1]!.toLowerCase(), header[2]!.trim());
  }
  return { status: Number(match[1]!), headers, body: output.slice(separator.index + separator[0].length) };
}

function responseValidators(headers: Map<string, string>): GitHubValidators {
  const result: GitHubValidators = {};
  const responseEtag = headers.get("etag");
  const responseLastModified = headers.get("last-modified");
  if (responseEtag !== undefined) result.etag = etag(responseEtag);
  if (responseLastModified !== undefined) result.lastModified = lastModified(responseLastModified);
  return result;
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new Error("GitHub returned malformed or missing JSON."); }
}

function abort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("GitHub request was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

/** Read one bounded REST or GraphQL response from github.com through gh. */
export async function readGitHubJson(endpoint: string, options: GitHubJsonOptions = {}): Promise<GitHubRemoteRead<unknown>> {
  validateOptions(options);
  const path = endpointPath(endpoint);
  const graphQL = path === "/graphql";
  requireValue(graphQL ? options.query !== undefined && options.validators === undefined : options.query === undefined, "API request type");
  abort(options.signal);

  const args = ["api", graphQL ? "graphql" : path, "--hostname", "github.com", "--method", graphQL ? "POST" : "GET", "--include"];
  for (const field of options.fields ?? []) args.push("-F", field);
  if (graphQL) args.push("-F", `query=${options.query}`);
  const validators = options.validators === undefined ? undefined : validateValidators(options.validators);
  if (!graphQL && validators?.etag) args.push("-H", `If-None-Match: ${validators.etag}`);
  else if (!graphQL && validators?.lastModified) args.push("-H", `If-Modified-Since: ${validators.lastModified}`);
  if (options.projection) args.push("--jq", options.projection);

  let output: string;
  try { output = await runGh(args, options.signal, options.maxOutputBytes); }
  catch (error) {
    abort(options.signal);
    if (error instanceof GitHubRequestError && error.httpStatus === 304 && validators && Object.keys(validators).length > 0) {
      return { status: "not_modified", validators };
    }
    throw error;
  }
  abort(options.signal);
  const response = parseResponse(output);
  const freshValidators = responseValidators(response.headers);
  if (response.status === 304) {
    requireValue(!graphQL && validators !== undefined && Object.keys(validators).length > 0, "unsolicited HTTP 304 response");
    return { status: "not_modified", validators: { ...validators, ...freshValidators } };
  }
  if (response.status !== 200) {
    throw new GitHubRequestError(`GitHub ${graphQL ? "GraphQL POST" : "GET"} returned HTTP ${response.status}, not 200.`, response.status);
  }
  return { status: "ok", value: parseJson(response.body), validators: freshValidators };
}

const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;

/** Return the authenticated GitHub login after validating /user. */
export async function readGitHubAccount(signal?: AbortSignal): Promise<string> {
  const response = await readGitHubJson("/user", { signal, projection: "{login}" });
  requireValue(response.status === "ok" && record(response.value), "authenticated user response");
  requireValue(typeof response.value.login === "string" && LOGIN_PATTERN.test(response.value.login), "authenticated user login");
  return response.value.login;
}
