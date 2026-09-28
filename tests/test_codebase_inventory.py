"""Offline generator and commit-gate fixtures. Run: python3 -m unittest tests/test_codebase_inventory.py"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from codebase_inventory import generate  # noqa: E402
from codebase_inventory_gate import check  # noqa: E402


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.scratch.cleanup)
        self.repo = Path(self.scratch.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    def put(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        self.git("add", name)

    def test_js_ts_python_and_shell_static_symbols(self):
        self.put("src/worker.ts", 'import { a } from "node:fs";\nexport function deliver() { return 1 }\nexport const recover = (id) => id;\n')
        self.put("scripts/check.py", 'import os\ndef inspect(): pass\nclass Gate: pass\n')
        self.put("scripts/build.sh", '#!/bin/sh\nsource helpers.sh\nrun() { :; }\n')
        self.put("scripts/runner", '#!/usr/bin/env bash\nstart() { :; }\n')
        rows = [json.loads(line) for line in generate(self.repo).splitlines()]
        self.assertEqual([r["path"] for r in rows], sorted(r["path"] for r in rows))
        ts = next(r for r in rows if r["filename"] == "worker.ts")
        self.assertEqual(ts["language"], "typescript")
        self.assertIn("deliver", [f["name"] for f in ts["functions"]])
        self.assertIn("recover", ts["exported_symbols"])
        self.assertIn("node:fs", ts["dependencies"])
        self.assertTrue(any(r["filename"] == "runner" and r["language"] == "shell" for r in rows))
        self.assertEqual(rows, [json.loads(line) for line in generate(self.repo).splitlines()])

    def test_gate_refreshes_and_requires_staging(self):
        self.put("src/main.js", "export function first() {}\n")
        allowed, reason = check(self.repo)
        self.assertFalse(allowed)
        self.assertIn("stage", reason)
        self.git("add", "pipeline_output/codebase_inventory.jsonl")
        self.assertTrue(check(self.repo)[0])
        (self.repo / "src/main.js").write_text("export function second() {}\n")
        self.assertFalse(check(self.repo)[0])
        self.git("add", "src/main.js")
        allowed, reason = check(self.repo)
        self.assertFalse(allowed)
        self.assertIn("stage", reason)
        self.git("add", "pipeline_output/codebase_inventory.jsonl")
        self.assertTrue(check(self.repo)[0])


if __name__ == "__main__":
    unittest.main()
