import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CoordinationError, FOLLOWING_FILE, readFollowing, readInbox, readIndex, readProject } from "./coordination.ts";

const exec = promisify(execFile);
const IGNORE_RULE = "/.hari/";
const PAGE_CHARS = 16_000;
const RECORD_PATH = /^(?:PROJECTS\.md|INBOX\.md|FOLLOWING\.md|\.gitignore|projects\/[a-z0-9-]+\/(?:PROJECT\.md|reports\/[a-z0-9-]+\.md))$/;

// Do not let a parent shell redirect a coordination command into another repository/index.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C",
    GIT_AUTHOR_NAME: "Hari", GIT_AUTHOR_EMAIL: "hari@localhost",
    GIT_COMMITTER_NAME: "Hari", GIT_COMMITTER_EMAIL: "hari@localhost",
  };
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
    delete (env as NodeJS.ProcessEnv)[name];
  }
  return env;
}

async function git(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const literalPaths = args[0] === "check-ignore" ? [] : ["--literal-pathspecs"];
  const { stdout } = await exec("git", ["--no-pager", ...literalPaths, "-C", root, ...args], {
    encoding: "utf8", env: gitEnvironment(), signal, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function repositoryRoot(directory: string): Promise<string | undefined> {
  try { return (await git(directory, ["rev-parse", "--show-toplevel"])).trim(); }
  catch (error) {
    if (/not a git repository/.test(String((error as { stderr?: string }).stderr))) return undefined;
    throw error;
  }
}

async function existingAncestor(directory: string): Promise<string> {
  let current = resolve(directory);
  while (!await pathExists(current)) current = dirname(current);
  return realpath(current);
}

function names(output: string): string[] { return output.split("\0").filter(Boolean); }

async function regularRecord(root: string, relativePath: string): Promise<boolean> {
  if (!RECORD_PATH.test(relativePath)) throw new CoordinationError(`Invalid coordination record path: ${relativePath}`);
  let path = root;
  const segments = relativePath.split("/");
  for (let i = 0; i < segments.length; i++) {
    path = join(path, segments[i]);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (i < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new CoordinationError(`Coordination record must use regular files/directories, not symlinks: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

/** Preflight before init writes anything. Existing source repos and nested directories are not adopted. */
export async function preflightCoordinationRepository(directory: string): Promise<void> {
  const root = resolve(directory);
  const ancestor = await existingAncestor(root);
  const top = await repositoryRoot(ancestor);
  if (top && (!await pathExists(root) || await realpath(top) !== await realpath(root))) {
    throw new CoordinationError(`Coordination must have its own Git repository, not a directory inside ${top}`);
  }
  if (!await pathExists(root)) return;
  if (!(await lstat(root)).isDirectory()) throw new CoordinationError(`Coordination directory must be a real directory: ${root}`);
  const entries = await readdir(root);
  if (!entries.includes("PROJECTS.md") && !entries.includes("INBOX.md") && !entries.includes(FOLLOWING_FILE)
    && entries.some(name => ![".git", "projects", ".hari", ".gitignore", ".DS_Store"].includes(name))) {
    throw new CoordinationError("The Prime Radiant location must be empty or contain existing coordination records; unrelated files will not be adopted");
  }
  if (await pathExists(join(root, ".git"))) {
    if (!top || !(await lstat(join(root, ".git"))).isDirectory()) {
      throw new CoordinationError("Coordination requires a valid standalone Git repository, not a linked worktree or uncertain .git entry");
    }
    const tracked = names(await git(root, ["ls-files", "-z"]));
    const foreign = tracked.filter(path => !RECORD_PATH.test(path));
    if (foreign.length) throw new CoordinationError(`Refusing to adopt a repository with non-coordination tracked files: ${foreign.slice(0, 5).join(", ")}`);
    await requireEmptyIndex(root);
  }
  for (const name of ["PROJECTS.md", "INBOX.md", FOLLOWING_FILE, ".gitignore"]) await regularRecord(root, name);
  for (const name of ["projects", ".hari"]) {
    if (await pathExists(join(root, name)) && !(await lstat(join(root, name))).isDirectory()) {
      throw new CoordinationError(`Coordination ${name} must be a real directory`);
    }
  }
  if (await pathExists(join(root, "PROJECTS.md"))) {
    const index = await readIndex(root);
    for (const entry of index.projects) {
      await regularRecord(root, `projects/${entry.id}/PROJECT.md`);
      await readProject(root, entry.id);
    }
  }
  if (await pathExists(join(root, "INBOX.md"))) await readInbox(root);
  await readFollowing(root);
}

async function requireEmptyIndex(root: string): Promise<void> {
  if ((await git(root, ["diff", "--cached", "--name-only", "-z"])).length) {
    throw new CoordinationError("The Prime Radiant has staged changes. They were left untouched; inspect and resolve the existing index before a Hari checkpoint");
  }
}

export async function requireCoordinationRepository(directory: string): Promise<string> {
  let root: string;
  try { root = await realpath(directory); }
  catch { throw new CoordinationError(`Cannot open the Prime Radiant at ${directory}. Restore existing data here if it is missing. For first-time setup, run hari init`); }
  const top = await repositoryRoot(root);
  if (!top || await realpath(top) !== root || !(await lstat(join(root, ".git"))).isDirectory()) {
    throw new CoordinationError("Coordination needs its own local Git repository; run hari init for first-time setup");
  }
  const runtimeTracked = names(await git(root, ["ls-files", "-z", "--", ".hari"]));
  if (runtimeTracked.length) throw new CoordinationError("Runtime/session files under .hari are already tracked. Hari will not commit or untrack them automatically; resolve this explicitly");
  let ignoresRuntime = false;
  if (await regularRecord(root, ".gitignore")) {
    try { ignoresRuntime = Boolean((await git(root, ["check-ignore", "--", ".hari/"])).trim()); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  }
  if (!ignoresRuntime) throw new CoordinationError("The Prime Radiant must ignore /.hari/; run hari init to repair its ignore rule");
  return root;
}

export async function initializeCoordinationRepository(directory: string): Promise<boolean> {
  await preflightCoordinationRepository(directory);
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  if (!await pathExists(join(root, ".git"))) await git(root, ["init", "--initial-branch=main", "--quiet"]);
  const ignorePath = join(root, ".gitignore");
  const previous = await pathExists(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  // Last matching rule wins; keep existing rules and make runtime data unambiguously local.
  if (previous.trimEnd().split(/\r?\n/).at(-1) !== IGNORE_RULE) {
    await writeFile(ignorePath, `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${IGNORE_RULE}\n`, "utf8");
  }
  try { await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]); return false; }
  catch (error) { if ((error as { code?: number }).code === 1) return true; throw error; }
}

async function recordPaths(root: string): Promise<string[]> {
  const index = await readIndex(root);
  await readInbox(root);
  await readFollowing(root);
  const paths = new Set([".gitignore", "PROJECTS.md", "INBOX.md", FOLLOWING_FILE]);
  for (const entry of index.projects) {
    const project = await readProject(root, entry.id);
    paths.add(`projects/${project.id}/PROJECT.md`);
    for (const manager of project.managers) paths.add(`projects/${project.id}/reports/${manager.id}.md`);
  }
  // Include tracked record deletions, but never sweep arbitrary untracked files into a commit.
  const tracked = new Set(names(await git(root, ["ls-files", "-z"])));
  for (const path of tracked) if (RECORD_PATH.test(path)) paths.add(path);
  const selected: string[] = [];
  for (const path of paths) {
    if (!RECORD_PATH.test(path)) throw new CoordinationError(`Invalid coordination record path: ${path}`);
    if (await regularRecord(root, path) || tracked.has(path)) selected.push(path);
  }
  return selected.sort();
}

export type CoordinationGitView = { text: string; nextOffset?: number };

export async function inspectCoordinationGit(
  directory: string,
  action: "status" | "diff" | "history",
  offset = 0,
  signal?: AbortSignal,
): Promise<CoordinationGitView> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CoordinationError("Git view offset must be a non-negative integer");
  const root = await requireCoordinationRepository(directory);
  let text: string;
  if (action === "status") {
    text = await git(root, ["status", "--short", "--branch", "--untracked-files=all"], signal);
    text += "\nOnly Hari's coordination records are eligible for checkpoints. Other untracked files are left alone; .hari conversations, memory, and runtime data stay local and are excluded.\n";
  } else if (action === "history") {
    text = await git(root, ["log", "-20", "--format=%h %ad %s", "--date=iso-strict"], signal);
  } else {
    text = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...await recordPaths(root)], signal);
    text += "\nNew untracked records are not in this diff; inspect them with Hari's record/file reads before committing.\n";
  }
  return {
    text: text.slice(offset, offset + PAGE_CHARS) || "No changes.",
    ...(offset + PAGE_CHARS < text.length ? { nextOffset: offset + PAGE_CHARS } : {}),
  };
}

export async function checkpointCoordination(
  directory: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ commit?: string; changed: boolean }> {
  if (!message.trim() || message.length > 2000) throw new CoordinationError("A concise checkpoint message is required (up to 2000 characters)");
  const root = await requireCoordinationRepository(directory);
  await requireEmptyIndex(root);
  const paths = await recordPaths(root);
  signal?.throwIfAborted();
  if (!(await git(root, ["status", "--porcelain", "--", ...paths], signal)).trim()) return { changed: false };
  try {
    await git(root, ["add", "--all", "--", ...paths], signal);
    // These are unsigned local Prime Radiant checkpoints, not source commits.
    // Do not execute hooks (which may publish) or invoke signing/auth prompts.
    await git(root, ["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "--quiet", "--only", "-m", message.startsWith("hari:") ? message.trim() : `hari: ${message.trim()}`, "--", ...paths], signal);
    return { changed: true, commit: (await git(root, ["rev-parse", "HEAD"])).trim() };
  } catch (error) {
    throw new CoordinationError(`Local checkpoint did not return a confirmed result. Inspect status/history before retrying; files and index were not reset. ${String(error).slice(0, 1500)}`);
  }
}
