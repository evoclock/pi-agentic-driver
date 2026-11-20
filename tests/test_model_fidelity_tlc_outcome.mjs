import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTlcOutcome } from '../lib/model-fidelity/tlc-outcome.mjs';

const properties = ['Safety', 'Progress'];
const counterexample = 'Error: Invariant Safety is violated.\nThe behavior up to this point is:\nState 1: <Initial predicate>\n';
const cases = [
  ['completed clean run', { stdout: 'Model checking completed. No error has been found.', exitCode: 0 }, 'no-counterexample', ['Safety', 'Progress'], []],
  ['nonzero error', { stdout: 'Error: Parsing or semantic analysis failed.', exitCode: 1 }, 'error', [], properties],
  ['real counterexample', { stdout: counterexample, exitCode: 12 }, 'counterexample', ['Safety'], ['Progress']],
  ['timeout', { stdout: counterexample, exitCode: null, timedOut: true }, 'incomplete', [], properties],
  ['truncated output', { stdout: counterexample, exitCode: 12, truncated: true }, 'incomplete', [], properties],
  ['zero without summary', { stdout: 'Finished in 1s', exitCode: 0 }, 'error', [], properties],
  ['missing Java', { errorCode: 'JAVA_UNAVAILABLE' }, 'unavailable', [], properties],
  ['missing checker', { errorCode: 'ENOENT' }, 'unavailable', [], properties],
  ['unknown property completion', { stdout: 'Error: Invariant Other is violated.\nThe behavior up to this point is:\nState 1:', exitCode: 12 }, 'counterexample', [], properties],
  ['state limit', { stdout: 'Too many states', exitCode: 1 }, 'incomplete', [], properties],
  ['budget exhaustion before run', { budgetExhausted: true }, 'not-run', [], properties],
  ['budget exhaustion after partial run', { budgetExhausted: true, stdout: 'Starting TLC' }, 'incomplete', [], properties],
  ['signal', { signal: 'SIGKILL' }, 'incomplete', [], properties],
  ['error text despite clean summary', { stdout: 'Error: something\nModel checking completed. No error has been found.', exitCode: 0 }, 'error', [], properties],
];
for (const [name, captured, status, checked, unchecked] of cases) {
  // Why: Each captured outcome keeps unknown properties unchecked instead of claiming a clean run.
  test(name, () => {
    let result;
    assert.doesNotThrow(() => { result = classifyTlcOutcome({ ...captured, properties }); });
    assert.equal(result.status, status);
    assert.deepEqual(result.checked, checked);
    assert.deepEqual(result.unchecked, unchecked);
    assert.equal(result.properties.length, properties.length);
  });
}

// Why: A trace for one property cannot prove any other property completed.
test('named counterexample is not a success for other properties', () => {
  const result = classifyTlcOutcome({ stdout: counterexample, exitCode: 12, properties });
  assert.deepEqual(result.counterexampleProperties, ['Safety']);
  assert.deepEqual(result.properties.map(p => p.status), ['counterexample', 'unchecked']);
});

// Why: Ambiguous property identities would turn unchecked work into apparent coverage.
test('invalid or duplicate property lists are rejected rather than silently deduplicated', () => {
  assert.throws(() => classifyTlcOutcome({ properties: ['Safety', 'Safety'] }), TypeError);
  assert.throws(() => classifyTlcOutcome({ properties: ['bad name'] }), TypeError);
});
