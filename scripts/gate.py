#!/usr/bin/env python3
"""Run the repository's shared, rules-driven local and Buildkite gate."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / ".driver/gate-rules.json"
POLICY_ROOTS = ("skills/", "scripts/", ".buildkite/", ".githooks/", "templates/")
POLICY_SUFFIXES = {".md", ".py", ".sh", ".js", ".mjs", ".ts", ".json", ".yml", ".yaml"}
INSTALL_COMMAND = re.compile(
    r"\b(?:bun|npm|pnpm|yarn)\s+(?:install|i|add|ci)\b"
    r"|\b(?:pip3?|pipx|gem|apt-get|apt|brew)\s+(?:install|add)\b"
    r"|\bapk\s+add\b"
    r"|\buv\s+(?:add|pip\s+install)\b"
    r"|\bcargo\s+(?:add|install)\b",
    re.IGNORECASE,
)
NO_VERIFY_COMMAND = re.compile(r"\bgit\s+(?:-[^\s]+\s+)*commit\b[^\n]*--no-verify\b", re.IGNORECASE)
INTERNAL_CHECKS = {"hash-allowances", "hook-integrity", "no-hidden-installs"}


def safe_relative_path(name: str) -> bool:
    path = Path(name)
    return bool(name) and not path.is_absolute() and ".." not in path.parts


def validate_rules(rules: object) -> dict:
    if not isinstance(rules, dict) or rules.get("schema") != "driver-gate-rules.v1":
        raise ValueError("expected schema driver-gate-rules.v1")
    budget = rules.get("speedBudgetSeconds")
    if not isinstance(budget, int) or isinstance(budget, bool) or budget <= 0:
        raise ValueError("speedBudgetSeconds must be a positive integer")
    base_ref = rules.get("baseRef")
    if not isinstance(base_ref, str) or not base_ref or base_ref.startswith("-"):
        raise ValueError("baseRef must be a valid Git ref name")
    checks = rules.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("checks must be a non-empty list")
    seen: set[str] = set()
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get("id"), str):
            raise ValueError("each check must have a string id")
        check_id = check["id"]
        if check_id in seen:
            raise ValueError(f"duplicate check id: {check_id}")
        seen.add(check_id)
        kind = check.get("kind")
        if kind == "command":
            command = check.get("command")
            if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
                raise ValueError(f"{check_id}: command must be a non-empty argument list")
            cwd = check.get("cwd", ".")
            if not isinstance(cwd, str) or not safe_relative_path(cwd):
                raise ValueError(f"{check_id}: cwd must stay inside the repository")
        elif kind == "internal":
            if check_id not in INTERNAL_CHECKS:
                raise ValueError(f"unknown internal check: {check_id}")
        elif kind == "deferred":
            if not isinstance(check.get("reason"), str) or not check["reason"].strip():
                raise ValueError(f"{check_id}: deferred check needs a reason")
        else:
            raise ValueError(f"{check_id}: kind must be command, internal, or deferred")
        if check.get("when", "always") not in {"always", "buildkite"}:
            raise ValueError(f"{check_id}: when must be always or buildkite")

    allowances = rules.get("hashScopedAllowances")
    if not isinstance(allowances, list):
        raise ValueError("hashScopedAllowances must be a list")
    for allowance in allowances:
        if not isinstance(allowance, dict):
            raise ValueError("each hash-scoped allowance must be an object")
        if (
            allowance.get("check") not in {"hook-integrity", "no-hidden-installs"}
            or not isinstance(allowance.get("path"), str)
            or not safe_relative_path(allowance["path"])
            or not re.fullmatch(r"[0-9a-f]{64}", str(allowance.get("sha256", "")))
            or not isinstance(allowance.get("reason"), str)
            or not allowance["reason"].strip()
        ):
            raise ValueError("allowances need a supported check, safe path, SHA-256, and reason")
    return rules


def load_rules(path: Path = RULES_PATH) -> dict:
    return validate_rules(json.loads(path.read_text(encoding="utf-8")))


def allowance_matches(allowances: list[dict], check_id: str, name: str, content: bytes) -> bool:
    digest = hashlib.sha256(content).hexdigest()
    return any(
        item["check"] == check_id and item["path"] == name and item["sha256"] == digest
        for item in allowances
    )


def hash_allowance_findings(root: Path, allowances: list[dict]) -> list[str]:
    findings = []
    for item in allowances:
        path = root / item["path"]
        if path.is_symlink() or not path.is_file():
            findings.append(f"{item['path']}: allowlisted file is missing; remove or renew its allowance")
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            findings.append(f"{item['path']}: allowance SHA-256 is stale; review and update the exact hash")
    return findings


def policy_files(root: Path) -> dict[str, bytes]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *POLICY_ROOTS],
        cwd=root,
        capture_output=True,
        check=True,
    )
    files: dict[str, bytes] = {}
    for raw_name in result.stdout.decode("utf-8", errors="surrogateescape").split("\0"):
        if not raw_name:
            continue
        path = root / raw_name
        if path.suffix not in POLICY_SUFFIXES or path.is_symlink() or not path.is_file():
            continue
        content = path.read_bytes()
        if b"\0" not in content:
            files[raw_name] = content
    return files


def policy_path(name: str) -> bool:
    return name.startswith(POLICY_ROOTS)


def hidden_install_findings(files: dict[str, bytes], allowances: list[dict]) -> list[str]:
    findings = []
    for name, content in sorted(files.items()):
        if not policy_path(name):
            continue
        if allowance_matches(allowances, "no-hidden-installs", name, content):
            continue
        text = content.decode("utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), 1):
            if INSTALL_COMMAND.search(line):
                findings.append(
                    f"{name}:{line_number}: package install in an automation/bootstrap path; "
                    "remove it or add a reviewed path+SHA-256 allowance for a required install-time command"
                )
    return findings


def no_verify_findings(files: dict[str, bytes], allowances: list[dict]) -> list[str]:
    findings = []
    for name, content in sorted(files.items()):
        if not policy_path(name):
            continue
        if allowance_matches(allowances, "hook-integrity", name, content):
            continue
        text = content.decode("utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), 1):
            if NO_VERIFY_COMMAND.search(line):
                findings.append(f"{name}:{line_number}: commit command bypasses hooks; remove the bypass flag")
    return findings


def changed_hook_paths(root: Path, base_ref: str) -> set[str]:
    verify = subprocess.run(
        ["git", "rev-parse", "--verify", f"{base_ref}^{{commit}}"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if verify.returncode:
        raise ValueError(f"cannot resolve {base_ref}; fetch the target branch before running make gate")
    changed = subprocess.check_output(
        ["git", "diff", "--name-only", "-z", "--no-ext-diff", base_ref, "--"], cwd=root
    )
    untracked = subprocess.check_output(
        ["git", "ls-files", "--others", "--exclude-standard", "-z", "--", ".githooks"], cwd=root
    )
    paths = set(changed.decode("utf-8", errors="surrogateescape").split("\0"))
    paths.update(untracked.decode("utf-8", errors="surrogateescape").split("\0"))
    return {name for name in paths if name.startswith(".githooks/")}


def hook_integrity_findings(root: Path, files: dict[str, bytes], rules: dict) -> list[str]:
    findings = []
    configured = subprocess.run(
        ["git", "config", "--path", "--get", "core.hooksPath"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if configured.returncode == 0:
        configured_path = Path(configured.stdout.strip())
        if not configured_path.is_absolute():
            configured_path = root / configured_path
        if configured_path.resolve() != (root / ".githooks").resolve():
            findings.append(
                f"core.hooksPath points to {configured.stdout.strip()!r}, not .githooks; "
                "preserve the existing chain and configure the repository hook path"
            )
    elif configured.returncode != 1:
        findings.append(f"could not read core.hooksPath: {configured.stderr.strip()}")
    else:
        print("NOTICE [hook-integrity]: core.hooksPath is unset; checked-in hook is still checked and replayed in Buildkite")

    hook = root / ".githooks/pre-commit"
    if not hook.is_file() or not os.access(hook, os.X_OK):
        findings.append(".githooks/pre-commit is missing or not executable; restore the checked-in hook")

    allowances = rules["hashScopedAllowances"]
    try:
        changed = changed_hook_paths(root, rules["baseRef"])
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        findings.append(str(error))
        changed = set()
    for name in sorted(changed):
        path = root / name
        content = path.read_bytes() if path.is_file() and not path.is_symlink() else b""
        if not allowance_matches(allowances, "hook-integrity", name, content):
            findings.append(
                f"{name}: hook changed from {rules['baseRef']}; require a reviewed path+SHA-256 allowance"
            )
    findings.extend(no_verify_findings(files, allowances))
    return findings


def is_buildkite() -> bool:
    return os.environ.get("BUILDKITE", "").lower() not in {"", "0", "false", "no"}


def run_internal(check_id: str, root: Path, rules: dict) -> list[str]:
    if check_id == "hash-allowances":
        return hash_allowance_findings(root, rules["hashScopedAllowances"])
    files = policy_files(root)
    if check_id == "hook-integrity":
        return hook_integrity_findings(root, files, rules)
    if check_id == "no-hidden-installs":
        return hidden_install_findings(files, rules["hashScopedAllowances"])
    return [f"unknown internal check: {check_id}"]


def run_check(check: dict, root: Path, rules: dict, started: float) -> tuple[bool, bool]:
    check_id = check["id"]
    label = check.get("label", check_id)
    if check.get("when", "always") == "buildkite" and not is_buildkite():
        print(f"SKIP [{check_id}]: Buildkite-only check; local inventory --check runs above")
        return True, False
    kind = check["kind"]
    if kind == "deferred":
        print(f"TODO [{check_id}]: deferred -- {check['reason']}")
        return True, False
    if kind == "internal":
        findings = run_internal(check_id, root, rules)
        if findings:
            for finding in findings:
                print(f"FAIL [{check_id}]: {finding}", file=sys.stderr)
            return False, False
        print(f"PASS [{check_id}]")
        return True, False

    budget = rules["speedBudgetSeconds"]
    remaining = budget - (time.monotonic() - started)
    if remaining <= 0:
        print(f"FAIL [{check_id}]: gate speed budget of {budget}s exhausted before {label}", file=sys.stderr)
        return False, True
    cwd = (root / check.get("cwd", ".")).resolve()
    if not cwd.is_relative_to(root):
        print(f"FAIL [{check_id}]: command working directory escapes repository", file=sys.stderr)
        return False, False
    command = check["command"]
    print(f"RUN [{check_id}]: {shlex.join(command)}", flush=True)
    try:
        result = subprocess.run(command, cwd=cwd, timeout=remaining)
    except subprocess.TimeoutExpired:
        print(f"FAIL [{check_id}]: exceeded the remaining {remaining:.1f}s gate budget", file=sys.stderr)
        return False, True
    except OSError as error:
        print(f"FAIL [{check_id}]: could not run {command[0]}: {error}", file=sys.stderr)
        return False, False
    if result.returncode:
        print(f"FAIL [{check_id}]: exit {result.returncode}", file=sys.stderr)
        if check.get("failureMessage"):
            print(f"FIX [{check_id}]: {check['failureMessage']}", file=sys.stderr)
        return False, False
    print(f"PASS [{check_id}]")
    return True, False


def main() -> int:
    started = time.monotonic()
    try:
        rules = load_rules()
        failures = 0
        exhausted = False
        for check in rules["checks"]:
            if exhausted:
                print(f"SKIP [{check['id']}]: speed budget already exhausted")
                continue
            passed, exhausted = run_check(check, ROOT, rules, started)
            failures += int(not passed)
        elapsed = time.monotonic() - started
        budget = rules["speedBudgetSeconds"]
        if elapsed > budget:
            print(f"FAIL [speed-budget]: {elapsed:.1f}s exceeded {budget}s", file=sys.stderr)
            failures += 1
        else:
            print(f"Gate time: {elapsed:.1f}s / {budget}s budget")
        if failures:
            print(f"Gate failed: {failures} check(s)", file=sys.stderr)
            return 1
        print("Gate passed")
        return 0
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError, ValueError) as error:
        print(f"GATE ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
