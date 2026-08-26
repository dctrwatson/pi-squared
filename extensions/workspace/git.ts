import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { NodeProcessRunner, type ProcessRunner, WorkspaceError, conciseProcessError } from "./process.ts";
import type { Worktree } from "./types.ts";

export interface RepositoryPaths {
    commonDir: string;
    primaryCwd: string;
    currentCwd: string;
}

async function existingPath(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

export async function canonicalPath(path: string): Promise<string> {
    const absolute = resolve(path);
    try {
        return await realpath(absolute);
    } catch {
        return absolute;
    }
}

export class GitRepository {
    readonly runner: ProcessRunner;
    readonly cwd: string;

    constructor(cwd: string, runner: ProcessRunner = new NodeProcessRunner()) {
        this.cwd = cwd;
        this.runner = runner;
    }

    async run(args: string[], cwd = this.cwd): Promise<string> {
        const result = await this.runner.run("git", args, { cwd });
        if (result.code !== 0) throw conciseProcessError("git", args, result);
        return result.stdout.trim();
    }

    async tryRun(args: string[], cwd = this.cwd): Promise<{ ok: boolean; stdout: string; stderr: string }> {
        const result = await this.runner.run("git", args, { cwd });
        return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
    }

    async writeBlob(content: string): Promise<string> {
        const result = await this.runner.run("git", ["hash-object", "-w", "--stdin"], { cwd: this.cwd, stdin: content });
        if (result.code !== 0 || !/^[0-9a-f]+$/i.test(result.stdout.trim())) {
            throw conciseProcessError("git", ["hash-object"], result);
        }
        return result.stdout.trim();
    }

    async readBlob(oid: string): Promise<string | undefined> {
        const result = await this.tryRun(["cat-file", "-p", oid]);
        return result.ok ? result.stdout : undefined;
    }

    async refOid(ref: string): Promise<string | undefined> {
        const result = await this.tryRun(["rev-parse", "--verify", "--quiet", ref]);
        return result.ok && /^[0-9a-f]+$/i.test(result.stdout.trim()) ? result.stdout.trim() : undefined;
    }

    async updateRef(ref: string, value: string | undefined, oldValue: string): Promise<boolean> {
        const args = value === undefined
            ? ["update-ref", "--no-deref", "-d", ref, oldValue]
            : ["update-ref", "--no-deref", ref, value, oldValue];
        return (await this.tryRun(args)).ok;
    }

    async paths(): Promise<RepositoryPaths> {
        const topLevel = await this.run(["rev-parse", "--show-toplevel"]);
        const formattedCommonDir = await this.tryRun(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        const commonDirValue = formattedCommonDir.ok
            ? formattedCommonDir.stdout.trim()
            : await this.run(["rev-parse", "--git-common-dir"]);
        const worktrees = await this.worktrees();
        const primary = worktrees[0];
        if (!primary) throw new WorkspaceError("Git did not report a primary checkout");
        return {
            commonDir: await canonicalPath(resolve(topLevel, commonDirValue)),
            primaryCwd: await canonicalPath(primary.cwd),
            currentCwd: await canonicalPath(topLevel),
        };
    }

    async branch(cwd = this.cwd): Promise<string> {
        const result = await this.tryRun(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
        if (!result.ok || !result.stdout.trim()) throw new WorkspaceError("Workspace commands require a checked out branch");
        return result.stdout.trim();
    }

    async branchOid(cwd = this.cwd): Promise<string> {
        return this.run(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
    }

    async localBranchOid(branch: string): Promise<string | undefined> {
        return this.refOid(`refs/heads/${branch}`);
    }

    private async localRefNames(prefixes: readonly string[]): Promise<string[]> {
        const result = await this.tryRun(["for-each-ref", "--format=%(refname:short)", ...prefixes]);
        if (!result.ok) throw new WorkspaceError("Could not list local Git refs");
        return [...new Set(result.stdout.split("\n").map((ref) => ref.trim()).filter(Boolean))].sort();
    }

    async localBranches(): Promise<string[]> {
        return this.localRefNames(["refs/heads"]);
    }

    async localRefs(): Promise<string[]> {
        return this.localRefNames(["refs/heads", "refs/tags"]);
    }

    async localBranchForRef(ref: string, cwd = this.cwd): Promise<string | undefined> {
        const result = await this.tryRun(["rev-parse", "--symbolic-full-name", ref], cwd);
        const resolved = result.ok ? result.stdout.trim() : "";
        return resolved.startsWith("refs/heads/") ? resolved.slice("refs/heads/".length) : undefined;
    }

    async remoteForBranch(branch: string): Promise<string | undefined> {
        const configured = await this.tryRun(["config", "--local", "--get", `branch.${branch}.remote`]);
        if (configured.ok && configured.stdout.trim()) return configured.stdout.trim() === "." ? undefined : configured.stdout.trim();
        const remotes = (await this.run(["remote"]))
            .split("\n")
            .map((remote) => remote.trim())
            .filter(Boolean);
        if (remotes.includes("origin")) return "origin";
        return remotes.length === 1 ? remotes[0] : undefined;
    }

    async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
        const args = ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`];
        const result = await this.runner.run("git", args, { cwd: this.cwd });
        if (result.code === 0) return true;
        if (result.code === 2) return false;
        throw conciseProcessError("git", args, result);
    }

    async hasCommit(oid: string): Promise<boolean> {
        return (await this.tryRun(["cat-file", "-e", `${oid}^{commit}`])).ok;
    }

    async fetchCommit(repository: string, oid: string): Promise<void> {
        await this.run(["fetch", "--no-tags", repository, oid]);
        if (!await this.hasCommit(oid)) throw new WorkspaceError("Could not obtain the pull request head commit");
    }

    async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
        return (await this.tryRun(["merge-base", "--is-ancestor", ancestor, descendant])).ok;
    }

    async mergeBase(left: string, right: string): Promise<string | undefined> {
        const result = await this.tryRun(["merge-base", left, right]);
        const oid = result.stdout.trim();
        return result.ok && /^[0-9a-f]+$/i.test(oid) ? oid : undefined;
    }

    private async patchId(patch: string): Promise<string | undefined> {
        if (!patch.trim()) return undefined;
        const result = await this.runner.run("git", ["patch-id", "--stable"], { cwd: this.cwd, stdin: patch });
        if (result.code !== 0) throw conciseProcessError("git", ["patch-id"], result);
        const oid = result.stdout.trim().split(/\s+/, 1)[0] ?? "";
        return /^[0-9a-f]+$/i.test(oid) ? oid : undefined;
    }

    private async rangePatch(base: string, tip: string): Promise<string> {
        const result = await this.runner.run("git", ["diff", "--binary", base, tip], { cwd: this.cwd });
        if (result.code !== 0) throw conciseProcessError("git", ["diff"], result);
        return result.stdout;
    }

    async rangePatchId(base: string, tip: string): Promise<string | undefined> {
        return this.patchId(await this.rangePatch(base, tip));
    }

    private async patchIsPresentInTree(patch: string, tree: string): Promise<boolean> {
        const directory = await mkdtemp(join(tmpdir(), "pi-workspace-index-"));
        const index = join(directory, "index");
        const env = { GIT_INDEX_FILE: index };
        try {
            const readTree = await this.runner.run("git", ["read-tree", tree], { cwd: this.cwd, env });
            if (readTree.code !== 0) throw conciseProcessError("git", ["read-tree"], readTree);
            const apply = await this.runner.run("git", ["apply", "--cached", "--reverse", "--check"], {
                cwd: this.cwd,
                env,
                stdin: patch,
            });
            return apply.code === 0;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    async commitPatchId(commit: string): Promise<string | undefined> {
        const result = await this.runner.run("git", ["show", "--format=", "--binary", commit], { cwd: this.cwd });
        if (result.code !== 0) throw conciseProcessError("git", ["show"], result);
        return this.patchId(result.stdout);
    }

    async commitsBetween(base: string, tip: string): Promise<string[]> {
        const output = await this.run(["rev-list", "--first-parent", `${base}..${tip}`]);
        return output.split("\n").map((oid) => oid.trim()).filter(Boolean);
    }

    async integrationIntoBase(source: string, base: string): Promise<"ancestor" | "squash" | undefined> {
        if (await this.isAncestor(source, base)) return "ancestor";
        const fork = await this.mergeBase(source, base);
        if (!fork) return undefined;
        const patch = await this.rangePatch(fork, source);
        const sourcePatch = await this.patchId(patch);
        if (!sourcePatch) return undefined;
        for (const commit of await this.commitsBetween(fork, base)) {
            if (await this.commitPatchId(commit) === sourcePatch) {
                return await this.patchIsPresentInTree(patch, base) ? "squash" : undefined;
            }
        }
        return undefined;
    }

    async fastForward(cwd: string, oid: string): Promise<void> {
        await this.run(["merge", "--ff-only", oid], cwd);
    }

    async resetHard(cwd: string, oid: string): Promise<void> {
        await this.run(["reset", "--hard", oid], cwd);
    }

    async updateBranch(branch: string, oid: string, previousOid: string): Promise<void> {
        if (!await this.updateRef(`refs/heads/${branch}`, oid, previousOid)) {
            throw new WorkspaceError(`Could not update branch ${branch}`);
        }
    }

    async worktrees(): Promise<Worktree[]> {
        const output = await this.run(["worktree", "list", "--porcelain"]);
        const records: Worktree[] = [];
        let cwd: string | undefined;
        let branch: string | undefined;
        let detached = false;
        const flush = () => {
            if (!cwd) return;
            records.push({ cwd, branch, detached });
            cwd = undefined;
            branch = undefined;
            detached = false;
        };
        for (const line of output.split("\n")) {
            if (!line) {
                flush();
                continue;
            }
            if (line.startsWith("worktree ")) cwd = line.slice("worktree ".length);
            else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
            else if (line === "detached") detached = true;
        }
        flush();
        return Promise.all(records.map(async (record) => ({ ...record, cwd: await canonicalPath(record.cwd) })));
    }

    async findWorktree(branch: string): Promise<Worktree | undefined> {
        return (await this.worktrees()).find((worktree) => worktree.branch === branch);
    }

    async isManagedWorktree(cwd: string): Promise<boolean> {
        const [resolved, paths] = await Promise.all([canonicalPath(cwd), this.paths()]);
        const root = resolve(paths.primaryCwd, ".ws");
        return basename(resolved) === "src" && dirname(dirname(resolved)) === root;
    }

    async excludeWorkspaceRoot(commonDir: string): Promise<void> {
        const path = join(commonDir, "info", "exclude");
        let content = "";
        try {
            content = await readFile(path, "utf8");
        } catch {
            // The file is created below.
        }
        if (content.split(/\r?\n/).includes("/.ws/")) return;
        await mkdir(dirname(path), { recursive: true });
        const separator = content && !content.endsWith("\n") ? "\n" : "";
        await writeFile(path, `${content}${separator}/.ws/\n`);
    }

    async assertClean(cwd: string): Promise<void> {
        const status = await this.run([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ], cwd);
        if (status) throw new WorkspaceError("Refusing to change a checkout with staged, unstaged, or untracked files");

        const submodules = await this.tryRun(["submodule", "status", "--recursive"], cwd);
        if (submodules.ok && submodules.stdout.split("\n").some((line) => line.startsWith("+") || line.startsWith("U"))) {
            throw new WorkspaceError("Refusing to change a checkout with a dirty submodule");
        }

        for (const path of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
            const gitPath = await this.tryRun(["rev-parse", "--git-path", path], cwd);
            if (gitPath.ok && await existingPath(resolve(cwd, gitPath.stdout.trim()))) {
                throw new WorkspaceError("Refusing to change a checkout during a merge or rebase");
            }
        }
        for (const path of ["rebase-apply", "rebase-merge"]) {
            const gitPath = await this.tryRun(["rev-parse", "--git-path", path], cwd);
            if (gitPath.ok && await existingPath(resolve(cwd, gitPath.stdout.trim()))) {
                throw new WorkspaceError("Refusing to change a checkout during a merge or rebase");
            }
        }
    }

    async assertLocalBranch(branch: string): Promise<void> {
        const result = await this.tryRun(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (!result.ok) throw new WorkspaceError(`Local branch does not exist: ${branch}`);
    }

    async assertRef(ref: string): Promise<string> {
        const result = await this.tryRun(["rev-parse", "--verify", `${ref}^{commit}`]);
        if (!result.ok) throw new WorkspaceError(`Ref does not resolve to a commit: ${ref}`);
        return result.stdout.trim();
    }

    async assertNewBranch(branch: string): Promise<void> {
        const valid = await this.tryRun(["check-ref-format", "--branch", branch]);
        if (!valid.ok) throw new WorkspaceError(`Invalid branch name: ${branch}`);
        const exists = await this.tryRun(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (exists.ok) throw new WorkspaceError(`Branch already exists: ${branch}`);
    }

    async checkout(branch: string, cwd: string): Promise<void> {
        const current = await this.branch(cwd);
        if (current === branch) return;
        const occupied = await this.findWorktree(branch);
        const target = await canonicalPath(cwd);
        if (occupied && occupied.cwd !== target) {
            throw new WorkspaceError(`Branch ${branch} is already checked out in another worktree`);
        }
        await this.assertClean(cwd);
        await this.run(["checkout", branch], cwd);
    }

    async detach(cwd: string, oid: string): Promise<void> {
        await this.run(["checkout", "--detach", oid], cwd);
    }

    async createBranch(branch: string, from: string, cwd: string): Promise<void> {
        await this.assertNewBranch(branch);
        await this.assertClean(cwd);
        await this.run(["checkout", "-b", branch, from], cwd);
    }

    async addWorktree(path: string, branch: string, from?: string): Promise<void> {
        if (await existingPath(path)) throw new WorkspaceError("Managed worktree path already exists and is not reusable");
        await mkdir(dirname(path), { recursive: true });
        const args = from ? ["worktree", "add", "-b", branch, path, from] : ["worktree", "add", path, branch];
        await this.run(args);
    }

    async addDetachedWorktree(path: string, from: string): Promise<void> {
        if (await existingPath(path)) throw new WorkspaceError("Managed worktree path already exists and is not reusable");
        await mkdir(dirname(path), { recursive: true });
        await this.run(["worktree", "add", "--detach", path, from]);
    }

    async initializeWorkspacePm(path: string, externalPm?: string): Promise<void> {
        if (await existingPath(path)) throw new WorkspaceError("Managed workspace PM path already exists and is not reusable");
        if (!externalPm) {
            await this.run(["init", "--quiet", path]);
            return;
        }
        const requested = await canonicalPath(externalPm);
        const topLevel = await this.tryRun(["rev-parse", "--show-toplevel"], requested);
        if (!topLevel.ok || !topLevel.stdout.trim()) throw new WorkspaceError(`PM path is not a Git worktree: ${requested}`);
        const target = await canonicalPath(topLevel.stdout.trim());
        if (target !== requested) throw new WorkspaceError(`PM path must be a Git worktree root: ${requested}`);
        await symlink(target, path, "dir");
    }

    async removeWorktree(path: string): Promise<void> {
        await this.run(["worktree", "remove", path]);
    }

    async removeWorktreeForce(path: string): Promise<void> {
        await this.run(["worktree", "remove", "--force", path]);
    }

    async removeBranchConfig(branch: string): Promise<void> {
        const result = await this.tryRun(["config", "--local", "--remove-section", `branch.${branch}`]);
        if (!result.ok && result.stderr.trim() && !/no such section/i.test(result.stderr)) {
            throw conciseProcessError("git", ["config"], { stdout: result.stdout, stderr: result.stderr, code: 1 });
        }
    }

    async deleteBranch(branch: string): Promise<void> {
        const result = await this.tryRun(["branch", "-d", branch]);
        if (!result.ok) throw conciseProcessError("git", ["branch"], { stdout: result.stdout, stderr: result.stderr, code: 1 });
    }
}
