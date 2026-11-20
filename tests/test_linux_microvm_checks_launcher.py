import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/enforcement/linux_microvm_checks_launcher.py'
SPEC = importlib.util.spec_from_file_location('pad_guest_launcher', SOURCE) if SOURCE.exists() else None
API = importlib.util.module_from_spec(SPEC) if SPEC else None
if API is not None:
    SPEC.loader.exec_module(API)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(API, 'fixed owner-installed backend launcher required')
        parent = Path('.scratch/g8-ssh-checks/backend-tests').resolve()
        parent.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(dir=parent))
        self.addCleanup(shutil.rmtree, self.root)
        self.pins = {}
        for name in ('image', 'initramfs', 'kernel', 'taxonomy'):
            p = self.root / name
            p.write_bytes(name.encode())
            self.pins[name] = {'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
        vmm = self.root / 'fake-vmm'
        vmm.write_text('#!' + sys.executable + '\nimport sys,json,time\nc=json.load(open(sys.argv[-1]))\nprint("serial-fixture",flush=True)\nif c["machine-config"]["vcpu_count"]==2: time.sleep(10)\n')
        vmm.chmod(0o755)
        self.pins['firecracker'] = {'path': str(vmm), 'sha256': hashlib.sha256(vmm.read_bytes()).hexdigest()}
        # Why: parallel suites need Python startup headroom; the watchdog test overrides this to 0.1s.
        self.cfg = {'schema': 'pad-guest-launcher.v1', 'pins': self.pins, 'checks': ['syntax'], 'vcpus': 1, 'memoryMiB': 128, 'timeoutSeconds': 30, 'runDir': str(self.root / 'runs')}
        (self.root / 'runs').mkdir(mode=0o700)
        self.bundle = b'synthetic checkout'
        self.request = {'schema': 'pad-ssh-guest-check.v1', 'jobId': '12345678-1234-4234-8234-123456789abc', 'checkId': 'syntax', 'checkoutSha256': hashlib.sha256(self.bundle).hexdigest()}

    def test_typed_request_only(self):
        """Why: shell, argv and substituted bundle inputs must fail before launch."""
        import base64
        encoded = base64.b64encode(self.bundle).decode()
        self.assertEqual(API.read_request(io.BytesIO((json.dumps(self.request)+'\n'+encoded+'\n').encode()), self.cfg), (self.request, self.bundle))
        for change in ({'command': ['sh']}, {'checkId': 'not-allowlisted'}, {'checkoutSha256': '0'*64}):
            with self.assertRaises(ValueError):
                API.read_request(io.BytesIO((json.dumps({**self.request, **change})+'\n'+encoded+'\n').encode()), self.cfg)

    def test_probe_does_not_need_bundle_or_launch_guest(self):
        """Why: pin readiness is a non-launching protocol, never a fabricated armed guest."""
        probe = {'schema': 'pad-ssh-guest-probe.v1', 'jobId': self.request['jobId']}
        try:
            req, bundle = API.read_request(io.BytesIO((json.dumps(probe)+'\n').encode()), self.cfg)
        except ValueError:
            self.fail('non-launching probe must be recognized')
        self.assertEqual(req, probe)
        self.assertIsNone(bundle)

    def test_pin_mismatch_refuses(self):
        """Why: PinnedBeforeBoot requires verification of every actual image/initramfs/taxonomy byte."""
        for name in self.pins:
            cfg = json.loads(json.dumps(self.cfg))
            cfg['pins'][name]['sha256'] = '0'*64
            with self.assertRaises(ValueError):
                API.validate_config(cfg, owner_uid=os.getuid(), check_ancestors=False)

    def test_untrusted_pin_file_refuses(self):
        """Why: a digest check cannot trust an image path writable by another account."""
        Path(self.pins['image']['path']).chmod(0o666)
        with self.assertRaises(ValueError):
            API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)

    def test_verified_pins_no_network_and_readonly_drives(self):
        """Why: only verified pins precede boot, with exact serial digest and observed process destruction."""
        cfg = API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)
        events = []
        result = API.run_job(cfg, self.request, self.bundle, events.append, disconnected=lambda: False)
        self.assertEqual(result, 0)
        self.assertEqual(events[0]['type'], 'preflight')
        serial = (self.root / 'runs' / self.request['jobId'] / 'serial.log').read_bytes()
        self.assertEqual(events[-1]['logSha256'], hashlib.sha256(serial).hexdigest())
        self.assertTrue(events[-1]['destroyed'])
        vm = json.loads((self.root / 'runs' / self.request['jobId'] / 'vm.json').read_text())
        self.assertNotIn('network-interfaces', vm)
        self.assertNotIn('vsock', vm)
        self.assertTrue(all(d['is_read_only'] for d in vm['drives']))

    def test_watchdog_and_disconnect_destroy_owned_process(self):
        """Why: quiet guests still terminate on a wall-clock deadline or an SSH channel drop."""
        cfg = API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)
        cfg['vcpus'] = 2
        cfg['timeoutSeconds'] = 0.1  # internal fixture clock; production validator refuses fractions
        events = []
        self.assertEqual(API.run_job(cfg, self.request, self.bundle, events.append, disconnected=lambda: False), 126)
        self.assertTrue(events[-1]['destroyed'])
        self.assertTrue(events[-1]['watchdog'])
        other = {**self.request, 'jobId': '22345678-1234-4234-8234-123456789abc'}
        events = []
        channel = iter((False, False, True))
        self.assertEqual(API.run_job(cfg, other, self.bundle, events.append, disconnected=lambda: next(channel, True)), 126)
        self.assertTrue(events[-1]['destroyed'])

    def test_cancelled_or_disconnected_before_boot_never_starts_vmm(self):
        """Why: cancellation or a lost channel observed before boot cannot create a guest effect."""
        cfg = API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)
        for cancelled, disconnected in ((True, False), (False, True)):
            with self.subTest(cancelled=cancelled, disconnected=disconnected):
                events = []
                req = {**self.request, 'jobId': ('1' if cancelled else '2') + self.request['jobId'][1:]}
                with patch.object(API.subprocess, 'Popen', side_effect=AssertionError('VMM started after cancellation')) as launch:
                    result = API.run_job(cfg, req, self.bundle, events.append,
                                         cancelled=lambda: cancelled, disconnected=lambda: disconnected)
                self.assertEqual(result, 126)
                launch.assert_not_called()
                self.assertEqual(events, [])
                self.assertFalse((self.root / 'runs' / req['jobId']).exists())

    def test_cancel_after_preflight_still_prevents_boot(self):
        """Why: cancellation during checkout preparation must be rechecked at the VMM effect boundary."""
        cfg = API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)
        stopped = [False]; events = []
        def emit(row):
            events.append(row)
            stopped[0] = True
        with patch.object(API.subprocess, 'Popen', side_effect=AssertionError('boot after preflight cancellation')) as launch:
            result = API.run_job(cfg, self.request, self.bundle, emit, disconnected=lambda: False, cancelled=lambda: stopped[0])
        self.assertEqual(result, 126)
        launch.assert_not_called()
        self.assertEqual([row['type'] for row in events], ['preflight'])
        self.assertTrue((self.root/'runs'/self.request['jobId']/'request.json').is_file())

    def test_job_id_never_restarts(self):
        """Why: a retained job intent prevents uncertain effects or trips from silently retrying."""
        cfg = API.validate_config(self.cfg, owner_uid=os.getuid(), check_ancestors=False)
        self.assertEqual(API.run_job(cfg, self.request, self.bundle, lambda _: None, disconnected=lambda: False), 0)
        with self.assertRaises(FileExistsError):
            API.run_job(cfg, self.request, self.bundle, lambda _: None, disconnected=lambda: False)


if __name__ == '__main__':
    unittest.main()
