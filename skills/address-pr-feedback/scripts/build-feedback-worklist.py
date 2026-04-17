#!/usr/bin/env python3
"""Build a planning-friendly worklist from normalized PR feedback."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def clip(text: str, *, char_limit: int = 160) -> str:
    text = " ".join((text or "").split())
    if len(text) <= char_limit:
        return text
    return text[: char_limit - 1].rstrip() + "…"


def thread_item(thread: dict[str, Any]) -> dict[str, Any]:
    comments = thread.get("comments", [])
    latest = comments[-1] if comments else {}
    participants = sorted({comment.get("author") for comment in comments if comment.get("author")})
    line = thread.get("line") or thread.get("original_line") or "?"
    return {
        "item_id": f"thread:{thread.get('thread_id')}",
        "kind": "inline_thread",
        "sort_bucket": 0 if thread.get("status") == "unresolved" else 1,
        "status": thread.get("status") or "unknown",
        "author": thread.get("root_author") or "unknown",
        "path": thread.get("path"),
        "line": line,
        "location": f"{thread.get('path') or 'unknown-path'}:{line}",
        "comment_count": len(comments),
        "participants": participants,
        "latest_author": latest.get("author"),
        "latest_at": latest.get("created_at"),
        "url": next((comment.get("url") for comment in comments if comment.get("url")), None),
        "summary": clip(thread.get("root_body") or ""),
    }


def issue_comment_item(comment: dict[str, Any]) -> dict[str, Any]:
    return {
        "item_id": f"issue-comment:{comment.get('id')}",
        "kind": "general_comment",
        "sort_bucket": 3,
        "status": "open",
        "author": comment.get("author") or "unknown",
        "path": None,
        "line": None,
        "location": None,
        "comment_count": 1,
        "participants": [comment.get("author")] if comment.get("author") else [],
        "latest_author": comment.get("author"),
        "latest_at": comment.get("updated_at") or comment.get("created_at"),
        "url": comment.get("url"),
        "summary": clip(comment.get("body") or ""),
    }


def review_item(review: dict[str, Any]) -> dict[str, Any]:
    state = (review.get("state") or "COMMENTED").lower()
    sort_bucket = 2 if state == "changes_requested" else 4
    return {
        "item_id": f"review:{review.get('id')}",
        "kind": "review_summary",
        "sort_bucket": sort_bucket,
        "status": state,
        "author": review.get("author") or "unknown",
        "path": None,
        "line": None,
        "location": None,
        "comment_count": 1,
        "participants": [review.get("author")] if review.get("author") else [],
        "latest_author": review.get("author"),
        "latest_at": review.get("submitted_at"),
        "url": review.get("url"),
        "summary": clip(review.get("body") or ""),
    }


def sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    return (
        item.get("sort_bucket", 99),
        item.get("path") or "",
        item.get("line") or -1,
        item.get("latest_at") or "",
        item.get("item_id") or "",
    )


SECTION_ORDER = [
    ("unresolved_inline_threads", "Unresolved inline threads"),
    ("resolved_or_outdated_inline_threads", "Resolved or outdated inline threads"),
    ("change_request_reviews", "Review summaries with requested changes"),
    ("general_pr_comments", "General PR comments"),
    ("other_review_summaries", "Other review summaries"),
]


def build_worklist(normalized: dict[str, Any]) -> dict[str, Any]:
    threads = normalized.get("review_threads", [])
    issue_comments = normalized.get("issue_comments", [])
    reviews = normalized.get("reviews", [])

    unresolved_threads = [thread_item(thread) for thread in threads if thread.get("status") == "unresolved"]
    other_threads = [thread_item(thread) for thread in threads if thread.get("status") != "unresolved"]
    change_reviews = [review_item(review) for review in reviews if (review.get("state") or "").lower() == "changes_requested"]
    other_reviews = [review_item(review) for review in reviews if (review.get("state") or "").lower() != "changes_requested"]
    general_comments = [issue_comment_item(comment) for comment in issue_comments]

    sections = {
        "unresolved_inline_threads": sorted(unresolved_threads, key=sort_key),
        "resolved_or_outdated_inline_threads": sorted(other_threads, key=sort_key),
        "change_request_reviews": sorted(change_reviews, key=sort_key),
        "general_pr_comments": sorted(general_comments, key=sort_key),
        "other_review_summaries": sorted(other_reviews, key=sort_key),
    }

    all_items = []
    for key, _title in SECTION_ORDER:
        all_items.extend(sections[key])

    return {
        "repo": normalized.get("repo"),
        "pr": normalized.get("pr"),
        "counts": normalized.get("counts") or {},
        "section_order": [key for key, _title in SECTION_ORDER],
        "sections": sections,
        "all_items": all_items,
    }


def render_markdown(worklist: dict[str, Any]) -> str:
    pr = worklist.get("pr") or {}
    lines = [
        "# PR feedback worklist",
        "",
        f"- PR: #{pr.get('number')} {pr.get('title')}",
        f"- URL: {pr.get('url')}",
        "",
        "Use this as a planning worksheet. Decide for each item whether it is reply-only, a code change, or needs clarification.",
        "",
    ]

    sections = worklist.get("sections") or {}
    for key, title in SECTION_ORDER:
        items = sections.get(key) or []
        lines.extend([f"## {title}", ""])
        if not items:
            lines.extend(["_None._", ""])
            continue
        for item in items:
            header = f"- [ ] `{item['item_id']}`"
            if item.get("location"):
                header += f" `{item['location']}`"
            header += f" by @{item.get('author') or 'unknown'}"
            if item.get("status"):
                header += f" [{item['status']}]"
            lines.append(header)
            lines.append(f"  - Summary: {item.get('summary') or '_No body_'}")
            if item.get("comment_count"):
                lines.append(f"  - Comment count: {item['comment_count']}")
            if item.get("participants"):
                participants = ", ".join(f"@{participant}" for participant in item["participants"])
                lines.append(f"  - Participants: {participants}")
            if item.get("latest_author") or item.get("latest_at"):
                lines.append(
                    f"  - Latest activity: @{item.get('latest_author') or 'unknown'} at {item.get('latest_at') or 'unknown'}"
                )
            if item.get("url"):
                lines.append(f"  - URL: {item['url']}")
            lines.append("  - Action: ")
            lines.append("  - Notes: ")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a worklist from normalized PR feedback JSON.")
    parser.add_argument("normalized_json", help="Path to normalized-feedback.json")
    parser.add_argument("--json-out", help="Where to write worklist JSON. Defaults next to the input file.")
    parser.add_argument("--md-out", help="Where to write worklist Markdown. Defaults next to the input file.")
    args = parser.parse_args()

    normalized_path = Path(args.normalized_json)
    normalized = load_json(normalized_path)
    worklist = build_worklist(normalized)

    json_out = Path(args.json_out) if args.json_out else normalized_path.with_name("feedback-worklist.json")
    md_out = Path(args.md_out) if args.md_out else normalized_path.with_name("feedback-worklist.md")

    write_json(json_out, worklist)
    md_out.write_text(render_markdown(worklist), encoding="utf-8")

    print(f"JSON={json_out}")
    print(f"MARKDOWN={md_out}")
    print(f"ITEMS={len(worklist.get('all_items') or [])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
