import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initial, run, readStatus } from './workflow_runner_authority_fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-ownership-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('checkout', '-qb', 'fixture');
  git('config', 'user.name', 'Synthetic Owner'); git('config', 'user.email', 'fixture@example.invalid');
  mkdirSync(join(repo, 'skills')); mkdirSync(join(repo, 'docs'));
  const skill = '# Fixture\n## step: check\nCheck the artifact.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill);
  writeFileSync(join(repo, 'docs/result.md'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const w = { schema: 'pad-workflow.v1', repo, revision: git('rev-parse', 'HEAD'), maxAttempts: 2,
    steps: [{ id: 'check', artifact: 'docs/result.md', sha256: sha('after\n'),
      skill: { pack: 'fixture', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' } }] };
  const store = join(repo, '.local/workflow-runner/task');
  const state = () => readStatus(w, store);
  const control = { ownerControl: request => ({ ...request, approved: true }) };
  const tickAdapter = (ownerId, generation) => ({ observeOwner: request => ({ ...request, ownerId, generation }) });
  return { w, store, state, control, tickAdapter, owner: initial(w).writerId };
}

// Why: ReleaseOwnership needs a task/event/current-owner-bound host observation, never caller assertions.
test('ownership release refuses untrusted and misbound controls, then persists owner absence', t => {
  const f = fixture(t);
  const release = { id: 'release', type: 'release-ownership', approved: true };
  assert.throws(() => run(f.w, f.store, release), /owner control unverified/);
  for (const field of ['taskDigest', 'ownerId', 'generation', 'eventId', 'type']) {
    assert.throws(() => run(f.w, f.store, release, { ownerControl: r => ({ ...r, approved: true, [field]: 'wrong' }) }), /owner control unverified/);
  }
  assert.equal(run(f.w, f.store, release, f.control).reason, 'ownership-released');
  assert.equal(f.state().ownership.ownerId, null);
  assert.equal(f.state().ownership.generation, 1);
  assert.equal(run(f.w, f.store, { id: 'stale', type: 'tick' }, f.tickAdapter(f.owner, 0)).move, 'wait');
});

// Why: Transfer is host-only and cannot grant ownership to a caller-supplied target without exact approval.
test('ownership transfer requires exact host approval and cannot undo a handbrake', t => {
  const f = fixture(t);
  const event = { id: 'transfer', type: 'transfer-ownership', targetOwner: 'owner-b' };
  assert.throws(() => run(f.w, f.store, event), /owner control unverified/);
  assert.throws(() => run(f.w, f.store, event, { ownerControl: r => ({ ...r, approved: true, targetOwner: 'owner-c' }) }), /owner control unverified/);
  run(f.w, f.store, { id: 'hold', type: 'hold' });
  assert.equal(run(f.w, f.store, event, f.control).reason, 'ownership-transferred');
  assert.equal(f.state().phase, 'held');
  assert.equal(run(f.w, f.store, { id: 'held', type: 'tick' }, f.tickAdapter('owner-b', 1)).move, 'settled');
});

// Why: even an ABA transfer back to the same owner must invalidate its old generation.
test('each transfer bumps generation and old generation cannot dispatch after owner returns', t => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'to-b', type: 'transfer-ownership', targetOwner: 'owner-b' }, f.control);
  run(f.w, f.store, { id: 'to-a', type: 'transfer-ownership', targetOwner: f.owner }, f.control);
  assert.equal(f.state().ownership.generation, 2);
  assert.equal(run(f.w, f.store, { id: 'old', type: 'tick' }, f.tickAdapter(f.owner, 0)).reason, 'ownership-fenced');
  const act = run(f.w, f.store, { id: 'new', type: 'tick' }, f.tickAdapter(f.owner, 2));
  assert.equal(act.move, 'act'); assert.equal(act.intent.ownerGeneration, 2);
});

// Why: managed effects require current host identity; neither raw events nor replay can manufacture a new act.
test('managed effect gate refuses missing, wrong-owner and stale-generation observations', t => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'transfer', type: 'transfer-ownership', targetOwner: 'owner-b' }, f.control);
  for (const [eventId, adapter] of [['missing', {}], ['old-owner', f.tickAdapter(f.owner, 1)], ['old-gen', f.tickAdapter('owner-b', 0)]]) {
    assert.equal(run(f.w, f.store, { id: eventId, type: 'tick', ownerId: 'owner-b', generation: 1 }, adapter).reason, 'ownership-fenced');
  }
  const event = { id: 'act', type: 'tick' };
  assert.equal(run(f.w, f.store, event, f.tickAdapter('owner-b', 1)).move, 'act');
  assert.equal(run(f.w, f.store, event).reason, 'ownership-replay-not-dispatch');
  assert.equal(f.state().attempts[0], 1);
});

// Why: unknown, present or misbound old-effect evidence must never clear the outstanding effect or spend a retry.
test('stale effects require exact task and dispatch bound terminal readback', t => {
  const f = fixture(t);
  const act = run(f.w, f.store, { id: 'act', type: 'tick' });
  run(f.w, f.store, { id: 'transfer', type: 'transfer-ownership', targetOwner: 'owner-b' }, f.control);
  const event = { id: 'reconcile', type: 'reconcile-old' };
  for (const status of ['unknown', 'present']) {
    const output = run(f.w, f.store, { ...event, id: status }, { reconcileOld: r => ({ ...r, status }) });
    assert.equal(output.reason, 'old-effect-unverified');
    assert.equal(f.state().intent.dispatchId, act.intent.dispatchId);
  }
  for (const field of ['taskDigest', 'dispatchId', 'writerId', 'ownerGeneration', 'epoch', 'branch', 'base']) {
    assert.equal(run(f.w, f.store, { ...event, id: `wrong-${field}` }, { reconcileOld: r => ({ ...r, status: 'completed', [field]: 'wrong' }) }).reason, 'old-effect-unverified');
  }
  assert.equal(run(f.w, f.store, { id: 'bypass', type: 'readback', status: 'absent' }, { readback: r => ({ ...r, status: 'absent' }) }).reason, 'old-effect-reconciliation-required');
  assert.equal(run(f.w, f.store, event, { reconcileOld: r => ({ ...r, status: 'completed' }) }).reason, 'old-effect-settled');
  assert.equal(f.state().intent, null); assert.equal(f.state().attempts[0], 1);
  const next = run(f.w, f.store, { id: 'next', type: 'tick' }, f.tickAdapter('owner-b', 1));
  assert.equal(next.move, 'act'); assert.equal(next.attempts, 2);
  assert.notEqual(next.intent.dispatchId, act.intent.dispatchId);
});
