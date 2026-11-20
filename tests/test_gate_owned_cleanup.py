"""Real-process conformance: lock released implies no owned process is alive."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CHILD = """
import json, os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
ready = Path(sys.argv[1])
staged = ready.with_suffix('.tmp')
staged.write_text(json.dumps({'pid':os.getpid(), 'group':os.getpgrp()}))
staged.replace(ready)
time.sleep(9)
Path(sys.argv[2]).write_text('survived supervisor')
time.sleep(30)
"""
LEADER = """
import subprocess, sys, time
subprocess.Popen([sys.executable, '-c', sys.argv[1], *sys.argv[2:]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(60)
"""
SUPERVISOR = """
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import gate
root = Path(sys.argv[2])
with gate.observable_gate_lock(root, 60):
    with gate.termination_as_interrupt():
        result = gate.run_bounded([sys.executable, '-c', sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]], float(sys.argv[7]))
assert result == 3
(root / 'released').write_text('released')
"""


class OwnedCleanupTest(unittest.TestCase):
    def exercise(self, interrupted):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            ready, late = root / 'ready', root / 'late'
            supervisor = subprocess.Popen(
                [sys.executable, '-c', SUPERVISOR, str(ROOT / 'scripts'), str(root),
                 LEADER, CHILD, str(ready), str(late), '60' if interrupted else '4'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            owned = None
            try:
                deadline = time.monotonic() + 20
                while not ready.exists() and supervisor.poll() is None and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(ready.exists(), 'descendant must install TERM ignore before termination')
                owned = json.loads(ready.read_text())
                self.assertTrue((root / '.local/locks/test-gate.lock').is_dir())
                if interrupted:
                    supervisor.send_signal(signal.SIGTERM)
                output, _ = supervisor.communicate(timeout=20)
                self.assertEqual(supervisor.returncode, 0, output)
                self.assertTrue((root / 'released').exists())
                self.assertFalse((root / '.local/locks/test-gate.lock').exists())
                # Zombie entries cannot execute; only runnable/sleeping survivors break ownership.
                rows = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True).splitlines()
                alive = [row for row in rows if row.split()[0] == str(owned['group']) and not row.split()[1].startswith('Z')]
                self.assertEqual(alive, [], 'lock released => no owned process alive')
                time.sleep(9.2)
                self.assertFalse(late.exists(), 'no descendant may perform work after admission release')
                return supervisor.returncode
            finally:
                if owned:
                    try:
                        os.killpg(owned['group'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if supervisor.poll() is None:
                    supervisor.kill()
                supervisor.communicate(timeout=20)

    def test_timeout_drains_owned_descendants_before_release(self):
        """Why: a leader exiting on TERM must not hide a TERM-ignoring descendant on timeout."""
        self.assertEqual(self.exercise(False), 0)

    def test_interrupt_drains_owned_descendants_before_release(self):
        """Why: interruption must retain admission until the entire owned group has stopped."""
        self.assertEqual(self.exercise(True), 0)


if __name__ == '__main__':
    unittest.main()
