import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cli = path.resolve('scripts/model_fidelity.mjs');
const plan = { schema: 'model-fidelity.plan.v1', id: 'original', goals: ['Protect new generation'], currentGenerationRule: 'Check at effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: ['fixture'], intendedRollback: 'Deprecate wrong work' };
const request = (operation, requestId, payload) => ({ schema: 'model-fidelity.request.v1', unitId: 'unit', attemptId: 'one', requestId, operation, payload });
const payload = (planId, bundleId, changeRef = 'change.json', rollbackRecordRef = null, priorEvaluateRequestId) => ({ planId, bundleId, assessmentIds: [], runtimeArtifactIds: [], changeRef, rollbackRecordRef, ...(priorEvaluateRequestId ? { priorEvaluateRequestId } : {}) });
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.resolve('.scratch/mf-eval-test-'));
  git(cwd, 'init', '-q');
  await writeFile(path.join(cwd, 'plan.json'), JSON.stringify(plan));
  await writeFile(path.join(cwd, 'data.json'), 'raw');
  await writeFile(path.join(cwd, 'script.mjs'), 'export const value = 1;');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'original');
  await writeFile(path.join(cwd, 'config.json'), JSON.stringify({ schema: 'model-fidelity.red-lines.v1', rawDataPaths: ['data.json'], keyAssetPaths: ['script.mjs'] }));
  await writeFile(path.join(cwd, 'change.json'), JSON.stringify({ goals: plan.goals }));
  const prepared = await call(cwd, request('prepare', 'p1', { mode: 'light', planRef: 'plan.json', designRefs: [] }));
  assert.equal(prepared.exit, 0, JSON.stringify(prepared.output));
  return { cwd, prepared: prepared.output };
}
async function call(cwd, req) {
  await writeFile(path.join(cwd, 'request.json'), JSON.stringify(req));
  const run = spawnSync(process.execPath, [cli, req.operation, '--json', 'request.json'], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, PAD_MF_RED_LINES: 'config.json' }, input: '' });
  assert.equal(run.signal, null, run.stderr);
  return { exit: run.status, output: JSON.parse(run.stdout) };
}

// Why: an unchanged original and a same-generation completion must stay advisory even without runtime proof.
test('evaluate preserves the frozen plan, returns typed unknown runtime and four views', async () => {
  const { cwd, prepared } = await fixture();
  const result = await call(cwd, request('evaluate', 'e1', payload(prepared.planId, prepared.bundleId)));
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.equal(result.output.planMatch, 'unknown');
  assert.equal(result.output.runtime, 'not-run');
  assert.equal(result.output.continuation, 'continue');
  assert.equal(result.output.diagrams.length, 4);
  assert.equal((await call(cwd, request('evaluate', 'e1', payload(prepared.planId, prepared.bundleId)))).output.manifestDigest, result.output.manifestDigest);
});

// Why: actual Git changes to host-listed raw input and deleted assets must stop those actions, not other delivery.
test('evaluate checks exact diff for confirmed red lines and suspected script reuse', async () => {
  const { cwd, prepared } = await fixture();
  await writeFile(path.join(cwd, 'data.json'), 'overwritten');
  git(cwd, 'add', '-u');
  git(cwd, 'commit', '-qm', 'change raw');
  const result = await call(cwd, request('evaluate', 'e1', payload(prepared.planId, prepared.bundleId)));
  assert.equal(result.exit, 0, JSON.stringify(result.output));
  assert.equal(result.output.continuation, 'stop-red-line');
  assert.ok(result.output.findings.some(f => f.redLine === 'raw-data-overwrite' && f.confidence === 'confirmed'));
  git(cwd, 'mv', 'script.mjs', 'replacement.mjs');
  git(cwd, 'add', '-u');
  git(cwd, 'commit', '-qm', 'replace script');
  const second = await call(cwd, request('evaluate', 'e2', payload(prepared.planId, prepared.bundleId)));
  assert.ok(second.output.findings.some(f => f.redLine === 'key-asset-delete' && f.confidence === 'confirmed'));
});

// Why: a rollback needs a distinct second call bound to the first evaluation and current revision and manifest.
test('rollback records reject stale targets and never treat caller observation as host proof', async () => {
  const { cwd, prepared } = await fixture();
  await writeFile(path.join(cwd, 'change.json'), JSON.stringify({ goals: ['Changed acceptance wording'] }));
  const first = await call(cwd, request('evaluate', 'e1', payload(prepared.planId, prepared.bundleId)));
  assert.equal(first.output.planMatch, 'differs');
  assert.equal(first.output.rollback, 'suggested');
  const revision = git(cwd, 'rev-parse', 'HEAD');
  const record = { schema: 'model-fidelity.caller-step.v1', id: 'rollback-1', unitId: 'unit', attemptId: 'one', kind: 'rollback', revision, manifestDigest: first.output.manifestDigest, outcome: 'observed' };
  await writeFile(path.join(cwd, 'rollback.json'), JSON.stringify(record));
  const second = await call(cwd, request('evaluate', 'e2', payload(prepared.planId, prepared.bundleId, 'change.json', 'rollback.json', 'e1')));
  assert.equal(second.exit, 0, JSON.stringify(second.output));
  assert.equal(second.output.rollback, 'unknown');
  assert.ok(second.output.findings.some(f => f.code === 'rollback-unverified'));
  await writeFile(path.join(cwd, 'rollback.json'), JSON.stringify({ ...record, manifestDigest: '0'.repeat(64) }));
  const stale = await call(cwd, request('evaluate', 'e3', payload(prepared.planId, prepared.bundleId, 'change.json', 'rollback.json', 'e1')));
  assert.equal(stale.exit, 0, JSON.stringify(stale.output));
  assert.ok(stale.output.findings.some(f => f.code === 'stale-rollback-target'));
});
