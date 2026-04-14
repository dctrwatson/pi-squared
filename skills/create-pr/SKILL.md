---
name: create-pr
description: Creates a GitHub pull request by summarizing the current branch's changes, squashing `pi:` auto-commits while preserving non-`pi:` commits when possible, and following repo-specific PR templates. Use when the user wants to create, draft, or open a PR.
---

# Create Pull Request

## 1. Gather context

Run both helper scripts (pass optional base branch as arg):

```bash
bash <skill_dir>/gather-context.sh [base_branch]
```

```bash
bash <skill_dir>/gather-diff.sh [base_branch]
```

The first script outputs: BRANCHES, EXISTING PR, COMMITS, and RECENT PR TITLES.
The second script outputs: DIFF STAT and DIFF. They are separate to avoid large diffs truncating the metadata.

- If the first script errors with "Current branch IS the base branch", stop and tell the user.
- If EXISTING PR is not "none", ask the user if they want to update the existing PR body instead.

## 2. Generate PR title and body

**Title:** Concise and descriptive. Match the convention from RECENT PR TITLES if one is apparent (e.g. `feat: ...`, `fix: ...`). Otherwise use a clear imperative sentence. If commits share a common prefix/path (e.g. `vm-stack/eks: do something`), preserve it as a scope in the conventional commit format: `type(vm-stack/eks): do something`. Do NOT drop or rewrite the user's prefix.

**Body:** First, check for a PR template:

```bash
bash <skill_dir>/find-template.sh
```

If a template is found, use it as the PR body structure. Copy the template exactly, then fill in each section with real content derived from the diff and commits. Keep all headings, checkboxes, and required sections intact.

Only if none of the above files exist, use this fallback structure:

```
## Summary
<1-3 sentences: why, then what>

## Changes
<Bulleted list of changes, grouped logically>

## Notes
<Migration steps, breaking changes, testing notes, or "None">
```

**Guidelines:** Be concise. Lead with "why". Synthesize commits, don't just list them. Call out breaking changes or new dependencies.

## 3. Clean up `pi:` auto-commits

If any commit subject in `COMMITS` starts with `pi:`, rewrite only the `pi:` commit run into one clean commit before pushing, while preserving non-`pi:` commits.

- Reuse the generated PR title as the cleaned-up commit subject.
- Write a short commit body (1 short paragraph or 2-4 bullets) that accurately summarizes the changes represented by the squashed `pi:` commit(s). Do **not** paste the PR template or checkbox lists into the commit message.
- Create a temporary commit message file and run:

```bash
tmp=$(mktemp)
cat > "$tmp" <<'EOF'
<title>

<commit summary>
EOF
bash <skill_dir>/squash-pi-commits.sh <base> "$tmp"
rm -f "$tmp"
```

- If the script prints `NO_PI_COMMITS`, leave the existing commit history alone.
- If the script prints `REWROTE_PI_COMMITS`, continue with the updated history.
- If the script errors because the working tree is dirty, stop and ask the user whether to commit or stash the extra changes first.
- If the script errors because there are multiple separate `pi:` commit groups or merge commits, stop and ask the user how they want to clean up the history; preserving non-`pi:` commits would require a more manual rewrite.
- If the script prints a `PUSH:` command, use that exact command in the next step.

## 4. Push and create

If step 3 did not print a `PUSH:` command, use:

```bash
git push -u origin HEAD
```

Then create the PR:

```bash
gh pr create --base <base> --title "<title>" --body "<body>"
```

Add `--draft` if the user requested a draft. If the user provided extra context, incorporate it into the summary. Show the PR URL when done.
