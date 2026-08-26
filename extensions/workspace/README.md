# Workspace extension

Use this extension to bind a Git branch to one Pi session. A workspace can also have a pull request and a managed Git worktree.

Install this package as a global Pi package. Put `bin/piw` on your `PATH`. The launcher requires the workspace extension.

## Commands

- `/workspace` and `/ws` open the local workspace picker.
- `/ws <branch>` switches to a local branch workspace.
- `/ws branch:<branch>` forces a local branch target. Use it for a branch named `new`, `prune`, or a pull request number.
- `/ws <number>`, `/ws #<number>`, and `/ws <pull-request-url>` open a GitHub pull request workspace. URLs can end in `/files`, `/commits`, `/checks`, or `/conversation`.
- `/ws <target> --worktree` and `/ws --worktree <target>` use a managed worktree when the target is not already in one.
- `/ws --worktree` promotes the clean, non-`main` primary workspace into a managed worktree. Pi forks its session for the new working directory.
- `/ws new` starts a fresh Pi session and binds it to the current branch workspace. It replaces the branch's saved workspace-session binding.
- `/ws new <branch>` creates a branch workspace.
- `/ws new <branch> --from <ref>` selects the base ref. Use `--from current` to use the current commit.
- `/ws new <branch> --worktree` creates the branch in a managed worktree and switches the current Pi session.
- `/ws merge <base-branch>` asks Pi to group the work into logical commits, run checks, fast-forward the base branch, and remove the managed workspace.
- `/ws merge <base-branch> --squash` creates one commit on the base branch before it removes the managed workspace.
- `/ws prune` removes inactive managed workspaces when their remote branch no longer exists or their work is integrated into the recorded local base branch.
- `launch_pi` starts interactive Pi for a workspace in a new Ghostty tab. It runs `piw` in the selected directory with the supplied initial prompt.

Run `/workspace --help` or `/ws -h` to show runtime syntax. Both aliases accept either exact help flag. Help does not open the picker. Argument completion offers `new`, `merge`, `prune`, and `--worktree`. It also offers local branch and known pull request targets, valid `new` and `merge` options, and local `--from` refs. Type `branch:` to complete an explicit local branch target. Completion uses local Git and workspace state only.

Without `--from`, `/ws new <branch>` and `piw new <branch>` use only `refs/heads/main`. They fail when that local branch is absent. They do not fetch or use `origin/main`. The workspace records the local base branch and its initial commit for merge checks.

`/ws merge` is an agent workflow. Pi reviews the source work and commits it in logical groups. For the default mode, Pi rebases the source when necessary and the finalizer uses a fast-forward merge. With `--squash`, the finalizer creates the squash commit in a temporary worktree. Before it merges, the finalizer asks for confirmation. Pi saves recovery refs and cleanup state, merges the base, and requests shutdown. During shutdown, it removes the source worktree, PM repository, workspace binding, lease, local source branch, and recovery state. It preserves the Pi session file. If Pi exits before cleanup starts, run `/ws merge <base-branch>` again from the source workspace to resume it. The base branch must be clean and checked out in the primary checkout.

The picker reads local Git, session, and lease state only. It does not call `gh`. Active workspaces are shown in a status message and are not choices. A stale pull request row tells you to run `/ws #N`. That explicit command can contact GitHub to repair the workspace.

## Launcher

```bash
piw                         # Use the branch in this checkout
piw feature/example         # Use a branch workspace
piw '#123'                  # Use a pull request workspace
piw --worktree feature/example
piw new feature/example --worktree
piw new feature/example --from current --worktree
piw prune                   # Remove workspaces for deleted remote branches
piw -- --model anthropic/claude-sonnet-4-5
```

Put Pi arguments after `--`. `piw` rejects forwarded session and extension-disable options. `piw new <branch>` creates a branch workspace. Add `--worktree` to create it in a managed worktree. Bare `piw` uses the branch checked out in its current directory. Run `piw` from any repository path to resume that branch workspace. A plain `pi` session remains independent and does not change workspace bindings unless you run `/ws`. After validation and registration, a workspace session requests active observational memory when that extension is installed.

An explicit PR command can contact GitHub. If its trusted local branch differs from the current PR head, use `/ws #N` in Pi to choose one of these actions:

- Keep local commits.
- Fast-forward when Git can fast-forward.
- Reset to the PR head after a clean check and confirmation. The extension creates a recovery ref first.
- Cancel.

Noninteractive `piw <PR>` fails when this choice is needed. It does not reset the branch.

## Storage and safety

Pi keeps session files in its normal session directory. New, forked, and bound sessions without a user name use the branch name as their display name. A user-defined name is preserved.

The extension stores only these workspace keys in shared local Git config:

- `branch.<branch>.pi-workspace-session` is the central session path.
- `branch.<branch>.pi-workspace-pr` is the canonical PR URL when the branch is bound.
- `branch.<branch>.pi-workspace-base` is the local base branch when it is known.
- `branch.<branch>.pi-workspace-base-oid` is the base commit at workspace creation.
- `branch.<branch>.pi-workspace-merge-cleanup` is temporary recovery state after a workspace merge.
- `pi-workspace.last` is the last branch name.

Session headers and `pi-workspace` custom session metadata contain the detailed workspace validation data. Git branch rename moves branch-scoped config bindings. Lease names use the central session path, so a rename keeps its live lease. Managed worktrees are at `<repo>/.ws/<12-character-branch-hash>/src`. The extension initializes an empty Git repository at the sibling `pm` path for durable project records. While its workspace is active, the `workspace-pm` skill is available for plans, tasks, decisions, and related records. It adds `/.ws/` to `.git/info/exclude`. Lease files remain below `<git-common-dir>/pi-workspaces/.state`. A private Git ref provides the operation lock.

`/ws prune` and `piw prune` first check the recorded local base branch. They recognize a normal merge by Git ancestry. They recognize an exact squash merge by comparing the complete source patch with commits on the base branch. If local integration is not proven, they use `git ls-remote` to check each managed branch. They use its configured remote, `origin`, or the only configured remote. They skip active or dirty workspaces when neither local integration nor remote deletion is proven. Pruning removes the `src` worktree, its sibling `pm` repository, and the workspace binding. It preserves the local branch and Pi session.

`git clean -ffdx` can remove ignored `.ws` workspaces. Do not run it when you need those workspaces.

The extension validates session cwd and workspace metadata before reuse. It adds workspace metadata to active Pi sessions before it maps them. A live lease prevents another process from changing the same checkout, including serial primary workspaces. It can repair a stale branch session mapping when its checkout is usable.

The extension refuses branch changes when the target checkout has staged, unstaged, untracked, dirty-submodule, merge, or rebase state. It does not stash. It does not reset a trusted PR branch without the explicit reset action. It uses `gh pr view` and `gh pr checkout` only for explicit pull request targets. GitHub CLI authentication and normal GitHub CLI behavior still apply.

## Limits

The extension supports macOS and Linux. `launch_pi` requires macOS and Ghostty. `/ws` requires Pi TUI mode. It requires Git. It requires GitHub CLI only for explicit pull request targets. It cannot recover a lease when it cannot prove that the recorded local process has ended. Remove such state only after you verify that no Pi session owns the workspace.
