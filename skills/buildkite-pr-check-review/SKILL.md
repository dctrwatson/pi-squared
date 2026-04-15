---
name: buildkite-pr-check-review
description: Reviews GitHub PR status checks backed by Buildkite, fetches the relevant Buildkite logs with `bk`, and explains what failed. Use whenever the user asks what failed on a PR, mentions a red CI/status check, wants Buildkite logs, or asks to inspect the checks for the current branch PR.
compatibility: Requires GitHub CLI (`gh` 2.40+), Python 3.7+, and a Buildkite CLI command available as `bk` or `buildkite`, with auth for the target GitHub repo and Buildkite org.
---

# Buildkite PR Check Review

Turn a GitHub PR status check into the relevant Buildkite logs, then give the user a concise diagnosis.

## 1. Verify the environment

Use the current repo by default. Before doing anything else, verify GitHub and Buildkite access in a single step:

```bash
set -euo pipefail

gh auth status

if command -v bk >/dev/null 2>&1; then
  BK_CLI=bk
elif command -v buildkite >/dev/null 2>&1; then
  BK_CLI=buildkite
else
  echo "Missing Buildkite CLI: expected 'bk' or 'buildkite' on PATH" >&2
  exit 1
fi

"$BK_CLI" auth status
echo "Environment OK. BK_CLI=$BK_CLI"
```

If any step fails, stop and tell the user exactly what is missing or unauthenticated. Note the `BK_CLI` value — use it in place of `"$BK_CLI"` in all subsequent commands.

## 2. Resolve the PR and choose the check

For the common case, inspect the PR for the current branch in the current repo. First, create a working directory to avoid file collisions across concurrent runs:

```bash
workdir=$(mktemp -d /tmp/bk-review-XXXXXX)
echo "WORKDIR=$workdir"
```

Note the printed path and substitute it for `$workdir` in every subsequent command.

```bash
gh pr view [pr_selector] [--repo owner/repo] --json number,title,url,headRefName,headRefOid > "$workdir/pr.json"
gh pr checks [pr_selector] [--repo owner/repo] --json name,state,bucket,link,description,workflow,startedAt,completedAt > "$workdir/pr-checks.json"
```

- Omit `pr_selector` to use the current branch PR.
- `pr_selector` can be a PR number, PR URL, or branch name when the user gives one.
- Treat a check as Buildkite-backed when its `link` points at Buildkite.
- The `bucket` field in `gh pr checks --json` requires `gh` 2.40+; if the command errors on that field, drop `bucket` from the list.

Choose the check from the GitHub results plus the user's wording:

1. Exact check-name match
2. Workflow match
3. Case-insensitive substring match
4. If the prompt is vague, the only failing Buildkite-backed check
5. If still vague, the only Buildkite-backed check overall

If multiple Buildkite checks are still plausible, show a short numbered list and ask the user which one they mean. If there are no Buildkite-backed checks, say so clearly.

## 3. Parse the Buildkite target

Once you have the chosen check's `link`, parse it with:

```bash
python3 <skill_dir>/scripts/extract_buildkite_target.py "<check_link>"
```

This extracts the organization, pipeline, build number, optional job hint, and normalized Buildkite URL.

If the parser cannot recognize the URL, ask the user for the direct Buildkite build URL or identifier.

## 4. Fetch the build and choose the job

Use the installed CLI shape directly:

- `bk build view <build-number> -p <org>/<pipeline> --json`
- `bk job log <job-id> -p <org>/<pipeline> -b <build-number> --no-timestamps`

Suggested workflow:

```bash
pipeline_ref="<org>/<pipeline>"
build_number="<build-number>"
job_id="<job-id-if-known>"

"$BK_CLI" build view "$build_number" -p "$pipeline_ref" --json > "$workdir/buildkite-build.json"
python3 <skill_dir>/scripts/select_buildkite_job.py "$workdir/buildkite-build.json" ${job_id:+--job-id-hint "$job_id"} > "$workdir/buildkite-job-selection.json"

# Fetch annotations — often contain structured test failure summaries
"$BK_CLI" api "organizations/<org>/pipelines/<pipeline>/builds/<build_number>/annotations" 2>/dev/null > "$workdir/buildkite-annotations.json" || true
```

`select_buildkite_job.py` is the default way to choose the job to inspect. It prefers:

- the exact job referenced by the Buildkite URL, when present
- failed or broken command-like jobs
- otherwise the most relevant running or pending job

Then fetch logs for the selected job:

```bash
"$BK_CLI" job log "$job_id" -p "$pipeline_ref" -b "$build_number" --no-timestamps > "$workdir/buildkite-job.log"
```

Interpret `select_buildkite_job.py` like this:

- `job_hint_matched`: the exact URL-referenced job was found; note its state — if it passed, check `other_relevant_jobs` for the actual failures
- `failed_job_selected` or `pending_job_selected`: continue with that job
- `multiple_failed_jobs`: inspect `selected_job` first, but mention the others
- `job_hint_not_found`: mention that you fell back from the URL-specific job to the closest live job on the build
- `only_canceled_jobs`: no failed or running jobs; report the canceled state and ask the user if they want to investigate further
- `no_jobs_found`: fall back to `bk api` or tell the user the build JSON did not include jobs

When reading logs:

- Prefer job logs over whole-build output.
- If logs are large, save them and search around meaningful failures instead of pasting everything.
- Read logs with fresh eyes; always review surrounding context before drawing conclusions. If the initial pass is inconclusive, surface what you found and ask the user whether to dig deeper into a specific section.
- If the check is still running, summarize what is active or blocked instead of claiming failure.
- If log evidence is sparse, check `$workdir/buildkite-annotations.json` — annotations often contain structured test reports. To go further, list build artifacts with `"$BK_CLI" api "organizations/<org>/pipelines/<pipeline>/builds/<build_number>/artifacts"`.
- If `bk build view --json` is missing a field you need, use `bk api` instead of guessing.

## 5. What to return

Use this structure by default:

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

Keep the response evidence-based:

- Quote the most relevant log lines.
- Separate observed failure from likely cause.
- Say plainly when the build passed or when the evidence is inconclusive.

## 6. Edge cases

- **Missing Buildkite CLI or auth**: stop and explain what to install or authenticate.
- **Non-Buildkite check**: say the selected check is not backed by Buildkite.
- **Canceled checks**: say whether the job appears user-canceled, superseded, or infra-related if the logs show it.
- **Pending checks**: summarize queue / running state and name the relevant job if visible.
- **Permission errors**: surface the exact CLI error.
- **Direct Buildkite URL from the user**: skip GitHub lookup and go straight to parsing plus Buildkite inspection.

## Helper files

- `scripts/extract_buildkite_target.py` — parse a Buildkite URL into structured identifiers
- `scripts/select_buildkite_job.py` — choose the most relevant failed or pending Buildkite job from `bk build view --json`
