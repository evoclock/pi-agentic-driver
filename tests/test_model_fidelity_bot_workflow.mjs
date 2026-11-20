import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRecord } from '../lib/model-fidelity/records.mjs';

const cli = path.resolve('scripts/model_fidelity.mjs');
const host = path.resolve('scripts/machine_host.mjs');
const source = path.resolve('tests/fixtures/model-fidelity/bot-workflow');
const request = (operation, requestId, payload) => ({ schema: 'model-fidelity.request.v1', unitId: 'workflow', attemptId: 'attempt1', requestId, operation, payload });

async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.resolve('.scratch/mf-bot-workflow-'));
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  assert.equal(spawnSync('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).status, 0);
  await Promise.all(['plan.json', 'design.json'].map(name => copyFile(path.join(source, name), path.join(cwd, name))));
  await writeFile(path.join(cwd, 'candidate.txt'), 'old clearance may write after replacement\n');
  return cwd;
}

async function call(cwd, transport, input) {
  if (transport === 'cli') {
    const file = `${input.requestId}.json`;
    await writeFile(path.join(cwd, file), JSON.stringify(input));
    const run = spawnSync(process.execPath, [cli, input.operation, '--json', file], { cwd, input: '', encoding: 'utf8', timeout: 20000, env: { ...process.env, PAD_MF_RENDERER: '/nonexistent/renderer.mjs' } });
    assert.equal(run.signal, null, 'closed-input CLI must not wait');
    assert.equal(run.error, undefined, 'closed-input CLI must finish');
    assert.doesNotThrow(() => JSON.parse(run.stdout), 'CLI must emit one JSON document');
    return { exit: run.status, output: JSON.parse(run.stdout) };
  }
  const child = spawn(process.execPath, [host, 'mcp', '--commands', 'model-fidelity'], {
    cwd, env: { ...process.env, PAD_MACHINE_BOARD: '', PAD_MF_RENDERER: '/nonexistent/renderer.mjs' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `model-fidelity.${input.operation}`, arguments: input } })}\n`);
  const exit = await Promise.race([
    new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }),
    new Promise((_, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('closed-input MCP waited')); }, 20000); child.on('close', () => clearTimeout(timer)); }),
  ]);
  assert.equal(exit, 0, 'MCP closed input must finish');
  lines.push(...stdout.trim().split('\n').map(line => JSON.parse(line)));
  assert.equal(lines[0].result.protocolVersion, '2024-11-05');
  assert.equal(lines[1].id, 2);
  const reply = lines[1].result;
  return { exit: reply.isError ? 2 : 0, output: JSON.parse(reply.content[0].text), isError: reply.isError };
}

for (const transport of ['cli', 'mcp']) {
  // Why: a closed-input host workflow must retain findings, expose errors, and preserve rollback evidence without an owner reply.
  test(`${transport} synthetic host builds first, delivers gaps and records wrong-change rollback`, async () => {
    const cwd = await fixture();
    const built = await readFile(path.join(cwd, 'candidate.txt'), 'utf8');
    assert.match(built, /old clearance/);
    const first = await call(cwd, transport, request('prepare', 'prepare1', { mode: 'protocol', planRef: 'plan.json', designRefs: ['design.json', 'candidate.txt'] }));
    assert.equal(first.exit, 0, JSON.stringify(first.output));
    assert.equal(first.output.continuation, 'continue');
    assert.equal(first.output.diagrams.length, 4);
    assert.deepEqual(first.output.diagrams.map(v => v.viewId), ['lifecycle', 'results', 'action-map', 'fault-window']);
    assert.ok(first.output.findings.some(f => f.code === 'missing-action-map'));
    const outstanding = 'The observation-to-effect window is not proven safe';
    assert.ok(outstanding.length > 0);
    const later = await call(cwd, transport, request('diagram', 'diagram1', { bundleId: first.output.bundleId, resultIds: ['prepare1'] }));
    assert.equal(later.exit, 0);
    assert.equal(later.output.diagrams.length, 4);
    const artifactId = later.output.artifactIds.find(id => id.endsWith('view.json'));
    const read = await call(cwd, transport, request('read', 'read1', { artifactId }));
    assert.equal(read.exit, 0);
    assert.equal(read.output.artifact.content.schema, 'model-fidelity.view.v1');
    assert.ok(read.output.artifact.content.findings.some(f => f.id === 'Fmissingactionmap-ObserveGeneration'));
    const manifest = await readFile(path.join(cwd, '.scratch/model-fidelity/units/workflow/attempts/attempt1/input/bundles', first.output.bundleId, 'manifest.json'));
    const revision = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const { createHash } = await import('node:crypto');
    const rollback = { schema: 'model-fidelity.caller-step.v1', id: 'rollback1', unitId: 'workflow', attemptId: 'attempt1', kind: 'rollback', revision, manifestDigest: createHash('sha256').update(manifest).digest('hex'), outcome: 'deprecated' };
    assert.equal(validateRecord('caller-step', rollback).ok, true);
    await writeFile(path.join(cwd, 'rollback-record.json'), JSON.stringify(rollback), { flag: 'wx' });
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, 'rollback-record.json'), 'utf8')), rollback);
    await writeFile(path.join(cwd, 'candidate-deprecated.txt'), 'Deprecated: wrong old-generation effect; use a generation-conditional write. Removal needs later review.\n');
    await writeFile(path.join(cwd, 'replacement.txt'), 'effect permitted only if current generation matches\n');
    assert.match(await readFile(path.join(cwd, 'candidate-deprecated.txt'), 'utf8'), /Deprecated/);
    assert.match(await readFile(path.join(cwd, 'replacement.txt'), 'utf8'), /current generation/);
    assert.equal(await readFile(path.join(cwd, 'candidate.txt'), 'utf8'), built);
    const bad = await call(cwd, transport, request('read', 'bad1', { artifactId: '../../plan.json' }));
    assert.notEqual(bad.exit, 0);
    assert.equal(bad.output.continuation, 'continue');
    assert.equal(bad.output.errors[0].code, 'invalid-reference');
    if (transport === 'mcp') assert.equal(bad.isError, true);
    const transcript = { transport, builtBeforeCall: built, results: [first.output, later.output, read.output, bad.output], unresolvedAssumptions: [outstanding], rollback };
    await writeFile(path.join(cwd, 'workflow-transcript.json'), JSON.stringify(transcript), { flag: 'wx' });
    assert.equal(JSON.parse(await readFile(path.join(cwd, 'workflow-transcript.json'), 'utf8')).results.length, 4);
    assert.equal(first.output.authorityCreated, false);
  });
}
