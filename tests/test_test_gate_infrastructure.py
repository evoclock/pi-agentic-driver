"""Real CLI fixtures for freshness and uncaught Node loader failures."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_test_gate as harness

ROOT = Path(__file__).resolve().parents[1]


class InfrastructureGate(unittest.TestCase):
    setUp = harness.TestGateWorkflow.setUp
    git = harness.TestGateWorkflow.git
    write = harness.TestGateWorkflow.write
    run_gate = harness.TestGateWorkflow.run_gate
    result = harness.TestGateWorkflow.result

    def node_base(self):
        rules = json.loads((self.repo / '.driver/gate-rules.json').read_text())
        rules['checks'].append({'id': 'node-tests', 'kind': 'command',
                                'command': ['node', '--test', '--test-reporter=tap', 'tests/*.mjs']})
        self.write('.driver/gate-rules.json', json.dumps(rules))
        config = json.loads((self.repo / '.driver/test-gate.json').read_text())
        config['testCountRationales']['node-tests'] = 'Native Node TAP totals count executed cases.'
        self.write('.driver/test-gate.json', json.dumps(config))
        self.write('.gitignore', 'scratch/\n.local/\n.driver/test-gate-evidence/\n')
        self.write('app.mjs', 'export const value = 1;\n')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'node base')

    def node_test(self, prefix=''):
        return self.write('tests/test_loader.mjs', prefix +
                          "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                          "import { value } from '../app.mjs';\n"
                          "// Why: the assertion must execute before a red is accepted.\n"
                          "test('behavior', () => assert.equal(value, 2));\n")

    def locks(self):
        return list((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))

    def test_uncaught_import_is_infrastructure_not_lockable(self):
        """Why: file-level TAP ERR_TEST_FAILURE must never stand in for an executed assertion."""
        self.node_base()
        self.node_test("import './missing-loader-helper.mjs';\n")
        completed = self.run_gate()
        self.assertEqual(self.result(completed)['status'], 'blocked', completed.stdout)
        self.assertIn('crash', completed.stdout)
        self.assertEqual(self.locks(), [])
        records = [json.loads(line) for line in
                   (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        child = next(row for row in records if row.get('phase') == 'fail-first-base')
        self.assertNotEqual(child['exitCode'], 0)
        self.assertGreater(child['testCounts']['errors'], 0)
        self.assertEqual(child['testCounts']['failures'], 1)
        self.assertIn('ERR_MODULE_NOT_FOUND', completed.stdout)

    def test_refresh_import_crash_preserves_existing_lock(self):
        """Why: an audited refresh cannot replace valid assertion evidence with a loader crash."""
        self.node_base()
        self.node_test()
        red = self.run_gate()
        self.assertEqual(red.returncode, 0, red.stdout)
        lock = self.locks()[0]
        before = lock.read_bytes()
        self.node_test("import './missing-loader-helper.mjs';\n")
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', ROOT / 'scripts/test_gate_runner.py'))
        completed = subprocess.run([sys.executable, str(runner), '--root', str(self.repo),
                                    '--phase', 'refresh', '--reason', 'exercise loader rejection'],
                                   capture_output=True, text=True, cwd=self.repo)
        self.assertEqual(self.result(completed)['status'], 'blocked', completed.stdout)
        self.assertIn('crash', completed.stdout)
        self.assertEqual(lock.read_bytes(), before)

    def test_caught_import_and_harmless_output_remain_behavioral(self):
        """Why: expected import errors and console text must not trigger substring classification."""
        self.node_base()
        self.write('tests/test_loader.mjs',
                   "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                   "import { value } from '../app.mjs';\n"
                   "// Why: catching an expected import failure is a real executed assertion.\n"
                   "test('behavior', async () => {\n"
                   " console.log('ERR_MODULE_NOT_FOUND ERR_TEST_FAILURE testCodeFailure');\n"
                   " await assert.rejects(import('./absent.mjs'), {code: 'ERR_MODULE_NOT_FOUND'});\n"
                   " assert.equal(value, 2);\n});\n")
        completed = self.run_gate()
        self.assertEqual(completed.returncode, 0, completed.stdout)
        self.assertEqual(len(self.locks()), 1)
        self.write('app.mjs', 'export const value = 2 === 2 ? 2 : 1;\n')
        completed = self.run_gate('check')
        self.assertEqual(completed.returncode, 0, completed.stdout)

    def test_dynamic_uncaught_import_is_infrastructure(self):
        """Why: an import rejected inside a running test is not an assertion-red either."""
        self.node_base()
        self.write('tests/test_loader.mjs',
                   "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                   "// Why: loading must succeed before this assertion can execute.\n"
                   "test('behavior', async () => { await import('./absent.mjs'); assert.equal(1, 2); });\n")
        completed = self.run_gate()
        self.assertEqual(self.result(completed)['status'], 'blocked', completed.stdout)
        self.assertEqual(self.locks(), [])

    def origin_base(self):
        self.git('branch', '-M', 'main')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        rules = json.loads((self.repo / '.driver/gate-rules.json').read_text())
        rules['baseRef'] = 'origin/main'
        self.write('.driver/gate-rules.json', json.dumps(rules))
        self.write('.gitignore', 'scratch/\n.local/\n.driver/test-gate-evidence/\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'origin configuration')
        self.git('remote', 'add', 'origin', str(self.repo))
        self.git('fetch', 'origin', 'main:refs/remotes/origin/main')
        self.git('switch', '-c', 'worker')

    def advance_main(self):
        self.git('switch', 'main')
        self.write('tests/test_new_main.py', 'import unittest\nclass Added(unittest.TestCase):\n'
                   ' def test_added(self):\n  """Why: a new inherited contract exists only on main."""\n'
                   '  self.assertEqual(1, 1)\n')
        self.git('add', 'tests/test_new_main.py')
        self.git('commit', '-qm', 'new inherited test')
        self.git('switch', 'worker')

    def test_stale_main_fetches_and_never_reports_missing_test(self):
        """Why: main advancing after checkout must block every gate phase before source findings."""
        self.origin_base()
        self.advance_main()
        for phase in ('baseline', 'check', 'refresh'):
            with self.subTest(phase=phase):
                completed = self.run_gate(phase)
                payload = self.result(completed)
                self.assertEqual(payload['status'], 'blocked', completed.stdout)
                self.assertIn('stale base: merge origin/main (--no-ff)', payload['reason'])
                self.assertNotIn('missing or is a symlink', completed.stdout)
                self.assertEqual(self.locks(), [])

    def test_fresh_checkout_passes_and_records_lease_start(self):
        """Why: the shared check must observe a fetched base and record the verified lease start."""
        self.origin_base()
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', ROOT / 'scripts/test_gate_runner.py'))
        script = runner.with_name('check_base_freshness.py')
        completed = subprocess.run([sys.executable, str(script), '--root', str(self.repo), '--lease-start'],
                                   capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        record = json.loads((self.repo / '.local/lease-base.json').read_text())
        self.assertEqual(record['leaseBase'], self.git('rev-parse', 'HEAD').stdout.strip())
        self.assertEqual(record['fetchedBase'], record['leaseBase'])
        self.assertEqual(self.run_gate('check').returncode, 0)

    def test_stale_lease_start_is_rejected_without_record(self):
        """Why: lease tooling cannot vouch for a start that is behind freshly fetched main."""
        self.origin_base()
        self.advance_main()
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', ROOT / 'scripts/test_gate_runner.py'))
        completed = subprocess.run([sys.executable, str(runner.with_name('check_base_freshness.py')),
                                    '--root', str(self.repo), '--lease-start'], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('stale base:', completed.stdout)
        self.assertFalse((self.repo / '.local/lease-base.json').exists())

    def test_configured_local_base_is_also_checked(self):
        """Why: isolated fixtures and explicit base refs must retain the same ancestry contract."""
        self.origin_base()
        self.advance_main()
        rules = json.loads((self.repo / '.driver/gate-rules.json').read_text())
        rules['baseRef'] = 'main'
        self.write('.driver/gate-rules.json', json.dumps(rules))
        completed = self.run_gate()
        self.assertEqual(self.result(completed)['status'], 'blocked', completed.stdout)
        self.assertIn('stale base: merge main (--no-ff)', completed.stdout)
        self.assertEqual(self.locks(), [])
