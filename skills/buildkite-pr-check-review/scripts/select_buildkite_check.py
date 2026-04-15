#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
import sys
from typing import Any

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "at",
    "be",
    "branch",
    "build",
    "buildkite",
    "check",
    "checks",
    "ci",
    "current",
    "debug",
    "explain",
    "failed",
    "failure",
    "fetch",
    "for",
    "from",
    "get",
    "github",
    "help",
    "i",
    "in",
    "inspect",
    "it",
    "logs",
    "look",
    "my",
    "of",
    "on",
    "or",
    "please",
    "pr",
    "pull",
    "red",
    "repo",
    "review",
    "running",
    "show",
    "status",
    "summarize",
    "tell",
    "that",
    "the",
    "this",
    "to",
    "what",
    "why",
}


def run(cmd: list[str]) -> Any:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr or result.stdout)
        raise SystemExit(result.returncode)
    return json.loads(result.stdout)


def is_buildkite_link(link: str | None) -> bool:
    return bool(link and "buildkite" in link.lower())


def load_pr_checks(selector: str | None, repo: str | None) -> dict[str, Any]:
    base_cmd = ["gh"]
    repo_args = ["-R", repo] if repo else []
    selector_args = [selector] if selector else []

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
        bucket = (check.get("bucket") or "").lower()
        state = (check.get("state") or "").lower()
        enriched_checks.append(
            {
                **check,
                "is_buildkite": is_buildkite_link(check.get("link")),
                "is_passing": bucket == "pass" or state in {"success", "successful"},
                "is_failing": bucket == "fail" or state in {"failure", "failed", "error", "timed_out", "cancelled", "canceled"},
                "is_pending": bucket == "pending" or state in {"pending", "queued", "in_progress", "requested", "waiting"},
            }
        )

    summary = {
        "total_checks": len(enriched_checks),
        "buildkite_checks": sum(1 for c in enriched_checks if c["is_buildkite"]),
        "failing_checks": sum(1 for c in enriched_checks if c["is_failing"]),
        "pending_checks": sum(1 for c in enriched_checks if c["is_pending"]),
        "passing_checks": sum(1 for c in enriched_checks if c["is_passing"]),
    }

    return {
        "selector": selector,
        "repo": repo,
        "pr": pr,
        "summary": summary,
        "checks": enriched_checks,
    }


def tokenize(text: str) -> set[str]:
    words = set(re.findall(r"[a-z0-9]+", text.lower()))
    return {word for word in words if word not in STOP_WORDS and len(word) > 1}


def score_check(check: dict[str, Any], prompt: str, prompt_tokens: set[str]) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []

    name = str(check.get("name") or "")
    name_lower = name.lower()
    workflow = str(check.get("workflow") or "")
    workflow_lower = workflow.lower()
    description = str(check.get("description") or "")
    bucket = str(check.get("bucket") or "").lower()
    state = str(check.get("state") or "").lower()

    fields = " ".join(part for part in [name_lower, workflow_lower, description.lower()] if part)
    field_tokens = tokenize(fields)
    overlap = sorted(prompt_tokens & field_tokens)

    if name and name_lower in prompt.lower():
        score += 200
        reasons.append("Prompt contains the full check name.")

    if workflow and workflow_lower in prompt.lower():
        score += 100
        reasons.append("Prompt contains the workflow name.")

    if overlap:
        score += min(len(overlap) * 20, 80)
        reasons.append(f"Prompt overlaps check metadata on: {', '.join(overlap[:6])}.")

    if check.get("is_failing"):
        score += 35
        reasons.append("Check is currently failing.")
    elif check.get("is_pending"):
        score += 20
        reasons.append("Check is currently pending.")
    elif check.get("is_passing"):
        score -= 10

    if bucket == "fail" or state in {"failure", "failed", "error", "timed_out"}:
        score += 10
    if bucket == "pending" or state in {"pending", "queued", "in_progress", "requested", "waiting"}:
        score += 5

    if not check.get("is_buildkite"):
        score -= 1000
        reasons.append("Not a Buildkite-backed check.")

    if not overlap and name and any(part in prompt.lower() for part in re.split(r"[^a-z0-9]+", name_lower) if len(part) > 2):
        score += 20
        reasons.append("Prompt mentions part of the check name.")

    return score, reasons


def summarize_check(check: dict[str, Any], score: int | None = None, reasons: list[str] | None = None) -> dict[str, Any]:
    payload = {
        "name": check.get("name"),
        "state": check.get("state"),
        "bucket": check.get("bucket"),
        "link": check.get("link"),
        "workflow": check.get("workflow"),
        "description": check.get("description"),
        "is_buildkite": check.get("is_buildkite"),
        "is_failing": check.get("is_failing"),
        "is_pending": check.get("is_pending"),
        "is_passing": check.get("is_passing"),
    }
    if score is not None:
        payload["score"] = score
    if reasons is not None:
        payload["reasons"] = reasons
    return payload


def select_check(data: dict[str, Any], prompt: str) -> dict[str, Any]:
    checks = data.get("checks") or []
    buildkite_checks = [check for check in checks if check.get("is_buildkite")]
    failing_buildkite = [check for check in buildkite_checks if check.get("is_failing")]
    pending_buildkite = [check for check in buildkite_checks if check.get("is_pending")]
    prompt_tokens = tokenize(prompt)

    if not buildkite_checks:
        return {
            "status": "no_buildkite_checks",
            "selection_reason": "The PR has no Buildkite-backed status checks.",
            "selected_check": None,
            "candidate_checks": [],
        }

    if len(buildkite_checks) == 1:
        check = buildkite_checks[0]
        return {
            "status": "selected",
            "selection_reason": "There is exactly one Buildkite-backed check on the PR.",
            "selected_check": summarize_check(check),
            "candidate_checks": [summarize_check(check, 0, ["Only Buildkite-backed check available."])],
        }

    if len(failing_buildkite) == 1 and not prompt_tokens:
        check = failing_buildkite[0]
        return {
            "status": "selected",
            "selection_reason": "There is exactly one failing Buildkite-backed check on the PR.",
            "selected_check": summarize_check(check),
            "candidate_checks": [summarize_check(check, 0, ["Only failing Buildkite-backed check available."])],
        }

    scored: list[tuple[int, dict[str, Any], list[str]]] = []
    for check in buildkite_checks:
        score, reasons = score_check(check, prompt, prompt_tokens)
        scored.append((score, check, reasons))

    scored.sort(key=lambda item: item[0], reverse=True)
    top_score, top_check, top_reasons = scored[0]
    second_score = scored[1][0] if len(scored) > 1 else None

    confidence_gap = top_score - second_score if second_score is not None else top_score
    strong_name_match = any(reason.startswith("Prompt contains the full check name") for reason in top_reasons)
    explicit_overlap = any(reason.startswith("Prompt overlaps") for reason in top_reasons)

    if len(failing_buildkite) == 1 and top_score < 40:
        check = failing_buildkite[0]
        return {
            "status": "selected",
            "selection_reason": "There is exactly one failing Buildkite-backed check, so it was selected despite a weak prompt match.",
            "selected_check": summarize_check(check),
            "candidate_checks": [summarize_check(c, s, r) for s, c, r in scored[:5]],
        }

    confident = strong_name_match or top_score >= 80 or (top_score >= 45 and confidence_gap >= 20 and explicit_overlap)
    if not confident and second_score is not None and abs(top_score - second_score) <= 15:
        return {
            "status": "ambiguous",
            "selection_reason": "Multiple Buildkite checks match the prompt similarly closely.",
            "selected_check": summarize_check(top_check, top_score, top_reasons),
            "candidate_checks": [summarize_check(c, s, r) for s, c, r in scored[:5]],
        }

    return {
        "status": "selected",
        "selection_reason": "Selected the Buildkite-backed check whose metadata best matches the prompt.",
        "selected_check": summarize_check(top_check, top_score, top_reasons),
        "candidate_checks": [summarize_check(c, s, r) for s, c, r in scored[:5]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Select the most relevant Buildkite-backed PR check from the user's prompt.")
    parser.add_argument("selector", nargs="?", help="PR number, PR URL, or branch name. Defaults to current branch PR.")
    parser.add_argument("--repo", help="Optional GitHub repo in owner/repo format.")
    parser.add_argument("--prompt", required=True, help="The user's prompt or a short check-selection hint.")
    parser.add_argument("--input-json", help="Optional path to pre-fetched JSON from pr_checks.py.")
    args = parser.parse_args()

    if args.input_json:
        with open(args.input_json, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = load_pr_checks(args.selector, args.repo)

    result = select_check(data, args.prompt)
    output = {
        "status": result["status"],
        "prompt": args.prompt,
        "selector": args.selector,
        "repo": args.repo,
        "pr": data.get("pr"),
        "summary": data.get("summary"),
        "selection_reason": result["selection_reason"],
        "selected_check": result["selected_check"],
        "candidate_checks": result["candidate_checks"],
    }

    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
