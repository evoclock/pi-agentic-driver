import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createModelFidelityCommands } from '../scripts/enforcement/model_fidelity_commands.mjs';
import { machineMcpMessage } from '../scripts/enforcement/machine_transports_pi.js';

const host = path.resolve('scripts/machine_host.mjs');
const cli = path.resolve('scripts/model_fidelity.mjs');
const plan = { schema: 'model-fidelity.plan.v1', id: 'original', goals: ['Keep effects on current generation'], currentGenerationRule: 'Check at effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: ['fixture'], intendedRollback: 'Deprecate wrong work' };
const request = (operation, requestId, payload) => ({ schema: 'model-fidelity.request.v1', unitId: 'unit', attemptId: 'one', requestId, operation, payload });
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.resolve('.scratch/mf-mcp-test-'));
  spawnSync('git', ['init', '-q', cwd]);
  spawnSync('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  await writeFile(path.join(cwd, 'plan.json'), JSON.stringify(plan));
  return cwd;
}
function session(cwd, args, env = {}) {
  const child = spawn(process.execPath, [host, ...args], { cwd, env: { ...process.env, PAD_MACHINE_BOARD: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const queue = [];
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      queue.shift()?.(JSON.parse(line));
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP call timed out')), 30000);
    queue.push(value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  });
  return { child, call };
}

// Why: evidence-only startup must work without a board and reveal only implemented CLI operations.
test('opt-in stdio initializes and lists typed evidence-only tools with no board', async () => {
  const cwd = await fixture();
  for (const options of [{ args: ['mcp', '--commands', 'model-fidelity'] }, { args: ['mcp'], env: { PAD_MACHINE_COMMANDS: 'model-fidelity' } }]) {
    const { child, call } = session(cwd, options.args, options.env);
    try {
      assert.equal((await call('initialize')).result.protocolVersion, '2024-11-05');
      const tools = (await call('tools/list')).result.tools;
      assert.deepEqual(tools.map(t => t.name), ['model-fidelity.prepare', 'model-fidelity.diagram', 'model-fidelity.read']);
      assert.deepEqual(tools[0].inputSchema.properties.operation, { const: 'prepare' });
      assert.deepEqual(tools[0].inputSchema.properties.payload.required, ['mode', 'planRef', 'designRefs']);
      assert.ok(tools[2].inputSchema.properties.payload.oneOf);
    } finally { child.stdin.end(); }
  }
});

// Why: the MCP adapter must return the identical cached CLI result, including partial evidence and bounded read errors.
test('tools/call matches CLI and keeps findings distinct from malformed input', async () => {
  const cwd = await fixture();
  const commands = createModelFidelityCommands({ repoRoot: cwd });
  const prepare = request('prepare', 'p1', { mode: 'light', planRef: 'plan.json', designRefs: [] });
  const first = await machineMcpMessage(commands, { id: 1, method: 'tools/call', params: { name: 'model-fidelity.prepare', arguments: prepare } });
  assert.equal(first.result.isError, false);
  const result = JSON.parse(first.result.content[0].text);
  assert.equal(result.status, 'partial');
  await writeFile(path.join(cwd, 'cli-request.json'), JSON.stringify(prepare));
  const direct = spawnSync(process.execPath, [cli, 'prepare', '--json', 'cli-request.json'], { cwd, encoding: 'utf8', input: '' });
  assert.equal(direct.status, 0, direct.stdout);
  assert.deepEqual(result, JSON.parse(direct.stdout));
  const diagram = await commands['model-fidelity.diagram'](request('diagram', 'd1', { bundleId: result.bundleId }));
  assert.equal(diagram.diagrams.length, 4);
  const read = await commands['model-fidelity.read'](request('read', 'r1', { artifactId: diagram.artifactIds.find(id => id.endsWith('view.json')) }));
  assert.equal(read.artifact.content.schema, 'model-fidelity.view.v1');
  const oversize = await commands['model-fidelity.prepare']({ ...prepare, payload: { ...prepare.payload, planRef: 'a'.repeat(256 * 1024) } });
  assert.equal(oversize.errors[0].code, 'read-limit');
  for (const bad of [request('read', 'bad', { artifactId: '../../plan.json' }), { ...prepare, operation: 'read' }, { ...prepare, payload: { ...prepare.payload, verified: true } }]) {
    const reply = await machineMcpMessage(commands, { id: 2, method: 'tools/call', params: { name: 'model-fidelity.prepare', arguments: bad } });
    assert.equal(reply.result.isError, true);
  }
  assert.equal((await machineMcpMessage(commands, { id: 3, method: 'unknown' })).error.code, -32601);
});

// Why: the default host still needs its board and never silently enables evidence tools.
test('default startup refuses a missing board', () => {
  const run = spawnSync(process.execPath, [host, 'mcp'], { env: { ...process.env, PAD_MACHINE_BOARD: '', PAD_MACHINE_COMMANDS: '' }, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /PAD_MACHINE_BOARD/);
});
