"""Behavior fixtures for the host-run test-gate workflow."""

import json
import os
from importlib.util import module_from_spec, spec_from_file_location
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/test_gate_runner.py"


class TestGateWorkflow(unittest.TestCase):
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
                    "caps": {"maxObservedTests": 10000, "commandTimeoutSeconds": 120},
                    "testCountRationales": {
                        "python-tests": "unittest discovers tests/test_*.py and reports its actual Ran N total."
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

    def put_test(self, text):
        return self.write("tests/test_contract.py", text)

    def run_gate(self, phase="baseline"):
        runner = Path(os.environ.get("TEST_GATE_SCRIPT", ROOT / "scripts/test_gate_runner.py"))
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

    def fixture_text(self, name):
        return (ROOT / "tests/fixtures/test-gate" / name).read_text(encoding="utf-8")

    def test_runner_exists(self):
        """Why: the new workflow needs an explicit fail-first check before behavior tests can run."""
        self.assertTrue(RUNNER.is_file(), "test-gate runner is not implemented")

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_reporter_counts_exclude_skipped_and_cancelled_cases(self):
        """Why: skipped or cancelled cases are not passing tests."""
        spec = spec_from_file_location("driver_test_gate_runner", RUNNER)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(
            module.parse_test_counts("Ran 9 tests\nFAILED (failures=1, skipped=8)"),
            {"tests": 9, "failures": 1, "errors": 0, "skipped": 8, "passed": 0},
        )
        self.assertEqual(
            module.parse_test_counts("# tests 4\n# pass 1\n# fail 1\n# cancelled 1\n# skipped 1\n# todo 0"),
            {"tests": 4, "failures": 1, "errors": 0, "skipped": 1, "cancelled": 1, "todo": 0, "passed": 1},
        )

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_always_passing_test_is_rejected_on_base(self):
        """Why: a test that passes before the change does not prove the new behavior."""
        self.put_test(self.fixture_text("vacuous.py"))
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(result["status"], "fail")
        self.assertIn("passed on the base", result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_test_without_assertion_is_blocked(self):
        """Why: empty test bodies must not count as evidence or inflate a pass rate."""
        self.put_test(self.fixture_text("empty_assertion.py"))
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("no assertion", result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_meaningful_test_fails_first_and_locks_its_content(self):
        """Why: the host must prove the new assertion fails against base behavior."""
        path = self.put_test(self.fixture_text("meaningful.py"))
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["phase"], "baseline")
        self.assertTrue(list((self.repo / ".driver/test-gate-evidence").glob("baseline-lock-*.json")))
        path.write_text(path.read_text(encoding="utf-8").replace("assertEqual(value(), 2)", "assertEqual(value(), 1)"), encoding="utf-8")
        blocked = self.run_gate("check")
        blocked_result = self.result(blocked)
        self.assertEqual(blocked.returncode, 3)
        self.assertEqual(blocked_result["status"], "blocked")
        self.assertIn("changed after fail-first lock", blocked_result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_changed_code_mutation_catches_behavior_without_runner_target(self):
        """Why: a new behavior test must catch a mutation in changed code, not require a runner edit."""
        self.write("app.py", "def value():\n    return 2\n")
        self.put_test(self.fixture_text("meaningful.py"))
        completed = self.run_gate("check")
        result = self.result(completed)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(result["mutationPath"], "app.py")
        self.assertTrue(result["mutationCaught"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_changed_javascript_comparison_is_caught_in_snapshot(self):
        """Why: changed JS must get an isolated mutant caught by a real Node assertion, not a runner crash."""
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"].append({
            "id": "node-tests", "kind": "command",
            "command": ["node", "--test", "--test-reporter=tap", "tests/test_contract.mjs"],
        })
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["testCountRationales"]["node-tests"] = "The Node TAP summary reports the actual test total."
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write("app.mjs", "export function value() { return 1 !== 1; }\n")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "node fixture base")
        self.write("app.mjs", "export function value() { return 1 !== 2; }\n")
        self.write("tests/test_contract.mjs", "\n".join([
            '// Why: changed comparisons must keep the new behavior.',
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            'import { value } from "../app.mjs";',
            'test("value changed", () => assert.equal(value(), true));',
            '',
        ]))
        baseline = self.run_gate("baseline")
        self.assertEqual(self.result(baseline)["status"], "pass", baseline.stdout + baseline.stderr)
        completed = self.run_gate("check")
        result = self.result(completed)
        self.assertEqual(completed.returncode, 0, result["reason"])
        self.assertEqual(result["mutationPath"], "app.mjs")
        self.assertTrue(result["mutationCaught"])
        records = [json.loads(line) for line in
                   (self.repo / ".driver/test-gate-evidence/checks.jsonl").read_text(encoding="utf-8").splitlines()]
        mutant = next(record for record in records if record["phase"] == "mutation-spot-check")
        self.assertGreater(mutant["testCounts"]["tests"], 0)
        self.assertGreater(mutant["testCounts"]["failures"], 0)
        self.assertEqual(mutant["testCounts"]["errors"], 0)
        self.assertEqual(self.repo.joinpath("app.mjs").read_text(encoding="utf-8"),
                         "export function value() { return 1 !== 2; }\n")

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_changed_typescript_slice_bound_is_caught_in_snapshot(self):
        """Why: a changed TS widget limit must fail a Node assertion when its bound grows."""
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"].append({
            "id": "node-tests", "kind": "command",
            "command": ["node", "--test", "--test-reporter=tap", "tests/test_contract.mjs"],
        })
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["testCountRationales"]["node-tests"] = "Node TAP reports the observed test count."
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write("app.ts", "export const visible = [1,2,3,4,5,6].slice(0, 6);\n")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "TypeScript fixture base")
        self.write("app.ts", "export const visible = [1,2,3,4,5,6].slice(0, 5);\n")
        self.write("tests/test_contract.mjs", "\n".join([
            '// Why: the compact task list must contain exactly five rows.',
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            'import { visible } from "../app.ts";',
            'test("five visible", () => assert.deepEqual(visible, [1,2,3,4,5]));',
            '',
        ]))
        baseline = self.run_gate("baseline")
        self.assertEqual(self.result(baseline)["status"], "pass", baseline.stdout + baseline.stderr)
        checked = self.run_gate("check")
        result = self.result(checked)
        self.assertEqual(checked.returncode, 0, result["reason"])
        self.assertEqual(result["mutationPath"], "app.ts")
        self.assertTrue(result["mutationCaught"])
        self.assertEqual(self.repo.joinpath("app.ts").read_text(encoding="utf-8"),
                         "export const visible = [1,2,3,4,5,6].slice(0, 5);\n")

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_zero_observed_tests_is_blocked_with_host_evidence(self):
        """Why: the denominator must come from a host-observed nonzero test count."""
        self.put_test(self.fixture_text("meaningful.py"))
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = ["python3", "-c", "print('Ran 0 tests')"]
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("zero tests", result["reason"])
        evidence = self.repo / ".driver/test-gate-evidence/checks.jsonl"
        record = json.loads(evidence.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(record["exitCode"], 3)
        self.assertEqual(record["commitSha"], self.git("rev-parse", "HEAD").stdout.strip())
        self.assertGreaterEqual(record["elapsedMs"], 0)
        self.assertIn("command", record)

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_count_cap_blocks_a_reported_total_that_is_too_large(self):
        """Why: impossible denominators must not be trusted as host-observed test totals."""
        self.put_test(self.fixture_text("meaningful.py"))
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = ["python3", "-c", "print('Ran 11 tests')"]
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["caps"]["maxObservedTests"] = 10
        config_path.write_text(json.dumps(config), encoding="utf-8")
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("exceeds cap 10", result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_test_file_modified_by_runner_is_blocked(self):
        """Why: the host must verify test immutability after each process runs."""
        self.put_test(self.fixture_text("meaningful.py"))
        baseline = self.run_gate()
        self.assertEqual(self.result(baseline)["status"], "pass")
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = [
            "python3",
            "-c",
            "from pathlib import Path; p=Path('tests/test_contract.py'); p.write_text(p.read_text() + '# changed'); print('Ran 1 test'); print('FAILED (failures=1)'); raise SystemExit(1)",
        ]
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        blocked = self.run_gate("check")
        result = self.result(blocked)
        self.assertEqual(blocked.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("changed after fail-first lock", result["reason"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_command_time_cap_blocks_with_recorded_exit(self):
        """Why: a hung test process must stop at the host limit and cannot count as evidence."""
        self.put_test(self.fixture_text("meaningful.py"))
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = [
            "python3",
            "-c",
            "import time; print('Ran 1 test', flush=True); time.sleep(1)",
        ]
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["caps"]["commandTimeoutSeconds"] = 0.01
        config_path.write_text(json.dumps(config), encoding="utf-8")
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("time cap", result["reason"])
        evidence = self.repo / ".driver/test-gate-evidence/checks.jsonl"
        records = [json.loads(line) for line in evidence.read_text(encoding="utf-8").splitlines()]
        observation = next(record for record in records if record.get("phase") == "fail-first-base")
        self.assertEqual(observation["exitCode"], 124)
        self.assertTrue(observation["timedOut"])

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_blocked_exit_is_structured_and_nonzero(self):
        """Why: a missing test command is a clean off-ramp, not a runner crash."""
        self.put_test(self.fixture_text("meaningful.py"))
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"][0]["command"] = []
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 3)
        self.assertEqual(result["status"], "blocked")
        self.assertTrue(result["reason"])


if __name__ == "__main__":
    unittest.main()
