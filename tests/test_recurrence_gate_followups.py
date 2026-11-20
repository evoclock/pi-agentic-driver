"""Isolated conformance for full pre-push selection and owned signal cleanup."""
import json
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import gate


class RecurrenceFollowups(unittest.TestCase):
    def test_pre_push_selects_complete_current_implementation_set(self):
        """Why: merging new tests or checks must invalidate a previous partial selection."""
        select = getattr(gate, 'pre_push_commands', None)
        self.assertTrue(callable(select))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tests').mkdir()
            (root / 'tests/test_model_negative_controls.mjs').write_text('// fixture\n')
            python = ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']
            rules = {'checks': [{'id': 'python-tests', 'kind': 'command', 'command': python}]}
            commands = select(root, rules)
            self.assertIn(["node", "scripts/model_negative_controls.mjs", "--changed"], commands)
            self.assertIn(["python3", "scripts/check_base_freshness.py"], commands)
            self.assertNotIn(["node", "scripts/review_preflight.mjs"], commands)
            self.assertTrue(any('tests/test_model_negative_controls.mjs' in command for command in commands))
            self.assertIn(python, commands)
            (root / 'tests/test_new_after_merge.mjs').write_text('// new upstream case\n')
            extra = ['python3', '-m', 'unittest', 'discover', '-s', 'extra']
            rules['checks'].append({'id': 'new-tests', 'kind': 'command', 'command': extra})
            updated = select(root, rules)
            self.assertTrue(any('tests/test_new_after_merge.mjs' in command for command in updated))
            self.assertIn(extra, updated)

    def test_pre_push_rejects_changed_head_and_failed_implementation_suite(self):
        """Why: an earlier green sample cannot cover a changed head or a failing suite."""
        from types import SimpleNamespace
        from unittest.mock import patch
        check = getattr(gate, 'pre_push_main', None)
        self.assertTrue(callable(check))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(gate, 'pre_push_commands', return_value=[['fixture-tests']]):
                with patch.object(gate, 'implementation_snapshot', side_effect=['old', 'new']), patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                    self.assertEqual(check(root, {'checks': []}), 3)
                with patch.object(gate, 'implementation_snapshot', return_value='same'), patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(returncode=1)):
                    self.assertEqual(check(root, {'checks': []}), 1)
                with patch.object(gate, 'implementation_snapshot', return_value='same'), patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                    self.assertEqual(check(root, {'checks': []}), 0)

    def test_push_payload_is_bound_to_tested_head(self):
        """Why: a hook must not verify HEAD while Git pushes a different commit."""
        validate = getattr(gate, 'validate_push_head', None)
        self.assertTrue(callable(validate))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            (root / 'fixture').write_text('fixture')
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            row = f'refs/heads/feature {head} refs/heads/feature {"0" * 40}\n'
            self.assertEqual(validate(root, row), head)
            for invalid in ('', 'malformed', row.replace(head, '1' * 40)):
                with self.assertRaises(ValueError):
                    validate(root, invalid)

    def test_java_tlc_discovery_skips_macos_stub_and_preserves_precedence(self):
        """Why: a macOS launcher stub must not hide a working keg-only runtime."""
        from unittest.mock import patch
        resolve = getattr(gate, 'resolve_java_tlc', None)
        self.assertTrue(callable(resolve))
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            jar = home / '.local/share/tlc/tla2tools.jar'
            jar.parent.mkdir(parents=True)
            jar.write_bytes(b'fixture')
            local = str(home / '.local/bin/java')
            keg = '/opt/homebrew/opt/openjdk/bin/java'
            def probe(argv, **kwargs):
                if argv[0] == '/usr/bin/java':
                    raise subprocess.CalledProcessError(1, argv, stderr=b'Unable to locate a Java Runtime')
                return subprocess.CompletedProcess(argv, 0)
            with patch.object(gate.subprocess, 'run', side_effect=probe) as run:
                java, found_jar = resolve(env={'JAVA': '/usr/bin/java'}, home=home)
                self.assertEqual(java, local)
                self.assertEqual(found_jar, str(jar))
                self.assertEqual([call.args[0][0] for call in run.call_args_list], ['/usr/bin/java', local])
            with patch.object(gate.subprocess, 'run', side_effect=lambda argv, **kw: probe(['/usr/bin/java'] if argv[0] == local else argv)):
                self.assertEqual(resolve(env={}, home=home)[0], keg)
            with patch.object(gate.subprocess, 'run', side_effect=probe):
                self.assertEqual(resolve(env={'JAVA': '/custom/java', 'TLA2TOOLS': str(jar)}, home=home), ('/custom/java', str(jar)))

    def test_java_tlc_discovery_fails_hard_with_actionable_paths(self):
        """Why: missing Java or TLC must fail before admission, with an exact repair path."""
        from unittest.mock import patch
        resolve = getattr(gate, 'resolve_java_tlc', None)
        self.assertTrue(callable(resolve))
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.object(gate.subprocess, 'run', side_effect=OSError('missing')):
                with self.assertRaisesRegex(ValueError, '/opt/homebrew/opt/openjdk/bin/java'):
                    resolve(env={}, home=home)
            with patch.object(gate.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                with self.assertRaisesRegex(ValueError, 'TLA2TOOLS.*tla2tools.jar'):
                    resolve(env={}, home=home)

    def test_sigterm_unwinds_owned_gate_and_restores_handler(self):
        """Why: cancellation must withdraw owned state rather than strand FIFO callers."""
        interrupt = getattr(gate, 'termination_as_interrupt', None)
        self.assertTrue(callable(interrupt))
        prior = signal.getsignal(signal.SIGTERM)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            with self.assertRaises(KeyboardInterrupt):
                with interrupt():
                    with gate.observable_gate_lock(root, 10):
                        signal.raise_signal(signal.SIGTERM)
            self.assertFalse((root / '.local/locks/test-gate.lock').exists())
            self.assertEqual(list((root / '.local/locks/test-gate.queue').glob('ticket-*.json')), [])
            self.assertEqual(signal.getsignal(signal.SIGTERM), prior)


if __name__ == '__main__':
    unittest.main()
