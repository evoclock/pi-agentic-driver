#!/usr/bin/env python3
"""Lint a pull-request title and body against the public wording rule.

Usage:
  pr_wording_lint.py --title "..." --body-file body.md [--rules rules.json] [--config me.json]
  pr_wording_lint.py --event "$GITHUB_EVENT_PATH" [--config repo.json]

Exits 0 when clean, 1 with one reason per line, 2 on bad input.
Stdlib only. Clutter list and sentence cap follow agentic_aidr.
PR text speaks as the owner in first person. The base rules are generic.
Owner names, handles, bot names and model names come from an optional
personal config merged over them (see config_path and SKILL.md, Setup).
Only the PR title and body are read; repo files never are.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_RULES = Path(__file__).with_name("pr_wording_rules.json")
LOCAL_CONFIG = Path(__file__).with_name("pr_wording_config.local.json")
CONFIG_ENV = "PR_WORDING_CONFIG"
CONFIG_NAME = "public-pr-wording.json"
CONFIG_LISTS = ("owner_names", "handles", "bot_names", "model_names")
# Verbs that make a name or handle the subject of a third-person sentence.
INTENT_VERBS = ("will|would|wants?|wanted|needs?|needed|asked|asks|says?|said|decides?|decided|prefers?|"
                "preferred|thinks?|thought|reviews?|reviewed|should|can|could|must|may")
NAME_ONLY_VERBS = "approves?|approved|merges?|merged|is|was|has|had"
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'/._-]*")
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^\s*```")
BULLET_RE = re.compile(r"^\s*[-*+]\s+(.*)$")


def words(text: str) -> list[str]:
    return WORD_RE.findall(text)


def split_fences(body: str) -> tuple[list[str], list[int]]:
    """Return prose lines and the length of each fenced block."""
    prose, blocks, inside, size = [], [], False, 0
    for line in body.splitlines():
        if FENCE_RE.match(line):
            if inside:
                blocks.append(size)
            inside, size = not inside, 0
            continue
        if inside:
            size += 1
        else:
            prose.append(line)
    if inside:
        blocks.append(size)
    return prose, blocks


def sections(prose: list[str]) -> list[tuple[str, list[str]]]:
    found: list[tuple[str, list[str]]] = []
    for line in prose:
        match = HEADING_RE.match(line)
        if match:
            found.append((match.group(1), []))
        elif found:
            found[-1][1].append(line)
    return found


def config_path(explicit: str | None, env: dict) -> tuple[Path | None, bool]:
    """Pick the personal config. Returns (path, required).

    Order: --config, $PR_WORDING_CONFIG, {PI_CODING_AGENT_DIR}/skills-config/,
    the installed agent skills-config directory, then pr_wording_config.local.json beside this
    script. An explicit path must exist; the fallbacks are optional.
    """
    if explicit:
        return Path(explicit).expanduser(), True
    if env.get(CONFIG_ENV):
        return Path(env[CONFIG_ENV]).expanduser(), True
    candidates = []
    if env.get("PI_CODING_AGENT_DIR"):
        candidates.append(Path(env["PI_CODING_AGENT_DIR"]).expanduser() / "skills-config" / CONFIG_NAME)
    candidates += [Path.home() / ".pi" / "agent" / "skills-config" / CONFIG_NAME, LOCAL_CONFIG]
    for candidate in candidates:
        if candidate.is_file():
            return candidate, False
    return None, False


def _alternation(items: list[str]) -> str:
    return "|".join(re.escape(item.strip()) for item in items if item.strip())


def merge_config(rules: dict, config: dict) -> dict:
    """Return base rules with the personal config's names turned into bans."""
    if not isinstance(config, dict):
        raise ValueError("config must be a JSON object")
    for key in CONFIG_LISTS:
        value = config.get(key, [])
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError(f"config {key} must be a list of strings")
    merged = {**rules, "banned": list(rules["banned"]), "allowed_names": list(rules.get("allowed_names", []))}
    names = _alternation(config.get("owner_names", []))
    handles = _alternation(config.get("handles", []))
    third = []
    if names:
        third.append(rf"\b(?:{names})(?:'s\b|\s+(?:{INTENT_VERBS}|{NAME_ONLY_VERBS})\b)")
    if handles:
        # A handle may own plain statements ("Only <handle> merges"); flag it only as a speaking subject.
        third.append(rf"\b(?:{handles})(?:'s\s+(?:review|approval|call|decision|request)\b|\s+(?:{INTENT_VERBS})\b)")
    if third:
        merged["banned"].append({"reason": "third-person reference to the owner; write as I", "pattern": "|".join(third)})
    bots = _alternation(config.get("bot_names", []))
    if bots:
        merged["banned"].append({"reason": "internal bot or agent name", "pattern": rf"\b(?:{bots})\b"})
    models = _alternation(config.get("model_names", []))
    if models:
        # Model names also catch versioned forms such as name-2 or name5.1.
        merged["banned"].append({"reason": "model or provider name", "pattern": rf"\b(?:{models})(?:[-.]?\d[\w.-]*)?\b"})
    extras = config.get("banned", [])
    if not isinstance(extras, list):
        raise ValueError("config banned must be a list")
    for extra in extras:
        if not (isinstance(extra, dict) and isinstance(extra.get("reason"), str) and isinstance(extra.get("pattern"), str)):
            raise ValueError("config banned entries need string reason and pattern")
        re.compile(extra["pattern"])
        merged["banned"].append({"reason": extra["reason"], "pattern": extra["pattern"]})
    return merged


REQUIRED_RULE_KEYS = ("title_max_chars", "title_min_chars", "body_max_words", "body_max_lines",
                      "sentence_max_words", "code_block_max_lines", "notes_max_bullets",
                      "notes_bullet_max_words", "sections", "banned", "clutter")


def validate_rules(rules: dict) -> dict:
    """Fail as bad input (exit 2) before linting if the merged rules are malformed."""
    missing = [key for key in REQUIRED_RULE_KEYS if key not in rules]
    if missing:
        raise ValueError(f"rules missing {', '.join(missing)}")
    if not isinstance(rules["banned"], list) or not isinstance(rules["clutter"], list):
        raise ValueError("rules banned and clutter must be lists")
    for rule in rules["banned"]:
        if not (isinstance(rule, dict) and isinstance(rule.get("reason"), str) and isinstance(rule.get("pattern"), str)):
            raise ValueError("rules banned entries need string reason and pattern")
        re.compile(rule["pattern"])
    rules.setdefault("allowed_names", [])
    return rules


def lint(title: str, body: str, rules: dict) -> list[str]:
    problems: list[str] = []
    title = title.strip()
    body = body.replace("\r\n", "\n").strip()
    allowed = {name.lower() for name in rules["allowed_names"]}

    if not rules["title_min_chars"] <= len(title) <= rules["title_max_chars"]:
        problems.append(f"title: {len(title)} chars; keep it {rules['title_min_chars']}-{rules['title_max_chars']}")
    if title.endswith("."):
        problems.append("title: drop the trailing period")

    lines = body.splitlines()
    if len(lines) > rules["body_max_lines"]:
        problems.append(f"body: {len(lines)} lines; cap is {rules['body_max_lines']}")
    count = len(words(body))
    if count > rules["body_max_words"]:
        problems.append(f"body: {count} words; cap is {rules['body_max_words']}. Move detail to a linked doc")

    prose, blocks = split_fences(body)
    for size in blocks:
        if size > rules["code_block_max_lines"]:
            problems.append(f"body: code block of {size} lines; cap is {rules['code_block_max_lines']}")

    found = sections(prose)
    names = [name for name, _ in found]
    if names != rules["sections"]:
        want = " / ".join(f"## {name}" for name in rules["sections"])
        problems.append(f"body: sections are {names or 'missing'}; use exactly {want}")
    notes = dict(found).get("Notes for agents")
    if notes is not None:
        bullets = [m.group(1) for m in map(BULLET_RE.match, notes) if m]
        if not 1 <= len(bullets) <= rules["notes_max_bullets"]:
            problems.append(f"Notes for agents: {len(bullets)} bullets; use 1-{rules['notes_max_bullets']}")
        for bullet in bullets:
            if len(words(bullet)) > rules["notes_bullet_max_words"]:
                problems.append(f"Notes for agents: bullet over {rules['notes_bullet_max_words']} words: {bullet[:60]}")

    text = f"{title}\n" + "\n".join(prose)
    for rule in rules["banned"]:
        for match in re.finditer(rule["pattern"], text, re.IGNORECASE):
            if match.group(0).lower() not in allowed:
                problems.append(f"{rule['reason']}: {match.group(0)!r}")
                break
    lowered = text.lower()
    for phrase in rules["clutter"]:
        if re.search(rf"\b{re.escape(phrase)}\b", lowered):
            problems.append(f"clutter (aidr): {phrase!r}")

    plain = re.sub(r"`[^`]*`", "x", "\n".join(l for l in prose if not HEADING_RE.match(l)))
    for sentence in re.split(r"(?<=[.!?])\s+|\n", plain):
        n = len(words(sentence))
        if n > rules["sentence_max_words"]:
            problems.append(f"sentence: {n} words; cap is {rules['sentence_max_words']}: {sentence.strip()[:60]}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--title")
    parser.add_argument("--body-file")
    parser.add_argument("--event", help="GitHub event JSON with pull_request.title/body")
    parser.add_argument("--rules", default=str(DEFAULT_RULES))
    parser.add_argument("--config", help=f"personal or repo config merged over the rules; else ${CONFIG_ENV}, then the fallbacks in SKILL.md")
    args = parser.parse_args(argv)
    try:
        rules = json.loads(Path(args.rules).read_text(encoding="utf-8"))
        if not isinstance(rules, dict):
            raise ValueError("rules must be a JSON object")
        path, required = config_path(args.config, dict(os.environ))
        if path is not None and (required or path.is_file()):
            rules = merge_config(rules, json.loads(path.read_text(encoding="utf-8")))
        validate_rules(rules)
        if args.event:
            pr = json.loads(Path(args.event).read_text(encoding="utf-8"))["pull_request"]
            title, body = pr.get("title") or "", pr.get("body") or ""
        elif args.title is not None and args.body_file:
            title = args.title
            body = sys.stdin.read() if args.body_file == "-" else Path(args.body_file).read_text(encoding="utf-8")
        else:
            parser.error("give --event, or --title with --body-file")
        if not isinstance(title, str) or not isinstance(body, str):
            raise ValueError("PR title and body must be strings")
        # Malformed rule values surface while linting; they are bad input too, not findings.
        problems = lint(title, body, rules)
    except (OSError, KeyError, ValueError, TypeError, AttributeError, re.error) as error:
        print(f"pr-wording-lint: cannot read input: {error}", file=sys.stderr)
        return 2
    for problem in problems:
        print(f"pr-wording-lint: {problem}")
    if problems:
        print("pr-wording-lint: rewrite in first person with agentic_aidr (mode ste), restate plainly, then lint again.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
