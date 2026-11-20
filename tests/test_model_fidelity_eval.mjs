import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate } from '../scripts/model_fidelity_eval.mjs';

const source = new URL('./fixtures/model-fidelity/held-out-17/input.json', import.meta.url);
const load = async () => JSON.parse(await readFile(source, 'utf8'));

// Why: missing independent review must not become a zero-error score.
test('unreviewed and unavailable pairs are recorded, not scored', async () => {
  const report = evaluate(await load());
  assert.equal(report.caseCount, 6);
  assert.equal(report.reviewedCases, 0);
  for (const arm of Object.values(report.arms)) assert.deepEqual([arm.attempts, arm.unavailable, arm.scored, arm.unreviewed], [6, 6, 0, 6]);
  assert.equal(report.attempts.length, 12);
});

// Why: a fully specified reviewed oracle must expose exact-field misses and false alarms.
test('one independently attributed test oracle scores action, mechanism, schedule and error types', async () => {
  const input = await load();
  input.cases = [input.cases[0]];
  input.cases[0].reviewStatus = 'reviewed';
  input.cases[0].review = { reviewer: 'different-reviewer', independent: true, artifactDigest: 'a'.repeat(64) };
  input.attempts = [{ caseId: input.cases[0].id, arm: 'method-loaded', status: 'recorded', provenance: 'test-only',
    response: { actionId: 'Other', mechanism: input.cases[0].expected.mechanism, schedule: input.cases[0].expected.schedule, finding: false } }];
  const report = evaluate(input);
  assert.deepEqual(report.arms['method-loaded'].correct, { actionId: 0, mechanism: 1, schedule: 1 });
  assert.deepEqual(report.arms['method-loaded'].missedFindings, [input.cases[0].id]);
  input.attempts[0].response.finding = true;
  input.cases[0].expected.finding = false;
  assert.deepEqual(evaluate(input).arms['method-loaded'].falseAlarms, [input.cases[0].id]);
});

// Why: corrupted attribution must not quietly inflate the evaluated sample.
test('invalid review, duplicate attempts and absent response are refused', async () => {
  const input = await load();
  input.cases[0].reviewStatus = 'reviewed';
  assert.throws(() => evaluate(input), /provenance/);
  input.cases[0].review = { reviewer: 'different-reviewer', independent: true, artifactDigest: 'a'.repeat(64) };
  input.attempts.push({ ...input.attempts[0] });
  assert.throws(() => evaluate(input), /duplicate attempt/);
  input.attempts.pop();
  input.attempts[0] = { ...input.attempts[0], status: 'recorded' };
  assert.throws(() => evaluate(input), /requires response/);
});
