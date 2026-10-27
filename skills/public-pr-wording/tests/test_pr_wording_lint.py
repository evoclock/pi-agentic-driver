#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[1]
SCRIPT = SKILL / "pr_wording_lint.py"

GOOD_TITLE = "Add a time limit to looping tasks"
GOOD_BODY = """## What changed
Looping tasks now stop after a set time or step count.

## Why
A loop with no limit could run until the session ended.

## How verified
`npm test` passes, including two new tests for both limits.

## Notes for agents
- Give every loop an explicit stop condition and test that it fires.
"""

# Fixture identity. Placeholder values only; no real person, bot or model.
FIXTURE = {
    "owner_names": ["Alex Doe", "Alex"],
    "handles": ["adoe"],
    "bot_names": ["Botty"],
    "model_names": ["modelx"],
    "banned": [{"reason": "internal project name", "pattern": "\\bcodename-z\\b"}],
}


def clean_env(home: str) -> dict:
    """Environment with no personal config reachable, so tests never read the user's.

    PR_WORDING_CONFIG points at an empty object, which wins over every fallback,
    including a git-ignored local config beside the lint.
    """
    env = {k: v for k, v in os.environ.items() if k not in ("PR_WORDING_CONFIG", "PI_CODING_AGENT_DIR")}
    env["HOME"] = home
    empty = Path(home) / "empty-config.json"
    empty.write_text("{}", encoding="utf-8")
    env["PR_WORDING_CONFIG"] = str(empty)
    return env


def run(title: str, body: str, *extra: str, config: dict | None = None, env_config: bool = False,
        cwd: str | None = None) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        env = clean_env(tmp)
        args = list(extra)
        if config is not None:
            cfg = Path(tmp) / "config.json"
            cfg.write_text(json.dumps(config), encoding="utf-8")
            if env_config:
                env["PR_WORDING_CONFIG"] = str(cfg)
            else:
                args += ["--config", str(cfg)]
        if title is None:
            cmd = [sys.executable, str(SCRIPT), *args]
        else:
            body_file = Path(tmp) / "body.md"
            body_file.write_text(body, encoding="utf-8")
            cmd = [sys.executable, str(SCRIPT), "--title", title, "--body-file", str(body_file), *args]
        return subprocess.run(cmd, capture_output=True, text=True, check=False, env=env, cwd=cwd)


def with_line(line: str) -> str:
    return GOOD_BODY.replace("## Notes for agents", f"{line}\n\n## Notes for agents")


class PrWordingLint(unittest.TestCase):
    def assert_rejects(self, title: str, body: str, reason: str, config: dict | None = None) -> None:
        result = run(title, body, config=config)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(reason, result.stdout)

    def assert_passes(self, body: str, config: dict | None = None) -> None:
        result = run(GOOD_TITLE, body, config=config)
        self.assertEqual(result.returncode, 0, result.stdout)

    # ---- base rules, no personal config ---------------------------------
    def test_clean_message_passes_without_config(self) -> None:
        self.assert_passes(GOOD_BODY)

    def test_base_rules_name_no_person_bot_or_model(self) -> None:
        rules = json.loads((SKILL / "pr_wording_rules.json").read_text(encoding="utf-8"))
        self.assertEqual(rules["allowed_names"], [])
        reasons = [r["reason"] for r in rules["banned"]]
        self.assertNotIn("internal bot or agent name", reasons)
        self.assertNotIn("model or provider name", reasons)

    def test_generic_third_person_phrases(self) -> None:
        for phrase in ("the owner decides", "The user asked for this", "the maintainer wants it", "the repo owner said so"):
            self.assert_rejects(GOOD_TITLE, with_line(phrase + "."), "third-person reference to the owner")

    def test_plural_users_is_not_an_owner_reference(self) -> None:
        self.assert_passes(with_line("It skips the users table."))

    def test_names_pass_when_no_config_names_them(self) -> None:
        self.assert_passes(with_line("Alex will review it. Botty and modelx helped."))

    def test_battle_story(self) -> None:
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("A loop", "After a frustrating night, a loop"), "battle story")

    def test_word_and_line_caps(self) -> None:
        long_body = GOOD_BODY.replace("A loop with", "A loop with " + "more words here. " * 110)
        self.assert_rejects(GOOD_TITLE, long_body, "words; cap is 300")
        tall_body = GOOD_BODY.replace("## Why", "\n" * 40 + "## Why")
        self.assert_rejects(GOOD_TITLE, tall_body, "lines; cap is 40")

    def test_long_sentence(self) -> None:
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("A loop", "A " + "very " * 30 + "loop"), "sentence:")

    def test_sections_and_notes(self) -> None:
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("## Why", "## Background"), "use exactly")
        many = GOOD_BODY + "".join(f"- Lesson {i}.\n" for i in range(5))
        self.assert_rejects(GOOD_TITLE, many, "Notes for agents: 6 bullets")

    def test_title_rules(self) -> None:
        self.assert_rejects("x" * 80, GOOD_BODY, "title: 80 chars")
        self.assert_rejects(GOOD_TITLE + ".", GOOD_BODY, "trailing period")

    def test_dash_emoji_path_clutter(self) -> None:
        local_path = "/".join(("", "Users", "someone", "repo"))
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("set time", "set time \u2014 or steps"), "dash")
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("passes", "passes \U0001F680"), "emoji")
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("`npm test`", local_path), "local path")
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("now stop", "now stop in order to"), "clutter")

    def test_code_block_cap(self) -> None:
        block = "```\n" + "line\n" * 9 + "```\n"
        self.assert_rejects(GOOD_TITLE, GOOD_BODY.replace("## Why", block + "## Why"), "code block of 9 lines")

    # ---- personal config merged over the base ---------------------------
    def test_config_flags_third_person_owner_names_and_handles(self) -> None:
        for phrase in ("Alex will review it", "Alex Doe asked for this", "Alex's call", "adoe will review",
                       "adoe wants this", "adoe's approval"):
            self.assert_rejects(GOOD_TITLE, with_line(phrase + "."), "third-person reference to the owner", FIXTURE)

    def test_config_allows_first_person_and_plain_handle_statements(self) -> None:
        for line in ("I wrote this. Author: Alex Doe.", "Only adoe merges.", "Only adoe approves merges.",
                     "See adoe/some-repo for the source."):
            self.assert_passes(with_line(line), FIXTURE)

    def test_config_bans_bots_models_and_extra_patterns(self) -> None:
        self.assert_rejects(GOOD_TITLE, with_line("Botty approved it."), "internal bot or agent name", FIXTURE)
        self.assert_rejects(GOOD_TITLE, with_line("A modelx-2 review passed."), "model or provider name", FIXTURE)
        self.assert_rejects(GOOD_TITLE, with_line("Part of codename-z."), "internal project name", FIXTURE)

    def test_config_bot_names_are_whole_words(self) -> None:
        self.assert_passes(with_line("The Bottyard job ran."), FIXTURE)
        self.assert_passes(with_line("A modelxyz table exists."), FIXTURE)
        self.assert_rejects(GOOD_TITLE, with_line("The modelx5.1 run passed."), "model or provider name", FIXTURE)

    def test_config_names_are_literal_not_regex(self) -> None:
        cfg = {"bot_names": ["a.c"]}
        self.assert_passes(with_line("The abc job ran."), cfg)
        self.assert_rejects(GOOD_TITLE, with_line("The a.c job ran."), "internal bot or agent name", cfg)

    def test_config_from_env_var(self) -> None:
        result = run(GOOD_TITLE, with_line("Botty approved it."), config=FIXTURE, env_config=True)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("internal bot or agent name", result.stdout)

    def test_config_from_agent_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = Path(tmp) / "agent"
            (agent / "skills-config").mkdir(parents=True)
            (agent / "skills-config" / "public-pr-wording.json").write_text(json.dumps(FIXTURE))
            body = Path(tmp) / "body.md"
            body.write_text(with_line("Botty approved it."))
            env = clean_env(tmp)
            del env["PR_WORDING_CONFIG"]
            env["PI_CODING_AGENT_DIR"] = str(agent)
            result = subprocess.run([sys.executable, str(SCRIPT), "--title", GOOD_TITLE, "--body-file", str(body)],
                                    capture_output=True, text=True, check=False, env=env)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("internal bot or agent name", result.stdout)

    def test_missing_explicit_config_or_bad_config_exits_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = clean_env(tmp)
            env["PR_WORDING_CONFIG"] = str(Path(tmp) / "missing.json")
            body = Path(tmp) / "body.md"
            body.write_text(GOOD_BODY)
            result = subprocess.run([sys.executable, str(SCRIPT), "--title", GOOD_TITLE, "--body-file", str(body)],
                                    capture_output=True, text=True, check=False, env=env)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(run(GOOD_TITLE, GOOD_BODY, config={"bot_names": "Botty"}).returncode, 2)
        self.assertEqual(run(GOOD_TITLE, GOOD_BODY, config={"banned": [{"reason": "x", "pattern": "("}]}).returncode, 2)
        for bad in ({"banned": 5}, {"banned": None}, {"banned": [{"reason": "x", "pattern": 5}]}, {"banned": ["x"]}):
            result = run(GOOD_TITLE, GOOD_BODY, config=bad)
            self.assertEqual(result.returncode, 2, f"{bad}: {result.stdout}{result.stderr}")
            self.assertNotIn("Traceback", result.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            rules = Path(tmp) / "rules.json"
            base = json.loads((SKILL / "pr_wording_rules.json").read_text(encoding="utf-8"))
            for broken in ([], {k: v for k, v in base.items() if k != "clutter"},
                           {**base, "banned": [{"reason": "x", "pattern": "("}]}, {**base, "banned": [{"reason": "x"}]}):
                rules.write_text(json.dumps(broken))
                result = run(GOOD_TITLE, GOOD_BODY, "--rules", str(rules))
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
            event = Path(tmp) / "event.json"
            for payload in ({"pull_request": 5}, {"pull_request": {"title": 5, "body": "x"}}):
                event.write_text(json.dumps(payload))
                result = run(None, None, "--event", str(event))
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertNotIn("Traceback", result.stderr)
            for broken in ({**base, "clutter": [5]}, {**base, "title_min_chars": "10"}, {**base, "sections": 5}):
                rules.write_text(json.dumps(broken))
                result = run(GOOD_TITLE, GOOD_BODY, "--rules", str(rules))
                self.assertEqual(result.returncode, 2, f"{broken}: {result.stdout}{result.stderr}")
                self.assertNotIn("Traceback", result.stderr)
        for not_object in ([], "x", 0):
            result = run(GOOD_TITLE, GOOD_BODY, config=not_object)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_example_config_is_placeholders_only_and_loads(self) -> None:
        example = json.loads((SKILL / "pr_wording_config.example.json").read_text(encoding="utf-8"))
        for key in ("owner_names", "handles", "bot_names", "model_names"):
            self.assertTrue(example[key], key)
            for value in example[key]:
                self.assertRegex(value, r"(?i)^your", f"{key} must hold a placeholder: {value}")
        self.assert_passes(GOOD_BODY, example)

    # ---- inputs: only the PR title and body ------------------------------
    def test_event_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            event = Path(tmp) / "event.json"
            event.write_text(json.dumps({"pull_request": {"title": GOOD_TITLE, "body": GOOD_BODY}}))
            result = run(None, None, "--event", str(event))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_repo_files_are_never_linted(self) -> None:
        # Repo files full of banned text, including configured names, sit in the
        # working tree. The lint reads only the PR title and body, so it passes.
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            (work / "README.md").write_text("# Tool\n\nAlex finally got modelx working \u2014 a frustrating saga.\n" * 50)
            (work / "CHANGELOG.md").write_text("## 1.0\n- Botty fixed it overnight.\n")
            (work / "docs").mkdir()
            (work / "docs" / "models.md").write_text("# Models\n\nThe owner will review modelx results.\n")
            event = work / "event.json"
            event.write_text(json.dumps({"pull_request": {"title": GOOD_TITLE, "body": GOOD_BODY}}))
            result = run(None, None, "--event", str(event), config=FIXTURE, cwd=str(work))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_cli_accepts_no_file_or_glob_targets(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, check=True)
        self.assertNotRegex(result.stdout, r"--(?:path|paths|glob|files?|dir)\b")

    def test_buildkite_runs_pr_wording_from_the_base(self) -> None:
        pipeline = (ROOT / ".buildkite" / "pipeline.yml").read_text(encoding="utf-8")
        checks = (ROOT / ".buildkite" / "pr-checks.sh").read_text(encoding="utf-8")
        self.assertIn('label: "PR wording"', pipeline)
        self.assertIn('command: ".buildkite/pr-checks.sh wording"', pipeline)
        self.assertIn('pr="${BUILDKITE_PULL_REQUEST:-false}"', checks)
        self.assertIn('if [[ "$pr" == false || -z "$pr" ]]; then', checks)
        # Trusted code only: the lint and config come from the PR base.
        self.assertIn('git show "$base_sha:$base/$name"', checks)
        self.assertIn('git show "$base_sha:.github/pr-wording.json"', checks)
        self.assertIn('args=(--event "$scratch/event.json")', checks)
        self.assertIn('python3 "$scratch/pr-wording/pr_wording_lint.py" "${args[@]}"', checks)

    def test_no_personal_config_is_committed(self) -> None:
        self.assertFalse((ROOT / ".github" / "pr-wording.json").exists())
        self.assertFalse((SKILL / "pr_wording_config.local.json").exists() and
                         subprocess.run(["git", "ls-files", "--error-unmatch", str(SKILL / "pr_wording_config.local.json")],
                                        cwd=ROOT, capture_output=True).returncode == 0)

    def test_unreadable_input_exits_2(self) -> None:
        result = run(None, None, "--event", "/nonexistent.json")
        self.assertEqual(result.returncode, 2)



    def test_rejects_summary_test_plan_template(self):
        """Never reopen public PRs with GitHub Summary / Test plan headings."""
        body = "## Summary\nI changed a thing.\n\n## Test plan\n- ran tests\n"
        result = run("Sync herdr refuse to public", body)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sections are", result.stdout)


if __name__ == "__main__":
    unittest.main()
