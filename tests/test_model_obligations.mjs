import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Why: directive substrings inside identifiers must not erase obligations or stop collection.
test('obligations preserve MaxINITLen and NoVIEWLeak exactly', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'obligation parser must exist');
  const { obligations } = await import('../scripts/model_negative_controls.mjs');
  assert.deepEqual(obligations('INVARIANT TypeOK MaxINITLen'), ['TypeOK','MaxINITLen']);
  assert.deepEqual(obligations('INVARIANT A NoVIEWLeak B'), ['A','NoVIEWLeak','B']);
  assert.deepEqual(obligations('INVARIANT SafeCONSTRAINT Bound'), ['SafeCONSTRAINT','Bound']);
});

// Why: single-line, multiline and nested block comments cannot contribute checked obligations.
test('obligations remove block comments before recognizing directives', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'obligation parser must exist');
  const { obligations } = await import('../scripts/model_negative_controls.mjs');
  for (const source of [
    '(* INVARIANT Old *)\nINVARIANT Safe',
    '(* first line\nINVARIANT Old\nPROPERTY Ghost\n*)\nINVARIANT Safe',
    '(* outer (* INVARIANT Hidden *) PROPERTY Ghost *)\nINVARIANT Safe',
    'INVARIANT Safe (* comment\nINVARIANT Hidden *) Other',
  ]) assert.deepEqual(obligations(source), source.endsWith('Other') ? ['Safe','Other'] : ['Safe']);
});

// Why: comment-like bytes in quoted values stay data, and malformed comments must fail closed.
test('obligation lexical boundaries respect strings and reject unfinished comments', async () => {
  assert.ok(existsSync('scripts/model_negative_controls.mjs'), 'obligation parser must exist');
  const { obligations } = await import('../scripts/model_negative_controls.mjs');
  assert.deepEqual(obligations('CONSTANT Label = "(* INVARIANT Old *)"\nINVARIANT Safe'),['Safe']);
  assert.deepEqual(obligations('\\* INVARIANT Old\nINVARIANT Safe'),['Safe']);
  assert.throws(() => obligations('INVARIANT Safe\n(* unfinished'), /unterminated block comment/);
});
