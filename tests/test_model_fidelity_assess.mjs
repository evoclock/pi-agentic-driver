import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assess } from '../lib/model-fidelity/assess.mjs';

const cli = path.resolve('scripts/model_fidelity.mjs');
const request = (operation, requestId, payload) => ({ schema: 'model-fidelity.request.v1', unitId: 'unit', attemptId: 'one', requestId, operation, payload });
const plan = { schema: 'model-fidelity.plan.v1', id: 'original', goals: ['Protect the current generation'], currentGenerationRule: 'Check generation at effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: ['fixture'], intendedRollback: 'Deprecate' };
async function setup() {
  await mkdir('.scratch', { recursive: true });
  const cwd = await mkdtemp(path.resolve('.scratch/mf-assess-test-'));
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  assert.equal(spawnSync('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).status, 0);
  await writeFile(path.join(cwd, 'plan.json'), JSON.stringify(plan));
  const prepared = await call(cwd, request('prepare', 'p1', { mode: 'protocol', planRef: 'plan.json', designRefs: [] }));
  assert.equal(prepared.exit, 0, prepared.output.errors?.[0]?.message);
  const base = path.join(cwd, '.scratch/model-fidelity/units/unit/attempts/one');
  await mkdir(path.join(base, 'reviews'));
  return { cwd, base, bundleId: prepared.output.bundleId, owner: JSON.parse(await readFile(path.join(base, 'owner.json'))) };
}
async function call(cwd, req) {
  await writeFile(path.join(cwd, 'request.json'), JSON.stringify(req));
  const run = spawnSync(process.execPath, [cli, req.operation, '--json', 'request.json'], { cwd, encoding: 'utf8', input: '', timeout: 60000 });
  return { exit: run.status, output: JSON.parse(run.stdout) };
}
const review = (bundleId, extra = {}) => ({ schema: 'model-fidelity.review.v1', id: 'r1', bundleId, reviewer: 'reviewer', provenance: 'host-bound', challengeSchedules: ['Replacement between observation and effect'], evidenceIds: ['conditional-write-evidence'], unresolvedAssumptions: [], ...extra });

// Why: missing review and check records yield non-blocking findings and refreshed diagrams, never a prompt.
test('assess with no review or check returns not-assessed and keeps diagram artifacts', async () => {
  const { cwd, bundleId } = await setup();
  const result = await call(cwd, request('assess', 'a1', { bundleId, checkResultIds: [], reviewArtifactIds: [] }));
  assert.equal(result.exit, 0);
  assert.equal(result.output.correspondence, 'not-assessed');
  assert.equal(result.output.continuation, 'continue');
  assert.ok(result.output.findings.some(f => f.code === 'missing-review'));
  assert.equal(result.output.diagrams.length, 4);
  assert.deepEqual((await call(cwd, request('assess', 'a1', { bundleId, checkResultIds: [], reviewArtifactIds: [] }))).output, result.output);
});

// Why: caller-written provenance, an author reviewer and a stale bundle never become independent support.
test('self-reported host label, author review, stale review and changed bytes remain gaps', async () => {
  const { cwd, base, bundleId } = await setup();
  const ref = path.join(base, 'reviews/r1.json');
  await writeFile(ref, JSON.stringify(review(bundleId)));
  const assessReq = request('assess', 'a1', { bundleId, checkResultIds: [], reviewArtifactIds: ['r1'] });
  const first = await call(cwd, assessReq);
  assert.equal(first.exit, 0);
  assert.equal(first.output.correspondence, 'gaps');
  assert.ok(first.output.findings.some(f => f.code === 'self-reported-review'));
  await writeFile(ref, JSON.stringify(review(bundleId, { reviewer: 'model-fidelity-cli' })));
  const conflict = await call(cwd, assessReq);
  assert.equal(conflict.exit, 3);
  assert.equal(conflict.output.errors[0].code, 'request-conflict');
  const author = await call(cwd, request('assess', 'a2', assessReq.payload));
  assert.ok(author.output.findings.some(f => f.code === 'author-review'));
  await writeFile(ref, JSON.stringify(review('other')));
  const stale = await call(cwd, request('assess', 'a3', assessReq.payload));
  assert.ok(stale.output.findings.some(f => f.code === 'stale-review'));
});

// Why: independent host evidence cannot fill absent schedules, enforcing evidence or unresolved assumptions.
test('host verifier binds exact review bytes, but near misses and unknown schedules remain gaps', async () => {
  const { base, bundleId, owner } = await setup();
  const ref = path.join(base, 'reviews/r1.json');
  const req = request('assess', 'a1', { bundleId, checkResultIds: [], reviewArtifactIds: ['r1'] });
  const claim = { ...owner, base };
  for (const variant of [
    { challengeSchedules: [] },
    { evidenceIds: [] },
    { unresolvedAssumptions: ['Effect-time ownership of reusable address unknown'] },
  ]) {
    await writeFile(ref, JSON.stringify(review(bundleId, variant)));
    const result = await assess(req, claim, { verifyReview: async ({ bytes, manifestDigest }) => bytes.length > 0 && manifestDigest.length === 64 });
    assert.equal(result.correspondence, 'gaps');
    assert.equal(result.continuation, 'continue');
  }
  await writeFile(ref, JSON.stringify(review(bundleId)));
  const supported = await assess(req, claim, { verifyReview: async () => true });
  assert.equal(supported.correspondence, 'gaps'); // No bound model check was supplied.
  assert.ok(supported.findings.some(f => f.code === 'missing-check'));
  await writeFile(path.join(base, 'results/c1.json'), JSON.stringify({ operation: 'check', requestId: 'c1', bundleId, unitId: 'unit', attemptId: 'one', checks: [{ status: 'no-counterexample' }] }));
  const withCheck = await assess(request('assess', 'a2', { bundleId, checkResultIds: ['c1'], reviewArtifactIds: ['r1'] }), claim, { verifyReview: async () => true });
  assert.equal(withCheck.correspondence, 'supported-under-assumptions');
  const untrusted = await assess(request('assess', 'a3', { bundleId, checkResultIds: ['c1'], reviewArtifactIds: ['r1'] }), claim);
  assert.equal(untrusted.correspondence, 'gaps');
  await writeFile(ref, JSON.stringify({ ...review(bundleId), verified: true }));
  const falseVerified = await assess(req, claim, { verifyReview: async () => true });
  assert.ok(falseVerified.findings.some(f => f.code === 'invalid-review'));
  await writeFile(ref, JSON.stringify(review(bundleId)));
  await writeFile(path.join(base, 'results/c2.json'), JSON.stringify({ operation: 'check', requestId: 'c2', bundleId: 'other', unitId: 'unit', attemptId: 'one', checks: [{ status: 'no-counterexample' }] }));
  const staleCheck = await assess(request('assess', 'a4', { bundleId, checkResultIds: ['c2'], reviewArtifactIds: ['r1'] }), claim, { verifyReview: async () => true });
  assert.ok(staleCheck.findings.some(f => f.code === 'stale-check'));
});
