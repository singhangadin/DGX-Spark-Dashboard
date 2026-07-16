#!/usr/bin/env python3
"""Compute and persist the next dashboard release version."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
VERSION_PATH = Path(__file__).resolve().parents[2] / "VERSION"


def fail(message: str) -> None:
    print(f"bump: {message}", file=sys.stderr)
    raise SystemExit(1)


current = VERSION_PATH.read_text().strip()
match = SEMVER.fullmatch(current)
if match is None:
    fail(f'VERSION value "{current}" is not X.Y.Z')

release_as = os.getenv("RELEASE_AS", "").strip()
version_type = os.getenv("VERSION_TYPE", "").strip().upper()

if release_as:
    if SEMVER.fullmatch(release_as) is None:
        fail(f'RELEASE_AS "{release_as}" is not X.Y.Z')
    next_version = release_as
elif version_type:
    major, minor, patch = map(int, match.groups())
    if version_type == "MAJOR":
        next_version = f"{major + 1}.0.0"
    elif version_type == "MINOR":
        next_version = f"{major}.{minor + 1}.0"
    elif version_type == "PATCH":
        next_version = f"{major}.{minor}.{patch + 1}"
    else:
        fail(f'VERSION_TYPE must be MAJOR, MINOR or PATCH (got "{version_type}")')
else:
    fail("set VERSION_TYPE=MAJOR|MINOR|PATCH or RELEASE_AS=X.Y.Z")

if next_version != current:
    VERSION_PATH.write_text(f"{next_version}\n")
    print(f"bump: {current} -> {next_version}", file=sys.stderr)
else:
    print(f"bump: version unchanged ({current})", file=sys.stderr)

print(next_version)
