#!/usr/bin/env python3
"""Render detailed context for selected PR feedback items."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


KIND_ALIASES = {
    "thread": "thread",
    "inline_thread": "thread",
    "issue": "issue-comment",
    "issue-comment": "issue-comment",
    "comment": "issue-comment",
    "review": "review",
    "review_summary": "review",
}


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def clip(text: str, *, char_limit: int = 2000) -> str:
    text = (text or "").strip()
    if len(text) <= char_limit:
        return text
    return text[: char_limit - 1].rstrip() + "…"


def parse_item_id(raw: str) -> tuple[str, str]:
    if ":" not in raw:
        raise ValueError(f"invalid item id '{raw}' (expected kind:value)")
    kind, value = raw.split(":", 1)
    normalized_kind = KIND_ALIASES.get(kind)
    if normalized_kind is None:
        raise ValueError(f"unknown item kind '{kind}' in '{raw}'")
    return normalized_kind, value


def iter_all_ids(normalized: dict[str, Any]) -> list[str]:
    ids: list[str] = []
    ids.extend(f"thread:{thread.get('thread_id')}" for thread in normalized.get("review_threads", []))
    ids.extend(f"issue-comment:{comment.get('id')}" for comment in normalized.get("issue_comments", []))
    ids.extend(f"review:{review.get('id')}" for review in normalized.get("reviews", []))
    return ids


def resolve_items(normalized: dict[str, Any], requested_ids: list[str], kind_filter: str | None, unresolved_only: bool) -> list[tuple[str, dict[str, Any]]]:
    lookup: dict[str, dict[str, Any]] = {}
    for thread in normalized.get("review_threads", []):
        lookup[f"thread:{thread.get('thread_id')}"] = thread
    for comment in normalized.get("issue_comments", []):
        lookup[f"issue-comment:{comment.get('id')}"] = comment
    for review in normalized.get("reviews", []):
        lookup[f"review:{review.get('id')}"] = review

    chosen_ids = requested_ids or iter_all_ids(normalized)
    resolved: list[tuple[str, dict[str, Any]]] = []
    for item_id in chosen_ids:
        kind, _value = parse_item_id(item_id)
        canonical_id = item_id if item_id in lookup else f"{kind}:{item_id.split(':', 1)[1]}"
        item = lookup.get(canonical_id)
        if item is None:
            raise KeyError(f"item not found: {item_id}")
        if kind_filter and kind != kind_filter:
            continue
        if unresolved_only and kind == "thread" and item.get("status") != "unresolved":
            continue
        resolved.append((canonical_id, item))
    return resolved


def render_thread(item_id: str, thread: dict[str, Any]) -> list[str]:
    location = f"{thread.get('path') or 'unknown-path'}:{thread.get('line') or thread.get('original_line') or '?'}"
    lines = [
        f"## {item_id}",
        "",
        f"- Kind: inline thread",
        f"- Status: {thread.get('status')}",
        f"- Location: `{location}`",
        f"- Thread id: {thread.get('thread_id')}",
        f"- Resolved: {thread.get('is_resolved')}",
        f"- Outdated: {thread.get('is_outdated')}",
        "",
        "### Conversation",
        "",
    ]
    for comment in thread.get("comments", []):
        lines.append(f"- Comment {comment.get('id')} by @{comment.get('author') or 'unknown'} at {comment.get('created_at') or 'unknown'}")
        if comment.get("reply_to_id") is not None:
            lines.append(f"  - Reply to: {comment.get('reply_to_id')}")
        if comment.get("url"):
            lines.append(f"  - URL: {comment.get('url')}")
        body = clip(comment.get("body") or "") or "_No body_"
        for body_line in body.splitlines():
            lines.append(f"  {body_line}" if body_line else "  ")
        lines.append("")
    return lines


def render_issue_comment(item_id: str, comment: dict[str, Any]) -> list[str]:
    lines = [
        f"## {item_id}",
        "",
        "- Kind: general PR comment",
        f"- Author: @{comment.get('author') or 'unknown'}",
        f"- Created: {comment.get('created_at') or 'unknown'}",
        f"- Updated: {comment.get('updated_at') or 'unknown'}",
        f"- URL: {comment.get('url') or 'unknown'}",
        "",
        "### Body",
        "",
    ]
    body = clip(comment.get("body") or "") or "_No body_"
    lines.extend(body.splitlines() or [body])
    lines.append("")
    return lines


def render_review(item_id: str, review: dict[str, Any]) -> list[str]:
    lines = [
        f"## {item_id}",
        "",
        "- Kind: review summary",
        f"- State: {review.get('state') or 'unknown'}",
        f"- Author: @{review.get('author') or 'unknown'}",
        f"- Submitted: {review.get('submitted_at') or 'unknown'}",
        f"- URL: {review.get('url') or 'unknown'}",
        "",
        "### Body",
        "",
    ]
    body = clip(review.get("body") or "") or "_No body_"
    lines.extend(body.splitlines() or [body])
    lines.append("")
    return lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Render detailed context for selected feedback items.")
    parser.add_argument("normalized_json", help="Path to normalized-feedback.json")
    parser.add_argument("item_ids", nargs="*", help="One or more item ids such as thread:<id> or issue-comment:123")
    parser.add_argument("--kind", choices=sorted(KIND_ALIASES), help="Restrict output to one item kind.")
    parser.add_argument("--unresolved", action="store_true", help="Only keep unresolved inline threads.")
    args = parser.parse_args()

    normalized = load_json(Path(args.normalized_json))
    kind_filter = KIND_ALIASES.get(args.kind) if args.kind else None

    try:
        items = resolve_items(normalized, args.item_ids, kind_filter, args.unresolved)
    except (KeyError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if not items:
        print("No matching items.")
        return 0

    pr = normalized.get("pr") or {}
    lines = [
        "# Feedback item context",
        "",
        f"- PR: #{pr.get('number')} {pr.get('title')}",
        f"- URL: {pr.get('url')}",
        "",
    ]

    for item_id, item in items:
        kind, _value = parse_item_id(item_id)
        if kind == "thread":
            lines.extend(render_thread(item_id, item))
        elif kind == "issue-comment":
            lines.extend(render_issue_comment(item_id, item))
        else:
            lines.extend(render_review(item_id, item))

    print("\n".join(lines).rstrip() + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
