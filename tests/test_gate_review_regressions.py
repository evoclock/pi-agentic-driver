"""Closed loader-path matrix and live-anchor/override CLI recurrence checks."""
import os
from pathlib import Path
import subprocess
import sys
import unittest

import test_test_gate_infrastructure as infrastructure

ROOT = Path(__file__).resolve().parents[1]
# Every supported loading phase must be exercised through both JavaScript import paths.
LOAD_FAILURES = {
    'resolution': "import './absent-module.mjs'; export const answer = 1;\n",
    'linking': "import { absentNamedExport } from './app.mjs'; export const answer = absentNamedExport;\n",
    'parsing': 'export const answer = ;\n',
}
LOADER_PATHS = tuple((mode, failure) for mode in ('static', 'dynamic') for failure in LOAD_FAILURES)


class GateReviewRegressions(unittest.TestCase):
    def fixture(self):
        fixture = infrastructure.InfrastructureGate('test_uncaught_import_is_infrastructure_not_lockable')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.node_base()
        return fixture

    def cli(self, fixture, phase, base=None, env=None):
        runner = Path(os.environ.get('TEST_GATE_SCRIPT', ROOT / 'scripts/test_gate_runner.py'))
        argv = [sys.executable, str(runner), '--root', str(fixture.repo), '--phase', phase]
        if base:
            argv += ['--base', base]
        if phase == 'refresh':
            argv += ['--reason', 'real CLI review recurrence']
        return subprocess.run(argv, cwd=fixture.repo, capture_output=True, text=True,
                              env=env, timeout=30)

    def loader_test(self, fixture, mode, caught=False):
        prefix = "import '../helper.mjs';\n" if mode == 'static' else ''
        action = "await import('../helper.mjs'); " if mode == 'dynamic' else ''
        if caught:
            action = "await assert.rejects(import('../helper.mjs'), SyntaxError); "
        fixture.write('tests/test_loader.mjs', prefix +
                      "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                      "import {value} from '../app.mjs';\n"
                      "// Why: loading must complete, or an expected rejection be caught, before asserting behavior.\n"
                      "test('behavior', async () => { " + action + "assert.equal(value, 2); });\n")

    def test_closed_loader_path_matrix_never_creates_or_refreshes_a_crash_lock(self):
        """Why: static/dynamic resolution, linking and parsing all precede behavioral assertion evidence."""
        self.assertEqual(set(LOADER_PATHS), {
            ('static', 'resolution'), ('static', 'linking'), ('static', 'parsing'),
            ('dynamic', 'resolution'), ('dynamic', 'linking'), ('dynamic', 'parsing'),
        })
        for mode, failure in LOADER_PATHS:
            for phase in ('baseline', 'refresh'):
                with self.subTest(mode=mode, failure=failure, phase=phase):
                    fixture = self.fixture()
                    fixture.write('helper.mjs', LOAD_FAILURES[failure])
                    fixture.git('add', 'helper.mjs')
                    fixture.git('commit', '-qm', 'loader fixture base')
                    before = None
                    if phase == 'refresh':
                        fixture.node_test()
                        red = self.cli(fixture, 'baseline')
                        self.assertEqual(red.returncode, 0, red.stdout + red.stderr)
                        lock = fixture.locks()[0]
                        before = lock.read_bytes()
                    self.loader_test(fixture, mode)
                    completed = self.cli(fixture, phase)
                    status = fixture.result(completed)['status']
                    if phase == 'baseline':
                        self.assertEqual((status, len(fixture.locks())), ('blocked', 0), completed.stdout)
                    else:
                        self.assertEqual((status, lock.read_bytes()), ('blocked', before), completed.stdout)
                    self.assertIn('crash', completed.stdout)
                    if failure in {'linking', 'parsing'}:
                        self.assertIn('SyntaxError', completed.stdout)

    def test_caught_dynamic_syntax_and_linking_failures_are_executed_controls(self):
        """Why: expected import failures must not invalidate a later genuine assertion red or green."""
        for failure in ('linking', 'parsing'):
            with self.subTest(failure=failure):
                fixture = self.fixture()
                fixture.write('helper.mjs', LOAD_FAILURES[failure])
                fixture.git('add', 'helper.mjs')
                fixture.git('commit', '-qm', 'expected loader error base')
                self.loader_test(fixture, 'dynamic', caught=True)
                red = self.cli(fixture, 'baseline')
                self.assertEqual(red.returncode, 0, red.stdout + red.stderr)
                fixture.write('app.mjs', 'export const value = 2 === 2 ? 2 : 1;\n')
                green = self.cli(fixture, 'check')
                self.assertEqual(green.returncode, 0, green.stdout + green.stderr)

    def assert_stale_override(self, phase, forged_observation=False):
        fixture = self.fixture()
        fixture.origin_base()
        historical = fixture.git('rev-parse', 'HEAD').stdout.strip()
        fixture.node_test()
        before = None
        if phase == 'refresh':
            red = self.cli(fixture, 'baseline', historical)
            self.assertEqual(red.returncode, 0, red.stdout + red.stderr)
            lock = fixture.locks()[0]
            before = lock.read_bytes()
            fixture.node_test('// Changed test input must not refresh against a stale live anchor.\n')
        fixture.advance_main()
        env = os.environ.copy()
        if forged_observation:
            env.update(PAD_OBSERVABILITY_BASE=historical, PAD_OBSERVABILITY_HEAD=historical)
        completed = self.cli(fixture, phase, historical, env)
        payload = fixture.result(completed)
        self.assertEqual(payload['status'], 'blocked', completed.stdout)
        self.assertIn('stale base: merge origin/main (--no-ff)', payload['reason'])
        self.assertEqual(completed.returncode, 3)
        if before is None:
            self.assertEqual(fixture.locks(), [])
        else:
            self.assertEqual(lock.read_bytes(), before)

    def test_baseline_historical_override_cannot_replace_live_anchor(self):
        """Why: an ancestor comparison SHA cannot lock a head missing freshly fetched live main."""
        self.assert_stale_override('baseline')

    def test_check_historical_override_cannot_replace_live_anchor(self):
        """Why: ordinary check must reject stale main before test-only or inherited proof paths."""
        self.assert_stale_override('check')

    def test_refresh_historical_override_preserves_existing_lock(self):
        """Why: refresh cannot use an old comparison revision to erase the live-anchor requirement."""
        self.assert_stale_override('refresh')

    def test_environment_claims_cannot_enable_offline_bypass_on_an_ordinary_checkout(self):
        """Why: supplied observation strings are not proof of actual contained offline execution."""
        self.assert_stale_override('baseline', forged_observation=True)

    def test_historical_comparison_still_works_when_live_anchor_is_contained(self):
        """Why: separating anchor from comparison must preserve legitimate historical comparisons."""
        fixture = self.fixture()
        fixture.origin_base()
        historical = fixture.git('rev-parse', 'HEAD').stdout.strip()
        fixture.git('switch', 'main')
        fixture.write('current-main.txt', 'new main generation\n')
        fixture.git('add', 'current-main.txt')
        fixture.git('commit', '-qm', 'advance live main')
        fixture.git('switch', 'worker')
        fixture.git('merge', '--no-ff', 'main', '-m', 'contain live main')
        fixture.node_test()
        completed = self.cli(fixture, 'baseline', historical)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(len(fixture.locks()), 1)

    def test_contained_helper_mode_is_unavailable_to_an_ordinary_checkout(self):
        """Why: an offline flag must not become another ordinary-CLI freshness escape hatch."""
        fixture = self.fixture()
        script = ROOT / 'scripts/check_base_freshness.py'
        completed = subprocess.run([sys.executable, str(script), '--root', str(fixture.repo),
                                    '--contained-observation'], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn('contained observation', completed.stdout + completed.stderr)
        self.assertEqual(fixture.locks(), [])
