#!/usr/bin/env python3
"""Reject new ad hoc Git checkout creation in executable repository sources."""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Historical evidence and fixture tests may quote prohibited commands, but must not execute them.
EXCLUDED = ("docs/internal/", "tests/", "scratch/", "pipeline_output/")
PATTERNS = (
    re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?worktree\s+add\b", re.I),
    re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?clone\b", re.I),
    re.compile(r"\bcorrections-treehouse\b", re.I),
)


def violations(path, text):
    if path.startswith(EXCLUDED) or path == "scripts/treehouse_codepath_scan.py":
        return []
    return [(path, i, line.strip()) for i, line in enumerate(text.splitlines(), 1)
            if any(pattern.search(line) for pattern in PATTERNS)]


def main():
    paths = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0")
    found = []
    for name in paths:
        if not name or name.startswith(EXCLUDED) or name == "scripts/treehouse_codepath_scan.py":
            continue
        path = ROOT / name
        if path.suffix not in {".sh", ".py", ".js", ".mjs", ".ts", ".md"} or not path.is_file():
            continue
        found.extend(violations(name, path.read_text(encoding="utf-8", errors="replace")))
    for name, line, content in found:
        print(f"{name}:{line}: ad hoc checkout: {content}", file=sys.stderr)
    return int(bool(found))


if __name__ == "__main__":
    sys.exit(main())
