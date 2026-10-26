#!/usr/bin/env python3
"""Refuse a release while README.md still says merged, unreleased."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

LABEL = 'merged, unreleased'


def contains_unreleased_label(text):
    """Return True when text contains the unreleased status label, any capitalization."""
    return LABEL in text.casefold()


def assert_no_unreleased_label(readme):
    """Raise ValueError when the release README is missing or still unreleased."""
    path = Path(readme)
    if not path.is_file():
        raise ValueError(f'{path.name} is missing; the release README must be present and free of unreleased labels')
    if contains_unreleased_label(path.read_text(encoding='utf-8')):
        raise ValueError(
            f'{path.name} still contains "merged, unreleased"; '
            'update status labels for this release before tagging or packing')


def current_branch():
    """Prefer the CI branch name, then the local checkout."""
    if 'BUILDKITE_BRANCH' in os.environ:
        return os.environ['BUILDKITE_BRANCH'].strip()
    try:
        return subprocess.run(
            ['git', 'branch', '--show-current'],
            check=True, text=True, capture_output=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ''


def is_release_branch(name):
    return name.startswith('chore/release-')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('readme', nargs='?', type=Path, default=Path('README.md'))
    parser.add_argument('--if-release-branch', action='store_true',
                        help='Check only on chore/release-* branches; other branches pass')
    args = parser.parse_args(argv)
    if args.if_release_branch and not is_release_branch(current_branch()):
        print('README release check skipped: not a chore/release-* branch')
        return 0
    try:
        assert_no_unreleased_label(args.readme)
    except ValueError as exc:
        print(f'release blocked: {exc}', file=sys.stderr)
        return 1
    print('README release check passed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
