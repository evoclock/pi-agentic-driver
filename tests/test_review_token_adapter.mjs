import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Why: testing the native function alone would miss an adapter that never calls it.
test('token adapter checks actual changed test files against the base', () => {
  const adapter = resolve('scripts/review_test_tokens.py');
  assert.ok(existsSync(adapter), 'native token adapter must exist');
  mkdirSync('.scratch', {recursive:true});
  const cwd = mkdtempSync(resolve('.scratch/token-adapter-'));
  const git = (...args) => execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  try {
    git('init','-q'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
    mkdirSync(join(cwd,'tests'));
    const file = join(cwd,'tests/test_sample.mjs');
    writeFileSync(file,'assert.equal(value, 1);\n');
    git('add','.'); git('commit','-qm','fixture');
    git('update-ref','refs/remotes/origin/main',git('rev-parse','HEAD'));
    let result = spawnSync('python3',[adapter,'origin/main'],{cwd,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    writeFileSync(file,'assert.ok(value);\n');
    result = spawnSync('python3',[adapter,'origin/main'],{cwd,encoding:'utf8',timeout:10000});
    assert.equal(result.status,3,result.stdout + result.stderr);
    assert.match(result.stderr,/correction removed or relaxed an existing assertion or test token: tests\/test_sample\.mjs/);
  } finally { rmSync(cwd,{recursive:true,force:true}); }
});
