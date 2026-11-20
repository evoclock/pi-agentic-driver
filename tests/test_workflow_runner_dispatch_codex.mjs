import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as dispatch from '../scripts/workflow_runner_dispatch.mjs';
import { run, initial } from '../scripts/workflow_runner_core.mjs';
import { fixtureAuthority } from './workflow_runner_authority_fixture.mjs';
import { specRequest } from '../scripts/workflow_runner_spec.mjs';

const scope = () => ({ kind: 'codex', account: 'synthetic-account', authority: { ledgerId: 'synthetic-grant' } });
const factory = (...args) => {
  assert.equal(typeof dispatch.padHarnessDriver, 'function');
  return dispatch.padHarnessDriver(...args);
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, kind = 'codex') {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-codex-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  mkdirSync(join(repo, 'skills'));
  const skill = '# Check\n## step: check\nCheck the committed artifact.\n';
  writeFileSync(join(repo, 'skills/check.md'), skill); writeFileSync(join(repo, 'artifact.md'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  const w = { schema: 'pad-workflow.v1', revision: git('rev-parse', 'HEAD'), repo, maxAttempts: 1,
    steps: [{ id: 'step-one', artifact: 'artifact.md', sha256: sha('after\n'),
      skill: { pack: 'synthetic', version: 'v1', path: 'skills/check.md', sha256: sha(skill), step: 'check' },
      procedure: { schema: 'pad-procedure.v1', checks: ['git-diff-check.v1'] },
      worker: { schema: 'pad-worker.v1', role: 'synthetic-worker', model: 'synthetic-model', repository: 'synthetic-repo' } }] };
  const store = join(repo, '.local/workflow-runner/task-one'), authority = fixtureAuthority(repo, store);
  w.spec = { schema: 'pad-workflow-spec-ref.v1', manifest: 'synthetic-spec.json', sha256: sha('synthetic manifest') };
  const request = specRequest(w, { ...initial(w), taskId: 'task-one' });
  const derived = { schema: 'pad-derived-stack.v1', skills: [], playbook: { name: 'synthetic', sha256: sha('synthetic playbook') }, harness: { kind }, specDigest: w.spec.sha256 };
  const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
  run(w, store, { id: 'synthetic-spec-claim', type: 'spec' }, { authority });
  run(w, store, { id: 'synthetic-spec', type: '_spec' }, { authority, specEventId: 'synthetic-spec-claim', specObservation: () => ({ ...request.binding,
    evidenceId: `spec-${randomUUID()}`, manifestSha256: w.spec.sha256, verdict: 'pass', reason: null, derived,
    derivedDigest: sha(canonical(derived)), chartSha256: null, confirmedChartSha256: null }) });
  run(w, store, { id: 'start', type: 'tick' }, { authority });
  return { w, store, authority, repo };
}
function seams(repo, outcome = 'spawned') {
  const calls = [];
  return { calls,
    loadSpawn: async () => ({ executeHerdrSpawnWorker: async (...args) => {
      calls.push(['spawn', ...args]);
      return { ok: outcome === 'spawned', status: outcome, role: 'synthetic-worker', paneId: 'synthetic-pane', worktreePath: repo };
    } }),
    nested: async (name, params) => {
      calls.push([name, params]);
      return { details: params.action === 'delivery'
        ? { ok: true, deliveryId: 'synthetic-delivery', role: 'synthetic-worker', agentKind: 'codex', deliveryState: 'answered' }
        : { ok: true, status: 'accepted', role: 'synthetic-worker', deliveryId: 'synthetic-delivery' } };
    } };
}
const send = (f, driver, options = {}) => dispatch.dispatchWorkflow(f.w, f.store, { id: 'dispatch', type: 'dispatch' }, driver,
  { authority: f.authority, readUserConfig: () => ({ model: { policy: 'subscription' } }), ...options });

// Why: the existing guarded spawn must receive explicit trusted bindings unchanged, not a second launch path.
test('codex binding present calls the existing guarded helper with exact values and no credential env', async () => {
  const s = seams('/synthetic/repo'), binding = scope(), context = { cwd: '/synthetic/repo', hasUI: false };
  const driver = await factory('codex', context, s.nested, undefined, binding, { loadSpawn: s.loadSpawn });
  assert.equal(driver.schema, 'pad-worker-kind-adapter.v1'); assert.equal(driver.kind, 'codex'); assert.equal(driver.host, 'local');
  const params = { placement: 'tab', role: 'synthetic-worker', model: 'synthetic-model', repository: 'synthetic-repo' };
  await driver.spawn({ params });
  assert.deepEqual(s.calls, [['spawn', { ...params, ...binding }, context, {}, undefined]]);
  assert.equal(s.calls[0][1].authority, binding.authority);
  assert.equal(Object.hasOwn(s.calls[0][3], 'env'), false);
  await driver.submit({ role: 'synthetic-worker', prompt: 'synthetic prompt' });
  await driver.delivery('synthetic-delivery');
  assert.deepEqual(s.calls.slice(1), [
    ['agentic_herdr_communication', { action: 'submit', role: 'synthetic-worker', prompt: 'synthetic prompt', timeoutMs: 1000 }],
    ['agentic_herdr_communication', { action: 'delivery', deliveryId: 'synthetic-delivery' }],
  ]);
});

// Why: absent or malformed binding fields cannot grant account or ledger scope or reach the guarded spawn.
test('each missing codex binding field returns a named HOLD with zero spawn calls', async () => {
  for (const field of ['kind', 'account', 'authority', 'ledgerId']) {
    const binding = scope(), s = seams('/synthetic/repo');
    if (field === 'ledgerId') delete binding.authority.ledgerId; else delete binding[field];
    const held = await factory('codex', {}, s.nested, undefined, binding, { loadSpawn: s.loadSpawn });
    assert.equal(held.move, 'wait'); assert.equal(held.reason, 'codex-binding-missing'); assert.equal(held.authorityCreated, false);
    assert.deepEqual(s.calls, []);
  }
});

// Why: the caller binding cannot override the issued kind, and Claude remains unserved.
test('kind mismatch and claude return named HOLD without fallback', async () => {
  const s = seams('/synthetic/repo');
  assert.equal((await factory('codex', {}, s.nested, undefined, { ...scope(), kind: 'pi' }, { loadSpawn: s.loadSpawn })).reason, 'harness-kind-mismatch');
  assert.equal((await factory('pi', {}, s.nested, undefined, scope(), { loadSpawn: s.loadSpawn })).reason, 'harness-kind-mismatch');
  assert.equal((await factory('claude', {}, s.nested, undefined, undefined, { loadSpawn: s.loadSpawn })).reason, 'harness-unavailable');
  assert.deepEqual(s.calls, []);
});

// Why: unavailable helper modules must hold before any external effect, rather than fall back to Pi.
test('missing codex helper returns HOLD and does not spawn', async () => {
  const s = seams('/synthetic/repo');
  const held = await factory('codex', {}, s.nested, undefined, scope(), { loadSpawn: async () => { throw Error('missing synthetic helper'); } });
  assert.equal(held.reason, 'harness-unavailable'); assert.deepEqual(s.calls, []);
});

// Why: the existing Pi nested tool path and its parameter shape must remain unchanged.
test('pi harness is unchanged', async () => {
  const calls = [];
  const driver = await factory('pi', {}, async (name, params) => { calls.push({ name, params }); return { details: { ok: true } }; });
  assert.equal(driver.kind, 'pi');
  await driver.spawn({ params: { role: 'synthetic-worker' } });
  assert.deepEqual(calls, [{ name: 'agentic_herdr_spawn_worker', params: { role: 'synthetic-worker' } }]);
});

// Why: factory selection must use only the durable issued harness and credentials must stay outside the prompt.
test('issued codex selects factory, submits and observes its matching delivery', async t => {
  const f = fixture(t), s = seams(f.repo), binding = scope(), kinds = [];
  const driver = async kind => { kinds.push(kind); return factory(kind, { cwd: f.repo }, s.nested, undefined, binding, { loadSpawn: s.loadSpawn }); };
  const result = await send(f, driver);
  assert.equal(result.reason, 'worker-submitted'); assert.deepEqual(kinds, ['codex']);
  const prompt = s.calls.find(([name]) => name === 'agentic_herdr_communication')[1].prompt;
  assert.doesNotMatch(prompt, /synthetic-account|synthetic-grant/);
  const observed = await dispatch.dispatchWorkflow(f.w, f.store, { id: 'delivery', type: 'delivery' }, driver, { authority: f.authority });
  assert.equal(observed.deliveryAcknowledged, true);
});

// Why: failed guards, missing bindings, missing helpers and mismatches must park with no prompt delivery.
test('unavailable harnesses park, and denied guards are never retried', async t => {
  for (const scenario of ['binding', 'helper', 'mismatch', 'claude', 'denied']) {
    const f = fixture(t, scenario === 'claude' ? 'claude' : 'codex'), s = seams(f.repo, scenario === 'denied' ? 'denied' : 'spawned');
    const driver = scenario === 'mismatch' ? { schema: 'pad-worker-kind-adapter.v1', kind: 'pi', host: 'local', spawn: async () => { throw Error('must not spawn'); }, submit() {}, delivery() {} }
      : kind => factory(kind, {}, s.nested, undefined, scenario === 'binding' ? undefined : scope(),
        { loadSpawn: scenario === 'helper' ? async () => { throw Error('missing'); } : s.loadSpawn });
    const result = await send(f, driver);
    assert.equal(result.reason, 'harness-unavailable', scenario); assert.equal(result.phase, 'parked');
    assert.equal(s.calls.filter(([name]) => name === 'spawn').length, scenario === 'denied' ? 1 : 0);
    assert.equal(s.calls.filter(([name]) => name === 'agentic_herdr_communication').length, 0);
    await dispatch.dispatchWorkflow(f.w, f.store, { id: 'again', type: 'dispatch' }, driver, { authority: f.authority });
    assert.equal(s.calls.filter(([name]) => name === 'spawn').length, scenario === 'denied' ? 1 : 0);
  }
});
