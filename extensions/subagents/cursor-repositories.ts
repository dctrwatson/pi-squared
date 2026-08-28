import { spawn } from "node:child_process";
import { SubagentBackendError } from "./backend.ts";
import type { CursorSdkGateway } from "./cursor-sdk.ts";

export const MAX_CURSOR_REPOSITORIES = 20;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const GIT_REF_PATTERN = /^[^\u0000-\u001f\u007f\s~^:?*\[\\]+$/;

/** True only for an exact Git object ID that Cursor can use as a pinned ref. */
export function isCursorCommitSha(value: string): boolean {
    return GIT_SHA_PATTERN.test(value);
}

export interface CursorRepository {
    readonly url: string;
    readonly startingRef?: string;
}

export interface CursorPrimaryRepository extends CursorRepository {
    readonly startingRef: string;
    readonly root: string;
    readonly remote: string;
    readonly head: string;
    /** Local remote-tracking data contains HEAD. The SDK creation remains authoritative. */
    readonly remoteHeadKnown: boolean;
    readonly dirty: boolean;
    readonly warnings: readonly string[];
}

export interface GitCommandResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** Run Git commands without a shell. */
export interface GitCommandPort {
    run(cwd: string, args: readonly string[]): Promise<GitCommandResult>;
}

function appendBounded(chunks: Buffer[], currentBytes: number, data: Buffer): number {
    if (currentBytes >= MAX_GIT_OUTPUT_BYTES) return currentBytes;
    const remaining = MAX_GIT_OUTPUT_BYTES - currentBytes;
    chunks.push(data.subarray(0, remaining));
    return currentBytes + Math.min(data.length, remaining);
}

/** Default Git port. It only captures bounded output and does not use a shell. */
export const systemGitCommandPort: GitCommandPort = {
    async run(cwd, args) {
        return new Promise((resolve) => {
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;
            const finish = (exitCode: number | null) => {
                if (settled) return;
                settled = true;
                resolve({
                    exitCode,
                    stdout: Buffer.concat(stdout).toString("utf8"),
                    stderr: Buffer.concat(stderr).toString("utf8"),
                });
            };
            let child;
            try {
                child = spawn("git", [...args], {
                    cwd,
                    shell: false,
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch {
                finish(null);
                return;
            }
            child.stdout.on("data", (data: Buffer) => { stdoutBytes = appendBounded(stdout, stdoutBytes, data); });
            child.stderr.on("data", (data: Buffer) => { stderrBytes = appendBounded(stderr, stderrBytes, data); });
            child.once("error", () => finish(null));
            child.once("close", (code) => finish(code));
        });
    },
};

function trimOutput(result: GitCommandResult): string {
    return result.stdout.trim();
}

async function gitOutput(port: GitCommandPort, cwd: string, args: readonly string[]): Promise<string | undefined> {
    const result = await port.run(cwd, args);
    return result.exitCode === 0 ? trimOutput(result) : undefined;
}

function gitPrecondition(message: string): SubagentBackendError {
    return new SubagentBackendError("GIT_PRECONDITION", message, "cursor-cloud");
}

function normalizePathSegment(value: string): string | undefined {
    return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== ".." ? value : undefined;
}

/** Normalize a supported GitHub SSH or HTTPS repository URL. */
export function normalizeCursorGitHubUrl(value: string, field = "repository URL"): string {
    const scpMatch = value.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
    if (scpMatch) {
        const owner = normalizePathSegment(scpMatch[1] ?? "");
        const repository = normalizePathSegment(scpMatch[2] ?? "");
        if (owner && repository) return `https://github.com/${owner}/${repository}`;
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${field} must be a supported GitHub repository URL`);
    }
    const pathMatch = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    const owner = normalizePathSegment(pathMatch?.[1] ?? "");
    const repository = normalizePathSegment(pathMatch?.[2] ?? "");
    const https = parsed.protocol === "https:" && !parsed.username && !parsed.password;
    const ssh = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
    if ((https || ssh)
        && parsed.hostname.toLowerCase() === "github.com"
        && !parsed.port
        && !parsed.search
        && !parsed.hash
        && !value.includes("?")
        && !value.includes("#")
        && owner && repository) {
        return `https://github.com/${owner}/${repository}`;
    }
    throw new Error(`${field} must be a credential-free GitHub repository URL without a query or fragment`);
}

/** Validate a Git branch name or exact commit ref supplied to Cursor. */
export function normalizeCursorStartingRef(value: string, field = "startingRef"): string {
    const ref = value.trim();
    if (!ref || ref.length > 255
        || !GIT_REF_PATTERN.test(ref)
        || ref === "@"
        || ref.startsWith("-")
        || ref.startsWith("/")
        || ref.endsWith("/")
        || ref.includes("..")
        || ref.includes("//")
        || ref.includes("@{")
        || ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
        throw new Error(`invalid ${field}`);
    }
    return GIT_SHA_PATTERN.test(ref) ? ref.toLowerCase() : ref;
}

function repositoryKey(url: string): string {
    return url.toLowerCase();
}

function requireExactCommitSha(value: string, field: string): string {
    const ref = value.trim();
    if (!isCursorCommitSha(ref)) throw gitPrecondition(`${field} must be an exact commit SHA.`);
    return ref.toLowerCase();
}

/**
 * Put the local primary repository first. Supporting explicit refs win over an
 * omitted ref. Two different explicit refs are ambiguous.
 */
export function buildCursorRepositoryList(
    primary: CursorRepository,
    supporting: readonly CursorRepository[] = [],
): CursorRepository[] {
    const primaryUrl = normalizeCursorGitHubUrl(primary.url, "primary repository URL");
    if (!primary.startingRef) throw gitPrecondition("The primary repository requires an exact HEAD startingRef.");
    const primaryRef = requireExactCommitSha(primary.startingRef, "Primary startingRef");
    const repositories = new Map<string, CursorRepository>();
    repositories.set(repositoryKey(primaryUrl), { url: primaryUrl, startingRef: primaryRef });

    for (const [index, input] of supporting.entries()) {
        let url: string;
        let startingRef: string | undefined;
        try {
            url = normalizeCursorGitHubUrl(input.url, `supporting repository ${index + 1} URL`);
            startingRef = input.startingRef === undefined
                ? undefined
                : normalizeCursorStartingRef(input.startingRef, `supporting repository ${index + 1} startingRef`);
        } catch (error) {
            throw gitPrecondition(error instanceof Error ? error.message : "Invalid supporting repository.");
        }
        const key = repositoryKey(url);
        const existing = repositories.get(key);
        if (existing) {
            const primaryDuplicate = key === repositoryKey(primaryUrl);
            if (primaryDuplicate) {
                if (startingRef !== undefined && existing.startingRef !== startingRef) {
                    throw gitPrecondition(`Supporting repository ${index + 1} has a conflicting startingRef for ${url}.`);
                }
                continue;
            }
            if (existing.startingRef && startingRef && existing.startingRef !== startingRef) {
                throw gitPrecondition(`Supporting repository ${index + 1} has a conflicting startingRef for ${url}.`);
            }
            if (!existing.startingRef && startingRef) repositories.set(key, { url, startingRef });
            continue;
        }
        repositories.set(key, { url, ...(startingRef ? { startingRef } : {}) });
    }

    const normalized = [...repositories.values()];
    if (normalized.length > MAX_CURSOR_REPOSITORIES) {
        throw gitPrecondition(`Cursor Cloud supports at most ${MAX_CURSOR_REPOSITORIES} repositories after deduplication.`);
    }
    return normalized;
}

/**
 * Derive the local repository Cursor will inspect. This never fetches, pushes,
 * checks out, merges, or otherwise changes the repository.
 */
export async function detectCursorPrimaryRepository(
    cwd: string,
    git: GitCommandPort = systemGitCommandPort,
): Promise<CursorPrimaryRepository> {
    const root = await gitOutput(git, cwd, ["rev-parse", "--show-toplevel"]);
    if (!root) throw gitPrecondition("Current working directory is not in a Git repository.");
    const head = await gitOutput(git, cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!head || !isCursorCommitSha(head)) {
        throw gitPrecondition("Current Git HEAD is not an exact commit SHA.");
    }

    const branch = await gitOutput(git, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const configuredRemote = branch && GIT_REF_PATTERN.test(branch)
        ? await gitOutput(git, cwd, ["config", "--get", `branch.${branch}.remote`])
        : undefined;
    const remote = configuredRemote?.trim() || "origin";
    if (!remote || remote.startsWith("-") || /[\u0000-\u001f\u007f]/.test(remote)) {
        throw gitPrecondition("The configured Git remote name is invalid.");
    }
    const remoteUrl = await gitOutput(git, cwd, ["remote", "get-url", remote]);
    if (!remoteUrl) throw gitPrecondition("No Git URL is configured for the selected remote.");

    let url: string;
    try {
        url = normalizeCursorGitHubUrl(remoteUrl, "Git remote URL");
    } catch (error) {
        throw gitPrecondition(error instanceof Error ? error.message : "Git remote URL is not supported.");
    }

    const upstream = await gitOutput(git, cwd, ["rev-parse", "--verify", "--quiet", "@{upstream}"]);
    const configuredMerge = branch && GIT_REF_PATTERN.test(branch)
        ? await gitOutput(git, cwd, ["config", "--get", `branch.${branch}.merge`])
        : undefined;
    const mergeBranch = configuredMerge?.match(/^refs\/heads\/(.+)$/)?.[1] ?? branch;
    const trackingRef = !upstream && mergeBranch && GIT_REF_PATTERN.test(mergeBranch)
        ? `refs/remotes/${remote}/${mergeBranch}`
        : undefined;
    const trackingHead = trackingRef
        ? await gitOutput(git, cwd, ["rev-parse", "--verify", "--quiet", trackingRef])
        : undefined;
    const comparison = upstream && isCursorCommitSha(upstream)
        ? "@{upstream}"
        : trackingHead && isCursorCommitSha(trackingHead)
            ? trackingRef
            : undefined;
    let remoteHeadKnown = false;
    if (comparison) {
        const ahead = await gitOutput(git, cwd, ["rev-list", "--count", `${comparison}..HEAD`]);
        if (ahead && /^\d+$/.test(ahead) && Number(ahead) > 0) {
            throw gitPrecondition("Current HEAD has commits that are not pushed to its configured remote branch. Push HEAD before creating a Cursor Cloud subagent.");
        }
        remoteHeadKnown = ahead !== undefined;
    }

    const status = await gitOutput(git, cwd, ["status", "--porcelain=v1", "-z"]);
    const dirty = Boolean(status);
    const warnings = dirty
        ? ["The worktree has local changes. Cursor Cloud sees only the committed HEAD state."]
        : [];
    return {
        url,
        startingRef: head.toLowerCase(),
        root,
        remote,
        head: head.toLowerCase(),
        remoteHeadKnown,
        dirty,
        warnings,
    };
}

/**
 * Cache one connected-repository request for the extension session. Cursor uses
 * this endpoint as a URL-level hint only; run creation remains authoritative.
 */
export class CursorConnectedRepositoryLookup {
    private readonly sdk: Pick<CursorSdkGateway, "listRepositories">;
    private urlsPromise: Promise<readonly string[]> | undefined;

    constructor(sdk: Pick<CursorSdkGateway, "listRepositories">) {
        this.sdk = sdk;
    }

    async list(): Promise<readonly string[]> {
        this.urlsPromise ??= this.load();
        return this.urlsPromise;
    }

    async has(url: string): Promise<boolean> {
        const normalized = normalizeCursorGitHubUrl(url);
        const urls = await this.list();
        return urls.some((candidate) => repositoryKey(candidate) === repositoryKey(normalized));
    }

    private async load(): Promise<readonly string[]> {
        const values = await this.sdk.listRepositories();
        const urls = new Map<string, string>();
        for (const value of values.slice(0, 100)) {
            if (typeof value !== "object" || value === null) continue;
            const url = (value as { url?: unknown }).url;
            if (typeof url !== "string") continue;
            try {
                const normalized = normalizeCursorGitHubUrl(url);
                urls.set(repositoryKey(normalized), normalized);
            } catch {
                // Ignore malformed server data. It is only an optional URL hint.
            }
        }
        return [...urls.values()];
    }
}
