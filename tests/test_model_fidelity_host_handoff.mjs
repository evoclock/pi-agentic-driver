import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateHostHandoff } from '../lib/model-fidelity/host-handoff.mjs';
import { validateRecord } from '../lib/model-fidelity/records.mjs';

const offer = { schema: 'model-fidelity.to-host.v1', unitId: 'u1', attemptId: 'a1', stepId: 'review', kind: 'review', requestId: 'check1', bundleId: 'bundle1', resultId: 'check1', action: 'Review the built bundle', artifactIds: ['views/lifecycle/check1/view.json'], findingIds: [], authorityCreated: false };
const reply = { schema: 'model-fidelity.from-host.v1', unitId: 'u1', attemptId: 'a1', stepId: 'review', kind: 'review', requestId: 'check1', bundleId: 'bundle1', status: 'recorded', callerStep: { schema: 'model-fidelity.caller-step.v1', id: 'review1', unitId: 'u1', attemptId: 'a1', kind: 'review', reviewArtifactId: 'review-artifact-1' }, authorityCreated: false };

// Why: a reply from another attempt must never be attributed to this hand-off.
test('host hand-off binds caller step to the offered unit, attempt and kind', () => {
  assert.equal(validateHostHandoff(offer).ok, true);
  assert.equal(validateHostHandoff(reply, offer).ok, true);
  for (const [field, value] of [['unitId', 'other'], ['attemptId', 'other'], ['kind', 'runtime'], ['requestId', 'other'], ['bundleId', 'other']])
    assert.equal(validateHostHandoff({ ...reply, [field]: value }, offer).ok, false, field);
  assert.equal(validateHostHandoff({ ...reply, callerStep: { ...reply.callerStep, unitId: 'other' } }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...reply, callerStep: { ...reply.callerStep, verified: true } }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...reply, authorityCreated: true }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...offer, artifactIds: ['same', 'same'] }).ok, false);
});

// Why: absence of a host observation cannot become a successful caller record.
test('missing review and interrupted effects are explained, never manufactured', () => {
  for (const status of ['not-run', 'unknown', 'interrupted'])
    assert.equal(validateHostHandoff({ ...reply, status, callerStep: null, reason: 'No observed result' }, offer).ok, true);
  assert.equal(validateHostHandoff({ ...reply, status: 'interrupted', callerStep: reply.callerStep }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...reply, status: 'not-run', callerStep: null }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...reply, status: 'recorded', callerStep: null }, offer).ok, false);
  assert.equal(validateHostHandoff({ ...offer, verified: true }).ok, false);
});

// Why: host replies must preserve the original caller-step requirements for every kind.
test('all four caller-owned kinds use existing T01 record constraints', () => {
  const fields = {
    review: { reviewArtifactId: 'review-artifact-1' },
    runtime: { observationId: 'observation-1', status: 'observed' },
    rollback: { revision: 'a'.repeat(40), manifestDigest: 'b'.repeat(64), outcome: 'deprecated' },
    'red-line-stop': { findingId: 'finding-1', stoppedAction: 'overwrite' },
  };
  for (const [kind, extra] of Object.entries(fields)) {
    const offered = { ...offer, kind, stepId: kind };
    const callerStep = { schema: 'model-fidelity.caller-step.v1', id: `${kind}-1`, unitId: 'u1', attemptId: 'a1', kind, ...extra };
    assert.equal(validateRecord('caller-step', callerStep).ok, true, kind);
    assert.equal(validateHostHandoff({ ...reply, kind, stepId: kind, callerStep }, offered).ok, true, kind);
    const missing = { ...callerStep }; delete missing[Object.keys(extra)[0]];
    assert.equal(validateHostHandoff({ ...reply, kind, stepId: kind, callerStep: missing }, offered).ok, false, kind);
  }
});

// Why: both transports need a single ordered example with explicit failure paths.
test('one example workflow has causal order, branches and no hidden authority', async () => {
  const workflow = JSON.parse(await readFile(new URL('../lib/model-fidelity/examples/host-workflow.v1.json', import.meta.url)));
  const schema = JSON.parse(await readFile(new URL('../lib/model-fidelity/schemas/host-handoff.v1.schema.json', import.meta.url)));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$defs.toHost.properties.schema.const, 'model-fidelity.to-host.v1');
  assert.equal(schema.$defs.fromHost.properties.schema.const, 'model-fidelity.from-host.v1');
  const ids = workflow.steps.map(step => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of workflow.steps) for (const parent of step.after ?? []) assert.ok(ids.indexOf(parent) < ids.indexOf(step.id), `${parent} precedes ${step.id}`);
  assert.deepEqual(workflow.steps.filter(step => step.offer).map(step => step.kind), ['review', 'runtime', 'red-line-stop', 'rollback']);
  assert.deepEqual(workflow.steps.filter(step => step.operation).map(step => step.operation), ['prepare', 'diagram', 'check', 'assess', 'evaluate', 'evaluate', 'read']);
  assert.deepEqual(Object.keys(workflow.branches), ['complete', 'partial', 'tool-error', 'interrupted', 'stop-red-line']);
  assert.equal(workflow.transport.cli.includes('--json'), true);
  assert.equal(workflow.transport.mcp.includes('model-fidelity.OPERATION'), true);
  assert.deepEqual(workflow.availability.base, ['prepare', 'diagram', 'read']);
});
