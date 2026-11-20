import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { run, readAuthorizedStatus } from '../scripts/workflow_runner_core.mjs';
import { fixtureAuthority } from './workflow_runner_authority_fixture.mjs';
import { checkedSpecFixture } from './workflow_runner_spec_fixture.mjs';
import register from '../extensions/workflow-runner.js';
const sha = v => createHash('sha256').update(v).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const readUserConfig = () => ({ model: { policy: 'subscription' } });
const dispatch = async (w, store, event, driver, options = {}) => (await import('../scripts/workflow_runner_dispatch.mjs')).dispatchWorkflow(w, store, event, driver, { readUserConfig, ...options });
function fixture(t, requirement = true) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-dispatch-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Synthetic'); git(repo, 'config', 'user.email', 'synthetic@example.invalid');
  mkdirSync(join(repo, 'skills')); const skill = '# Check\n## step: check\nCheck the committed artifact.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill); writeFileSync(join(repo, 'artifact.md'), 'before\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const w = { schema: 'pad-workflow.v1', revision: git(repo, 'rev-parse', 'HEAD'), repo, maxAttempts: 1,
    steps: [{ id: 'step-one', artifact: 'artifact.md', sha256: sha('after\n'),
      skill: { pack: 'synthetic', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' },
      ...(requirement ? { procedure: { schema: 'pad-procedure.v1', checks: ['git-diff-check.v1'] } } : {}),
      worker: { schema: 'pad-worker.v1', role: 'synthetic-worker', model: 'synthetic-model', repository: 'synthetic-repo' } }] };
  const store = join(repo, '.local/workflow-runner/task-one');
  const authority = fixtureAuthority(repo, store);
  checkedSpecFixture(w, store, authority);
  run(w, store, { id: 'start', type: 'tick' }, { authority });
  const calls = [];
  const driver = { schema: 'pad-worker-kind-adapter.v1', kind: 'pi', host: 'local',
    async spawn(request) { calls.push('spawn'); assert.equal(readAuthorizedStatus(w, store, authority).intent.workerStage, 'claimed');
      assert.equal(request.binding.taskId, 'task-one');
      return { ok: true, status: 'spawned', role: 'synthetic-worker', paneId: 'synthetic-pane', repository: repo }; },
    async submit(request) { calls.push('submit'); assert.equal(readAuthorizedStatus(w, store, authority).intent.workerStage, 'prompt-claimed');
      assert.match(request.prompt, /inputDigest/);
      return { ok: true, status: 'accepted', role: 'synthetic-worker', deliveryId: 'synthetic-delivery' }; },
    async delivery() { calls.push('delivery'); return { ok: true, status: 'observed', role: 'synthetic-worker', deliveryId: 'synthetic-delivery', agentKind: 'pi', deliveryState: 'answered' }; } };
  return { repo, w, store, authority, driver, calls };
}

// Why: effects need durable claims and exact duplicate events must not spawn or prompt twice, including with async authority.
test('dispatch persists intent before guarded calls and never replays a duplicate', async t => {
  const f = fixture(t), event = { id: 'dispatch-one', type: 'dispatch' };
  const adapter = { authority: Object.fromEntries(Object.entries(f.authority).map(([method, call]) =>
    [method, async (...args) => call(...args)])) };
  const result = await dispatch(f.w, f.store, event, f.driver, adapter);
  assert.equal(result.reason, 'worker-submitted'); assert.equal(result.procedureVerified, false);
  await dispatch(f.w, f.store, event, f.driver, adapter);
  await dispatch(f.w, f.store, { id: 'dispatch-two', type: 'dispatch' }, f.driver, adapter);
  assert.deepEqual(f.calls, ['spawn', 'submit']);
});

// Why: the model refuses external effects when no frozen host-check requirement is defined.
test('real dispatch requires a procedure contract even for a valid worker route', async t => {
  const f = fixture(t, false);
  const result = await dispatch(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority });
  assert.equal(result.reason, 'procedure-required'); assert.deepEqual(f.calls, []);
});

// Why: spawn/submit exceptions and partial or wrong-target receipts are unknown effects, not permission to retry.
test('unknown effects park across restart without spawn or prompt replay', async t => {
  for (const stage of ['spawn', 'submit', 'partial', 'foreign']) {
    const f = fixture(t);
    if (stage === 'spawn' || stage === 'submit') f.driver[stage] = async () => { f.calls.push(stage); throw new Error('lost reply'); };
    if (stage === 'partial') f.driver.spawn = async () => { f.calls.push('spawn'); return { ok: false, status: 'partial' }; };
    if (stage === 'foreign') f.driver.spawn = async () => { f.calls.push('spawn'); return { ok: true, status: 'spawned', role: 'foreign', paneId: 'synthetic-pane', repository: f.repo }; };
    assert.equal((await dispatch(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority })).phase, 'parked');
    const before = [...f.calls];
    await dispatch(f.w, f.store, { id: 'restart', type: 'dispatch' }, f.driver, { authority: f.authority });
    assert.deepEqual(f.calls, before);
  }
});

// Why: a stop between spawn and handoff must prevent a prompt and cannot be repaired by resending.
test('owner stop during spawn fences the subsequent prompt', async t => {
  const f = fixture(t), spawn = f.driver.spawn;
  f.driver.spawn = async request => { const result = await spawn(request); await run(f.w, f.store, { id: 'stop', type: 'cancel' }, { authority: f.authority }); return result; };
  await dispatch(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority });
  assert.deepEqual(f.calls, ['spawn']);
});

// Why: task-bound transport readback never establishes host procedure verification and wrong deliveries remain unacknowledged.
test('delivery observation is separate and bound to the exact submitted delivery', async t => {
  const f = fixture(t);
  await dispatch(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, f.driver, { authority: f.authority });
  const read = f.driver.delivery;
  f.driver.delivery = async () => ({ ...(await read()), deliveryId: 'foreign-delivery' });
  assert.equal((await dispatch(f.w, f.store, { id: 'bad', type: 'delivery' }, f.driver, { authority: f.authority })).deliveryAcknowledged, false);
  f.driver.delivery = read;
  const result = await dispatch(f.w, f.store, { id: 'good', type: 'delivery' }, f.driver, { authority: f.authority });
  assert.equal(result.deliveryAcknowledged, true); assert.equal(result.procedureVerified, false);
  assert.deepEqual(f.calls.slice(0, 2), ['spawn', 'submit']);
});

// Why: a process lost after a journaled claim cannot spend that dispatch again, even with another event id.
test('crash after claim parks without calling the driver on restart', async t => {
  const f = fixture(t), event = { id: 'lost', type: 'dispatch' };
  assert.equal(run(f.w, f.store, event, { authority: f.authority }).move, 'spawn');
  await dispatch(f.w, f.store, event, f.driver, { authority: f.authority });
  await dispatch(f.w, f.store, { id: 'reopen', type: 'dispatch' }, f.driver, { authority: f.authority });
  assert.deepEqual(f.calls, []);
});

// Why: the CLI must route a dispatch event without invoking any live adapter when no worker intent exists.
test('CLI routes dispatch with no worker intent without live effects', t => {
  const f = fixture(t), wf = join(f.repo, 'workflow.json'), ef = join(f.repo, 'event.json');
  run(f.w, f.store, { id: 'stop-before-cli', type: 'cancel' }, { authority: f.authority });
  writeFileSync(wf, JSON.stringify(f.w)); writeFileSync(ef, JSON.stringify({ id: 'cli', type: 'dispatch' }));
  mkdirSync(join(f.repo, '.pi'));
  writeFileSync(join(f.repo, '.pi/workflow-runner-authority.json'), JSON.stringify({ kind: 'remote-do',
    baseUrl: 'https://authority.invalid', tenantId: 'tenant_0001', taskId: sha(f.store).slice(0, 32) }));
  const result = JSON.parse(execFileSync(process.execPath, ['--import', new URL('./workflow_runner_authority_http_fixture.mjs', import.meta.url).pathname,
    new URL('../scripts/pad-runner.mjs', import.meta.url).pathname,
    'run', '--workflow', wf, '--run-id', 'task-one', '--event', ef, '--store', join(f.repo, '.local/workflow-runner')],
    { cwd: f.repo, encoding: 'utf8', env: { ...process.env, PAD_TEST_AUTHORITY_REPO: f.repo, PAD_TEST_AUTHORITY_STORE: f.store } }));
  assert.equal(result.reason, 'dispatch-unavailable');
});

// Why: current branch/head changes must prevent handing the original frozen input to a worker.
test('changed input and forged private worker events cannot acquire a dispatch', async t => {
  const f = fixture(t);
  assert.equal(run(f.w, f.store, { id: 'forged', type: '_worker', status: 'submitted' }, { authority: f.authority }).reason, 'worker-observation-rejected');
  git(f.repo, 'commit', '--allow-empty', '-qm', 'new input');
  assert.equal((await dispatch(f.w, f.store, { id: 'changed', type: 'dispatch' }, f.driver, { authority: f.authority })).reason, 'dispatch-input-changed');
  assert.deepEqual(f.calls, []);
});

// Why: even trusted transport observations must match the task-bound dispatch tuple before they change durable worker state.
test('foreign worker observation cannot authorize the prompt stage', t => {
  const f = fixture(t);
  const claim = run(f.w, f.store, { id: 'claim', type: 'dispatch' }, { authority: f.authority });
  const result = run(f.w, f.store, { id: 'foreign', type: '_worker' }, { authority: f.authority, workerObservation: () => ({
    ...claim.intent.workerBinding, taskId: 'foreign-task', status: 'spawned', paneId: 'synthetic-pane' }) });
  assert.equal(result.reason, 'worker-observation-rejected');
  assert.equal(run(f.w, f.store, { id: 'handoff', type: '_prompt' }, { authority: f.authority }).reason, 'prompt-unavailable');
});

// Why: the Pi surface must use nested guarded tools, not direct terminal commands or private execution fallback.
test('Pi dispatch uses the guarded tool path and refuses absent nested-tool capability', async t => {
  const f = fixture(t), tools = new Map(); register({ registerTool: tool => tools.set(tool.name, tool) }, { authorityForRepository: async () => f.authority, readUserConfig });
  assert.ok(tools.has('agentic_workflow_dispatch'));
  const params = { workflow: f.w, taskId: 'task-one', event: { id: 'pi-dispatch', type: 'dispatch' } };
  const ctx = { cwd: f.repo, isProjectTrusted: () => true, hasUI: false };
  assert.equal((await tools.get('agentic_workflow_dispatch').execute('call', params, undefined, undefined, ctx)).details.reason, 'capability-unavailable');
  const nested = [];
  ctx.executeTool = async (name, input) => { nested.push(name);
    return { details: name === 'agentic_herdr_spawn_worker' ? { ok: true, status: 'spawned', role: 'synthetic-worker', paneId: 'synthetic-pane', repository: f.repo } : { ok: true, status: 'accepted', role: 'synthetic-worker', deliveryId: 'synthetic-delivery' } }; };
  const result = await tools.get('agentic_workflow_dispatch').execute('call', params, undefined, undefined, ctx);
  assert.equal(result.details.reason, 'worker-submitted');
  assert.deepEqual(nested, ['agentic_herdr_spawn_worker', 'agentic_herdr_communication']);
});

// Why: an existing intent is never sufficient permission to dispatch without configured authority.
test('dispatch without authority parks before any driver call', async t => {
  const f = fixture(t);
  const result = await dispatch(f.w, f.store, { id: 'missing-authority', type: 'dispatch' }, f.driver);
  assert.equal(result.reason, 'AUTHORITY_UNCONFIGURED'); assert.equal(result.phase, 'parked');
  assert.deepEqual(f.calls, []);
});
