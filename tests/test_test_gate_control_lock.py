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
        (ROOT / '.scratch').mkdir(exist_ok=True)
        self.scratch = tempfile.TemporaryDirectory(dir=ROOT / (
            '.scratch' if 'FIXTURE_REPO_PARENT = ".scratch"' in
            (ROOT / 'tests/fixtures/test-gate/meaningful.py').read_text() else '.'))
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

    def test_fixture_repo_is_isolated_from_root_status(self):
        """Why: interrupted control-lock fixtures must stay outside root Git status."""
        self.assertEqual(self.repo.parent, ROOT / '.scratch')

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

    def run_gate(self, phase="baseline", reason=None):
        runner = Path(os.environ.get("TEST_GATE_SCRIPT", RUNNER))
        args = [sys.executable, str(runner), "--root", str(self.repo), "--phase", phase]
        if reason is not None:
            args.extend(["--reason", reason])
        return subprocess.run(
            args,
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

    def test_refresh_accepts_strict_input_supersets_and_preserves_prior_locks(self):
        """Why: staged test additions need new fail-first proof without erasing earlier evidence."""
        self.write(".gitignore", ".driver/test-gate-evidence/\nscratch/\n.scratch/\n__pycache__/\n")
        self.baseline_and_implement()
        area = self.repo / ".driver/test-gate-evidence"
        original = next(area.glob("baseline-lock-*.json"))
        original_bytes = original.read_bytes()
        source = (self.repo / "tests/test_contract.py").read_text()
        for name in ("test_expanded.py", "test_third.py"):
            self.write("tests/" + name, source.replace("ContractTest", "ExpandedTest"))
            result = self.run_gate("refresh", "add independently failing staged test inputs")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(original.read_bytes(), original_bytes)
            refreshed = json.loads((self.repo / self.result(result)["lockPath"]).read_text())
            self.assertEqual(refreshed["refreshHistory"][-1]["addedInputs"], ["tests/" + name])
            self.assertIn("tests/" + name, refreshed["testFiles"])
            checked = self.run_gate("check")
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(len(list(area.glob("baseline-lock-*.json"))), 3)

    def test_expanded_refresh_requires_reason_and_each_new_file_to_fail_first(self):
        """Why: a passing new file cannot borrow another file's failure or replace old inputs."""
        self.baseline_and_implement()
        original = next((self.repo / ".driver/test-gate-evidence").glob("baseline-lock-*.json"))
        before = original.read_bytes()
        self.write("tests/test_added.py", "import unittest\nclass Added(unittest.TestCase):\n    def test_pass(self):\n        \"\"\"Why: independently passing new inputs must be refused.\"\"\"\n        self.assertEqual(1, 1)\n")
        self.assertEqual(self.run_gate("refresh").returncode, 3)
        self.assertEqual(self.run_gate("refresh", "passing addition").returncode, 3)
        self.assertEqual(original.read_bytes(), before)
        (self.repo / "tests/test_contract.py").unlink()
        self.assertEqual(self.run_gate("refresh", "removed original").returncode, 3)
        self.assertEqual(original.read_bytes(), before)

    def test_refresh_records_proven_drift_and_identity(self):
        """Why: a refresh must preserve its prior hashes and identify the host-observed actor."""
        self.baseline_and_implement()
        lock = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        old = json.loads(lock.read_text())['testFiles']
        path = self.repo / 'tests/test_contract.py'
        path.write_text(path.read_text() + '\n# tightened description\n')
        result = self.run_gate('refresh', 'clarify the contract')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        refreshed = json.loads(lock.read_text())
        self.assertNotEqual(old, refreshed['testFiles'])
        records = [json.loads(line) for line in (lock.parent / 'checks.jsonl').read_text().splitlines()]
        record = next(item for item in records if item.get('kind') == 'lock-refresh')
        self.assertEqual(record['oldHashes'], old)
        self.assertEqual(record['newHashes'], refreshed['testFiles'])
        self.assertEqual(record['reason'], 'clarify the contract')
        self.assertTrue(record['identity']['author'])
        self.assertTrue(record['identity']['committer'])
        self.assertTrue(record['recordedAt'])

    def test_refresh_requires_reason_and_proven_drift(self):
        """Why: missing reasons and unchanged or unproven tests cannot replace a baseline."""
        self.baseline_and_implement()
        lock = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        before = lock.read_bytes()
        self.assertEqual(self.run_gate('refresh', 'unchanged').returncode, 3)
        path = self.repo / 'tests/test_contract.py'
        path.write_text(path.read_text() + '\n# drift\n')
        self.assertEqual(self.run_gate('refresh').returncode, 3)
        self.assertEqual(lock.read_bytes(), before)
        path.write_text(path.read_text().replace('module.value(), 2', 'module.value(), 1'))
        self.assertNotEqual(self.run_gate('refresh', 'not fail first').returncode, 0)
        self.assertEqual(lock.read_bytes(), before)

    def test_refresh_requires_valid_prior_lock(self):
        """Why: a missing or malformed prior record cannot be refreshed."""
        self.put_test()
        self.assertEqual(self.run_gate('refresh', 'reason').returncode, 3)
        self.assertEqual(self.run_gate().returncode, 0)
        lock = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        lock.write_text('{}')
        self.assertEqual(self.run_gate('refresh', 'reason').returncode, 3)

    def test_ordinary_phases_still_reject_drift(self):
        """Why: refresh must not make ordinary baseline or check overwrite a locked test."""
        self.baseline_and_implement()
        path = self.repo / 'tests/test_contract.py'
        path.write_text(path.read_text() + '\n# drift\n')
        self.assertEqual(self.run_gate('baseline').returncode, 3)
        self.assertEqual(self.run_gate('check').returncode, 3)

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

    def test_additive_contract_refresh_replays_baseline_and_keeps_history(self):
        """Why: adding contracts must replay fail-first without weakening frozen controls."""
        self.write(".gitignore", ".driver/test-gate-evidence/\nscratch/\n.scratch/\n__pycache__/\n")
        self.baseline_and_implement()
        lock = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        original = json.loads(lock.read_text())
        path = self.repo / '.driver/test-gate.json'
        config = json.loads(path.read_text())
        extra = dict(config['mutation'], id='extra', after='return 3')
        config['mutations'] = {'extra': extra}
        path.write_text(json.dumps(config))
        result = self.run_gate('refresh', 'add the second independent mutation')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        first = json.loads(lock.read_text())
        self.assertEqual(first['refreshHistory'][-1]['addedContracts'], ['extra'])
        self.assertEqual(first['refreshHistory'][-1]['oldHashes'], original['testFiles'])
        self.assertTrue(first['testCommands'][0]['counts']['failures'])
        config['mutations']['another'] = dict(extra, id='another', after='return 4')
        path.write_text(json.dumps(config))
        second = self.run_gate('refresh', 'add another contract without replacing the first')
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        current = json.loads(lock.read_text())
        self.assertEqual(len(current['refreshHistory']), 2)
        self.assertEqual(current['refreshHistory'][0], first['refreshHistory'][0])
        self.assertEqual(current['refreshHistory'][-1]['addedContracts'], ['another'])
        self.assertEqual(self.run_gate('check').returncode, 0)

    def test_additive_refresh_refuses_removal_weakening_and_cap_edits(self):
        """Why: additions cannot disguise replacement, deletion or cap changes."""
        import copy
        self.baseline_and_implement()
        path = self.repo / '.driver/test-gate.json'
        original = json.loads(path.read_text())
        lock = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        before = lock.read_bytes()
        for change in ('remove', 'weaken', 'cap'):
            config = copy.deepcopy(original)
            config['mutations'] = {'new': dict(config['mutation'], id='new', after='return 3')}
            if change == 'remove':
                del config['mutation']
            elif change == 'weaken':
                config['mutation']['after'] = 'return 2'
            else:
                config['caps']['commandTimeoutSeconds'] += 1
            path.write_text(json.dumps(config))
            result = self.run_gate('refresh', 'attempt prohibited change')
            self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
            self.assertEqual(lock.read_bytes(), before)
        config = copy.deepcopy(original)
        config['mutations'] = {'new': dict(config['mutation'], id='new', after='return 3')}
        path.write_text(json.dumps(config))
        self.assertEqual(self.run_gate('refresh').returncode, 3)
        self.assertEqual(lock.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
