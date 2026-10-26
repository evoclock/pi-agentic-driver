#!/usr/bin/env python3
"""One bounded Ralph iteration; the caller owns the plan and launches each next iteration."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

OUTCOMES = ('completed', 'review requested', 'changes requested', 'blocked', 'crashed', 'timed out', 'gave up')
# Host ceilings; fan-out is not metered here. Only zero-fan-out commands are admitted.
CEILINGS = {'depth': 1, 'nodes': 1, 'concurrency': 1, 'iterations': 100, 'wall_seconds': 3600}


def positive_bound(value, ceiling):
    return type(value) is int and 0 < value <= ceiling



def run(root, plan_path, state_path, budget_path):
    plan = json.loads(plan_path.read_text())
    state = json.loads(state_path.read_text()) if state_path.exists() else {'done': [], 'failures': 0, 'remaining': None, 'iteration': 0}
    budget = json.loads(budget_path.read_text())
    if not isinstance(plan, dict) or not isinstance(plan.get('items'), list) or not plan['items']:
        raise ValueError('plan needs items')
    if not isinstance(budget, dict) or not all(positive_bound(budget.get(k), v) for k, v in CEILINGS.items()):
        raise ValueError('invalid fan-out budget')
    if (not isinstance(state.get('done'), list) or type(state.get('failures')) is not int
            or state['failures'] < 0 or type(state.get('iteration')) is not int
            or state['iteration'] < 0):
        raise ValueError('invalid state')
    if state.get('terminal'):
        raise ValueError(f"terminal outcome: {state['terminal']}; do not retry")
    ids = [item['id'] for item in plan['items']]
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate item ids')
    remaining = [item for item in plan['items'] if item['id'] not in state['done']]
    if state['iteration']:
        previous = root / 'handoff' / f"ralph-{state['iteration']}.json"
        if not previous.with_suffix('.json.consumed').exists():
            raise ValueError('consume previous session-handover before next iteration')
    if not remaining:
        return {'schema': 'ralph-outcome.v1', 'outcome': 'completed', 'item': None, 'next': 'stop'}
    item = remaining[0]
    pending = root / 'handoff' / f"ralph-{state['iteration'] + 1}.json"
    intent = pending.with_suffix('.json.intent')
    if intent.exists() or pending.exists() or pending.with_suffix('.json.consumed').exists():
        return {'schema': 'ralph-outcome.v1', 'outcome': 'blocked', 'item': item['id'],
                'reason': 'interrupted iteration: inspect intent, handover and work before retrying',
                'handover': str(pending) if pending.exists() else None, 'intent': str(intent), 'next': 'stop'}
    pending.parent.mkdir(exist_ok=True)
    # Exclusive durable intent precedes all work. A lost response never authorizes replay.
    with intent.open('x') as output:
        json.dump({'schema': 'ralph-attempt.v1', 'item': item['id'], 'iteration': state['iteration'] + 1}, output)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(pending.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    start = time.monotonic()
    outcome = 'blocked'
    reason = ''
    fan = item.get('fanout', {})
    if not isinstance(fan, dict) or any(type(fan.get(k)) is not int or fan[k] != 0
           for k in ('depth', 'nodes', 'concurrency')) or state['iteration'] >= budget['iterations']:
        reason = 'fan-out or iteration budget refused; commands must be non-fan-out'
    elif state['failures'] >= 2 and state['remaining'] is not None and len(remaining) >= state['remaining']:
        # Gap analysis uses the remaining-item count, not a model claim of progress.
        outcome, reason = 'gave up', 'gap analysis: remaining work did not shrink'
    else:
        try:
            for key in ('work', 'accept'):
                argv = item[key]
                if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
                    raise ValueError(f'{key} needs argv')
                left = budget['wall_seconds'] - (time.monotonic() - start)
                if left <= 0:
                    raise subprocess.TimeoutExpired(argv, budget['wall_seconds'])
                result = subprocess.run(argv, cwd=root, timeout=left, check=False, capture_output=True, text=True)
                if result.returncode:
                    outcome = 'changes requested'
                    reason = f'{key} failed ({result.returncode}): {result.stderr[-300:]}'
                    break
            else:
                outcome = 'completed'
        except subprocess.TimeoutExpired:
            outcome, reason = 'timed out', 'wall-clock budget exhausted'
        except (OSError, ValueError, KeyError) as exc:
            outcome, reason = 'blocked', str(exc)
    if outcome == 'completed':
        state['done'].append(item['id'])
        state['failures'] = 0
    elif outcome == 'changes requested':
        state['failures'] += 1
    state['remaining'] = len([x for x in plan['items'] if x['id'] not in state['done']])
    state['iteration'] += 1
    if outcome in ('gave up', 'blocked', 'crashed', 'timed out'):
        state['terminal'] = outcome
    # Use the existing producer, never write handover content here. The supplied
    # source-indexed sections must validate against the repository before state advances.
    handover = root / 'handoff' / f"ralph-{state['iteration']}.json"
    handover.parent.mkdir(exist_ok=True)
    try:
        sections = root / item['sections']
        left = budget['wall_seconds'] - (time.monotonic() - start)
        if left <= 0:
            raise subprocess.TimeoutExpired('handover', budget['wall_seconds'])
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('session_handover.py')),
                                 'write', str(handover), '--root', str(root), '--input', str(sections)],
                                cwd=root, capture_output=True, text=True, timeout=left)
        if result.returncode:
            raise ValueError('handover failed: ' + result.stderr.strip())
        state_path.write_text(json.dumps(state, indent=2) + '\n')
    except (subprocess.TimeoutExpired, ValueError, OSError, KeyError, TypeError) as exc:
        return {'schema': 'ralph-outcome.v1', 'outcome': 'timed out' if isinstance(exc, subprocess.TimeoutExpired) else 'blocked',
                'item': item['id'], 'reason': str(exc), 'intent': str(intent),
                'handover': str(handover) if handover.exists() else None, 'next': 'stop; inspect held attempt'}
    assert outcome in OUTCOMES
    return {'schema': 'ralph-outcome.v1', 'outcome': outcome, 'item': item['id'], 'reason': reason, 'handover': str(handover),
            'next': 'stop' if outcome in ('gave up', 'blocked', 'crashed', 'timed out') else 'consume handover before next iteration'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--budget', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.root.resolve(), args.plan.resolve(), args.state.resolve(), args.budget.resolve())))
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f'ralph: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
