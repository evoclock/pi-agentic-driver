import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initial, decide, transition, run, readStatus } from './workflow_runner_authority_fixture.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Runner Test'); git(repo, 'config', 'user.email', 'runner@example.invalid');
  mkdirSync(join(repo, 'skills')); mkdirSync(join(repo, 'docs'));
  const skill = '# Skill\n## step: check\n1. Edit the declared file.\n';
  writeFileSync(join(repo, 'skills/doc.md'), skill);
  writeFileSync(join(repo, 'docs/demo.md'), 'before\n');
  writeFileSync(join(repo, 'docs/second.md'), 'before\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const step = (name, artifact, result) => ({ id: name, artifact, sha256: sha(result), skill: { pack: 'docskill', version: 'v1', path: 'skills/doc.md', sha256: sha(skill), step: 'check' } });
  const w = { schema: 'pad-workflow.v1', repo, revision: git(repo, 'rev-parse', 'HEAD'), maxAttempts: 2,
    steps: [step('doc', 'docs/demo.md', 'after\n'), step('second', 'docs/second.md', 'next\n')] };
  const store = join(repo, '.local/workflow-runner/task');
  const commit = (path = 'docs/demo.md', bytes = 'after\n') => {
    writeFileSync(join(repo, path), bytes); git(repo, 'add', path); git(repo, 'commit', '-qm', 'step result'); return git(repo, 'rev-parse', 'HEAD');
  };
  const receipt = (s, head) => ({ stepId: w.steps[s.step].id, epoch: s.epoch, revision: w.revision,
    skillRef: 'docskill/v1/check', commit: head, check: 'git-object-content', dispatchId: s.intent.dispatchId,
    dispatchEpoch: s.intent.epoch, dispatchWriter: s.intent.writerId, branch: s.intent.branch,
    stepBaseHead: s.intent.base, actor: s.intent.actor, writerId: s.intent.writerId });
  return { w, repo, store, commit, receipt };
}
const act = (f) => transition(f.w, initial(f.w), { id: 'act', type: 'tick' }).state;
const move = (f, s, id, type, extra = {}, adapter) => transition(f.w, s, { id, type, ...extra }, adapter);

// Why: a new Git commit cannot prove a step with no matching nonzero PAD-issued dispatch.
test('receipt rejects a foreign dispatch and requires a nonzero step dispatch', (t) => {
  const f = fixture(t), s = act(f), head = f.commit();
  assert.ok(s.intent.dispatchId && s.intent.dispatchId !== '0');
  assert.equal(move(f, s, 'foreign', 'receipt', { receipt: { ...f.receipt(s, head), dispatchId: 'foreign' } }).result.reason, 'receipt-rejected');
  assert.equal(move(f, s, 'zero', 'receipt', { receipt: { ...f.receipt(s, head), dispatchId: '0' } }).result.reason, 'receipt-rejected');
  const forged = { ...s, intent: { ...s.intent, dispatchId: '0' },
    pending: { stepId: s.intent.stepId, dispatchId: '0', epoch: s.epoch,
      writerId: s.intent.writerId, stepBaseHead: s.intent.base } };
  assert.equal(decide(f.w, forged).move, 'wait');
});

// Why: a receive-time epoch or writer must never relabel an older dispatched effect.
test('dispatch-time epoch and writer are immutable receipt attribution', (t) => {
  const f = fixture(t), s = act(f), head = f.commit();
  assert.equal(move(f, s, 'epoch', 'receipt', { receipt: { ...f.receipt(s, head), dispatchEpoch: 1 } }).result.reason, 'receipt-rejected');
  assert.equal(move(f, s, 'writer', 'receipt', { receipt: { ...f.receipt(s, head), dispatchWriter: 'other' } }).result.reason, 'receipt-rejected');
  assert.equal(move(f, s, 'good', 'receipt', { receipt: f.receipt(s, head) }).result.reason, 'verified-receipt');
});

// Why: cancellation must preserve a visible late observation without allowing a stopped step to complete.
test('cancel bumps the epoch and journals a late result as fenced', (t) => {
  const f = fixture(t), s = act(f), head = f.commit();
  const stopped = move(f, s, 'stop', 'cancel').state;
  assert.equal(stopped.epoch, 1);
  const late = move(f, stopped, 'late', 'receipt', { receipt: f.receipt(s, head) });
  assert.equal(late.result.reason, 'late-receipt-fenced');
  assert.equal(late.state.step, 0);
  assert.equal(late.state.phase, 'cancelled');
  assert.equal(late.state.history.at(-1).type, 'receipt');
});

// Why: a durable acknowledgement changes crash recovery; an unacknowledged effect needs exact readback.
test('ack gates resume of the same epoch and writer dispatch', (t) => {
  const f = fixture(t), s = act(f);
  const unknown = move(f, s, 'resume-unknown', 'resume').state;
  assert.equal(unknown.phase, 'parked');
  const ackFields = { dispatchId: s.intent.dispatchId, epoch: s.epoch, writerId: s.intent.writerId };
  assert.equal(move(f, s, 'forged-ack', 'ack', ackFields).result.reason, 'ack-unverified');
  const acked = move(f, s, 'ack', 'ack', ackFields,
    { acknowledge: (intent) => ({ dispatchId: intent.dispatchId, epoch: intent.epoch, writerId: intent.writerId }) }).state;
  assert.equal(acked.intent.ack, true);
  assert.equal(move(f, acked, 'resume-known', 'resume').state.phase, 'awaiting');
  assert.equal(move(f, { ...acked, epoch: 1 }, 'resume-stale', 'resume').state.phase, 'parked');
});

// Why: An acknowledged present effect cannot become eligible for replay through a contradictory absent readback.
test('absent readback after ack stays fenced without a second act', (t) => {
  const f = fixture(t), issued = act(f);
  const fields = { dispatchId: issued.intent.dispatchId, epoch: issued.epoch, writerId: issued.intent.writerId };
  const acked = move(f, issued, 'ack', 'ack', fields, { acknowledge: (intent) => ({
    dispatchId: intent.dispatchId, epoch: intent.epoch, writerId: intent.writerId,
  }) }).state;
  const parked = move(f, acked, 'park', 'tick').state;
  assert.equal(parked.phase, 'parked');
  const contradicted = move(f, parked, 'absent', 'readback', {}, { readback: (intent) => ({
    dispatchId: intent.dispatchId, epoch: intent.epoch, writerId: intent.writerId,
    branch: intent.branch, status: 'absent',
  }) });
  assert.equal(contradicted.result.reason, 'effect-fenced');
  assert.equal(contradicted.state.phase, 'parked');
  assert.equal(move(f, contradicted.state, 'retry', 'tick').result.move, 'wait');
  assert.equal(contradicted.state.attempts[0], 1);
});

// Why: untrusted or unknown readback may observe but must never release an uncertain effect for replay.
test('unknown readback parks and caller-claimed absence cannot resend', (t) => {
  const f = fixture(t), s = act(f);
  const parked = move(f, s, 'resume', 'resume').state;
  const unknown = move(f, parked, 'unknown', 'readback', { status: 'unknown' }).state;
  assert.equal(unknown.phase, 'parked');
  const forged = move(f, unknown, 'forged', 'readback', { status: 'absent' }).state;
  assert.equal(move(f, forged, 'tick', 'tick').result.move, 'wait');
  assert.equal(forged.attempts[0], 1);
});

// Why: only a trusted absent readback can spend the second attempt for this step, without consuming the next step's budget.
test('trusted absent readback permits exactly two attempts per step', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'act', type: 'tick' });
  run(f.w, f.store, { id: 'resume', type: 'resume' });
  const unknown = run(f.w, f.store, { id: 'unknown', type: 'readback', status: 'unknown' });
  assert.equal(unknown.phase, 'parked');
  const observed = run(f.w, f.store, { id: 'absent', type: 'readback' }, { readback: (intent) => ({ dispatchId: intent.dispatchId, epoch: intent.epoch,
    writerId: intent.writerId, branch: intent.branch, status: 'absent' }) });
  assert.equal(observed.phase, 'ready');
  const second = run(f.w, f.store, { id: 'again', type: 'tick' });
  assert.equal(second.move, 'act'); assert.equal(second.attempts, 2);
  const state = JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8'));
  assert.equal(state.attempts[0], 2);
  const head = f.commit();
  const accepted = run(f.w, f.store, { id: 'receipt', type: 'receipt', receipt: f.receipt(state, head) });
  assert.equal(accepted.reason, 'verified-receipt');
  assert.equal(run(f.w, f.store, { id: 'advance', type: 'tick' }).phase, 'ready');
  const next = run(f.w, f.store, { id: 'next', type: 'tick' });
  assert.equal(next.attempts, 1);
  assert.equal(readStatus(f.w, f.store).step, 1);
});

// Why: an unverified hint must not erase independently verified receipt evidence.
test('hint preserves verified result until the next advancing tick', (t) => {
  const f = fixture(t), s = act(f), head = f.commit();
  const verified = move(f, s, 'good', 'receipt', { receipt: f.receipt(s, head) }).state;
  const hinted = move(f, verified, 'hint', 'hint', { transitionId: 'hint-1' });
  assert.equal(hinted.result.reason, 'hint-observed');
  assert.deepEqual(hinted.state.pending, verified.pending);
  assert.equal(move(f, hinted.state, 'finish', 'tick').result.move, 'advance');
});

// Why: the receipt must carry the frozen branch/base and observed actor/writer, not invented caller labels.
test('receipt rejects missing or incorrect branch, base, actor and writer fields', (t) => {
  const f = fixture(t), s = act(f), head = f.commit(), good = f.receipt(s, head);
  for (const field of ['branch', 'stepBaseHead', 'actor', 'writerId']) {
    assert.ok(good[field], field);
    assert.equal(move(f, s, `missing-${field}`, 'receipt', { receipt: { ...good, [field]: undefined } }).result.reason, 'receipt-rejected');
    assert.equal(move(f, s, `wrong-${field}`, 'receipt', { receipt: { ...good, [field]: 'wrong' } }).result.reason, 'receipt-rejected');
  }
});

// Why: A caller's label is not enough: only matching Git content, the issued intent and its current dispatch epoch may advance.
test('unverified or relabeled results cannot advance the current dispatch', (t) => {
  const f = fixture(t), issued = act(f), head = f.commit(), good = f.receipt(issued, head);
  for (const [name, patch] of [
    ['unverified', { check: 'caller-claimed' }],
    ['old-epoch', { dispatchEpoch: issued.epoch - 1 }],
    ['wrong-writer', { dispatchWriter: 'writer-other' }],
    ['wrong-commit', { commit: issued.intent.base }],
  ]) {
    const rejected = move(f, issued, name, 'receipt', { receipt: { ...good, ...patch } });
    assert.equal(rejected.result.reason, 'receipt-rejected', name);
    assert.equal(rejected.state.pending, null, name);
    assert.notEqual(move(f, rejected.state, `tick-${name}`, 'tick').result.move, 'advance', name);
  }
  const successorEpoch = { ...issued, epoch: issued.epoch + 1 };
  const mislabeled = { ...good, epoch: successorEpoch.epoch, dispatchEpoch: successorEpoch.epoch };
  assert.equal(move(f, successorEpoch, 'receive-time-relabel', 'receipt', { receipt: mislabeled }).result.reason, 'receipt-rejected');
  const verified = move(f, issued, 'valid', 'receipt', { receipt: good });
  assert.equal(move(f, verified.state, 'advance', 'tick').result.move, 'advance');
  assert.equal(verified.result.procedureVerified, false); // Git evidence is not proof a worker followed the skill.
});

// Why: An old effect ID must not be accepted for a new dispatch even when its other receipt fields match.
test('exact dispatch ID gates receipt and pending advancement', (t) => {
  const f = fixture(t), first = act(f);
  const parked = move(f, first, 'resume', 'resume').state;
  const ready = move(f, parked, 'absent', 'readback', {}, {
    readback: (intent) => ({ dispatchId: intent.dispatchId, epoch: intent.epoch,
      writerId: intent.writerId, branch: intent.branch, status: 'absent' }),
  }).state;
  const second = move(f, ready, 'again', 'tick').state, head = f.commit();
  assert.notEqual(first.intent.dispatchId, second.intent.dispatchId);
  const oldId = first.intent.dispatchId;
  const rejected = move(f, second, 'old-id', 'receipt', { receipt: { ...f.receipt(second, head), dispatchId: oldId } });
  assert.equal(rejected.result.reason, 'receipt-rejected');
  assert.equal(rejected.state.pending, null);
  const accepted = move(f, second, 'new-id', 'receipt', { receipt: f.receipt(second, head) }).state;
  assert.equal(decide(f.w, { ...accepted, pending: { ...accepted.pending, dispatchId: oldId } }).move, 'wait');
  assert.equal(decide(f.w, accepted).move, 'advance');
});

// Why: A successor writer must retire an old dispatch by exact readback before spending another attempt.
test('successor epoch and writer cannot redispatch before reconciliation', (t) => {
  const f = fixture(t), issued = act(f), head = f.commit();
  // The core has no transfer event yet; model only a persisted successor fence, not a completed handoff.
  const successor = { ...issued, epoch: issued.epoch + 1, writerId: 'writer-successor' };
  assert.equal(move(f, successor, 'late', 'receipt', { receipt: f.receipt(issued, head) }).result.reason, 'receipt-rejected');
  const parked = move(f, successor, 'resume', 'resume').state;
  assert.equal(parked.phase, 'parked');
  assert.equal(move(f, parked, 'before-readback', 'tick').result.move, 'wait');
  const observed = (status) => ({ readback: (intent) => ({ dispatchId: intent.dispatchId,
    epoch: intent.epoch, writerId: intent.writerId, branch: intent.branch, status }) });
  const present = move(f, parked, 'old-present', 'readback', {}, observed('present')).state;
  assert.equal(present.phase, 'parked');
  assert.equal(move(f, present, 'still-no-resend', 'tick').result.move, 'wait');
  const absent = move(f, parked, 'old-absent', 'readback', {}, observed('absent')).state;
  assert.equal(absent.phase, 'ready');
  const retry = move(f, absent, 'retry', 'tick');
  assert.equal(retry.result.move, 'act');
  assert.equal(retry.state.intent.epoch, successor.epoch);
  assert.equal(retry.state.intent.writerId, successor.writerId);
});

// Why: Until a reviewed release path exists, hold must not silently resume or redispatch an uncertain effect.
test('hold stops redispatch even after readback and receipt events', (t) => {
  const f = fixture(t), issued = act(f), head = f.commit();
  const held = move(f, issued, 'hold', 'hold').state;
  assert.equal(held.phase, 'held');
  const readback = move(f, held, 'readback', 'readback', {}, {
    readback: () => { throw Error('held readback must not run'); },
  }).state;
  const late = move(f, readback, 'late', 'receipt', { receipt: f.receipt(issued, head) }).state;
  assert.equal(late.pending, null);
  assert.equal(move(f, late, 'after-hold', 'tick').result.move, 'settled');
  assert.equal(late.attempts[0], 1);
});

// Why: An unknown observation must not invoke even a caller-supplied absent adapter or spend the next attempt.
test('unknown readback never permits blind resend', (t) => {
  const f = fixture(t), issued = act(f), parked = move(f, issued, 'resume', 'resume').state;
  const unknown = move(f, parked, 'unknown', 'readback', { status: 'unknown' }, {
    readback: () => { throw Error('unknown cannot be translated to absence'); },
  });
  assert.equal(unknown.result.reason, 'readback-unknown');
  assert.equal(unknown.state.phase, 'parked');
  assert.equal(unknown.state.intent.dispatchId, issued.intent.dispatchId);
  assert.equal(unknown.state.attempts[0], 1);
  assert.equal(move(f, unknown.state, 'retry', 'tick').result.move, 'wait');
});

// Why: Terminal cancellation must absorb late receipts, resumed recovery, and subsequent ticks regardless of epoch bump.
test('cancel remains terminal after late observations', (t) => {
  const f = fixture(t), issued = act(f), head = f.commit();
  const stopped = move(f, issued, 'cancel', 'cancel').state;
  const late = move(f, stopped, 'late', 'receipt', { receipt: f.receipt(issued, head) });
  assert.equal(late.result.reason, 'late-receipt-fenced');
  const resumed = move(f, late.state, 'resume', 'resume').state;
  const readback = move(f, resumed, 'readback', 'readback', { status: 'absent' }).state;
  assert.equal(readback.phase, 'cancelled');
  assert.equal(readback.pending, null);
  assert.equal(move(f, readback, 'tick', 'tick').result.move, 'settled');
  assert.equal(readback.attempts[0], 1);
});
