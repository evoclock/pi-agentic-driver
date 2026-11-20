import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import workflowRunner from '../extensions/workflow-runner.js';
import { createFakeAuthority } from '../scripts/workflow_runner_authority.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'runner-test-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Runner Test'); git(repo, 'config', 'user.email', 'runner@example.invalid');
  mkdirSync(join(repo, 'skills')); mkdirSync(join(repo, 'docs'));
  const skill = '# Skill\n## step: check\n1. Edit docs/demo.md.\n2. Check it.\n';
  writeFileSync(join(repo, 'skills/doc.md'), skill); writeFileSync(join(repo, 'docs/demo.md'), 'before\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const workflow = { schema: 'pad-workflow.v1', repo, revision: git(repo, 'rev-parse', 'HEAD'), maxAttempts: 1,
    steps: [{ id: 'docs', artifact: 'docs/demo.md', sha256: sha('after\n'),
      skill: { pack: 'docskill', version: 'v1', path: 'skills/doc.md', sha256: sha(skill), step: 'check' } }] };
  const authority = createFakeAuthority({ tenantId: 'tenant_0001', taskId: 'task_000001' });
  const tools = new Map(); workflowRunner({ registerTool: (tool) => tools.set(tool.name, tool) }, { authorityForRepository: async () => authority });
  const ctx = { cwd: repo, hasUI: false, isProjectTrusted: () => true, ui: { confirm: async () => { throw Error('no dialog'); } } };
  const call = (name, params, context = ctx) => tools.get(name).execute('call', params, undefined, undefined, context).then(x => x.details);
  return { repo, workflow, tools, ctx, call };
}

// Why: the separate guarded dispatch entry must register while run/tick/status keep their non-authorizing reducer behavior.
test('seven Pi tools register and run/tick/status share one non-authorizing state', async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()].sort(), ['agentic_workflow_cancel', 'agentic_workflow_dispatch', 'agentic_workflow_gate', 'agentic_workflow_handbrake', 'agentic_workflow_run', 'agentic_workflow_status', 'agentic_workflow_tick']);
  const params = { workflow: f.workflow, taskId: 'task' };
  const first = await f.call('agentic_workflow_run', { ...params, eventId: 'tick1' });
  assert.equal(first.move, 'act'); assert.equal(first.authorityCreated, false);
  assert.equal((await f.call('agentic_workflow_status', params)).phase, 'awaiting');
  assert.equal((await f.call('agentic_workflow_run', { ...params, eventId: 'tick1' })).duplicate, true);
  writeFileSync(join(f.repo, 'docs/demo.md'), 'after\n'); git(f.repo, 'add', 'docs/demo.md'); git(f.repo, 'commit', '-qm', 'change');
  const receipt = { stepId: 'docs', epoch: 0, revision: f.workflow.revision,
    skillRef: 'docskill/v1/check', commit: git(f.repo, 'rev-parse', 'HEAD'), check: 'git-object-content',
    dispatchId: first.intent.dispatchId, dispatchEpoch: first.intent.epoch,
    dispatchWriter: first.intent.writerId, branch: first.intent.branch,
    stepBaseHead: first.intent.base, actor: first.intent.actor, writerId: first.intent.writerId };
  assert.equal((await f.call('agentic_workflow_tick', { ...params, event: { id: 'receipt', type: 'receipt', receipt } })).reason, 'verified-receipt');
  assert.equal((await f.call('agentic_workflow_tick', { ...params, event: { id: 'advance', type: 'tick' } })).phase, 'done');
  assert.equal((await f.call('agentic_workflow_status', params)).phase, 'done');
});

// Why: the host gate is a separate entry and cannot accept private or unrelated event types.
test('agentic_workflow_gate registers and runs only the spec event', async t => {
  const f = fixture(t), tool = f.tools.get('agentic_workflow_gate');
  assert.ok(tool, 'G7 Workflow Gate tool must register');
  assert.equal(tool.label, 'Workflow Gate');
  const params = { workflow: f.workflow, taskId: 'task', event: { id: 'gate', type: 'spec' } };
  const result = await f.call('agentic_workflow_gate', params);
  assert.equal(result.authorityCreated, false);
  for (const type of ['_spec', 'tick', 'dispatch']) await assert.rejects(f.call('agentic_workflow_gate', { ...params, event: { id: 'bad', type } }), /invalid bounded/);
});

// Why: a model tool call cannot cancel, release a hold, select another checkout, or smuggle owner control via tick.
test('owner controls and foreign scopes fail closed without a native confirmation', async (t) => {
  const f = fixture(t), params = { workflow: f.workflow, taskId: 'task', eventId: 'stop' };
  assert.equal((await f.call('agentic_workflow_cancel', params)).reason, 'owner-confirmation-required');
  assert.equal((await f.call('agentic_workflow_handbrake', { ...params, action: 'off' })).reason, 'release-reconciliation-unavailable');
  await assert.rejects(f.call('agentic_workflow_tick', { ...params, event: { id: 'stop', type: 'cancel' } }), /invalid bounded/);
  await assert.rejects(f.call('agentic_workflow_run', params, { ...f.ctx, cwd: resolve('.') }), /current trusted checkout/);
});

// Why: CLI and Pi must share the per-step cancel fence, not mint fresh IDs for caller-only digest or step-list changes.
test('cancelled artifact and procedure cannot be re-run through CLI or Pi aliases', async (t) => {
  const f = fixture(t);
  const confirmed = { ...f.ctx, hasUI: true, ui: { confirm: async () => true } };
  assert.equal((await f.call('agentic_workflow_run', { workflow: f.workflow, taskId: 'original', eventId: 'act' })).move, 'act');
  assert.equal((await f.call('agentic_workflow_cancel', { workflow: f.workflow, taskId: 'original', eventId: 'stop' }, confirmed)).move, 'settled');
  const base = f.workflow.steps[0];
  const aliases = [
    ['digest', [{ ...base, sha256: 'f'.repeat(64) }]],
    ['duplicate', [base, { ...base, id: 'copy' }]],
    ['trailing', [{ ...base, artifact: 'docs/demo.md/' }]],
  ];
  const workflowFile = join(f.repo, 'workflow.json'), eventFile = join(f.repo, 'event.json');
  writeFileSync(eventFile, JSON.stringify({ id: 'tick', type: 'tick' }));
  for (const [label, steps] of aliases) {
    const workflow = { ...f.workflow, steps };
    writeFileSync(workflowFile, JSON.stringify(workflow));
    const cliId = `cli-${label}`, piId = `pi-${label}`;
    const output = spawnSync(process.execPath, ['scripts/pad-runner.mjs', 'run', '--workflow', workflowFile,
      '--run-id', cliId, '--event', eventFile, '--store', join(f.repo, '.local/workflow-runner')], { encoding: 'utf8' });
    assert.equal(output.status, 2, `${label}: ${output.stdout} ${output.stderr}`);
    await assert.rejects(f.call('agentic_workflow_run', { workflow, taskId: piId, eventId: 'tick' }),
      /bound to a different task run|invalid artifact contract/);
    assert.equal(existsSync(join(f.repo, '.local/workflow-runner', cliId)), false);
    assert.equal(existsSync(join(f.repo, '.local/workflow-runner', piId)), false);
  }
});

// Why: A noninteractive CLI cannot bypass the Pi owner dialog or submit recovery events unavailable to Pi tick.
test('CLI refuses owner controls and private recovery events like Pi tick', async (t) => {
  const f = fixture(t), workflowFile = join(f.repo, 'workflow.json'), eventFile = join(f.repo, 'event.json');
  writeFileSync(workflowFile, JSON.stringify(f.workflow));
  for (const type of ['hold', 'cancel', 'resume', 'readback', 'ack', 'hint']) {
    writeFileSync(eventFile, JSON.stringify({ id: `probe-${type}`, type }));
    const output = spawnSync(process.execPath, ['scripts/pad-runner.mjs', 'run', '--workflow', workflowFile,
      '--run-id', 'task', '--event', eventFile, '--store', join(f.repo, '.local/workflow-runner')], { encoding: 'utf8' });
    assert.equal(output.status, 2, `${type}: ${output.stdout} ${output.stderr}`);
    assert.equal(output.stdout, '', type);
    await assert.rejects(f.call('agentic_workflow_tick', { workflow: f.workflow, taskId: 'task', event: { id: `pi-${type}`, type } }), /invalid bounded/, type);
  }
  assert.equal((await f.call('agentic_workflow_cancel', { workflow: f.workflow, taskId: 'task', eventId: 'stop' })).reason, 'owner-confirmation-required');
  const confirmed = { ...f.ctx, hasUI: true, ui: { confirm: async () => true } };
  assert.equal((await f.call('agentic_workflow_handbrake', { workflow: f.workflow, taskId: 'task', eventId: 'hold', action: 'on' }, confirmed)).phase, 'held');
  const other = fixture(t), confirmedCancel = { ...other.ctx, hasUI: true, ui: { confirm: async () => true } };
  assert.equal((await other.call('agentic_workflow_cancel', { workflow: other.workflow, taskId: 'task', eventId: 'cancel' }, confirmedCancel)).phase, 'cancelled');
});
