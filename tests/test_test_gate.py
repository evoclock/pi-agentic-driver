"""Behavior fixtures for the host-run test-gate workflow."""

import json
import os
from importlib.util import module_from_spec, spec_from_file_location
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/test_gate_runner.py"


class TestGateWorkflow(unittest.TestCase):
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

    def test_fixture_repo_is_isolated_from_root_status(self):
        """Why: interrupted fixture runs must not appear as untracked repos at the root."""
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

    def mutation_fixture(self, *, form="map", inherited=True):
        config = json.loads((self.repo / '.driver/test-gate.json').read_text())
        own = {'id': 'current', 'path': 'app.py', 'before': 'return 2', 'after': 'return 1',
               'testCheckId': 'python-tests', 'testPaths': ['tests/test_contract.py'],
               'reason': 'The current behavior must reject its previous value.'}
        stable = {'id': 'inherited', 'path': 'stable.py', 'before': 'return 7', 'after': 'return 0',
                  'testCheckId': 'python-tests', 'testPaths': ['tests/test_stable.py'],
                  'reason': 'An inherited behavior must remain covered outside the diff.'}
        self.write('.gitignore', 'scratch/\n.driver/test-gate-evidence/\n')
        self.write('stable.py', 'def value():\n    return 7\n')
        self.write('tests/test_stable.py', 'import unittest\nfrom stable import value\n'
                   'class Stable(unittest.TestCase):\n    def test_value(self):\n'
                   '        """Why: inherited behavior must not regress."""\n'
                   '        self.assertEqual(value(), 7)\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'inherited contract base')
        self.put_test(self.fixture_text('meaningful.py'))
        self.write('app.py', 'def value():\n    return 2\n')
        if form == 'legacy':
            config['mutation'] = own
        else:
            config['mutations'] = {'inherited': stable} if inherited else {}
            config['mutations']['current'] = own
        self.write('.driver/test-gate.json', json.dumps(config))
        return config, own, stable

    def mutation_records(self):
        return [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()
                if json.loads(line).get('phase') == 'mutation-spot-check']

    def test_failed_mutation_releases_snapshot(self):
        """Why: a surviving mutant must leave evidence but not a base snapshot on tmpfs."""
        config, _, _ = self.mutation_fixture(inherited=False)
        config['mutations']['current']['after'] = 'return 2  # behavior unchanged'
        self.write('.driver/test-gate.json', json.dumps(config))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn('mutant survived', completed.stdout)
        self.assertEqual(list((self.repo / 'scratch/test-gate').glob('base-*')), [])

    def test_legacy_single_contract_runs(self):
        """Why: existing branches must retain their single-contract mutation proof."""
        self.mutation_fixture(form='legacy')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual([row['mutationPath'] for row in self.mutation_records()], ['app.py'])

    def test_two_contract_map_runs_both_including_inherited(self):
        """Why: an inherited target and suite outside the diff must still be mutated."""
        self.mutation_fixture()
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        records = self.mutation_records()
        self.assertEqual(len(records), 2)
        self.assertEqual(list((self.repo / 'scratch/test-gate').glob('base-*')), [],
                         'completed mutation snapshots must not accumulate on tmpfs')
        self.assertEqual([row['mutationPath'] for row in records], ['stable.py', 'app.py'])
        self.assertTrue(all(row['testCounts']['failures'] > 0 and row['testCounts']['errors'] == 0 for row in records))
        evidence = [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        heads = [row for row in evidence if row.get('phase') == 'mutation-head-tests']
        self.assertEqual(len(heads), 1, 'the changed suite already passed; only inherited head needs another command')
        self.assertTrue(heads[0]['testCounts']['passed'] > 0)

    def test_mixed_map_includes_distinct_legacy_and_deduplicates_id(self):
        """Why: migration must neither lose a legacy contract nor run a duplicate id twice."""
        config, own, stable = self.mutation_fixture()
        config['mutations'] = {'inherited': stable}
        config['mutation'] = own
        self.write('.driver/test-gate.json', json.dumps(config))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual([row['mutationPath'] for row in self.mutation_records()], ['stable.py', 'app.py'])
        config['mutations']['current'] = own
        config['mutation'] = {**own, 'before': 'not present'}
        self.write('.driver/test-gate.json', json.dumps(config))
        # Separate check removes no evidence; inspect only the new observations.
        runner = spec_from_file_location('mixed_gate', RUNNER)
        module = module_from_spec(runner)
        runner.loader.exec_module(module)
        observations = module.mutation_observation(self.repo, json.loads((self.repo / '.driver/gate-rules.json').read_text()),
            config, {'app.py', 'tests/test_contract.py'}, {'tests/test_contract.py'},
            self.git('rev-parse', 'HEAD').stdout.strip(), self.git('rev-parse', 'HEAD').stdout.strip())
        self.assertEqual(len(observations), 2)

    def test_upstream_mutation_is_ignored(self):
        """Why: obsolete upstream metadata must not run or invalidate a current contract."""
        config, _, _ = self.mutation_fixture(form='legacy')
        config['upstreamMutation'] = {'path': 'missing.py', 'before': 'absent'}
        self.write('.driver/test-gate.json', json.dumps(config))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual([row['mutationPath'] for row in self.mutation_records()], ['app.py'])

    def test_only_inherited_contracts_block_changed_production(self):
        """Why: unrelated inherited coverage cannot replace this change's focused contract."""
        config, _, stable = self.mutation_fixture()
        config['mutations'] = {'inherited': stable}
        self.write('.driver/test-gate.json', json.dumps(config))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('add a focused mutation contract', self.result(completed)['reason'])

    def test_inherited_contracts_run_for_documentation_only_diff(self):
        """Why: retaining a contract means executing it even without changed production or tests."""
        self.mutation_fixture()
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'contracts inherited')
        self.write('docs/guide.md', 'documentation change\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual([row['mutationPath'] for row in self.mutation_records()], ['stable.py', 'app.py'])

    def test_inherited_mutant_requires_unmutated_suite_to_pass(self):
        """Why: an already failing inherited suite is not evidence that its mutant was caught."""
        self.mutation_fixture()
        stable_test = self.repo / 'tests/test_stable.py'
        stable_test.write_text(stable_test.read_text().replace('self.assertEqual(value(), 7)', 'self.assertEqual(value(), 8)'))
        self.git('add', 'tests/test_stable.py')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'failing inherited suite')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn('unmutated head', self.result(completed)['reason'])
        self.assertEqual(self.mutation_records(), [])

    def inherited_side_effect_fixture(self, target):
        config, _, stable = self.mutation_fixture()
        stable['scriptEnv'] = 'INHERITED_MUTANT'
        config['mutations'] = {'inherited': stable}
        self.write('.driver/test-gate.json', json.dumps(config))
        self.write('tests/test_stable.py', 'import os, unittest\nfrom pathlib import Path\n'
                   'class Inherited(unittest.TestCase):\n    def test_source(self):\n'
                   '        """Why: the inherited contract must reject a changed return."""\n'
                   '        source = Path(os.environ.get("INHERITED_MUTANT", "stable.py")).read_text()\n'
                   '        if os.environ.get("INHERITED_MUTANT"):\n'
                   f'            path = Path({target!r})\n'
                   '            path.write_text(path.read_text() + "\\n# mutation side effect\\n")\n'
                   '        self.assertIn("return 7", source)\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'inherited side-effect suite')
        self.write('docs/guide.md', 'documentation-only edit\n')

    def test_documentation_inherited_mutation_cannot_modify_production(self):
        """Why: inherited scriptEnv tests must not create a production diff after config-only classification."""
        self.inherited_side_effect_fixture('app.py')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('contract inputs or worktree changed', self.result(completed)['reason'])

    def test_documentation_inherited_mutation_cannot_modify_its_suite(self):
        """Why: unchanged inherited suites need the same read-only protection as changed tests."""
        self.inherited_side_effect_fixture('tests/test_stable.py')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('contract inputs or worktree changed', self.result(completed)['reason'])

    def test_test_only_added_suite_cannot_bypass_prior_lock(self):
        """Why: changing the input-set identity must not unlock an already locked assertion."""
        self.write('.gitignore', 'scratch/\n.driver/test-gate-evidence/\n')
        path = self.put_test(self.fixture_text('meaningful.py'))
        baseline = self.run_gate('baseline')
        self.assertEqual(baseline.returncode, 0, baseline.stdout + baseline.stderr)
        path.write_text(path.read_text().replace('assertEqual(value(), 2)', 'assertEqual(value(), 1)'))
        self.write('tests/test_added.py', self.fixture_text('vacuous.py'))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('changed or removed after fail-first lock', self.result(completed)['reason'])

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

    def test_colored_unittest_failure_is_still_a_reported_failure(self):
        """Why: Python 3.14 color on CI must not conceal an executed unittest assertion red."""
        spec = spec_from_file_location('colored_unittest_gate', Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER)))
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        source = self.write('tests/test_color.py', 'import unittest\nclass Color(unittest.TestCase):\n def test_value(self):\n  self.assertEqual(1, 2)\n')
        completed = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(source.parent), '-p', source.name], capture_output=True, text=True)
        self.assertNotEqual(completed.returncode, 0)
        output = completed.stdout + completed.stderr
        self.assertIn('FAILED', output)
        colored = output.replace('FAILED', '\x1b[1;31mFAILED\x1b[0m').replace('failures=1', '\x1b[31mfailures=1\x1b[0m')
        self.assertEqual(module.parse_test_counts(colored), {'tests': 1, 'failures': 1, 'errors': 0, 'skipped': 0, 'passed': 0})

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_uncaught_node_import_has_observed_errors(self):
        """Why: a failed file-level TAP case is infrastructure, not an executed assertion red."""
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER))
        spec = spec_from_file_location('loader_diagnostic_gate', runner)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        source = self.write('tests/test_crash.mjs', "import './absent.mjs';\n")
        completed = subprocess.run(['node', '--test', '--test-reporter=tap', str(source)],
                                   capture_output=True, text=True)
        self.assertNotEqual(completed.returncode, 0)
        counts = module.parse_test_counts(completed.stdout + completed.stderr)
        self.assertIsNotNone(counts)
        self.assertEqual(counts['failures'], 1)
        self.assertGreater(counts['errors'], 0)

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_nested_unittest_output_uses_outer_summary(self):
        """Why: nested gate witnesses must not conceal the outer assertion-failure count."""
        spec = spec_from_file_location("driver_test_gate_runner_nested", RUNNER)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        output = "# tests 1\n# pass 1\n# fail 0\nRan 1 test in 0.01s\nOK\nRan 29 tests in 1s\nFAILED (failures=14)\n"
        self.assertEqual(module.parse_test_counts(output),
                         {"tests": 29, "failures": 14, "errors": 0, "skipped": 0, "passed": 15})

    def test_executed_nonloader_failure_is_not_a_file_loader_crash(self):
        """Why: ERR_TEST_FAILURE alone also labels executed TypeErrors in inherited mutation suites."""
        spec = spec_from_file_location('executed_failure_gate', Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER)))
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        source = self.write('tests/test_executed.mjs',
                            "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                            "test('assertion', () => assert.equal(1, 2));\n"
                            "test('runtime', () => { const result = {}; return result.error.code; });\n")
        completed = subprocess.run(['node', '--test', '--test-reporter=tap', str(source)],
                                   capture_output=True, text=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn('ERR_ASSERTION', completed.stdout)
        counts = module.parse_test_counts(completed.stdout + completed.stderr)
        self.assertEqual(counts['failures'], 2)
        self.assertEqual(counts['errors'], 0)

    def test_nested_unittest_failure_does_not_override_outer_bare_ok(self):
        """Why: an inner caught mutant must not make an outer passing suite appear to fail."""
        spec = spec_from_file_location('outer_unittest_counts', Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER)))
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        for suffix, skipped in [('OK', 0), ('OK (skipped=2)', 2)]:
            with self.subTest(summary=suffix):
                output = f'Ran 1 test in 0.01s\nFAILED (failures=1, errors=1)\nRan 44 tests in 1s\n{suffix}\n'
                self.assertEqual(module.parse_test_counts(output),
                                 {'tests': 44, 'failures': 0, 'errors': 0, 'skipped': skipped, 'passed': 44 - skipped})

    def test_nested_node_counts_belong_to_last_reporter(self):
        """Why: totals from the outer Node reporter must not inherit an inner failure or skip count."""
        spec = spec_from_file_location('outer_node_counts', Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER)))
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        output = '# tests 1\n# pass 0\n# fail 1\n# skipped 1\n# tests 4\n# pass 4\n# fail 0\n# skipped 0\n'
        self.assertEqual(module.parse_test_counts(output),
                         {'tests': 4, 'failures': 0, 'errors': 0, 'skipped': 0, 'cancelled': 0, 'todo': 0, 'passed': 4})

    def test_test_only_change_passes_without_base_failure_or_mutation(self):
        """Why: test-only pin refreshes may pass on base but must still pass on head with a warning."""
        self.put_test(self.fixture_text('vacuous.py'))
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn('WARNING [test-gate]: test-only: head tests passed; fail-first and mutation proof are not required', completed.stdout)
        records = [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        self.assertTrue(any(row.get('phase') == 'implementation-tests' and row['testCounts']['passed'] > 0 for row in records))
        self.assertFalse(any(row.get('phase') in ('fail-first-base', 'mutation-spot-check') for row in records))
        self.assertFalse(list((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json')))

    def test_test_only_change_still_requires_head_success_and_why(self):
        """Why: warning-only baseline handling must not admit failing or unexplained tests."""
        self.put_test(self.fixture_text('meaningful.py'))
        failed = self.run_gate('check')
        self.assertEqual(failed.returncode, 1, failed.stdout + failed.stderr)
        self.assertIn('implementation tests failed', self.result(failed)['reason'])
        self.put_test('import unittest\nclass MissingWhy(unittest.TestCase):\n    def test_value(self):\n        self.assertTrue(True)\n')
        blocked = self.run_gate('check')
        self.assertEqual(blocked.returncode, 3, blocked.stdout + blocked.stderr)
        self.assertIn('Why:', self.result(blocked)['reason'])

    def test_test_only_annotation_is_distinct_and_delivery_failure_is_nonfatal(self):
        """Why: CI needs a test-only warning, but unavailable annotation transport must not block passing tests."""
        self.write('.gitignore', '.local/\n')
        self.put_test(self.fixture_text('vacuous.py'))
        for status in (0, 1):
            with self.subTest(annotation_exit=status):
                agent = self.write('.local/bin/buildkite-agent', f'#!{sys.executable}\nimport json, pathlib, sys\npathlib.Path(".local/annotation.json").write_text(json.dumps(sys.argv[1:]))\nsys.exit({status})\n')
                agent.chmod(0o755)
                environment = {**os.environ, 'BUILDKITE': 'true', 'BUILDKITE_BUILD_CHECKOUT_PATH': str(self.repo),
                               'PATH': str(agent.parent) + os.pathsep + os.environ['PATH']}
                completed = subprocess.run([sys.executable, str(RUNNER), '--root', str(self.repo), '--phase', 'check'],
                                           cwd=self.repo, env=environment, capture_output=True, text=True)
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertEqual(json.loads((self.repo / '.local/annotation.json').read_text()),
                                 ['annotate', '--style', 'warning', '--context', 'test-gate-test-only',
                                  'test-only: head tests passed; fail-first and mutation proof are not required'])

    def test_annotations_require_the_resolved_buildkite_checkout_for_both_warning_kinds(self):
        """Why: inherited CI variables must not let fixture roots annotate the real build."""
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER))
        spec = spec_from_file_location('checkout_annotation_gate', runner)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        warning = getattr(module, 'change_only_warning', None)
        self.assertTrue(callable(warning), 'the shared warning helper must enforce checkout identity')
        checkouts = {'unset': None, 'empty': '', 'different': str(self.repo / 'other-checkout'),
                     'matching': str(self.repo) + '/../' + self.repo.name}
        for kind in ('config-only', 'test-only'):
            for case, checkout in checkouts.items():
                with self.subTest(kind=kind, checkout=case):
                    environment = {'BUILDKITE': 'true'}
                    if checkout is not None:
                        environment['BUILDKITE_BUILD_CHECKOUT_PATH'] = checkout
                    with patch.dict(os.environ, environment, clear=True), \
                         patch.object(module.subprocess, 'run') as annotate, \
                         patch('builtins.print') as printed:
                        message = warning(self.repo, kind)
                    printed.assert_any_call(f'WARNING [test-gate]: {message}')
                    self.assertTrue(message.startswith(f'{kind}:'))
                    self.assertEqual(annotate.call_count, int(case == 'matching'))
                    if case == 'matching':
                        self.assertEqual(annotate.call_args.args[0],
                                         ['buildkite-agent', 'annotate', '--style', 'warning', '--context',
                                          f'test-gate-{kind}', message])

    def test_base_fail_first_cannot_publish_legacy_config_only_annotation(self):
        """Why: base tests using an old runner must not publish a fixture warning onto the official build."""
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER))
        spec = spec_from_file_location('base_annotation_gate', runner)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        self.write('.gitignore', '.local/\nscratch/\n.driver/test-gate-evidence/\n')
        legacy_source = RUNNER.read_text().replace(
            'if os.environ.get("BUILDKITE") and checkout and root.resolve() == Path(checkout).resolve():',
            'if os.environ.get("BUILDKITE"):')
        self.write('scripts/test_gate_runner.py', legacy_source)
        freshness = RUNNER.with_name('check_base_freshness.py')
        if freshness.is_file():
            # Historical base runners predate this dependency; current synthetic runners need it.
            self.write('scripts/check_base_freshness.py', freshness.read_text())
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'legacy runner base')
        base = self.git('rev-parse', 'HEAD').stdout.strip()
        annotations = self.repo / '.local/annotations.jsonl'
        child_environment = self.repo / '.local/child-environment.json'
        agent = self.write('.local/bin/buildkite-agent', f'#!{sys.executable}\nimport json, pathlib, sys\n'
                           f'with pathlib.Path({str(annotations)!r}).open("a") as stream:\n'
                           '    stream.write(json.dumps(sys.argv[1:]) + "\\n")\n')
        agent.chmod(0o755)
        self.put_test(
            'import json, os, subprocess, sys, unittest\nfrom pathlib import Path\nfrom app import value\n'
            'class LegacyFixture(unittest.TestCase):\n    def test_config_only_fixture(self):\n'
            '        """Why: replay old fixture annotation behavior before the production assertion."""\n'
            f'        Path({str(child_environment)!r}).write_text(json.dumps({{key: os.environ[key] for key in '
            '("BUILDKITE", "BUILDKITE_BUILD_CHECKOUT_PATH") if key in os.environ}))\n'
            '        fixture = Path(".local/config-fixture").resolve()\n'
            '        (fixture / ".driver").mkdir(parents=True)\n'
            '        subprocess.run(["git", "init", "-q", str(fixture)], check=True)\n'
            '        for name in ("gate-rules.json", "test-gate.json"):\n'
            '            (fixture / ".driver" / name).write_bytes((Path(".driver") / name).read_bytes())\n'
            '        subprocess.run(["git", "-C", str(fixture), "add", "."], check=True)\n'
            '        subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Fixture", "-c", '
            '"user.email=fixture@example.invalid", "commit", "-qm", "config base"], check=True)\n'
            '        (fixture / "settings.json").write_text("{}\\n")\n'
            '        result = subprocess.run([sys.executable, "scripts/test_gate_runner.py", "--root", '
            'str(fixture), "--phase", "check"], capture_output=True, text=True)\n'
            '        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)\n'
            '        self.assertIn("config-only: no mutation contract", result.stdout)\n'
            '        self.assertEqual(value(), 2)\n')
        rules, config = module.load_rules(self.repo)
        tests = {'tests/test_contract.py'}
        specs = module.command_specs(self.repo, rules, config, tests)
        environment = {'BUILDKITE': 'true', 'BUILDKITE_BUILD_CHECKOUT_PATH': str(self.repo),
                       'PATH': str(agent.parent) + os.pathsep + os.environ['PATH']}
        with patch.dict(os.environ, environment):
            observations, proofs, hermetic = module.fixture_baseline_observations(
                self.repo, base, base, tests, specs)
        self.assertEqual(observations[0]['counts']['failures'], 1)
        self.assertEqual(observations[0]['counts']['errors'], 0)
        self.assertEqual((proofs, hermetic), ([], []))
        self.assertFalse(annotations.exists(), 'base-snapshot legacy runner annotated the real build')
        self.assertEqual(json.loads(child_environment.read_text()), {})

    def test_host_commands_only_inherit_buildkite_at_checkout_root(self):
        """Why: all host phases must isolate non-checkout roots and cwd without altering caller environments."""
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', RUNNER))
        spec = spec_from_file_location('command_annotation_gate', runner)
        module = module_from_spec(spec)
        spec.loader.exec_module(module)
        snapshot = self.repo / '.local/snapshot'
        snapshot.mkdir(parents=True)
        (self.repo / '.local/subdir').mkdir()
        base = self.git('rev-parse', 'HEAD').stdout.strip()
        environment = {**os.environ, 'BUILDKITE': 'true',
                       'BUILDKITE_BUILD_CHECKOUT_PATH': str(self.repo / '..' / self.repo.name),
                       'TEST_GATE_SCRIPT': 'keep-the-mutant', 'ANNOTATION_TEST_SENTINEL': 'retained'}
        probe = ('import json, os; print(json.dumps({key: os.environ[key] for key in '
                 '("BUILDKITE", "BUILDKITE_BUILD_CHECKOUT_PATH", "TEST_GATE_SCRIPT", '
                 '"ANNOTATION_TEST_SENTINEL", "PYTHONDONTWRITEBYTECODE") if key in os.environ}))')
        for explicit in (False, True):
            for execute_root, cwd in ((self.repo, '.'), (snapshot, '.'), (self.repo, '.local/subdir')):
                with self.subTest(explicit=explicit, execute_root=execute_root, cwd=cwd), \
                     patch.dict(os.environ, environment):
                    observation = module.run_command(
                        self.repo, execute_root,
                        {'command': [sys.executable, '-c', probe], 'cwd': cwd, 'timeoutSeconds': 10},
                        phase='annotation-environment-probe', commit_sha=base, base_sha=base,
                        expected='only official checkout inherits Buildkite',
                        environment=environment if explicit else None)
                    self.assertEqual(observation['exitCode'], 0, observation['output'])
                    expected = {'TEST_GATE_SCRIPT': 'keep-the-mutant',
                                'ANNOTATION_TEST_SENTINEL': 'retained', 'PYTHONDONTWRITEBYTECODE': '1'}
                    if execute_root == self.repo and cwd == '.':
                        expected.update({key: environment[key] for key in
                                         ('BUILDKITE', 'BUILDKITE_BUILD_CHECKOUT_PATH')})
                    self.assertEqual(json.loads(observation['output']), expected)
                    self.assertEqual(os.environ['BUILDKITE'], 'true')
                    self.assertEqual(environment['BUILDKITE_BUILD_CHECKOUT_PATH'],
                                     str(self.repo / '..' / self.repo.name))

    def test_test_only_execution_cannot_create_changed_production(self):
        """Why: a test command must not create a production diff after test-only classification."""
        self.put_test('import unittest\nfrom pathlib import Path\nclass ChangedProductionWriter(unittest.TestCase):\n'
                      '    def test_write(self):\n        """Why: expose a changed producer during execution."""\n'
                      '        Path("app.py").write_text("def value():\\n    return 2\\n")\n'
                      '        self.assertTrue(True)\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('production source changed', self.result(completed)['reason'])
        self.assertNotIn('WARNING [test-gate]: test-only:', completed.stdout)

    def test_production_change_cannot_use_test_only_warning(self):
        """Why: passing pre-existing assertions must not exempt a production change from fail-first."""
        self.put_test(self.fixture_text('vacuous.py'))
        self.write('app.py', 'def value():\n    return 2\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 1, completed.stdout + completed.stderr)
        self.assertIn('passed on the base', self.result(completed)['reason'])
        self.assertNotIn('test-only:', completed.stdout)

    @unittest.skipUnless(RUNNER.is_file(), "test-gate runner is not implemented yet")
    def test_always_passing_test_is_rejected_on_base(self):
        """Why: a test that passes before the change does not prove the new behavior."""
        self.put_test(self.fixture_text("vacuous.py"))
        completed = self.run_gate()
        result = self.result(completed)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(result["status"], "fail")
        self.assertIn("passed on the base", result["reason"])

    def test_config_only_changes_pass_with_warning_locally(self):
        """Why: non-code changes rely on the real pipeline rather than claiming mutation coverage."""
        for name in ('settings.yml', 'settings.yaml', 'settings.json', 'docs/guide.md', '.buildkite/pipeline.yml'):
            with self.subTest(path=name):
                self.write(name, '{}\n')
                completed = self.run_gate('check')
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertEqual(self.result(completed)['status'], 'pass')
                self.assertIn('WARNING [test-gate]: config-only: no mutation contract; relies on real pipeline run', completed.stdout)
                self.assertIsNone(self.result(completed)['testsObserved'])

    def test_explicit_config_baseline_and_head_checks_remain_supported(self):
        """Why: an optional explicit baseline still records its proof before a test-only head warning."""
        self.write('.gitignore', 'scratch/\n.driver/test-gate-evidence/\n')
        self.write('app.py', "import json\nfrom pathlib import Path\ndef value():\n    return json.loads(Path('settings.json').read_text())['value']\n")
        self.write('settings.json', '{"value": 1}\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'configuration base')
        self.put_test(self.fixture_text('meaningful.py'))
        self.write('settings.json', '{"value": 2}\n')
        baseline = self.run_gate('baseline')
        self.assertEqual(baseline.returncode, 0, baseline.stdout + baseline.stderr)
        completed = self.run_gate('check')
        result = self.result(completed)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(result['status'], 'pass')
        self.assertIn('WARNING [test-gate]: test-only: head tests passed; fail-first and mutation proof are not required', completed.stdout)
        records = [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        self.assertTrue(any(row.get('phase') == 'fail-first-base' and row['testCounts']['failures'] > 0 for row in records))
        self.assertTrue(any(row.get('phase') == 'implementation-tests' and row['testCounts']['passed'] > 0 for row in records))
        self.assertNotIn('mutationCaught', result)

    def test_config_only_buildkite_annotation_is_exact_and_warning_styled(self):
        """Why: CI must publish the limitation as a warning annotation, not only a passing log line."""
        self.write('.gitignore', '.local/\n')
        agent = self.write('.local/bin/buildkite-agent', f'#!{sys.executable}\nimport json, pathlib, sys\npathlib.Path(".local/annotation.json").write_text(json.dumps(sys.argv[1:]))\n')
        agent.chmod(0o755)
        environment = {**os.environ, 'BUILDKITE': 'true', 'BUILDKITE_BUILD_CHECKOUT_PATH': str(self.repo),
                       'PATH': str(agent.parent) + os.pathsep + os.environ['PATH']}
        completed = subprocess.run([sys.executable, str(RUNNER), '--root', str(self.repo), '--phase', 'check'],
                                   cwd=self.repo, env=environment, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertTrue((self.repo / '.local/annotation.json').is_file(), completed.stdout)
        self.assertEqual(json.loads((self.repo / '.local/annotation.json').read_text()),
                         ['annotate', '--style', 'warning', '--context', 'test-gate-config-only',
                          'config-only: no mutation contract; relies on real pipeline run'])

    def test_production_without_changed_tests_remains_blocked(self):
        """Why: adding a config file must not exempt untested production changes."""
        self.write('settings.json', '{}\n')
        self.write('app.py', 'def value():\n    return 2\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('changed code has no changed tests', self.result(completed)['reason'])
        self.assertNotIn('config-only:', completed.stdout)

    def test_production_without_mutation_contract_remains_blocked(self):
        """Why: lack of an automatic mutation must not turn real production changes into config-only passes."""
        self.write('app.sh', 'printf 1\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'shell base')
        self.write('app.sh', 'printf 2\n')
        self.put_test('import subprocess, unittest\nclass TestValue(unittest.TestCase):\n'
                      '    def test_value(self):\n        """Why: shell output must change."""\n'
                      '        self.assertEqual(subprocess.check_output(["sh", "app.sh"], text=True), "2")\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertEqual(self.result(completed)['status'], 'blocked')
        self.assertIn('add a focused mutation contract', self.result(completed)['reason'])
        self.assertNotIn('config-only:', completed.stdout)

    def fixture_correction(self, *, old="stale", new="ready", original='self.assertEqual(value(), "ready")'):
        self.write("app.py", "from pathlib import Path\ndef value():\n    return Path('tests/fixtures/value.txt').read_text().strip()\n")
        self.write("tests/fixtures/value.txt", old)
        self.put_test('from app import value\nimport unittest\nclass TestValue(unittest.TestCase):\n'
                      '    def test_value(self):\n        """Why: fixture reports the expected value."""\n'
                      f'        {original}\n        self.assertTrue(value())\n')
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture baseline")
        self.write("tests/fixtures/value.txt", new)
        self.put_test('from app import value\nimport unittest\nclass TestValue(unittest.TestCase):\n'
                      '    def test_value(self):\n        """Why: fixture reports the expected value."""\n'
                      f'        {original}\n        self.assertTrue(value())\n        self.assertIsInstance(value(), str)\n')

    def test_fixture_correction_requires_real_contrast_and_records_it(self):
        """Why: corrected data may pass base only when the historical data demonstrably failed assertions."""
        self.fixture_correction()
        completed = self.run_gate("baseline")
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        lock = json.loads(next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json')).read_text())
        proof = lock['fixtureCorrections'][0]
        self.assertEqual(proof['fixturePaths'], ['tests/fixtures/value.txt'])
        self.assertNotEqual(proof['fixtureHashes']['tests/fixtures/value.txt']['base'], proof['fixtureHashes']['tests/fixtures/value.txt']['corrected'])
        self.assertGreater(proof['baseObservation']['testCounts']['failures'], 0)
        self.assertEqual(proof['correctedObservation']['testCounts']['failures'], 0)
        records = [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        self.assertTrue(any(row.get('phase') == 'fixture-correction-proof' for row in records))

    def test_fixture_correction_forged_lock_does_not_replace_host_runs(self):
        """Why: a lock claim without matching host contrast evidence must be refused on check."""
        self.fixture_correction()
        baseline = self.run_gate('baseline')
        self.assertEqual(baseline.returncode, 0, baseline.stdout)
        lock_path = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        lock = json.loads(lock_path.read_text())
        lock['fixtureCorrections'] = []
        lock_path.write_text(json.dumps(lock))
        checked = self.run_gate('check')
        self.assertEqual(checked.returncode, 3, checked.stdout)
        self.assertIn('proof missing', self.result(checked)['reason'])

    def test_fixture_correction_base_still_passes_is_rejected(self):
        """Why: a fixture label cannot exempt a suite that also passes with historical data."""
        self.fixture_correction(old='ready', new='ready ')
        result = self.run_gate()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('passed on the base', self.result(result)['reason'])

    def test_fixture_correction_cannot_mask_changed_production(self):
        """Why: a changed producer exercised by the test makes a fixture-only explanation unsafe."""
        self.fixture_correction()
        self.write('app.py', 'def value():\n    return "ready"\n')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('changed production', self.result(result)['reason'])

    def test_fixture_correction_errors_block(self):
        """Why: a base fixture crash is not an assertion-based contrast."""
        self.fixture_correction(old='invalid', new='1', original='self.assertEqual(int(value()), 1)')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('errors', self.result(result)['reason'])

    def test_new_only_fixture_cannot_claim_historical_contrast(self):
        """Why: a fixture absent from base has no historical value to replay."""
        self.write('app.py', "from pathlib import Path\ndef value():\n    return Path('tests/fixtures/value.txt').read_text().strip()\n")
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'producer without fixture')
        self.write('tests/fixtures/value.txt', 'ready')
        self.put_test('from app import value\nimport unittest\nclass TestValue(unittest.TestCase):\n'
                      '    def test_value(self):\n        """Why: require the expected result."""\n'
                      '        self.assertEqual(value(), "ready")\n')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('fail-first command had 1 errors', self.result(result)['reason'])

    def test_new_fixture_is_not_overlaid_on_base(self):
        """Why: a new fixture must produce an assertion failure on the base snapshot."""
        self.write('app.py', "from pathlib import Path\ndef value():\n    return Path('tests/fixtures/value.txt').is_file()\n")
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'producer without fixture')
        self.write('tests/fixtures/value.txt', 'ready')
        self.put_test('from app import value\nimport unittest\nclass TestValue(unittest.TestCase):\n'
                      '    def test_value(self):\n        """Why: require the new fixture."""\n'
                      '        self.assertTrue(value())\n')
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.result(result)['status'], 'pass')

    def test_fixture_without_changed_test_blocks(self):
        """Why: fixture-only changes have no changed test specification to validate."""
        self.fixture_correction()
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture corrected')
        self.write('tests/fixtures/value.txt', 'changed again')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('fixture', self.result(result)['reason'])

    def test_fixture_correction_rejects_removed_assertion(self):
        """Why: an older assertion must not disappear behind otherwise valid fixture data."""
        self.fixture_correction()
        test = self.repo / 'tests/test_contract.py'
        test.write_text(test.read_text().replace('        self.assertTrue(value())\n', ''), encoding='utf-8')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('assertion', self.result(result)['reason'])

    def hermetic_correction(self, *, old_env_assert="assert.equal(process.env.DRIVER_HERMETIC_ROOT, 'ready');", code_change=False):
        self.write('.gitignore', 'scratch/\n.driver/test-gate-evidence/\n')
        self.write('app.js', 'export const value = () => 1;\n')
        old = ('import { test } from "node:test";\nimport assert from "node:assert/strict";\n'
               'import { value } from "../app.js";\n'
               '// Why: the isolated root must be supplied and the producer must remain stable.\n'
               'test("root", () => {\n'
               f'  {old_env_assert}\n  assert.equal(value(), 1);\n}});\n')
        self.write('tests/test_hermetic.mjs', old)
        config = json.loads((self.repo / '.driver/test-gate.json').read_text())
        config['testCountRationales']['node-tests'] = 'Node TAP reports the observed number of cases.'
        self.write('.driver/test-gate.json', json.dumps(config))
        self.git('add', '.')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'hermetic base')
        corrected = old.replace('  ' + old_env_assert,
            '  const prior = process.env.DRIVER_HERMETIC_ROOT;\n  try {\n'
            "    process.env.DRIVER_HERMETIC_ROOT = 'ready';\n"
            '    ' + old_env_assert + '\n  } finally {\n'
            '    if (prior === undefined) delete process.env.DRIVER_HERMETIC_ROOT;\n'
            '    else process.env.DRIVER_HERMETIC_ROOT = prior;\n  }', 1)
        self.write('tests/test_hermetic.mjs', corrected)
        if code_change:
            self.write('app.js', 'export const value = () => 2;\n')

    def test_hermetic_repair_records_old_assertion_and_head_proof(self):
        """Why: a hermetic test may pass base only when its own historical version failed assertions there."""
        self.hermetic_correction()
        completed = self.run_gate('baseline')
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        lock = json.loads(next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json')).read_text())
        proof = lock['hermeticCorrections'][0]
        self.assertEqual(proof['testPaths'], ['tests/test_hermetic.mjs'])
        self.assertNotEqual(proof['testHashes']['tests/test_hermetic.mjs']['base'], proof['testHashes']['tests/test_hermetic.mjs']['corrected'])
        self.assertGreater(proof['baseObservation']['testCounts']['failures'], 0)
        self.assertEqual(proof['baseObservation']['testCounts']['errors'], 0)
        self.assertEqual(proof['headObservation']['testCounts']['failures'], 0)
        records = [json.loads(line) for line in (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        self.assertTrue(any(row.get('phase') == 'hermetic-correction-proof' for row in records))

    def test_hermetic_old_test_also_passes_still_fails(self):
        """Why: setting an already satisfied environment is not fail-first evidence."""
        self.hermetic_correction(old_env_assert='assert.equal(value(), 1);')
        result = self.run_gate()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('passed on the base', self.result(result)['reason'])

    def test_hermetic_rejects_removed_assertion(self):
        """Why: a test repair must preserve every prior behavior check."""
        self.hermetic_correction()
        path = self.repo / 'tests/test_hermetic.mjs'
        path.write_text(path.read_text().replace('  assert.equal(value(), 1);\n', ''), encoding='utf-8')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('assertion', self.result(result)['reason'])

    def test_hermetic_rejects_changed_producer(self):
        """Why: a producer change must not be hidden under a test-environment correction."""
        self.hermetic_correction(code_change=True)
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('changed production', self.result(result)['reason'])

    def test_hermetic_rejects_crashing_old_test(self):
        """Why: a missing-key crash is not an assertion failure."""
        self.hermetic_correction(old_env_assert='assert.equal(process.env.DRIVER_HERMETIC_ROOT.toString(), "ready");')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('assertion', self.result(result)['reason'])

    def test_hermetic_rejects_missing_restore(self):
        """Why: changing process environment without restoration is not a hermetic repair."""
        self.hermetic_correction()
        path = self.repo / 'tests/test_hermetic.mjs'
        path.write_text(path.read_text().replace('    else process.env.DRIVER_HERMETIC_ROOT = prior;\n', ''), encoding='utf-8')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('restoration', self.result(result)['reason'])

    def test_hermetic_rejects_non_isolation_addition(self):
        """Why: added unrelated assertions or behavior cannot ride the environment-only exception."""
        self.hermetic_correction()
        path = self.repo / 'tests/test_hermetic.mjs'
        path.write_text(path.read_text().replace('  try {\n', '  assert.equal(value(), 1);\n  try {\n'), encoding='utf-8')
        result = self.run_gate()
        self.assertEqual(result.returncode, 3, result.stdout)
        self.assertIn('non-environment-isolation', self.result(result)['reason'])

    def test_hermetic_rejects_forged_lock(self):
        """Why: the check phase must rerun the old test, not trust a JSON claim."""
        self.hermetic_correction()
        baseline = self.run_gate('baseline')
        self.assertEqual(baseline.returncode, 0, baseline.stdout)
        path = next((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))
        lock = json.loads(path.read_text())
        lock['hermeticCorrections'] = []
        path.write_text(json.dumps(lock))
        checked = self.run_gate('check')
        self.assertEqual(checked.returncode, 3, checked.stdout)
        self.assertIn('proof missing', self.result(checked)['reason'])

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
    def test_changed_shell_kill_fallback_is_caught_in_snapshot(self):
        """Why: a changed shell kill must be mutatable and caught by an assertion without changing the original."""
        rules_path = self.repo / ".driver/gate-rules.json"
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        rules["checks"].append({
            "id": "node-tests", "kind": "command",
            "command": ["node", "--test", "--test-reporter=tap", "tests/test_contract.mjs"],
        })
        rules_path.write_text(json.dumps(rules), encoding="utf-8")
        config_path = self.repo / ".driver/test-gate.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["testCountRationales"]["node-tests"] = "Node TAP reports the observed total."
        config_path.write_text(json.dumps(config), encoding="utf-8")
        old = '#!/bin/sh\nif [ -f "$session/kill" ]; then\n  kill -KILL "$PPID" 2>/dev/null || true\n  kill -KILL 0 2>/dev/null || true\nfi\n'
        new = '#!/bin/sh\nif [ -f "$session/kill" ]; then\n  kill -KILL 0 2>/dev/null || true\n  kill -KILL "$PPID" 2>/dev/null || true\nfi\n'
        self.write("scripts/fixture.sh", old)
        self.write(".gitignore", "scratch/test-gate/\n")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "commit", "-qm", "shell fixture base")
        self.write("scripts/fixture.sh", new)
        self.write("tests/test_contract.mjs", "\n".join([
            '// Why: the job group must be signalled before the parent fallback.',
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            'import { readFileSync } from "node:fs";',
            'const source = readFileSync("scripts/fixture.sh", "utf8");',
            'test("group first", () => assert.ok(source.indexOf("kill -KILL 0") < source.indexOf("kill -KILL \\\"$PPID\\\"")));',
            '',
        ]))
        baseline = self.run_gate("baseline")
        self.assertEqual(self.result(baseline)["status"], "pass", baseline.stdout + baseline.stderr)
        checked = self.run_gate("check")
        result = self.result(checked)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(result["mutationPath"], "scripts/fixture.sh")
        self.assertTrue(result["mutationCaught"])
        self.assertEqual(self.repo.joinpath("scripts/fixture.sh").read_text(encoding="utf-8"), new)

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
