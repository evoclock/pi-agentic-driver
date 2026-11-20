import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createAttempt, captureBundle, publishOutput } from '../lib/model-fidelity/attempts.mjs';

const revision = 'a'.repeat(40);
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/mf-attempt-'));
  const repoRoot = path.join(root, 'repo');
  const storeRoot = path.join(root, 'store');
  await mkdir(repoRoot);
  await writeFile(path.join(repoRoot, 'model.tla'), 'original');
  return { repoRoot, storeRoot };
}

// Why: another actor must not reuse an attempt or its generation.
test('an attempt binds its owner and generation and refuses another claimant', async () => {
  const fixturePaths = await fixture();
  const claim = await createAttempt({ ...fixturePaths, unitId: 'unit', attemptId: 'one', owner: 'actor' });
  await assert.rejects(createAttempt({ ...fixturePaths, unitId: 'unit', attemptId: 'one', owner: 'other' }), { code: 'attempt-conflict' });
  await assert.rejects(publishOutput({ ...claim, generation: 'old' }, { kind: 'result', ids: { requestId: 'one' }, bytes: '{}' }), { code: 'attempt-conflict' });
  await assert.rejects(publishOutput({ ...claim, owner: 'other' }, { kind: 'result', ids: { requestId: 'one' }, bytes: '{}' }), { code: 'attempt-conflict' });
});

// Why: changed source must create a distinct immutable bundle.
test('manifest binds original bytes and source identity; later bundles keep both versions', async () => {
  const f = await fixture();
  const claim = await createAttempt({ ...f, unitId: 'u', attemptId: 'a', owner: 'actor' });
  const first = await captureBundle(claim, { repoRoot: f.repoRoot, bundleId: 'b1', sourceRevision: revision, checker: 'tlc-2', files: ['model.tla'] });
  await writeFile(path.join(f.repoRoot, 'model.tla'), 'changed');
  const second = await captureBundle(claim, { repoRoot: f.repoRoot, bundleId: 'b2', sourceRevision: revision, checker: 'tlc-2', files: ['model.tla'] });
  assert.notEqual(first.manifestDigest, second.manifestDigest);
  assert.equal(await readFile(path.join(f.storeRoot, 'units/u/attempts/a/input/bundles/b1/files/model.tla'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(f.storeRoot, 'units/u/attempts/a/input/bundles/b2/files/model.tla'), 'utf8'), 'changed');
  await assert.rejects(captureBundle(claim, { repoRoot: f.repoRoot, bundleId: 'b1', sourceRevision: revision, checker: 'tlc-2', files: ['model.tla'] }), { code: 'EEXIST' });
});

// Why: every diagram invocation keeps its own render.
test('two diagram results retain separate renders; outputs never overwrite', async () => {
  const f = await fixture();
  const claim = await createAttempt({ ...f, unitId: 'u', attemptId: 'a', owner: 'actor' });
  for (const resultId of ['first', 'second']) await publishOutput(claim, { kind: 'view', ids: { viewId: 'lifecycle', resultId }, name: 'diagram.svg', bytes: resultId });
  const base = path.join(f.storeRoot, 'units/u/attempts/a/views/lifecycle');
  assert.equal(await readFile(path.join(base, 'first/diagram.svg'), 'utf8'), 'first');
  assert.equal(await readFile(path.join(base, 'second/diagram.svg'), 'utf8'), 'second');
  await assert.rejects(publishOutput(claim, { kind: 'view', ids: { viewId: 'lifecycle', resultId: 'first' }, name: 'diagram.svg', bytes: 'overwrite' }), { code: 'EEXIST' });
  await publishOutput(claim, { kind: 'result', ids: { requestId: 'r1' }, bytes: '{}' });
  await assert.rejects(publishOutput(claim, { kind: 'result', ids: { requestId: 'r1' }, bytes: '{}' }), { code: 'EEXIST' });
});

// Why: a crash must leave its evidence visible and refuse reuse.
test('an interrupted bundle remains visible without a published manifest', async () => {
  const f = await fixture();
  const claim = await createAttempt({ ...f, unitId: 'u', attemptId: 'a', owner: 'actor' });
  const dir = path.join(f.storeRoot, 'units/u/attempts/a/input/bundles/b1');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'interrupted'), 'keep');
  await assert.rejects(captureBundle(claim, { repoRoot: f.repoRoot, bundleId: 'b1', sourceRevision: revision, checker: 'tlc', files: ['model.tla'] }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(dir, 'interrupted'), 'utf8'), 'keep');
});

// Why: input capture and artifact publication must stay in their roots.
test('rejects path escapes and symlink inputs', async () => {
  const f = await fixture();
  const claim = await createAttempt({ ...f, unitId: 'u', attemptId: 'a', owner: 'actor' });
  const args = { repoRoot: f.repoRoot, bundleId: 'b', sourceRevision: revision, checker: 'tlc' };
  await assert.rejects(captureBundle(claim, { ...args, files: ['../outside'] }), TypeError);
  await symlink('model.tla', path.join(f.repoRoot, 'linked'));
  await assert.rejects(captureBundle(claim, { ...args, files: ['linked'] }), TypeError);
  await assert.rejects(publishOutput(claim, { kind: 'view', ids: { viewId: 'lifecycle', resultId: 'b' }, name: '../escape', bytes: 'x' }), TypeError);
});
