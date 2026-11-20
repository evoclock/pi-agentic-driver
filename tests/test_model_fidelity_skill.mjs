import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

const repo = process.cwd();
const cli = path.join(repo, 'scripts/model_fidelity.mjs');
const plan = { schema: 'model-fidelity.plan.v1', id: 'plan', goals: ['Keep old effects off replacement generations'], currentGenerationRule: 'Check current generation at effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: ['Replacement between check and effect'], progressRequirements: [], scope: ['synthetic'], intendedRollback: 'Deprecate wrong work' };
const design = { schema: 'model-fidelity.design.v1', id: 'candidate', planId: 'plan', mode: 'protocol', sourceRefs: [], modelRefs: [], configRefs: [], dependencyRefs: [], actionIds: ['ApplyClearedEffect'], environmentId: 'environment.json' };

async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.join(repo, '.scratch/mf-skill-'));
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  assert.equal(spawnSync('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).status, 0);
  await Promise.all([
    writeFile(path.join(cwd, 'plan.json'), JSON.stringify(plan)),
    writeFile(path.join(cwd, 'design.json'), JSON.stringify(design)),
    writeFile(path.join(cwd, 'environment.json'), JSON.stringify({ schema: 'model-fidelity.environment.v1', id: 'environment', events: [], omissions: [] })),
  ]);
  return cwd;
}

async function call(cwd, operation, requestId, payload, env = {}) {
  const request = { schema: 'model-fidelity.request.v1', unitId: 'case', attemptId: 'first', requestId, operation, payload };
  await writeFile(path.join(cwd, 'request.json'), JSON.stringify(request));
  const run = spawnSync(process.execPath, [cli, operation, '--json', 'request.json'], { cwd, input: '', encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  assert.equal(run.signal, null, run.stderr);
  return { exit: run.status, result: JSON.parse(run.stdout) };
}

// Why: a declared but unproven effect must remain visible while the caller can deliver built work.
test('protocol gap and failed render retain delivery continuation and view records', async () => {
  const cwd = await fixture();
  const { exit, result } = await call(cwd, 'prepare', 'prepare-1', { mode: 'protocol', planRef: 'plan.json', designRefs: ['design.json', 'environment.json'] }, { PAD_MF_RENDERER: '/missing/renderer.mjs' });
  assert.equal(exit, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.continuation, 'continue');
  assert.ok(result.findings.some(f => f.code === 'missing-action-map' && f.actionId === 'ApplyClearedEffect'));
  assert.ok(result.findings.some(f => f.code === 'diagram-unavailable'));
  assert.deepEqual(result.diagrams.map(d => d.viewId), ['lifecycle', 'results', 'action-map', 'fault-window']);
  assert.ok(result.diagrams.every(d => d.status === 'unavailable'));
  const followup = await call(cwd, 'diagram', 'diagram-1', { bundleId: result.bundleId });
  assert.equal(followup.exit, 0);
  assert.equal(followup.result.continuation, 'continue');
  assert.equal(followup.result.diagrams.length, 4);
});

// Why: registration must point to the named driver skill and an installed example, not shadow the upstream port.
test('skill frontmatter, routing and package registration are coherent', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const skill = await readFile('skills/model-fidelity/SKILL.md', 'utf8');
  const examples = await readFile('skills/model-fidelity/examples.md', 'utf8');
  const route = await readFile('skills/driver-mode/SKILL.md', 'utf8');
  assert.match(skill, /^---\nname: model-fidelity\ndescription: .+\n---\n/);
  assert.ok(pkg.pi.skills.includes('./skills/model-fidelity'));
  assert.ok(pkg.files.includes('skills/model-fidelity'));
  assert.match(route, /\| `model-fidelity` \|/);
  assert.match(examples, /unproven-all-at-once-step/);
  assert.match(examples, /diagram-unavailable/);
  assert.doesNotMatch(pkg.pi.skills.join(' '), /statechart-pi/);
});
