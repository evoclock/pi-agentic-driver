import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Why: owner vocabulary applies to added lines, not unchanged history or substrings.
test('owner terms enforce exact tokens and explicit per-rule exclusions', async () => {
  assert.ok(existsSync('scripts/owner_terms_lint.mjs'), 'owner terms lint must exist');
  const { lintLines } = await import('../scripts/owner_terms_lint.mjs');
  for (const term of [['pre','spawn'].join('-'), ['PRE','SPAWN'].join(' '), ['pre','spawn'].join('')]) {
    assert.equal(lintLines([{path:'docs/example.md', line:4, text:term}]).length, 1);
  }
  assert.equal(lintLines([{path:'docs/pi.md', line:1, text:['Pi uses pstack ', '/statechart'].join('')}]).length, 1);
  for (const text of ['a check before spawn', 'statechart-pi', 'Claude equivalent: /statechart', 'prespawner']) {
    assert.deepEqual(lintLines([{path:'docs/pi.md', line:1, text}]), []);
  }
  assert.equal(lintLines([{path:'config/owner-terms.v1.json',line:1,text:['pre','spawn'].join('-')}]).length, 1);
});

// Why: deleted lines and diff metadata must never become new wording violations.
test('unified diff parser records only additions with their new line numbers', async () => {
  assert.ok(existsSync('scripts/owner_terms_lint.mjs'), 'owner terms lint must exist');
  const { addedLines } = await import('../scripts/owner_terms_lint.mjs');
  assert.deepEqual(addedLines('diff --git a/docs/x.md b/docs/x.md\n--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n'), [{path:'docs/x.md',line:1,text:'new'}]);
});
