import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const api = await import('../scripts/workflow_runner_exit.mjs').catch(error => error);
const helpers = await import('./fixtures/workflow-exit/build.mjs').catch(error => error);
const need = () => { assert.ok(!(api instanceof Error), 'exit module required'); assert.ok(!(helpers instanceof Error), 'real Git fixture required'); };

// Why: real Node default/spec/TAP and Python unittest output must count through the production executor, not a fake summary.
test('real subprocess test reporters supply positive exit-check counts', async t => {
  need();
  const f = helpers.fixture(t);
  // Why: the generated Node program contains an actual asserting test whose reporter supplies the denominator.
  writeFileSync(join(f.repo, 'real.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('one', () => assert.equal(1, 1));\n");
  writeFileSync(join(f.repo, 'real_test.py'), "import unittest\nclass One(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(1, 1)\n");
  f.git('add', '.'); f.git('commit', '-m', 'real check programs');
  const commit = f.git('rev-parse', 'HEAD');
  for (const command of [[process.execPath, '--test', 'real.test.mjs'], [process.execPath, '--test', '--test-reporter=spec', 'real.test.mjs'], [process.execPath, '--test', '--test-reporter=tap', 'real.test.mjs'], ['python3', '-B', '-m', 'unittest', 'real_test.py']]) {
    const counter = command[0] === 'python3' ? 'python-unittest' : 'node-tap';
    const result = await api.observeExitChecks({...f.request, commit, binding: {...f.binding, commit}, checks: [{id:'real',kind:'test',command,counter}]});
    assert.equal(result.verdict, 'pass', JSON.stringify({command,result}));
    assert.equal(result.results[0].tests, 1);
    assert.equal(result.results[0].exitStatus, 0);
  }
});
// Why: changing a declared timeout must change real process completion, not just parsed configuration.
test('real subprocess checks honor declared timeouts', async t => {
  need();
  const f = helpers.fixture(t);
  writeFileSync(join(f.repo, 'slow_test.py'), "import time, unittest\nclass Slow(unittest.TestCase):\n    def test_completion(self):\n        time.sleep(2)\n        self.assertEqual(1, 1)\n");
  f.git('add', '.'); f.git('commit', '-m', 'real delayed check');
  const commit = f.git('rev-parse', 'HEAD');
  const request = {...f.request, commit, binding: {...f.binding, commit}};
  const check = {id:'delayed', kind:'test', command:['python3', '-B', '-m', 'unittest', 'slow_test.py'], counter:'python-unittest'};
  const completed = await api.observeExitChecks({...request, checks:[{...check, timeoutSeconds:3}]});
  assert.equal(completed.verdict, 'pass', JSON.stringify(completed));
  assert.equal(completed.results[0].tests, 1);
  assert.equal(completed.results[0].exitStatus, 0);
  assert.equal(completed.results[0].timedOut, false);
  const expired = await api.observeExitChecks({...request, checks:[{...check, timeoutSeconds:1}]});
  assert.equal(expired.verdict, 'incomplete', JSON.stringify(expired));
  assert.equal(expired.parkReason, 'checks-incomplete');
  assert.equal(expired.results[0].timedOut, true);
  assert.equal(expired.results[0].exitStatus, null);
  assert.equal(expired.results[0].tests, null);
});
// Why: imported checks must use explicit semantics and a bounded timeout, not infer them from names or executable names.
test('imported rules preserve argv and explicit kind counter and timeout', () => {
  need();
  const defaults = {schema:'pad-exit-checks.v1',fromGateRules:[{id:'unit-suite',kind:'test',counter:'pytest',timeoutSeconds:300}],defaults:[]};
  const rules = {checks:[{id:'unit-suite',kind:'command',command:['python3','-m','pytest'],timeoutSeconds:120}]};
  const resolve = doc => api.resolveExitChecks({repo:'.',revision:'pinned'}, {invariants:[],checks:{add:[]}}, {show: (_rev,path) => JSON.stringify(path.endsWith('exit-checks.json') ? doc : rules)});
  assert.deepEqual(resolve(defaults).checks, [{id:'unit-suite',kind:'test',counter:'pytest',command:['python3','-m','pytest'],timeoutSeconds:300}]);
  for (const change of [{counter:undefined},{timeoutSeconds:601},{timeoutSeconds:0},{command:['unreviewed']}]) {
    const bad = structuredClone(defaults); Object.assign(bad.fromGateRules[0], change);
    assert.equal(resolve(bad).park, 'checks-invalid');
  }
  assert.equal(resolve({...defaults,fromGateRules:['unit-suite']}).park, 'checks-invalid');
});
// Why: the shipped Python suite needs measured headroom and the Node suite needs a declared counter regardless of its id.
test('shipped imported defaults declare test counters and Python timeout headroom', () => {
  need();
  const defaults = JSON.parse(readFileSync(new URL('../.driver/exit-checks.json', import.meta.url)));
  assert.equal(api.validExitChecks(defaults), true);
  const python = defaults.fromGateRules.find(c => c.id === 'python-tests');
  const node = defaults.fromGateRules.find(c => c.id === 'policy-unit-tests');
  assert.equal(python.kind, 'test'); assert.equal(python.counter, 'python-unittest');
  assert.equal(python.timeoutSeconds, 450);
  assert.ok(python.timeoutSeconds <= 600);
  assert.equal(node.kind, 'test'); assert.equal(node.counter, 'node-tap');
});
