import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { run } from '../scripts/workflow_runner_core.mjs';
import { createFakeAuthority } from '../scripts/workflow_runner_authority.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'authority-core-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'evoclock'); git('config', 'user.email', '52983349+evoclock@users.noreply.github.com');
  mkdirSync(join(repo, 'skills')); const skill = '# Skill\n## step: check\nCheck synthetic content.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill); writeFileSync(join(repo, 'artifact.md'), 'before');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const w = { schema: 'pad-workflow.v1', repo, revision: git('rev-parse', 'HEAD'), maxAttempts: 2,
    steps: [{ id: 'check', artifact: 'artifact.md', sha256: sha('after'),
      skill: { pack: 'synthetic', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' } }] };
  return { w, store: join(repo, '.local/workflow-runner/task0001'), authority: createFakeAuthority({ tenantId: 'tenant_0001', taskId: 'task_000001' }) };
}
// Why: the actual public core must not emit an effect when no authority is configured.
test('core parks without authority before publishing any intent', async t => {
  const f = fixture(t); const result = await run(f.w, f.store, { id: 'tick', type: 'tick' });
  assert.equal(result.reason, 'AUTHORITY_UNCONFIGURED'); assert.equal(result.move, 'wait');
});
// Why: a disconnected owner cancel is not a durable acknowledgement in the core API.
test('core offline cancel is pending rather than cancelled', async t => {
  const f = fixture(t); const authority = { ...f.authority, commitCancel: () => ({ ok: false, error: { code: 'AUTHORITY_UNAVAILABLE', retryable: true } }) };
  const result = await run(f.w, f.store, { id: 'cancel', type: 'cancel' }, { authority });
  assert.equal(result.phase, 'cancel_pending'); assert.equal(result.acknowledged, false);
});
// Why: real checkpoint deletion and valid-prefix journal truncation must not undo acknowledged cancellation.
test('G4 filesystem rollback defers to authority cancellation', async t => {
  const f = fixture(t), adapter = { authority: f.authority };
  await run(f.w, f.store, { id: 'act', type: 'tick' }, adapter);
  for (let i = 0; i < 31; i++) await run(f.w, f.store, { id: `look${i}`, type: 'look' }, adapter);
  const journal = join(f.store, 'journal.jsonl'); const prefix = readFileSync(journal);
  const cancelled = await run(f.w, f.store, { id: 'cancel', type: 'cancel' }, adapter);
  assert.equal(cancelled.phase, 'cancelled');
  rmSync(join(f.store, 'checkpoint.json')); writeFileSync(journal, prefix);
  const resumed = await run(f.w, f.store, { id: 'resume', type: 'tick' }, adapter);
  assert.equal(resumed.phase, 'cancelled'); assert.notEqual(resumed.move, 'act');
});
// Why: a fresh authority observation does not substitute for a successful CAS admission.
test('core refuses effect publication when CAS authority is unavailable', async t => {
  const f = fixture(t);
  const authority = { ...f.authority, casAdmitEffect: () => ({ ok: false, error: { code: 'AUTHORITY_UNAVAILABLE', retryable: true } }) };
  const result = await run(f.w, f.store, { id: 'tick', type: 'tick' }, { authority });
  assert.equal(result.reason, 'AUTHORITY_UNAVAILABLE'); assert.notEqual(result.move, 'act');
});

// Why: another writer's higher authority epoch cannot be reconciled from a stale local cache.
test('core parks when authority epoch advances outside the cached run', async t => {
  const f = fixture(t), adapter = { authority: f.authority };
  await run(f.w, f.store, { id: 'observe', type: 'look' }, adapter);
  await f.authority.casAdmitEffect({ tenantId: 'tenant_0001', taskId: 'task_000001', requestId: '00000000-0000-4000-8000-000000000001',
    op: 'claim', expectedEpoch: 0, leaseTtlMs: 1000 });
  const result = await run(f.w, f.store, { id: 'act', type: 'tick' }, adapter);
  assert.equal(result.reason, 'AUTHORITY_RECONCILIATION_REQUIRED'); assert.notEqual(result.move, 'act');
});

// Why: replay of an old dispatch event is observation, never permission to execute the effect again.


test('core duplicate dispatch never reuses cached admission', async t => {
  const f = fixture(t), adapter = { authority: f.authority }, event = { id: 'tick', type: 'tick' };
  assert.equal((await run(f.w, f.store, event, adapter)).move, 'act');
  const duplicate = await run(f.w, f.store, event, adapter);
  assert.equal(duplicate.duplicate, true); assert.notEqual(duplicate.move, 'act');
});
