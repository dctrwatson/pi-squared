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
- `piw --list` shows locally known workspaces and their status without starting Pi.
- `create_workspace` creates an inactive managed workspace for a new local branch. It returns the source directory for `launch_pi`.
- `launch_pi` starts interactive Pi for a workspace in a new Ghostty tab. It runs `piw` in the selected directory with the supplied initial prompt.

Run `/workspace --help` or `/ws -h` to show runtime syntax. Both aliases accept either exact help flag. Help does not open the picker. Argument completion offers `new`, `merge`, `prune`, and `--worktree`. It also offers local branch and known pull request targets, valid `new` and `merge` options, and local `--from` refs. Type `branch:` to complete an explicit local branch target. Completion uses local Git and workspace state only.

Without `--from`, `/ws new <branch>` and `piw new <branch>` use only `refs/heads/main`. They fail when that local branch is absent. They do not fetch or use `origin/main`. The workspace records the local base branch and its initial commit for merge checks.

`/ws merge` is an agent workflow. Pi reviews the source work and commits it in logical groups. For the default mode, Pi rebases the source when necessary and the finalizer uses a fast-forward merge. With `--squash`, the finalizer creates the squash commit in a temporary worktree. Before it merges, the finalizer asks for confirmation. Pi saves recovery refs and cleanup state, merges the base, and requests shutdown. During shutdown, it removes the source worktree, PM directory or symlink, workspace binding, lease, local source branch, and recovery state. It preserves the Pi session file and an external PM worktree. If Pi exits before cleanup starts, run `/ws merge <base-branch>` again from the source workspace to resume it. The base branch must be clean and checked out in the primary checkout.

The picker reads local Git, session, and lease state only. It does not call `gh`. Active workspaces are shown in a status message and are not choices. A stale pull request row tells you to run `/ws #N`. That explicit command can contact GitHub to repair the workspace.

## Tools

`create_workspace` has these parameters:

- `branch` is the required new local branch name.
- `cwd` is an optional directory in the target repository. It defaults to the current directory.
- `from` is an optional local base ref. It defaults to `main`.
- `pm` is an optional path to the root of an existing PM Git worktree. Relative paths use `cwd`. The tool creates `../pm` as a symlink to that worktree. The symlink is removed with the workspace. Its target is not removed.

The tool always creates an inactive managed workspace, equivalent to `/ws new <branch> --worktree`, and returns its source directory. On macOS, call `launch_pi` with that directory to start its bound Pi session. On Linux, run `piw` in that directory.

## Launcher

```bash
piw                         # Use the branch in this checkout
piw feature/example         # Use a branch workspace
piw '#123'                  # Use a pull request workspace
piw --worktree feature/example
piw new feature/example --worktree
piw new feature/example --from current --worktree
piw prune                   # Remove workspaces for deleted remote branches
piw --list                  # Show local workspace status
piw -- --model anthropic/claude-sonnet-4-5
piw --profile hari feature/example -- --no-extensions -e /path/to/hari
piw --expect-session /absolute/path/to/session.jsonl feature/example
```


### Profile forwarding

Use `piw --profile <name> [workspace options] -- [Pi arguments]` for an explicit resource profile. The name is a label only. It does not load configuration, add Pi arguments, or pass the name to Pi.

The profile lane accepts all normal forwarded Pi arguments. It also accepts `--no-extensions` and `-ne`, so a caller can combine extension discovery disablement with explicit `-e` or `--extension` resources. Use Pi resource controls after `--`, for example `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files`. Ordinary `piw` continues to reject forwarded `--no-extensions` and `-ne`.

`piw` always selects the session. Both lanes reject forwarded `--session`, `--session-id`, `--fork`, `--continue` or `-c`, `--resume` or `-r`, and `--no-session`.

### Strict session resume

Use `--expect-session <path>` only with an explicit local branch target, for example `piw --expect-session /absolute/path/to/session.jsonl feature/example`. It rejects a bare target, a pull request target, and `piw new`.

Before checkout changes, session repair or replacement, and lease acquisition, `piw` resolves the expected path. It requires it to match the local branch workspace binding and validates that session's workspace metadata. It does not bind or rebind the session. Use this option when resumption must not repair or replace a branch binding.

### Programmatic pre-activation validation

`resolveLaunch(args, cwd, { beforeActivate })` provides an optional validation hook. Before it supplies this callback, a caller MUST check `WORKSPACE_LAUNCH_CAPABILITIES.beforeActivate === true`. Do not infer support from the existence of `resolveLaunch`. The hook is available only for an explicit existing local branch that is already checked out at `cwd`. Pi waits for the hook before it changes checkout state, repairs a binding, acquires a lease, or activates a session.

The hook receives `{ branch, cwd, session? }`. `branch` and `cwd` are the explicit prepared binding. `session` is the existing native session only when its local workspace binding and metadata are valid. An absent `session` means that no workspace binding exists. An invalid or uncertain binding fails instead of being repaired. A new candidate creates a new native session after validation. It does not adopt or fork another session.

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

Session headers and `pi-workspace` custom session metadata contain the detailed workspace validation data. Git branch rename moves branch-scoped config bindings. Lease names use the central session path, so a rename keeps its live lease. Managed worktrees are at `<repo>/.ws/<12-character-branch-hash>/src`. The extension initializes an empty Git repository at the sibling `pm` path for durable project records. When `create_workspace` gets `pm`, that sibling path is a symlink to the specified existing PM worktree. While its workspace is active, the `workspace-pm` skill is available for plans, tasks, decisions, and related records. It adds `/.ws/` to `.git/info/exclude`. Lease files remain below `<git-common-dir>/pi-workspaces/.state`. A private Git ref provides the operation lock.

`/ws prune` and `piw prune` first check the recorded local base branch. They recognize a normal merge by Git ancestry. They recognize an exact squash merge by comparing the complete source patch with commits on the base branch. If local integration is not proven, they use `git ls-remote` to check each managed branch. They use its configured remote, `origin`, or the only configured remote. They skip active or dirty workspaces when neither local integration nor remote deletion is proven. Pruning removes the `src` worktree, its sibling `pm` repository or symlink, and the workspace binding. It preserves the local branch, Pi session, and any external PM worktree.

`git clean -ffdx` can remove ignored `.ws` workspaces. Do not run it when you need those workspaces.

The extension validates session cwd and workspace metadata before reuse. It adds workspace metadata to active Pi sessions before it maps them. A live lease prevents another process from changing the same checkout, including serial primary workspaces. It can repair a stale branch session mapping when its checkout is usable.

The extension refuses branch changes when the target checkout has staged, unstaged, untracked, dirty-submodule, merge, or rebase state. It does not stash. It does not reset a trusted PR branch without the explicit reset action. It uses `gh pr view` and `gh pr checkout` only for explicit pull request targets. GitHub CLI authentication and normal GitHub CLI behavior still apply.

## Limits

The extension supports macOS and Linux. `launch_pi` requires macOS and Ghostty. `/ws` requires Pi TUI mode. It requires Git. It requires GitHub CLI only for explicit pull request targets. It cannot recover a lease when it cannot prove that the recorded local process has ended. Remove such state only after you verify that no Pi session owns the workspace.
