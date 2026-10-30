#!/usr/bin/env python3
"""Host-run fail-first, test-diff, mutation, and evidence checks beside make gate."""

from __future__ import annotations

import argparse
import ast
import difflib
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

DEFAULT_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_REL = Path(".driver/test-gate-evidence")
LOCK_SCHEMA = "driver-test-gate-lock.v1"
EVIDENCE_SCHEMA = "driver-test-gate-evidence.v1"
RESULT_SCHEMA = "driver-test-gate-result.v1"
BLOCKED_EXIT = 3
MAX_OBSERVED_TESTS = 10_000
MAX_COMMAND_SECONDS = 300
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
    node_tests = re.search(r"(?m)^# tests\s+(\d+)\s*$", output)
    if node_tests:
        def node_count(label: str) -> int:
            match = re.search(rf"(?m)^# {label}\s+(\d+)\s*$", output)
            return int(match.group(1)) if match else 0

        total = int(node_tests.group(1))
        failures = node_count("fail")
        skipped = node_count("skipped")
        return {
            "tests": total,
            "failures": failures,
            "errors": 0,
            "skipped": skipped,
            "cancelled": node_count("cancelled"),
            "todo": node_count("todo"),
            "passed": node_count("pass"),
        }

    unittest_total = re.search(r"(?m)^Ran\s+(\d+)\s+tests?\b", output)
    if unittest_total:
        summary = re.search(r"(?:FAILED|OK)\s*\(([^)]*)\)", output)
        details = summary.group(1) if summary else ""
        failures = int((re.search(r"failures=(\d+)", details) or [None, "0"])[1])
        errors = int((re.search(r"errors=(\d+)", details) or [None, "0"])[1])
        skipped = int((re.search(r"skipped=(\d+)", details) or [None, "0"])[1])
        total = int(unittest_total.group(1))
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
        stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


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
    timed_out = False
    process_environment = dict(os.environ if environment is None else environment)
    process_environment["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=process_environment,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout_seconds,
        )
        output = (result.stdout or "") + (result.stderr or "")
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
    elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
    print(f"RUN [{phase}]: {shlex.join(command)} (cwd={cwd_rel})", flush=True)
    if timed_out:
        print(f"TIMEOUT [{phase}]: exceeded {timeout_seconds:g}s", flush=True)
    if output:
        print(output, end="" if output.endswith("\n") else "\n", flush=True)
    counts = parse_test_counts(output)
    input_hashes = {}
    for name in spec.get("testFiles", []):
        input_path = execute_root / name
        if input_path.is_file() and not input_path.is_symlink():
            input_hashes[name] = sha256_bytes(input_path.read_bytes())
    record = {
        "phase": phase,
        "command": shlex.join(command),
        "argv": command,
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
        "mutationPath": mutation_path,
        "mutantSha256": spec.get("mutantSha256"),
        "outputSha256": sha256_bytes(output.encode("utf-8", errors="replace")),
    }
    append_evidence(evidence_root, record)
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
        overlay.update(changed_test_support_paths(root))
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


def baseline_lock(root: Path, gate_rules: dict, config: dict, base_ref: str, base_sha: str, commit_sha: str, tests: set[str], test_inputs: set[str], specs: list[dict]) -> Path:
    if not tests:
        raise Blocked("fail-first requires at least one changed test file")
    findings = test_source_findings(root, tests)
    if findings:
        raise Blocked("; ".join(findings))
    before = test_hashes(root, test_inputs)
    target = lock_location(root, base_sha, test_inputs)
    for previous in sorted((root / EVIDENCE_REL).glob("baseline-lock-*.json")):
        if previous == target:
            raise Blocked("fail-first lock already exists; do not replace it during implementation")
        old_lock = load_json(previous, "prior fail-first lock")
        if old_lock.get("baseCommitSha") != base_sha or old_lock.get("branch", current_branch(root)) != current_branch(root):
            continue
        old_inputs = old_lock.get("testFiles")
        if not isinstance(old_inputs, dict):
            raise Blocked(f"prior fail-first lock is malformed: {previous.name}")
        removed = sorted(set(old_inputs) - set(before))
        changed = sorted(name for name in set(old_inputs) & set(before) if old_inputs[name] != before[name])
        if removed or changed:
            raise Blocked(f"test file(s) changed or removed after fail-first lock: {', '.join(removed + changed)}")
    snapshot = prepare_base_snapshot(root, base_sha, tests)
    observations = []
    for spec in specs:
        observation = run_command(
            root,
            snapshot,
            spec,
            phase="fail-first-base",
            commit_sha=commit_sha,
            base_sha=base_sha,
            expected="nonzero with assertion failures and zero errors",
            environment={key: value for key, value in os.environ.items() if key != "TEST_GATE_SCRIPT"},
        )
        counts = validate_counts(observation, spec, phase="fail-first")
        if observation["exitCode"] == 0:
            raise GateFailure(f"new tests passed on the base commit ({counts['tests']} tests, zero failures)")
        if counts["errors"]:
            raise Blocked(f"fail-first command had {counts['errors']} errors; a crash is not proof that assertions fail")
        if counts["failures"] == 0:
            raise Blocked("fail-first command exited nonzero without a reported test failure")
        observations.append({"checkId": spec["id"], "counts": counts, "command": spec["command"], "cwd": spec["cwd"]})
    after = test_hashes(root, test_inputs)
    if before != after:
        raise Blocked("test files or test fixtures changed while the host was recording the fail-first baseline")

    target.parent.mkdir(parents=True, exist_ok=True)
    lock = {
        "schema": LOCK_SCHEMA,
        "baseRef": base_ref,
        "baseCommitSha": base_sha,
        "branch": current_branch(root),
        "lockedAt": datetime.now(timezone.utc).isoformat(),
        "lockedAtCommitSha": commit_sha,
        "testFiles": before,
        "testCommands": observations,
    }
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
    """Choose a changed JS comparison, or retain the existing Python return mutant."""
    for name in sorted(changed):
        if not is_production_code_path(name) or not name.endswith((".js", ".mjs", ".cjs")):
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
    raise Blocked("no changed JavaScript comparison or Python return can be mutated; add a focused mutation contract for this change")


def mutation_observation(root: Path, gate_rules: dict, config: dict, changed: set[str], tests: set[str], commit_sha: str, base_sha: str) -> dict:
    configured = config.get("mutation")
    if not isinstance(configured, dict) or configured.get("path") not in changed:
        target = changed_code_mutation(root, changed, base_sha)
        name = target["path"]
        snapshot = prepare_base_snapshot(root, base_sha, tests)
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
                if name.endswith((".js", ".mjs", ".cjs")) and not re.search(
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
    if not all(isinstance(value, str) and value.strip() for value in (path_name, before, after, check_id, env_name, reason)):
        raise Blocked("mutation needs path, exact before/after text, testCheckId, scriptEnv, and a why note")
    if not safe_repo_path(path_name) or path_name not in changed:
        raise Blocked("mutation target must be a changed repository file in this diff")
    source = root / path_name
    if source.is_symlink() or not source.is_file():
        raise Blocked("mutation target is missing or linked")
    content = source.read_text(encoding="utf-8")
    if content.count(before) != 1 or before == after:
        raise Blocked("mutation text must match exactly once and change the target")
    mutation_tests = mutation.get("testPaths")
    if not isinstance(mutation_tests, list) or not mutation_tests or not all(isinstance(name, str) for name in mutation_tests):
        raise Blocked("mutation.testPaths must name the focused suite that detects the mutant")
    if not set(mutation_tests).issubset(changed) or not all(is_test_path(name) for name in mutation_tests):
        raise Blocked("mutation.testPaths must be changed test files from this diff")
    mutation_specs = command_specs(root, gate_rules, config, set(mutation_tests))
    if len(mutation_specs) != 1 or mutation_specs[0]["id"] != check_id:
        raise Blocked("mutation must select one focused test command matching testCheckId")
    test_spec = mutation_specs[0]
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", env_name):
        raise Blocked("mutation scriptEnv must be an uppercase environment variable name")
    mutated = content.replace(before, after, 1).encode("utf-8")
    digest = sha256_bytes(mutated)
    mutant_path = root / EVIDENCE_REL / "mutants" / digest / Path(path_name).name
    mutant_path.parent.mkdir(parents=True, exist_ok=True)
    if not mutant_path.exists():
        mutant_path.write_bytes(mutated)
    spec = {
        "id": f"mutation:{mutation.get('id', 'spot-check')}",
        "command": test_spec["command"],
        "cwd": test_spec["cwd"],
        "testFiles": test_spec.get("testFiles", []),
        "rationale": test_spec["rationale"],
        "maxObservedTests": test_spec["maxObservedTests"],
        "timeoutSeconds": test_spec["timeoutSeconds"],
        "mutantSha256": digest,
    }
    environment = os.environ.copy()
    environment[env_name] = str(mutant_path)
    observation = run_command(
        root,
        root,
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


def run_test_gate(root: Path, phase: str, base_override: str | None, commit_sha: str) -> dict:
    gate_rules, config = load_rules(root)
    base_ref, base_sha = resolve_base(root, gate_rules, base_override)
    paths, tests, code, test_inputs = working_tree_paths(root, base_sha)
    if not paths:
        return {
            "status": "pass",
            "phase": phase,
            "reason": "No changed test or code files; no test count or pass rate is claimed.",
            "commitSha": commit_sha,
            "baseCommitSha": base_sha,
            "testsObserved": None,
        }
    if not tests:
        if code:
            raise Blocked(f"changed code has no changed tests: {', '.join(sorted(code))}")
        return {
            "status": "pass",
            "phase": phase,
            "reason": "Documentation or non-code changes only; no test count or pass rate is claimed.",
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
    else:
        lock = baseline_lock(root, gate_rules, config, base_ref, base_sha, commit_sha, tests, test_inputs, specs)

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
        verify_lock(root, base_sha, tests, test_inputs)
        counts = validate_counts(observation, spec, phase="implementation test run")
        if observation["exitCode"] != 0 or counts["failures"] or counts["errors"]:
            raise GateFailure(f"implementation tests failed: {spec['id']} exited {observation['exitCode']}")
        if counts["passed"] <= 0:
            raise Blocked(f"{spec['id']}: no passing tests were observed")

    mutation_result = mutation_observation(root, gate_rules, config, paths, tests, commit_sha, base_sha)
    verify_lock(root, base_sha, tests, test_inputs)
    return {
        "status": "pass",
        "phase": "check",
        "reason": "Fail-first lock, read-only test diff, host counts, implementation tests, and mutation spot-check passed.",
        "commitSha": commit_sha,
        "baseCommitSha": base_sha,
        "testFiles": sorted(tests),
        "mutationPath": mutation_result["record"]["mutationPath"],
        "mutationCaught": True,
        "lockPath": str(lock.relative_to(root)),
    }


def main(argv: list[str] | None = None) -> int:
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="repository root (defaults to this script's repository)")
    args.add_argument("--phase", choices=("baseline", "check"), default="check")
    args.add_argument("--base", help="override the baseRef from .driver/gate-rules.json")
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
        result = run_test_gate(root, options.phase, options.base, commit_sha)
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
