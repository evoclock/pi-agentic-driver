import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Why: an unrelated temporal failure or unlabeled exit 13 cannot prove the requested property failed.
test('temporal control matches its expected property as well as the exit code', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'model control checker must exist');
  const module = await import('../scripts/model_negative_controls.mjs');
  assert.equal(typeof module.negativeResultMatches,'function','named-result classifier must exist');
  const control = {kind:'property',expected:'ClaimNeverWedges'};
  assert.equal(module.negativeResultMatches(control,{status:13,stdout:'Temporal property ClaimNeverWedges is violated.'}),false);
  assert.equal(module.negativeResultMatches(control,{status:13,stdout:'Temporal property Other is violated.'}),false);
  assert.equal(module.negativeResultMatches(control,{status:13,stdout:'Temporal properties were violated.'}),false);
  assert.equal(module.negativeResultMatches(control,{status:12,stdout:'Temporal property ClaimNeverWedges is violated.'}),false);
  assert.equal(module.negativeResultMatches({kind:'invariant',expected:'Safe'},{status:12,stdout:'Invariant Safe is violated.'}),true);
});

// Why: reporting changed source status must preserve the original checker failure and its cause.
test('repository status cleanup preserves primary failures and reports both causes', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'model control checker must exist');
  const module = await import('../scripts/model_negative_controls.mjs');
  assert.equal(typeof module.withStatusUnchanged,'function','status-preserving execution must exist');
  const primary = new Error('intended TLC failure');
  let calls = 0;
  assert.throws(() => module.withStatusUnchanged(() => calls++ ? 'changed' : 'clean',() => { throw primary; }),error => error instanceof AggregateError && error.cause === primary && error.errors[0] === primary && error.message.includes('intended TLC failure') && error.message.includes('TLC changed repository status'));
  assert.throws(() => module.withStatusUnchanged(() => 'clean',() => { throw primary; }),error => error === primary);
  calls = 0;
  assert.throws(() => module.withStatusUnchanged(() => calls++ ? 'changed' : 'clean',() => 'result'),/TLC changed repository status/);
  assert.equal(module.withStatusUnchanged(() => 'clean',() => 'result'),'result');
});
