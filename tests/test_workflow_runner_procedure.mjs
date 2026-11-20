import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { run } from './workflow_runner_authority_fixture.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-procedure-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Synthetic Test');
  git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  mkdirSync(join(repo, 'skills'));
  const skill = '# Checks\n## step: check\nRun the declared host check.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill);
  writeFileSync(join(repo, 'artifact.md'), 'before\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const w = { schema: 'pad-workflow.v1', revision: git(repo, 'rev-parse', 'HEAD'), repo, maxAttempts: 1,
    steps: [{ id: 'step-one', artifact: 'artifact.md', sha256: sha('after\n'),
      skill: { pack: 'synthetic', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' },
      procedure: { schema: 'pad-procedure.v1', checks: ['git-diff-check.v1'] } }] };
  const store = join(repo, '.local/workflow-runner/task-one');
  const event = (id, type = 'procedure') => ({ id, type });
  return { repo, w, store, event };
}
const observation = request => ({ ...request.binding, evidenceId: 'evidence-one',
  checks: request.checks.map(id => ({ id, exitStatus: 0, outputDigest: sha('') })) });

// Why: worker assertions cannot replace the host's closed check execution or its persisted one-use result.
test('host check verifies a frozen procedure; duplicate event never invokes it twice', t => {
  const f = fixture(t);
  const act = run(f.w, f.store, f.event('start', 'tick'));
  assert.equal(act.procedureVerified, false);
  let calls = 0;
  const adapter = { observeProcedure(request) { calls++; return observation(request); } };
  const event = { ...f.event('check'), procedureVerified: true };
  const checked = run(f.w, f.store, event, adapter);
  assert.equal(checked.procedureVerified, true);
  assert.equal(checked.deliveryAcknowledged, false);
  assert.equal(run(f.w, f.store, event, adapter).duplicate, true);
  assert.equal(calls, 1);
  assert.equal(run(f.w, f.store, f.event('replay'), adapter).reason, 'procedure-rejected');
  const state = JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8'));
  assert.equal(state.procedureEvidence.evidenceId, 'evidence-one');
});

// Why: the model's binding guard must reject foreign, stale, mismatched and replayed host observations.
test('procedure observation binds every dispatch dimension and requires successful complete checks', t => {
  for (const field of ['taskId', 'stepId', 'epoch', 'writerId', 'dispatchId', 'inputDigest', 'requirementDigest', 'commit']) {
    const f = fixture(t);
    run(f.w, f.store, f.event('start', 'tick'));
    const result = run(f.w, f.store, f.event('check'), { observeProcedure(request) {
      return { ...observation(request), [field]: field === 'epoch' ? 9 : 'foreign' };
    } });
    assert.equal(result.procedureVerified, false, field);
    assert.equal(result.reason, 'procedure-rejected', field);
  }
  for (const bad of [null, {}, { checks: [] }, { evidenceId: '' },
    { checks: [{ id: 'git-diff-check.v1', exitStatus: 1, outputDigest: sha('failed') }] },
    { checks: [{ id: 'git-diff-check.v1', exitStatus: 0, outputDigest: 'not-a-digest' }] }]) {
    const f = fixture(t);
    run(f.w, f.store, f.event('start', 'tick'));
    const result = run(f.w, f.store, f.event('check'), { observeProcedure(request) {
      return bad === null ? null : Object.keys(bad).length ? { ...observation(request), ...bad } : {};
    } });
    assert.equal(result.procedureVerified, false);
  }
});

// Why: production verification must actually execute the declared bounded host command, not read a worker's claimed exit code.
test('default observer executes git check and captures only its exit status and output digest', t => {
  const f = fixture(t);
  run(f.w, f.store, f.event('start', 'tick'));
  writeFileSync(join(f.repo, 'artifact.md'), 'bad trailing whitespace   \n');
  git(f.repo, 'add', 'artifact.md'); git(f.repo, 'commit', '-qm', 'bad input');
  assert.equal(run(f.w, f.store, { ...f.event('bad'), exitStatus: 0 }).procedureVerified, false);
  writeFileSync(join(f.repo, 'artifact.md'), 'after\n');
  git(f.repo, 'add', 'artifact.md'); git(f.repo, 'commit', '-qm', 'good input');
  const result = run(f.w, f.store, f.event('good'));
  assert.equal(result.procedureVerified, true);
  const state = JSON.parse(readFileSync(join(f.store, 'state.json'), 'utf8'));
  assert.match(state.procedureEvidence.checks[0].outputDigest, /^[a-f0-9]{64}$/);
  assert.equal(state.procedureEvidence.checks[0].exitStatus, 0);
});

// Why: procedure observations are for exact committed input, and artifact acceptance remains an independent prerequisite.
test('only the checked commit with a valid Git receipt can advance a required procedure', t => {
  const f = fixture(t);
  const act = run(f.w, f.store, f.event('start', 'tick'));
  assert.equal(run(f.w, f.store, f.event('early')).procedureVerified, true);
  writeFileSync(join(f.repo, 'artifact.md'), 'after\n');
  git(f.repo, 'add', 'artifact.md'); git(f.repo, 'commit', '-qm', 'candidate');
  const receipt = { stepId: 'step-one', epoch: 0, dispatchEpoch: 0, revision: f.w.revision,
    skillRef: 'synthetic/v1/check', commit: git(f.repo, 'rev-parse', 'HEAD'), check: 'git-object-content',
    dispatchId: act.intent.dispatchId, dispatchWriter: act.intent.writerId, writerId: act.intent.writerId,
    actor: act.intent.actor, branch: act.intent.branch, stepBaseHead: act.intent.base };
  assert.equal(run(f.w, f.store, { ...f.event('receipt', 'receipt'), receipt }).reason, 'verified-receipt');
  assert.equal(run(f.w, f.store, f.event('blocked', 'tick')).reason, 'procedure-required');
  assert.equal(run(f.w, f.store, f.event('current')).procedureVerified, true);
  assert.equal(run(f.w, f.store, f.event('advance', 'tick')).move, 'advance');
  assert.equal(run(f.w, f.store, f.event('late')).procedureVerified, false);
});

// Why: an owner stop during the bounded host command must fence publication of its proof.
test('owner cancellation during host observation cannot publish verified evidence', t => {
  const f = fixture(t);
  run(f.w, f.store, f.event('start', 'tick'));
  const result = run(f.w, f.store, f.event('check'), { observeProcedure(request) {
    run(f.w, f.store, f.event('stop', 'cancel'));
    return observation(request);
  } });
  assert.equal(result.move, 'settled');
  assert.notEqual(result.procedureVerified, true);
});

// Why: the public CLI must use the same host observer rather than accept worker-supplied observation JSON.
test('CLI procedure event runs the closed host check', t => {
  const f = fixture(t);
  run(f.w, f.store, f.event('start', 'tick'));
  const workflowFile = join(f.repo, 'workflow.json'), eventFile = join(f.repo, 'event.json');
  writeFileSync(workflowFile, JSON.stringify(f.w)); writeFileSync(eventFile, JSON.stringify(f.event('cli-check')));
  mkdirSync(join(f.repo, '.pi'));
  writeFileSync(join(f.repo, '.pi/workflow-runner-authority.json'), JSON.stringify({ kind: 'remote-do',
    baseUrl: 'https://authority.invalid', tenantId: 'tenant_0001', taskId: sha(f.store).slice(0, 32) }));
  const output = execFileSync(process.execPath, ['--import', new URL('./workflow_runner_authority_http_fixture.mjs', import.meta.url).pathname,
    new URL('../scripts/pad-runner.mjs', import.meta.url).pathname,
    'run', '--workflow', workflowFile, '--run-id', 'task-one', '--event', eventFile, '--store', join(f.repo, '.local/workflow-runner')],
    { encoding: 'utf8', env: { ...process.env, PAD_TEST_AUTHORITY_REPO: f.repo, PAD_TEST_AUTHORITY_STORE: f.store } });
  assert.equal(JSON.parse(output).procedureVerified, true);
});

// Why: a frozen command id is a closed capability, never arbitrary worker-provided shell text.
test('unsupported check contracts are rejected before any dispatch', t => {
  const f = fixture(t);
  f.w.steps[0].procedure.checks = ['shell-anything.v1'];
  assert.throws(() => run(f.w, f.store, f.event('start', 'tick')), /invalid procedure requirement/);
});
