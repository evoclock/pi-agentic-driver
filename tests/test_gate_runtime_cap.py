"""Reviewed gate runtime caps (380s per command, 900s shared total) and their 25% headroom contract."""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / 'scripts/test_gate_runner.py'
CONFIG = ROOT / '.driver/test-gate.json'
RULES = ROOT / '.driver/gate-rules.json'
GATE = ROOT / 'scripts/gate.py'


def load_runner():
    spec = importlib.util.spec_from_file_location('driver_test_gate_runner_cap', RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_gate():
    spec = importlib.util.spec_from_file_location('driver_shared_gate_cap', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeCapTests(unittest.TestCase):
    def setUp(self):
        self.runner = load_runner()
        self.config = json.loads(CONFIG.read_text())

    def test_runner_ceiling_is_the_reviewed_380_seconds(self):
        """Why: the slowest recorded node suite (281.207s) needs a cap with 25% headroom."""
        self.assertEqual(self.runner.MAX_COMMAND_SECONDS, 380)

    def test_configured_cap_is_380_seconds(self):
        """Why: config and runner ceiling must move together in one reviewed transition."""
        self.assertEqual(self.config['caps']['commandTimeoutSeconds'], 380)

    def test_runner_accepts_380_and_rejects_anything_higher(self):
        """Why: the ceiling stays finite; only the reviewed value is admitted."""
        rules = {'checks': []}
        accepted = dict(self.config, caps=dict(self.config['caps'], commandTimeoutSeconds=380))
        try:
            specs = self.runner.command_specs(ROOT, rules, accepted, set())
        except self.runner.Blocked as error:
            self.fail(f'380s cap refused: {error}')
        self.assertEqual(specs, [])
        rejected = dict(self.config, caps=dict(self.config['caps'], commandTimeoutSeconds=380.001))
        with self.assertRaises(self.runner.Blocked):
            self.runner.command_specs(ROOT, rules, rejected, set())

    def test_recorded_load_bound_runtimes_clear_25_percent_headroom_at_380(self):
        """Why: the runner blocks when a prior run exceeds 75% of the cap (elapsedMs > cap*750)."""
        cap = self.config['caps']['commandTimeoutSeconds']
        for elapsed_ms in (182794, 234848, 236463, 240016, 240030, 281207):
            self.assertLessEqual(elapsed_ms, cap * 750, elapsed_ms)


class SharedTotalCapTests(unittest.TestCase):
    def setUp(self):
        self.gate = load_gate()
        self.rules = json.loads(RULES.read_text())

    def test_shared_gate_budget_is_the_reviewed_900_seconds(self):
        """Why: the shared gate (shared-total) last ran 600.060s and timed out at the 600s budget."""
        self.assertEqual(self.rules['speedBudgetSeconds'], 900)

    def test_rules_validator_admits_900(self):
        """Why: no code ceiling may silently refuse the reviewed shared budget."""
        try:
            validated = self.gate.validate_rules(dict(self.rules, speedBudgetSeconds=900))
        except ValueError as error:
            self.fail(f'900s shared budget refused: {error}')
        self.assertEqual(validated['speedBudgetSeconds'], 900)

    def test_recorded_shared_total_clears_25_percent_headroom_at_configured_budget(self):
        """Why: preflight blocks shared-total when its last run exceeds 75% of the budget."""
        budget = self.rules['speedBudgetSeconds']
        self.assertEqual(self.gate.runtime_headroom_findings('shared-total', 600.060, budget), [])


if __name__ == '__main__':
    unittest.main()
