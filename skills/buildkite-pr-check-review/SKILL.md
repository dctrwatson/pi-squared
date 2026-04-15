---
name: buildkite-pr-check-review
description: Investigates GitHub pull request status checks that map to Buildkite builds or jobs, fetches the relevant Buildkite logs with the Buildkite CLI, and summarizes what failed. Use whenever the user asks to review, debug, explain, or fetch logs for a GitHub PR status check, required check, CI failure, or Buildkite result on a PR—even if they only say things like “what failed on this PR?”, “look at the red check”, or “check the Buildkite logs”.
compatibility: Requires git, GitHub CLI (`gh`), Python 3, and a Buildkite CLI command available as `bk` or `buildkite`, with authentication for the target GitHub repo and Buildkite org.
---

# Buildkite PR Check Review

Turn a GitHub PR status check into the relevant Buildkite logs, then give the user a concise diagnosis.

## 1. Confirm the environment first

This skill assumes the target check lives on GitHub and the backing CI system is Buildkite.

Before doing anything else:

1. Make sure you are in the right GitHub checkout, or that `GH_REPO` / `gh -R owner/repo` will point at the correct repo.
2. Verify GitHub auth works:

```bash
gh auth status
```

3. Find the Buildkite CLI command:

```bash
if command -v bk >/dev/null 2>&1; then
  BK_CLI=bk
elif command -v buildkite >/dev/null 2>&1; then
  BK_CLI=buildkite
else
  echo "Missing Buildkite CLI: expected 'bk' or 'buildkite' on PATH" >&2
  exit 1
fi
```

4. Confirm the Buildkite CLI is callable and authenticated:

```bash
"$BK_CLI" --help
"$BK_CLI" auth status
```

If any of those fail, stop and tell the user exactly what is missing or unauthenticated.

## 2. Resolve the PR and the relevant check

Use the helper script to gather PR metadata plus status checks:

```bash
python3 <skill_dir>/scripts/pr_checks.py [--repo owner/repo] [pr_selector] > /tmp/pr_checks.json
```

- `pr_selector` can be a PR number, PR URL, or branch name. Omit it to use the PR for the current branch.
- The script returns JSON with the PR metadata, all checks, and a basic summary.
- A check is marked `is_buildkite: true` when its link points at Buildkite.

Selection rules:

- If the user named a specific check, prefer an exact name match, then a case-insensitive substring match.
- If the user asked broadly to review a PR's status checks and there is exactly one failing Buildkite check, inspect it immediately.
- If there are multiple failing or pending Buildkite checks and the user did not specify one, show a short numbered list and ask which one to inspect.
- If there are no Buildkite-backed checks, say so clearly instead of pretending you can use this skill.

## 3. Turn the GitHub check link into a Buildkite target

Once you have the chosen check's `link`, parse it with:

```bash
python3 <skill_dir>/scripts/extract_buildkite_target.py "<check_link>"
```

The parser extracts the common Buildkite URL pieces:

- organization
- pipeline
- build number
- job id hint, when present
- normalized web URL

If the parser cannot recognize a Buildkite URL, ask the user for the direct Buildkite build URL or build identifier.

## 4. Use the Buildkite CLI to fetch the right logs

The installed CLI uses these concrete commands:

- `bk build view <build-number> -p <org>/<pipeline> --json`
- `bk job log <job-id> -p <org>/<pipeline> -b <build-number> --no-timestamps`

Use the parsed Buildkite target to fetch, in this order:

1. build summary / state
2. embedded jobs from the build JSON
3. logs for the failed or non-passing job(s)

Suggested workflow:

```bash
pipeline_ref="<org>/<pipeline>"
build_number="<build-number>"
job_id="<job-id-if-known>"

"$BK_CLI" build view "$build_number" -p "$pipeline_ref" --json > /tmp/buildkite-build.json
python3 <skill_dir>/scripts/select_buildkite_job.py /tmp/buildkite-build.json ${job_id:+--job-id-hint "$job_id"} > /tmp/buildkite-job-selection.json
```

Use `select_buildkite_job.py` as the default way to choose which job to inspect. It prefers:

- the exact job referenced by the Buildkite URL, when present
- failed or broken command-like jobs
- otherwise the most relevant running or pending job

Then read `/tmp/buildkite-job-selection.json` and use its `selected_job.id` with:

```bash
"$BK_CLI" job log "$job_id" -p "$pipeline_ref" -b "$build_number" --no-timestamps > /tmp/buildkite-job.log
```

Handling the selection result:

- If `status` is `failed_job_selected` or `pending_job_selected`, continue with that job.
- If `status` is `multiple_failed_jobs`, inspect `selected_job` first, but mention the other failed jobs in your response.
- If `status` is `job_hint_not_found`, mention that the URL-specific job was not present and that you fell back to the most relevant job still attached to the build.
- If `status` is `no_jobs_found`, fall back to `bk api` or tell the user the build JSON did not include jobs.

Guidance:

- Prefer job-specific logs over whole-build output whenever the check link points to a specific job.
- If several jobs failed, summarize each one briefly but spend most attention on the first real root cause.
- If logs are large, save raw CLI output to a temp file, then search and inspect around meaningful failures rather than pasting huge blobs into the response.
- Search for signals like `error`, `failed`, `exception`, `traceback`, `panic`, `AssertionError`, `Caused by:`, or tool-specific failure markers, but always read surrounding context before concluding.
- If the check is still running, summarize what is pending or currently executing instead of claiming failure.
- If `bk build view --json` is missing a field you need, fall back to `bk api` against the relevant Buildkite REST endpoint rather than guessing.

## 5. What to return to the user

Default response structure:

~~~markdown
## PR check review
- PR: #<number> <title>
- Check: <check name>
- GitHub state: <state>
- Buildkite target: <org>/<pipeline> build <number> [job <id>]

## What failed
- <short diagnosis>
- <whether this looks like code, test, infra, or flaky CI>

## Relevant log excerpts
```text
<only the most useful lines>
```

## Suggested next step
- <specific next action>
~~~

Keep the answer grounded in evidence:

- Quote a few relevant lines from the logs.
- Distinguish clearly between observed failure, likely cause, and uncertainty.
- If the logs show only a symptom, say that instead of overstating confidence.
- If everything passed, say so plainly.

## 6. Edge cases

- **Missing Buildkite CLI or auth**: stop and tell the user what to install or authenticate.
- **Non-Buildkite check**: explain that the selected check is not backed by Buildkite and avoid fake Buildkite commands.
- **Canceled checks**: say whether the job was canceled by a user, superseded, or appears infrastructure-related if the logs indicate that.
- **Pending checks**: summarize queue / running state and name any long-running step if visible.
- **Permission errors**: surface the exact CLI error; do not paraphrase away important auth details.
- **Direct Buildkite URL from the user**: you may skip the GitHub lookup and go straight to parsing plus Buildkite CLI inspection.

## Helper files

- `scripts/pr_checks.py` — collect PR metadata and GitHub checks as JSON
- `scripts/extract_buildkite_target.py` — parse a Buildkite URL into structured identifiers
- `scripts/select_buildkite_job.py` — choose the most relevant failed or pending Buildkite job from `bk build view --json`
