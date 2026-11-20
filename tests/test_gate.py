"""Violation fixtures for the shared gate's hidden-install and hook-bypass checks."""

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gate import allowance_matches, hook_integrity_findings, run_internal as run_gate_check  # noqa: E402

CHAINING_DISPATCHER = """#!/bin/sh
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
case "$name" in
  pre-commit|pre-merge-commit)
    "$here/check-blocked-identity" --hook || exit $?
    ;;
esac
GIT=${GIT_BLOCKED_IDENTITY_REAL_GIT:-/usr/bin/git}
[ -x "$GIT" ] || GIT=git
common=$("$GIT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
target="$common/hooks/$name"
[ -f "$target" ] && [ -x "$target" ] || exit 0
tdir=$(cd "$common/hooks" 2>/dev/null && pwd -P) || exit 0
[ "$tdir" = "$here" ] && exit 0
exec "$target" "$@"
"""
NON_CHAINING_DISPATCHER = """#!/bin/sh
"$(dirname "$0")/check-blocked-identity" --hook || exit $?
exit 0
"""


class GateFixtureTest(unittest.TestCase):
    def fixture(self, name):
        return (ROOT / "tests/fixtures/gate" / name).read_bytes()

    def run_fixture_check(self, check_id, files):
        rules = {"hashScopedAllowances": [], "baseRef": "origin/main"}
        with patch("gate.policy_files", return_value=files), patch("gate.changed_hook_paths", return_value=set()):
            return run_gate_check(check_id, ROOT, rules)

    def test_skill_bootstrap_install_fails_then_passes_when_removed(self):
        """Why: a hidden install in a skill bootstrap path must be caught and clear once removed."""
        name = "skills/example/SKILL.md"
        files = {name: self.fixture("hidden-install/SKILL.md")}
        self.assertTrue(self.run_fixture_check("no-hidden-installs", files))
        files.pop(name)
        self.assertEqual(self.run_fixture_check("no-hidden-installs", files), [])

    def test_hook_bypass_fails_then_passes_when_removed(self):
        """Why: a hook-bypass commit command must fail hook-integrity and clear once removed."""
        name = "scripts/unsafe-commit.sh"
        files = {name: self.fixture("hook-bypass.sh")}
        self.assertTrue(self.run_fixture_check("hook-integrity", files))
        files.pop(name)
        self.assertEqual(self.run_fixture_check("hook-integrity", files), [])

    def test_hash_allowance_only_matches_exact_file_content(self):
        """Why: an allowance must match only the exact reviewed content and its own check."""
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



class GlobalHookChainTest(unittest.TestCase):
    """A global core.hooksPath passes hook-integrity only through a verified chaining dispatcher."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.home = base / "home"
        self.repo = base / "repo"
        self.home.mkdir()
        self.repo.mkdir()
        env = {"HOME": str(self.home), "GIT_CONFIG_GLOBAL": str(self.home / ".gitconfig"),
               "GIT_CONFIG_NOSYSTEM": "1", "XDG_CONFIG_HOME": str(self.home / ".config")}
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        reviewed = patch("gate.REVIEWED_GLOBAL_DISPATCHER_SHA256",
                         frozenset({hashlib.sha256(CHAINING_DISPATCHER.encode()).hexdigest()}), create=True)
        reviewed.start()
        self.addCleanup(reviewed.stop)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        hook = self.repo / ".githooks/pre-commit"
        hook.parent.mkdir()
        hook.write_text("#!/bin/sh\nexit 0\n")
        hook.chmod(0o755)

    def install_global(self, dispatcher, hooks_dir=None, link=True):
        hooks_dir = hooks_dir or self.home / ".config/git/hooks"
        hooks_dir.mkdir(parents=True, exist_ok=True)
        dispatch = hooks_dir / "evoclock-hook-dispatch"
        dispatch.write_text(dispatcher)
        dispatch.chmod(0o755)
        guard = hooks_dir / "check-blocked-identity"
        guard.write_text("#!/bin/sh\nexit 0\n")
        guard.chmod(0o755)
        if link:
            (hooks_dir / "pre-commit").symlink_to("evoclock-hook-dispatch")
        subprocess.run(["git", "config", "--global", "core.hooksPath", str(hooks_dir)], check=True)
        return hooks_dir

    def findings(self):
        rules = {"hashScopedAllowances": [], "baseRef": "origin/main"}
        with patch("gate.changed_hook_paths", return_value=set()):
            return hook_integrity_findings(self.repo, {}, rules)

    def test_global_chain_with_verified_dispatcher_passes(self):
        """Why: the machine-wide identity dispatcher that chains to repo hooks must not turn the gate red."""
        self.install_global(CHAINING_DISPATCHER)
        self.assertEqual(self.findings(), [])

    def test_global_chain_without_chaining_fails(self):
        """Why: a global hook dir that never reaches the repo hooks would silently drop them."""
        self.install_global(NON_CHAINING_DISPATCHER)
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_global_chain_hook_not_routed_through_dispatcher_fails(self):
        """Why: a hook name not routed through the verified dispatcher bypasses the chain."""
        hooks_dir = self.install_global(CHAINING_DISPATCHER, link=False)
        plain = hooks_dir / "pre-commit"
        plain.write_text("#!/bin/sh\nexit 0\n")
        plain.chmod(0o755)
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_unknown_hooks_path_fails_even_with_chaining_dispatcher(self):
        """Why: only the user-global hook dir is trusted; any other hooksPath stays refused."""
        self.install_global(CHAINING_DISPATCHER, hooks_dir=Path(self.tmp.name) / "elsewhere/hooks")
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_dispatcher_exiting_before_chain_fails(self):
        """Why: chain text after an early exit never runs, so repo hooks would be silently dropped."""
        self.install_global("#!/bin/sh\nexit 0\n" + CHAINING_DISPATCHER)
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_chain_lines_only_in_unused_heredoc_fail(self):
        """Why: chain text quoted in an unused here-document is not a chain."""
        self.install_global("#!/bin/sh\n: <<'UNUSED'\n" + CHAINING_DISPATCHER + "UNUSED\nexit 0\n")
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_unreviewed_dispatcher_content_fails_closed(self):
        """Why: any dispatcher edit, even one that still chains, must be re-reviewed before the gate trusts it."""
        self.install_global(CHAINING_DISPATCHER + "# unreviewed local edit\n")
        self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def test_allowlisted_but_non_chaining_dispatcher_still_fails(self):
        """Why: a reviewed hash is not proof of chaining; the behavioural probe must still refuse a dead chain."""
        dead = "#!/bin/sh\nexit 0\n" + CHAINING_DISPATCHER
        with patch("gate.REVIEWED_GLOBAL_DISPATCHER_SHA256", frozenset({hashlib.sha256(dead.encode()).hexdigest()}), create=True):
            self.install_global(dead)
            self.assertTrue(any("hooksPath" in item for item in self.findings()))

    def shared_hook_with_template(self, link_whole_dir):
        """Build a git template whose hooks reach a shared hooks dir outside any probe repo."""
        shared = Path(self.tmp.name) / "shared-hooks"
        shared.mkdir()
        existing = shared / "pre-commit"
        existing.write_text("#!/bin/sh\necho original shared hook\nexit 0\n")
        existing.chmod(0o750)
        template = Path(self.tmp.name) / "template"
        template.mkdir()
        if link_whole_dir:
            (template / "hooks").symlink_to(shared)
        else:
            (template / "hooks").mkdir()
            (template / "hooks/pre-commit").symlink_to(existing)
        return existing, template

    def assert_probe_leaves_shared_hook_alone(self, existing):
        before = (existing.read_bytes(), existing.stat().st_mode)
        self.install_global(CHAINING_DISPATCHER)
        self.assertEqual(self.findings(), [])
        self.assertEqual((existing.read_bytes(), existing.stat().st_mode), before)

    def test_probe_ignores_env_template_hooks_dir_symlink(self):
        """Why: the chain probe must never overwrite a real hook reached through a GIT_TEMPLATE_DIR hooks symlink."""
        existing, template = self.shared_hook_with_template(link_whole_dir=True)
        with patch.dict(os.environ, {"GIT_TEMPLATE_DIR": str(template)}):
            self.assert_probe_leaves_shared_hook_alone(existing)

    def test_probe_ignores_config_template_hook_symlink(self):
        """Why: the chain probe must never write through an init.templateDir hook symlink into a real hook."""
        existing, template = self.shared_hook_with_template(link_whole_dir=False)
        subprocess.run(["git", "config", "--global", "init.templateDir", str(template)], check=True)
        self.assert_probe_leaves_shared_hook_alone(existing)

    def test_repo_githooks_and_unset_still_pass(self):
        """Why: the existing accepted states (.githooks or unset) must keep passing."""
        self.assertEqual(self.findings(), [])
        subprocess.run(["git", "-C", str(self.repo), "config", "core.hooksPath", ".githooks"], check=True)
        self.assertEqual(self.findings(), [])


if __name__ == "__main__":
    unittest.main()
