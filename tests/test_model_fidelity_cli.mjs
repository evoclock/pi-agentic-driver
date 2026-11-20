import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cli = path.resolve('scripts/model_fidelity.mjs');
const plan = { schema: 'model-fidelity.plan.v1', id: 'original', goals: ['Keep old effects off replacement generations'], currentGenerationRule: 'Check the current generation at the effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: ['fixture'], intendedRollback: 'Deprecate wrong work' };
const make = (operation, requestId, payload) => ({ schema: 'model-fidelity.request.v1', unitId: 'unit', attemptId: 'one', requestId, operation, payload });
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.resolve('.scratch/mf-cli-test-'));
  const git = spawnSync('git', ['init', '-q', cwd]);
  assert.equal(git.status, 0);
  spawnSync('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  await writeFile(path.join(cwd, 'plan.json'), JSON.stringify(plan));
  return cwd;
}
async function call(cwd, request, env = {}) {
  await writeFile(path.join(cwd, 'request.json'), JSON.stringify(request));
  const run = spawnSync(process.execPath, [cli, request.operation, '--json', 'request.json'], { cwd, input: '', encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  assert.equal(run.signal, null, run.stderr);
  return { exit: run.status, output: JSON.parse(run.stdout), stdout: run.stdout };
}

// Why: caller workflows need one JSON result with diagrams even when design evidence is missing.
test('prepare, dedup, diagram, bounded read and mandatory view records with closed stdin', async () => {
  const cwd = await fixture();
  const req = make('prepare', 'p1', { mode: 'light', planRef: 'plan.json', designRefs: [] });
  const first = await call(cwd, req);
  assert.equal(first.exit, 0, first.stdout);
  assert.equal(first.output.status, 'partial');
  assert.equal(first.output.diagrams.length, 4);
  assert.deepEqual(first.output.diagrams.slice(2).map(v => v.status), ['not-applicable', 'not-applicable']);
  assert.deepEqual((await call(cwd, req)).output, first.output);
  const diagram = await call(cwd, make('diagram', 'd1', { bundleId: first.output.bundleId }));
  assert.equal(diagram.exit, 0, diagram.stdout);
  assert.equal(diagram.output.diagrams.length, 4);
  assert.ok(diagram.output.artifactIds.some(p => p.includes('views/lifecycle/d1/view.json')));
  const read = await call(cwd, make('read', 'r1', { artifactId: diagram.output.artifactIds.find(p => p.endsWith('view.json')) }));
  assert.equal(read.exit, 0, read.stdout);
  assert.equal(read.output.artifact.content.schema, 'model-fidelity.view.v1');
  assert.equal(read.output.artifact.content.bundleDigest.length, 64);
  assert.match(await readFile(path.join(cwd, '.scratch/model-fidelity/units/unit/attempts/one/results/p1-cli.json'), 'utf8'), /fingerprint/);
});

// Why: malformed inputs, conflicting IDs and interrupted publication cannot silently replay effects.
test('invalid input, request conflict, unavailable renderer and interrupted result are typed JSON', async () => {
  const cwd = await fixture();
  const req = make('prepare', 'p1', { mode: 'protocol', planRef: 'plan.json', designRefs: [] });
  const first = await call(cwd, req, { PAD_MF_RENDERER: '/nonexistent/renderer.mjs' });
  assert.equal(first.exit, 0, first.stdout);
  assert.ok(first.output.findings.some(f => f.code === 'diagram-unavailable'));
  assert.deepEqual(first.output.diagrams.slice(2).map(v => v.status), ['unavailable', 'unavailable']);
  const conflict = await call(cwd, { ...req, payload: { ...req.payload, mode: 'light' } });
  assert.equal(conflict.exit, 3);
  assert.equal(conflict.output.errors[0].code, 'request-conflict');
  const invalid = await call(cwd, make('read', 'bad', { artifactId: '../../plan.json' }));
  assert.equal(invalid.exit, 2);
  assert.equal(invalid.output.errors[0].code, 'invalid-reference');
  await writeFile(path.join(cwd, '.scratch/model-fidelity/units/unit/attempts/one/results/interrupted.json'), '{}');
  const interrupted = await call(cwd, make('read', 'interrupted', { resultId: 'p1' }));
  assert.equal(interrupted.exit, 3);
  assert.equal(interrupted.output.errors[0].code, 'interrupted');
});
