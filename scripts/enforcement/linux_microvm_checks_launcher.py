#!/usr/bin/python3
"""Owner-installed SSH subsystem; no shell, installs, owner payload or live credentials.

Requires an independently reviewed pinned guest image implementing the serial
protocol and the shipped killswitch. This launcher does not fabricate that image,
its armed marker, check results or permission to run it.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time

CONFIG = '/etc/pad/guest-checks.json'
MAX_BUNDLE = 16 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def trusted_file(path, owner_uid=0, check_ancestors=True):
    p = Path(path)
    if not p.is_absolute() or str(p.resolve()) != str(p):
        raise ValueError('noncanonical pin path')
    if check_ancestors:
        for parent in p.parents:
            s = parent.stat()
            if s.st_uid != owner_uid or s.st_mode & 0o022:
                raise ValueError('untrusted pin directory')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    s = os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_uid != owner_uid or s.st_mode & 0o022:
        os.close(fd)
        raise ValueError('untrusted pin file')
    return os.fdopen(fd, 'rb')


def validate_config(cfg, owner_uid=0, check_ancestors=True):
    if set(cfg) != {'schema', 'pins', 'checks', 'vcpus', 'memoryMiB', 'timeoutSeconds', 'runDir'} or cfg['schema'] != 'pad-guest-launcher.v1':
        raise ValueError('invalid config')
    if set(cfg['pins']) != {'image', 'initramfs', 'kernel', 'taxonomy', 'firecracker'}:
        raise ValueError('missing image pins')
    for pin in cfg['pins'].values():
        if set(pin) != {'path', 'sha256'} or not re.fullmatch('[a-f0-9]{64}', pin['sha256']):
            raise ValueError('invalid pin')
        h = hashlib.sha256()
        with trusted_file(pin['path'], owner_uid, check_ancestors) as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        if h.hexdigest() != pin['sha256']:
            raise ValueError('pin mismatch')
    if not isinstance(cfg['checks'], list) or not cfg['checks'] or len(cfg['checks']) > 32 or len(set(cfg['checks'])) != len(cfg['checks']) or not all(isinstance(c, str) and re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,80}', c) for c in cfg['checks']):
        raise ValueError('invalid allowlist')
    for key in ('vcpus', 'memoryMiB', 'timeoutSeconds'):
        if type(cfg[key]) is not int or cfg[key] < 1:
            raise ValueError('invalid budget')
    if cfg['timeoutSeconds'] > 600:
        raise ValueError('deadline exceeds frozen check cap')
    run_dir = Path(cfg['runDir'])
    s = run_dir.stat()
    if not run_dir.is_absolute() or str(run_dir.resolve()) != str(run_dir) or not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise ValueError('untrusted run directory')
    return cfg


def read_request(stream, cfg):
    line = stream.readline(8193)
    if len(line) > 8192 or not line.endswith(b'\n'):
        raise ValueError('invalid request frame')
    req = json.loads(line)
    if isinstance(req, dict) and set(req) == {'schema', 'jobId'} and req['schema'] == 'pad-ssh-guest-probe.v1':
        if not isinstance(req['jobId'], str) or not re.fullmatch('[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', req['jobId']) or stream.read(1):
            raise ValueError('invalid probe')
        return req, None
    if not isinstance(req, dict) or set(req) != {'schema', 'jobId', 'checkoutSha256', 'checkId'} or req['schema'] != 'pad-ssh-guest-check.v1' or not re.fullmatch('[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', req['jobId']) or not re.fullmatch('[a-f0-9]{64}', req['checkoutSha256']) or req['checkId'] not in cfg['checks']:
        raise ValueError('request not allowlisted')
    encoded = stream.readline(24 * 1024 * 1024 + 1)
    if len(encoded) > 24 * 1024 * 1024 or not encoded.endswith(b'\n') or stream.read(1):
        raise ValueError('invalid bundle frame')
    bundle = base64.b64decode(encoded[:-1], validate=True)
    if not bundle or len(bundle) > MAX_BUNDLE or digest(bundle) != req['checkoutSha256']:
        raise ValueError('checkout mismatch')
    return req, bundle


def channel_closed():
    poll = select.poll()
    poll.register(sys.stdout.fileno(), select.POLLERR | select.POLLHUP)
    return bool(poll.poll(0))


def run_job(cfg, req, bundle, emit, disconnected=channel_closed, cancelled=lambda: False):
    if cancelled() or disconnected():
        return 126
    directory = Path(cfg['runDir']) / req['jobId']
    directory.mkdir(mode=0o700)  # exclusive intent: never overwrite or retry
    with (directory / 'request.json').open('x') as saved_request:
        saved_request.write(json.dumps(req))
        saved_request.flush()
        os.fsync(saved_request.fileno())
    for path in (directory, directory.parent):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    checkout = directory / 'checkout.block'
    checkout.write_bytes(bundle + b'\0' * ((-len(bundle)) % 4096))
    checkout.chmod(0o400)
    pins = {k: cfg['pins'][k]['sha256'] for k in ('image', 'initramfs', 'taxonomy', 'kernel', 'firecracker')}
    args = 'console=ttyS0 quiet loglevel=0 reboot=k panic=1 pci=off root=/dev/vda ro rootfstype=ext4 rdinit=/init'
    args += f' pad_job={req["jobId"]} pad_bundle={req["checkoutSha256"]} pad_bundle_bytes={len(bundle)} pad_check={req["checkId"]}'
    vm = {'boot-source': {'kernel_image_path': cfg['pins']['kernel']['path'], 'initrd_path': cfg['pins']['initramfs']['path'], 'boot_args': args},
          'drives': [{'drive_id': 'rootfs', 'path_on_host': cfg['pins']['image']['path'], 'is_root_device': True, 'is_read_only': True},
                     {'drive_id': 'checkout', 'path_on_host': str(checkout), 'is_root_device': False, 'is_read_only': True}],
          'machine-config': {'vcpu_count': cfg['vcpus'], 'mem_size_mib': cfg['memoryMiB']}}
    config = directory / 'vm.json'
    config.write_text(json.dumps(vm))
    emit({'type': 'preflight', 'jobId': req['jobId'], 'verified': True, 'pins': pins})
    process = None
    watchdog = False
    interrupted = False
    log = bytearray()
    try:
        # Firecracker exits on guest poweroff; no persistent domain or API socket.
        if cancelled():
            return 126
        if disconnected():
            return 126
        process = subprocess.Popen([cfg['pins']['firecracker']['path'], '--no-api', '--config-file', str(config)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        streams = [process.stdout, process.stderr]
        deadline = time.monotonic() + cfg['timeoutSeconds']
        errors = 0
        with (directory / 'serial.log').open('xb') as saved:
            while streams:
                watchdog = time.monotonic() >= deadline
                interrupted = cancelled() or disconnected()
                if watchdog or interrupted:
                    break
                ready, _, _ = select.select(streams, [], [], 0.05)
                for stream in ready:
                    chunk = os.read(stream.fileno(), 65536)
                    if not chunk:
                        streams.remove(stream)
                    elif stream is process.stdout:
                        log.extend(chunk)
                        saved.write(chunk)
                        saved.flush()
                        if len(log) > 4 * 1024 * 1024:
                            interrupted = True
                            break
                        emit({'type': 'serial', 'bytes': base64.b64encode(chunk).decode('ascii')})
                    else:
                        errors += len(chunk)
                        if errors > 262144:
                            interrupted = True
                            break
                if interrupted:
                    break
    finally:
        if process is not None:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()
    destroyed = process is not None and process.poll() is not None
    emit({'type': 'teardown', 'jobId': req['jobId'], 'destroyed': destroyed, 'watchdog': watchdog or interrupted, 'logSha256': digest(log)})
    return 0 if destroyed and not watchdog and not interrupted and process.returncode == 0 else 126


def main():
    if sys.platform != 'linux' or len(sys.argv) != 1 or os.geteuid() == 0 or os.environ.get('SSH_ORIGINAL_COMMAND', '') not in ('', 'pad-guest-check-v1', '/usr/bin/python3 -I -B /usr/local/libexec/pad-guest-check-v1.py'):
        return 126
    os.umask(0o077)
    with trusted_file(CONFIG) as f:
        if os.fstat(f.fileno()).st_size > 65536:
            raise ValueError('config too large')
        cfg = validate_config(json.load(f))
    req, bundle = read_request(sys.stdin.buffer, cfg)
    stopped = [False]
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stopped.__setitem__(0, True))
    def emit(value):
        sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    if bundle is None:
        emit({'type': 'preflight', 'jobId': req['jobId'], 'verified': True, 'pins': {k: cfg['pins'][k]['sha256'] for k in ('image', 'initramfs', 'taxonomy', 'kernel', 'firecracker')}})
        return 0
    return run_job(cfg, req, bundle, emit, cancelled=lambda: stopped[0])


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # No fake pass, fallback shell or retry. Any partial guest log remains in
        # its exclusive private job directory for operator diagnosis.
        sys.exit(126)
