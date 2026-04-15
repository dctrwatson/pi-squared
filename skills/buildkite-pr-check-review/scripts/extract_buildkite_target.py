#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from urllib.parse import urlparse

_BUILDKITE_HOSTS: frozenset[str] = frozenset({"buildkite.com", "app.buildkite.com"})
_UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_RE = re.compile(_UUID_PATTERN, re.IGNORECASE)


def parse(url: str) -> dict:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    parts = [part for part in parsed.path.split("/") if part]

    organization = None
    pipeline = None
    build_number = None
    job_id = None

    if len(parts) >= 4 and parts[2] == "builds":
        organization = parts[0]
        pipeline = parts[1]
        build_number = parts[3]
        if len(parts) >= 6 and parts[4] == "jobs":
            job_id = parts[5]
    elif len(parts) >= 6 and parts[0] == "organizations" and parts[2] == "pipelines" and parts[4] == "builds":
        organization = parts[1]
        pipeline = parts[3]
        build_number = parts[5]
        if len(parts) >= 8 and parts[6] == "jobs":
            job_id = parts[7]

    if build_number is not None and not build_number.isdigit():
        build_number = None

    fragment = parsed.fragment or None
    if not job_id and fragment:
        match = re.fullmatch(r"job-(" + _UUID_PATTERN + r")", fragment, re.IGNORECASE)
        if match:
            job_id = match.group(1)
        elif _UUID_RE.fullmatch(fragment):
            job_id = fragment

    is_buildkite = host in _BUILDKITE_HOSTS or host.endswith(".buildkite.com")

    return {
        "input_url": url,
        "is_buildkite": is_buildkite,
        "host": parsed.netloc,
        "organization": organization,
        "pipeline": pipeline,
        "build_number": build_number,
        "job_id": job_id,
        "fragment": fragment,
        "web_url": f"{parsed.scheme}://{parsed.netloc}{parsed.path}" if parsed.scheme and parsed.netloc else url,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract common Buildkite identifiers from a Buildkite URL.")
    parser.add_argument("url", help="Buildkite build or job URL")
    args = parser.parse_args()

    payload = parse(args.url)
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
