#!/usr/bin/env python3
"""Pre-commit inventory gate: refresh, then require the exact refreshed bytes staged."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from codebase_inventory import EXTENSIONS, generate, git

INVENTORY = "pipeline_output/codebase_inventory.jsonl"


def check(repo: Path) -> tuple[bool, str]:
    repo = Path(git(repo.resolve(), "rev-parse", "--show-toplevel").decode().strip())
    output = repo / INVENTORY
    content = generate(repo)
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.is_file() or output.read_bytes() != content:
        output.write_bytes(content)
    # A worktree inventory cannot describe a different staged version of the source.
    unstaged = git(repo, "diff", "--name-only", "-z", "--diff-filter=ACMRT")
    changed = unstaged.decode("utf-8", errors="surrogateescape").split("\0")
    if any(Path(name).suffix in EXTENSIONS for name in changed if name):
        return False, "source has unstaged changes; stage the intended code before refreshing the inventory"
    staged = subprocess.run(["git", "-C", str(repo), "show", f":{INVENTORY}"], capture_output=True)
    if staged.returncode != 0 or staged.stdout != content:
        return False, "review and stage pipeline_output/codebase_inventory.jsonl, then retry the commit"
    return True, "inventory matches the staged source"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        allowed, reason = check(args.repo)
    except (OSError, subprocess.CalledProcessError) as error:
        allowed, reason = False, str(error)
    if not allowed:
        print(f"codebase-inventory: BLOCKED -- {reason}", file=sys.stderr)
    return 0 if allowed else 1


if __name__ == "__main__":
    raise SystemExit(main())
