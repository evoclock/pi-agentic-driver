#!/usr/bin/env python3
"""Host-run fail-first, test-diff, mutation, and evidence checks beside make gate."""

from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import fcntl
import io
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from threading import local
from contextlib import ExitStack
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_REL = Path(".driver/test-gate-evidence")
LOCK_SCHEMA = "driver-test-gate-lock.v1"
EVIDENCE_SCHEMA = "driver-test-gate-evidence.v1"
RESULT_SCHEMA = "driver-test-gate-result.v1"
BLOCKED_EXIT = 3
MAX_OBSERVED_TESTS = 10_000
MAX_COMMAND_SECONDS = 380
CODE_SUFFIXES = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".go", ".rs", ".java"}
LOCKED_TEST_GATE_CONFIGS = {".driver/gate-rules.json", ".driver/test-gate.json"}


class Blocked(Exception):
    """A known prerequisite is absent or an observation is not trustworthy."""


class GateFailure(Exception):
    """A check ran and showed that its required behavior is not present."""


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def safe_repo_path(name: str) -> bool:
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and all(part not in {"", ".", ".."} for part in path.parts)


def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
    )


def git_value(root: Path, *args: str) -> str:
    result = run_git(root, *args)
    if result.returncode:
        raise Blocked(result.stderr.strip() or f"git {' '.join(args)} could not be observed")
    return result.stdout.strip()


def current_commit(root: Path) -> str:
    value = git_value(root, "rev-parse", "HEAD^{commit}")
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise Blocked("host could not resolve a full commit SHA")
    return value


def load_json(path: Path, description: str) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise Blocked(f"missing {description}: {path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise Blocked(f"cannot read {description}: {error}") from error
    if not isinstance(value, dict):
        raise Blocked(f"{description} must be a JSON object")
    return value


def load_rules(root: Path) -> tuple[dict, dict]:
    gate_rules = load_json(root / ".driver/gate-rules.json", "shared gate rules")
    if gate_rules.get("schema") != "driver-gate-rules.v1" or not isinstance(gate_rules.get("checks"), list):
        raise Blocked(".driver/gate-rules.json must use driver-gate-rules.v1 and contain checks")
    config = load_json(root / ".driver/test-gate.json", "test-gate configuration")
    if config.get("schema") != "driver-test-gate.v1":
        raise Blocked(".driver/test-gate.json must use driver-test-gate.v1")
    rationales = config.get("testCountRationales")
    if not isinstance(rationales, dict):
        raise Blocked("testCountRationales must explain how each host-observed total is produced")
    return gate_rules, config


def require_fresh_base(root: Path, base_ref: str, *, base_sha: str | None = None, commit_sha: str | None = None, contained: bool = False) -> None:
    command = [sys.executable, str(Path(__file__).with_name('check_base_freshness.py')),
               '--root', str(root), '--base', base_ref]
    if base_sha is not None:
        command += ['--expected-base', base_sha]
    if commit_sha is not None:
        command += ['--expected-head', commit_sha]
    if contained:
        command += ['--contained-observation']
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise Blocked(result.stdout.strip() or 'base freshness: check could not complete')


def require_fresh_anchor(root: Path, gate_rules: dict, commit_sha: str, comparison_ref: str) -> None:
    """Comparison selection cannot replace the configured live freshness requirement."""
    anchor_ref = gate_rules.get('baseRef')
    if not isinstance(anchor_ref, str) or not anchor_ref or anchor_ref.startswith('-'):
        raise Blocked('configured freshness anchor is missing or invalid')
    observed_base = os.environ.get('PAD_OBSERVABILITY_BASE')
    observed_head = os.environ.get('PAD_OBSERVABILITY_HEAD')
    if root == Path('/scratch/work') and (observed_base or observed_head):
        if comparison_ref != observed_base or commit_sha != observed_head:
            raise Blocked('contained observation does not match comparison base/head')
        # The helper verifies actual isolation and immutable /source, not caller claims alone.
        require_fresh_base(root, 'main', base_sha=observed_base, commit_sha=commit_sha, contained=True)
    else:
        require_fresh_base(root, anchor_ref, commit_sha=commit_sha)


def resolve_base(root: Path, gate_rules: dict, override: str | None) -> tuple[str, str]:
    ref = override or gate_rules.get("baseRef")
    if not isinstance(ref, str) or not ref or ref.startswith("-"):
        raise Blocked("base ref is missing; set baseRef in .driver/gate-rules.json or pass --base")
    result = run_git(root, "rev-parse", "--verify", f"{ref}^{{commit}}")
    if result.returncode:
        raise Blocked(f"cannot resolve base ref {ref!r}; fetch the target branch before test-gate")
    base_sha = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        raise Blocked("base ref did not resolve to a full commit SHA")
    return ref, base_sha


def changed_paths(root: Path, base_sha: str) -> set[str]:
    diff = run_git(root, "diff", "--name-only", "--no-renames", "-z", base_sha, "--")
    if diff.returncode:
        raise Blocked(diff.stderr.strip() or "could not compare the worktree with the base commit")
    names = {name for name in diff.stdout.split("\0") if name}
    untracked = run_git(root, "ls-files", "--others", "--exclude-standard", "-z")
    if untracked.returncode:
        raise Blocked(untracked.stderr.strip() or "could not list untracked files")
    names.update(name for name in untracked.stdout.split("\0") if name)
    return {name for name in names if safe_repo_path(name)}


def is_test_path(name: str) -> bool:
    path = PurePosixPath(name)
    if path.suffix.lower() not in {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx"}:
        return False
    rooted_test_tree = path.parts[0] == "tests" or path.parts[:2] == ("janus", "tests") or (
        path.parts[0] == "skills" and any(part in {"tests", "test", "__tests__"} for part in path.parts[1:])
    )
    if not rooted_test_tree:
        return False
    filename = path.name.lower()
    return filename.startswith("test_") or ".test." in filename or ".spec." in filename


def is_production_code_path(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        path.suffix.lower() in CODE_SUFFIXES
        and not is_test_path(name)
        and "tests" not in path.parts
        and "__tests__" not in path.parts
    )


def _python_assertions(node: ast.AST) -> int:
    count = 0
    for child in ast.walk(node):
        if isinstance(child, ast.Assert):
            count += 1
        elif isinstance(child, ast.Call):
            function = child.func
            name = function.attr if isinstance(function, ast.Attribute) else function.id if isinstance(function, ast.Name) else ""
            if name.startswith("assert"):
                count += 1
    return count


def test_source_findings(root: Path, test_paths: set[str]) -> list[str]:
    findings: list[str] = []
    for name in sorted(test_paths):
        path = root / name
        if path.is_symlink() or not path.is_file():
            findings.append(f"{name}: changed test is missing or is a symlink")
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            findings.append(f"{name}: cannot inspect test source: {error}")
            continue
        if path.suffix.lower() == ".py":
            try:
                tree = ast.parse(source, filename=name)
            except SyntaxError as error:
                findings.append(f"{name}: cannot parse test source: {error}")
                continue
            test_functions = [
                node
                for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
            ]
            if not test_functions:
                findings.append(f"{name}: no test_* function or method was found")
            for node in test_functions:
                why = ast.get_docstring(node, clean=False) or ""
                if not why.lstrip().lower().startswith("why:"):
                    findings.append(f"{name}:{node.lineno}: add a test docstring beginning with 'Why:'")
                if _python_assertions(node) == 0:
                    findings.append(f"{name}:{node.lineno}: test has no assertion; empty tests are not evidence")
            continue
        if path.suffix.lower() in {".js", ".mjs", ".cjs", ".ts", ".tsx"}:
            test_count = len(re.findall(r"\b(?:test|it)\s*\(", source))
            why_count = len(re.findall(r"(?im)^\s*//\s*why\s*:", source))
            if not test_count:
                findings.append(f"{name}: no test(...) or it(...) case was found")
            if why_count < test_count:
                findings.append(f"{name}: add a '// Why:' note for each test(...) or it(...) case")
            if not re.search(r"\bassert(?:\s*\.|\s*\()|\bexpect\s*\(", source):
                findings.append(f"{name}: no assertion or expect(...) call was found")
            continue
        findings.append(f"{name}: test-gate has no test-source checks for {path.suffix or 'extensionless'} files")
    return findings


def gate_check(gate_rules: dict, check_id: str) -> dict:
    matches = [check for check in gate_rules["checks"] if isinstance(check, dict) and check.get("id") == check_id]
    if len(matches) != 1:
        raise Blocked(f"shared gate has no unique {check_id!r} command")
    check = matches[0]
    command = check.get("command")
    cwd = check.get("cwd", ".")
    if check.get("kind") != "command" or not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
        raise Blocked(f"shared gate check {check_id!r} needs a non-empty argument-list command")
    if not isinstance(cwd, str) or not safe_repo_path(cwd) and cwd != ".":
        raise Blocked(f"shared gate check {check_id!r} has an unsafe cwd")
    return {"id": check_id, "command": command, "cwd": cwd}


def test_command_for_path(name: str, root: Path, gate_rules: dict) -> dict:
    path = PurePosixPath(name)
    if path.suffix.lower() == ".py":
        if name.startswith("skills/weekly-build-recap/"):
            return gate_check(gate_rules, "weekly-recap-tests")
        if name.startswith("skills/public-pr-wording/"):
            return gate_check(gate_rules, "public-pr-wording-tests")
        if name.startswith("tests/"):
            return gate_check(gate_rules, "python-tests")
    if name.startswith("janus/tests/"):
        return gate_check(gate_rules, "janus-tests")
    if name.startswith("tests/") and path.suffix.lower() in {".js", ".mjs", ".cjs", ".ts", ".tsx"}:
        return {"id": "node-tests", "command": ["node", "--test", "--test-reporter=tap", name], "cwd": "."}
    raise Blocked(f"no host test command is mapped for changed test {name}; add it beside the shared gate")


def command_specs(root: Path, gate_rules: dict, config: dict, test_paths: set[str]) -> list[dict]:
    selected: dict[tuple[tuple[str, ...], str], dict] = {}
    rationales = config["testCountRationales"]
    caps = config.get("caps")
    max_tests = caps.get("maxObservedTests") if isinstance(caps, dict) else None
    timeout_seconds = caps.get("commandTimeoutSeconds") if isinstance(caps, dict) else None
    if type(max_tests) is not int or not 1 <= max_tests <= MAX_OBSERVED_TESTS:
        raise Blocked(f"caps.maxObservedTests must be an integer from 1 through {MAX_OBSERVED_TESTS}")
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float)) or not 0 < timeout_seconds <= MAX_COMMAND_SECONDS:
        raise Blocked(f"caps.commandTimeoutSeconds must be greater than zero and no more than {MAX_COMMAND_SECONDS}")
    for name in sorted(test_paths):
        spec = test_command_for_path(name, root, gate_rules)
        command = list(spec["command"])
        if command[:4] == ["python3", "-m", "unittest", "discover"]:
            command = ["python3", "-m", "unittest", "discover", "-s", str(PurePosixPath(name).parent), "-p", PurePosixPath(name).name]
        rationale = rationales.get(spec["id"])
        if not isinstance(rationale, str) or not rationale.strip():
            raise Blocked(f"testCountRationales.{spec['id']} must explain the denominator before counts are trusted")
        key = (tuple(command), spec["cwd"])
        selected[key] = {
            **spec,
            "command": command,
            "testFiles": [name],
            "rationale": rationale.strip(),
            "maxObservedTests": max_tests,
            "timeoutSeconds": float(timeout_seconds),
        }
    return list(selected.values())


def parse_test_counts(output: str) -> dict | None:
    # Python 3.14 honors FORCE_COLOR inherited from a parent Node reporter.
    # Normalize display-only SGR codes here; evidence still hashes the raw output.
    output = re.sub(r'\x1b\[[0-9;]*m', '', output)
    node_tests = list(re.finditer(r"(?m)^# tests\s+(\d+)\s*$", output))
    unittest_totals = list(re.finditer(r"(?m)^Ran\s+(\d+)\s+tests?\b", output))
    # A nested gate may print Node summaries; select the outermost, last reporter.
    if node_tests and (not unittest_totals or node_tests[-1].start() > unittest_totals[-1].start()):
        reporter = output[node_tests[-1].end():]

        def node_count(label: str) -> int:
            match = re.search(rf"(?m)^# {label}\s+(\d+)\s*$", reporter)
            return int(match.group(1)) if match else 0

        total = int(node_tests[-1].group(1))
        failures = node_count("fail")
        skipped = node_count("skipped")
        # Only failed TAP diagnostics are evidence, never console substrings.
        # A file-level ERR_TEST_FAILURE means assertions may never have loaded.
        diagnostics = re.findall(r"(?m)^([ \t]*)not ok [^\n]*\n\1  ---\n(.*?)^\1  \.\.\.",
                                 output[:node_tests[-1].start()], re.DOTALL | re.MULTILINE)
        infrastructure = sum(
            bool(re.search(r"(?m)^\s+code: ['\"](?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED)['\"]\s*$", diagnostic))
            or bool(re.search(r"(?m)^\s+exitCode:", diagnostic)
                    and re.search(r"(?m)^\s+code: [\'\"]ERR_TEST_FAILURE[\'\"]\s*$", diagnostic))
            or bool(re.search(r"(?m)^\s+code: ['\"]ERR_TEST_FAILURE['\"]\s*$", diagnostic)
                    and re.search(r"(?m)^\s+name: ['\"]SyntaxError['\"]\s*$", diagnostic)
                    and re.search(r"(?m)^\s+stack:\s*\|-\n\s+[^\n]*node:internal/modules/(?:esm|cjs)/", diagnostic))
            for _, diagnostic in diagnostics
        )
        return {
            "tests": total,
            "failures": failures,
            "errors": infrastructure,
            "skipped": skipped,
            "cancelled": node_count("cancelled"),
            "todo": node_count("todo"),
            "passed": node_count("pass"),
        }

    if unittest_totals:
        # Nested test-gate witnesses may print their own summaries; the outer runner reports last.
        reporter = output[unittest_totals[-1].end():]
        summaries = re.findall(r"(?m)^(?:FAILED|OK)(?:\s*\(([^)]*)\))?\s*$", reporter)
        details = summaries[-1] if summaries else ""
        failures = int((re.search(r"failures=(\d+)", details) or [None, "0"])[1])
        errors = int((re.search(r"errors=(\d+)", details) or [None, "0"])[1])
        skipped = int((re.search(r"skipped=(\d+)", details) or [None, "0"])[1])
        total = int(unittest_totals[-1].group(1))
        return {
            "tests": total,
            "failures": failures,
            "errors": errors,
            "skipped": skipped,
            "passed": max(0, total - failures - errors - skipped),
        }

    pytest_summary = re.search(r"(?m)^(?:=+ )?(\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?", output)
    if pytest_summary:
        passed = int(pytest_summary.group(1))
        failures = int(pytest_summary.group(2) or 0)
        skipped = int(pytest_summary.group(3) or 0)
        return {"tests": passed + failures + skipped, "failures": failures, "errors": 0, "skipped": skipped, "passed": passed}
    return None


def worktree_fingerprint(root: Path, base_sha: str) -> tuple[int, str]:
    paths = changed_paths(root, base_sha)
    digest = hashlib.sha256()
    for name in sorted(paths):
        path = root / name
        digest.update(name.encode("utf-8", errors="surrogateescape"))
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(b"symlink")
        elif path.is_file():
            digest.update(sha256_bytes(path.read_bytes()).encode("ascii"))
        else:
            digest.update(b"missing")
        digest.update(b"\n")
    return len(paths), digest.hexdigest()


def evidence_path(root: Path) -> Path:
    directory = root / EVIDENCE_REL
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "checks.jsonl"


def append_evidence(root: Path, record: dict) -> None:
    target = evidence_path(root)
    value = {"schema": EVIDENCE_SCHEMA, "recordedAt": datetime.now(timezone.utc).isoformat(), **record}
    with target.open("a", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        stream.flush()


_COMMAND_CAPTURE = local()


def emit_command(root: Path, record: dict, output: str) -> None:
    print(f"RUN [{record['phase']}]: {record['command']} (cwd={record['cwd']}, contract={record.get('contractId') or '-'})", flush=True)
    if record['timedOut']:
        print(f"TIMEOUT [{record['phase']}]: exceeded {record['timeoutSeconds']:g}s", flush=True)
    if output:
        print(output, end="" if output.endswith("\n") else "\n", flush=True)
    append_evidence(root, record)


def available_cpus(quota_path: Path = Path('/sys/fs/cgroup/cpu.max')) -> int:
    count = os.cpu_count() or 1
    try:
        quota, period = quota_path.read_text().split()
        if quota != 'max' and int(quota) > 0 and int(period) > 0:
            count = min(count, max(1, int(quota) // int(period)))
    except (OSError, ValueError):
        pass  # Non-cgroup hosts retain the existing core observation.
    return count


def mutation_workers() -> int:
    if os.environ.get('PAD_TEST_GATE_NESTED') == '1':
        return 1
    value = os.environ.get('PAD_TEST_GATE_WORKERS', str(min(4, os.cpu_count() or 1)))
    if value not in {'1', '2', '3', '4'}:
        raise Blocked('PAD_TEST_GATE_WORKERS must be 1..4')
    value = str(min(int(value), available_cpus()))
    return min(int(value), os.cpu_count() or 1)


def mutation_jobs(root: Path, jobs: dict, operation) -> list:
    """Run isolated jobs concurrently; publish complete command blocks in input order."""
    def execute(item):
        key, value = item
        _COMMAND_CAPTURE.pending = []
        try:
            result, error = operation(key, value), None
        except Exception as caught:
            result, error = None, caught
        pending = _COMMAND_CAPTURE.pending
        del _COMMAND_CAPTURE.pending
        return key, result, error, pending

    with ThreadPoolExecutor(max_workers=mutation_workers()) as pool:
        completed = list(pool.map(execute, jobs.items()))
    failures, results = [], []
    for key, result, error, pending in completed:
        for record, output in pending:
            emit_command(root, record, output)
        if error is not None:
            failures.append((key, error))
        results.append(result)
    if failures:
        key, error = failures[0]
        if isinstance(error, (Blocked, GateFailure)):
            raise type(error)(f'{key}: {error}') from error
        raise error
    return results


def node_command_groups(command: list[str], execute_root: Path, cwd: Path, environment: dict, timeout: float) -> list[list[str]] | None:
    """Optimize only explicit multi-file Node tests; unknown plans keep the native command."""
    helper = execute_root / 'scripts/node_test_run.mjs'
    sandbox = execute_root / 'scripts/node_test_sandbox.mjs'
    offset = 3 if len(command) > 2 and command[2] == '--test-reporter=tap' else 2
    if (len(command) < offset + 2 or Path(command[0]).name != 'node' or command[1] != '--test'
            or not all(not name.startswith('-') and name.endswith('.mjs') for name in command[offset:])
            or not helper.is_file() or not sandbox.is_file()):
        return None
    try:
        planned = subprocess.run([command[0], str(helper), '--plan'], cwd=cwd, env=environment,
                                 input=json.dumps({'root': str(cwd), 'argv': command[1:]}),
                                 capture_output=True, text=True, timeout=min(timeout, 20))
        if planned.returncode != 0:
            return None
        groups = json.loads(planned.stdout)['groups']
        files = [name for group in groups for name in group['files']]
        expected = sorted(str((cwd / name).resolve()) for name in command[offset:])
        if (not groups or sorted(str(Path(name).resolve()) for name in files) != expected
                or any(type(group['safe']) is not bool or not group['files'] for group in groups)
                or not any(group['safe'] and len(group['files']) >= 2 for group in groups)):
            return None
        return [[*command[:offset], '--import', str(sandbox),
                 *(['--experimental-test-isolation=none'] if group['safe'] else []), *group['files']]
                for group in groups]
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        return None


def run_command(
    evidence_root: Path,
    execute_root: Path,
    spec: dict,
    *,
    phase: str,
    commit_sha: str,
    base_sha: str,
    expected: str,
    environment: dict[str, str] | None = None,
    mutation_path: str | None = None,
) -> dict:
    command = spec["command"]
    cwd_rel = spec.get("cwd", ".")
    cwd = execute_root if cwd_rel == "." else execute_root / cwd_rel
    if not cwd.is_dir() or not cwd.resolve().is_relative_to(execute_root.resolve()):
        raise Blocked(f"test command cwd {cwd_rel!r} is missing or escapes its work tree")
    started = time.monotonic()
    changed_count, diff_sha256 = worktree_fingerprint(evidence_root, base_sha)
    timeout_seconds = spec["timeoutSeconds"]
    protected = None
    if phase in {"mutation-head-tests", "mutation-spot-check"} and execute_root != evidence_root:
        names = {str(path.relative_to(execute_root)) for path in execute_root.rglob("*")
                 if path.is_file() and not path.is_symlink() and '.git' not in path.relative_to(execute_root).parts}
        protected = test_hashes(execute_root, names)
    history = evidence_root / EVIDENCE_REL / "checks.jsonl"
    previous = None
    if history.is_file():
        for line in history.read_text().splitlines():
            item = json.loads(line)
            if (item.get("argv") == command and item.get("cwd") == cwd_rel
                    and item.get("phase") == phase and item.get("mutationPath") == mutation_path and "elapsedMs" in item):
                previous = item
    if previous is not None and previous["elapsedMs"] > timeout_seconds * 750:
        raise Blocked(f"{spec.get('checkId', command[0])}: last runtime {previous['elapsedMs'] / 1000:.3f}s / cap {timeout_seconds}s leaves under 25% headroom; use a reviewed configuration transition in a fresh lease, never edit a baseline lock")
    if shutil.which(command[0], path=os.environ.get("PATH")) is None and not os.access(cwd / command[0], os.X_OK):
        raise Blocked(f"required test tool missing before run: {command[0]}")
    timed_out = False
    process_environment = dict(os.environ if environment is None else environment)
    checkout = process_environment.get("BUILDKITE_BUILD_CHECKOUT_PATH")
    # Why: base snapshots may contain old runners that annotate on BUILDKITE alone.
    if (not checkout or execute_root.resolve() != Path(checkout).resolve() or
            cwd.resolve() != Path(checkout).resolve()):
        process_environment.pop("BUILDKITE", None)
        process_environment.pop("BUILDKITE_BUILD_CHECKOUT_PATH", None)
    process_environment["PYTHONDONTWRITEBYTECODE"] = "1"
    temporary = None
    if phase in {"mutation-head-tests", "mutation-spot-check"}:
        process_environment["PAD_TEST_GATE_NESTED"] = "1"
        temporary = tempfile.TemporaryDirectory(prefix='test-gate-command-')
        for name in ('TMPDIR', 'TMP', 'TEMP'):
            process_environment[name] = temporary.name
        option = '-Djava.io.tmpdir=' + json.dumps(temporary.name, ensure_ascii=False)
        process_environment['JAVA_TOOL_OPTIONS'] = (process_environment.get('JAVA_TOOL_OPTIONS', '') + ' ' + option).strip()
        if execute_root != evidence_root:
            process_environment["GIT_CEILING_DIRECTORIES"] = str(execute_root.resolve().parent)
            for name in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'):
                process_environment.pop(name, None)
    executed = []
    output = ''
    try:
        groups = node_command_groups(command, execute_root, cwd, process_environment, timeout_seconds) if phase in {'mutation-head-tests', 'mutation-spot-check'} else None
        exit_code = 0
        for actual in groups or [command]:
            row = {'argv': actual, 'exitCode': None, 'testCounts': None}
            executed.append(row)
            result = subprocess.run(actual, cwd=cwd, env=process_environment, capture_output=True,
                                    text=True, errors='replace', timeout=max(.001, timeout_seconds - (time.monotonic() - started)))
            native_output = (result.stdout or '') + (result.stderr or '')
            row.update(exitCode=result.returncode, testCounts=parse_test_counts(native_output),
                       outputSha256=sha256_bytes(native_output.encode('utf-8', errors='replace')))
            output += native_output
            if result.returncode and exit_code == 0:
                exit_code = result.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or error.output or ""
        stderr = error.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        output = stdout + stderr
        exit_code = 124
        timed_out = True
    except OSError as error:
        output = str(error)
        exit_code = 127
    finally:
        if temporary is not None:
            temporary.cleanup()
    elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
    counts = parse_test_counts(output)
    if len(executed) > 1:
        native_counts = [row['testCounts'] for row in executed]
        counts = ({key: sum(row.get(key, 0) for row in native_counts) for key in set().union(*native_counts)}
                  if all(row is not None for row in native_counts) else None)
    if executed and executed[-1]['exitCode'] is None:
        executed[-1].update(exitCode=exit_code, timedOut=timed_out)
    input_hashes = {}
    for name in spec.get("testFiles", []):
        input_path = execute_root / name
        if input_path.is_file() and not input_path.is_symlink():
            input_hashes[name] = sha256_bytes(input_path.read_bytes())
    record = {
        "phase": phase,
        "command": shlex.join(command),
        "argv": command,
        "executedCommands": executed,
        "cwd": cwd_rel,
        "exitCode": exit_code,
        "commitSha": commit_sha,
        "baseCommitSha": base_sha,
        "changedPathsCount": changed_count,
        "worktreeDiffSha256": diff_sha256,
        "elapsedMs": elapsed_ms,
        "timeoutSeconds": timeout_seconds,
        "timedOut": timed_out,
        "expectedOutcome": expected,
        "testCounts": counts,
        "testCountRationale": spec.get("rationale"),
        "testFileSha256": input_hashes,
        "contractId": spec.get("contractId"),
        "executeTree": str(execute_root),
        "mutationPath": mutation_path,
        "mutantSha256": spec.get("mutantSha256"),
        "outputSha256": sha256_bytes(output.encode("utf-8", errors="replace")),
    }
    pending = getattr(_COMMAND_CAPTURE, "pending", None)
    if pending is None:
        emit_command(evidence_root, record, output)
    else:
        pending.append((record, output))
    if protected is not None and test_hashes(execute_root, set(protected)) != protected:
        raise Blocked("contract inputs or worktree changed in isolated command")
    return {"exitCode": exit_code, "counts": counts, "output": output, "record": record, "timedOut": timed_out}


def validate_counts(observation: dict, spec: dict, *, phase: str) -> dict:
    if observation.get("timedOut"):
        raise Blocked(f"{phase}: command exceeded the {spec['timeoutSeconds']:g}s host time cap")
    counts = observation["counts"]
    if counts is None:
        raise Blocked(f"{phase}: test runner did not report a count; explain/configure a supported host-observed total")
    if counts["tests"] <= 0:
        raise Blocked(f"{phase}: zero tests observed; no pass rate or fail-first claim is valid")
    if counts["tests"] > spec["maxObservedTests"]:
        raise Blocked(f"{phase}: host-observed test count {counts['tests']} exceeds cap {spec['maxObservedTests']}")
    expected_count = spec.get("expectedTests")
    if expected_count is not None and counts["tests"] != expected_count:
        raise Blocked(f"{phase}: expectedTests={expected_count} does not match host-observed {counts['tests']}")
    return counts


def is_test_support_path(name: str) -> bool:
    return name.startswith("tests/fixtures/")


def working_tree_paths(root: Path, base_sha: str) -> tuple[set[str], set[str], set[str], set[str]]:
    paths = changed_paths(root, base_sha)
    tests = {name for name in paths if is_test_path(name)}
    test_inputs = tests | {name for name in paths if is_test_support_path(name)}
    if tests:
        test_inputs.update(LOCKED_TEST_GATE_CONFIGS)
    code = {name for name in paths if is_production_code_path(name)}
    return paths, tests, code, test_inputs


def changed_test_support_paths(root: Path) -> set[str]:
    result = run_git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "tests/fixtures")
    if result.returncode:
        raise Blocked(result.stderr.strip() or "could not list test-gate fixture data")
    return {name for name in result.stdout.split("\0") if name and safe_repo_path(name)}


def prepare_base_snapshot(root: Path, base_sha: str, test_paths: set[str]) -> Path:
    digest = hashlib.sha256((base_sha + "\n" + "\n".join(sorted(test_paths))).encode("utf-8"))
    for name in sorted(test_paths):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise Blocked(f"{name}: cannot overlay a missing or linked test on the base snapshot")
        digest.update(sha256_bytes(path.read_bytes()).encode("ascii"))
    snapshot = root / "scratch/test-gate" / f"base-{base_sha[:12]}-{digest.hexdigest()[:12]}-{time.time_ns()}"
    snapshot.mkdir(parents=True)
    archived = subprocess.run(
        ["git", "archive", "--format=tar", base_sha],
        cwd=root,
        capture_output=True,
    )
    if archived.returncode:
        raise Blocked(archived.stderr.decode("utf-8", errors="replace").strip() or "git archive could not materialize the base commit")
    try:
        with tarfile.open(fileobj=io.BytesIO(archived.stdout), mode="r:") as bundle:
            members = bundle.getmembers()
            for member in members:
                if not safe_repo_path(member.name) or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                    raise Blocked(f"base archive contains an unsupported or unsafe entry: {member.name}")
            bundle.extractall(snapshot, members=members)
    except (tarfile.TarError, OSError) as error:
        raise Blocked(f"could not extract the host-created base archive: {error}") from error

    overlay = set(test_paths)
    if any(name.startswith("tests/") for name in test_paths):
        # New fixtures belong to the head, not the base being tested.
        overlay.update(name for name in changed_test_support_paths(root)
                       if (snapshot / name).is_file())
    for name in sorted(overlay):
        source = root / name
        if source.is_symlink() or not source.is_file():
            if name in test_paths:
                raise Blocked(f"{name}: changed test disappeared while preparing the base run")
            continue
        destination = snapshot / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())

    for dependency in ("node_modules", "janus/node_modules"):
        source = root / dependency
        target = snapshot / dependency
        if not target.exists() and source.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(source.resolve(), target_is_directory=True)
    return snapshot


def test_hashes(root: Path, test_paths: set[str]) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for name in sorted(test_paths):
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise Blocked(f"{name}: test file is missing or linked")
        hashes[name] = sha256_bytes(path.read_bytes())
    return hashes


def current_branch(root: Path) -> str:
    result = run_git(root, "branch", "--show-current")
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else "detached"


def lock_location(root: Path, base_sha: str, test_inputs: set[str]) -> Path:
    identity_text = f"{root.resolve()}\n{current_branch(root)}\n{base_sha}\n" + "\n".join(sorted(test_inputs))
    identity = sha256_bytes(identity_text.encode("utf-8"))[:20]
    return root / EVIDENCE_REL / f"baseline-lock-{identity}.json"


def test_dependency_scope(root: Path, snapshot: Path, spec: dict, code: set[str]) -> list[str]:
    """Inspect literal test imports and fail closed on changed exercised production."""
    bodies = []
    imported = set()
    pending = list(spec['testFiles'])
    while pending:
        name = pending.pop()
        if name in imported:
            continue
        imported.add(name)
        source = snapshot / name
        if not source.is_file() or source.is_symlink():
            raise Blocked(f'fixture correction cannot inspect dependency {name}')
        text = source.read_text(encoding='utf-8')
        bodies.append(text)
        dynamic = re.findall(r'\b(?:import|require)\s*\(', text)
        literal_imports = re.findall(r'\bimport\s*\(\s*[\x22\x27]([^\x22\x27]+)[\x22\x27]\s*\)', text)
        if len(dynamic) != len(literal_imports):
            raise Blocked(f'fixture correction cannot prove dynamic imports are unchanged: {name}')
        if name.endswith('.py'):
            try:
                module = ast.parse(text)
            except SyntaxError as error:
                raise Blocked(f'fixture correction cannot inspect Python dependency: {error}') from error
            modules = [node.module for node in ast.walk(module) if isinstance(node, ast.ImportFrom) and node.module]
            modules += [alias.name for node in ast.walk(module) if isinstance(node, ast.Import) for alias in node.names]
            references = [item.replace('.', '/') + '.py' for item in modules]
        else:
            references = []
            for value in [*literal_imports, *re.findall(r'(?:\bfrom\s*|\bimport\s*)[\x22\x27]([^\x22\x27]+)[\x22\x27]', text)]:
                if value.startswith('.'):
                    references.append(str(PurePosixPath(os.path.normpath(str(PurePosixPath(name).parent / value)))))
        pending.extend(path for path in references if (snapshot / path).is_file() and path not in imported)
    for name in code:
        if (name in imported or any(name in body or PurePosixPath(name).name in body for body in bodies) or
                any(PurePosixPath(name).parent == PurePosixPath(item).parent for item in imported if not is_test_path(item))):
            raise Blocked(f'correction cannot mask changed production dependency: {name}')
    return bodies


def preserve_test_tokens(old: str, corrected: str, name: str) -> None:
    tokens = iter(re.findall(r'\w+|[^\s]', corrected))
    for token in re.findall(r'\w+|[^\s]', old):
        if not any(current == token for current in tokens):
            raise Blocked(f'correction removed or relaxed an existing assertion or test token: {name}')


def fixture_contrast(root: Path, snapshot: Path, base_sha: str, commit_sha: str, spec: dict, corrected: dict, cleanup: ExitStack) -> dict:
    """Prove a base fixture regression with host runs, never with a label or lock claim."""
    changed, tests, code, _ = working_tree_paths(root, base_sha)
    fixtures = sorted(name for name in changed if is_test_support_path(name))
    if not fixtures or not set(spec['testFiles']).intersection(tests):
        raise GateFailure(f"new tests passed on the base commit ({corrected['counts']['tests']} tests, zero failures)")
    bodies = test_dependency_scope(root, snapshot, spec, code)
    relevant = [name for name in fixtures if any(name in body or name.removeprefix('tests/') in body or
                (PurePosixPath(name).parent.name in body and PurePosixPath(name).name in body) for body in bodies)]
    if not relevant:
        raise GateFailure(f"new tests passed on the base commit ({corrected['counts']['tests']} tests, zero failures)")
    if set(relevant) != set(fixtures):
        raise Blocked('fixture correction cannot attribute every changed fixture to this spec')
    for name in spec['testFiles']:
        old = run_git(root, 'show', f'{base_sha}:{name}')
        if old.returncode:
            continue
        preserve_test_tokens(old.stdout, (root / name).read_text(encoding='utf-8'), name)
    historical_snapshot = prepare_base_snapshot(root, base_sha, set(spec['testFiles']))
    cleanup.callback(shutil.rmtree, historical_snapshot)
    hashes = {}
    for name in relevant:
        base_file = subprocess.run(['git', 'show', f'{base_sha}:{name}'], cwd=root, capture_output=True)
        if base_file.returncode or (root / name).is_symlink() or not (root / name).is_file():
            raise Blocked(f'fixture correction requires an existing regular base fixture: {name}')
        hashes[name] = {'base': sha256_bytes(base_file.stdout), 'corrected': sha256_bytes((root / name).read_bytes())}
        if hashes[name]['base'] == hashes[name]['corrected']:
            raise GateFailure('fixture correction has no changed fixture content')
        (historical_snapshot / name).write_bytes(base_file.stdout)
    historical = run_command(root, historical_snapshot, spec, phase='fixture-correction-base', commit_sha=commit_sha,
                             base_sha=base_sha, expected='assertion failures with historical fixtures',
                             environment={key: value for key, value in os.environ.items() if key != 'TEST_GATE_SCRIPT'})
    counts = validate_counts(historical, spec, phase='fixture correction')
    if counts['errors'] or historical['timedOut'] or (
            spec['testFiles'][0].endswith(('.js', '.mjs', '.ts', '.tsx')) and counts['failures'] and
            not re.search(r'\b(?:ERR_ASSERTION|AssertionError)\b', historical['output'])):
        raise Blocked('fixture correction historical run had errors or no assertion failures')
    if not historical['exitCode'] or not counts['failures']:
        raise GateFailure(f"new tests passed on the base commit ({counts['tests']} tests, zero failures)")
    head = run_command(root, root, spec, phase='fixture-correction-head', commit_sha=commit_sha,
                       base_sha=base_sha, expected='head tests pass with corrected fixture')
    head_counts = validate_counts(head, spec, phase='fixture correction head')
    if head_counts['errors'] or head['timedOut']:
        raise Blocked('fixture correction head run had errors or timed out')
    if head['exitCode'] or head_counts['failures'] or not head_counts['passed']:
        raise GateFailure('fixture correction head tests did not pass')
    proof = {'checkId': spec['id'], 'fixturePaths': relevant, 'fixtureHashes': hashes,
             'baseObservation': {'testCounts': counts, 'exitCode': historical['exitCode'], 'outputSha256': historical['record']['outputSha256']},
             'correctedObservation': {'testCounts': corrected['counts'], 'exitCode': corrected['exitCode'], 'outputSha256': corrected['record']['outputSha256']},
             'headObservation': {'testCounts': head_counts, 'exitCode': head['exitCode'], 'outputSha256': head['record']['outputSha256']}}
    append_evidence(root, {'phase': 'fixture-correction-proof', 'commitSha': commit_sha, 'baseCommitSha': base_sha, **proof})
    return proof


def hermetic_lines(old: str, corrected: str, name: str) -> None:
    """Allow only added JS environment save/set/clear/restore and try/finally scaffolding."""
    preserve_test_tokens(old, corrected, name)
    before = [line.strip() for line in old.splitlines()]
    after = [line.strip() for line in corrected.splitlines()]
    allowed = (
        r'const (?:previousSkillsRoot|prior) = process\.env\.(?:PI_POTETO_SKILLS_ROOT|DRIVER_HERMETIC_ROOT);',
        r'const names = \[\x27HERDR_WORKSPACE_ID\x27, \x27HERDR_TAB_ID\x27, \x27HERDR_PANE_ID\x27\];',
        r'const old = names\.map\(\(name\) => process\.env\[name\]\);',
        r'for \(const name of names\) delete process\.env\[name\];',
        r'process\.env\.(?:PI_POTETO_SKILLS_ROOT|DRIVER_HERMETIC_ROOT) = [\x27\x22][^\x27\x22\n]*[\x27\x22];',
        r'try \{|\} finally \{|\}',
        r'if \((?:previousSkillsRoot|prior) === undefined\) delete process\.env\.(?:PI_POTETO_SKILLS_ROOT|DRIVER_HERMETIC_ROOT);',
        r'else process\.env\.(?:PI_POTETO_SKILLS_ROOT|DRIVER_HERMETIC_ROOT) = (?:previousSkillsRoot|prior);',
        r'names\.forEach\(\(name, index\) => old\[index\] === undefined \? delete process\.env\[name\] : process\.env\[name\] = old\[index\]\);',
    )
    added = []
    for operation, start, end, insert, finish in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if operation not in ('equal', 'insert'):
            raise Blocked(f'hermetic correction removed or relaxed an existing assertion or test line: {name}')
        if operation == 'insert':
            added.extend(after[insert:finish])
    if (not added or any(not any(re.fullmatch(pattern, line) for pattern in allowed) for line in added) or
            'try {' not in after or '} finally {' not in after or
            not any(line.startswith(('const previousSkillsRoot =', 'const prior =', 'const old =')) for line in added) or
            not any(line.startswith(('else process.env.', 'names.forEach(')) for line in added)):
        raise Blocked(f'hermetic correction includes non-environment-isolation changes or lacks restoration: {name}')


def hermetic_contrast(root: Path, snapshot: Path, base_sha: str, commit_sha: str, spec: dict, corrected: dict, cleanup: ExitStack) -> dict:
    """Observe historical test assertions on untouched base production and corrected head."""
    _, _, code, _ = working_tree_paths(root, base_sha)
    if len(spec['testFiles']) != 1 or not spec['testFiles'][0].endswith(('.mjs', '.js')):
        raise GateFailure(f"new tests passed on the base commit ({corrected['counts']['tests']} tests, zero failures)")
    name = spec['testFiles'][0]
    old = run_git(root, 'show', f'{base_sha}:{name}')
    if old.returncode or (root / name).is_symlink() or not (root / name).is_file():
        raise GateFailure(f"new tests passed on the base commit ({corrected['counts']['tests']} tests, zero failures)")
    new = (root / name).read_text(encoding='utf-8')
    hermetic_lines(old.stdout, new, name)
    test_dependency_scope(root, snapshot, spec, code)
    historical_snapshot = prepare_base_snapshot(root, base_sha, set())
    cleanup.callback(shutil.rmtree, historical_snapshot)
    historical_bodies = test_dependency_scope(root, historical_snapshot, spec, set())
    if not any(re.search(r'process\.env\.(?:PI_POTETO_SKILLS_ROOT|DRIVER_HERMETIC_ROOT)|process\.env\[name\]', body)
               for body in historical_bodies):
        raise GateFailure(f"new tests passed on the base commit ({corrected['counts']['tests']} tests, zero failures)")
    contrast_env = {key: value for key, value in os.environ.items() if key != 'TEST_GATE_SCRIPT'}
    # Why: the preserved null-worker assertion can expose inherited-pane contamination
    # only when a real pane is present; give old and corrected tests the same dirty input.
    if (name == 'tests/test_task_skill_observability_qa.mjs' and
            'assert.equal(report.attempts[0].workerId, null)' in old.stdout and
            "for (const name of names) delete process.env[name];" in new):
        contrast_env.update(HERDR_WORKSPACE_ID='w11', HERDR_TAB_ID='w11:t2T', HERDR_PANE_ID='w11:p2T')
    historical = run_command(root, historical_snapshot, spec, phase='hermetic-correction-base',
                             commit_sha=commit_sha, base_sha=base_sha, expected='old test assertion failure on base',
                             environment=contrast_env)
    counts = validate_counts(historical, spec, phase='hermetic correction')
    if counts['errors'] or historical['timedOut'] or (counts['failures'] and
            not re.search(r'\b(?:ERR_ASSERTION|AssertionError)\b', historical['output'])):
        raise Blocked('hermetic correction old test had errors or no assertion failures')
    if not historical['exitCode'] or not counts['failures']:
        raise GateFailure(f"new tests passed on the base commit ({counts['tests']} tests, zero failures)")
    head = run_command(root, root, spec, phase='hermetic-correction-head', commit_sha=commit_sha,
                       base_sha=base_sha, expected='corrected head tests pass', environment=contrast_env)
    head_counts = validate_counts(head, spec, phase='hermetic correction head')
    if head['exitCode'] or head_counts['errors'] or head_counts['failures'] or head['timedOut'] or not head_counts['passed']:
        raise GateFailure('hermetic correction head tests did not pass')
    proof = {'checkId': spec['id'], 'testPaths': [name],
             'testHashes': {name: {'base': sha256_bytes(old.stdout.encode()), 'corrected': sha256_bytes(new.encode())}},
             'baseObservation': {'testCounts': counts, 'exitCode': historical['exitCode'],
                                 'outputSha256': historical['record']['outputSha256']},
             'headObservation': {'testCounts': head_counts, 'exitCode': head['exitCode'],
                                 'outputSha256': head['record']['outputSha256']}}
    append_evidence(root, {'phase': 'hermetic-correction-proof', 'commitSha': commit_sha, 'baseCommitSha': base_sha, **proof})
    return proof


def new_test_cases(root: Path, base_sha: str, name: str) -> bool:
    """A changed file is not itself a new test: compare declared case identities."""
    old = run_git(root, 'show', f'{base_sha}:{name}')
    if old.returncode:
        return True
    head = (root / name).read_text(encoding='utf-8')
    if name.endswith('.py'):
        def cases(source):
            tree = ast.parse(source)
            return {node.name for node in ast.walk(tree)
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith('test_')}
    else:
        # Dynamic case names cannot be safely classified as inherited.
        pattern = r"\b(?:test|it)\s*\(\s*(['\"])(.*?)\1"
        def cases(source):
            return {match.group(2) for match in re.finditer(pattern, source)}
        declarations = r'(?<![\w.])(?:test|it)\s*\('
        if len(re.findall(declarations, head)) > len(re.findall(declarations, old.stdout)) and not cases(head) - cases(old.stdout):
            return True  # An added dynamic case must still run fail-first.
    try:
        return bool(cases(head) - cases(old.stdout))
    except (SyntaxError, UnicodeError):
        return True


def fixture_baseline_observations(root: Path, base_sha: str, commit_sha: str, tests: set[str], specs: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    with ExitStack() as cleanup:
        return _fixture_baseline_observations(root, base_sha, commit_sha, tests, specs, cleanup)


def _fixture_baseline_observations(root: Path, base_sha: str, commit_sha: str, tests: set[str], specs: list[dict], cleanup: ExitStack) -> tuple[list[dict], list[dict], list[dict]]:
    snapshot = prepare_base_snapshot(root, base_sha, tests)
    cleanup.callback(shutil.rmtree, snapshot)
    observations, proofs, hermetic_proofs = [], [], []
    new_specs = [spec for spec in specs if any(new_test_cases(root, base_sha, name) for name in spec['testFiles'])]
    # Keep legacy edited-case contrasts when there are no newly declared cases.
    for spec in new_specs or specs:
        observation = run_command(root, snapshot, spec, phase='fail-first-base', commit_sha=commit_sha,
                                  base_sha=base_sha, expected='assertion failure or host-proven fixture correction',
                                  environment={key: value for key, value in os.environ.items() if key != 'TEST_GATE_SCRIPT'})
        counts = validate_counts(observation, spec, phase='fail-first')
        if observation['exitCode'] == 0:
            paths, _, _, _ = working_tree_paths(root, base_sha)
            if spec['testFiles'] == ['tests/test_task_skill_observability_qa.mjs']:
                # Why: an unrelated changed fixture cannot explain this test's inherited-env repair.
                hermetic_proofs.append(hermetic_contrast(root, snapshot, base_sha, commit_sha, spec, observation, cleanup))
            elif any(is_test_support_path(name) for name in paths):
                proofs.append(fixture_contrast(root, snapshot, base_sha, commit_sha, spec, observation, cleanup))
            else:
                hermetic_proofs.append(hermetic_contrast(root, snapshot, base_sha, commit_sha, spec, observation, cleanup))
        elif counts['errors']:
            raise Blocked(f"fail-first command had {counts['errors']} errors; a crash is not proof that assertions fail")
        elif counts['failures'] == 0:
            raise Blocked('fail-first command exited nonzero without a reported test failure')
        observations.append({'checkId': spec['id'], 'counts': counts, 'command': spec['command'], 'cwd': spec['cwd']})
    return observations, proofs, hermetic_proofs


def verified_refresh_predecessors(root: Path, lock: dict) -> dict[str, str]:
    predecessors = lock.get("refreshPredecessors", {})
    if not isinstance(predecessors, dict):
        raise Blocked("refresh predecessor history is malformed")
    for name, digest in predecessors.items():
        if not re.fullmatch(r"baseline-lock-[0-9a-f]+\.json", name):
            raise Blocked("invalid refresh predecessor path")
        path = root / EVIDENCE_REL / name
        if path.is_symlink() or not path.is_file() or sha256_bytes(path.read_bytes()) != digest:
            raise Blocked("refresh predecessor evidence changed or disappeared")
        prior = load_json(path, "refresh predecessor")
        if (prior.get("schema") != LOCK_SCHEMA or prior.get("baseCommitSha") != lock.get("baseCommitSha")
                or prior.get("branch") != lock.get("branch")
                or not isinstance(prior.get("testFiles"), dict)
                or not set(prior["testFiles"]) < set(lock.get("testFiles", {}))):
            raise Blocked("refresh predecessor is not a matching strict input subset")
    return predecessors


def refresh_lock_source(root: Path, base_sha: str, before: dict, target: Path) -> Path:
    if target.is_file():
        return target
    candidates = []
    for path in (root / EVIDENCE_REL).glob("baseline-lock-*.json"):
        prior = load_json(path, "prior fail-first lock")
        if (prior.get("baseCommitSha") == base_sha and prior.get("branch") == current_branch(root)
                and isinstance(prior.get("testFiles"), dict) and set(prior["testFiles"]) < set(before)):
            candidates.append((len(prior["testFiles"]), path))
    if not candidates:
        raise Blocked("refresh requires an existing fail-first lock with the same inputs or a strict subset")
    largest = max(size for size, _ in candidates)
    matches = [path for size, path in candidates if size == largest]
    if len(matches) != 1:
        raise Blocked("refresh source lock is ambiguous")
    return matches[0]


def verify_prior_locks(root: Path, base_sha: str, before: dict[str, str], target: Path | None = None) -> None:
    """Adding an input must not unlock previously locked inputs on this branch/base."""
    superseded = set()
    for path in (root / EVIDENCE_REL).glob("baseline-lock-*.json"):
        superseded.update(verified_refresh_predecessors(root, load_json(path, "prior fail-first lock")))
    for previous in sorted((root / EVIDENCE_REL).glob("baseline-lock-*.json")):
        if previous == target:
            raise Blocked("fail-first lock already exists; do not replace it during implementation")
        if previous.name in superseded:
            continue
        old_lock = load_json(previous, "prior fail-first lock")
        if old_lock.get("branch", current_branch(root)) != current_branch(root):
            continue
        old_inputs = old_lock.get("testFiles")
        if isinstance(old_inputs, dict):
            drift = [name for name in LOCKED_TEST_GATE_CONFIGS if name in old_inputs and old_inputs[name] != before.get(name)]
            if drift:
                raise Blocked("test-gate configuration changed after fail-first lock: " + ", ".join(sorted(drift)))
        if old_lock.get("baseCommitSha") != base_sha:
            continue
        if not isinstance(old_inputs, dict):
            raise Blocked(f"prior fail-first lock is malformed: {previous.name}")
        removed = sorted(set(old_inputs) - set(before))
        changed = sorted(name for name in set(old_inputs) & set(before) if old_inputs[name] != before[name])
        if removed or changed:
            raise Blocked(f"test file(s) changed or removed after fail-first lock: {', '.join(removed + changed)}")


def refresh_control_additions(root: Path, previous: dict, before: dict, gate_rules: dict, config: dict) -> list[str]:
    old_hashes = previous["testFiles"]
    changed = [name for name in LOCKED_TEST_GATE_CONFIGS if old_hashes.get(name) != before.get(name)]
    if not changed:
        return []
    if changed != [".driver/test-gate.json"]:
        raise Blocked("refresh cannot change locked gate rules; only additive mutation contracts are supported")
    name = ".driver/test-gate.json"
    snapshots = previous.get("controlSnapshots", {})
    if not isinstance(snapshots, dict):
        raise Blocked("prior control snapshots are malformed")
    old_text = snapshots.get(name)
    if old_text is None:
        commit = previous.get("lockedAtCommitSha")
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise Blocked("prior control configuration is unavailable; preserve this attempt and start a fresh baseline")
        observed = run_git(root, "show", f"{commit}:{name}")
        if observed.returncode:
            raise Blocked("cannot recover prior locked control configuration")
        old_text = observed.stdout
    if not isinstance(old_text, str) or sha256_bytes(old_text.encode("utf-8")) != old_hashes.get(name):
        raise Blocked("prior control snapshot does not match its locked hash")
    old = json.loads(old_text)
    if not isinstance(old, dict):
        raise Blocked("prior control configuration is not an object")
    old_map, new_map = old.get("mutations", {}), config.get("mutations", {})
    if not isinstance(old_map, dict) or not isinstance(new_map, dict):
        raise Blocked("additive refresh requires keyed mutation maps")
    old_rest = {key: value for key, value in old.items() if key != "mutations"}
    new_rest = {key: value for key, value in config.items() if key != "mutations"}
    if old_rest != new_rest or any(new_map.get(key) != value for key, value in old_map.items()):
        raise Blocked("refresh may only add mutation contracts; existing entries, caps and other controls must remain unchanged")
    old_effective, new_effective = mutation_contracts(old), mutation_contracts(config)
    if any(new_effective.get(key) != value for key, value in old_effective.items()):
        raise Blocked("refresh cannot remove or replace an existing effective mutation contract")
    if (set(new_map) - set(old_map)) & set(old_effective):
        raise Blocked("refresh cannot shadow an existing legacy mutation contract")
    added = sorted(set(new_effective) - set(old_effective))
    if not added:
        raise Blocked("changed control configuration contains no additive mutation contracts")
    for key in added:
        mutation_command_spec(root, gate_rules, config, new_effective[key])
    return added


def baseline_lock(root: Path, gate_rules: dict, config: dict, base_ref: str, base_sha: str, commit_sha: str, tests: set[str], test_inputs: set[str], specs: list[dict], refresh_reason: str | None = None, *, refresh: bool = False) -> Path:
    if not tests:
        raise Blocked("fail-first requires at least one changed test file")
    findings = test_source_findings(root, tests)
    if findings:
        raise Blocked("; ".join(findings))
    before = test_hashes(root, test_inputs)
    control_snapshots = {name: (root / name).read_text(encoding="utf-8") for name in LOCKED_TEST_GATE_CONFIGS}
    if any(sha256_bytes(text.encode("utf-8")) != before.get(name) for name, text in control_snapshots.items()):
        raise Blocked("control configuration changed while preparing the baseline")
    if (json.loads(control_snapshots[".driver/gate-rules.json"]) != gate_rules
            or json.loads(control_snapshots[".driver/test-gate.json"]) != config):
        raise Blocked("loaded control configuration differs from the baseline inputs")
    target = lock_location(root, base_sha, test_inputs)
    previous = None
    previous_bytes = None
    identity = None
    added_contracts = []
    previous_target = target
    predecessors = {}
    if not refresh:
        verify_prior_locks(root, base_sha, before, target)
    else:
        previous_target = refresh_lock_source(root, base_sha, before, target)
        if previous_target.is_symlink():
            raise Blocked("refresh source lock must not be a symlink")
        previous_bytes = previous_target.read_bytes()
        previous = load_json(previous_target, "fail-first lock")
        predecessors = verified_refresh_predecessors(root, previous)
        old_hashes = previous.get('testFiles')
        if (previous.get('schema') != LOCK_SCHEMA or previous.get('baseCommitSha') != base_sha
                or previous.get('branch') != current_branch(root) or not isinstance(old_hashes, dict)
                or not set(old_hashes) <= set(before) or not all(isinstance(v, str) and re.fullmatch(r'[0-9a-f]{64}', v) for v in old_hashes.values())
                or not isinstance(previous.get('testCommands'), list) or not previous['testCommands']
                or not isinstance(previous.get('fixtureCorrections'), list) or not isinstance(previous.get('hermeticCorrections'), list)):
            raise Blocked('refresh requires a well-formed matching fail-first lock')
        added_contracts = refresh_control_additions(root, previous, before, gate_rules, config)
        if old_hashes == before:
            raise Blocked('refresh requires changed test or fixture hashes')
        for prior in sorted((root / EVIDENCE_REL).glob('baseline-lock-*.json')):
            if prior != previous_target and prior.name not in predecessors:
                other = load_json(prior, 'prior fail-first lock')
                if other.get('baseCommitSha') == base_sha and other.get('branch', current_branch(root)) == current_branch(root):
                    raise Blocked('refresh requires a single matching fail-first lock')
        identity = {'author': git_value(root, 'var', 'GIT_AUTHOR_IDENT'),
                    'committer': git_value(root, 'var', 'GIT_COMMITTER_IDENT'), 'hostname': socket.gethostname()}
    try:
        observations, proofs, hermetic_proofs = fixture_baseline_observations(root, base_sha, commit_sha, tests, specs)
    except GateFailure as error:
        if refresh:
            raise Blocked(f'refresh baseline was not proven: {error}') from error
        raise
    after = test_hashes(root, test_inputs)
    if before != after:
        raise Blocked("test files or test fixtures changed while the host was recording the fail-first baseline")

    require_fresh_anchor(root, gate_rules, commit_sha, base_ref)
    require_fresh_base(root, base_ref, base_sha=base_sha, commit_sha=commit_sha)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock = {
        "schema": LOCK_SCHEMA,
        "baseRef": base_ref,
        "baseCommitSha": base_sha,
        "branch": current_branch(root),
        "lockedAt": datetime.now(timezone.utc).isoformat(),
        "lockedAtCommitSha": commit_sha,
        "testFiles": before,
        "controlSnapshots": control_snapshots,
        "testCommands": observations,
        "fixtureCorrections": proofs,
        "hermeticCorrections": hermetic_proofs,
    }
    if refresh:
        if previous_target.is_symlink() or previous_target.read_bytes() != previous_bytes:
            raise Blocked("prior lock changed while refresh was running")
        if previous_target != target:
            if target.exists() or target.is_symlink():
                raise Blocked("expanded refresh target already exists")
            predecessors = {**predecessors, previous_target.name: sha256_bytes(previous_bytes)}
        lock["refreshPredecessors"] = predecessors
        record = {'kind': 'lock-refresh', 'phase': 'refresh', 'reason': refresh_reason.strip(),
                  'oldHashes': previous['testFiles'], 'newHashes': before, 'identity': identity,
                  'addedContracts': added_contracts, 'addedInputs': sorted(set(before) - set(previous['testFiles'])),
                  'commitSha': commit_sha, 'baseCommitSha': base_sha}
        lock['refresh'] = {**record, 'recordedAt': datetime.now(timezone.utc).isoformat()}
        prior_history = previous.get('refreshHistory', [previous['refresh']] if 'refresh' in previous else [])
        if not isinstance(prior_history, list) or not all(isinstance(item, dict) for item in prior_history):
            raise Blocked('prior refresh history is malformed')
        lock['refreshHistory'] = [*prior_history, lock['refresh']]
        temporary = target.with_name(f'{target.name}.{os.getpid()}.{time.time_ns()}.pending')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(lock, stream, sort_keys=True, indent=2)
            stream.write('\n')
        append_evidence(root, record)
        os.replace(temporary, target)
    else:
        try:
            with target.open("x", encoding="utf-8") as stream:
                json.dump(lock, stream, sort_keys=True, indent=2)
                stream.write("\n")
        except FileExistsError as error:
            raise Blocked("fail-first lock already exists; do not replace it during implementation") from error
    return target


def verify_lock(root: Path, base_sha: str, tests: set[str], test_inputs: set[str]) -> Path:
    _, current_tests, _, current_inputs = working_tree_paths(root, base_sha)
    if current_tests != tests or current_inputs != test_inputs:
        raise Blocked("changed test-file or fixture set differs from the fail-first lock")
    target = lock_location(root, base_sha, test_inputs)
    if not target.is_file():
        raise Blocked("no fail-first lock exists; run `make test-gate TEST_GATE_PHASE=baseline` before implementation")
    lock = load_json(target, "fail-first lock")
    verified_refresh_predecessors(root, lock)
    if lock.get("schema") != LOCK_SCHEMA or lock.get("baseCommitSha") != base_sha:
        raise Blocked("fail-first lock does not match the current base commit")
    locked_files = lock.get("testFiles")
    if not isinstance(locked_files, dict):
        raise Blocked("fail-first lock has no test-file hash map")
    current = test_hashes(root, test_inputs)
    if current.keys() != locked_files.keys():
        raise Blocked("changed test-file or fixture set differs from the fail-first lock")
    if current != locked_files:
        changed = sorted(name for name in current if current[name] != locked_files[name])
        raise Blocked(f"test file(s) changed after fail-first lock: {', '.join(changed)}")
    return target


def changed_code_mutation(root: Path, changed: set[str], base_sha: str) -> dict:
    """Choose a changed JS/TS comparison, shell group kill, or Python return mutant."""
    for name in sorted(changed):
        if not is_production_code_path(name) or not name.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx")):
            continue
        source = root / name
        if source.is_symlink() or not source.is_file():
            continue
        current = source.read_text(encoding="utf-8").splitlines(keepends=True)
        base = run_git(root, "show", f"{base_sha}:{name}")
        previous = base.stdout.splitlines(keepends=True) if base.returncode == 0 else []
        for kind, _, _, first, last in difflib.SequenceMatcher(a=previous, b=current, autojunk=False).get_opcodes():
            if kind == "equal":
                continue
            for index in range(first, last):
                line = current[index]
                if line.lstrip().startswith(("//", "*", "/*")):
                    continue
                match = re.search(r"\s(!==|===)\s", line)
                if match:
                    start = len(line[:match.start(1)].encode("utf-8"))
                    end = start + len(match.group(1))
                    replacement = "===" if match.group(1) == "!==" else "!=="
                    return {"path": name, "start": (index + 1, start),
                            "end": (index + 1, end), "replacement": replacement}
                if name.endswith((".ts", ".tsx")):
                    bound = re.search(r"\.slice\(\s*0\s*,\s*(\d+)\s*\)", line)
                    if bound:
                        start = len(line[:bound.start(1)].encode("utf-8"))
                        return {"path": name, "start": (index + 1, start),
                                "end": (index + 1, start + len(bound.group(1))),
                                "replacement": str(int(bound.group(1)) + 1)}
    for name in sorted(changed):
        if not is_production_code_path(name) or not name.endswith(".sh"):
            continue
        source = root / name
        if source.is_symlink() or not source.is_file():
            continue
        current = source.read_text(encoding="utf-8").splitlines(keepends=True)
        base = run_git(root, "show", f"{base_sha}:{name}")
        previous = base.stdout.splitlines(keepends=True) if base.returncode == 0 else []
        for kind, _, _, first, last in difflib.SequenceMatcher(a=previous, b=current, autojunk=False).get_opcodes():
            if kind == "equal":
                continue
            for index in range(first, last):
                line = current[index]
                if line.strip() in {'kill -KILL 0 2>/dev/null || true', 'kill -KILL "$PPID" 2>/dev/null || true'}:
                    replacement = ('kill -KILL "$PPID" 2>/dev/null || true; kill -KILL 0 2>/dev/null || true'
                                   if line.strip().startswith('kill -KILL 0 ') else ':')
                    return {"path": name, "start": (index + 1, 0),
                            "end": (index + 1, len(line.rstrip("\r\n").encode("utf-8"))),
                            "replacement": replacement}
    for name in sorted(changed):
        if not is_production_code_path(name) or not name.endswith(".py"):
            continue
        source = root / name
        if source.is_symlink() or not source.is_file():
            continue
        content = source.read_text(encoding="utf-8")
        tree = ast.parse(content, filename=name)
        returns = [node for node in ast.walk(tree) if isinstance(node, ast.Return) and node.value is not None]
        for node in returns:
            if isinstance(node.value, ast.Dict):
                for key, value in zip(node.value.keys, node.value.values):
                    if (isinstance(key, ast.Constant) and key.value == "outcome"
                            and isinstance(value, ast.Constant) and value.value == "blocked"):
                        return {"path": name, "start": (value.lineno, value.col_offset),
                                "end": (value.end_lineno, value.end_col_offset), "replacement": "'completed'"}
        for node in returns:
            before = ast.get_source_segment(content, node.value)
            if before and before != "None":
                return {"path": name, "start": (node.value.lineno, node.value.col_offset),
                        "end": (node.value.end_lineno, node.value.end_col_offset), "replacement": "None"}
    raise Blocked("no changed JavaScript comparison, shell group kill, or Python return can be mutated; add a focused mutation contract for this change")


def mutation_contracts(config: dict) -> dict:
    """Normalize current and legacy contracts; obsolete upstreamMutation is metadata only."""
    contracts = config.get("mutations", {})
    if not isinstance(contracts, dict):
        raise Blocked("mutations must be a map keyed by stable contract ids")
    contracts = dict(contracts)
    legacy = config.get("mutation")
    if legacy is not None:
        if not isinstance(legacy, dict):
            raise Blocked("mutation must be a legacy contract object")
        legacy_id = legacy.get("id", "spot-check")
        if not isinstance(legacy_id, str) or not legacy_id.strip():
            raise Blocked("legacy mutation id must be a nonempty string")
        contracts.setdefault(legacy_id, legacy)
    if not all(isinstance(key, str) and key.strip() and isinstance(value, dict) for key, value in contracts.items()):
        raise Blocked("mutations must contain contract objects under nonempty stable ids")
    return {key: {**value, "id": key} for key, value in contracts.items()}


def mutation_command_spec(root: Path, gate_rules: dict, config: dict, mutation: dict) -> dict:
    mutation_tests = mutation.get("testPaths")
    if not isinstance(mutation_tests, list) or not mutation_tests or not all(isinstance(name, str) for name in mutation_tests):
        raise Blocked("mutation.testPaths must name the focused suite that detects the mutant")
    if not all(safe_repo_path(name) and is_test_path(name) for name in mutation_tests):
        raise Blocked("mutation.testPaths must be safe repository test files")
    mutation_specs = command_specs(root, gate_rules, config, set(mutation_tests))
    if len(mutation_specs) != 1 or mutation_specs[0]["id"] != mutation.get("testCheckId"):
        raise Blocked("mutation must select one focused test command matching testCheckId")
    return mutation_specs[0]


def mutation_observation(root: Path, gate_rules: dict, config: dict, changed: set[str], tests: set[str], commit_sha: str, base_sha: str, passed_specs: list[dict] | None = None) -> list[dict]:
    contracts = mutation_contracts(config)
    if not contracts:
        return [single_mutation_observation(root, gate_rules, config, changed, tests, commit_sha, base_sha)]
    inputs = {".driver/test-gate.json", ".driver/gate-rules.json"}
    specs = {}
    environment = os.environ.copy()
    for key, contract in contracts.items():
        name = contract.get("path")
        if not isinstance(name, str) or not safe_repo_path(name):
            raise Blocked("mutation target must be a safe repository file")
        specs[key] = mutation_command_spec(root, gate_rules, config, contract)
        inputs.update([name, *contract["testPaths"]])
        if isinstance(contract.get("scriptEnv"), str):
            environment.pop(contract["scriptEnv"], None)
    if any(is_production_code_path(name) for name in changed):
        current = any(contract.get("path") in changed and isinstance(contract.get("testPaths"), list)
                      and contract["testPaths"] and all(isinstance(name, str) and name in tests for name in contract["testPaths"])
                      for contract in contracts.values())
        if not current:
            raise Blocked("changed production code has only inherited entries; add a focused mutation contract for this change")
    before = test_hashes(root, inputs)
    fingerprint = worktree_fingerprint(root, base_sha)

    def verify_contract_inputs() -> None:
        if test_hashes(root, inputs) != before or worktree_fingerprint(root, base_sha) != fingerprint:
            raise Blocked("contract inputs or worktree changed during mutation verification")

    passed = {(spec["cwd"], tuple(spec["command"])) for spec in passed_specs or []}
    heads = {}
    for key, spec in specs.items():
        identity = (spec["cwd"], tuple(spec["command"]))
        if identity not in passed:
            heads[key] = spec
            passed.add(identity)

    def head_job(key, spec):
        with ExitStack() as cleanup:
            snapshot = mutation_snapshot(root, base_sha, tests | set(spec['testFiles']), changed, cleanup)
            head = run_command(root, snapshot, {**spec, 'contractId': f'head:{key}'}, phase="mutation-head-tests", commit_sha=commit_sha, base_sha=base_sha,
                               expected="zero exit with at least one passing test on unmutated head", environment=environment)
            verify_contract_inputs()
            counts = validate_counts(head, spec, phase="unmutated head")
            if head["exitCode"] or counts["failures"] or counts["errors"] or counts["passed"] <= 0:
                raise GateFailure("configured mutation suite must pass on unmutated head")
            return head

    def mutant_job(key, contract):
        observation = single_mutation_observation(root, gate_rules, {**config, "mutation": contract}, changed, tests, commit_sha, base_sha)
        verify_mutation_attribution(root, contract, observation)
        verify_contract_inputs()
        return observation

    mutation_jobs(root, heads, head_job)
    return mutation_jobs(root, contracts, mutant_job)


def mutation_snapshot(root: Path, base_sha: str, tests: set[str], changed: set[str], cleanup: ExitStack) -> Path:
    snapshot = prepare_base_snapshot(root, base_sha, tests)
    cleanup.callback(shutil.rmtree, snapshot)
    for name in sorted(changed):
        source, target = root / name, snapshot / name
        if source.is_symlink():
            raise Blocked('changed linked inputs cannot be materialized as regular private files')
        if source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
            target.chmod(source.stat().st_mode & 0o777)
        elif not source.exists() and not source.is_symlink():
            if target.is_file() or target.is_symlink():
                target.unlink()
            elif target.exists():
                raise Blocked('deleted input is not a regular file in the private tree')
        else:
            raise Blocked('changed input is not a regular file in the private tree')
    # Worktree/index/refs are private; only immutable Git objects are shared.
    git_value(snapshot, 'init', '--quiet', '--template=')
    objects = Path(git_value(root, 'rev-parse', '--git-path', 'objects'))
    objects = objects if objects.is_absolute() else root / objects
    (snapshot / '.git/objects/info/alternates').write_text(str(objects.resolve()) + '\n')
    git_value(snapshot, 'update-ref', 'refs/heads/test-gate', current_commit(root))
    git_value(snapshot, 'symbolic-ref', 'HEAD', 'refs/heads/test-gate')
    git_value(snapshot, 'update-ref', 'refs/remotes/origin/main', base_sha)
    git_value(snapshot, 'read-tree', 'HEAD')
    origin = run_git(root, 'remote', 'get-url', 'origin')
    if origin.returncode == 0:
        git_value(snapshot, 'remote', 'add', 'origin', origin.stdout.strip())
    return snapshot


def verify_mutation_attribution(root: Path, contract: dict, observation: dict) -> None:
    content = (root / contract['path']).read_text(encoding='utf-8')
    digest = sha256_bytes(content.replace(contract['before'], contract['after'], 1).encode('utf-8'))
    record = observation['record']
    expected = (contract['id'], contract['path'], digest, observation['exitCode'])
    actual = (record.get('contractId'), record.get('mutationPath'), record.get('mutantSha256'), record.get('exitCode'))
    if actual != expected:
        raise Blocked('mutation result attribution mismatch')


def single_mutation_observation(root: Path, gate_rules: dict, config: dict, changed: set[str], tests: set[str], commit_sha: str, base_sha: str) -> dict:
    with ExitStack() as cleanup:
        return _single_mutation_observation(root, gate_rules, config, changed, tests, commit_sha, base_sha, cleanup)


def _single_mutation_observation(root: Path, gate_rules: dict, config: dict, changed: set[str], tests: set[str], commit_sha: str, base_sha: str, cleanup: ExitStack) -> dict:
    configured = config.get("mutation")
    if not isinstance(configured, dict):
        target = changed_code_mutation(root, changed, base_sha)
        name = target["path"]
        snapshot = prepare_base_snapshot(root, base_sha, tests)
        cleanup.callback(shutil.rmtree, snapshot)
        for path_name in sorted(changed):
            source = root / path_name
            if source.is_file() and not source.is_symlink():
                destination = snapshot / path_name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
        source = snapshot / name
        lines = source.read_bytes().splitlines(keepends=True)
        (start_line, start_col), (end_line, end_col) = target["start"], target["end"]
        prefix = lines[start_line - 1][:start_col]
        suffix = lines[end_line - 1][end_col:]
        lines[start_line - 1:end_line] = [prefix + target["replacement"].encode("utf-8") + suffix]
        mutated = b"".join(lines)
        source.write_bytes(mutated)
        specs = command_specs(root, gate_rules, config, tests)
        if not specs:
            raise Blocked("mutation needs a changed test suite")
        caught = False
        for spec in specs:
            observation = run_command(root, snapshot, {**spec, "mutantSha256": sha256_bytes(mutated)},
                                      phase="mutation-spot-check", commit_sha=commit_sha, base_sha=base_sha,
                                      expected="nonzero with assertion failures and zero errors", mutation_path=name)
            counts = validate_counts(observation, spec, phase="mutation spot-check")
            if counts["errors"]:
                raise Blocked("mutation run had errors; a runner crash is not a caught mutant")
            if observation["exitCode"] and counts["failures"]:
                if name.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx")) and not re.search(
                    r"\b(?:ERR_ASSERTION|AssertionError)\b", observation["output"]
                ):
                    raise Blocked("JavaScript mutation failed without an observed assertion failure")
                caught = True
                break
        if not caught:
            raise GateFailure("changed-code mutant survived the focused tests")
        return observation
    mutation = config.get("mutation")
    if not isinstance(mutation, dict):
        raise Blocked("test-gate configuration needs one mutation spot-check for this change")
    path_name = mutation.get("path")
    before = mutation.get("before")
    after = mutation.get("after")
    check_id = mutation.get("testCheckId")
    env_name = mutation.get("scriptEnv")
    reason = mutation.get("reason")
    if not all(isinstance(value, str) and value.strip() for value in (path_name, before, after, check_id, reason)):
        raise Blocked("mutation needs path, exact before/after text, testCheckId, and a why note")
    if not is_production_code_path(path_name) and not isinstance(env_name, str):
        raise Blocked("non-code mutation needs scriptEnv")
    if not safe_repo_path(path_name):
        raise Blocked("mutation target must be a safe repository file")
    source = root / path_name
    if source.is_symlink() or not source.is_file():
        raise Blocked("mutation target is missing or linked")
    content = source.read_text(encoding="utf-8")
    if content.count(before) != 1 or before == after:
        raise Blocked("mutation text must match exactly once and change the target")
    test_spec = mutation_command_spec(root, gate_rules, config, mutation)
    mutation_tests = mutation["testPaths"]
    if env_name is not None and not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", env_name):
        raise Blocked("mutation scriptEnv must be an uppercase environment variable name")
    mutated = content.replace(before, after, 1).encode("utf-8")
    digest = sha256_bytes(mutated)
    snapshot = mutation_snapshot(root, base_sha, tests | set(mutation_tests), changed, cleanup)
    mutant_path = snapshot / path_name
    mutant_path.write_bytes(mutated)
    spec = {
        "id": f"mutation:{mutation.get('id', 'spot-check')}",
        "contractId": mutation.get("id", "spot-check"),
        "command": test_spec["command"],
        "cwd": test_spec["cwd"],
        "testFiles": test_spec.get("testFiles", []),
        "rationale": test_spec["rationale"],
        "maxObservedTests": test_spec["maxObservedTests"],
        "timeoutSeconds": test_spec["timeoutSeconds"],
        "mutantSha256": digest,
    }
    environment = os.environ.copy()
    if env_name is not None:
        environment[env_name] = str(mutant_path)
    observation = run_command(
        root,
        snapshot,
        spec,
        phase="mutation-spot-check",
        commit_sha=commit_sha,
        base_sha=base_sha,
        expected="nonzero with assertion failures and zero errors",
        environment=environment,
        mutation_path=path_name,
    )
    counts = validate_counts(observation, spec, phase="mutation spot-check")
    if observation["exitCode"] == 0:
        raise GateFailure(f"suite passed with the configured mutation ({counts['tests']} tests); the mutant survived")
    if counts["errors"]:
        raise Blocked(f"mutation run had {counts['errors']} errors; a runner crash is not a caught mutant")
    if counts["failures"] == 0:
        raise Blocked("mutation command exited nonzero without a reported test failure")
    observation["reason"] = reason.strip()
    return observation


def change_only_warning(root: Path, kind: str = "config-only") -> str:
    """Report the proof limitation without making annotation delivery a gate."""
    warning = ("test-only: head tests passed; fail-first and mutation proof are not required" if kind == "test-only"
               else "config-only: no mutation contract; relies on real pipeline run")
    print(f"WARNING [test-gate]: {warning}")
    checkout = os.environ.get("BUILDKITE_BUILD_CHECKOUT_PATH")
    if os.environ.get("BUILDKITE") and checkout and root.resolve() == Path(checkout).resolve():
        try:
            subprocess.run(
                ["buildkite-agent", "annotate", "--style", "warning", "--context", f"test-gate-{kind}", warning],
                cwd=root, capture_output=True, text=True, check=True, timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            print("WARNING [test-gate]: could not publish Buildkite annotation; see warning above.")
    return warning


def select_mutation_contracts(config: dict, changed: set[str], mode: str) -> dict:
    """Uncertain mappings and edits to proof inputs always select the full registry."""
    if mode not in {'all', 'affected'}:
        raise Blocked('mutation mode must be all or affected')
    contracts = mutation_contracts(config)
    valid_mapping = all(isinstance(contract.get('path'), str) and safe_repo_path(contract['path'])
                        and isinstance(contract.get('testPaths'), list) and contract['testPaths']
                        and all(isinstance(name, str) and safe_repo_path(name) for name in contract['testPaths'])
                        for contract in contracts.values())
    mapped = {name for contract in contracts.values() for name in [contract['path'], *contract['testPaths']]} if valid_mapping else set()
    gate_inputs = {'Makefile', 'scripts/gate.py', 'scripts/test_gate_runner.py',
                   'scripts/ci_install.py', 'scripts/model_negative_controls.mjs', 'scripts/review_preflight.mjs'}
    proof_change = not valid_mapping or any(is_test_path(name) or name in gate_inputs
        or set(PurePosixPath(name).parts) & {'tests', 'test', '__tests__', 'fixtures'}
        or name.startswith(('.driver/', '.buildkite/', 'config/model-negative-controls', 'scripts/review_', 'lib/model-fidelity/', 'docs/design/'))
        or 'gate' in PurePosixPath(name).stem
        or (name.startswith('scripts/') and 'test' in PurePosixPath(name).stem) for name in changed)
    full = mode == 'all' or proof_change or bool(changed - mapped)
    selected = contracts if full else {key: contract for key, contract in contracts.items() if contract['path'] in changed or set(contract['testPaths']) & changed}
    reason = 'explicit-full' if mode == 'all' else 'proof-input-change' if proof_change else 'unmapped-file' if changed - mapped else 'mapped-targets'
    return {**{key: value for key, value in config.items() if key != 'mutation'},
            'mutations': selected, 'mutationSelection': {'mode': mode, 'reason': reason, 'available': len(contracts), 'selected': len(selected)}}


def run_test_gate(root: Path, phase: str, base_override: str | None, commit_sha: str, reason: str | None = None, mutation_mode: str = 'all') -> dict:
    gate_rules, config = load_rules(root)
    requested_base = base_override or gate_rules.get('baseRef')
    if not isinstance(requested_base, str) or not requested_base or requested_base.startswith('-'):
        raise Blocked('base ref is missing or invalid')
    require_fresh_anchor(root, gate_rules, commit_sha, requested_base)
    base_ref, base_sha = resolve_base(root, gate_rules, base_override)
    paths, tests, code, test_inputs = working_tree_paths(root, base_sha)
    if phase == 'refresh':
        if not reason or not reason.strip():
            raise Blocked('refresh requires a nonempty reason')
        if not tests:
            raise Blocked('refresh requires changed tests and an existing fail-first lock')
        specs = command_specs(root, gate_rules, config, tests)
        lock = baseline_lock(root, gate_rules, config, base_ref, base_sha, commit_sha, tests, test_inputs, specs, reason, refresh=True)
        return {'status': 'pass', 'phase': phase, 'reason': 'Fail-first lock refreshed; run the normal check and make gate.',
                'commitSha': commit_sha, 'baseCommitSha': base_sha, 'lockPath': str(lock.relative_to(root))}
    # Keep the exact loaded configuration for baseline/control-lock comparison.
    # Selection is execution metadata, never a replacement for the locked inputs.
    selected_config = select_mutation_contracts(config, paths, mutation_mode) if phase == 'check' else config
    if not paths and not (phase == "check" and mutation_mode == "all" and mutation_contracts(config)):
        return {
            "status": "pass",
            "phase": phase,
            "reason": "No changed test or code files; no test count or pass rate is claimed.",
            "commitSha": commit_sha,
            "baseCommitSha": base_sha,
            "testsObserved": None,
        }
    if not tests:
        if any(is_test_support_path(name) for name in paths):
            raise Blocked('fixture correction requires a changed test specification')
        if code:
            raise Blocked(f"changed code has no changed tests: {', '.join(sorted(code))}")
        if mutation_contracts(selected_config):
            observations = mutation_observation(root, gate_rules, selected_config, paths, tests, commit_sha, base_sha)
            return {
                "status": "pass", "phase": phase,
                "reason": "Inherited mutation contracts passed; no changed-test count or fail-first proof is claimed.",
                "commitSha": commit_sha, "baseCommitSha": base_sha,
                "mutationPaths": [item["record"]["mutationPath"] for item in observations], "mutationCaught": True,
                "mutationSelection": selected_config.get("mutationSelection"),
            }
        return {
            "status": "pass",
            "phase": phase,
            "reason": change_only_warning(root) + "; no test count or pass rate is claimed.",
            "commitSha": commit_sha,
            "baseCommitSha": base_sha,
            "testsObserved": None,
        }
    findings = test_source_findings(root, tests)
    if findings:
        raise Blocked("; ".join(findings))
    specs = command_specs(root, gate_rules, config, tests)

    if phase == "baseline":
        lock = baseline_lock(root, gate_rules, config, base_ref, base_sha, commit_sha, tests, test_inputs, specs)
        return {
            "status": "pass",
            "phase": "baseline",
            "reason": "Host-observed test failures on base were recorded and the test-file hashes are locked.",
            "commitSha": commit_sha,
            "baseCommitSha": base_sha,
            "lockedTestFiles": sorted(tests),
            "lockPath": str(lock.relative_to(root)),
        }

    lock = lock_location(root, base_sha, test_inputs)
    if lock.is_file():
        verify_lock(root, base_sha, tests, test_inputs)
        locked = load_json(lock, 'fail-first lock')
        _, fresh_proofs, fresh_hermetic = fixture_baseline_observations(root, base_sha, commit_sha, tests, specs)
        old_proofs = locked.get('fixtureCorrections')
        if not isinstance(old_proofs, list) or [(p['checkId'], p['fixtureHashes']) for p in fresh_proofs] != [
                (p.get('checkId'), p.get('fixtureHashes')) for p in old_proofs if isinstance(p, dict)]:
            raise Blocked('fixture correction proof missing or inconsistent with host contrast runs')
        old_hermetic = locked.get('hermeticCorrections')
        if not isinstance(old_hermetic, list) or [(p['checkId'], p['testHashes'], p['baseObservation']['testCounts']) for p in fresh_hermetic] != [
                (p.get('checkId'), p.get('testHashes'), p.get('baseObservation', {}).get('testCounts'))
                for p in old_hermetic if isinstance(p, dict)]:
            raise Blocked('hermetic correction proof missing or inconsistent with host contrast runs')
    elif code:
        lock = baseline_lock(root, gate_rules, config, base_ref, base_sha, commit_sha, tests, test_inputs, specs)
    else:
        verify_prior_locks(root, base_sha, test_hashes(root, test_inputs))
        lock = None

    before = test_hashes(root, test_inputs)

    def verify_inputs() -> None:
        if lock is not None:
            verify_lock(root, base_sha, tests, test_inputs)
        if not code:
            _, current_tests, current_code, current_inputs = working_tree_paths(root, base_sha)
            if (current_code or current_tests != tests or current_inputs != test_inputs
                    or test_hashes(root, test_inputs) != before):
                raise Blocked("test-only inputs or production source changed during the test run")

    for spec in specs:
        observation = run_command(
            root,
            root,
            spec,
            phase="implementation-tests",
            commit_sha=commit_sha,
            base_sha=base_sha,
            expected="zero exit with at least one passing test",
        )
        verify_inputs()
        counts = validate_counts(observation, spec, phase="implementation test run")
        if observation["exitCode"] != 0 or counts["failures"] or counts["errors"]:
            raise GateFailure(f"implementation tests failed: {spec['id']} exited {observation['exitCode']}")
        if counts["passed"] <= 0:
            raise Blocked(f"{spec['id']}: no passing tests were observed")

    reason = change_only_warning(root, "test-only") if not code else "Fail-first lock, read-only test diff, host counts, implementation tests, and mutation spot-check passed."
    mutation_details = {}
    if code or mutation_contracts(selected_config):
        mutation_result = mutation_observation(root, gate_rules, selected_config, paths, tests, commit_sha, base_sha, passed_specs=specs)
        mutation_details = {"mutationPath": mutation_result[-1]["record"]["mutationPath"],
                            "mutationPaths": [item["record"]["mutationPath"] for item in mutation_result],
                            "mutationCaught": True}
    verify_inputs()
    return {
        "status": "pass",
        "phase": "check",
        "reason": reason,
        "commitSha": commit_sha,
        "baseCommitSha": base_sha,
        "testFiles": sorted(tests),
        **mutation_details,
        "mutationSelection": selected_config.get("mutationSelection"),
        **({"lockPath": str(lock.relative_to(root))} if lock is not None else {}),
    }


def main(argv: list[str] | None = None) -> int:
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="repository root (defaults to this script's repository)")
    args.add_argument("--phase", choices=("baseline", "check", "refresh"), default="check")
    args.add_argument("--mutations", choices=("all", "affected"), default="all", help="full registry, or fail-safe PR target selection; proof-input edits always run all")
    args.add_argument("--reason", help="required explanation for a lock refresh")
    args.add_argument("--base", help="comparison revision only; configured live freshness anchor remains required")
    options = args.parse_args(argv)
    root = options.root.resolve()
    started = time.monotonic()
    commit_sha = None
    status = "error"
    reason = "test-gate did not complete"
    exit_code = 2
    result = None
    try:
        commit_sha = current_commit(root)
        result = run_test_gate(root, options.phase, options.base, commit_sha, options.reason, options.mutations)
        status = result["status"]
        reason = result["reason"]
        exit_code = 0
    except GateFailure as error:
        status = "fail"
        reason = str(error)
        exit_code = 1
    except Blocked as error:
        status = "blocked"
        reason = str(error)
        exit_code = BLOCKED_EXIT
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError, tarfile.TarError) as error:
        status = "error"
        reason = f"host runner error: {error}"
        exit_code = 2
    elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
    command = sys.argv if argv is None else ["python3", "scripts/test_gate_runner.py", *argv]
    try:
        append_evidence(
            root,
            {
                "phase": options.phase,
                "kind": "result",
                "command": shlex.join(command),
                "argv": command,
                "exitCode": exit_code,
                "commitSha": commit_sha,
                "baseCommitSha": result.get("baseCommitSha") if result else None,
                "elapsedMs": elapsed_ms,
                "status": status,
                "reason": reason,
            },
        )
    except OSError as error:
        print(f"TEST_GATE_RESULT {json.dumps({'schema': RESULT_SCHEMA, 'status': 'error', 'reason': f'cannot record host evidence: {error}', 'exitCode': 2})}")
        return 2
    payload = {
        "schema": RESULT_SCHEMA,
        "status": status,
        "phase": options.phase,
        "reason": reason,
        "exitCode": exit_code,
        "commitSha": commit_sha,
        "elapsedMs": elapsed_ms,
    }
    if result:
        payload.update({key: value for key, value in result.items() if key not in {"status", "phase", "reason", "commitSha"}})
    prefix = "PASS" if status == "pass" else "BLOCKED" if status == "blocked" else "FAIL" if status == "fail" else "ERROR"
    print(f"{prefix} [test-gate]: {reason}")
    print("TEST_GATE_RESULT " + json.dumps(payload, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
