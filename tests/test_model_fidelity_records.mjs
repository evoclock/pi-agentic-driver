import test from 'node:test';
import assert from 'node:assert/strict';

const records = await import('../lib/model-fidelity/records.mjs').catch(() => ({}));
const { validateRecord, outputPath, dedupKey } = records;
const base = { schema: 'model-fidelity.result.v1', requestId: 'r1', unitId: 'u1', attemptId: 'a1', operation: 'prepare', status: 'partial', continuation: 'continue', findings: [], checks: [], correspondence: 'not-assessed', runtime: 'not-run', diagrams: [], artifactIds: [], errors: [], authorityCreated: false };
const finding = { id: 'f1', code: 'raw-overwrite', message: 'Raw bytes changed', origin: 'inspected-source', evidenceIds: [], redLine: 'raw-data-overwrite', confidence: 'confirmed' };

// Why: All six workflow steps must parse as typed requests with bounded payloads.
test('all operations accept their required inputs and reject missing inputs', () => {
  const payloads = { prepare: { mode: 'light', planRef: 'plans/p.json', designRefs: [] }, check: { bundleId: 'b1' }, assess: { bundleId: 'b1', checkResultIds: [], reviewArtifactIds: [] }, diagram: { bundleId: 'b1' }, evaluate: { planId: 'p1', bundleId: 'b1', assessmentIds: [], runtimeArtifactIds: [], changeRef: 'diff/1', rollbackRecordRef: null }, read: { artifactId: 'a1' } };
  for (const [operation, payload] of Object.entries(payloads)) {
    const request = { schema: 'model-fidelity.request.v1', requestId: 'r1', unitId: 'u1', attemptId: 'a1', operation, payload };
    assert.equal(validateRecord('request', request).ok, true, operation);
    assert.equal(validateRecord('request', { ...request, payload: {} }).ok, false, operation);
  }
});

// Why: Results remain evidence, not permission or caller-supplied verification.
test('result continuation and red lines are coherent', () => {
  assert.equal(validateRecord('result', base).ok, true);
  assert.equal(JSON.parse(JSON.stringify(base)).continuation, 'continue');
  assert.equal(validateRecord('result', { ...base, continuation: 'stop-red-line' }).ok, false);
  assert.equal(validateRecord('result', { ...base, continuation: 'stop-red-line', findings: [{ ...finding, confidence: 'suspected' }] }).ok, false);
  assert.equal(validateRecord('result', { ...base, continuation: 'stop-red-line', findings: [finding] }).ok, true);
  assert.equal(validateRecord('result', { ...base, findings: [{ ...finding, blocking: true }] }).ok, false);
  assert.equal(validateRecord('result', { ...base, verifiedImplementation: true }).ok, false);
  assert.equal(validateRecord('result', { ...base, rollback: 'deprecated' }).ok, true);
});

// Why: Unknown versions and forged observation fields must fail rather than silently downgrade.
test('version and provenance boundaries reject untrusted claims', () => {
  assert.equal(validateRecord('result', { ...base, schema: 'model-fidelity.result.v2' }).ok, false);
  assert.equal(validateRecord('result', { ...base, verified: true }).ok, false);
  assert.equal(validateRecord('evidence', { schema: 'model-fidelity.evidence.v1', id: 'e1', claim: 'seen', artifactDigest: 'a'.repeat(64), origin: 'host-observed-test', verified: true }).ok, false);
});

// Why: Light mode must disclose omitted protocol views, not silently claim coverage.
test('light views label omitted coverage and review arrays may be empty', () => {
  assert.equal(validateRecord('view', { schema: 'model-fidelity.view.v1', bundleDigest: 'a'.repeat(64), viewId: 'lifecycle', mode: 'light', states: [], transitions: [], findings: [], omittedViews: [{ viewId: 'fault-window', status: 'not-applicable', reason: 'Light mode' }] }).ok, true);
  assert.equal(validateRecord('view', { schema: 'model-fidelity.view.v1', bundleDigest: 'a'.repeat(64), viewId: 'lifecycle', mode: 'light', states: [], transitions: [], findings: [] }).ok, false);
  assert.equal(validateRecord('review', { schema: 'model-fidelity.review.v1', id: 'review1', bundleId: 'b1', reviewer: 'self', provenance: 'self-reported', challengeSchedules: [], evidenceIds: [], unresolvedAssumptions: [] }).ok, true);
});

// Why: Original plan and action mapping gaps remain explicit even before evidence exists.
test('plan, design, action map and environment require contract boundaries', () => {
  const plan = { schema: 'model-fidelity.plan.v1', id: 'p1', goals: ['safe reuse'], currentGenerationRule: 'check before effect', allowedPostDeathCompletion: true, initialConditions: [], exclusions: [], failureCases: [], progressRequirements: [], scope: [], intendedRollback: 'deprecate' };
  assert.equal(validateRecord('plan', plan).ok, true);
  assert.equal(validateRecord('plan', { ...plan, currentGenerationRule: undefined }).ok, false);
  assert.equal(validateRecord('design', { schema: 'model-fidelity.design.v1', id: 'd1', planId: 'p1', mode: 'protocol', sourceRefs: [], modelRefs: [], configRefs: [], dependencyRefs: [], actionIds: [], environmentId: 'env1' }).ok, true);
  assert.equal(validateRecord('action-map', { schema: 'model-fidelity.action-map.v1', actionId: 'effect', kind: 'implementation', modelLocation: 'M:1', actor: 'worker', session: 's1', privilege: 'write', realOperation: 'conditional update', sourceEvidenceIds: [], preconditions: [], observedValue: 'generation', observedFrom: 'store', protectedInterval: 'transaction', effectPoint: 'commit', assumptions: [] }).ok, true);
  assert.equal(validateRecord('environment', { schema: 'model-fidelity.environment.v1', id: 'env1', events: ['process-death', 'resource-replacement'], omissions: [] }).ok, true);
});

// Why: Caller steps need revision-bound rollback and separate observable red-line stop records.
test('caller steps reject rollback without cleared target and accept distinct step types', () => {
  const common = { schema: 'model-fidelity.caller-step.v1', id: 's1', unitId: 'u1', attemptId: 'a1' };
  for (const [kind, fields] of Object.entries({ review: { reviewArtifactId: 'review1' }, runtime: { observationId: 'obs1', status: 'not-run' }, rollback: { revision: 'a'.repeat(40), manifestDigest: 'b'.repeat(64), outcome: 'deprecated' }, 'red-line-stop': { findingId: 'f1', stoppedAction: 'write' } })) {
    assert.equal(validateRecord('caller-step', { ...common, kind, ...fields }).ok, true, kind);
  }
  assert.equal(validateRecord('caller-step', { ...common, kind: 'rollback', outcome: 'observed' }).ok, false);
});

// Why: Result versions and checker versions prevent silent replacement or stale dedup reuse.
test('output paths and dedup keys are versioned and safe', () => {
  assert.equal(outputPath('view', { viewId: 'lifecycle', resultId: 'result-1' }), 'views/lifecycle/result-1/');
  assert.equal(outputPath('evaluation', { resultId: 'result-1' }), 'evaluation/result-1/');
  assert.equal(outputPath('result', { requestId: 'req-1' }), 'results/req-1.json');
  assert.throws(() => outputPath('result', { requestId: '../escape' }));
  assert.notEqual(dedupKey({ requestId: 'r1', checkerVersion: '2.19', inputDigest: 'a' }), dedupKey({ requestId: 'r1', checkerVersion: '2.20', inputDigest: 'a' }));
});
