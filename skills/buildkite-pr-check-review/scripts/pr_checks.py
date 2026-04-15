#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from typing import Any


def run(cmd: list[str]) -> Any:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        raise SystemExit(result.returncode)
    return json.loads(result.stdout)


def is_buildkite_link(link: str | None) -> bool:
    if not link:
        return False
    link = link.lower()
    return "buildkite" in link


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch GitHub PR metadata and status checks as JSON.")
    parser.add_argument("selector", nargs="?", help="PR number, PR URL, or branch name. Defaults to current branch PR.")
    parser.add_argument("--repo", help="Optional GitHub repo in owner/repo format.")
    args = parser.parse_args()

    base_cmd = ["gh"]
    repo_args = ["-R", args.repo] if args.repo else []
    selector_args = [args.selector] if args.selector else []

    pr = run(
        base_cmd
        + ["pr", "view"]
        + selector_args
        + repo_args
        + ["--json", "number,title,url,headRefName,headRefOid"]
    )

    checks = run(
        base_cmd
        + ["pr", "checks"]
        + selector_args
        + repo_args
        + ["--json", "name,state,bucket,link,description,startedAt,completedAt,workflow"]
    )

    enriched_checks: list[dict[str, Any]] = []
    for check in checks:
        link = check.get("link")
        bucket = (check.get("bucket") or "").lower()
        state = (check.get("state") or "").lower()
        enriched = {
            **check,
            "is_buildkite": is_buildkite_link(link),
            "is_passing": bucket == "pass" or state in {"success", "successful"},
            "is_failing": bucket == "fail" or state in {"failure", "failed", "error", "timed_out", "cancelled", "canceled"},
            "is_pending": bucket == "pending" or state in {"pending", "queued", "in_progress", "requested", "waiting"},
        }
        enriched_checks.append(enriched)

    summary = {
        "total_checks": len(enriched_checks),
        "buildkite_checks": sum(1 for c in enriched_checks if c["is_buildkite"]),
        "failing_checks": sum(1 for c in enriched_checks if c["is_failing"]),
        "pending_checks": sum(1 for c in enriched_checks if c["is_pending"]),
        "passing_checks": sum(1 for c in enriched_checks if c["is_passing"]),
    }

    payload = {
        "selector": args.selector,
        "repo": args.repo,
        "pr": pr,
        "summary": summary,
        "checks": enriched_checks,
    }

    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
