import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Why: a stale base must stop before running expensive verification.
test('preflight blocks a stale base in an isolated repository', async () => {
  assert.ok(existsSync('scripts/review_preflight.mjs'), 'review preflight must exist');
  const { preflight } = await import('../scripts/review_preflight.mjs');
  mkdirSync('.scratch',{recursive:true});
  const cwd = mkdtempSync(resolve('.scratch/preflight-'));
  const git = (...args) => execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  try {
    git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    writeFileSync(join(cwd,'file'),'first'); git('add','.'); git('commit','-qm','first');
    const initial = git('rev-parse','HEAD');
    writeFileSync(join(cwd,'file'),'next'); git('commit','-qam','next');
    git('update-ref','refs/remotes/origin/main',git('rev-parse','HEAD')); git('checkout','--detach',initial);
    const result = preflight({cwd,fetch:false});
    assert.equal(result.ok,false);
    assert.equal(result.message,'BLOCKED: merge origin/main with --no-ff first');
  } finally { rmSync(cwd,{recursive:true,force:true}); }
});

// Why: native frozen-test token checks must be reused, never reimplemented or bypassed.
test('preflight token adapter rejects relaxed assertions using native gate function', () => {
  assert.ok(existsSync('scripts/review_test_tokens.py'), 'native token adapter must exist');
  const program = "import sys; sys.path.insert(0, 'scripts'); from test_gate_runner import preserve_test_tokens, Blocked;\ntry: preserve_test_tokens('assert.equal(value, 1)', 'assert.ok(value)', 'fixture.mjs')\nexcept Blocked: sys.exit(3)\nsys.exit(0)";
  assert.throws(() => execFileSync('python3',['-c',program]), error => error.status === 3);
});
