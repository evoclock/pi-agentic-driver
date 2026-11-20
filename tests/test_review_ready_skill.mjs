import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Why: review guidance must ship honestly as behavior and require reusable guard evidence.
test('review-ready is registered guidance with enforced vocabulary and checks', () => {
  assert.ok(existsSync('skills/review-ready/SKILL.md'), 'review-ready skill must exist');
  const text = readFileSync('skills/review-ready/SKILL.md','utf8');
  for (const term of ['make preflight','decision-gate','statechart-pi','negative cfg','mutant','F1','F23']) assert.ok(text.includes(term),term);
  assert.doesNotMatch(text,/\bpre[- ]?spawn\b/i);
  assert.ok(JSON.parse(readFileSync('package.json')).pi.skills.includes('./skills/review-ready'));
  assert.equal(JSON.parse(readFileSync('config/skill-proof.v1.json')).skills['review-ready'].kind,'behavior');
  assert.match(readFileSync('README.md','utf8'), /`review-ready`/);
});
