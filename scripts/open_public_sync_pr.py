#!/usr/bin/env python3
"""Open a draft public sync PR with public-pr-wording only (never Summary/Test plan)."""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINT = ROOT / "skills/public-pr-wording/pr_wording_lint.py"
PUBLIC_REPO = "evoclock/pi-agentic-driver"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", required=True, type=Path)
    parser.add_argument("--head", required=True, help="public head branch")
    parser.add_argument("--base", default="main")
    parser.add_argument("--repo", default=PUBLIC_REPO)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    body = args.body_file.read_text(encoding="utf-8")
    lint = subprocess.run(
        [sys.executable, str(LINT), "--title", args.title, "--body-file", str(args.body_file)],
        cwd=ROOT,
    )
    if lint.returncode:
        raise SystemExit("pr_wording_lint failed; rewrite with skills/public-pr-wording")
    if "## Summary" in body or "## Test plan" in body:
        raise SystemExit("body still contains Summary or Test plan")
    cmd = [
        "gh", "pr", "create", "--repo", args.repo, "--base", args.base, "--head", args.head,
        "--draft", "--title", args.title, "--body-file", str(args.body_file),
    ]
    if args.dry_run:
        print(" ".join(cmd))
        return
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
