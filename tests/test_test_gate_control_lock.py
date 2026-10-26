"""Regression tests for fail-first locking of test-gate control inputs."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/test_gate_runner.py"


class TestControlConfigLock(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.scratch.cleanup)
        self.repo = Path(self.scratch.name)
        self.git("init", "-q")
        self.write("app.py", "def value():\n    return 1\n")
        self.write(
            ".driver/gate-rules.json",
            json.dumps(
                {
                    "schema": "driver-gate-rules.v1",
                    "baseRef": "HEAD",
                    "checks": [
                        {
                            "id": "python-tests",
                            "kind": "command",
                            "command": [
                                "python3",
                                "-m",
                                "unittest",
                                "discover",
                                "-s",
                                "tests",
                                "-p",
                                "test_*.py",
                            ],
                        }
                    ],
                }
            ),
        )
        self.write(
            ".driver/test-gate.json",
            json.dumps(
                {
                    "schema": "driver-test-gate.v1",
                    "caps": {"maxObservedTests": 100, "commandTimeoutSeconds": 120},
                    "testCountRationales": {
                        "python-tests": "unittest reports the host-observed Ran N total."
                    },
                    "mutation": {
                        "id": "value-contract",
                        "path": "app.py",
                        "before": "return 2",
                        "after": "return 1",
                        "testCheckId": "python-tests",
                        "testPaths": ["tests/test_contract.py"],
                        "scriptEnv": "TEST_MUTANT",
                        "reason": "The changed value must break the focused assertion.",
                    },
                }
            ),
        )
        self.git("add", ".")
        self.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "fixture base",
        )

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
            text=True,
        )

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def put_test(self):
        return self.write(
            "tests/test_contract.py",
            '''import importlib.util
import os
from pathlib import Path
import unittest

class ContractTest(unittest.TestCase):
    def test_value_matches_new_contract(self):
        """Why: the changed value must be checked against an independent expectation."""
        target = Path(os.environ.get("TEST_MUTANT", Path(__file__).resolve().parents[1] / "app.py"))
        spec = importlib.util.spec_from_file_location("fixture_app", target)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(module.value(), 2)
''',
        )

    def run_gate(self, phase="baseline"):
        runner = Path(os.environ.get("TEST_GATE_SCRIPT", RUNNER))
        return subprocess.run(
            [sys.executable, str(runner), "--root", str(self.repo), "--phase", phase],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )

    def result(self, completed):
        for line in completed.stdout.splitlines():
            if line.startswith("TEST_GATE_RESULT "):
                return json.loads(line.removeprefix("TEST_GATE_RESULT "))
        self.fail(f"test-gate did not return structured output:\n{completed.stdout}\n{completed.stderr}")

    def baseline_and_implement(self):
        self.put_test()
        baseline = self.run_gate()
        baseline_result = self.result(baseline)
        self.assertEqual(baseline.returncode, 0, baseline.stdout + baseline.stderr)
        self.assertEqual(baseline_result["status"], "pass")
        self.write("app.py", "def value():\n    return 2\n")

    def test_runner_exists(self):
        """Why: control-input locking requires the host runner to exist."""
        self.assertTrue(RUNNER.is_file(), "test-gate runner is not implemented")

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_gate_command_cannot_change_after_fail_first(self):
        """Why: a new command must not replace the one that proved fail-first."""
        self.baseline_and_implement()
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = [
            "python3",
            "-c",
            "import os,sys; print('Ran 1 test'); print('FAILED (failures=1)' if os.environ.get('TEST_MUTANT') else 'OK'); sys.exit(1 if os.environ.get('TEST_MUTANT') else 0)",
        ]
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        completed = self.run_gate("check")
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn(".driver/gate-rules.json", result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_test_gate_policy_cannot_change_after_fail_first(self):
        """Why: caps and mutation policy must stay fixed after the baseline lock."""
        self.baseline_and_implement()
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["testCountRationales"]["python-tests"] = "Changed after the fail-first baseline."
        config_path.write_text(json.dumps(config), encoding="utf-8")
        completed = self.run_gate("check")
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn(".driver/test-gate.json", result["reason"])


if __name__ == "__main__":
    unittest.main()
