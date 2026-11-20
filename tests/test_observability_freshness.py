"""Execute observability's real host/offline base-selection blocks in local Git fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys

import test_test_gate as harness
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ObservabilityFreshness(unittest.TestCase):
    git = harness.TestGateWorkflow.git
    write = harness.TestGateWorkflow.write

    def setUp(self):
        harness.TestGateWorkflow.setUp(self)
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('branch', '-M', 'main')
        self.write('.gitignore', '.scratch/\n.local/\n.ci-observability/\nscratch/\n.driver/test-gate-evidence/\n__pycache__/\n')
        helper = ROOT / 'scripts/check_base_freshness.py'
        if helper.is_file():
            self.write('scripts/check_base_freshness.py', helper.read_text())
        rules = json.loads((self.repo / '.driver/gate-rules.json').read_text())
        rules['checks'].append({'id': 'node-tests', 'kind': 'command',
                                'command': ['node', '--test', '--test-reporter=tap', 'tests/*.mjs']})
        self.write('.driver/gate-rules.json', json.dumps(rules))
        config = json.loads((self.repo / '.driver/test-gate.json').read_text())
        config['testCountRationales']['node-tests'] = 'Use the actual native TAP case total.'
        self.write('.driver/test-gate.json', json.dumps(config))
        self.write('app.mjs', 'export const value = 1;\n')
        self.write('stable.mjs', 'export const historical = true;\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'historical main')
        self.old = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('remote', 'add', 'origin', str(self.repo))
        self.git('switch', '-c', 'feature')
        self.git('switch', 'main')
        self.write('stable.mjs', 'export const historical = true;\nexport const approved = () => true;\n')
        self.git('add', 'stable.mjs')
        self.git('commit', '-qm', 'main gains a required named export')
        self.fresh = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('switch', 'feature')
        self.git('merge', '--no-ff', 'main', '-m', 'integrate current main')
        self.head = self.git('rev-parse', 'HEAD').stdout.strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.old)
        self.script = (ROOT / 'scripts/ci-observability.sh').read_text()
        toolchain = self.repo / '.scratch/python/bin'
        toolchain.mkdir(parents=True)
        (toolchain / 'python3').symlink_to(sys.executable)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('BUILDKITE', 'GIT_CONFIG_'))
                    and key not in {'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'}}
        self.env.update({'RUNNER_TEMP': str(self.repo / '.scratch/runner'),
                         'GITHUB_RUN_ID': 'fixture', 'GITHUB_RUN_ATTEMPT': '1',
                         'CI_OBSERVABILITY_PYTHON_ROOT': str(toolchain.parent),
                         'PAD_OBSERVABILITY_BASE': self.fresh,
                         'PAD_OBSERVABILITY_HEAD': self.head})

    def shell(self, block):
        return subprocess.run(['bash', '-euo', 'pipefail', '-c',
                               block + '\nprintf "SELECTED_BASE=%s\\n" "$base"\n'],
                              cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30)

    def host(self):
        # Execute only the actual pre-materialization block, never Docker or installs.
        prefix, separator, _ = self.script.partition('git archive "$head"')
        self.assertTrue(separator, 'host verification must precede source materialization')
        return self.shell(prefix)

    def offline(self):
        marker = '> /scratch/evidence/tests.before\n'
        _, separator, tail = self.script.partition(marker)
        self.assertTrue(separator, 'offline verification must precede the official gate')
        block, separator, _ = tail.partition('printf \'%s\\n\' "$base"')
        self.assertTrue(separator, 'record the selected base without rewriting tests')
        return self.shell(block)

    def selected(self, completed):
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        lines = [line.removeprefix('SELECTED_BASE=') for line in completed.stdout.splitlines()
                 if line.startswith('SELECTED_BASE=')]
        self.assertEqual(len(lines), 1, completed.stdout)
        return lines[0]

    def assert_blocked(self, completed, message):
        self.assertEqual(completed.returncode, 3, completed.stdout + completed.stderr)
        self.assertIn(message, completed.stdout + completed.stderr)
        self.assertNotIn('missing or is a symlink', completed.stdout + completed.stderr)
        self.assertEqual(list((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json')), [])

    def test_host_fetches_instead_of_selecting_cached_tracking_tip(self):
        """Why: Linux can cache an old origin/main even after the feature merged current main."""
        self.assertEqual(self.git('merge-base', 'HEAD', 'origin/main').stdout.strip(), self.old)
        self.assertEqual(self.selected(self.host()), self.fresh)
        self.assertEqual(self.git('rev-parse', 'origin/main').stdout.strip(), self.fresh)

    def test_host_rejects_a_head_missing_live_main(self):
        """Why: stale checkout ancestry must stop before any source image or baseline is used."""
        self.git('switch', '--detach', self.old)
        self.assert_blocked(self.host(), 'stale base: merge origin/main (--no-ff)')

    def test_host_fetch_failure_never_falls_back_to_cache(self):
        """Why: an unavailable origin is not permission to use a previously cached base."""
        self.git('remote', 'set-url', 'origin', str(self.repo / '.scratch/absent-origin'))
        self.assert_blocked(self.host(), 'base freshness: git observation failed (fetch)')

    def test_offline_image_rejects_stale_main_against_verified_host_sample(self):
        """Why: the contained image must not replace the freshly observed base with a historical ref."""
        self.git('update-ref', 'refs/heads/main', self.old)
        self.assert_blocked(self.offline(), 'stale base:')

    def test_offline_image_rejects_head_drift(self):
        """Why: a valid base cannot explain a different image head than the host verified."""
        self.git('commit', '--allow-empty', '-qm', 'unexpected head generation')
        self.assert_blocked(self.offline(), 'base freshness: HEAD changed')

    def test_offline_image_uses_verified_sample_without_network(self):
        """Why: rechecking materialized refs must preserve the network-none acceptance boundary."""
        self.git('remote', 'set-url', 'origin', str(self.repo / '.scratch/absent-origin'))
        self.assertEqual(self.selected(self.offline()), self.fresh)
        self.assertIn('--network none', self.script)
        self.assertIn('PAD_OBSERVABILITY_BASE="$base" PAD_OBSERVABILITY_HEAD="$head"', self.script)

    def test_fresh_selection_produces_behavioral_red_not_missing_export(self):
        """Why: inherited exports from current main must load before a new assertion supplies red evidence."""
        self.write('tests/test_current.mjs',
                   "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
                   "import {approved} from '../stable.mjs';\nimport {value} from '../app.mjs';\n"
                   "// Why: stable exports must load before the changed value assertion executes.\n"
                   "test('current behavior', () => { assert.equal(approved(), true); assert.equal(value, 2); });\n")
        self.write('app.mjs', 'export const value = 2;\n')
        self.git('add', 'app.mjs', 'tests/test_current.mjs')
        self.git('commit', '-qm', 'new feature assertion and implementation')
        selected = self.selected(self.host())
        self.assertEqual(selected, self.fresh)
        completed = subprocess.run([sys.executable, str(ROOT / 'scripts/test_gate_runner.py'),
                                    '--root', str(self.repo), '--phase', 'baseline', '--base', selected],
                                   cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn('ERR_ASSERTION', completed.stdout)
        self.assertNotIn('SyntaxError', completed.stdout)
        records = [json.loads(line) for line in
                   (self.repo / '.driver/test-gate-evidence/checks.jsonl').read_text().splitlines()]
        child = next(row for row in records if row.get('phase') == 'fail-first-base')
        self.assertEqual(child['testCounts']['errors'], 0)
        self.assertEqual(child['testCounts']['failures'], 1)
        self.assertEqual(child['baseCommitSha'], self.fresh)
        self.assertEqual(len(list((self.repo / '.driver/test-gate-evidence').glob('baseline-lock-*.json'))), 1)
