"""Conformance for the measured, audited aggregate native budget transition."""
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import gate

class BudgetTransition(unittest.TestCase):
    def test_measured_native_budget_has_25_percent_headroom(self):
        """Why: the measured 1586.978s proof must not repeatedly exhaust its aggregate budget."""
        cap = getattr(gate, 'NATIVE_BUDGET_SECONDS', 0)
        self.assertGreaterEqual(cap, math.ceil(1586.978 / .75))
        self.assertEqual(cap, 2400)
        self.assertEqual(gate.runtime_headroom_findings('native-check-total', 1586.978, cap), [])

    def test_preflight_uses_the_audited_native_budget(self):
        """Why: changing a declared budget alone must not leave the old admission cap active."""
        resolve = getattr(gate, 'resolve_java_tlc', None)
        self.assertTrue(callable(resolve))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / '.driver/test-gate-evidence/shared-runtimes.jsonl'
            history.parent.mkdir(parents=True)
            history.write_text(json.dumps({'step':'native-check-total','elapsed':1586.978}) + '\n')
            with patch.dict(gate.os.environ), patch.object(gate, 'required_tool_findings', return_value=[]), patch.object(gate, 'resolve_java_tlc', return_value=('/java','/tlc.jar')), patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
                self.assertEqual(gate.preflight_findings(root, {'speedBudgetSeconds':600}), [])

if __name__ == '__main__':
    unittest.main()
