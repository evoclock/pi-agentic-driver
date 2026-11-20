import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const spellings = () => [['pre','spawn'].join('-'), ['PRE','SPAWN'].join(' '), ['pre','spawn'].join('')];

// Why: a prohibited runtime fixture in any added tests/ line must be caught, including the former exemption.
test('owner lint enforces the same added-line boundary for tests and fixtures', async () => {
  assert.ok(existsSync('scripts/owner_terms_lint.mjs'), 'owner terms lint must exist');
  const { lintLines, addedLines } = await import('../scripts/owner_terms_lint.mjs');
  const values = [...spellings(), ['Pi uses pstack ', '/statechart'].join('')];
  for (const path of ['tests/test_owner_terms_lint.mjs','tests/fixtures/owner-terms/example.txt']) {
    for (const text of values) {
      const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${text}\n`;
      const hits = lintLines(addedLines(diff));
      assert.equal(hits.length,1,`${path}: fixture wording must be checked`);
      assert.equal(hits[0].path,path);
      assert.equal(hits[0].line,1);
    }
  }
});

// Why: neither the test file nor config needs an exemption when the rule patterns do not match their own source.
test('rule source has no self-match and no file exclusions remain', async () => {
  assert.ok(existsSync('scripts/owner_terms_lint.mjs'), 'owner terms lint must exist');
  const { lintLines } = await import('../scripts/owner_terms_lint.mjs');
  const path = 'config/owner-terms.v1.json';
  const source = readFileSync(path,'utf8');
  const config = JSON.parse(source);
  for (const rule of config.rules) {
    // Why: check the pattern directly so a file exclusion cannot conceal a genuine self-match.
    assert.equal(new RegExp(rule.pattern,'i').test(source),false,`${rule.id}: self-exclusion is unnecessary`);
    assert.deepEqual(rule.exclude,[],`${rule.id}: added-file exemptions must not return`);
  }
  assert.deepEqual(lintLines(source.split('\n').map((text,line) => ({path,line:line + 1,text}))),[]);
  assert.equal(lintLines([{path,line:1,text:spellings()[0]}]).length,1,'config path must not hide a genuine violation');
});
