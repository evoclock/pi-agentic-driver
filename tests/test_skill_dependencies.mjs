import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dependenciesMissing } from '../scripts/skill_dependencies.mjs';
const root = resolve(import.meta.dirname, '..');
const packageSkills = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).pi.skills.map(s => s.split('/').at(-1));

// Why: an unshipped skill reference cannot be a required step without an absent-tool fallback.
test('skill dependencies are shipped or explicitly optional', () => {
  assert.deepEqual(dependenciesMissing('Use `recall-pi` to read history.', packageSkills), ['recall-pi']);
  assert.deepEqual(dependenciesMissing('If `recall-pi` is installed, use it; otherwise report missing history.', packageSkills), []);
  for (const name of packageSkills) {
    if (name === 'release-public') continue;
    const text = readFileSync(resolve(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.deepEqual(dependenciesMissing(text, packageSkills), [], name);
  }
});
