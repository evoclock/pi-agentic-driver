#!/usr/bin/env python3
"""Run the repository's shared, rules-driven local and Buildkite gate."""

from __future__ import annotations

import hashlib
import argparse
import fcntl
import signal
from contextlib import contextmanager
import json
import os
import re
import shlex
import shutil
import math
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / ".driver/gate-rules.json"
NATIVE_BUDGET_SECONDS = 2400
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


def runtime_headroom_findings(step: str, elapsed: float | None, cap: float) -> list[str]:
    if not isinstance(elapsed, (int, float)) or isinstance(elapsed, bool) or not math.isfinite(elapsed) or elapsed < 0:
        return [f"{step}: missing or invalid recorded runtime; an observed runtime is required"]
    if not isinstance(cap, (int, float)) or isinstance(cap, bool) or not math.isfinite(cap) or cap <= 0:
        return [f"{step}: invalid runtime cap"]
    if elapsed > cap * 0.75:
        return [f"{step}: last runtime {elapsed:.3f}s / cap {cap:.3f}s leaves {(cap - elapsed) / cap:.1%} headroom; require 25%; use the reviewed cap/configuration transition, never edit a baseline lock"]
    return []


def required_tool_findings(tools: list[str], which=shutil.which) -> list[str]:
    return [f"required tool missing: {name}" for name in sorted(set(tools)) if not which(name)]


def lock_wait_findings(holder: dict, position: int, now: float) -> list[str]:
    if not holder.get("holder") or not isinstance(holder.get("started"), (int, float)) or not isinstance(holder.get("cap"), (int, float)):
        return ["gate lock holder/start/cap unavailable; cannot estimate wait"]
    if position < 1 or holder["cap"] <= 0 or now < holder["started"] or now - holder["started"] >= holder["cap"]:
        return ["gate lock queue position invalid or holder runtime expired; do not steal the lock"]
    return []


def resolve_java_tlc(env=None, home: Path | None = None) -> tuple[str, str]:
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    candidates = [env.get("JAVA"), str(home / ".local/bin/java"), "/opt/homebrew/opt/openjdk/bin/java", "java"]
    java = None
    for candidate in dict.fromkeys(filter(None, candidates)):
        try:
            subprocess.run([candidate, "-version"], env=env, capture_output=True, timeout=10, check=True)
            java = candidate
            break
        except (OSError, subprocess.SubprocessError):
            continue
    if java is None:
        raise ValueError("Working Java required (macOS /usr/bin/java may be a stub). Set JAVA=/opt/homebrew/opt/openjdk/bin/java or link that runtime at ~/.local/bin/java; install a JDK if neither exists.")
    jar = env.get("TLA2TOOLS") or env.get("TLA2TOOLS_JAR") or str(home / ".local/share/tlc/tla2tools.jar")
    if not Path(jar).is_file():
        raise ValueError("TLC required: set TLA2TOOLS to an existing tla2tools.jar or place it at ~/.local/share/tlc/tla2tools.jar")
    return java, jar


def preflight_findings(root: Path, rules: dict) -> list[str]:
    # Consume the upstream #230 roster instead of maintaining a second list.
    tools = ["node"]
    if is_buildkite() and sys.platform.startswith("linux"):
        tools += ["docker", "buildkite-agent", "sha256sum", "head", "tee", "cmp", "env", "timeout"]
    findings = required_tool_findings(tools, lambda name: shutil.which(name, path=os.environ.get("PATH")) if "/" not in name else (name if os.access(root / name, os.X_OK) else None))
    if not findings:
        try:
            result = subprocess.run(["node", str(root / "scripts/review_gate_tools.mjs")], cwd=root, capture_output=True, text=True, timeout=10, check=False)
            if result.returncode:
                findings.append(result.stderr.strip() or "upstream required-tool preflight failed")
        except (OSError, subprocess.SubprocessError) as error:
            findings.append(f"upstream required-tool preflight unavailable: {error}")
        try:
            java, jar = resolve_java_tlc()
            os.environ.update(JAVA=java, TLA2TOOLS=jar)
        except ValueError as error:
            findings.append(str(error))
        for name in ("tsc", "tsx"):
            executable = root / "janus/node_modules/.bin" / name
            try:
                subprocess.run([str(executable), "--version"], capture_output=True, timeout=10, check=True)
            except (OSError, subprocess.SubprocessError):
                findings.append(f"required Janus tool is not runnable: {name}")
    history = root / ".driver/test-gate-evidence/shared-runtimes.jsonl"
    latest = {}
    if history.exists():
        for line in history.read_text().splitlines():
            item = json.loads(line)
            latest[item["step"]] = item
    for step, item in latest.items():
        cap = NATIVE_BUDGET_SECONDS if step.startswith("native-") else (1800 if step == "prepush-total" else rules["speedBudgetSeconds"])
        findings += runtime_headroom_findings(step, item.get("elapsed"), cap)
    return findings


def read_lock_record(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def record_runtime(root: Path, step: str, elapsed: float) -> None:
    history = root / ".driver/test-gate-evidence/shared-runtimes.jsonl"
    history.parent.mkdir(parents=True, exist_ok=True)
    with history.open("a") as stream:
        stream.write(json.dumps({"step": step, "elapsed": elapsed, "recordedAt": time.time()}) + "\n")


@contextmanager
def queue_registration(area: Path, metadata: dict):
    area.mkdir(parents=True, exist_ok=True)
    with (area / ".admission").open("a+") as admission:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(admission, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError("gate queue registration unavailable after 5s; not waiting invisibly")
                time.sleep(0.05)
        try:
            counter = area / ".sequence"
            sequence = int(counter.read_text()) + 1 if counter.exists() else 1
            counter.write_text(str(sequence))
            ticket = area / f"ticket-{sequence:020d}.json"
            pending = area / f".pending-{os.getpid()}-{time.time_ns()}"
            pending.write_text(json.dumps(metadata))
            os.replace(pending, ticket)
        finally:
            fcntl.flock(admission, fcntl.LOCK_UN)
    try:
        yield ticket
    finally:
        ticket.unlink(missing_ok=True)


def queue_position(area: Path, ticket: Path) -> int:
    return sorted(area.glob("ticket-*.json")).index(ticket) + 1


def owned_group_exists(group: int) -> bool:
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can report EPERM for a group containing only unreaped zombies.
        return True


def signal_owned_group(group: int, signum: int) -> None:
    try:
        os.killpg(group, signum)
    except (ProcessLookupError, PermissionError):
        # Still require disappearance below; a signal error never grants release.
        pass


def terminate_owned_group(process: subprocess.Popen) -> None:
    signal_owned_group(process.pid, signal.SIGTERM)
    deadline = time.monotonic() + 2
    while owned_group_exists(process.pid) and time.monotonic() < deadline:
        process.poll()
        time.sleep(0.02)
    if owned_group_exists(process.pid):
        signal_owned_group(process.pid, signal.SIGKILL)
    process.wait()
    # Admission stays owned until descendants, not just the leader, are gone.
    while owned_group_exists(process.pid):
        time.sleep(0.02)


def run_bounded(command: list[str], cap: float) -> int:
    process = subprocess.Popen(command, start_new_session=True)
    try:
        return process.wait(timeout=cap)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        print(f"BLOCKED [gate-runtime]: holder cap {cap}s reached or interrupted; terminating owned process group", flush=True)
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
        try:
            terminate_owned_group(process)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)
        return 3


@contextmanager
def observable_gate_lock(root: Path, cap: float):
    common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=root, capture_output=True, text=True, check=True, timeout=10).stdout.strip()
    common_path = (root / common).resolve()
    locks = common_path.parent / ".local/locks"
    lock = locks / "test-gate.lock"
    queue = locks / "test-gate.queue"
    metadata = {"holder": os.environ.get("PAD_WORKER_ROLE", "unlabelled"),
                "role": os.environ.get("PAD_WORKER_ROLE", "unlabelled"),
                "slot": os.environ.get("PAD_WORKER_SLOT", root.parent.name if root.parent.name.isdigit() else "standalone"),
                "pid": os.getpid(), "cap": cap}
    with queue_registration(queue, metadata) as ticket:
        acquired = False
        deadline = time.monotonic() + 1800
        try:
            while not acquired:
                position = queue_position(queue, ticket)
                if position == 1:
                    try:
                        lock.mkdir()
                        acquired = True
                    except FileExistsError:
                        pass
                if acquired:
                    metadata.update(started=time.time(), queueDirectory=str(queue))
                    pending = lock / ".holder.pending"
                    pending.write_text(json.dumps(metadata))
                    os.replace(pending, lock / "holder.json")
                    ticket.unlink()
                    print("ACQUIRED [gate-lock]: " + json.dumps(metadata), flush=True)
                    break
                holder_path = lock / "holder.json"
                holder = read_lock_record(holder_path)
                issues = lock_wait_findings(holder, position, time.time())
                remaining = max(0, holder.get("cap", 0) - (time.time() - holder.get("started", time.time())))
                callers = [read_lock_record(p) for p in sorted(queue.glob("ticket-*.json"))]
                expected = None if issues else remaining + sum(item.get("cap", cap) for item in callers[:position - 1])
                print("WAIT [gate-lock]: " + json.dumps({"holder": holder or "unknown", "queuePosition": position, "fifoQueue": callers, "expectedWaitSeconds": expected, "diagnostics": issues}), flush=True)
                if time.monotonic() >= deadline:
                    raise ValueError("gate lock wait exceeded 1800s; own queue ticket withdrawn, holder untouched")
                time.sleep(60)
            yield
        finally:
            if acquired:
                (lock / "holder.json").unlink(missing_ok=True)
                lock.rmdir()


@contextmanager
def termination_as_interrupt():
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def pre_push_commands(root: Path, rules: dict) -> list[list[str]]:
    files = sorted(path.relative_to(root).as_posix() for path in (root / "tests").glob("test_*.mjs"))
    if not files:
        raise ValueError("pre-push requires a nonempty complete Node implementation suite")
    commands = [["python3", "scripts/check_base_freshness.py"],
                ["node", "scripts/model_negative_controls.mjs", "--changed"],
                ["node", "scripts/owner_terms_lint.mjs", "--base", "origin/main"],
                ["node", "scripts/generic_owner_scan.mjs"],
                ["node", "--test", "--test-reporter=tap", "--test-concurrency=1", *files]]
    for check in rules["checks"]:
        if check["kind"] != "command" or not (check["id"].endswith("-tests") or check["id"] == "janus-types"):
            continue
        command = check["command"]
        cwd = (root / check.get("cwd", ".")).resolve()
        if not cwd.is_relative_to(root.resolve()):
            raise ValueError("pre-push command directory escapes checkout")
        if check.get("cwd", ".") != ".":
            command = ["bash", "-c", 'cd -- "$1" && shift && exec "$@"', "pre-push", str(cwd), *command]
        commands.append(command)
    return commands


def implementation_snapshot(root: Path):
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root, capture_output=True, text=True, timeout=10, check=True).stdout
    if status:
        raise ValueError("pre-push requires committed, unchanged implementation inputs")
    return head


def validate_push_head(root: Path, rows: str) -> str:
    head = implementation_snapshot(root)
    updates = [line.split() for line in rows.splitlines() if line.strip()]
    if not updates or any(len(row) != 4 or row[1] != head for row in updates):
        raise ValueError("push payload must name current HEAD; other commits/deletions need their own verification")
    return head


def pre_push_main(root: Path = ROOT, rules: dict | None = None, expected_head: str | None = None) -> int:
    rules = rules or load_rules(root / ".driver/gate-rules.json")
    try:
        before = implementation_snapshot(root)
        if expected_head is not None and before != expected_head:
            raise ValueError("push head changed while waiting for FIFO admission")
        for command in pre_push_commands(root, rules):
            print(f"RUN [pre-push]: {shlex.join(command)}", flush=True)
            result = subprocess.run(command, cwd=root)
            if result.returncode:
                return 1
        if implementation_snapshot(root) != before:
            raise ValueError("implementation head changed during pre-push checks")
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"BLOCKED [pre-push]: {error}", file=sys.stderr)
        return 3
    print("PASS [pre-push]: full current implementation-test set passed on unchanged HEAD", flush=True)
    return 0


def locked_entry() -> int:
    with termination_as_interrupt():
        return _locked_entry()


def _locked_entry() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--native-phase", choices=("baseline", "check", "refresh"))
    mode.add_argument("--pre-push", action="store_true")
    mode.add_argument("--tool-env", action="store_true")
    parser.add_argument("--git-hook", action="store_true")
    parser.add_argument("--reason")
    args = parser.parse_args()
    if args.tool_env:
        java, jar = resolve_java_tlc()
        print(json.dumps({"JAVA": java, "TLA2TOOLS": jar}))
        return 0
    if args.git_hook and not args.pre_push:
        parser.error("--git-hook requires --pre-push")
    expected_head = validate_push_head(ROOT, sys.stdin.read()) if args.git_hook else None
    rules = load_rules()
    inventory = subprocess.run(["node", str(ROOT / "scripts/model_negative_controls.mjs"), "--changed"], cwd=ROOT, capture_output=True, text=True, timeout=20)
    findings = preflight_findings(ROOT, rules)
    if inventory.returncode:
        findings.append(inventory.stderr.strip() or "changed-model inventory failed")
    if findings:
        for finding in findings:
            print(f"BLOCKED [recurrence-preflight]: {finding}", file=sys.stderr)
        return 3
    # The existing 600s shared-gate budget and per-command native caps remain
    # unchanged. The native verifier previously had no aggregate supervisor;
    # its inherited mutation runs are serial and need a separate finite bound.
    cap = NATIVE_BUDGET_SECONDS if args.native_phase else (1800 if args.pre_push else rules["speedBudgetSeconds"])
    if args.pre_push:
        command = [sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import gate; raise SystemExit(gate.pre_push_main(expected_head=sys.argv[2] or None))", str(ROOT / "scripts"), expected_head or ""]
    elif args.native_phase:
        command = [sys.executable, str(ROOT / "scripts/test_gate_runner.py"), "--phase", args.native_phase,
                   "--mutations", os.environ.get("TEST_GATE_MUTATIONS", "all")]
        if args.reason:
            command += ["--reason", args.reason]
    else:
        command = [sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import gate; raise SystemExit(gate.main())", str(ROOT / "scripts")]
    with observable_gate_lock(ROOT, cap):
        started = time.monotonic()
        try:
            return run_bounded(command, cap)
        finally:
            step = "prepush-total" if args.pre_push else (f"native-{args.native_phase}-total" if args.native_phase else "shared-total")
            record_runtime(ROOT, step, time.monotonic() - started)


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


GLOBAL_HOOK_DISPATCHER = "evoclock-hook-dispatch"
# Exact SHA-256 of every reviewed evoclock-hook-dispatch. Fail closed: any other content,
# including a dispatcher that still appears to chain, is refused until reviewed and added here.
# 46c168b6...: $CONFIG_HOME/git/hooks/evoclock-hook-dispatch on the MBP and mini, 19 Nov 2026 15:42 London.
REVIEWED_GLOBAL_DISPATCHER_SHA256 = frozenset({
    "46c168b6dc5bb7bfe4ca1ff6526d76a14aaedadf6eb890244e86e59fefee9d94",
})
# Environment that would point a probe hook at the caller's repository instead of the probe repo.
PROBE_SCRUBBED_GIT_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX")
PROBE_EXIT = 7


def hook_chains_to_repo(hook: Path) -> bool:
    """Run one installed global hook in a throwaway repo and prove it reaches <git-common-dir>/hooks/<name>.

    The probe hook records its arguments and exits PROBE_EXIT; only a dispatcher that really
    executes the repository hook with its arguments and propagates its exit code passes.
    """
    import tempfile

    env = {key: value for key, value in os.environ.items() if key not in PROBE_SCRUBBED_GIT_ENV}
    with tempfile.TemporaryDirectory(prefix="pad-hook-chain-probe-") as tmp:
        repo = Path(tmp).resolve() / "repo"
        # An explicit empty template overrides GIT_TEMPLATE_DIR and init.templateDir, whose
        # hook symlinks would otherwise point the probe write at a real hook outside tmp.
        empty_template = Path(tmp).resolve() / "empty-template"
        empty_template.mkdir()
        try:
            subprocess.run(["git", "init", "-q", f"--template={empty_template}", str(repo)], env=env,
                           check=True, capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            return False
        marker = repo / "probe-ran"
        hooks = repo / ".git/hooks"
        if hooks.is_symlink():
            return False
        hooks.mkdir(exist_ok=True)
        probe = hooks / hook.name
        try:
            # O_EXCL|O_NOFOLLOW: never write through, or over, anything already at the probe path.
            fd = os.open(probe, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
        except OSError:
            return False
        with os.fdopen(fd, "w") as handle:
            handle.write(f'#!/bin/sh\nprintf "%s" "$*" > "{marker}"\nexit {PROBE_EXIT}\n')
        probe.chmod(0o755)
        try:
            result = subprocess.run([str(hook), "pad-probe-arg"], cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                    capture_output=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == PROBE_EXIT and marker.is_file() and marker.read_text() == "pad-probe-arg"


def user_global_hooks_dir() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(config_home) / "git/hooks"


def global_hook_chain_problem(root: Path, configured_path: Path) -> str | None:
    """Return why a non-repo hooksPath is not a verified chain, or None when it is."""
    hooks_dir = configured_path.resolve()
    if hooks_dir != user_global_hooks_dir().resolve():
        return "not the user-global git hooks directory"
    dispatcher = hooks_dir / GLOBAL_HOOK_DISPATCHER
    if dispatcher.is_symlink() or not dispatcher.is_file() or not os.access(dispatcher, os.X_OK):
        return f"{GLOBAL_HOOK_DISPATCHER} is missing, a symlink, or not executable"
    digest = hashlib.sha256(dispatcher.read_bytes()).hexdigest()
    if digest not in REVIEWED_GLOBAL_DISPATCHER_SHA256:
        return f"{GLOBAL_HOOK_DISPATCHER} sha256 {digest} is not a reviewed dispatcher"
    repo_hooks = root / ".githooks"
    names = sorted(p.name for p in repo_hooks.iterdir() if p.is_file()) if repo_hooks.is_dir() else []
    # Route first so the probe only ever executes the dispatcher itself.
    for name in sorted(set(names) | {"pre-commit"}):
        entry = hooks_dir / name
        if not entry.exists() or entry.resolve() != dispatcher.resolve():
            return f"{name} is not routed through {GLOBAL_HOOK_DISPATCHER}"
    missing = [name for name in sorted(set(names) | {"pre-commit"}) if not hook_chains_to_repo(hooks_dir / name)]
    if missing:
        return f"{GLOBAL_HOOK_DISPATCHER} does not chain to the repository hooks"
    return None


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
            problem = global_hook_chain_problem(root, configured_path)
            if problem:
                findings.append(
                    f"core.hooksPath points to {configured.stdout.strip()!r}, not .githooks ({problem}); "
                    "preserve the existing chain and configure the repository hook path"
                )
            else:
                print(
                    "NOTICE [hook-integrity]: core.hooksPath is the user-global chain "
                    f"{configured.stdout.strip()!r}; its verified {GLOBAL_HOOK_DISPATCHER} chains to "
                    "<git-common-dir>/hooks, and the checked-in hook is still checked and replayed in Buildkite"
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
    history = root / ".driver/test-gate-evidence/shared-runtimes.jsonl"
    previous = None
    if history.is_file():
        for line in history.read_text().splitlines():
            item = json.loads(line)
            if item.get("step") == check_id:
                previous = item
    if previous is not None:
        findings = runtime_headroom_findings(check_id, previous.get("elapsed"), remaining)
        if findings:
            print("BLOCKED [runtime-headroom]: " + "; ".join(findings), file=sys.stderr)
            return False, True
    print(f"RUN [{check_id}]: {shlex.join(command)}", flush=True)
    try:
        command_started = time.monotonic()
        try:
            result = subprocess.run(command, cwd=cwd, timeout=remaining)
        finally:
            record_runtime(root, check_id, time.monotonic() - command_started)
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
        findings = preflight_findings(ROOT, rules)
        if findings:
            for finding in findings:
                print(f"FAIL [recurrence-preflight]: {finding}", file=sys.stderr)
            return 1
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
    raise SystemExit(locked_entry())
