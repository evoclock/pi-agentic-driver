"""Exercise PR metadata fetching without network access or an installed gh CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(os.environ.get('PR_CHECKS_SCRIPT', ROOT / '.buildkite/pr-checks.sh'))
FAKE_TOOL = r'''
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'tool': name, 'args': args}) + '\n')
if name == 'git':
    sys.exit(1 if args[:2] == ['cat-file', '-e'] else 0)
if name == 'curl':
    failure = os.environ.get('FETCH_FAILURE', '')
    if failure == 'transport':
        sys.exit(7)
    if failure == 'http' and '--fail' in args:
        sys.exit(22)
    output = args[args.index('--output') + 1]
    payload = '{broken' if failure == 'malformed' else json.dumps({
        'base': {'sha': 'a' * 40}, 'title': 'Fixture title', 'body': 'Fixture body',
    })
    Path(output).write_text(payload)
    sys.exit(0)
sys.exit(90)
'''


class PrChecksFetchTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / 'scratch'
        scratch.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'calls.jsonl'
        for name in ('curl', 'git'):
            tool = self.bin / name
            tool.write_text(f'#!{sys.executable}\n' + FAKE_TOOL)
            tool.chmod(0o755)
        (self.bin / 'mkdir').symlink_to('/bin/mkdir')
        (self.bin / 'python3').symlink_to(sys.executable)
        self.repo = next(line.split('=', 1)[1] for line in SCRIPT.read_text().splitlines()
                         if line.startswith('repo='))

    def run_check(self, failure=''):
        env = {
            'PATH': str(self.bin), 'HOME': str(self.root), 'TMPDIR': str(self.root),
            'GH_TOKEN': 'fixture-credential', 'BUILDKITE_PULL_REQUEST': '12',
            'BUILDKITE_BUILD_ID': 'fixture', 'CALL_LOG': str(self.log),
            'FETCH_FAILURE': failure, 'PYTHONDONTWRITEBYTECODE': '1',
        }
        result = subprocess.run(['/bin/bash', str(SCRIPT), 'wording'], cwd=self.root,
                                env=env, capture_output=True, text=True, timeout=5)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_wording_fetch_works_without_gh_and_pins_the_returned_base(self):
        """Why: a minimal CI agent must fetch authenticated metadata before trusted-base linting."""
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.bin / 'gh').exists())
        requests = [call['args'] for call in calls if call['tool'] == 'curl']
        self.assertEqual(len(requests), 1)
        args = requests[0]
        self.assertIn(f'https://api.github.com/repos/{self.repo}/pulls/12', args)
        self.assertIn('Authorization: Bearer fixture-credential', args)
        self.assertIn('Accept: application/vnd.github+json', args)
        self.assertIn('--fail', args)
        self.assertEqual(args[args.index('--connect-timeout') + 1], '10')
        self.assertEqual(args[args.index('--max-time') + 1], '30')
        self.assertIn({'tool': 'git', 'args': ['fetch', '--quiet', 'origin', 'a' * 40]}, calls)
        self.assertNotIn('fixture-credential', result.stdout + result.stderr)

    def test_http_failure_stops_before_fetch_or_lint_even_with_valid_json(self):
        """Why: a failed HTTP response must not be accepted merely because its body looks valid."""
        result, calls = self.run_check('http')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call['tool'] for call in calls], ['curl'])
        self.assertNotIn('fixture-credential', result.stdout + result.stderr)

    def test_transport_failure_stops_without_retry_or_gh_fallback(self):
        """Why: unavailable transport is a failed check, not permission to continue or retry."""
        result, calls = self.run_check('transport')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call['tool'] for call in calls], ['curl'])

    def test_malformed_metadata_stops_before_fetch_or_lint(self):
        """Why: a successful HTTP request cannot invent a trusted base from invalid JSON."""
        result, calls = self.run_check('malformed')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call['tool'] for call in calls], ['curl'])


if __name__ == '__main__':
    unittest.main()
