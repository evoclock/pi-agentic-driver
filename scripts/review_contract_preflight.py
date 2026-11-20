"""Check focused-contract readiness before the native host records a baseline."""
from pathlib import Path
from test_gate_runner import (
    Blocked, load_rules, resolve_base, working_tree_paths,
    mutation_contracts, is_production_code_path, mutation_command_spec,
)


def require_focused(changed, tests, contracts):
    if not any(is_production_code_path(name) for name in changed):
        return
    focused = [contract for contract in contracts.values()
               if contract.get('path') in changed
               and isinstance(contract.get('testPaths'), list)
               and contract['testPaths']
               and all(isinstance(name, str) and name in tests for name in contract['testPaths'])]
    if not focused:
        raise Blocked('before baseline: changed production needs a focused mutation key; register contracts before taking the lock')


def check(root):
    rules, config = load_rules(root)
    _, base = resolve_base(root, rules, None)
    changed, tests, _, _ = working_tree_paths(root, base)
    contracts = mutation_contracts(config)
    require_focused(changed, tests, contracts)
    for contract in contracts.values():
        if contract.get('path') in changed:
            mutation_command_spec(root, rules, config, contract)


if __name__ == '__main__':
    try:
        check(Path.cwd())
        print('focused contract preflight: OK; baseline may now record the final configuration')
    except (Blocked, OSError, ValueError) as error:
        print(f'BLOCKED: {error}')
        raise SystemExit(3)
