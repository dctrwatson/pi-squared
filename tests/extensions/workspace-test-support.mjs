import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  WorkspaceService,
  parseCommandWords,
  parseNewWorkspace,
  parseWorkspaceMerge,
  parseWorkspaceTarget,
} from "../../extensions/workspace/core.ts";
import { GitRepository } from "../../extensions/workspace/git.ts";
import { NodeProcessRunner } from "../../extensions/workspace/process.ts";
import { stableHash } from "../../extensions/workspace/state.ts";
import { PiSessionStore, workspaceMetadata } from "../../extensions/workspace/sessions.ts";
import { formatWorkspaceList, parseLauncherArguments, resolveLaunch, validateForwardedPiArguments } from "../../extensions/workspace/launcher.ts";
import workspaceExtension, { CREATE_WORKSPACE_TOOL, WORKSPACE_MERGE_FINALIZE_TOOL, WORKSPACE_PM_SKILL_PATH, handleWorkspace, picker, staleWorkspaceTarget } from "../../extensions/workspace/index.ts";

const WORKSPACE_HELP_TEXT = `Usage: /workspace or /ws [target] [--worktree]
       /workspace or /ws new
       /workspace or /ws new <branch> [--from <ref|current>] [--worktree]
       /workspace or /ws merge <base-branch> [--squash]
       /workspace or /ws prune

No argument: Open the workspace picker.
target: Local branch, pull request number, or GitHub pull request URL.
branch:<name>: Force a local branch target.
new: Start a fresh session for the current branch, or create a branch workspace.
--from: Select the new branch base; current uses the current commit.
--worktree: Use a managed worktree.
merge: Prepare, merge, and remove the current managed workspace.
--squash: Create one commit on the base branch.
prune: Remove inactive managed workspaces.
--help, -h: Show this help.`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitSucceeds(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status === 0;
}

const repositoryTemplate = await mkdtemp(join(tmpdir(), "pi-workspace-template-"));
git(repositoryTemplate, "init", "-b", "main");
git(repositoryTemplate, "config", "user.email", "tests@example.invalid");
git(repositoryTemplate, "config", "user.name", "Workspace Tests");
await writeFile(join(repositoryTemplate, "README.md"), "base\n");
git(repositoryTemplate, "add", "README.md");
git(repositoryTemplate, "commit", "-m", "base");
test.after(() => rm(repositoryTemplate, { recursive: true, force: true }));

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-"));
  await cp(repositoryTemplate, root, { recursive: true });
  return root;
}

async function removeRepository(root) {
  await rm(root, { recursive: true, force: true });
}

function samePr(left, right) {
  if (!left || !right) return left === right;
  return left.number === right.number
    && left.url.toLowerCase() === right.url.toLowerCase()
    && left.baseRepository.toLowerCase() === right.baseRepository.toLowerCase()
    && left.headRepository.toLowerCase() === right.headRepository.toLowerCase()
    && left.headRef === right.headRef;
}

class FakeSessions {
  constructor(root) {
    this.root = join(root, ".git", "test-sessions");
    this.entries = new Map();
    this.forks = [];
    this.binds = [];
    this.sequence = 0;
  }

  async create(metadata) {
    const path = join(this.root, "sessions", `${++this.sequence}.jsonl`);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, [
      JSON.stringify({ type: "session", version: 3, id: `test-${this.sequence}`, timestamp: new Date().toISOString(), cwd: metadata.cwd }),
      JSON.stringify({ type: "custom", id: `metadata-${this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata }),
      "",
    ].join("\n"));
    this.entries.set(path, metadata);
    return path;
  }

  async createLegacy(metadata) {
    const path = join(this.root, "sessions", `${++this.sequence}.jsonl`);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: `test-${this.sequence}`, timestamp: new Date().toISOString(), cwd: metadata.cwd })}\n`);
    this.entries.set(path, undefined);
    return path;
  }

  async fork(source, metadata) {
    this.forks.push({ source, metadata });
    return this.create(metadata);
  }

  async bind(path, metadata) {
    this.binds.push({ path, metadata });
    if (!this.entries.has(path)) return false;
    this.entries.set(path, metadata);
    await writeFile(path, `${JSON.stringify({ type: "custom", id: `metadata-${++this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata })}\n`, { flag: "a" });
    return this.validate(path, metadata);
  }

  async rebind(path, metadata) {
    if (!this.entries.has(path)) return false;
    this.entries.set(path, metadata);
    await writeFile(path, `${JSON.stringify({ type: "custom", id: `metadata-${++this.sequence}`, parentId: null, timestamp: new Date().toISOString(), customType: "pi-workspace", data: metadata })}\n`, { flag: "a" });
    return this.validate(path, metadata);
  }

  async validate(path, metadata) {
    const entry = this.entries.get(path);
    return entry?.repository === metadata.repository
      && entry.branch === metadata.branch
      && resolve(entry.cwd) === resolve(metadata.cwd)
      && samePr(entry.pr, metadata.pr);
  }
}

function switcher(calls, cancelled = false) {
  return async (session) => {
    calls.push(session);
    return { cancelled };
  };
}

async function mapWorkspace(service, sessions, branch, cwd, pr) {
  const state = await service.state();
  const paths = await service.git.paths();
  const mappedCwd = await realpath(cwd);
  const session = await sessions.create({ repository: paths.commonDir, branch, cwd: mappedCwd, ...(pr ? { pr } : {}) });
  const record = {
    version: 2,
    repository: paths.commonDir,
    branch,
    session,
    cwd: mappedCwd,
    ...(pr ? { pr } : {}),
    updatedAt: new Date().toISOString(),
  };
  await state.putWorkspace(record);
  await state.putLast(record);
  return { state, record };
}

export {
  test,
  assert,
  execFileSync,
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  hostname,
  join,
  resolve,
  WorkspaceService,
  GitRepository,
  NodeProcessRunner,
  workspaceMetadata,
  resolveLaunch,
  staleWorkspaceTarget,
  git,
  gitSucceeds,
  repository,
  removeRepository,
  FakeSessions,
  switcher,
  mapWorkspace,
  mkdtemp,
  tmpdir,
  dirname,
  parseCommandWords,
  parseNewWorkspace,
  parseWorkspaceMerge,
  parseWorkspaceTarget,
  stableHash,
  parseLauncherArguments,
  formatWorkspaceList,
  workspaceExtension,
  CREATE_WORKSPACE_TOOL,
  WORKSPACE_MERGE_FINALIZE_TOOL,
  handleWorkspace,
  WORKSPACE_HELP_TEXT,
  spawnSync,
  utimes,
  picker,
  spawn,
  PiSessionStore,
  validateForwardedPiArguments,
  WORKSPACE_PM_SKILL_PATH,
};
