import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { ADAPTER } from '../lib/model-fidelity/tlc-runner.mjs';
import path from 'node:path';
import { createAttempt, captureBundle } from '../lib/model-fidelity/attempts.mjs';
import { check } from '../lib/model-fidelity/check.mjs';
import { validateRecord } from '../lib/model-fidelity/records.mjs';

async function fixture() {
  mkdirSync(path.join(process.cwd(), '.scratch'), { recursive: true });
  const repoRoot = await mkdtemp(path.join(process.cwd(), '.scratch/mf-t10-test-'));
  const storeRoot = path.join(repoRoot, 'store');
  const claim = await createAttempt({ storeRoot, unitId: 'unit', attemptId: 'attempt', owner: 'test' });
  await mkdir(path.join(repoRoot, 'inputs'));
  const model = await readFile('tests/fixtures/model-fidelity-runner/Sample.tla');
  await writeFile(path.join(repoRoot, 'inputs/Sample.tla'), model);
  await writeFile(path.join(repoRoot, 'inputs/Primary.cfg'), 'SPECIFICATION Spec\nINVARIANT Unsafe\n');
  await writeFile(path.join(repoRoot, 'inputs/Mutant.cfg'), 'SPECIFICATION Spec\nINVARIANT Unsafe\n');
  await writeFile(path.join(repoRoot, 'inputs/Wrong.cfg'), 'SPECIFICATION Spec\nINVARIANT Safe\n');
  const design = { schema: 'model-fidelity.design.v1', id: 'design', planId: 'plan', mode: 'protocol', sourceRefs: [], modelRefs: ['inputs/Sample.tla'], configRefs: ['inputs/Primary.cfg', 'inputs/Mutant.cfg', 'inputs/Wrong.cfg'], dependencyRefs: [], actionIds: [], environmentId: 'environment' };
  await writeFile(path.join(repoRoot, 'inputs/design.json'), JSON.stringify(design));
  await captureBundle(claim, { repoRoot, bundleId: 'bundle', sourceRevision: 'a'.repeat(40), checker: 'not-run', files: ['inputs/design.json', 'inputs/Sample.tla', 'inputs/Primary.cfg', 'inputs/Mutant.cfg', 'inputs/Wrong.cfg'] });
  const request = { schema: 'model-fidelity.request.v1', requestId: 'check1', unitId: 'unit', attemptId: 'attempt', operation: 'check', payload: { bundleId: 'bundle', controlIds: ['Mutant', 'Wrong'] } };
  return { claim, request, repoRoot };
}

// Why: a failing safety model is a completed finding, not a delivery error.
test('captured primary and named controls retain raw evidence and never block on expected counterexamples', async () => {
  const { claim, request } = await fixture();
  const result = await check(request, claim);
  assert.equal(result.continuation, 'continue');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.checks.map(row => row.status), existsSync(ADAPTER) ? ['invalid', 'counterexample', 'exposed'] : ['invalid', 'unavailable', 'unavailable']);
  assert.equal(result.checks[0].name, 'Wrong');
  assert.equal(result.artifactIds.length, existsSync(ADAPTER) ? 2 : 0);
  assert.equal(validateRecord('result', result).ok, true);
  if (existsSync(ADAPTER)) {
    const raw = JSON.parse(await readFile(path.join(claim.storeRoot, 'units/unit/attempts/attempt', result.checks[2].rawArtifactId)));
    assert.equal(raw.inputs.spec.sha256.length, 64);
    assert.match(raw.checkerOutput, /Invariant Unsafe is violated/);
  } else assert.ok(result.findings.some(f => f.code === 'check-unavailable'));
  assert.ok(result.findings.some(f => f.code === 'reachability-not-assessed'));
});

// Why: unchecked names must not turn into arbitrary checker input.
test('unknown control is refused before execution', async () => {
  const { claim, request } = await fixture();
  await assert.rejects(check({ ...request, payload: { ...request.payload, controlIds: ['other'] } }, claim), /not a named captured config/);
});

// Why: a requested limit that the checker cannot enforce must stay unproven.
test('unsupported state limit is a finding, not a claimed check', async () => {
  const { claim, request } = await fixture();
  const result = await check({ ...request, payload: { ...request.payload, limits: { maxStates: 5 } } }, claim);
  assert.deepEqual(result.checks.map(row => row.status), ['invalid', 'not-run', 'not-run']);
  assert.ok(result.findings.some(f => f.code === 'unsupported-state-limit'));
  assert.equal(result.artifactIds.length, 0);
});

// Why: the public CLI must return one machine-readable result with closed stdin after real prepare and check calls.
test('CLI prepare then check exposes complete control evidence without an interactive step', async () => {
  const { repoRoot } = await fixture();
  const init = spawnSync('git', ['-C', repoRoot, 'init', '-q'], { encoding: 'utf8' });
  assert.equal(init.status, 0);
  const commit = spawnSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stderr);
  const plan = { schema: 'model-fidelity.plan.v1', id: 'plan', goals: ['Keep old effects off replacements'], currentGenerationRule: 'Check generation at effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: [], intendedRollback: 'Deprecate incorrect work' };
  await writeFile(path.join(repoRoot, 'inputs/plan.json'), JSON.stringify(plan));
  const cli = path.resolve('scripts/model_fidelity.mjs');
  async function call(operation, requestId, payload) {
    await writeFile(path.join(repoRoot, `${requestId}.json`), JSON.stringify({ schema: 'model-fidelity.request.v1', requestId, unitId: 'cli', attemptId: 'first', operation, payload }));
    const result = spawnSync(process.execPath, [cli, operation, '--json', `${requestId}.json`], { cwd: repoRoot, input: '', encoding: 'utf8', timeout: 60000 });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  const prepared = await call('prepare', 'p1', { mode: 'protocol', planRef: 'inputs/plan.json', designRefs: ['inputs/design.json', 'inputs/Sample.tla', 'inputs/Primary.cfg', 'inputs/Mutant.cfg', 'inputs/Wrong.cfg'] });
  assert.ok(prepared.bundleId);
  const checked = await call('check', 'c1', { bundleId: prepared.bundleId, controlIds: ['Mutant'] });
  assert.equal(checked.continuation, 'continue');
  assert.ok(checked.checks.some(row => row.status === (existsSync(ADAPTER) ? 'exposed' : 'unavailable')));
  assert.equal(checked.diagrams.length, 4);
  assert.equal((await call('check', 'c1', { bundleId: prepared.bundleId, controlIds: ['Mutant'] })).requestId, 'c1');
});
