// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreHandcheck, wilson } from '../scripts/skill_usage_handcheck.mjs';

const cases = [
  { id: 'a', skill: 'test-gate', pack: 'PAD', needed: true },
  { id: 'b', skill: 'test-gate', pack: 'PAD', needed: true },
  { id: 'c', skill: 'ralph', pack: 'PAD', needed: false },
  { id: 'd', skill: 'ralph', pack: 'PAD', needed: false },
];
const labels = { schema: 'pad.skill-usage-labels.v1', rubric: 'Read evidence and SKILL.md before predictions.', cases };
const row = (values) => cases.map((c, i) => ({ id: c.id, needed: values[i] }));
const predictions = { schema: 'pad.skill-usage-predictions.v1',
  openai: { before: row([true, false, true, false]), after: row([true, true, false, false]) },
  jev: { before: row([true, true, false, false]), after: row([true, true, false, false]) } };

// Why: A confidence bound without its denominator can hide an undersized check.
test('Wilson 95 percent interval uses the relevant denominator', () => {
  assert.equal(wilson(0, 0), null);
  assert.ok(Math.abs(wilson(1, 2).lower - 0.0945312057) < 1e-8);
  assert.equal(wilson(1, 2).n, 2);
});

// Why: Both transports must be evaluated against one unchanged label set.
test('paired provider and phase scores use identical blinded labels', () => {
  const score = scoreHandcheck(labels, predictions);
  assert.equal(score.n, 4);
  assert.deepEqual([score.results.openai.before.tp, score.results.openai.before.fp,
    score.results.openai.before.fn, score.results.openai.before.tn], [1, 1, 1, 1]);
  assert.equal(score.results.openai.after.precision.estimate, 1);
  assert.equal(score.results.jev.before.recall.estimate, 1);
});

// Why: A checkout must reproduce the reported table and structured/plain control without ignored files.
test('committed handcheck evidence reproduces the table and control', async () => {
  const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
  const frozen = await fixture('skill_usage_labels.json');
  const observed = await fixture('skill_usage_predictions.json');
  const control = await fixture('skill_usage_plain_control.json');
  const requests = await fixture('skill_usage_requests.json');
  assert.equal(requests.goals.length, 12);
  assert.equal(requests.questions.plain.includes('{description}'), true);
  const actual = scoreHandcheck(frozen, observed).results;
  assert.deepEqual(['openai', 'jev'].flatMap((provider) => ['before', 'after'].map((phase) => {
    const { tp, fp, fn, tn } = actual[provider][phase];
    return [tp, fp, fn, tn];
  })), [[9, 11, 1, 39], [9, 5, 1, 45], [4, 0, 6, 50], [4, 0, 6, 50]]);
  assert.deepEqual(control.openai.after.map((row) => [row.id, row.needed]),
    observed.openai.before.map((row) => [row.id, row.needed]));
});

// Why: Partial provider output must not inflate reported accuracy.
test('missing, duplicate and extraneous predictions fail rather than shrink the denominator', () => {
  assert.throws(() => scoreHandcheck(labels, { ...predictions, openai: { ...predictions.openai,
    before: row([true, true, false]) } }));
  assert.throws(() => scoreHandcheck(labels, { ...predictions, jev: { ...predictions.jev,
    after: [...row([true, true, false, false]).slice(0, 3), { id: 'a', needed: true }] } }));
  assert.throws(() => scoreHandcheck({ ...labels, cases: [...cases, cases[0]] }, predictions));
});
