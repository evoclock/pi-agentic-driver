"""Behavioral controls for recurrence preflight; no external tools are dispatched."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import gate
import test_gate_runner as runner


class RecurrenceGuardsTest(unittest.TestCase):
    def test_cap_headroom(self):
        """Why: a known near-cap step must be rejected before repeating it."""
        check = getattr(gate, "runtime_headroom_findings", lambda *args: [])
        self.assertTrue(check("native", 500, 600))
        self.assertEqual(check("native", 450, 600), [])
        self.assertTrue(check("native", None, 600))
        self.assertTrue(check("native", -1, 600))

    def test_missing_tools(self):
        """Why: command presence must be verified before running any gate step."""
        check = getattr(gate, "required_tool_findings", lambda *args: [])
        self.assertTrue(check(["fixture-missing-tool"], lambda name: None))
        self.assertEqual(check(["fixture-tool"], lambda name: "/fixture/tool"), [])

    def test_prior_config_drift_across_base(self):
        """Why: moving the base must not silently discard locked control hashes."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            area = root / runner.EVIDENCE_REL
            area.mkdir(parents=True)
            control = ".driver/test-gate.json"
            (area / "baseline-lock-old.json").write_text(json.dumps({
                "schema": runner.LOCK_SCHEMA, "baseCommitSha": "old",
                "branch": "feature", "testFiles": {control: "old-hash"},
            }))
            with patch.object(runner, "current_branch", return_value="feature"):
                with self.assertRaises(runner.Blocked):
                    runner.verify_prior_locks(root, "new", {control: "new-hash"})

    def test_legacy_lock_cannot_wait_silently(self):
        """Why: an anonymous legacy holder cannot support an honest wait estimate."""
        check = getattr(gate, "lock_wait_findings", lambda *args: [])
        findings = check({}, 1, 100)
        self.assertTrue(findings)
        self.assertIn("holder", " ".join(findings))
        self.assertEqual(check({"holder": "fixture", "started": 90, "cap": 20}, 1, 100), [])
        self.assertTrue(check({"holder": "fixture", "started": 90, "cap": 20}, 0, 100))
        self.assertTrue(check({"holder": "fixture", "started": 70, "cap": 20}, 1, 100))

    def test_fifo_registration_and_cleanup(self):
        """Why: concurrent callers need stable FIFO positions and owned cleanup."""
        register = getattr(gate, "queue_registration", None)
        position = getattr(gate, "queue_position", None)
        self.assertTrue(callable(register))
        self.assertTrue(callable(position))
        with tempfile.TemporaryDirectory() as directory:
            area = Path(directory)
            metadata = {"role": "fixture", "slot": "fixture", "pid": 1}
            with register(area, metadata) as first:
                with register(area, metadata) as second:
                    self.assertEqual(position(area, first), 1)
                    self.assertEqual(position(area, second), 2)
                self.assertEqual(position(area, first), 1)
            self.assertEqual(list(area.glob("ticket-*.json")), [])

    def test_holder_runtime_supervised(self):
        """Why: the supervisor must terminate an over-cap command before releasing."""
        bounded = getattr(gate, "run_bounded", None)
        self.assertTrue(callable(bounded))
        self.assertEqual(bounded([sys.executable, "-c", "pass"], 5), 0)
        self.assertEqual(bounded([sys.executable, "-c", "import time; time.sleep(30)"], 0.1), 3)

    def test_native_runtime_rejects_before_command(self):
        """Why: a prior near-cap observation must prevent native subprocess execution."""
        from types import SimpleNamespace
        command = [sys.executable, "-c", "pass"]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            area = root / runner.EVIDENCE_REL
            area.mkdir(parents=True)
            (area / "checks.jsonl").write_text(json.dumps({"argv": command, "cwd": ".", "phase": "head", "elapsedMs": 9000}) + "\n")
            result = SimpleNamespace(returncode=0, stdout="Ran 1 test in 0.001s\nOK\n", stderr="")
            with patch.object(runner, "worktree_fingerprint", return_value=(0, "fixture")), patch.object(runner.subprocess, "run", return_value=result):
                with self.assertRaises(runner.Blocked):
                    runner.run_command(root, root, {"command": command, "timeoutSeconds": 10}, phase="head", commit_sha="fixture", base_sha="fixture", expected="pass")

    def test_native_missing_tool_rejects_before_command(self):
        """Why: missing native executables are blocked, not classified as test failures."""
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = SimpleNamespace(returncode=0, stdout="Ran 1 test in 0.001s\nOK\n", stderr="")
            with patch.object(runner, "worktree_fingerprint", return_value=(0, "fixture")), patch.object(runner.subprocess, "run", return_value=result):
                with self.assertRaises(runner.Blocked):
                    runner.run_command(root, root, {"command": ["fixture-absent-recurrence-tool"], "timeoutSeconds": 10}, phase="head", commit_sha="fixture", base_sha="fixture", expected="pass")

    def test_wait_prints_holder_and_fifo_without_touching_holder(self):
        """Why: waiting callers must see the actual holder and their queue position."""
        import io
        import subprocess
        acquire = getattr(gate, "observable_gate_lock", None)
        self.assertTrue(callable(acquire))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            output = io.StringIO()
            with patch.dict("os.environ", {"PAD_WORKER_ROLE": "fixture", "PAD_WORKER_SLOT": "fixture"}), patch("sys.stdout", output):
                with acquire(root, 10):
                    holder = root / ".local/locks/test-gate.lock/holder.json"
                    original = holder.read_bytes()
                    with patch.object(gate.time, "sleep", side_effect=RuntimeError("stop waiting")):
                        with self.assertRaisesRegex(RuntimeError, "stop waiting"):
                            with acquire(root, 10):
                                self.fail("second caller must not acquire")
                    self.assertEqual(holder.read_bytes(), original)
                    wait = next(line for line in output.getvalue().splitlines() if line.startswith("WAIT [gate-lock]: "))
                    record = json.loads(wait.split(": ", 1)[1])
                    self.assertEqual(record["queuePosition"], 1)
                    self.assertEqual(record["holder"]["role"], "fixture")
                    self.assertEqual(record["holder"]["slot"], "fixture")
                    self.assertGreater(record["holder"]["pid"], 0)
                    self.assertGreater(record["holder"]["started"], 0)
                    self.assertGreater(record["expectedWaitSeconds"], 0)
                    self.assertEqual(len(record["fifoQueue"]), 1)
            self.assertFalse((root / ".local/locks/test-gate.lock").exists())


if __name__ == "__main__":
    unittest.main()
