"""Behavioral fixtures for the handover boundary."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/session_handover.py'


class HandoverTest(unittest.TestCase):
    def test_write_validate_and_consume_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'source.txt').write_text('evidence\n')
            claim = {'label': 'derived', 'text': 'Resume from evidence', 'pointer': 'source.txt:1'}
            sections = {'goal': [claim], 'next_fix_plan_item': [claim], 'changed_files': [], 'state': [], 'next_step': [claim], 'open_items': [], 'decisions': [], 'Rejected': []}
            input_path = root / 'input.json'
            handover = root / 'HANDOVER.json'
            input_path.write_text(json.dumps(sections))

            def run(*arguments):
                return subprocess.run([sys.executable, str(SCRIPT), *arguments, '--root', str(root)], capture_output=True, text=True)

            self.assertEqual(run('write', str(handover), '--input', str(input_path)).returncode, 0)
            self.assertEqual(run('validate', str(handover)).returncode, 0)
            self.assertEqual(run('consume', str(handover)).returncode, 0)
            self.assertTrue((root / 'HANDOVER.json.consumed').is_file())
            self.assertNotEqual(run('consume', str(handover)).returncode, 0)
            self.assertNotEqual(run('write', str(handover), '--input', str(input_path)).returncode, 0)
            data = json.loads(handover.read_text())
            original = json.loads(handover.read_text())
            for section in ('goal', 'next_fix_plan_item', 'changed_files'):
                broken = json.loads(json.dumps(original))
                del broken['sections'][section]
                handover.write_text(json.dumps(broken))
                self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            for pointer in ('https://github.com/a/b', 'https://buildkite.com/a/b',
                            '../outside.txt:1', 'session.jsonl#entry=abc@' + '0' * 64):
                broken = json.loads(json.dumps(original))
                broken['sections']['goal'][0]['pointer'] = pointer
                handover.write_text(json.dumps(broken))
                self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            broken = json.loads(json.dumps(original))
            broken['checks'] = [{'command': ['true'], 'exit_code': 0, 'commit': 'a' * 40}]
            handover.write_text(json.dumps(broken))
            self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            session = root / 'session.jsonl'
            line = '{"id":"abc","text":"evidence"}\n'
            session.write_text(line)
            digest = hashlib.sha256(line.encode()).hexdigest()
            for pointer, valid in ((f'session.jsonl#entry=abc@{digest}', True),
                                   (f'session.jsonl#entry=ab@{digest}', False),
                                   (f'session.jsonl#entry=abc@{"0" * 64}', False)):
                broken = json.loads(json.dumps(original))
                broken['sections']['goal'][0]['pointer'] = pointer
                handover.write_text(json.dumps(broken))
                self.assertEqual(run('validate', str(handover)).returncode == 0, valid)
            handover.write_text(json.dumps(original))
            subprocess.run(['git', '-C', str(root), 'init', '-q'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Julen', '-c', 'user.email=julen@example.invalid',
                            'commit', '-q', '--allow-empty', '-m', 'Fixture'], check=True)
            commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            checked = root / 'CHECKED.json'
            self.assertEqual(run('write', str(checked), '--input', str(input_path), '--check', 'true').returncode, 0)
            attestation = json.loads((root / 'CHECKED.json.checks.json').read_text())
            self.assertEqual(attestation['exit_code'], 0)
            self.assertEqual(attestation['commit'], commit)
            self.assertEqual(attestation['handover_sha256'], hashlib.sha256(checked.read_bytes()).hexdigest())
            self.assertEqual(json.loads(checked.read_text())['checks'], [])
            broken = json.loads(json.dumps(original))
            broken['sections']['goal'][0]['pointer'] = commit
            handover.write_text(json.dumps(broken))
            self.assertEqual(run('validate', str(handover)).returncode, 0)
            broken['sections']['goal'][0]['pointer'] = '0' * 40
            handover.write_text(json.dumps(broken))
            self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            handover.write_text(json.dumps(original))
            data = json.loads(handover.read_text())
            del data['sections']['Rejected']
            handover.write_text(json.dumps(data))
            self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            data = json.loads(json.dumps(original))
            data['sections']['next_step'][0]['pointer'] = ''
            handover.write_text(json.dumps(data))
            self.assertNotEqual(run('validate', str(handover)).returncode, 0)
            data['sections']['next_step'][0]['pointer'] = 'source.txt:2'
            handover.write_text(json.dumps(data))
            self.assertNotEqual(run('validate', str(handover)).returncode, 0)


if __name__ == '__main__':
    unittest.main()
