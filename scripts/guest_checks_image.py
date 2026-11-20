#!/usr/bin/env python3
"""Assemble a deterministic guest initramfs from existing pinned inputs; never install or boot."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat

TESTUDO_COMMIT = '92796bc7d487b6c0a8b9128be87653f17898742b'
SOURCE_PINS = {'monitor': 'd2aa2b380bb2855fcb75a1feeda72877f8e59f658697b409d8581503a5b4e97c',
               'taxonomy': '0b194cdfd86f23fd68c2685c2ccfc556a0e311e2973b1ff619c6c78791d65fcd'}
ASSETS = {'image', 'kernel', 'firecracker', 'busybox', 'monitor', 'taxonomy'}
INIT = b'''#!/bin/busybox sh
set -eu
B=/bin/busybox
$B mount -t devtmpfs -o nosuid devtmpfs /dev
$B mount -t ext4 -o ro,nosuid /dev/vda /rootfs
$B mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /rootfs/run
$B mkdir -p /rootfs/run/pad
$B chmod 700 /rootfs/run/pad
$B cp /pad/* /rootfs/run/pad/
$B cp /bin/busybox /rootfs/run/pad/busybox
$B mount --bind /dev /rootfs/dev
$B mount -t proc -o hidepid=2,nosuid,nodev,noexec proc /rootfs/proc
$B mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /rootfs/tmp
$B mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /rootfs/work
exec $B chroot /rootfs /usr/bin/python3 -I -B /run/pad/supervisor.py
'''

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def digest(value):
    return hashlib.sha256(value).hexdigest()

def validate_recipe(recipe):
    fields = {'schema', 'testudoCommit', 'assets', 'sourceDateEpoch', 'checks'}
    if not isinstance(recipe, dict) or set(recipe) != fields or recipe['schema'] != 'pad-guest-image-recipe.v1':
        raise ValueError('invalid image recipe')
    if recipe['testudoCommit'] != TESTUDO_COMMIT or type(recipe['sourceDateEpoch']) is not int or not 0 <= recipe['sourceDateEpoch'] <= 0xffffffff:
        raise ValueError('unreviewed source or epoch')
    if not isinstance(recipe['assets'], dict) or set(recipe['assets']) != ASSETS:
        raise ValueError('all pinned inputs required')
    checks = recipe['checks']
    if not isinstance(checks, dict) or not 1 <= len(checks) <= 32:
        raise ValueError('fixed check map required')
    for name, row in checks.items():
        if not re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,80}', name) or not isinstance(row, dict) or set(row) != {'command', 'cwd', 'timeoutSeconds'}:
            raise ValueError('invalid fixed check')
        command, cwd, timeout = row['command'], row['cwd'], row['timeoutSeconds']
        if not isinstance(command, list) or not 1 <= len(command) <= 64 or any(not isinstance(arg, str) or '\0' in arg or len(arg) > 8192 for arg in command) or not (command[0].startswith('/') or re.fullmatch('[A-Za-z0-9_.+-]+', command[0])):
            raise ValueError('fixed argv required')
        if not isinstance(cwd, str) or Path(cwd).is_absolute() or '..' in Path(cwd).parts or '\0' in cwd:
            raise ValueError('unsafe check directory')
        if type(timeout) is not int or not 1 <= timeout <= 600:
            raise ValueError('invalid check timeout')
    data = {}
    for name in sorted(ASSETS):
        pin = recipe['assets'][name]
        if not isinstance(pin, dict) or set(pin) != {'path', 'sha256'} or not isinstance(pin['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', pin['sha256']):
            raise ValueError('invalid artifact pin')
        path = Path(pin['path'])
        if not path.is_absolute() or path.resolve() != path or not path.is_file() or path.stat().st_size > 512*1024*1024:
            raise ValueError('unsafe or oversized input')
        data[name] = path.read_bytes()
        if not data[name] or digest(data[name]) != pin['sha256']:
            raise ValueError('artifact digest mismatch')
        if name in SOURCE_PINS and pin['sha256'] != SOURCE_PINS[name]:
            raise ValueError('Testudo source pin mismatch')
    return data

def pack_newc(entries, epoch):
    output = bytearray()
    for ino, (name, mode, data) in enumerate([*entries, ('TRAILER!!!', 0, b'')], 1):
        encoded = name.encode() + b'\0'
        major, minor = (5, 1) if name == 'dev/console' else (0, 0)
        values = [ino, mode, 0, 0, 1, epoch, len(data), 0, 0, major, minor, len(encoded), 0]
        output.extend(b'070701' + ''.join(f'{n:08x}' for n in values).encode())
        output.extend(encoded); output.extend(b'\0' * (-len(output) % 4))
        output.extend(data); output.extend(b'\0' * (-len(output) % 4))
    return bytes(output)

def build_image(recipe, directory):
    directory = Path(directory)
    if directory.exists() or directory.is_symlink():
        raise FileExistsError('output already exists')
    data = validate_recipe(recipe)
    supervisor = Path(__file__).with_name('guest_checks_supervisor.py').read_bytes()
    checks = {name: {**row, 'commandSha256': digest(canonical(row['command']))} for name, row in sorted(recipe['checks'].items())}
    config = {'schema': 'pad-guest-supervisor.v1', 'checks': checks, 'sourcePins': dict(SOURCE_PINS)}
    entries = [(name, stat.S_IFDIR | 0o755, b'') for name in ('bin', 'dev', 'pad', 'rootfs')]
    entries += [('dev/console', stat.S_IFCHR | 0o600, b''), ('bin/busybox', stat.S_IFREG | 0o755, data['busybox']), ('init', stat.S_IFREG | 0o755, INIT),
                ('pad/supervisor.py', stat.S_IFREG | 0o444, supervisor), ('pad/checks.json', stat.S_IFREG | 0o444, canonical(config)),
                ('pad/monitor.sh', stat.S_IFREG | 0o555, data['monitor']), ('pad/taxonomy.json', stat.S_IFREG | 0o444, data['taxonomy'])]
    initramfs = pack_newc(sorted(entries), recipe['sourceDateEpoch'])
    manifest = {'schema': 'pad-guest-image-manifest.v1', 'testudoCommit': TESTUDO_COMMIT,
                'sourceDateEpoch': recipe['sourceDateEpoch'], 'checks': checks,
                'sources': {**dict(SOURCE_PINS), 'supervisor': digest(supervisor), 'busybox': digest(data['busybox'])},
                'pins': {**{name: digest(data[name]) for name in ('image', 'kernel', 'firecracker', 'taxonomy')}, 'initramfs': digest(initramfs)}}
    directory = Path(directory)
    directory.mkdir(mode=0o700)
    for name in ('image', 'kernel', 'firecracker', 'taxonomy'):
        path = directory / name
        path.write_bytes(data[name]); path.chmod(0o555 if name == 'firecracker' else 0o444)
    (directory / 'initramfs.cpio').write_bytes(initramfs)
    (directory / 'image-manifest.json').write_bytes(canonical(manifest) + b'\n')
    return manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recipe', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    manifest = build_image(json.loads(args.recipe.read_text()), args.out)
    print(json.dumps({'schema': manifest['schema'], 'pins': manifest['pins'], 'imageManifestSha256': digest((args.out/'image-manifest.json').read_bytes())}))

if __name__ == '__main__':
    main()
