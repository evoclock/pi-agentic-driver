#!/usr/bin/env python3
"""Prepare pinned development checker tools on the host, before network-none execution.

No installer scripts run. Socket Firewall wraps downloads; hashes are verified
before extracting the JDK data archive or exposing the TLC jar to the container.
The destination is private to one CI job, not a cross-build installation cache.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def download(asset, target):
    subprocess.run(['sfw', 'curl', '--fail', '--location', '--proto', '=https', '--tlsv1.2',
                    '--max-time', '180', asset['url'], '-o', str(target)], check=True, timeout=190)


def install_tools(target, manifest, fetch=download):
    target = Path(target)
    if target.is_symlink():
        raise ValueError('tool destination must not be linked')
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='checker-', dir=target) as temporary:
        stage = Path(temporary)
        for name, filename in [('jdk', 'jdk.tar.gz'), ('tlc', 'tla2tools.jar')]:
            asset = manifest[name]
            if not asset['url'].startswith('https://') or len(asset['sha256']) != 64:
                raise ValueError('checker tools require exact HTTPS/hash pins')
            path = stage / filename
            fetch(asset, path)
            if hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                raise ValueError('checker tool checksum mismatch: ' + name)
        extracted = stage / 'extracted'; extracted.mkdir()
        with tarfile.open(stage / 'jdk.tar.gz') as archive:
            archive.extractall(extracted, filter='data')
        jdk = extracted / manifest['jdk']['directory']
        if not (jdk / 'bin/java').is_file() or not (jdk / 'lib/modules').is_file():
            raise ValueError('JDK archive has no compiler-capable runtime layout')
        destination = target / 'jdk'
        if destination.exists():
            raise ValueError('checker tools already prepared; use a fresh job directory')
        jdk.rename(destination)
        (stage / 'tla2tools.jar').replace(target / 'tla2tools.jar')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'config/ci-tlc-tools.v1.json').read_text())
    print(install_tools(args.output, manifest))
