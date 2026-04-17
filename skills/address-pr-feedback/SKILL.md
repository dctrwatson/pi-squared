---
name: address-pr-feedback
description: Reviews GitHub pull request feedback, separates reply-only comments from comments that need code changes, groups related feedback into sensible patches, and drafts or posts responses. Use whenever the user asks to address PR feedback, respond to review comments, fix requested changes on a GitHub PR, resolve code review threads, or work through inline comments and general PR discussion on the current branch PR.
compatibility: Requires git, GitHub CLI (`gh`), a GitHub checkout, and permission to read the target PR. Pushing commits or posting replies also requires the corresponding repo permissions.
---

# Address PR Feedback

Use this skill to work through GitHub PR feedback methodically. The job is not "change code until the comments go away." The job is to decide what each comment is really asking for, make the smallest correct response, and leave the PR in a clean state.

Some comments should lead to code changes. Some should lead to a thoughtful reply. Some should be grouped into one patch because they are really the same underlying issue. Others should stay separate so the history stays easy to review.

## 1. Verify the repo and resolve the PR

Use the current repo and current branch PR unless the user specifies a PR number or URL.

Start with:

```bash
set -euo pipefail
gh auth status >/dev/null
git rev-parse --is-inside-work-tree >/dev/null
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
pr=$(gh pr view --json number -q .number)
workdir=$(mktemp -d /tmp/pr-feedback-XXXXXX)
echo "REPO=$repo"
echo "PR=$pr"
echo "WORKDIR=$workdir"
```

If `gh pr view` fails because there is no PR for the current branch, ask the user for the PR number or URL.

If the user gave a PR selector, resolve it explicitly first:

```bash
gh pr view <pr-selector> --json number,title,url
```

## 2. Gather all relevant feedback

You need the full feedback picture before deciding what to change.

Fetch these sources:

```bash
gh pr view "$pr" --json number,title,url,baseRefName,headRefName,reviewDecision,isDraft > "$workdir/pr.json"
gh api "repos/$repo/issues/$pr/comments?per_page=100" > "$workdir/issue-comments.json"
gh api "repos/$repo/pulls/$pr/comments?per_page=100" > "$workdir/review-comments.json"
gh api "repos/$repo/pulls/$pr/reviews?per_page=100" > "$workdir/reviews.json"
```

Treat them differently:

- `issue-comments.json`: general PR conversation comments
- `review-comments.json`: inline code comments with file/line context
- `reviews.json`: review summaries such as approve/comment/request changes

If the PR is very large or old and you suspect more than 100 items, fetch additional pages manually before proceeding.

## 3. Build a feedback plan before editing anything

Turn the comments into a short action plan. For each feedback item, classify it as one of:

1. **Reply only** — explanation, acknowledgment, or clarification is enough
2. **Code change** — the current branch should change
3. **Needs clarification** — ambiguous, conflicting, or too broad to safely act on alone

This step matters because not every comment deserves code churn.

### What usually counts as reply-only

Prefer replying without changing code when the best response is:

- explaining why the current behavior is intentional
- noting that the comment is already addressed in the current branch
- agreeing to defer a suggestion to follow-up work
- answering a question about context, tradeoffs, or naming
- clarifying that a requested change would be riskier than the value it adds

### What usually counts as a real code change

Make a code change when the comment points out something materially better, such as:

- a correctness bug
- a missing edge case
- a confusing API, name, or control flow that should be cleaned up now
- a missing test or missing docs for behavior introduced by the PR
- a style or maintainability issue that is local to this PR and easy to improve safely

### Grouping rules

Group multiple comments into one code change only when one coherent patch addresses the same underlying concern. Good grouping signals:

- same file or tightly related files
- same root cause
- same fix direction
- the reviewer would naturally understand them as one patch

Keep them separate when they are independent, even if they were left by the same reviewer.

A good plan looks like:

```text
1. [reply] Reviewer asks why this helper is package-private → explain test visibility constraint
2. [change A] Two inline comments both point to missing nil handling in parser → one fix commit
3. [change B] Rename a confusing option flag → separate commit
4. [clarify] Reviewer suggests a broader refactor beyond PR scope → ask user whether to take it now
```

## 4. Make code changes with clean commit boundaries

When changes are needed, favor reviewable history over a single "address feedback" blob.

### Commit policy

- If one patch resolves several related comments, use one commit.
- If comments are unrelated, make one commit per independent change.
- Do **not** bundle unrelated feedback into one commit just because it came from the same review.
- Do **not** invent a code change for a comment that is better handled with a reply.

Before each commit:

- make only the files needed for that feedback item
- run the most relevant test/check for the touched area when practical
- stage only that change

Then commit with a concise summary. Prefer a short imperative subject that names the area or fix, not the reviewer conversation.

Good examples:

- `fix(parser): handle nil config blocks`
- `refactor(cli): rename status helper`
- `test(cache): cover empty result case`
- `docs(api): clarify retry semantics`

Bad examples:

- `address pr feedback`
- `fix comments`
- `changes from review`

If a comment turns out to be already satisfied after inspection, do not make a no-op commit. Reply and explain.

## 5. Draft replies for every handled comment

Unless the user explicitly asks you to post on GitHub, draft replies in the conversation instead of sending them.

Every handled comment should have a clear response path:

- **Code change made:** say what changed and, when helpful, mention the test or reasoning
- **No code change needed:** explain why
- **Already addressed:** point to the existing code or commit that covers it
- **Needs clarification:** ask the narrowest possible follow-up question

Keep replies short and direct. The reviewer should not have to reverse-engineer what happened.

### Reply examples

**Code change:**

> Good catch. I added nil handling in the parser and covered it with a regression test.

**Reply only:**

> I kept this as-is because the value is only used inside the package test harness, so widening the visibility would make the public surface less clear.

**Already addressed:**

> This is already handled in the latest branch state — `loadConfig()` now returns early when the file is missing.

**Needs clarification:**

> I can take this either as a small rename in this PR or as part of the larger config cleanup. Which direction do you want here?

## 6. If the user explicitly wants comments posted

Posting comments is an external side effect, so do it only when the user asks.

- For general PR conversation, use `gh pr comment`.
- For inline review comments, use the GitHub pull-request review comment reply API so the response stays attached to the right thread.

If you are posting replies after making commits, push the relevant commits first so the comment truthfully describes the branch state.

## 7. Final response to the user

Return a concise summary with these sections when applicable:

```markdown
## PR feedback update
- PR: #<number> <title>

## Plan
- <reply-only items>
- <code-change groups>
- <items needing clarification>

## Commits created
- <sha or subject>: <what it addressed>

## Draft replies
- <comment/thread summary>: <reply text>

## Remaining questions
- <anything blocked or ambiguous>
```

If you did not push or post replies yet, say so explicitly.

## 8. Edge cases

### Outdated inline comments
If a line comment refers to code that has already moved or changed, inspect whether the concern is still relevant. Often the right move is a short reply, not another code change.

### Conflicting reviewer guidance
If two comments point in opposite directions, stop and ask the user which tradeoff they want. Do not guess.

### Large refactors requested on a small PR
Prefer replying and scoping the current PR tightly unless the user explicitly wants to broaden the work.

### Bot comments
Treat bot findings as input, not automatic requirements. Apply the same reply-versus-change judgment.

### Dirty working tree
Do not mix unrelated local changes into review-response commits. Ask the user whether to stash, commit, or discard unrelated work first.
