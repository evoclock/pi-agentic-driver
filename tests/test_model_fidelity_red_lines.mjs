import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRedLines, loadRedLineConfig, redLineConfigSchema, validateRedLineConfig } from '../lib/model-fidelity/red-lines.mjs';

const config = {
  schema: 'model-fidelity.red-lines.v1',
  rawDataPaths: ['inputs/original.csv'],
  keyAssetPaths: ['skills/core/SKILL.md'],
};
const empty = { modified: [], deleted: [], added: [] };

for (const [name, diff, expected] of [
  ['raw overwrite', { ...empty, modified: ['inputs/original.csv'] }, [['raw-data-overwrite', 'confirmed']]],
  ['key asset deleted', { ...empty, deleted: ['skills/core/SKILL.md'] }, [['key-asset-delete', 'confirmed']]],
  ['evidence deleted without explicit listing', { ...empty, deleted: ['runs/evidence/result.json'] }, [['key-asset-delete', 'confirmed']]],
  ['ordinary deletion', { ...empty, deleted: ['notes/draft.md'] }, []],
  ['added raw data does not overwrite', { ...empty, added: ['inputs/original.csv'] }, []],
  ['modified script is suspected', { ...empty, modified: ['scripts/check.mjs'] }, [['same-script-reedit', 'suspected']]],
  ['new script alongside edit has no heuristic', { modified: ['scripts/check.mjs'], deleted: [], added: ['scripts/new.mjs'] }, []],
]) {
  // Why: Each diff class must have an observable confidence and action-level decision.
  test(name, () => {
    let result;
    assert.doesNotThrow(() => { result = assessRedLines(diff, config); });
    assert.deepEqual(result.findings.map(({ redLine, confidence }) => [redLine, confidence]), expected);
    assert.equal(result.continuation, expected.some(([, confidence]) => confidence === 'confirmed') ? 'stop-red-line' : 'continue');
    assert.deepEqual(result.stoppedActions.map(({ path }) => path), expected.some(([, confidence]) => confidence === 'confirmed') ? [diff.modified[0] ?? diff.deleted[0]] : []);
  });
}

// Why: A caller's specific confirmation must stop that action without laundering a heuristic into host proof.
test('confirmation stops only the named script, without upgrading a heuristic to confirmed evidence', () => {
  const result = assessRedLines({ ...empty, modified: ['scripts/one.ts', 'scripts/two.js'] }, config, { confirmedScriptPaths: ['scripts/two.js'] });
  assert.equal(result.continuation, 'stop-red-line');
  assert.deepEqual(result.stoppedActions, [{ path: 'scripts/two.js', redLine: 'same-script-reedit' }]);
  assert.deepEqual(result.findings.map(f => f.confidence), ['suspected', 'suspected']);
});

// Why: A confirmed finding must not hold unrelated delivery.
test('a confirmed red line stops only its own path while unrelated work continues', () => {
  const result = assessRedLines({ ...empty, modified: ['inputs/original.csv', 'docs/readme.md'] }, config);
  assert.deepEqual(result.stoppedActions, [{ path: 'inputs/original.csv', redLine: 'raw-data-overwrite' }]);
});

// Why: Host defaults protect evidence even when both configured lists are empty.
test('empty lists still protect evidence and leave other changes alone', () => {
  const lists = { schema: config.schema, rawDataPaths: [], keyAssetPaths: [] };
  assert.equal(assessRedLines({ ...empty, modified: ['inputs/original.csv'] }, lists).continuation, 'continue');
  assert.equal(assessRedLines({ ...empty, deleted: ['evidence/item.json'] }, lists).continuation, 'stop-red-line');
});

// Why: A real file loader must return a validated versioned host configuration.
test('config schema and loader preserve typed host lists', async () => {
  const loaded = await loadRedLineConfig(new URL('./fixtures/model_fidelity_red_lines.json', import.meta.url));
  assert.equal(redLineConfigSchema.title, config.schema);
  assert.deepEqual(loaded, config);
  assert.notEqual(loaded.rawDataPaths, config.rawDataPaths);
});

for (const bad of [
  { ...config, schema: 'model-fidelity.red-lines.v2' },
  { ...config, rawDataPaths: ['../escape'] },
  { ...config, keyAssetPaths: ['/absolute'] },
  { ...config, rawDataPaths: ['inputs/original.csv', 'inputs/original.csv'] },
  { ...config, extra: true },
  { schema: config.schema, rawDataPaths: [] },
]) {
  // Why: Untrusted config versions and unsafe paths must fail before diff assessment.
  test(`reject invalid host lists ${JSON.stringify(bad)}`, () => assert.throws(() => validateRedLineConfig(bad), TypeError));
}

// Why: A false caller confirmation must never stop work outside the observed diff.
test('reject invalid diff and ungrounded confirmation', () => {
  assert.throws(() => assessRedLines({ ...empty, modified: ['../escape'] }, config), TypeError);
  assert.throws(() => assessRedLines(empty, config, { confirmedScriptPaths: ['scripts/no.js'] }), TypeError);
});
