#!/usr/bin/env python3
"""Fetch the configured base and require it in HEAD; never merge or repair refs."""
from __future__ import annotations

import argparse
import json
import os
import re
import socket
from pathlib import Path
import subprocess
import sys

STALE = 'stale base: merge {base} (--no-ff) and re-baseline'


class FreshnessError(Exception):
    """An unobservable or stale base is an infrastructure prerequisite failure."""


def git(root: Path, *args: str) -> str:
    completed = subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, timeout=60)
    if completed.returncode:
        # Do not echo remotes, credentials or machine-specific stderr into durable evidence.
        raise FreshnessError('base freshness: git observation failed (' + args[0] + ')')
    return completed.stdout.strip()


def check(root: Path, base: str, *, expected_base: str | None = None,
          expected_head: str | None = None, lease_start: bool = False) -> dict:
    if not base or base.startswith('-'):
        raise FreshnessError('base freshness: invalid base ref')
    if base.startswith('origin/'):
        branch = base.removeprefix('origin/')
        git(root, 'check-ref-format', 'refs/heads/' + branch)
        git(root, 'fetch', '--quiet', '--no-tags', 'origin',
            'refs/heads/' + branch + ':refs/remotes/origin/' + branch)
    tip = git(root, 'rev-parse', '--verify', base + '^{commit}')
    head = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', tip, head],
                              cwd=root, capture_output=True, timeout=60)
    if ancestor.returncode == 1:
        raise FreshnessError(STALE.format(base=base))
    if ancestor.returncode:
        raise FreshnessError('base freshness: ancestry could not be observed')
    if expected_base is not None and tip != expected_base:
        raise FreshnessError('stale base: fetched base differs from the verified generation; re-baseline')
    if expected_head is not None and head != expected_head:
        raise FreshnessError('base freshness: HEAD changed during baseline; re-baseline')
    record = {'schema': 'driver-base-freshness.v1', 'head': head, 'baseRef': base,
              'fetchedBase': tip, 'integrationBase': git(root, 'merge-base', tip, head)}
    if lease_start:
        if head != tip:
            raise FreshnessError('base freshness: a lease must start exactly at the fetched base tip')
        target = root / '.local/lease-base.json'
        if (root / '.local').is_symlink() or target.is_symlink():
            raise FreshnessError('base freshness: lease record must not be a symlink')
        record['leaseBase'] = head
        target.parent.mkdir(exist_ok=True)
        # Exclusive creation prevents silently replacing the recorded start of a lease.
        with target.open('x', encoding='utf-8') as stream:
            stream.write(json.dumps(record, sort_keys=True) + '\n')
    return record


def contained_observation(root: Path) -> tuple[str, str]:
    """Only the existing verified, network-none acceptance image can use offline pins."""
    if (sys.platform != 'linux' or root != Path('/scratch/work') or os.geteuid() != 65534
            or {name for _, name in socket.if_nameindex()} != {'lo'}):
        raise FreshnessError('contained observation requires verified network-none execution')
    status = Path('/proc/self/status').read_text()
    if (not re.search(r'(?m)^NoNewPrivs:\s+1$', status)
            or not re.search(r'(?m)^CapEff:\s+0+$', status)
            or not os.statvfs('/source').f_flag & os.ST_RDONLY):
        raise FreshnessError('contained observation requires immutable source and restricted execution')
    base = os.environ.get('PAD_OBSERVABILITY_BASE', '')
    head = os.environ.get('PAD_OBSERVABILITY_HEAD', '')
    if not all(re.fullmatch(r'[0-9a-f]{40}', value) for value in (base, head)):
        raise FreshnessError('contained observation requires an exact host base/head pair')
    source = Path('/source')
    args = ('-c', 'safe.directory=/source', '-c', 'core.fsmonitor=false')
    if (git(source, *args, 'rev-parse', 'HEAD^{commit}') != head
            or git(source, *args, 'rev-parse', 'main^{commit}') != base):
        raise FreshnessError('contained observation differs from immutable host source')
    return base, head


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--expected-base')
    parser.add_argument('--expected-head')
    parser.add_argument('--lease-start', action='store_true')
    parser.add_argument('--print-base', action='store_true', help='print only the verified base commit for a bounded handoff')
    parser.add_argument('--contained-observation', action='store_true', help='validate the actual offline acceptance boundary and immutable host pins')
    options = parser.parse_args()
    try:
        root = options.root.resolve()
        if options.contained_observation:
            base, head = contained_observation(root)
            if options.expected_base != base or options.expected_head != head or options.base != 'main':
                raise FreshnessError('contained observation does not match requested base/head')
        record = check(root, options.base, expected_base=options.expected_base,
                       expected_head=options.expected_head, lease_start=options.lease_start)
    except (FreshnessError, OSError, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, FreshnessError) else 'base freshness: observation or lease record failed'
        # Data-only stdout is captured by shell callers; never swallow rejection diagnostics.
        print('BLOCKED [base-freshness]: ' + reason, file=sys.stderr if options.print_base else sys.stdout)
        return 3
    print(record['fetchedBase'] if options.print_base else 'BASE_FRESHNESS_RESULT ' + json.dumps(record, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
