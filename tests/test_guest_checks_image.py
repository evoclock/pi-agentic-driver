import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import sys
import os
import shlex
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    path = ROOT / 'scripts' / (name + '.py')
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

IMAGE = module('guest_checks_image')
GUEST = module('guest_checks_supervisor')

class ImageTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(IMAGE, 'offline pinned image recipe required')
        self.assertIsNotNone(GUEST, 'protected guest supervisor required')
        parent = ROOT / '.scratch/g8b-image-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=parent))
        self.addCleanup(shutil.rmtree, self.root)
        self.assets = {}
        for name in ('image', 'kernel', 'firecracker', 'busybox', 'monitor', 'taxonomy'):
            path = self.root / name
            path.write_bytes(b'fixture-' + name.encode())
            self.assets[name] = {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        self.recipe = {'schema': 'pad-guest-image-recipe.v1', 'testudoCommit': IMAGE.TESTUDO_COMMIT,
                       'assets': self.assets, 'sourceDateEpoch': 1,
                       'checks': {'syntax': {'command': ['/usr/bin/python3', '-m', 'unittest'], 'cwd': '.', 'timeoutSeconds': 10}}}

    def test_pins_fail_before_output(self):
        """Why: no image may be published from unverified or substituted source bytes."""
        with self.assertRaises(ValueError):
            IMAGE.build_image(self.recipe, self.root / 'bad')
        self.assertFalse((self.root / 'bad').exists())
        changed = json.loads(json.dumps(self.recipe))
        changed['testudoCommit'] = '0' * 40
        with self.assertRaises(ValueError):
            IMAGE.validate_recipe(changed)

    def test_mutated_input_bytes_are_refused(self):
        """Why: validating a manifest digest alone cannot replace hashing the actual supplied artifact."""
        pins = {name: self.assets[name]['sha256'] for name in ('monitor', 'taxonomy')}
        Path(self.assets['kernel']['path']).write_bytes(b'changed-after-pinning')
        with patch.object(IMAGE, 'SOURCE_PINS', pins):
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                IMAGE.validate_recipe(self.recipe)

    def test_closed_recipe_rejects_argv_and_path_injection(self):
        """Why: recipe inputs select pinned data, not an install command or escaped working directory."""
        for change in ({'install': ['sh', '-c', 'false']}, {'sourceDateEpoch': True}):
            with self.assertRaises(ValueError):
                IMAGE.validate_recipe({**self.recipe, **change})
        for cwd in ('../outside', '/outside'):
            value = json.loads(json.dumps(self.recipe))
            value['checks']['syntax']['cwd'] = cwd
            with self.assertRaises(ValueError):
                IMAGE.validate_recipe(value)

    def test_fixture_assembly_is_byte_reproducible_and_manifest_bound(self):
        """Why: deterministic packing binds exact input bytes and fixed argv; fixture blobs are not a bootable guest."""
        pins = {name: self.assets[name]['sha256'] for name in ('monitor', 'taxonomy')}
        with patch.object(IMAGE, 'SOURCE_PINS', pins):
            first = IMAGE.build_image(self.recipe, self.root / 'one')
            second = IMAGE.build_image(self.recipe, self.root / 'two')
        self.assertEqual(first, second)
        archive = (self.root / 'one/initramfs.cpio').read_bytes()
        self.assertEqual(archive, (self.root / 'two/initramfs.cpio').read_bytes())
        self.assertEqual(first['pins']['initramfs'], hashlib.sha256(archive).hexdigest())
        self.assertEqual(first['checks']['syntax']['commandSha256'], hashlib.sha256(b'["/usr/bin/python3","-m","unittest"]').hexdigest())
        self.assertEqual(first['pins']['image'], self.assets['image']['sha256'])
        self.assertEqual(first['testudoCommit'], IMAGE.TESTUDO_COMMIT)
        self.assertFalse(any(str(self.root) in str(value) for value in first.values()))
        with self.assertRaises(FileExistsError):
            IMAGE.build_image(self.recipe, self.root / 'one')
        entries = {}; offset = 0
        while offset < len(archive):
            self.assertEqual(archive[offset:offset+6], b'070701')
            fields = [int(archive[offset+6+i*8:offset+14+i*8], 16) for i in range(13)]
            name = archive[offset+110:offset+110+fields[11]-1].decode()
            entries[name] = fields
            self.assertEqual(fields[2:4], [0, 0])
            offset = (offset+110+fields[11]+3)//4*4
            offset = (offset+fields[6]+3)//4*4
            if name == 'TRAILER!!!':
                break
        self.assertEqual(entries['dev/console'][9:11], [5, 1])
        self.assertEqual(entries['dev/console'][1], 0o20600)
        self.assertEqual(entries['pad/supervisor.py'][1], 0o100444)

class GuestTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(GUEST, 'protected guest supervisor required')

    def test_boot_identity_and_fixed_check_are_required(self):
        """Why: a guest must execute only its image-baked check map and authenticated bundle identity."""
        checks = {'syntax': {'command': ['/usr/bin/python3', '-V'], 'cwd': '.', 'timeoutSeconds': 10}}
        args = 'pad_job=12345678-1234-4234-8234-123456789abc pad_bundle=' + 'a'*64 + ' pad_bundle_bytes=10 pad_check=syntax'
        self.assertEqual(GUEST.parse_job(args, checks)['checkId'], 'syntax')
        for bad in (args + ' pad_check=other', args.replace('pad_check=syntax', 'pad_check=other'), args.replace('pad_bundle_bytes=10', 'pad_bundle_bytes=0')):
            with self.assertRaises(ValueError):
                GUEST.parse_job(bad, checks)

    def test_tar_escape_and_links_are_refused(self):
        """Why: immutable checkout bytes cannot create links, device files or files outside the guest checkout."""
        for name, kind in (('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('dev', tarfile.CHRTYPE)):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                row = tarfile.TarInfo(name); row.type = kind
                archive.addfile(row)
            with self.assertRaises(ValueError):
                GUEST.checked_members(stream.getvalue())
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            row = tarfile.TarInfo('safe/file.py'); row.size = 1
            archive.addfile(row, io.BytesIO(b'x'))
        self.assertEqual([x.name for x in GUEST.checked_members(stream.getvalue())], ['safe/file.py'])

    def test_child_deadline_survives_closed_output_and_monitor_failure(self):
        """Why: closing stdout cannot evade the guest deadline, and a dead monitor cannot certify a pass."""
        parent = ROOT / '.scratch/g8b-child-tests'; parent.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(dir=parent)); self.addCleanup(shutil.rmtree, directory)
        state = directory/'state'; state.mkdir()
        alive = SimpleNamespace(poll=lambda: None)
        check = {'command': [sys.executable, '-c', 'import os,time; os.close(1); os.close(2); time.sleep(2)'], 'timeoutSeconds': 0.1}
        with patch.object(GUEST, 'STATE', state), patch.object(GUEST, 'unprivileged', lambda: None):
            code, output = GUEST.execute_check(check, directory, [alive])
            self.assertEqual(code, 124); self.assertEqual(output, b'')
            check = {'command': [sys.executable, '-c', 'print("ok")'], 'timeoutSeconds': 3}
            code, output = GUEST.execute_check(check, directory, [alive])
            self.assertEqual(code, 0); self.assertEqual(output, b'ok\n')
            dead = SimpleNamespace(poll=lambda: 1)
            with patch.object(GUEST.subprocess, 'Popen', side_effect=AssertionError('check started without monitor')) as launch:
                code, output = GUEST.execute_check(check, directory, [dead])
            self.assertEqual(code, 126); launch.assert_not_called()

    def test_monitor_processes_serialize_shared_event_state(self):
        """Why: concurrent net/filesystem transitions must not lose event sequence or pressure updates."""
        parent = ROOT / '.scratch/g8b-monitor-tests'; parent.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(dir=parent)); self.addCleanup(shutil.rmtree, directory)
        state = directory/'state'; state.mkdir(); (state/'seq').write_text('0')
        monitor = directory/'monitor.sh'
        monitor.write_text('gc_net_sweep() { n=$(cat "$1/seq"); sleep 0.02; n=$((n+1)); printf "%s\\n" "$n" > "$1/seq"; printf "%s\\n" "$n" >> "$1/events"; }\n')
        shim = directory/'flock'
        shim.write_text('#!' + sys.executable + '\nimport fcntl,sys\nfcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX if sys.argv[1]=="-x" else fcntl.LOCK_UN)\n')
        shim.chmod(0o755)
        with patch.object(GUEST.subprocess, 'Popen') as capture:
            GUEST.start_monitor('net')
        script = capture.call_args.args[0][2]
        script = script.replace('/run/pad/monitor.sh', shlex.quote(str(monitor))).replace('state=/run/pad/containment', 'state='+shlex.quote(str(state)))
        script = script.replace('while :; do', 'for turn in 1 2 3; do')
        env = {'PATH': str(directory)+os.pathsep+os.defpath, 'LANG': 'C'}
        peers = [subprocess.Popen(['/bin/sh', '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True) for _ in range(2)]
        try:
            for peer in peers:
                _, error = peer.communicate(timeout=10)
                self.assertEqual(peer.returncode, 0, error.decode())
        finally:
            for peer in peers:
                if peer.poll() is None:
                    os.killpg(peer.pid, 9)
                peer.communicate(timeout=5)
        self.assertEqual(int((state/'seq').read_text()), 8)
        self.assertEqual([int(line) for line in (state/'events').read_text().splitlines()], list(range(1, 9)))

    def test_main_refuses_non_guest_process(self):
        """Why: installing or importing the supervisor must not run a workload on the development host."""
        with patch.object(GUEST.sys, 'platform', 'linux'), patch.object(GUEST.os, 'geteuid', return_value=0), patch.object(GUEST.os, 'getpid', return_value=2), patch.object(GUEST.Path, 'read_text', side_effect=AssertionError('non-guest attempted guest IO')):
            self.assertEqual(GUEST.main(), 126)

if __name__ == '__main__':
    unittest.main()
