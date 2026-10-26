"""Why: each iteration must have one observable acceptance and one consumable handover."""
import importlib.util
import os
import signal
import time
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'ralph.py'
if SCRIPT.exists():
    spec = importlib.util.spec_from_file_location('ralph', SCRIPT)
    ralph = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ralph)
else:
    ralph = None


class RalphTest(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(ralph, 'Ralph runner must exist on this code path')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root.joinpath('handoff').mkdir()
        self.plan = self.root / 'fix_plan.json'
        self.state = self.root / 'state.json'
        self.budget = self.root / 'budget.json'
        self.budget.write_text(json.dumps({'depth': 1, 'nodes': 1, 'concurrency': 1, 'iterations': 5, 'wall_seconds': 5}))
        sections = {k: [] for k in ('goal', 'next_fix_plan_item', 'changed_files', 'state', 'next_step', 'open_items', 'decisions', 'Rejected')}
        self.root.joinpath('source.txt').write_text('goal\n')
        claim = {'label': 'derived', 'text': 'one item', 'pointer': 'source.txt:1'}
        for key in ('goal', 'next_fix_plan_item', 'next_step'):
            sections[key] = [claim]
        self.root.joinpath('sections.json').write_text(json.dumps(sections))

    def items(self, work=None, fan=None):
        work = work or [sys.executable, '-c', 'pass']
        self.plan.write_text(json.dumps({'items': [
            {'id': str(i), 'work': work, 'accept': [sys.executable, '-c', 'pass'],
             'fanout': fan if fan is not None else {'depth': 0, 'nodes': 0, 'concurrency': 0}, 'sections': 'sections.json'}
            for i in range(3)]}))

    def iterate(self):
        return ralph.run(self.root, self.plan, self.state, self.budget)

    def consume(self, result):
        subprocess.run([sys.executable, str(SCRIPT.with_name('session_handover.py')), 'consume', result['handover'],
                        '--root', str(self.root)], check=True, capture_output=True)

    def test_one_item_and_handover_each_iteration(self):
        """Why: a resumed worker must not skip the source-indexed handover."""
        self.items()
        first = self.iterate()
        self.assertEqual(('completed', '0'), (first['outcome'], first['item']))
        self.assertTrue(Path(first['handover']).exists())
        with self.assertRaisesRegex(ValueError, 'consume previous'):
            self.iterate()
        self.consume(first)
        second = self.iterate()
        self.assertEqual('1', second['item'])
        self.assertNotEqual(first['handover'], second['handover'])

    def test_plateau_gives_up_after_two_stalls(self):
        """Why: unchanged remaining work must trip the circuit breaker."""
        self.items(work=[sys.executable, '-c', 'raise SystemExit(1)'])
        first = self.iterate()
        self.consume(first)
        second = self.iterate()
        self.consume(second)
        third = self.iterate()
        self.assertEqual('gave up', third['outcome'])
        self.assertIn('gap analysis', third['reason'])
        self.assertTrue(Path(third['handover']).exists())
        self.consume(third)
        with self.assertRaisesRegex(ValueError, 'terminal outcome'):
            self.iterate()

    def test_interrupted_handover_refuses_reexecution(self):
        """Why: a crash after work but before state must not repeat the work."""
        self.items()
        (self.root / 'handoff' / 'ralph-1.json').write_text('{}')
        self.assertEqual('blocked', self.iterate()['outcome'])

    def test_final_handover_must_be_consumed(self):
        """Why: completion must not bypass the last handover."""
        self.items()
        for _ in range(3):
            result = self.iterate()
            if result['item'] != '2':
                self.consume(result)
        with self.assertRaisesRegex(ValueError, 'consume previous'):
            self.iterate()
        self.consume(result)
        self.assertEqual('stop', self.iterate()['next'])

    def test_fanout_refusal_does_not_execute_work(self):
        """Why: over-budget work must never reach its command."""
        marker = self.root / 'executed'
        self.items(work=[sys.executable, '-c', f"open({str(marker)!r}, 'w').close()"],
                   fan={'depth': 3, 'nodes': 1, 'concurrency': 1})
        result = self.iterate()
        self.assertEqual('blocked', result['outcome'])
        self.assertFalse(marker.exists())
        self.assertTrue(Path(result['handover']).exists())

    def test_killed_work_is_held_without_replay(self):
        """Why: interruption after side effects must never replay ambiguous work."""
        marker = self.root / 'executed'
        self.items(work=[sys.executable, '-c', f"open({str(marker)!r}, 'a').write('x'); __import__('time').sleep(30)"])
        process = subprocess.Popen([sys.executable, str(SCRIPT), '--root', str(self.root), '--plan', str(self.plan),
                                    '--state', str(self.state), '--budget', str(self.budget)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            for _ in range(200):
                if marker.exists():
                    break
                time.sleep(.02)
            self.assertTrue(marker.exists())
        finally:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        result = self.iterate()
        self.assertEqual('blocked', result['outcome'])
        self.assertEqual('x', marker.read_text())
        self.assertTrue(Path(result['intent']).exists())

    def test_invalid_sections_hold_typed_outcome(self):
        """Why: an invalid handover must preserve a typed, held attempt."""
        self.items()
        self.root.joinpath('sections.json').write_text('{}')
        result = self.iterate()
        self.assertEqual('blocked', result['outcome'])
        self.assertTrue(Path(result['intent']).exists())
        self.assertEqual('blocked', self.iterate()['outcome'])

    def test_missing_sections_path_holds_typed_outcome(self):
        """Why: malformed metadata after work must not turn a held attempt into an untyped error."""
        self.items()
        plan = json.loads(self.plan.read_text())
        del plan['items'][0]['sections']
        self.plan.write_text(json.dumps(plan))
        result = self.iterate()
        self.assertEqual('blocked', result['outcome'])
        self.assertTrue(Path(result['intent']).exists())
        self.assertEqual('blocked', self.iterate()['outcome'])

    def test_boolean_and_unbounded_budgets_refused(self):
        """Why: editable budgets cannot raise host ceilings or use boolean integers."""
        self.items()
        for key, value in [('nodes', True), ('wall_seconds', 3601), ('iterations', 101)]:
            budget = json.loads(self.budget.read_text())
            budget[key] = value
            self.budget.write_text(json.dumps(budget))
            with self.assertRaisesRegex(ValueError, 'invalid fan-out budget'):
                self.iterate()
            self.budget.write_text(json.dumps({'depth': 1, 'nodes': 1, 'concurrency': 1, 'iterations': 5, 'wall_seconds': 5}))


if __name__ == '__main__':
    unittest.main()
