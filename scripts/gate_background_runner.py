#!/usr/bin/env python3
"""Detached gate supervision with read-only historical-runtime preflight.

Launch this process detached with stdout/stderr directed to a file; poll status.json.
The reviewed native aggregate budget is independent of locked command and
make-gate budgets. This never modifies gate rules, generated locks or native evidence.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

from gate_runtime_preflight import check_headroom, check_plan, check_recorded_steps

NATIVE_AGGREGATE_CAP_SECONDS = 2400
TOOL_TIMEOUT_SECONDS = 2460

COMMANDS = {
    'controls': ['node', 'scripts/workflow_runner_mutation_controls.mjs'],
    'check': ['python3', 'scripts/test_gate_runner.py', '--phase', 'check'],
    'test-gate': ['make', 'test-gate'],
    'gate': ['make', 'gate'],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=[*COMMANDS, 'refresh'])
    parser.add_argument('out', type=Path)
    parser.add_argument('--refresh-reason')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = args.out.resolve()
    if not out.is_relative_to(root / '.scratch'):
        parser.error('output must be a new repository-local scratch directory')
    if args.step == 'refresh' and not args.refresh_reason:
        parser.error('refresh needs its genuine reason')
    out.mkdir(exist_ok=False)
    rules = json.loads((root / '.driver/gate-rules.json').read_text()) if (root / '.driver/gate-rules.json').is_file() else {'speedBudgetSeconds':600}
    config = json.loads((root / '.driver/test-gate.json').read_text()) if (root / '.driver/test-gate.json').is_file() else {'caps':{'commandTimeoutSeconds':240}}
    cap = NATIVE_AGGREGATE_CAP_SECONDS if args.step in ('check','test-gate','refresh') else rules['speedBudgetSeconds']
    command = COMMANDS.get(args.step) or ['python3', 'scripts/test_gate_runner.py', '--phase', 'refresh', '--reason', args.refresh_reason]
    records = []
    for path in sorted(out.parent.glob('*/status.json'), key=lambda p: p.stat().st_mtime):
        if path.is_symlink() or not path.resolve().is_relative_to(out.parent):
            raise ValueError('runtime history must stay within its scratch directory')
        data = json.loads(path.read_text())
        if data.get('state') in ('passed', 'failed', 'budget-exceeded'):
            name = data.get('step')
            if name in ('check', 'test-gate') and args.step in ('check', 'test-gate'):
                name = args.step
            if name:
                records.append({'step':name, 'elapsedSeconds':data['elapsedSeconds']})
    # Preserve the measured incomplete native run as a lower bound, not a pass.
    measured = root / '.scratch/g8-final/overrun-wall-times.json'
    if args.step in ('check', 'test-gate') and not any(r['step'] == args.step for r in records) and measured.is_file():
        if measured.is_symlink() or not measured.resolve().is_relative_to(root / '.scratch'):
            raise ValueError('runtime measurement must stay within repository scratch')
        records.append({'step':args.step, 'elapsedSeconds':sum(r['seconds'] for r in json.loads(measured.read_text()))})
    state = {'step':args.step, 'pid':os.getpid(), 'state':'preflight', 'capSeconds':cap, 'elapsedSeconds':0}
    def save():
        temporary = out / 'status.tmp'
        temporary.write_text(json.dumps(state, indent=2) + '\n')
        temporary.replace(out / 'status.json')
    save()
    try:
        state['preflight'] = check_plan({args.step:cap}, records)
        evidence = root / '.driver/test-gate-evidence/checks.jsonl'
        command_records = [json.loads(line) for line in evidence.read_text().splitlines() if line.strip()] if evidence.is_file() else []
        make_seconds = next((r['elapsedSeconds'] for r in reversed(records) if r['step']=='gate'), None)
        historical = root / '.scratch/g8-final/serialized-results.json'
        if make_seconds is None and historical.is_file():
            make_seconds = next((r['elapsedSeconds'] for r in reversed(json.loads(historical.read_text())) if r['name']=='make-gate-final'),None)
        state['preflight'] += check_recorded_steps(command_records, config['caps']['commandTimeoutSeconds'], make_seconds, rules['speedBudgetSeconds'])
        if (root / 'scripts/test_gate_runner.py').is_file():
            from test_gate_runner import mutation_contracts, mutation_command_spec
            observed = {(tuple(r['argv']), r.get('cwd','.')) for r in command_records if isinstance(r.get('argv'),list)}
            declared = set()
            for contract in mutation_contracts(config).values():
                spec = mutation_command_spec(root, rules, config, contract)
                identity = (tuple(spec['command']),spec['cwd'])
                if identity not in observed and identity not in declared:
                    state['preflight'].append(check_headroom('unobserved-native:'+' '.join(spec['command']),None,spec['timeoutSeconds']))
                declared.add(identity)
        state['toolTimeoutSeconds'] = TOOL_TIMEOUT_SECONDS
    except ValueError as error:
        state.update(state='preflight-blocked', reason=str(error)); save(); return 3
    owning_root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=root, text=True).strip()).resolve()
    if owning_root != root:
        raise ValueError('gate supervisor must run from its owning repository')
    common = Path(subprocess.check_output(['git', 'rev-parse', '--git-common-dir'], cwd=root, text=True).strip())
    common = (root / common).resolve() if not common.is_absolute() else common.resolve()
    lock = common.parent / '.local/locks/test-gate.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    owned = False
    child = None
    def stop():
        if child is not None and child.poll() is None:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: return
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait()
    def interrupted(signum, frame):
        stop(); state.update(state='interrupted'); save(); raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        state.update(state='waiting-for-lock', queuedAt=time.time()); save()
        waiting = time.monotonic()
        while not owned:
            try: lock.mkdir(); owned = True
            except FileExistsError:
                if time.monotonic() - waiting >= 1800:
                    state.update(state='lock-timeout'); save(); return 3
                time.sleep(2)
        check_headroom(args.step, next((r['elapsedSeconds'] for r in reversed(records) if r['step'] == args.step), None), cap)
        started = time.monotonic()
        state.update(state='running', startedAt=time.time(), head=subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()); save()
        with (out / 'command.out').open('w') as log:
            child = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try: code = child.wait(timeout=cap)
            except subprocess.TimeoutExpired: stop(); code = 124
        state.update(state='passed' if code == 0 else 'budget-exceeded' if code == 124 else 'failed', exit=code, elapsedSeconds=time.monotonic()-started)
        save(); return code
    finally:
        if owned: lock.rmdir()


if __name__ == '__main__':
    raise SystemExit(main())
