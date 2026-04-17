#!/usr/bin/env python3
"""Collect and normalize GitHub PR feedback for the current repo or a selected PR.

The script writes raw API payloads plus a plan-friendly Markdown summary to a workdir,
then prints the key paths so the caller can read the artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


PR_FIELDS = "number,title,url,baseRefName,headRefName,reviewDecision,isDraft,author"
GRAPHQL_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          originalStartLine
          diffSide
          startDiffSide
          comments(first: 100) {
            nodes {
              databaseId
              body
              createdAt
              publishedAt
              url
              author {
                login
              }
              replyTo {
                databaseId
              }
            }
          }
        }
      }
    }
  }
}
""".strip()


class CommandError(RuntimeError):
    pass


def run(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout).strip() or f"command failed: {' '.join(cmd)}"
        raise CommandError(message)
    return proc.stdout


def run_json(cmd: list[str]) -> Any:
    output = run(cmd)
    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise CommandError(f"failed to parse JSON from {' '.join(cmd)}: {exc}") from exc


def gh(*args: str) -> str:
    return run(["gh", *args])


def gh_json(*args: str) -> Any:
    return run_json(["gh", *args])


def paginated_rest(endpoint: str) -> list[Any]:
    page = 1
    items: list[Any] = []
    while True:
        page_items = gh_json("api", f"{endpoint}{'&' if '?' in endpoint else '?'}per_page=100&page={page}")
        if not isinstance(page_items, list):
            raise CommandError(f"expected list from gh api {endpoint}, got {type(page_items).__name__}")
        items.extend(page_items)
        if len(page_items) < 100:
            break
        page += 1
    return items


def graphql_review_threads(owner: str, repo: str, pr_number: int) -> list[dict[str, Any]]:
    after: str | None = None
    threads: list[dict[str, Any]] = []
    while True:
        cmd = [
            "gh",
            "api",
            "graphql",
            "-f",
            f"query={GRAPHQL_QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"repo={repo}",
            "-F",
            f"number={pr_number}",
        ]
        if after is not None:
            cmd += ["-F", f"after={after}"]
        data = run_json(cmd)
        pr = data["data"]["repository"]["pullRequest"]
        connection = pr["reviewThreads"]
        threads.extend(connection["nodes"])
        if not connection["pageInfo"]["hasNextPage"]:
            break
        after = connection["pageInfo"]["endCursor"]
    return threads


def sanitize_login(raw_user: Any) -> str:
    if isinstance(raw_user, dict):
        return raw_user.get("login") or "unknown"
    if isinstance(raw_user, str):
        return raw_user
    return "unknown"


def clip_body(body: str, *, char_limit: int = 1200, line_limit: int = 20) -> str:
    body = (body or "").strip()
    if not body:
        return ""
    lines = body.splitlines()
    clipped_lines = lines[:line_limit]
    clipped = "\n".join(clipped_lines)
    clipped = clipped[:char_limit]
    was_trimmed = len(lines) > line_limit or len(body) > len(clipped)
    if was_trimmed:
        clipped = clipped.rstrip() + "\n… [truncated]"
    return clipped


def indent_block(text: str, prefix: str = "    ") -> list[str]:
    if not text:
        return [prefix + "_No body_"]
    return [prefix + line if line else prefix.rstrip() for line in text.splitlines()]


def normalize_reviews(reviews: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for review in reviews:
        normalized.append(
            {
                "id": review.get("id"),
                "author": sanitize_login(review.get("user")),
                "state": review.get("state"),
                "body": review.get("body") or "",
                "submitted_at": review.get("submitted_at"),
                "commit_id": review.get("commit_id"),
                "url": review.get("html_url") or review.get("url"),
            }
        )
    normalized.sort(key=lambda item: (item.get("submitted_at") or "", item.get("id") or 0))
    return normalized


def normalize_issue_comments(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for comment in comments:
        normalized.append(
            {
                "id": comment.get("id"),
                "author": sanitize_login(comment.get("user")),
                "body": comment.get("body") or "",
                "created_at": comment.get("created_at"),
                "updated_at": comment.get("updated_at"),
                "url": comment.get("html_url") or comment.get("url"),
            }
        )
    normalized.sort(key=lambda item: (item.get("created_at") or "", item.get("id") or 0))
    return normalized


def build_threads_from_graphql(threads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for thread in threads:
        comments = []
        for comment in thread.get("comments", {}).get("nodes", []):
            comments.append(
                {
                    "id": comment.get("databaseId"),
                    "reply_to_id": (comment.get("replyTo") or {}).get("databaseId"),
                    "author": sanitize_login(comment.get("author")),
                    "body": comment.get("body") or "",
                    "created_at": comment.get("createdAt") or comment.get("publishedAt"),
                    "url": comment.get("url"),
                }
            )
        comments.sort(key=lambda item: (item.get("created_at") or "", item.get("id") or 0))
        root = next((comment for comment in comments if comment.get("reply_to_id") is None), comments[0] if comments else None)
        normalized.append(
            {
                "thread_id": thread.get("id"),
                "path": thread.get("path"),
                "line": thread.get("line"),
                "original_line": thread.get("originalLine"),
                "start_line": thread.get("startLine"),
                "original_start_line": thread.get("originalStartLine"),
                "diff_side": thread.get("diffSide"),
                "start_diff_side": thread.get("startDiffSide"),
                "is_resolved": thread.get("isResolved"),
                "is_outdated": thread.get("isOutdated"),
                "status": "resolved" if thread.get("isResolved") else ("outdated" if thread.get("isOutdated") else "unresolved"),
                "root_comment_id": root.get("id") if root else None,
                "root_author": root.get("author") if root else None,
                "root_body": root.get("body") if root else "",
                "comments": comments,
            }
        )
    normalized.sort(key=lambda item: (item.get("path") or "", item.get("line") or -1, item.get("root_comment_id") or 0))
    return normalized


def build_threads_from_review_comments(review_comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {comment.get("id"): comment for comment in review_comments if comment.get("id") is not None}
    grouped: dict[int, list[dict[str, Any]]] = {}

    def root_id_for(comment: dict[str, Any]) -> int:
        current = comment
        seen: set[int] = set()
        while current.get("in_reply_to_id") is not None:
            current_id = current.get("id")
            if current_id in seen:
                break
            seen.add(current_id)
            parent = by_id.get(current.get("in_reply_to_id"))
            if not parent:
                break
            current = parent
        return int(current.get("id"))

    for comment in review_comments:
        comment_id = comment.get("id")
        if comment_id is None:
            continue
        grouped.setdefault(root_id_for(comment), []).append(comment)

    normalized = []
    for root_comment_id, comments in grouped.items():
        comments.sort(key=lambda item: (item.get("created_at") or "", item.get("id") or 0))
        root = next((comment for comment in comments if comment.get("id") == root_comment_id), comments[0])
        normalized_comments = []
        for comment in comments:
            normalized_comments.append(
                {
                    "id": comment.get("id"),
                    "reply_to_id": comment.get("in_reply_to_id"),
                    "author": sanitize_login(comment.get("user")),
                    "body": comment.get("body") or "",
                    "created_at": comment.get("created_at"),
                    "url": comment.get("html_url") or comment.get("url"),
                }
            )
        normalized.append(
            {
                "thread_id": f"rest-{root_comment_id}",
                "path": root.get("path"),
                "line": root.get("line") or root.get("original_line"),
                "original_line": root.get("original_line"),
                "start_line": root.get("start_line"),
                "original_start_line": root.get("original_start_line"),
                "diff_side": root.get("side"),
                "start_diff_side": root.get("start_side"),
                "is_resolved": None,
                "is_outdated": None,
                "status": "unknown",
                "root_comment_id": root_comment_id,
                "root_author": sanitize_login(root.get("user")),
                "root_body": root.get("body") or "",
                "comments": normalized_comments,
            }
        )
    normalized.sort(key=lambda item: (item.get("path") or "", item.get("line") or -1, item.get("root_comment_id") or 0))
    return normalized


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def render_summary(pr: dict[str, Any], reviews: list[dict[str, Any]], issue_comments: list[dict[str, Any]], review_threads: list[dict[str, Any]]) -> str:
    unresolved_count = sum(1 for thread in review_threads if thread.get("status") == "unresolved")
    resolved_count = sum(1 for thread in review_threads if thread.get("status") == "resolved")
    outdated_count = sum(1 for thread in review_threads if thread.get("status") == "outdated")

    lines: list[str] = []
    lines.extend(
        [
            "# PR feedback summary",
            "",
            f"- PR: #{pr['number']} {pr['title']}",
            f"- URL: {pr['url']}",
            f"- Base: `{pr.get('baseRefName')}`",
            f"- Head: `{pr.get('headRefName')}`",
            f"- Review decision: `{pr.get('reviewDecision')}`",
            f"- Draft: `{pr.get('isDraft')}`",
            f"- Review summaries: {len(reviews)}",
            f"- General PR comments: {len(issue_comments)}",
            f"- Inline review threads: {len(review_threads)}",
            f"- Unresolved inline threads: {unresolved_count}",
            f"- Resolved inline threads: {resolved_count}",
            f"- Outdated inline threads: {outdated_count}",
            "",
        ]
    )

    if review_threads:
        lines.extend(["## Inline thread index", ""])
        for thread in review_threads:
            location = thread.get("path") or "unknown-path"
            line = thread.get("line") or thread.get("original_line") or "?"
            root_preview = clip_body(thread.get("root_body") or "", char_limit=160, line_limit=3).replace("\n", " ")
            lines.append(
                f"- [{thread.get('status')}] `{location}:{line}` by @{thread.get('root_author') or 'unknown'} — {root_preview or '_No body_'}"
            )
        lines.append("")

    lines.extend(["## Review summaries", ""])
    if reviews:
        for review in reviews:
            lines.append(f"### [{review.get('state')}] @{review.get('author')} — review {review.get('id')}")
            lines.append(f"- Submitted: {review.get('submitted_at') or 'unknown'}")
            lines.append(f"- URL: {review.get('url') or 'unknown'}")
            lines.append("")
            lines.extend(indent_block(clip_body(review.get("body") or "")))
            lines.append("")
    else:
        lines.extend(["_No review summaries found._", ""])

    lines.extend(["## General PR comments", ""])
    if issue_comments:
        for comment in issue_comments:
            lines.append(f"### Comment {comment.get('id')} by @{comment.get('author')}")
            lines.append(f"- Created: {comment.get('created_at') or 'unknown'}")
            lines.append(f"- URL: {comment.get('url') or 'unknown'}")
            lines.append("")
            lines.extend(indent_block(clip_body(comment.get("body") or "")))
            lines.append("")
    else:
        lines.extend(["_No general PR comments found._", ""])

    lines.extend(["## Inline review threads", ""])
    if review_threads:
        for index, thread in enumerate(review_threads, start=1):
            location = thread.get("path") or "unknown-path"
            line = thread.get("line") or thread.get("original_line") or "?"
            lines.append(f"### Thread {index}: `{location}:{line}` [{thread.get('status')}]")
            lines.append(f"- Thread id: {thread.get('thread_id')}")
            if thread.get("is_resolved") is not None:
                lines.append(f"- Resolved: {thread.get('is_resolved')}")
            if thread.get("is_outdated") is not None:
                lines.append(f"- Outdated: {thread.get('is_outdated')}")
            lines.append("")
            for comment in thread.get("comments", []):
                lines.append(f"- Comment {comment.get('id')} by @{comment.get('author')} at {comment.get('created_at') or 'unknown'}")
                if comment.get("reply_to_id") is not None:
                    lines.append(f"  - Reply to: {comment.get('reply_to_id')}")
                if comment.get("url"):
                    lines.append(f"  - URL: {comment.get('url')}")
                body = clip_body(comment.get("body") or "")
                lines.extend(indent_block(body, prefix="  "))
                lines.append("")
    else:
        lines.extend(["_No inline review threads found._", ""])

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Gather and summarize GitHub PR feedback.")
    parser.add_argument("pr_selector", nargs="?", help="PR number, URL, or branch name. Defaults to current branch PR.")
    parser.add_argument("--repo", help="owner/repo to inspect. Defaults to the current checkout's repo.")
    parser.add_argument("--workdir", help="Directory to write artifacts into. Defaults to a new temp dir.")
    args = parser.parse_args()

    try:
        gh("auth", "status")
        repo = args.repo or gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").strip()

        pr_cmd = ["pr", "view"]
        if args.pr_selector:
            pr_cmd.append(args.pr_selector)
        pr_cmd += ["--repo", repo, "--json", PR_FIELDS]
        pr = gh_json(*pr_cmd)

        workdir = Path(args.workdir) if args.workdir else Path(tempfile.mkdtemp(prefix="pr-feedback-", dir="/tmp"))
        workdir.mkdir(parents=True, exist_ok=True)

        issue_comments = paginated_rest(f"repos/{repo}/issues/{pr['number']}/comments")
        reviews = paginated_rest(f"repos/{repo}/pulls/{pr['number']}/reviews")
        review_comments = paginated_rest(f"repos/{repo}/pulls/{pr['number']}/comments")

        owner, repo_name = repo.split("/", 1)
        graphql_threads_error = None
        try:
            review_threads_raw = graphql_review_threads(owner, repo_name, int(pr["number"]))
            review_threads = build_threads_from_graphql(review_threads_raw)
        except Exception as exc:  # noqa: BLE001
            graphql_threads_error = str(exc)
            review_threads_raw = []
            review_threads = build_threads_from_review_comments(review_comments)

        normalized = {
            "repo": repo,
            "pr": pr,
            "counts": {
                "review_summaries": len(reviews),
                "general_pr_comments": len(issue_comments),
                "inline_review_threads": len(review_threads),
                "unresolved_inline_threads": sum(1 for thread in review_threads if thread.get("status") == "unresolved"),
                "resolved_inline_threads": sum(1 for thread in review_threads if thread.get("status") == "resolved"),
                "outdated_inline_threads": sum(1 for thread in review_threads if thread.get("status") == "outdated"),
            },
            "graphql_review_threads_error": graphql_threads_error,
            "reviews": normalize_reviews(reviews),
            "issue_comments": normalize_issue_comments(issue_comments),
            "review_threads": review_threads,
        }

        write_json(workdir / "pr.json", pr)
        write_json(workdir / "issue-comments.json", issue_comments)
        write_json(workdir / "reviews.json", reviews)
        write_json(workdir / "review-comments.json", review_comments)
        write_json(workdir / "review-threads.json", review_threads_raw)
        write_json(workdir / "normalized-feedback.json", normalized)

        summary = render_summary(pr, normalized["reviews"], normalized["issue_comments"], normalized["review_threads"])
        summary_path = workdir / "feedback-summary.md"
        summary_path.write_text(summary, encoding="utf-8")

        print(f"REPO={repo}")
        print(f"PR={pr['number']}")
        print(f"WORKDIR={workdir}")
        print(f"SUMMARY={summary_path}")
        print(f"NORMALIZED_JSON={workdir / 'normalized-feedback.json'}")
        print(
            "COUNTS="
            f"general_comments:{normalized['counts']['general_pr_comments']} "
            f"review_summaries:{normalized['counts']['review_summaries']} "
            f"inline_threads:{normalized['counts']['inline_review_threads']} "
            f"unresolved_threads:{normalized['counts']['unresolved_inline_threads']}"
        )
        if graphql_threads_error:
            print(f"NOTE=GraphQL review thread lookup failed; used REST comment grouping instead: {graphql_threads_error}")
        return 0
    except CommandError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
