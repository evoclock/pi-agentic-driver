"""Violation fixtures for the shared gate's hidden-install and hook-bypass checks."""

import hashlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gate import allowance_matches, run_internal as run_gate_check  # noqa: E402


class GateFixtureTest(unittest.TestCase):
    def fixture(self, name):
        return (ROOT / "tests/fixtures/gate" / name).read_bytes()

    def run_fixture_check(self, check_id, files):
        rules = {"hashScopedAllowances": [], "baseRef": "origin/main"}
        with patch("gate.policy_files", return_value=files), patch("gate.changed_hook_paths", return_value=set()):
            return run_gate_check(check_id, ROOT, rules)

    def test_skill_bootstrap_install_fails_then_passes_when_removed(self):
        name = "skills/example/SKILL.md"
        files = {name: self.fixture("hidden-install/SKILL.md")}
        self.assertTrue(self.run_fixture_check("no-hidden-installs", files))
        files.pop(name)
        self.assertEqual(self.run_fixture_check("no-hidden-installs", files), [])

    def test_hook_bypass_fails_then_passes_when_removed(self):
        name = "scripts/unsafe-commit.sh"
        files = {name: self.fixture("hook-bypass.sh")}
        self.assertTrue(self.run_fixture_check("hook-integrity", files))
        files.pop(name)
        self.assertEqual(self.run_fixture_check("hook-integrity", files), [])

    def test_hash_allowance_only_matches_exact_file_content(self):
        name = ".buildkite/pipeline.yml"
        content = self.fixture("sfw-install.yml")
        allowance = [{
            "check": "no-hidden-installs",
            "path": name,
            "sha256": hashlib.sha256(content).hexdigest(),
            "reason": "A reviewed install-time CI fixture uses Socket Firewall.",
        }]
        self.assertTrue(allowance_matches(allowance, "no-hidden-installs", name, content))
        self.assertFalse(allowance_matches(allowance, "no-hidden-installs", name, content + b"\n# changed"))
        self.assertFalse(allowance_matches(allowance, "hook-integrity", name, content))


if __name__ == "__main__":
    unittest.main()
