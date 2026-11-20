import importlib.util
import ast
import unittest
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock

PATH = Path(__file__).resolve().parents[1] / 'scripts/gate_runtime_preflight.py'
API = None
if PATH.is_file():
    spec = importlib.util.spec_from_file_location('gate_runtime_preflight', PATH)
    API = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(API)


class HeadroomTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(API, 'gate runtime headroom preflight is required')

    def test_blocks_before_effect_with_step_and_numbers(self):
        """Why: the observed639.623s run cannot fit600s with25 percent headroom."""
        run = Mock()
        with self.assertRaisesRegex(API.HeadroomError, r'native-test-gate.*639\.623.*600.*25.*853'):
            API.run_step('native-test-gate', 600, [{'step':'native-test-gate','elapsedSeconds':639.623}], run)
        run.assert_not_called()

    def test_900_allows_the_observed_runtime(self):
        """Why:900s provides more than the required headroom without changing any policy."""
        run = Mock(return_value='ran')
        self.assertEqual(API.run_step('native-test-gate', 900, [{'step':'native-test-gate','elapsedSeconds':639.623}], run), 'ran')
        run.assert_called_once_with()

    def test_reviewed_supervisor_budget_and_outer_timeout(self):
        """Why: merged native workload needs2400 aggregate with2460 outer, independent of child caps."""
        tree = ast.parse((PATH.parent / 'gate_background_runner.py').read_text())
        values = {n.targets[0].id:ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id in ('NATIVE_AGGREGATE_CAP_SECONDS','TOOL_TIMEOUT_SECONDS')}
        self.assertEqual(values.get('NATIVE_AGGREGATE_CAP_SECONDS'),2400)
        self.assertEqual(values.get('TOOL_TIMEOUT_SECONDS'),2460)

    def test_merged_inventory_runtime_needs_more_than_900(self):
        """Why: reported1381.865s inventory run is only a lower bound for the larger G8 workload."""
        with self.assertRaises(API.HeadroomError):
            API.check_headroom('native-test-gate', 1381.865, 900)
        self.assertGreaterEqual(API.check_headroom('native-test-gate', 1381.865, 2400)['headroomPercent'], 25)

    def test_exact_boundary_and_one_over(self):
        """Why: exactly25 percent remaining is allowed, anything less is rejected."""
        self.assertEqual(API.check_headroom('a', 450, 600)['headroomPercent'], 25)
        with self.assertRaises(API.HeadroomError):
            API.check_headroom('a', 450.001, 600)

    def test_latest_matching_step_not_an_average(self):
        """Why: old or unrelated fast observations cannot conceal the last slow run."""
        records = [{'step':'a','elapsedSeconds':1}, {'step':'a','elapsedSeconds':500}, {'step':'b','elapsedSeconds':1}]
        run = Mock()
        with self.assertRaisesRegex(API.HeadroomError, 'a.*500.*600'):
            API.run_step('a', 600, records, run)
        run.assert_not_called()

    def test_plan_checks_every_step_before_any_run(self):
        """Why: a later step with inadequate headroom must be named before execution."""
        with self.assertRaisesRegex(API.HeadroomError, 'second.*80.*100'):
            API.check_plan({'first':100, 'second':100}, [{'step':'first','elapsedSeconds':1}, {'step':'second','elapsedSeconds':80}])

    def test_unknown_history_is_explicit_not_a_pass_measurement(self):
        """Why: a first run has no historical measurement to fabricate or average."""
        result = API.check_plan({'first':100}, [])
        self.assertEqual(result[0]['history'], 'unobserved')
        self.assertIsNone(result[0]['lastSeconds'])

    def test_invalid_numbers_fail_closed(self):
        """Why: invalid, negative or nonfinite observations and caps cannot authorize execution."""
        for value in [True, -1, float('nan'), float('inf'), '1']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                API.check_headroom('a', value, 600)
        for value in [False, 0, -1, float('nan'), float('inf'), '600']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                API.check_headroom('a', 1, value)

    def test_background_supervisor_blocks_before_lock_or_child(self):
        """Why: the real entry point must reject low headroom before touching a lock or starting a gate."""
        parent = PATH.parents[1] / '.scratch/headroom-tests'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as temporary:
            root = Path(temporary); (root / 'scripts').mkdir()
            for name in ['gate_runtime_preflight.py', 'gate_background_runner.py']:
                shutil.copyfile(PATH.parent / name, root / 'scripts' / name)
            prior = root / '.scratch/runs/prior'; prior.mkdir(parents=True)
            (prior / 'status.json').write_text(json.dumps({'step':'check','state':'failed','elapsedSeconds':1900}))
            out = root / '.scratch/runs/current'
            result = subprocess.run([sys.executable, str(root / 'scripts/gate_background_runner.py'), 'check', str(out)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 3, result.stderr)
            status = json.loads((out / 'status.json').read_text())
            self.assertEqual(status['state'], 'preflight-blocked')
            self.assertRegex(status['reason'], r'check.*1900.*2400.*2534')
            self.assertFalse((out / 'command.out').exists())
            self.assertFalse((root / '.local').exists())
            # Both public names execute the same native gate and must share history.
            (prior / 'status.json').write_text(json.dumps({'step':'test-gate','state':'failed','elapsedSeconds':1900}))
            other = root / '.scratch/runs/alias'
            result = subprocess.run([sys.executable, str(root / 'scripts/gate_background_runner.py'), 'check', str(other)], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertEqual(json.loads((other / 'status.json').read_text())['state'], 'preflight-blocked')
            self.assertFalse((other / 'command.out').exists())

    def test_all_recorded_caps_are_checked_without_raising_them(self):
        """Why: native command and make-gate caps remain independent of the aggregate900."""
        self.assertTrue(callable(getattr(API,'check_recorded_steps',None)), 'per-step cap preflight required')
        rows = API.check_recorded_steps([{'phase':'implementation-tests','argv':['node','test.mjs'],'cwd':'.','elapsedMs':89000}],240,168.8,600)
        self.assertEqual({r['capSeconds'] for r in rows},{240,600})
        try:
            summary = API.check_recorded_steps([{'phase':'check','argv':['scripts/test_gate_runner.py','--phase','check'],'elapsedMs':639623}],240,168.8,600)
        except API.HeadroomError:
            self.fail('aggregate summary is not a per-command240s observation')
        self.assertEqual(len(summary),1)
        with self.assertRaisesRegex(API.HeadroomError, 'node.*190.*240'):
            API.check_recorded_steps([{'phase':'implementation-tests','argv':['node','test.mjs'],'elapsedMs':190000}],240,168.8,600)
        with self.assertRaisesRegex(API.HeadroomError, 'make-gate.*500.*600'):
            API.check_recorded_steps([],240,500,600)

    def test_does_not_mutate_history(self):
        """Why: preflight is read-only and cannot rewrite observed gate evidence."""
        records = [{'step':'a','elapsedSeconds':3}]
        API.check_plan({'a':10}, records)
        self.assertEqual(records, [{'step':'a','elapsedSeconds':3}])
