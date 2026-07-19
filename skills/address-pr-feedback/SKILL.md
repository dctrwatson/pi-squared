---
name: address-pr-feedback
description: "Handles GitHub PR feedback end-to-end: reviews PR comments and inline threads, decides whether to reply or change code, groups related fixes into sensible commits, and posts replies on GitHub. Use when the user wants review feedback actually addressed on a PR, not just analyzed or drafted."
compatibility: Requires bash, git, GitHub CLI (`gh`), `jq`, a GitHub checkout, and permission to read the target PR. Pushing commits or posting replies also requires the corresponding repo permissions.
---

# Address PR Feedback

Use this skill to work through GitHub PR feedback methodically. The default expectation is execution, not rehearsal: handle the feedback on GitHub unless the user explicitly asks for analysis-only or a dry run. The job is not "change code until the comments go away." The job is to decide what each comment is really asking for, make the smallest correct response, and leave the PR in a clean state.

Some comments should lead to code changes. Some should lead to a thoughtful reply. Some should be grouped into one patch because they are really the same underlying issue. Others should stay separate so the history stays easy to review.

Throughout this skill, `<skill_dir>` refers to the directory containing this `SKILL.md`. Resolve it once at the start (for example, via the path the harness used to load the skill) and reuse it for every helper invocation below.

## 1. Verify the repo and resolve the PR

Use the current repo and current branch PR unless the user specifies a PR number or URL.

Before gathering feedback, verify the local state:

- `git status --porcelain` is empty, or the user has explicitly approved unrelated local changes. If dirty and unapproved, stop and ask whether to stash, commit, or discard.
- `git fetch` the remote so your local refs match what reviewers see.
- You are on the PR's head branch. After running the gather helper, cross-check `git rev-parse --abbrev-ref HEAD` against `.pr.headRefName` in `normalized-feedback.json`. If they differ, switch branches or ask the user before making any changes.

These checks are cheap and prevent the most common failure mode: committing feedback fixes on top of a stale or wrong branch.

Prefer the bundled helper first:

```bash
bash <skill_dir>/scripts/gather-pr-feedback.sh [pr-selector]
```

The script prints `WORKDIR=`, `SUMMARY=`, and `NORMALIZED_JSON=` paths and writes:

- `feedback-summary.md` — a readable summary of general comments, review summaries, and inline threads
- `normalized-feedback.json` — normalized structured data for deeper inspection
- raw API payloads such as `issue-comments.json`, `reviews.json`, and `review-comments.json`

Read `feedback-summary.md` first, then build a planning worksheet from the normalized JSON:

```bash
bash <skill_dir>/scripts/build-feedback-worklist.sh <workdir>/normalized-feedback.json
```

That writes `feedback-worklist.md` and `feedback-worklist.json`. Read the Markdown worklist before deciding what to change.

If you need full context for one specific thread or comment while drafting a reply or planning a patch, render just that item:

```bash
bash <skill_dir>/scripts/render-feedback-item.sh <workdir>/normalized-feedback.json <item-id>
```

Read `normalized-feedback.json` or the raw payloads only if you need more detail than the helper outputs provide.

If the helper fails, inspect its output and debug the underlying `gh` or `jq` command rather than switching to a separate manual workflow.

## 2. Gather all relevant feedback

You need the full feedback picture before deciding what to change.

The helper gathers these sources and keeps them separate:

- `issue-comments.json`: general PR conversation comments
- `review-comments.json`: inline code comments with file/line context
- `reviews.json`: review summaries such as approve/comment/request changes

If the PR is very large or old and you suspect more than 100 items, fetch additional pages manually before proceeding.

## 3. Build a feedback plan before editing anything

Turn the comments into a short action plan. Use `feedback-worklist.md` as the checklist, then classify each feedback item as one of:

1. **Reply only** — explanation, acknowledgment, or clarification is enough
2. **Code change** — the current branch should change
3. **Needs clarification** — ambiguous, conflicting, or too broad to safely act on alone

This step matters because not every comment deserves code churn.

Treat `feedback-worklist.md` as a working document. For each item, fill in:

- `Action:` — one of `reply`, `change`, `clarify`, or `already-addressed`. If grouping with another item, write `change (grouped with <other item id>)`.
- `Notes:` — a one-line rationale or, for code changes, the file(s) you expect to touch and the proposed commit subject.

Edit the file directly before making code changes. The filled-in worklist is the plan of record for the session and becomes the basis for your final summary in Section 7.

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
- [ ] `thread:PRRT_abc` `parser.go:42` by @alice [unresolved]
  - Summary: Missing nil handling when config block is absent
  - Action: change (grouped with thread:PRRT_def)
  - Notes: parser.go + parser_test.go; commit `fix(parser): handle nil config blocks`
- [ ] `issue-comment:12345` by @bob [open]
  - Summary: Why is this helper package-private?
  - Action: reply
  - Notes: visibility is test-only; explain.
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

Then commit with a concise summary. Prefer a short imperative subject that names the area or fix, not the reviewer conversation (this repo does not strictly require Conventional Commits; the goal is a short imperative subject that names the area).

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

## 5. Reply on GitHub for every handled comment

By default, post replies on GitHub rather than drafting them in the conversation. Only keep replies as drafts if the user explicitly asks for a dry run.

When a single thread is long or has back-and-forth from multiple people, use the item renderer so you can read only that thread without losing context:

```bash
bash <skill_dir>/scripts/render-feedback-item.sh <workdir>/normalized-feedback.json <item-id>
```

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

**Longer code-change reply:**

> I kept the fallback behavior, but moved the nil check earlier so the parser fails closed instead of silently continuing. I also added `TestLoadConfigMissingBlock` to cover the missing-config path.

## 6. Post comments on GitHub

Posting replies is the default behavior for this skill. Use the bundled helper so inline replies land on the correct thread:

```bash
bash <skill_dir>/scripts/post-reply.sh <workdir>/normalized-feedback.json <item-id> <body-file>
```

- For `thread:*` items the helper posts through the review-comment reply API so the response stays attached to the thread. The worklist exposes a GraphQL node id, but the reply API needs the REST comment `databaseId`; the helper handles that lookup for you.
- For `issue-comment:*` and `review:*` items the helper posts a new general PR comment via `gh pr comment`.
- Pass `--dry-run` to see the resolved endpoint and body without posting.
- By default, leave thread resolution to the reviewer; only resolve threads on the user's explicit instruction.

If a reply refers to code changes, push the relevant commits first so the comment truthfully describes the branch state. If several comments are handled by one commit, reply to each affected thread individually and mention the shared fix in natural language.

If the user asks for a preview first, draft the replies in the conversation before posting (see "Dry-run mode").

### Dry-run mode

If the user asks for a preview, analysis-only, or explicitly says "dry run":

- Do not push commits. If it helps keep the work reviewable you may make local commits on the current branch, but prefer the lightest-weight local state that still lets the user review the proposed changes, and do not `git push`.
- Do not post replies. Instead, write each drafted reply as a separate file in the workdir, named `draft-<item-id>.md`, and list the paths in your final summary.
- Pass `--dry-run` to `post-reply.sh` when you want to show the user what the posting call would look like without executing it.
- In Section 7's final summary, replace `Commits created` / `Replies posted` with `Commits staged (not pushed)` / `Replies drafted (not posted)` and point at the draft files.

Resume normal posting behavior only after the user explicitly confirms.

## 7. Final response to the user

Use the filled-in `feedback-worklist.md` as the source of truth for this summary; the `Plan`, `Commits created`, and `Replies posted` sections should map one-to-one to those rows.

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

## Replies posted
- <comment/thread summary>: <what you posted>

## Remaining questions
- <anything blocked or ambiguous>
```

If you intentionally did not push or post replies yet, say so explicitly.

## 8. Edge cases

### Outdated inline comments
If a line comment refers to code that has already moved or changed, inspect whether the concern is still relevant. Outdated often still means relevant: the code may have moved, been reformatted, or been partially rewritten without addressing the underlying concern. Inspect the current code before dismissing the comment. Often the right move is a short reply, not another code change.

### Conflicting reviewer guidance
If two comments point in opposite directions, stop and ask the user which tradeoff they want. Do not guess.

### Large refactors requested on a small PR
Prefer replying and scoping the current PR tightly unless the user explicitly wants to broaden the work.

### Bot comments
Treat bot findings as input, not automatic requirements. Apply the same reply-versus-change judgment.

### Failing CI referenced by reviewers
If reviewers reference failing checks, the `buildkite-pr-check-review` skill in this repo handles that triage.

### Dirty working tree
This should have been caught in Step 1. Do not mix unrelated local changes into review-response commits. If you find yourself here anyway, stop and ask the user whether to stash, commit, or discard unrelated work first.

## Helper files

- `scripts/gather-pr-feedback.sh` — resolves the PR, fetches general comments plus inline review threads, normalizes them with `jq`, and writes a summary you can read before planning changes
- `scripts/build-feedback-worklist.sh` — turns normalized feedback into a planning worksheet with stable item IDs, sorted so unresolved inline threads are easy to tackle first
- `scripts/render-feedback-item.sh` — prints full context for one or more specific worklist items so you can draft a reply or inspect a thread without rereading the whole PR summary
- `scripts/post-reply.sh` — posts replies for worklist items, handling the thread node-id to REST comment `databaseId` lookup for inline replies and supporting `--dry-run` for preview mode
