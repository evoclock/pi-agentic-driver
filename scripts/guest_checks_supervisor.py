#!/usr/bin/env python3
"""PID1-only supervisor for the pinned PAD guest; check children never own the serial channel."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import selectors
import signal
import subprocess
import sys
import tarfile
import time

LIMIT = 16 * 1024 * 1024
STATE = Path('/run/pad/containment')

def digest(value):
    return hashlib.sha256(value).hexdigest()

def parse_job(cmdline, checks):
    fields = {}
    for word in cmdline.split():
        key, sep, value = word.partition('=')
        if key.startswith('pad_'):
            if not sep or key in fields:
                raise ValueError('duplicate boot identity')
            fields[key] = value
    if set(fields) != {'pad_job', 'pad_bundle', 'pad_bundle_bytes', 'pad_check'}:
        raise ValueError('missing boot identity')
    if not re.fullmatch('[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', fields['pad_job']) or not re.fullmatch('[a-f0-9]{64}', fields['pad_bundle']):
        raise ValueError('invalid boot identity')
    if not fields['pad_bundle_bytes'].isdigit() or not 1 <= int(fields['pad_bundle_bytes']) <= LIMIT or fields['pad_check'] not in checks:
        raise ValueError('unknown check or invalid bundle size')
    return {'jobId': fields['pad_job'], 'checkoutSha256': fields['pad_bundle'], 'bundleBytes': int(fields['pad_bundle_bytes']), 'checkId': fields['pad_check']}

def checked_members(bundle):
    if not bundle or len(bundle) > LIMIT:
        raise ValueError('bundle size')
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:') as archive:
        members = archive.getmembers()
    names = set(); total = 0
    for row in members:
        path = PurePosixPath(row.name)
        if path.is_absolute() or '..' in path.parts or str(path) != row.name.rstrip('/') or str(path) in names or not (row.isfile() or row.isdir()) or row.sparse:
            raise ValueError('unsafe checkout entry')
        names.add(str(path)); total += row.size
    if len(members) > 20000 or total > 128 * 1024 * 1024:
        raise ValueError('checkout expansion budget')
    return members

def extract_checkout(bundle, directory):
    members = checked_members(bundle)
    directory.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(bundle), mode='r:') as archive:
        for row in members:
            path = directory / row.name
            if row.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open('xb') as target:
                    target.write(archive.extractfile(row).read())
                path.chmod(0o555 if row.mode & 0o111 else 0o444)
    for path in sorted(directory.rglob('*'), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
    directory.chmod(0o555)

def unprivileged():
    import ctypes
    os.setgroups([]); os.setgid(65534); os.setuid(65534)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError('no-new-privileges unavailable')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))

def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=5)

def start_monitor(kind):
    if kind == 'net':
        sweep = 'gc_net_sweep "$state" "$baseline" /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6'
    else:
        sweep = 'find /work /tmp -xdev -type f -newer "$state/baseline" -print | while IFS= read -r p; do gc_fs_detect "$state" "$p" >/dev/null 2>&1 || true; done; gc_baseline_retreat "$state/baseline"'
    # Both sweep processes update Testudo's shared sequence, pressure and kill state.
    locked_sweep = 'flock -x 9 || exit 126; ' + sweep + '; flock -u 9 || exit 126'
    script = '. /run/pad/monitor.sh; state=/run/pad/containment; baseline=""; exec 9>"$state/transition.lock"; ' + locked_sweep + '; touch "$state/ready-' + kind + '"; while :; do ' + locked_sweep + '; sleep 0.1; done'
    return subprocess.Popen(['/bin/sh', '-c', script], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TESTUDO_GUEST_WORKSPACE': '/work/checkout/.scratch', 'TESTUDO_GUEST_WRITABLE_PATHS': '/work/checkout/.scratch /work/checkout/.local /tmp/session'})

def execute_check(check, cwd, monitors):
    if (STATE/'kill').exists() or not monitors or any(p.poll() is not None for p in monitors):
        return 126, b''
    output = bytearray(); code = 126
    child = subprocess.Popen(check['command'], cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             close_fds=True, start_new_session=True, preexec_fn=unprivileged,
                             env={'PATH': '/usr/bin:/bin', 'HOME': '/tmp/session', 'TMPDIR': '/tmp/session', 'LANG': 'C.UTF-8', 'CI': '1'})
    selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + check['timeoutSeconds']
    try:
        while child.poll() is None or selector.get_map():
            if (STATE/'kill').exists() or any(p.poll() is not None for p in monitors):
                code = 126; break
            if time.monotonic() >= deadline:
                code = 124; break
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    output.extend(chunk)
                    if len(output) > 4 * 1024 * 1024:
                        return 126, bytes(output[:4*1024*1024])
        else:
            code = child.wait(timeout=5)
            if code < 0:
                code = 128 - code
        if (STATE/'kill').exists() or any(p.poll() is not None for p in monitors):
            code = 126
        return code, bytes(output)
    finally:
        selector.close(); stop(child); child.stdout.close()

def emit(record):
    print(json.dumps(record, separators=(',', ':')), flush=True)

def main():
    if sys.platform != 'linux' or os.getpid() != 1 or os.geteuid() != 0:
        return 126
    os.umask(0o077)
    config = json.loads(Path('/run/pad/checks.json').read_text())
    if config.get('schema') != 'pad-guest-supervisor.v1':
        return 126
    for key, path in [('monitor', '/run/pad/monitor.sh'), ('taxonomy', '/run/pad/taxonomy.json')]:
        if digest(Path(path).read_bytes()) != config['sourcePins'][key]:
            return 126
    job = parse_job(Path('/proc/cmdline').read_text(), config['checks'])
    with open('/dev/vdb', 'rb') as source:
        bundle = source.read(job['bundleBytes'])
    if len(bundle) != job['bundleBytes'] or digest(bundle) != job['checkoutSha256']:
        return 126
    checkout = Path('/work/checkout'); extract_checkout(bundle, checkout)
    for path in (checkout/'.scratch', checkout/'.local', Path('/tmp/session')):
        if path.exists():
            return 126
        path.mkdir(mode=0o700); os.chown(path, 65534, 65534)
    STATE.mkdir(mode=0o700)
    (STATE/'taxonomy.json').write_bytes(Path('/run/pad/taxonomy.json').read_bytes())
    (STATE/'baseline').touch()
    monitors = []
    try:
        monitors = [start_monitor('net'), start_monitor('fs')]
        deadline = time.monotonic() + 5
        while not all((STATE/('ready-'+kind)).exists() for kind in ('net', 'fs')):
            if time.monotonic() >= deadline or any(p.poll() is not None for p in monitors):
                return 126
            time.sleep(0.01)
        check = config['checks'][job['checkId']]
        expected = digest(json.dumps(check['command'], separators=(',', ':'), ensure_ascii=False).encode())
        if check['commandSha256'] != expected or (STATE/'kill').exists():
            return 126
        cwd = (checkout/check['cwd']).resolve()
        if not cwd.is_relative_to(checkout):
            return 126
        emit({'kind': 'header', 'jobId': job['jobId'], 'checkId': job['checkId'], 'checkoutSha256': job['checkoutSha256'], 'taxonomySha256': config['sourcePins']['taxonomy']})
        emit({'kind': 'armed', 'jobId': job['jobId']})
        code, output = execute_check(check, cwd, monitors)
        emit({'kind': 'result', 'jobId': job['jobId'], 'checkId': job['checkId'], 'source': 'guest', 'commandSha256': expected, 'exitStatus': code, 'outputBase64': base64.b64encode(output).decode()})
        return 0
    finally:
        for process in monitors:
            stop(process)

if __name__ == '__main__':
    status = 126
    try:
        status = main()
    except Exception:
        pass
    if sys.platform == 'linux' and os.getpid() == 1 and os.geteuid() == 0:
        subprocess.run(['/run/pad/busybox', 'poweroff', '-f'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    raise SystemExit(status)
