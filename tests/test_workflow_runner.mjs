import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, symlinkSync, rmSync, existsSync, realpathSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initial, decide, transition, run, readStatus } from './workflow_runner_authority_fixture.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Runner Test'); git(repo, 'config', 'user.email', 'runner@example.invalid');
  mkdirSync(join(repo, 'skills')); mkdirSync(join(repo, 'docs'));
  const skill = '# Document one change\n## step: check\n1. Edit the declared file.\n2. Check its committed bytes.\n';
  writeFileSync(join(repo, 'skills', 'doc.md'), skill);
  writeFileSync(join(repo, 'docs', 'demo.md'), 'before\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const w = { schema: 'pad-workflow.v1', revision: git(repo, 'rev-parse', 'HEAD'), repo, maxAttempts: 2, steps: [{ id: 'doc', skill: { pack: 'docskill', version: 'v1', path: 'skills/doc.md', sha256: sha(skill), step: 'check' }, artifact: 'docs/demo.md', sha256: sha('after\n') }] };
  const store = join(repo, '.local', 'workflow-runner', 'task');
  const commit = () => { writeFileSync(join(repo, 'docs/demo.md'), 'after\n'); git(repo, 'add', 'docs/demo.md'); git(repo, 'commit', '-qm', 'document change'); return git(repo, 'rev-parse', 'HEAD'); };
  const receipt = (head, dispatch = existsSync(join(store, 'state.json')) ? JSON.parse(readFileSync(join(store, 'state.json'), 'utf8')).intent : null) => ({
    stepId: 'doc', epoch: 0, revision: w.revision, skillRef: 'docskill/v1/check', commit: head,
    check: 'git-object-content', dispatchId: dispatch?.dispatchId, dispatchEpoch: dispatch?.epoch,
    dispatchWriter: dispatch?.writerId, branch: dispatch?.branch, stepBaseHead: dispatch?.base,
    actor: dispatch?.actor, writerId: dispatch?.writerId });
  return { repo, w, store, commit, receipt };
}

// Why: the Gap5 Wake/WakeTick/Receipt/Finish trace must complete a real capped store without a new effect.
test('final evidence reaches DONE beyond the ordinary history cap', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'cap-act', type: 'tick' });
  run(f.w, f.store, { id: 'cap-park', type: 'tick' });
  // Collapse the model's polling prefix into an authenticated fixture checkpoint;
  // terminal events below still traverse the real durable run() admission path.
  let capped = transition(f.w, JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8')),
    { id: 'cap-park', type: 'tick' }).state;
  for (let i = 2; i < 1024; i++) capped = transition(f.w, capped, { id: `cap-look-${i}`, type: 'look' }).state;
  const bytes = readFileSync(join(f.store, 'journal.jsonl'));
  const prev = JSON.parse(bytes.toString().trim().split('\n').at(-1)).checksum;
  const snapshot = { offset: bytes.length, prefixHash: sha(bytes), state: capped, prev };
  const fixtureKeys = join(f.repo, '.local', 'workflow-runner', '.keys');
  const fixtureKey = readFileSync(join(fixtureKeys, readdirSync(fixtureKeys)[0]), 'utf8');
  const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort((a, b) => a.localeCompare(b)).map(k => [k, v[k]])) : v);
  const checksum = createHmac('sha256', Buffer.from(fixtureKey, 'hex')).update(canonical(snapshot)).digest('hex');
  writeFileSync(join(f.store, 'checkpoint.json'), JSON.stringify({ ...snapshot, checksum }));
  const head = f.commit();
  assert.throws(() => run(f.w, f.store, { id: 'cap-invalid', type: 'receipt', receipt: {} }), /run history limit/);
  assert.equal(run(f.w, f.store, { id: 'cap-wake', type: 'wake', source: 'commit', commit: head, transitionId: 'cap-transition' }).reason, 'verified-wake-recorded');
  assert.throws(() => run(f.w, f.store, { id: 'cap-wake-again', type: 'wake', source: 'commit', commit: head, transitionId: 'cap-other-transition' }), /run history limit/);
  assert.equal(run(f.w, f.store, { id: 'cap-wake-tick', type: 'tick' }).phase, 'awaiting');
  const receipt = { id: 'cap-receipt', type: 'receipt', receipt: f.receipt(head) };
  assert.equal(run(f.w, f.store, receipt).reason, 'verified-receipt');
  assert.equal(run(f.w, f.store, receipt).duplicate, true);
  assert.throws(() => run(f.w, f.store, { ...receipt, id: 'cap-replacement' }), /run history limit/);
  assert.equal(run(f.w, f.store, { id: 'cap-finish', type: 'tick' }).phase, 'done');
  const state = JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8'));
  assert.equal(state.history.length, 1028);
  assert.equal(state.attempts[0], 1);
  for (let i = 0; i < 20; i++) assert.equal(run(f.w, f.store, { id: `cap-stop-${i}`, type: i % 2 ? 'hold' : 'cancel' }).reason, 'done');
  assert.equal(JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8')).history.length, 1028);
});

// Why: RepeatControl must stutter after either owner stop, even with new input ids at the cap.
test('settled owner controls do not grow capped history', (t) => {
  const f = fixture(t);
  for (const type of ['cancel', 'hold']) {
    let state = initial(f.w);
    state.history = Array.from({ length: 1024 }, (_, i) => ({ id: `prior-${i}` }));
    state = transition(f.w, state, { id: 'first-stop', type }).state;
    assert.equal(state.history.length, 1025);
    const epoch = state.epoch;
    for (let i = 0; i < 50; i++) {
      const out = transition(f.w, state, { id: `repeat-${i}`, type: i % 2 ? 'hold' : 'cancel' });
      assert.equal(out.state, state);
      assert.equal(out.duplicate, true);
      assert.equal(out.state.epoch, epoch);
    }
  }
});

// The action names correspond to WorkflowRunner.tla: Act, ObserveGood/Bad,
// Advance, Park, Wake, Crash/Resume (reopen), Cancel, LateResult, Handbrake.
// Why: a real commit must advance once while replayed or conflicting events cannot debit or complete twice.
test('one move per tick, independently verified commit receipt, DONE and dedup', (t) => {
  const f = fixture(t);
  const act = run(f.w, f.store, { id: 'tick1', type: 'tick' });
  assert.equal(act.move, 'act'); assert.equal(act.attempts, 1);
  assert.equal(act.procedureDeclared, true); assert.equal(act.procedureVerified, false);
  assert.equal(run(f.w, f.store, { id: 'tick1', type: 'tick' }).move, 'wait');
  const head = f.commit();
  assert.equal(run(f.w, f.store, { id: 'bad', type: 'receipt', receipt: { ...f.receipt(head), skillRef: 'fake/v1/check' } }).reason, 'receipt-rejected');
  assert.equal(run(f.w, f.store, { id: 'good', type: 'receipt', receipt: f.receipt(head) }).reason, 'verified-receipt');
  assert.equal(run(f.w, f.store, { id: 'tick2', type: 'tick' }).move, 'advance');
  const journal = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.at(-1).state.phase, 'done'); assert.equal(journal.at(-1).state.step, 1);
  assert.equal(journal.filter(x => x.event.id === 'tick1').length, 1);
  assert.throws(() => run(f.w, f.store, { id: 'tick1', type: 'cancel' }), /event-id conflict/);
  assert.throws(() => run({ ...f.w, maxAttempts: 4 }, f.store, { id: 'changed', type: 'tick' }), /revision mismatch|invalid workflow/);
});

// Why: an unacknowledged effect after restart must park, while an observed commit can wake it without a second attempt.
test('reopen parks uncertain intent; look and usage pause do not spend attempt', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'act', type: 'tick' });
  // A fresh invocation reads the committed journal; without an acknowledgement
  // it parks instead of reissuing Act (the crash window in the model).
  // This is a reopen, not a process crash. Stale locks require explicit reconciliation.
  const recovered = run(f.w, f.store, { id: 'resume', type: 'tick' });
  assert.equal(recovered.phase, 'parked'); assert.equal(recovered.attempts, 1);
  const looked = run(f.w, f.store, { id: 'look', type: 'look' });
  assert.equal(looked.looks, 1); assert.equal(looked.attempts, 1);
  assert.equal(run(f.w, f.store, { id: 'idle', type: 'tick' }).reason, 'no-new-evidence');
  assert.equal(run(f.w, f.store, { id: 'forged', type: 'wake', source: 'commit', commit: '0'.repeat(40), transitionId: 'w1', verified: true }).reason, 'wake-rejected');
  const head = f.commit();
  assert.equal(run(f.w, f.store, { id: 'wake1', type: 'wake', source: 'commit', commit: head, transitionId: 'w2' }).reason, 'verified-wake-recorded');
  assert.equal(run(f.w, f.store, { id: 'wake-tick', type: 'tick' }).phase, 'awaiting');
  assert.equal(run(f.w, f.store, { id: 'evidence', type: 'receipt', receipt: f.receipt(head) }).reason, 'verified-receipt');
  assert.equal(run(f.w, f.store, { id: 'advance', type: 'tick' }).phase, 'done');
});

// Why: stopping an epoch must make a late but otherwise correct commit receipt inert.
test('cancel and handbrake fence late results and never advance', (t) => {
  for (const type of ['cancel', 'hold']) {
    const f = fixture(t);
    run(f.w, f.store, { id: 'act', type: 'tick' });
    const head = f.commit();
    const halted = run(f.w, f.store, { id: 'stop', type });
    assert.equal(halted.move, 'settled'); assert.equal(halted.epoch, 1);
    assert.equal(run(f.w, f.store, { id: 'late', type: 'receipt', receipt: f.receipt(head) }).reason,
      type === 'cancel' ? 'late-receipt-fenced' : 'receipt-rejected');
    assert.equal(run(f.w, f.store, { id: 'tick', type: 'tick' }).move, 'settled');
    assert.equal(JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8')).step, 0);
  }
});

// Why: changing a caller-controlled digest or padding the steps list must not undo a cancelled procedure.
test('cancel binds each artifact and checked procedure regardless of digest or duplicate steps', (t) => {
  const f = fixture(t);
  assert.equal(run(f.w, f.store, { id: 'act', type: 'tick' }).move, 'act');
  assert.equal(run(f.w, f.store, { id: 'stop', type: 'cancel' }).move, 'settled');
  const base = f.w.steps[0];
  for (const [name, steps] of [
    ['digest', [{ ...base, sha256: 'f'.repeat(64) }]],
    ['duplicate', [base, { ...base, id: 'copy' }]],
    ['case', [{ ...base, artifact: 'docs/Demo.md' }]],
    ['trailing', [{ ...base, artifact: 'docs/demo.md/' }]],
  ]) {
    const store = join(f.repo, '.local', 'workflow-runner', name);
    assert.throws(() => run({ ...f.w, steps }, store, { id: `tick-${name}`, type: 'tick' }),
      /bound to a different task run|invalid artifact contract/);
    assert.equal(existsSync(store), false);
  }
});

// Why: a confirmed stop during a live transition must block publication of that tick's act and journal record.
test('concurrent owner halt before act publication fences the in-flight tick', (t) => {
  const f = fixture(t);
  let stopped;
  const result = run(f.w, f.store, { id: 'act', type: 'tick' }, {
    onBeforePublish: () => { stopped = run(f.w, f.store, { id: 'stop', type: 'cancel' }); },
  });
  assert.equal(stopped.move, 'settled');
  assert.equal(result.move, 'settled');
  assert.equal(existsSync(join(f.store, 'halt.json')), true);
  assert.equal(existsSync(join(f.store, 'journal.jsonl')), false);
  assert.equal(run(f.w, f.store, { id: 'later', type: 'tick' }).move, 'settled');
});

// Why: an owner stop during journal fsync must suppress the outward act even when its intent was already recorded.
test('owner halt after journal fsync suppresses the outward act and parks evidence', (t) => {
  const f = fixture(t);
  let stopped;
  const result = run(f.w, f.store, { id: 'act', type: 'tick' }, {
    onAfterPersist: () => { stopped = run(f.w, f.store, { id: 'stop', type: 'cancel' }); },
  });
  assert.equal(stopped.move, 'settled');
  assert.equal(result.move, 'settled');
  assert.equal(readStatus(f.w, f.store).phase, 'held');
  const journal = readFileSync(join(f.store, 'journal.jsonl'), 'utf8');
  assert.equal(journal.trim().split('\n').length, 1);
  assert.equal(run(f.w, f.store, { id: 'act', type: 'tick' }).move, 'settled');
});

// Why: migrated whole-list bindings cannot silently lose their old cancel facts under a per-step index.
test('old binding store requires reconciliation before a new task folder exists', (t) => {
  const f = fixture(t);
  const bindings = join(f.repo, '.local/workflow-runner/.contracts');
  mkdirSync(bindings, { recursive: true });
  writeFileSync(join(bindings, 'a'.repeat(64)), 'legacy-store');
  assert.throws(() => run(f.w, f.store, { id: 'act', type: 'tick' }), /legacy workflow binding/);
  assert.equal(existsSync(f.store), false);
});

// Why: bounded delta/snapshot replay and exact retired-lock facts must resist a provider's no-compaction vote.
test('256 polls keep journal bytes and lock names bounded while preserving stop facts', (t) => {
  const f = fixture(t);
  let proposals = 0;
  for (let i = 0; i < 256; i++) {
    assert.equal(run(f.w, f.store, { id: `look-${i}`, type: 'look' }, {
      decisionsApi: { proposeCompaction: () => { proposals++; return { compact: false }; } },
    }).move, 'wait');
  }
  assert.ok(proposals > 0);
  const names = readdirSync(f.store);
  const bytes = names.reduce((sum, name) => sum + statSync(join(f.store, name)).size, 0);
  assert.ok(names.length < 40, `unbounded names: ${names.length}`);
  assert.ok(bytes < 500_000, `unbounded bytes: ${bytes}`);
  assert.equal(readStatus(f.w, f.store).looks, 256);
  const retired = JSON.parse(readFileSync(join(f.store, 'lock-summary.json'), 'utf8')).retired;
  assert.ok(retired.some(entry => entry.generation === 1 && /^\d+:/.exec(entry.token) !== null));
  assert.equal(run(f.w, f.store, { id: 'stop', type: 'cancel' }).phase, 'cancelled');
  assert.notEqual(run(f.w, f.store, { id: 'late', type: 'tick' }).move, 'act');
  assert.equal(run(f.w, f.store, { id: 'look-0', type: 'look' }).move, 'settled');
});

// Why: compaction must preserve exact completed lock tokens, and a replaced summary must fail closed.
test('retired lock facts are exact and authenticated across generation cleanup', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'look-0', type: 'look' });
  const first = readFileSync(join(f.store, 'writer.g.1.lock'), 'utf8');
  for (let i = 1; i < 30; i++) run(f.w, f.store, { id: `look-${i}`, type: 'look' });
  const summaryPath = join(f.store, 'lock-summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.retired[0].generation, 1);
  assert.equal(summary.retired[0].token, first);
  assert.equal(existsSync(join(f.store, 'writer.g.1.lock')), false);
  summary.retired[0].token = `${process.pid}:00000000-0000-4000-8000-000000000000`;
  writeFileSync(summaryPath, JSON.stringify(summary));
  assert.throws(() => run(f.w, f.store, { id: 'later', type: 'tick' }), /lock summary integrity failure/);
});

// Why: each shortest unsafe TLC path must map to a real-code refusal, not only a green model assertion.
test('replay saved identity, halt, writer, fact and growth counterexample paths', (t) => {
  const saved = JSON.parse(readFileSync(join(import.meta.dirname, '../docs/design/workflow-runner/Fix4Runner-traces.json'), 'utf8'));
  assert.equal(saved.witnesses.length, 5);
  for (const witness of saved.witnesses) {
    const f = fixture(t);
    if (witness.id === 'identity-alias') {
      assert.deepEqual(witness.actions, ['Cancel', 'Claim(v2)', 'PrePublish', 'Act']);
      run(f.w, f.store, { id: 'stop', type: 'cancel' });
      const other = join(f.repo, '.local/workflow-runner/alias');
      assert.throws(() => run({ ...f.w, steps: [{ ...f.w.steps[0], sha256: 'e'.repeat(64) }] },
        other, { id: 'retry', type: 'tick' }), /bound to a different task run/);
      assert.equal(existsSync(other), false);
    } else if (witness.id === 'halt-race') {
      assert.deepEqual(witness.actions, ['Claim', 'Cancel', 'PrePublish', 'Act']);
      const result = run(f.w, f.store, { id: 'act', type: 'tick' }, {
        onBeforePublish: () => { run(f.w, f.store, { id: 'stop', type: 'cancel' }); },
      });
      assert.equal(result.move, 'settled');
      assert.equal(existsSync(join(f.store, 'journal.jsonl')), false);
    } else if (witness.id === 'old-restore-fork') {
      assert.deepEqual(witness.actions.slice(0, 2), ['Claim(1)', 'Claim(2)']);
      const result = run(f.w, f.store, { id: 'first', type: 'tick' }, {
        onBeforePublish: () => assert.throws(() => run(f.w, f.store,
          { id: 'second', type: 'tick' }), /already in progress/),
      });
      assert.equal(result.move, 'act');
      assert.equal(readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
    } else if (witness.id === 'lossy-compaction') {
      assert.deepEqual(witness.actions, ['Cancel', 'Look', 'Snapshot', 'Compact']);
      run(f.w, f.store, { id: 'stop', type: 'cancel' });
      for (let n = 0; n < 33; n++) run(f.w, f.store, { id: `poll-${n}`, type: 'look' });
      assert.equal(readStatus(f.w, f.store).phase, 'cancelled');
      assert.ok(existsSync(join(f.store, 'checkpoint.json')));
      assert.ok(existsSync(join(f.store, 'lock-summary.json')));
    } else if (witness.id === 'unbounded-polls') {
      assert.deepEqual(witness.actions, ['Cancel', 'Look', 'Snapshot', 'Look', 'Look']);
      run(f.w, f.store, { id: 'stop', type: 'cancel' });
      for (let n = 0; n < 33; n++) run(f.w, f.store, { id: `poll-${n}`, type: 'look' });
      assert.ok(readdirSync(f.store).length < 40);
    } else assert.fail(`unknown TLC witness ${witness.id}`);
  }
});

// Why: altering the authenticated checkpoint cannot hide a cancelled task or mint a new act.
test('damaged periodic checkpoint fails closed after 32 delta events', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 32; i++) run(f.w, f.store, { id: `look-${i}`, type: 'look' });
  const checkpoint = join(f.store, 'checkpoint.json');
  const record = JSON.parse(readFileSync(checkpoint, 'utf8'));
  record.state.phase = 'ready'; record.state.looks = 0;
  writeFileSync(checkpoint, JSON.stringify(record));
  assert.throws(() => run(f.w, f.store, { id: 'act', type: 'tick' }), /checkpoint integrity failure/);
  assert.equal(run(f.w, f.store, { id: 'stop', type: 'cancel' }).move, 'settled');
  assert.equal(readStatus(f.w, f.store).phase, 'held');
  assert.equal(run(f.w, f.store, { id: 'late', type: 'tick' }).move, 'settled');
});

// Why: an optional Decisions API failure must not leave the writer's generation
// unfinished and wedge the next tick; hard compaction remains deterministic.
test('throwing Decisions API cannot wedge a completed writer', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) {
    assert.equal(run(f.w, f.store, { id: `poll${i}`, type: 'look' }, {
      decisionsApi: { proposeCompaction: () => { throw Error('offline'); } },
    }).move, 'wait');
  }
  assert.equal(run(f.w, f.store, { id: 'later', type: 'look' }).move, 'wait');
});

// Why: removing commit, head, epoch or wake-source checks would admit forged progress.
test('deliberate broken-control counterexamples: self-report, stale head, wake bool', (t) => {
  const f = fixture(t); const s = initial(f.w);
  const before = transition(f.w, s, { id: 'a', type: 'tick' }).state;
  assert.equal(decide(f.w, before).move, 'wait');
  const head = f.commit();
  const bad = [{ ...f.receipt(head, before.intent), commit: '0'.repeat(40) }, { ...f.receipt(head, before.intent), check: 'worker-says-pass' }, { ...f.receipt(head, before.intent), epoch: 9 }];
  for (let i = 0; i < bad.length; i++) assert.equal(transition(f.w, before, { id: `bad${i}`, type: 'receipt', receipt: bad[i] }).result.reason, 'receipt-rejected');
  writeFileSync(join(f.repo, 'docs', 'unrelated.md'), 'new head\n');
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'move head without changing expected artifact');
  assert.equal(transition(f.w, before, { id: 'old-head', type: 'receipt', receipt: f.receipt(head, before.intent) }).result.reason, 'receipt-rejected');
  const forged = transition(f.w, { ...before, phase: 'parked' }, { id: 'wake', type: 'wake', source: 'commit', transitionId: 'fake', verified: true, commit: '0'.repeat(40) });
  assert.equal(forged.result.reason, 'wake-rejected');
});

// Why: A nonexistent Git object must never be treated as a valid artifact commit even with an issued dispatch ID.
test('standalone invalid commit receipt is rejected', (t) => {
  const f = fixture(t), act = run(f.w, f.store, { id: 'act', type: 'tick' });
  assert.equal(run(f.w, f.store, { id: 'invalid', type: 'receipt',
    receipt: f.receipt('0'.repeat(40), act.intent) }).reason, 'receipt-rejected');
  assert.notEqual(run(f.w, f.store, { id: 'next', type: 'tick' }).move, 'advance');
});

// Why: valid artifact bytes from a prior commit cannot prove the current HEAD after another commit moves it.
test('wrong-head receipt is refused before the step can advance', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'act', type: 'tick' });
  const prior = f.commit();
  writeFileSync(join(f.repo, 'docs/unrelated.md'), 'move head\n');
  git(f.repo, 'add', 'docs/unrelated.md'); git(f.repo, 'commit', '-qm', 'unrelated later commit');
  assert.notEqual(prior, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(run(f.w, f.store, { id: 'old-head', type: 'receipt', receipt: f.receipt(prior) }).reason, 'receipt-rejected');
  const next = run(f.w, f.store, { id: 'next', type: 'tick' });
  assert.notEqual(next.move, 'advance');
  assert.equal(next.step, 0);
});

// Why: A self-checksummed appended record cannot un-cancel a run or forge DONE without an authorized transition.
test('forged journal record cannot overturn a stop or invent completion', (t) => {
  for (const targetPhase of ['ready', 'done']) {
    const f = fixture(t);
    run(f.w, f.store, { id: 'act', type: 'tick' });
    run(f.w, f.store, { id: 'stop', type: 'cancel' });
    const file = join(f.store, 'journal.jsonl');
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const last = records.at(-1), state = structuredClone(last.state);
    state.phase = targetPhase;
    if (targetPhase === 'ready') state.attempts[0] = 0;
    if (targetPhase === 'done') state.step = 1;
    const event = { id: 'forged', type: 'tick' };
    const result = { move: targetPhase === 'done' ? 'advance' : 'wait' };
    state.history.push({ id: event.id, result });
    const body = { prev: last.checksum, event, state, result };
    const canonical = (v) => JSON.stringify(v, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    appendFileSync(file, JSON.stringify({ ...body, checksum: sha(canonical(body)) }) + '\n');
    assert.throws(() => run(f.w, f.store, { id: 'next', type: 'tick' }), /journal integrity failure/);
  }
});

// Why: A harmless key or deleted index must never mint a new budget after cancellation.
test('cancel cannot be undone by changing the workflow or deleting the index', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'act', type: 'tick' });
  run(f.w, f.store, { id: 'stop', type: 'cancel' });
  assert.throws(() => run({ ...f.w, note: 'harmless' }, join(f.repo, '.local/workflow-runner/other'), { id: 'again', type: 'tick' }), /invalid workflow/);
  rmSync(join(f.repo, '.local/workflow-runner/.contracts'), { recursive: true });
  const other = join(f.repo, '.local/workflow-runner/other');
  assert.throws(() => run(f.w, other, { id: 'rebind', type: 'tick' }), /binding|index|contract/);
  assert.equal(existsSync(other), false);
});

// Why: Nested caller keys and lowering the attempt budget cannot mint a fresh cancelled task under another run ID.
test('cancel binds nested step identity and reduced maxAttempts across task IDs', (t) => {
  const f = fixture(t), original = f.w;
  run(original, f.store, { id: 'act', type: 'tick' });
  run(original, f.store, { id: 'stop', type: 'cancel' });
  const variants = [
    { ...original, steps: [{ ...original.steps[0], note: 1 }] },
    { ...original, steps: [{ ...original.steps[0], skill: { ...original.steps[0].skill, note: 1 } }] },
    { ...original, maxAttempts: 1 },
  ];
  for (let index = 0; index < variants.length; index++) {
    const store = join(f.repo, '.local/workflow-runner', `other${index}`);
    assert.throws(() => run(variants[index], store, { id: `retry${index}`, type: 'tick' }), /invalid workflow|invalid skill step|bound to a different|binding/);
    assert.equal(existsSync(store), false);
  }
});

for (const [alias, change] of [
  ['skill version', (f) => { f.w.steps[0].skill.version = 'v9'; }],
  ['skill pack', (f) => { f.w.steps[0].skill.pack = 'renamed'; }],
  ['procedure case', (f) => { f.w.steps[0].skill.step = 'CHECK'; }],
  ['skill path prefix', (f) => { f.w.steps[0].skill.path = './skills/doc.md'; }],
  ['artifact path prefix', (f) => { f.w.steps[0].artifact = './docs/demo.md'; }],
  ['step ID', (f) => { f.w.steps[0].id = 'renamed'; }],
  ['step ID case', (f) => { f.w.steps[0].id = 'DOC'; }],
  ['later revision', (f) => {
    git(f.repo, 'commit', '--allow-empty', '-qm', 'later unchanged skill');
    f.w.revision = git(f.repo, 'rev-parse', 'HEAD');
  }],
]) {
  // Why: Cosmetic caller labels cannot turn a cancelled artifact-and-procedure task into a new budget.
  test(`cancel identity rejects ${alias} under a new task ID`, (t) => {
    const f = fixture(t);
    run(f.w, f.store, { id: 'act', type: 'tick' });
    run(f.w, f.store, { id: 'stop', type: 'cancel' });
    change(f);
    const other = join(f.repo, '.local/workflow-runner/other');
    assert.throws(() => run(f.w, other, { id: 'retry', type: 'tick' }), /bound to a different|binding|invalid workflow|invalid skill|invalid artifact/);
    assert.equal(existsSync(other), false);
  });
}

// Why: G8's engine backstop accepts100 but rejects larger delivery budgets without weakening the bound.
test('activation accepts100 attempts and rejects budgets beyond the engine backstop', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => run({ ...f.w, maxAttempts: 100 }, f.store, { id: 'act', type: 'tick' }));
  assert.throws(() => run({ ...f.w, maxAttempts: 101 }, f.store, { id: 'too-many', type: 'tick' }), /invalid workflow/);
});

// Why: a commit that predates intent or belongs to an earlier step cannot prove this step.
test('pre-existing commit and repeated two-step receipt cannot reach DONE', (t) => {
  const f = fixture(t);
  git(f.repo, 'commit', '--allow-empty', '-qm', 'base marker');
  writeFileSync(join(f.repo, 'docs/demo.md'), 'after\n'); git(f.repo, 'add', 'docs/demo.md'); git(f.repo, 'commit', '-qm', 'pre-existing artifact');
  const pre = git(f.repo, 'rev-parse', 'HEAD');
  const one = run(f.w, f.store, { id: 'a', type: 'tick' });
  assert.equal(one.intent.base, pre);
  assert.equal(run(f.w, f.store, { id: 'b', type: 'receipt', receipt: f.receipt(pre) }).reason, 'receipt-rejected');
  const copy = { ...f.w, steps: [f.w.steps[0], { ...f.w.steps[0], id: 'second' }] };
  const g = fixture(t); g.w.steps = copy.steps;
  run(g.w, g.store, { id: 'a', type: 'tick' });
  const head = g.commit();
  assert.equal(run(g.w, g.store, { id: 'b', type: 'receipt', receipt: g.receipt(head) }).reason, 'verified-receipt');
  assert.equal(run(g.w, g.store, { id: 'c', type: 'tick' }).phase, 'ready');
  assert.equal(run(g.w, g.store, { id: 'd', type: 'tick' }).move, 'act');
  assert.equal(run(g.w, g.store, { id: 'e', type: 'receipt', receipt: { ...g.receipt(head), stepId: 'second' } }).reason, 'receipt-rejected');
});

// Why: conflicting persistent state cannot revoke a stop or mint another run ID.
test('symlink, forged journal and second task ID fail closed', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'a', type: 'tick' });
  const refused = join(f.repo, '.local/workflow-runner/another');
  assert.throws(() => run(f.w, refused, { id: 'b', type: 'tick' }), /bound to a different/);
  assert.equal(existsSync(refused), false);
  const journal = join(f.store, 'journal.jsonl');
  appendFileSync(journal, JSON.stringify({ event: { id: 'bad', type: 'tick' }, state: initial(f.w) }) + '\n');
  assert.throws(() => run(f.w, f.store, { id: 'b', type: 'tick' }), /journal integrity/);
});

// Why: Cancelling an exhausted run must preserve its terminal phase instead of changing epoch or outcome.
test('cancel after exhausted is settled without reopening the run', (t) => {
  const f = fixture(t); f.w.maxAttempts = 1;
  run(f.w, f.store, { id: 'act', type: 'tick' });
  run(f.w, f.store, { id: 'park', type: 'tick' });
  run(f.w, f.store, { id: 'absent', type: 'readback' }, { readback: (intent) => ({
    dispatchId: intent.dispatchId, epoch: intent.epoch, writerId: intent.writerId,
    branch: intent.branch, status: 'absent',
  }) });
  const exhausted = run(f.w, f.store, { id: 'budget', type: 'tick' });
  assert.equal(exhausted.phase, 'exhausted');
  const cancelled = run(f.w, f.store, { id: 'stop', type: 'cancel' });
  assert.equal(cancelled.reason, 'exhausted');
  assert.equal(cancelled.phase, 'exhausted');
  assert.equal(cancelled.epoch, exhausted.epoch);
});

// Why: An owner cancel must leave a durable halt marker when a torn journal cannot be replayed safely.
test('cancel settles with a halt marker on an unrecoverable journal', (t) => {
  const f = fixture(t);
  run(f.w, f.store, { id: 'act', type: 'tick' });
  appendFileSync(join(f.store, 'journal.jsonl'), '{broken');
  const stopped = run(f.w, f.store, { id: 'stop', type: 'cancel' });
  assert.equal(stopped.reason, 'cancel');
  assert.equal(stopped.reconciliationRequired, true);
  assert.equal(existsSync(join(f.store, 'halt.json')), true);
  assert.equal(run(f.w, f.store, { id: 'after', type: 'tick' }).move, 'settled');
});

// Why: An owner can stop a previously bound run even when its lock, key or index cannot be trusted.
test('owner cancel safely halts empty lock and damaged key or index', (t) => {
  for (const damage of ['empty-lock', 'bad-key', 'missing-key', 'missing-index']) {
    const f = fixture(t);
    run(f.w, f.store, { id: 'act', type: 'tick' });
    const root = join(f.repo, '.local/workflow-runner');
    const key = join(root, '.keys', readdirSync(join(root, '.keys'))[0]);
    if (damage === 'empty-lock') writeFileSync(join(f.store, 'writer.lock'), '');
    if (damage === 'bad-key') writeFileSync(key, 'bad-key');
    if (damage === 'missing-key') unlinkSync(key);
    if (damage === 'missing-index') rmSync(join(root, '.contracts'), { recursive: true });
    assert.throws(() => run(f.w, f.store, { id: 'untrusted', type: 'tick' }), undefined, damage);
    const stopped = run(f.w, f.store, { id: 'stop', type: 'cancel' });
    assert.equal(stopped.move, 'settled', damage);
    assert.equal(stopped.reason, 'cancel', damage);
    assert.equal(stopped.reconciliationRequired, true, damage);
    assert.equal(existsSync(join(f.store, 'halt.json')), true, damage);
    assert.equal(readStatus(f.w, f.store).phase, 'held', damage);
    assert.equal(run(f.w, f.store, { id: 'later', type: 'tick' }).move, 'settled', damage);
  }
});

// Why: A live reused recovery PID or an EPERM observation cannot deny the owner's durable stop.
test('owner cancel halts when guard PID is live or cannot be signalled', (t) => {
  for (const scenario of ['live-guard', 'eperm-guard', 'live-lock']) {
    const f = fixture(t);
    run(f.w, f.store, { id: 'act', type: 'tick' });
    const token = 'a60a953c-16a5-4a93-a81e-886fb6bd4352';
    writeFileSync(join(f.store, 'writer.lock'), `${scenario === 'live-lock' ? process.pid : 999999}:${token}`);
    if (scenario !== 'live-lock') writeFileSync(join(f.store, 'writer-recovery'), `${scenario === 'live-guard' ? process.pid : 1}:${token}`);
    const originalKill = process.kill;
    if (scenario === 'eperm-guard') process.kill = (pid, signal) => {
      if (pid === 1 && signal === 0) { const error = new Error('kill EPERM'); error.code = 'EPERM'; throw error; }
      return originalKill(pid, signal);
    };
    try {
      const halted = run(f.w, f.store, { id: 'stop', type: 'cancel' });
      assert.equal(halted.reason, 'cancel', scenario);
      assert.equal(halted.reconciliationRequired, true, scenario);
      assert.equal(existsSync(join(f.store, 'halt.json')), true, scenario);
      assert.equal(readStatus(f.w, f.store).phase, 'held', scenario);
      assert.equal(run(f.w, f.store, { id: 'later', type: 'tick' }).move, 'settled', scenario);
    } finally { process.kill = originalKill; }
  }
});

// Why: live HEAD alone is insufficient when its declared artifact is wrong.
test('wrong artifact bytes and wrong receipt revision fail independently', (t) => {
  const f = fixture(t); run(f.w, f.store, { id: 'a', type: 'tick' });
  writeFileSync(join(f.repo, 'docs/demo.md'), 'different\n');
  git(f.repo, 'add', 'docs/demo.md'); git(f.repo, 'commit', '-qm', 'wrong artifact');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  assert.equal(run(f.w, f.store, { id: 'badbytes', type: 'receipt', receipt: f.receipt(head) }).reason, 'receipt-rejected');
  const valid = f.commit();
  assert.equal(run(f.w, f.store, { id: 'badrevision', type: 'receipt', receipt: { ...f.receipt(valid), revision: 'b'.repeat(40) } }).reason, 'receipt-rejected');
});

// Why: public claim and path cannot be swapped under a valid checkout.
test('activation rejects mismatched skill and noncanonical repository', (t) => {
  const f = fixture(t);
  assert.throws(() => run({ ...f.w, repo: join(f.repo, 'docs') }, f.store, { id: 'a', type: 'tick' }), /canonical root/);
  assert.throws(() => run({ ...f.w, revision: 'a'.repeat(40) }, f.store, { id: 'badrev', type: 'tick' }), /revision must be a commit/);
  const undeclared = structuredClone(f.w); undeclared.steps[0].skill.step = 'invented';
  assert.throws(() => run(undeclared, f.store, { id: 'badstep', type: 'tick' }), /procedure declaration mismatch/);
  writeFileSync(join(f.repo, 'skills/doc.md'), 'tampered skill\n');
  assert.throws(() => run(f.w, f.store, { id: 'b', type: 'tick' }), /skill content mismatch/);
});

// Why: two attempts belong to each step; exhausting step two must never be disguised as DONE.
test('budget exhaustion is per-step and explicit', (t) => {
  const f = fixture(t);
  f.w.steps.push({ ...f.w.steps[0], id: 'second' });
  run(f.w, f.store, { id: 'a', type: 'tick' });
  const head = f.commit();
  run(f.w, f.store, { id: 'b', type: 'receipt', receipt: f.receipt(head) });
  assert.equal(run(f.w, f.store, { id: 'c', type: 'tick' }).phase, 'ready');
  const first = run(f.w, f.store, { id: 'd', type: 'tick' });
  assert.equal(first.move, 'act'); assert.equal(first.attempts, 1);
  const readback = (intent) => ({ dispatchId: intent.dispatchId, epoch: intent.epoch,
    writerId: intent.writerId, branch: intent.branch, status: 'absent' });
  run(f.w, f.store, { id: 'resume1', type: 'resume' });
  assert.equal(run(f.w, f.store, { id: 'absent1', type: 'readback' }, { readback }).phase, 'ready');
  const second = run(f.w, f.store, { id: 'again', type: 'tick' });
  assert.equal(second.move, 'act'); assert.equal(second.attempts, 2);
  run(f.w, f.store, { id: 'resume2', type: 'resume' });
  assert.equal(run(f.w, f.store, { id: 'absent2', type: 'readback' }, { readback }).phase, 'ready');
  const exhausted = run(f.w, f.store, { id: 'end', type: 'tick' });
  assert.equal(exhausted.phase, 'exhausted'); assert.equal(exhausted.move, 'settled');
  assert.deepEqual(JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8')).attempts, [1, 2]);
});

// Why: a task store must remain private and a non-parked run must ignore early wake hints.
test('symlinked store and wake while not parked fail closed', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, '.local/workflow-runner'), { recursive: true });
  const outside = mkdtempSync(join(f.repo, '.local', 'outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, f.store);
  assert.throws(() => run(f.w, f.store, { id: 'a', type: 'tick' }), /private store must not escape/);
  const g = fixture(t); run(g.w, g.store, { id: 'a', type: 'tick' });
  const head = g.commit();
  assert.equal(run(g.w, g.store, { id: 'early', type: 'wake', source: 'commit', commit: head, transitionId: 'w1' }).reason, 'wake-not-parked');
});

// Why: The 1,024-event history cap must stop polling and new work, not the owner's
// stop. A cancel or hold at the cap has to settle; otherwise a run that hit the cap
// with an uncertain dispatch outstanding could never be halted.
test('owner cancel and hold still settle at the run history cap', (t) => {
  const f = fixture(t);
  const atCap = transition(f.w, initial(f.w), { id: 'a', type: 'tick' }).state;
  for (let i = atCap.history.length; i < 1024; i++) atCap.history.push({ id: `poll${i}`, type: 'look', result: { move: 'wait' } });
  assert.throws(() => transition(f.w, atCap, { id: 'poll', type: 'look' }), /run history limit/);
  assert.equal(transition(f.w, atCap, { id: 'stop', type: 'cancel' }).result.reason, 'cancelled');
  assert.equal(transition(f.w, atCap, { id: 'brake', type: 'hold' }).result.reason, 'handbrake');
});
