import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Why: required verification must fail loudly rather than silently skipping missing tools.
test('required TLC fails without Java or jar', async () => {
  assert.ok(existsSync('tests/helpers/tlc.mjs'), 'shared TLC helper must exist');
  const { runTlc } = await import(process.env.PAD_REVIEW_TLC_MUTANT || './helpers/tlc.mjs');
  assert.throws(() => runTlc({source:'skills/decision-gate', model:'DecisionGate.tla', config:'DecisionGate.cfg', env:{TLC_REQUIRED:'1', JAVA:'/nonexistent/java', TLA2TOOLS_JAR:'/nonexistent/jar'}}), /TLC required/);
});

// Why: model artifacts must stay in scratch and unsafe controls must fail for the intended reason.
test('shared TLC helper isolates safe and negative runs', async t => {
  assert.ok(existsSync('tests/helpers/tlc.mjs'), 'shared TLC helper must exist');
  const { runTlc } = await import(process.env.PAD_REVIEW_TLC_MUTANT || './helpers/tlc.mjs');
  const options = {source:'skills/decision-gate', model:'DecisionGate.tla'};
  const safe = runTlc({...options,config:'DecisionGate.cfg'});
  if (safe.skipped) return t.skip(safe.reason);
  assert.equal(safe.status, 0, safe.stdout + safe.stderr);
  assert.match(safe.stdout, /Model checking completed. No error has been found/);
  assert.match(safe.cwd, /\.scratch/);
  for (const [variant, invariant] of [['owner','OwnerBoundary'],['record','RecordedBeforeProceed'],['enforce','EnforcedBeforeProceed']]) {
    const result = runTlc({...options,config:`DecisionGate-unsafe-${variant}.cfg`});
    assert.equal(result.status, 12, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`Invariant ${invariant} is violated`));
  }
});
