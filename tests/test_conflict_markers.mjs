import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictLines } from '../.github/tools/public_term_scan.mjs';

test('detects conflict markers and ignores Markdown examples in fences', () => {
  assert.deepEqual(conflictLines('before\n<<<<<<< HEAD\n=======\n>>>>>>> branch\nafter'), [2, 3, 4]);
  assert.deepEqual(conflictLines('```text\n<<<<<<< HEAD\n=======\n>>>>>>> branch\n```\n<<<<<<< HEAD', true), [6]);
  assert.deepEqual(conflictLines('not =======\n======= extra\ntext'), []);
});
