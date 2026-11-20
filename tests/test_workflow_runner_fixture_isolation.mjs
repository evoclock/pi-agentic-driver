import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const fixtureModule = await import(new URL('./fixtures/workflow-exit/build.mjs', import.meta.url)).catch(error => error);
const fixture = (...args) => {
  assert.ok(!(fixtureModule instanceof Error), 'workflow-exit fixture/module required');
  return fixtureModule.fixture(...args);
};

// Why: sharing static arrangement must never share writable Git history, files or observation state.
test('exit fixtures retain independent real Git repositories and mutable state', t => {
  const a = fixture(t), b = fixture(t), before = b.git('rev-parse', 'HEAD');
  assert.notEqual(a.repo, b.repo);
  assert.notEqual(statSync(join(a.repo, '.git/config')).ino, statSync(join(b.repo, '.git/config')).ino);
  writeFileSync(join(a.repo, 'artifact.md'), 'independent repair');
  a.git('add', '.'); a.git('commit', '-m', 'independent repair');
  assert.notEqual(a.git('rev-parse', 'HEAD'), before);
  assert.equal(b.git('rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(b.repo, 'artifact.md'), 'utf8'), 'after');
  assert.equal(b.git('status', '--porcelain'), '');
  a.request.checks[0].command.push('independent-argument');
  assert.deepEqual(b.request.checks[0].command, ['node', 'check.mjs']);
  a.s.pending.commit = 'other';
  assert.equal(b.s.pending.commit, before);
});
