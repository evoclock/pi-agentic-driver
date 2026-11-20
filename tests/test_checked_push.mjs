import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as outward from '../scripts/enforcement/outward_effect_pi.js';

function fixture(t, native = '', full = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'checked-push-'));
  t.after(() => rmSync(cwd, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
  git('init', '-q', '-b', 'feat/checked');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(cwd, '.gitignore'), 'checks.log\n');
  writeFileSync(join(cwd, 'Makefile'), `.PHONY: test-gate pre-push\ntest-gate:\n\t@printf 'native\\n' >> checks.log\n${native}\npre-push:\n\t@printf 'full\\n' >> checks.log\n${full}\n`);
  git('add', '.'); git('commit', '-qm', 'fixture');
  return {cwd, git, head:git('rev-parse', 'HEAD')};
}

// Why: each new push requires native proof and the full suite on its requested commit.
test('checked push runs both gates on a clean exact head', async (t) => {
  assert.equal(typeof outward.verifyCheckedPush, 'function');
  const f = fixture(t);
  await outward.verifyCheckedPush(f.cwd, f.head, 'feat/checked');
  assert.equal(readFileSync(join(f.cwd, 'checks.log'), 'utf8'), 'native\nfull\n');
});

// Why: either failing suite or head drift must prevent an outward effect.
test('checked push rejects failed suites and drift during either gate', async (t) => {
  assert.equal(typeof outward.verifyCheckedPush, 'function');
  for (const target of ['native', 'full']) for (const recipe of ['\t@exit 1', '\t@git commit --allow-empty -qm drift']) {
    const f = fixture(t, target === 'native' ? recipe : '', target === 'full' ? recipe : '');
    await assert.rejects(() => outward.verifyCheckedPush(f.cwd, f.head, 'feat/checked'));
    assert.equal(readFileSync(join(f.cwd, 'checks.log'), 'utf8'), target === 'native' ? 'native\n' : 'native\nfull\n');
  }
});

// Why: dirty inputs, another branch and a different SHA cannot borrow prior green evidence.
test('checked push rejects dirty inputs and mismatched identities', async (t) => {
  assert.equal(typeof outward.verifyCheckedPush, 'function');
  const f = fixture(t);
  await assert.rejects(() => outward.verifyCheckedPush(f.cwd, '1'.repeat(40), 'feat/checked'), /head|inputs/i);
  await assert.rejects(() => outward.verifyCheckedPush(f.cwd, f.head, 'feat/other'), /branch|inputs/i);
  writeFileSync(join(f.cwd, 'untracked'), 'drift');
  await assert.rejects(() => outward.verifyCheckedPush(f.cwd, f.head, 'feat/checked'), /clean|inputs/i);
});
