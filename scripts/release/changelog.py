#!/usr/bin/env python3
"""Generate concise release notes from Conventional Commit history."""

from __future__ import annotations

import re
import subprocess
import sys

start = sys.argv[1].strip() if len(sys.argv) > 1 else ""
end = sys.argv[2].strip() if len(sys.argv) > 2 else "HEAD"
commit_pattern = re.compile(r"^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$")
sections = (("feat", "### ✨ Features"), ("fix", "### 🐛 Fixes"))
buckets: dict[str, list[str]] = {kind: [] for kind, _ in sections}
revision_range = f"{start}..{end}" if start else end

try:
    output = subprocess.run(
        ["git", "log", revision_range, "--no-merges", "--pretty=format:%H%x09%s"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
except subprocess.CalledProcessError as error:
    print(f"changelog: git log failed ({error.stderr.strip()})", file=sys.stderr)
    output = ""

for line in output.splitlines():
    sha, separator, subject = line.partition("\t")
    if not separator:
        continue
    match = commit_pattern.fullmatch(subject)
    if match is None:
        continue
    kind = match.group(1).lower()
    if kind in buckets:
        buckets[kind].append(f"- {match.group(3)} ({sha[:8]})")

notes = [f"{heading}\n\n" + "\n".join(buckets[kind]) for kind, heading in sections if buckets[kind]]
print("\n\n".join(notes) if notes else ("Maintenance release." if start else "Initial release."))
