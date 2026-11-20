import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Why: missing focused contracts must be caught before the host freezes configuration.
test('contract preflight requires a changed target and a changed focused suite', () => {
  assert.ok(existsSync('scripts/review_contract_preflight.py'), 'contract preflight must exist before baseline');
  const program = `import sys
sys.path.insert(0, 'scripts')
from review_contract_preflight import require_focused
from test_gate_runner import Blocked
changed = {'scripts/example.mjs', 'tests/test_example.mjs'}
tests = {'tests/test_example.mjs'}
contract = {'path':'scripts/example.mjs','testPaths':['tests/test_example.mjs']}
for contracts in ({}, {'inherited':{'path':'scripts/old.mjs','testPaths':['tests/test_example.mjs']}}, {'wrong-suite':{'path':'scripts/example.mjs','testPaths':['tests/test_old.mjs']}}):
    try: require_focused(changed, tests, contracts)
    except Blocked: continue
    sys.exit(1)
require_focused(changed, tests, {'focused':contract})
require_focused({'docs/example.md'}, set(), {})
print('focused contract checks passed')
`;
  const result = spawnSync('python3',['-c',program],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stdout + result.stderr);
  assert.match(result.stdout,/focused contract checks passed/);
});
