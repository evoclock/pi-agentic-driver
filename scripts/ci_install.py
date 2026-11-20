#!/usr/bin/env python3
"""Build-local install publication; lock-keyed npm downloads stay agent-local.

Run only from Buildkite. Installs use sfw, ignore lifecycle scripts, and are
copied (never hard-linked) so tests cannot write through to another job.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PROJECTS = ('', 'janus')


def cache_key(root: Path, runtime: str) -> str:
    digest = hashlib.sha256(runtime.encode())
    for prefix in PROJECTS:
        for name in ('package.json', 'package-lock.json'):
            path = root / prefix / name
            if path.is_symlink() or not path.is_file():
                raise ValueError(f'install input missing or linked: {prefix}/{name}')
            digest.update(f'\0{prefix}/{name}\0'.encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def install(root: Path, cache: Path, build: str, trust: str, runtime: str, run=subprocess.run) -> str:
    if not build or trust not in {'main', 'pr'}:
        raise ValueError('a build identity and main/pr namespace are required')
    key = cache_key(root, runtime)
    build_key = hashlib.sha256(build.encode()).hexdigest()
    directory = cache / 'builds' / trust / build_key
    directory.mkdir(parents=True, exist_ok=True)
    published = directory / key
    expected = {'key': key, 'runtime': runtime}
    with (directory / f'{key}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not published.exists():
            with tempfile.TemporaryDirectory(prefix=f'{key}-', dir=directory) as temporary:
                staging = Path(temporary) / 'install'
                staging.mkdir()
                environment = {**os.environ, 'npm_config_cache': str(cache / 'downloads' / trust / key)}
                for index, prefix in enumerate(PROJECTS):
                    project = root / prefix
                    run(['sfw', 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=project, env=environment, check=True)
                    shutil.copytree(project / 'node_modules', staging / str(index), symlinks=True)
                if cache_key(root, runtime) != key:
                    raise ValueError('install inputs changed during installation')
                (staging / 'complete.json').write_text(json.dumps(expected))
                staging.rename(published)
            return 'installed'
        if published.is_symlink() or json.loads((published / 'complete.json').read_text()) != expected:
            raise ValueError('install cache publication does not match its key')
        for index, prefix in enumerate(PROJECTS):
            source = published / str(index)
            if source.is_symlink() or not source.is_dir():
                raise ValueError('cached node_modules must be a real directory')
            target = root / prefix / 'node_modules'
            if target.is_symlink():
                target.unlink()
            elif target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target, symlinks=True)
        return 'restored'


def main() -> None:
    build = os.environ.get('BUILDKITE_BUILD_ID')
    if not build:
        raise ValueError('BUILDKITE_BUILD_ID is required; use sfw for local installs')
    root = Path(__file__).resolve().parents[1]
    runtime = subprocess.check_output(['node', '-p', 'JSON.stringify([process.version,process.platform,process.arch,process.versions.modules])'], text=True).strip()
    runtime += '/' + subprocess.check_output(['npm', '--version'], text=True).strip()
    trust = 'main' if os.environ.get('BUILDKITE_PULL_REQUEST', 'false') == 'false' else 'pr'
    cache = Path(os.environ.get('BUILDKITE_AGENT_CACHE_PATH', str(Path.home() / '.cache'))) / 'pad-ci'
    print(f'CI dependencies: {install(root, cache, build, trust, runtime)}', flush=True)


if __name__ == '__main__':
    main()
