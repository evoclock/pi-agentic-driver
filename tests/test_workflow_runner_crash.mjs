import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run } from './workflow_runner_authority_fixture.mjs';

const core = fileURLToPath(new URL('./workflow_runner_authority_fixture.mjs', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const sha = (text) => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Runner Test'); git(repo, 'config', 'user.email', 'runner@example.invalid');
  mkdirSync(join(repo, 'skills')); writeFileSync(join(repo, 'skills/doc.md'), '# Skill\n## step: check\n');
  writeFileSync(join(repo, 'demo.md'), 'before\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const workflow = { schema: 'pad-workflow.v1', repo, revision: git(repo, 'rev-parse', 'HEAD'), maxAttempts: 1,
    steps: [{ id: 'doc', artifact: 'demo.md', sha256: sha('after\n'), skill: { pack: 'docskill', version: 'v1', path: 'skills/doc.md', sha256: sha('# Skill\n## step: check\n'), step: 'check' } }] };
  return { workflow, store: join(repo, '.local/workflow-runner/task') };
}
async function deadLock(store) {
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(store, 'writer.lock'))},process.pid+':a60a953c-16a5-4a93-a81e-886fb6bd4352');console.log('ready');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

// Why: a killed writer's persisted act must resume as an uncertain intent, not dispatch a second effect.
test('SIGKILL owner lock is recovered and crash-resume parks without re-Act', async (t) => {
  const f = fixture(t);
  assert.equal(run(f.workflow, f.store, { id: 'act', type: 'tick' }).move, 'act');
  await deadLock(f.store);
  const resumed = run(f.workflow, f.store, { id: 'resume', type: 'tick' });
  assert.equal(resumed.phase, 'parked'); assert.equal(resumed.attempts, 1);
  const journal = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(x => x.result.move === 'act').length, 1);
});

// Why: A killed recovery claimant must leave a reclaimable guard so both later events and cancel remain possible.
test('SIGKILL during lock recovery cannot permanently block the handbrake', async (t) => {
  const f = fixture(t);
  run(f.workflow, f.store, { id: 'observe', type: 'look' });
  await deadLock(f.store);
  const guard = join(f.store, 'writer-recovery');
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(guard)},process.pid+':a60a953c-16a5-4a93-a81e-886fb6bd4352');console.log('guarded');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data'); child.kill('SIGKILL'); await once(child, 'exit');
  assert.equal(run(f.workflow, f.store, { id: 'tick', type: 'tick' }).move, 'act');
  assert.equal(run(f.workflow, f.store, { id: 'stop', type: 'cancel' }).reason, 'cancelled');
});

// Why: Three claimants delayed after observing a dead guard must not replace a successor's live lock or fork the journal.
test('three paused contenders cannot split a recovered journal', async (t) => {
  for (let round = 0; round < 3; round++) {
    const f = fixture(t), marker = join(f.workflow.repo, 'recovery-observations');
    run(f.workflow, f.store, { id: 'observe', type: 'look' });
    await deadLock(f.store);
    writeFileSync(join(f.store, 'writer-recovery'), readFileSync(join(f.store, 'writer.lock'), 'utf8'));
    const outcomes = await Promise.all(Array.from({ length: 3 }, (_, i) => new Promise((finish) => {
      const script = `import{run}from ${JSON.stringify(core)};import{appendFileSync}from 'node:fs';
        const pause=(stage)=>{appendFileSync(${JSON.stringify(marker)},'${i}:'+stage+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,stage==='guard'?${500 + i * 100}:200)};
        try{console.log(JSON.stringify(run(${JSON.stringify(f.workflow)},${JSON.stringify(f.store)},{id:'claim${round}-${i}',type:'tick'},{onRecoveryPause:pause})))}catch(error){console.log(JSON.stringify({error:error.message}))}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', data => { text += data; });
      child.on('close', () => finish(JSON.parse(text.trim())));
    })));
    assert.equal(existsSync(marker), true, 'pause hook must be reached');
    const winners = outcomes.filter(x => x.move === 'act').length;
    assert.ok(winners <= 1, JSON.stringify(outcomes));
    // Contention may fail all claimants closed; a later undelayed call must recover without a fork.
    if (!winners) assert.equal(run(f.workflow, f.store, { id: `retry${round}`, type: 'tick' }).move, 'act');
    const records = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(x => x.result.move === 'act').length, 1);
    assert.equal(run(f.workflow, f.store, { id: 'stop', type: 'cancel' }).reason, 'cancelled');
  }
});

// Why: Replacing the dead predecessor with the same token but another inode must not grant a new writer.
test('recovery refuses a changed predecessor inode', async (t) => {
  const f = fixture(t);
  run(f.workflow, f.store, { id: 'observe', type: 'look' });
  await deadLock(f.store);
  const lock = join(f.store, 'writer.lock');
  let injected = false;
  assert.throws(() => run(f.workflow, f.store, { id: 'tick', type: 'tick' }, {
    onRecoveryPause: (stage) => {
      if (stage !== 'lock') return;
      injected = true;
      const replacement = join(f.store, 'replacement-lock');
      writeFileSync(replacement, readFileSync(lock));
      renameSync(replacement, lock);
    },
  }), /writer lock changed/);
  assert.equal(injected, true);
});

// Why: A dead guard relabeled with a live PID during observation must fail even if the old writer is dead.
test('recovery rechecks the guard before claiming a generation', async (t) => {
  const f = fixture(t);
  run(f.workflow, f.store, { id: 'observe', type: 'look' });
  await deadLock(f.store);
  const guard = join(f.store, 'writer-recovery');
  writeFileSync(guard, readFileSync(join(f.store, 'writer.lock')));
  let injected = false;
  assert.throws(() => run(f.workflow, f.store, { id: 'tick', type: 'tick' }, {
    onRecoveryPause: (stage) => {
      if (stage !== 'guard') return;
      injected = true;
      writeFileSync(guard, `${process.pid}:a60a953c-16a5-4a93-a81e-886fb6bd4352`);
    },
  }), /recovery guard changed/);
  assert.equal(injected, true);
});

// Why: Four contenders delayed at both old restore boundaries must never vacate a live lock or fork one journal.
test('four paused contenders preserve one immutable writer generation', async (t) => {
  for (let round = 0; round < 3; round++) {
    const f = fixture(t), marker = join(f.workflow.repo, 'generation-observations');
    run(f.workflow, f.store, { id: 'observe', type: 'look' });
    await deadLock(f.store);
    writeFileSync(join(f.store, 'writer-recovery'), readFileSync(join(f.store, 'writer.lock')));
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((finish) => {
      const script = `import{run}from ${JSON.stringify(core)};import{appendFileSync}from 'node:fs';
        const pause=(stage)=>{appendFileSync(${JSON.stringify(marker)},'${i}:'+stage+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,stage==='guard'?${250 + i * 80}:stage==='lock'?${200 + i * 70}:500)};
        try{console.log(JSON.stringify(run(${JSON.stringify(f.workflow)},${JSON.stringify(f.store)},{id:'claim${round}-${i}',type:'tick'},{onRecoveryPause:pause})))}catch(error){console.log(JSON.stringify({error:error.message}))}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = ''; child.stdout.on('data', data => { text += data; });
      child.on('close', () => finish(JSON.parse(text.trim())));
    })));
    assert.equal(existsSync(marker), true);
    assert.match(readFileSync(marker, 'utf8'), /pre-publish/, 'test must pause where restore used to vacate the lock');
    const winners = outcomes.filter(x => x.move === 'act').length;
    assert.ok(winners <= 1, JSON.stringify(outcomes));
    if (!winners) assert.equal(run(f.workflow, f.store, { id: `retry${round}`, type: 'tick' }).move, 'act');
    const records = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(x => x.result.move === 'act').length, 1);
    assert.equal(run(f.workflow, f.store, { id: 'stop', type: 'cancel' }).reason, 'cancelled');
  }
});

// Why: a forged completion marker with the same token but another inode cannot retire a live writer.
test('copied completion marker cannot authorize another act', (t) => {
  const f = fixture(t);
  assert.equal(run(f.workflow, f.store, { id: 'observe', type: 'look' }).move, 'wait');
  const lock = join(f.store, 'writer.g.1.lock'), done = join(f.store, 'writer.g.1.done');
  unlinkSync(done);
  copyFileSync(lock, done);
  assert.throws(() => run(f.workflow, f.store, { id: 'act', type: 'tick' }), /completion mismatch/);
  assert.equal(readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
});

// Why: concurrent recovery must never allow more than one initial act after the same stale lock.
test('eight contenders after a dead writer produce at most one act', async (t) => {
  const f = fixture(t);
  // Create the task binding without spending an action, then leave a dead owner lock.
  run(f.workflow, f.store, { id: 'observe', type: 'look' });
  await deadLock(f.store);
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((finish) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {run} from ${JSON.stringify(core)};try{console.log(JSON.stringify(run(${JSON.stringify(f.workflow)},${JSON.stringify(f.store)},{id:'tick${i}',type:'tick'})))}catch(e){console.log(JSON.stringify({error:e.message}))}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', data => { text += data; }); child.on('close', () => finish(JSON.parse(text.trim())));
  })));
  assert.equal(outcomes.filter(x => x.move === 'act').length, 1, JSON.stringify(outcomes));
  const records = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(x => x.result.move === 'act').length, 1);
});

// Why: Compaction deletes old completed generation names. A contender that observed
// an older predecessor before that deletion must not re-create a retired name and
// run beside the writer that holds the newest generation.
test('stale contender cannot reuse a compacted writer generation', async (t) => {
  const f = fixture(t);
  run(f.workflow, f.store, { id: 'observe', type: 'look' });
  const child = spawn(process.execPath, ['-e', 'console.log(1);setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data'); const deadPid = child.pid; child.kill('SIGKILL'); await once(child, 'exit');
  writeFileSync(join(f.store, 'writer.g.2.lock'), `${deadPid}:a60a953c-16a5-4a93-a81e-886fb6bd4352`);
  let polled = 0, second = null;
  const stale = () => run(f.workflow, f.store, { id: 'stale', type: 'tick' }, {
    onRecoveryPause: (stage) => {
      if (stage !== 'pre-publish') return;
      for (; polled < 16; polled++) run(f.workflow, f.store, { id: `poll${polled}`, type: 'look' });
      assert.equal(existsSync(join(f.store, 'writer.g.3.lock')), false, 'compaction must have removed generation 3');
    },
    onBeforePublish: () => { second = run(f.workflow, f.store, { id: 'fresh', type: 'tick' }); },
  });
  assert.throws(stale, /acquired by another process/);
  assert.equal(polled, 16);
  assert.equal(second, null);
  const records = readFileSync(join(f.store, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(new Set(records.map(x => x.prev)).size, records.length, 'journal must not fork');
  assert.equal(run(f.workflow, f.store, { id: 'fresh', type: 'tick' }).move, 'act');
});
