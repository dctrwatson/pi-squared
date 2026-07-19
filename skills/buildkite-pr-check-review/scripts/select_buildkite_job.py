#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_job_container(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, dict) and isinstance(value.get("edges"), list):
        items = value["edges"]
    elif isinstance(value, dict) and isinstance(value.get("nodes"), list):
        items = value["nodes"]
    else:
        return []

    jobs: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("node"), dict):
            item = item["node"]
        if isinstance(item, dict):
            jobs.append(item)
    return jobs


def find_jobs(node: Any) -> list[dict[str, Any]]:
    candidates: list[list[dict[str, Any]]] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"jobs", "steps"}:
                    jobs = normalize_job_container(child)
                    if jobs:
                        candidates.append(jobs)
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(node)
    if not candidates:
        return []
    return max(candidates, key=len)


def first_present(obj: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return None


def nested_first_present(obj: dict[str, Any], paths: list[tuple[str, ...]]) -> Any:
    for path in paths:
        value: Any = obj
        ok = True
        for key in path:
            if not isinstance(value, dict) or key not in value:
                ok = False
                break
            value = value[key]
        if ok and value is not None:
            return value
    return None


INTERESTING_STATES: frozenset[str] = frozenset({
    "failed",
    "failing",
    "broken",
    "canceled",
    "cancelled",
    "running",
    "scheduled",
    "assigned",
    "accepted",
    "waiting",
    "blocked",
    "timed_out",
})


def normalize_job(job: dict[str, Any]) -> dict[str, Any]:
    step = job.get("step") if isinstance(job.get("step"), dict) else {}
    raw_id = first_present(job, "uuid", "id", "job_id")
    state = str(first_present(job, "state", "status") or "unknown").lower()
    label = (
        first_present(job, "label", "name")
        or first_present(step, "label", "name", "key")
        or nested_first_present(job, [("step", "label"), ("step", "name"), ("step", "key")])
        or str(raw_id or "unknown job")
    )
    job_type = str(first_present(job, "type", "kind") or first_present(step, "type") or "").lower()
    command = first_present(job, "command") or first_present(step, "command")
    exit_status = first_present(job, "exit_status", "exitStatus")
    web_url = first_present(job, "web_url", "webUrl", "url")
    retried = bool(first_present(job, "retried", "retry", "retried_in_job_id", "retriedInJobId"))
    soft_failed = bool(first_present(job, "soft_failed", "softFailed"))

    return {
        "id": str(raw_id) if raw_id is not None else None,
        "label": str(label),
        "state": state,
        "type": job_type,
        "command": command,
        "exit_status": exit_status,
        "web_url": web_url,
        "retried": retried,
        "soft_failed": soft_failed,
        "raw": job,
    }


def infer_build_state(build: Any) -> str | None:
    if isinstance(build, dict):
        value = first_present(build, "state", "status", "outcome")
        if value is not None:
            return str(value).lower()
        nested = build.get("build")
        if isinstance(nested, dict):
            return infer_build_state(nested)
    return None


def build_identity(build: Any) -> dict[str, Any]:
    if not isinstance(build, dict):
        return {"number": None, "pipeline": None, "url": None}

    pipeline = None
    pipeline_value = build.get("pipeline")
    if isinstance(pipeline_value, dict):
        slug = first_present(pipeline_value, "slug", "name")
        org = None
        org_value = pipeline_value.get("organization")
        if isinstance(org_value, dict):
            org = first_present(org_value, "slug", "name")
        pipeline = f"{org}/{slug}" if org and slug else slug
    if not pipeline:
        pipeline = first_present(build, "pipeline_slug", "pipelineSlug")

    return {
        "number": first_present(build, "number", "build_number", "buildNumber"),
        "pipeline": pipeline,
        "url": first_present(build, "web_url", "webUrl", "url"),
    }


_STATE_SCORES: dict[str, int] = {
    "failed": 100,
    "failing": 100,
    "broken": 95,
    "timed_out": 92,
    "running": 80,
    "assigned": 75,
    "accepted": 74,
    "scheduled": 70,
    "waiting": 65,
    "blocked": 60,
    "canceled": 35,
    "cancelled": 35,
    "passed": 10,
    "skipped": 5,
    "not_run": 0,
    "unknown": 0,
}


def state_score(state: str) -> int:
    return _STATE_SCORES.get(state, 0)


def type_score(job: dict[str, Any]) -> int:
    job_type = job["type"]
    label = job["label"].lower()
    if job_type in {"command", "script", "test"}:
        return 20
    if job_type in {"wait", "block", "input", "manual", "trigger", "group", "annotation"}:
        return -25
    if any(token in label for token in [" wait", "block", "manual unblock", "trigger "]):
        return -20
    if job.get("command"):
        return 15
    return 0


def retry_penalty(job: dict[str, Any]) -> int:
    return -10 if job["retried"] else 0


def soft_fail_penalty(job: dict[str, Any]) -> int:
    return -15 if job["soft_failed"] else 0


def select_job(jobs: list[dict[str, Any]], job_id_hint: str | None) -> tuple[dict[str, Any] | None, str]:
    if job_id_hint:
        for job in jobs:
            if job["id"] == job_id_hint:
                return job, "Selected the job referenced directly by the Buildkite URL."

    interesting = [job for job in jobs if job["state"] in INTERESTING_STATES]
    pool = interesting or jobs
    if not pool:
        return None, "No jobs were found in the build JSON."

    ranked = sorted(
        pool,
        key=lambda job: (
            state_score(job["state"]) + type_score(job) + retry_penalty(job) + soft_fail_penalty(job),
            job["label"],
        ),
        reverse=True,
    )
    selected = ranked[0]

    if selected["state"] in {"failed", "failing", "broken", "timed_out"}:
        reason = "Selected the highest-priority failed command-like job in the build."
    elif selected["state"] in {"running", "assigned", "accepted", "scheduled", "waiting", "blocked"}:
        reason = "Selected the most relevant in-progress job because the build is not finished yet."
    elif selected["state"] in {"canceled", "cancelled"}:
        reason = "Selected the most relevant canceled job because no failed or running jobs were available."
    else:
        reason = "Selected the most relevant job available in the build JSON."

    return selected, reason


def summarize_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "label": job["label"],
        "state": job["state"],
        "type": job["type"],
        "exit_status": job["exit_status"],
        "web_url": job["web_url"],
        "retried": job["retried"],
        "soft_failed": job["soft_failed"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Select the most relevant Buildkite job from build JSON.")
    parser.add_argument("build_json", help="Path to JSON output from `bk build view --json`")
    parser.add_argument("--job-id-hint", help="Prefer this specific Buildkite job UUID if it exists in the build")
    args = parser.parse_args()

    payload = load_json(args.build_json)
    build = payload.get("build") if isinstance(payload, dict) and isinstance(payload.get("build"), dict) else payload
    jobs = [normalize_job(job) for job in find_jobs(payload)]
    identity = build_identity(build)
    build_state = infer_build_state(build)

    selected_job, selection_reason = select_job(jobs, args.job_id_hint)

    failed_jobs = [job for job in jobs if job["state"] in {"failed", "failing", "broken", "timed_out"}]
    running_jobs = [job for job in jobs if job["state"] in {"running", "assigned", "accepted", "scheduled", "waiting", "blocked"}]
    canceled_jobs = [job for job in jobs if job["state"] in {"canceled", "cancelled"}]

    status = "ok"
    if not jobs:
        status = "no_jobs_found"
    elif args.job_id_hint and selected_job and selected_job["id"] == args.job_id_hint:
        status = "job_hint_matched"
    elif args.job_id_hint and (selected_job is None or selected_job["id"] != args.job_id_hint):
        status = "job_hint_not_found"
    elif len(failed_jobs) > 1:
        status = "multiple_failed_jobs"
    elif failed_jobs:
        status = "failed_job_selected"
    elif running_jobs:
        status = "pending_job_selected"
    elif canceled_jobs:
        status = "only_canceled_jobs"

    output = {
        "status": status,
        "build": {
            "state": build_state,
            "number": identity["number"],
            "pipeline": identity["pipeline"],
            "url": identity["url"],
        },
        "job_id_hint": args.job_id_hint,
        "selection_reason": selection_reason,
        "selected_job": summarize_job(selected_job) if selected_job else None,
        "other_relevant_jobs": sorted(
            [
                summarize_job(job)
                for job in jobs
                if (selected_job is None or job["id"] != selected_job["id"])
                and job["state"] in INTERESTING_STATES
            ],
            key=lambda j: state_score(j["state"]),
            reverse=True,
        )[:10],
        "counts": {
            "jobs_found": len(jobs),
            "failed_jobs": len(failed_jobs),
            "running_jobs": len(running_jobs),
            "canceled_jobs": len(canceled_jobs),
        },
    }

    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
