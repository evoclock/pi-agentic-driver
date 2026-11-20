"""Read-only runtime headroom checks; this module never changes a gate cap."""
import math


class HeadroomError(ValueError):
    """An observed runtime leaves insufficient room in the supplied real cap."""


def _seconds(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('runtime and cap must be finite numbers')
    if value < 0 or positive and value == 0:
        raise ValueError('runtime must be nonnegative and cap positive')
    return value


def check_headroom(step, last_seconds, cap_seconds):
    if not isinstance(step, str) or not step.strip() or not step.isprintable():
        raise ValueError('step needs a printable name')
    cap = _seconds(cap_seconds, positive=True)
    if last_seconds is None:
        return {'step':step, 'lastSeconds':None, 'capSeconds':cap, 'history':'unobserved', 'headroomPercent':None}
    last = _seconds(last_seconds)
    percent = 100 * (1 - last / cap)
    if last * 4 > cap * 3:
        minimum = math.ceil(last * 4 / 3)
        raise HeadroomError(f'{step}: last runtime {last:g}s; cap {cap:g}s; headroom {percent:.3f}% <25%; minimum cap {minimum}s')
    return {'step':step, 'lastSeconds':last, 'capSeconds':cap, 'history':'observed', 'headroomPercent':percent}


def last_runtime(step, records):
    latest = None
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('runtime history entries must be objects')
        if record.get('step') == step:
            latest = _seconds(record['elapsedSeconds'])
    return latest


def check_plan(caps, records):
    """Check every step before the caller starts any work; inputs stay read-only."""
    return [check_headroom(step, last_runtime(step, records), cap) for step, cap in caps.items()]


def check_recorded_steps(records, command_cap, make_seconds, make_cap):
    """Check the latest observation of every native command/phase and make gate."""
    latest = {}
    for row in records:
        if not isinstance(row, dict):
            raise ValueError('command history entries must be objects')
        if isinstance(row.get('argv'), list) and 'elapsedMs' in row:
            if row['argv'][:1] == ['scripts/test_gate_runner.py'] and row.get('timeoutSeconds') is None:
                continue  # Native aggregate summaries are not240s child commands.
            name = 'native:' + str(row.get('phase','command')) + ':' + str(row.get('cwd','.')) + ':' + ' '.join(row['argv'])
            latest[name] = _seconds(row['elapsedMs']) / 1000
    return [check_headroom(name, seconds, command_cap) for name, seconds in latest.items()] + [check_headroom('make-gate', make_seconds, make_cap)]


def run_step(step, cap_seconds, records, run):
    check_headroom(step, last_runtime(step, records), cap_seconds)
    return run()
