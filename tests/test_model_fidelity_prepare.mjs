import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepare } from '../lib/model-fidelity/prepare.mjs';

const sourceRevision = 'a'.repeat(40);
const plan = { schema: 'model-fidelity.plan.v1', id: 'crash-rule', goals: ['Protect replacement generations'], currentGenerationRule: 'Old clearance cannot affect a new generation', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: ['Crash and replacement'], progressRequirements: [], scope: ['Synthetic fixture'], intendedRollback: 'Deprecate wrong changes' };
const design = { schema: 'model-fidelity.design.v1', id: 'crash-candidate', planId: plan.id, mode: 'protocol', sourceRefs: ['map.json'], modelRefs: ['CrashReadiness.tla'], configRefs: ['safe.cfg'], dependencyRefs: [], actionIds: ['PublishReadiness', 'ProcessDies', 'ReplaceResource', 'ApplyClearedEffect'], environmentId: 'environment.json' };
const map = { schema: 'model-fidelity.action-map.v1', actionId: 'ApplyClearedEffect', kind: 'implementation', modelLocation: 'CrashReadiness.tla', actor: 'surviving writer', session: 'new', privilege: 'write', realOperation: 'generation-conditional effect', sourceEvidenceIds: [], preconditions: [], observedValue: 'generation', observedFrom: 'resource', protectedInterval: 'effect', effectPoint: 'effect', assumptions: [] };
async function fixture() {
  await mkdir('.scratch', { recursive: true });
  const root = await mkdtemp(path.resolve('.scratch/mf-prepare-'));
  const repoRoot = path.join(root, 'repo');
  const storeRoot = path.join(root, 'store');
  await mkdir(repoRoot);
  await writeFile(path.join(repoRoot, 'plan.json'), JSON.stringify(plan));
  const source = 'tests/fixtures/model-fidelity/crash-disconnect-01/';
  for (const file of ['CrashReadiness.tla', 'safe.cfg', 'unsafe.cfg']) await writeFile(path.join(repoRoot, file), await readFile(path.join(source, file)));
  await writeFile(path.join(repoRoot, 'design.json'), JSON.stringify(design));
  await writeFile(path.join(repoRoot, 'map.json'), JSON.stringify(map));
  await writeFile(path.join(repoRoot, 'environment.json'), JSON.stringify({ schema: 'model-fidelity.environment.v1', id: 'crash-environment', events: ['ProcessDies', 'ReplaceResource'], omissions: [] }));
  return { repoRoot, storeRoot, owner: 'writer', sourceRevision };
}
const request = (attemptId, planId, designRefs = []) => ({ schema: 'model-fidelity.request.v1', operation: 'prepare', requestId: `request-${attemptId}`, unitId: 'unit', attemptId, payload: { mode: 'protocol', planRef: 'plan.json', designRefs, ...(planId ? { planId } : {}) } });
const refs = ['design.json', 'map.json', 'environment.json', 'CrashReadiness.tla', 'safe.cfg'];

// Why: incomplete planning is usable evidence, not a delivery stop.
test('no design produces a partial bundle and frozen original with continuation', async () => {
  const f = await fixture();
  const result = await prepare(request('one'), f);
  assert.equal(result.status, 'partial');
  assert.equal(result.continuation, 'continue');
  assert.equal(result.findings[0].code, 'no-design-yet');
  assert.deepEqual(await readFile(path.join(f.storeRoot, 'units/unit/plans', result.planId, 'original.json')), await readFile(path.join(f.repoRoot, 'plan.json')));
  assert.equal(result.artifactIds.length, 1);
});

// Why: an omitted ID must never silently create a second original baseline.
test('later call without original plan ID is refused rather than making another baseline', async () => {
  const f = await fixture();
  const first = await prepare(request('one'), f);
  const refused = await prepare(request('two', undefined, refs), f);
  assert.equal(refused.status, 'error');
  assert.equal(refused.findings[0].code, 'plan-id-required');
  assert.deepEqual(await readFile(path.join(f.storeRoot, 'units/unit/plans', first.planId, 'original.json')), await readFile(path.join(f.repoRoot, 'plan.json')));
});

// Why: candidate bytes cannot replace the first plan even when the reference is reused.
test('original plan substitution is refused and recorded without changing frozen bytes', async () => {
  const f = await fixture();
  const first = await prepare(request('one'), f);
  const frozen = await readFile(path.join(f.storeRoot, 'units/unit/plans', first.planId, 'original.json'));
  await writeFile(path.join(f.repoRoot, 'plan.json'), JSON.stringify({ ...plan, goals: ['New policy'] }));
  const refused = await prepare(request('two', first.planId, refs), f);
  assert.equal(refused.status, 'error');
  assert.equal(refused.findings[0].code, 'original-plan-substitution');
  assert.equal(refused.bundleId, undefined);
  assert.deepEqual(await readFile(path.join(f.storeRoot, 'units/unit/plans', first.planId, 'original.json')), frozen);
  assert.equal(JSON.parse(await readFile(path.join(f.storeRoot, 'units/unit/attempts/two/results/request-two.json'))).errors[0].code, 'original-plan-substitution');
});

// Why: each attempt retains its own captured bytes for later comparison.
test('repeated prepare preserves both candidate bytes and manifest identities', async () => {
  const f = await fixture();
  const first = await prepare(request('one', undefined, refs), f);
  assert.equal(first.status, 'partial');
  assert.ok(first.findings.some(item => item.code === 'missing-action-map' && item.actionId === 'ProcessDies'));
  await writeFile(path.join(f.repoRoot, 'design.json'), JSON.stringify({ ...design, id: 'new-candidate' }));
  const second = await prepare(request('two', first.planId, refs), f);
  assert.notEqual(first.manifestDigest, second.manifestDigest);
  const bundlePath = r => path.join(f.storeRoot, 'units/unit/attempts', r.attemptId, 'input/bundles', r.bundleId, 'files/design.json');
  assert.equal(JSON.parse(await readFile(bundlePath(first))).id, 'crash-candidate');
  assert.equal(JSON.parse(await readFile(bundlePath(second))).id, 'new-candidate');
});

// Why: the structural case must disclose missing mappings and events without blocking.
test('incomplete crash/disconnect inventory remains partial and unsupported semantics visible', async () => {
  const f = await fixture();
  await writeFile(path.join(f.repoRoot, 'environment.json'), JSON.stringify({ schema: 'model-fidelity.environment.v1', id: 'crash-environment', events: [], omissions: ['Connection loss not represented'] }));
  const result = await prepare(request('one', undefined, refs), f);
  assert.equal(result.status, 'partial');
  assert.ok(result.findings.some(item => item.code === 'incomplete-inventory'));
  assert.ok(result.findings.some(item => item.code === 'missing-action-map' && item.actionId === 'ReplaceResource'));
  await writeFile(path.join(f.repoRoot, 'environment.json'), JSON.stringify({ schema: 'model-fidelity.environment.v1', id: 'crash-environment', events: ['UnmodeledDisconnect'], omissions: [] }));
  const next = await prepare(request('two', result.planId, refs), f);
  assert.ok(next.findings.some(item => item.code === 'missing-action-representation' && item.actionId === 'UnmodeledDisconnect'));
  assert.equal(result.continuation, 'continue');
});
