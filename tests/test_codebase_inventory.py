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


class RepoFixture(unittest.TestCase):
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


class InventoryTest(RepoFixture):
    def test_js_ts_python_and_shell_static_symbols(self):
        """Why: prior-art lookup needs deterministic symbols across supported languages."""
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
        """Why: private commits must stage the exact inventory of staged source."""
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

    def test_ignored_public_inventory_is_local_only(self):
        """Why: the public hook must refresh an ignored local inventory without staging it."""
        self.put('.gitignore', 'pipeline_output/\n')
        self.put('src/main.js', 'export function first() {}\n')
        self.assertTrue(check(self.repo)[0])
        self.assertTrue((self.repo / 'pipeline_output/codebase_inventory.jsonl').is_file())
        self.assertFalse(subprocess.run(['git', '-C', str(self.repo), 'ls-files', '--error-unmatch',
                                         'pipeline_output/codebase_inventory.jsonl'], capture_output=True).returncode == 0)
        (self.repo / 'src/main.js').write_text('export function second() {}\n')
        self.assertFalse(check(self.repo)[0], 'unstaged source must still fail')
        self.git('add', 'src/main.js')
        self.assertTrue(check(self.repo)[0])

    def test_ignored_but_staged_inventory_still_fails(self):
        """Why: ignore rules must not bless a tracked inventory that would leak in public."""
        self.put('pipeline_output/codebase_inventory.jsonl', 'stale\n')
        self.put('.gitignore', 'pipeline_output/\n')
        self.assertFalse(check(self.repo)[0])


HOOK = ROOT / "scripts" / "inventory_refresh.sh"
WORKSPACE_INVENTORY = ROOT / "pipeline_output" / "codebase_inventory.jsonl"


class RefreshHookTest(RepoFixture):
    """The shell hook refreshes the edited file's git toplevel and stays quiet."""

    @classmethod
    def setUpClass(cls):
        cls._workspace_inventory = WORKSPACE_INVENTORY.read_bytes()

    @classmethod
    def tearDownClass(cls):
        current = WORKSPACE_INVENTORY.read_bytes()
        if current != cls._workspace_inventory:
            WORKSPACE_INVENTORY.write_bytes(cls._workspace_inventory)
            raise AssertionError("inventory refresh test mutated the workspace inventory")

    def run_hook(self, *args, stdin="", cwd=None):
        return subprocess.run(
            ["bash", str(HOOK), *args],
            input=stdin,
            text=True,
            capture_output=True,
            timeout=8,
            cwd=str(cwd or self.repo),
            check=False,
        )

    def inventory_rows(self):
        path = self.repo / "pipeline_output" / "codebase_inventory.jsonl"
        self.assertTrue(path.is_file(), "expected a refreshed inventory")
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def assert_silent_skip(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")
        self.assertFalse((self.repo / "pipeline_output" / "codebase_inventory.jsonl").exists())

    def test_argv_refreshes_git_toplevel_of_the_edited_file(self):
        """Why: a file edit must refresh its own repository, not the coordinator checkout."""
        self.put("src/worker.ts", "export function deliver() { return 1 }\n")
        result = self.run_hook(str(self.repo / "src" / "worker.ts"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        rows = self.inventory_rows()
        self.assertEqual([row["path"] for row in rows], ["src/worker.ts"])
        self.assertIn("deliver", [item["name"] for item in rows[0]["functions"]])

    def test_relative_argv_uses_the_working_directory(self):
        """Why: relative edit paths must resolve within the active checkout."""
        self.put("src/main.py", "def tracked():\n    pass\n")
        result = self.run_hook("src/main.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("src/main.py", [row["path"] for row in self.inventory_rows()])

    def test_directory_dots_do_not_hide_a_python_file(self):
        """Why: dotted directory names do not change the source extension."""
        self.put("2021.12/worker.py", "def build():\n    pass\n")
        result = self.run_hook(str(self.repo / "2021.12" / "worker.py"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2021.12/worker.py", [row["path"] for row in self.inventory_rows()])

    def test_each_inventoried_extension_triggers_refresh(self):
        """Why: supported source edits must update local prior-art evidence."""
        names = ("a.py", "a.sh", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.ts", "a.tsx", "a.mts")
        for name in names:
            self.put(name, "export function marker() {}\n" if not name.endswith((".py", ".sh")) else "def marker():\n    pass\n")
        for name in names:
            result = self.run_hook(str(self.repo / name))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(name, [row["path"] for row in self.inventory_rows()])

    def test_stdin_accepts_tool_input_file_path_and_path(self):
        """Why: both editor payload shapes must identify the intended source file."""
        self.put("scripts/check.py", "def inspect():\n    pass\n")
        target = str(self.repo / "scripts" / "check.py")
        for key in ("file_path", "path"):
            inventory = self.repo / "pipeline_output" / "codebase_inventory.jsonl"
            if inventory.exists():
                inventory.unlink()
            result = self.run_hook(stdin=json.dumps({"tool_name": "Write", "tool_input": {key: target}}))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertIn("scripts/check.py", [row["path"] for row in self.inventory_rows()])

    def test_argv_wins_so_stdin_is_not_required(self):
        """Why: an explicit unrelated path must not refresh from stale stdin."""
        self.put("src/main.py", "def tracked():\n    pass\n")
        payload = json.dumps({"tool_input": {"file_path": str(self.repo / "src" / "main.py")}})
        result = self.run_hook(str(self.repo / "README.md"), stdin=payload)
        self.assert_silent_skip(result)

    def test_unrelated_extension_and_other_markdown_skip(self):
        """Why: unrelated edits must not create or rewrite the inventory."""
        self.put("src/main.py", "def tracked():\n    pass\n")
        self.put("README.md", "notes\n")
        self.put("src/Main.PY", "def tracked():\n    pass\n")
        for name in ("README.md", "src/Main.PY", "notes.txt"):
            result = self.run_hook(str(self.repo / name))
            self.assert_silent_skip(result)

    def test_tasks_and_handover_refresh_without_indexing_themselves(self):
        """Why: workflow docs trigger refresh without polluting source inventory."""
        self.put("src/main.py", "def tracked():\n    pass\n")
        self.put("TASKS.md", "- item\n")
        self.put("docs/HANDOVER.md", "done\n")
        for name in ("TASKS.md", "docs/HANDOVER.md"):
            inventory = self.repo / "pipeline_output" / "codebase_inventory.jsonl"
            if inventory.exists():
                inventory.unlink()
            result = self.run_hook(str(self.repo / name))
            self.assertEqual(result.returncode, 0, result.stderr)
            paths = [row["path"] for row in self.inventory_rows()]
            self.assertIn("src/main.py", paths)
            self.assertNotIn(name, paths)

    def test_extensionless_python_and_shell_shebangs_refresh(self):
        """Why: shebang scripts need inventory even without filename extensions."""
        self.put("scripts/agent-bridge", "#!/usr/bin/env python3\ndef main():\n    pass\n")
        self.put("bin/run", "#!/bin/zsh\nstart() { :; }\n")
        for name in ("scripts/agent-bridge", "bin/run"):
            result = self.run_hook(str(self.repo / name))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(name, [row["path"] for row in self.inventory_rows()])

    def test_extensionless_node_shebang_skips(self):
        """Why: unsupported extensionless node tools must not trigger refresh."""
        self.put("scripts/tool", "#!/usr/bin/env node\nconsole.log(1)\n")
        result = self.run_hook(str(self.repo / "scripts" / "tool"))
        self.assert_silent_skip(result)

    def test_bad_json_empty_stdin_and_missing_path_skip_quickly(self):
        """Why: malformed editor payloads must leave inventory untouched."""
        for stdin in ("", "{", "{}", json.dumps({"tool_input": {}}), json.dumps({"tool_input": {"file_path": ""}})):
            result = self.run_hook(stdin=stdin)
            self.assert_silent_skip(result)

    def test_path_outside_a_git_work_tree_skips_without_touching_the_workspace(self):
        """Why: edits outside Git cannot mutate the coordinator inventory."""
        before = WORKSPACE_INVENTORY.read_bytes()
        with tempfile.TemporaryDirectory() as outside:
            path = Path(outside) / "main.py"
            path.write_text("def outside():\n    pass\n")
            result = self.run_hook(str(path))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "")
            self.assertFalse((Path(outside) / "pipeline_output" / "codebase_inventory.jsonl").exists())
        self.assertEqual(WORKSPACE_INVENTORY.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
